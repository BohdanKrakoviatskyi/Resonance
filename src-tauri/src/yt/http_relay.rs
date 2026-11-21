use std::net::IpAddr;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::clients::{ResolvedYtStream, extract_query_param_str, is_valid_video_id};
use super::proxy::YtStreamProxy;
use super::stream_cache::parse_byte_range;

const PROXY_CHUNK_BYTES: u64 = 2 * 1024 * 1024;
const PREFETCH_HEAD_BYTES: u64 = 262_144;
const STALL_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_STALL_RESUMES: u32 = 3;

fn allowed_cors_origin(origin: &str) -> Option<&str> {
    if matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) {
        return Some(origin);
    }
    let url = url::Url::parse(origin).ok()?;
    if url.scheme() == "http"
        && url.host_str() == Some("localhost")
        && url.port().is_some_and(|port| (5173..=5174).contains(&port))
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
    {
        return Some(origin);
    }
    None
}

pub async fn handle_proxy_connection(
    mut socket: TcpStream,
    proxy: YtStreamProxy,
) -> Result<(), String> {
    let mut buf = vec![0u8; 8192];
    let mut n = 0usize;
    while n < buf.len() {
        let Ok(Ok(k)) =
            tokio::time::timeout(Duration::from_millis(500), socket.read(&mut buf[n..])).await
        else {
            break;
        };
        if k == 0 {
            break;
        }
        n += k;
        if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    if n == 0 {
        return Ok(());
    }

    let req_text = String::from_utf8_lossy(&buf[..n]);
    let mut lines = req_text.lines();
    let request_line = lines.next().unwrap_or_default();
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        return Ok(());
    }
    let method = parts[0].to_uppercase();
    let raw_target = parts[1];

    let mut range_header: Option<String> = None;
    let mut request_origin: Option<String> = None;
    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range_header = Some(v.trim().to_string());
            } else if k.trim().eq_ignore_ascii_case("origin") {
                request_origin = Some(v.trim().to_string());
            }
        }
    }
    let cors_origin = request_origin
        .as_deref()
        .and_then(allowed_cors_origin)
        .map(|origin| format!("Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\n"))
        .unwrap_or_default();

    if method == "OPTIONS" {
        if !cors_origin.is_empty() {
            let resp = format!(
                "HTTP/1.1 204 No Content\r\n{cors_origin}Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range, If-Range, Content-Type\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\n\r\n"
            );
            let _ = socket.write_all(resp.as_bytes()).await;
        } else {
            let _ = socket
                .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                .await;
        }
        return Ok(());
    }
    if extract_query_param_str(raw_target, "t").as_deref() != Some(proxy.token.as_str()) {
        let _ = socket
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            .await;
        return Ok(());
    }

    let path = raw_target.split('?').next().unwrap_or(raw_target);
    if let Some(id) = path.strip_prefix("/local/") {
        return serve_registered_local(&mut socket, &method, range_header.as_deref(), id, &cors_origin).await;
    }
    if let Some(id) = path.strip_prefix("/local-cover/") {
        return serve_local_cover(&mut socket, id, &cors_origin).await;
    }
    let is_prefetch = raw_target.contains("prefetch=1");
    let video_id = path.trim_start_matches("/yt-stream/").trim();
    if !is_valid_video_id(video_id) {
        let _ = socket
            .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
            .await;
        return Ok(());
    }

    // 1. Complete disk cache hit -> instant zero-network local file serving.
    if !is_prefetch
        && let Some(cached) = proxy.audio_cache.lookup_complete(video_id) {
            return serve_local_file(
                &mut socket,
                &method,
                range_header.as_deref(),
                &cached.path,
                cached.total_bytes,
                &cached.content_type,
                &cors_origin,
            )
            .await;
        }

    let (mut resolved, _, _, _) = match proxy
        .get_or_resolve_stream(video_id, false, !is_prefetch, None)
        .await
    {
        Ok(res) => res,
        Err(_) => {
            let _ = socket
                .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                .await;
            return Ok(());
        }
    };

    // 2. Background prefetch warms 256 KiB into memory so the next track starts instantly.
    if is_prefetch {
        if proxy.audio_cache.lookup_complete(video_id).is_none()
            && proxy.audio_cache.head_bytes(video_id).is_none()
        {
            let end = resolved
                .content_length
                .map_or(PREFETCH_HEAD_BYTES - 1, |t| {
                    t.saturating_sub(1).min(PREFETCH_HEAD_BYTES - 1)
                });
            if let Ok(resp) = fetch_with_swap(&proxy, video_id, &mut resolved, 0, end).await
                && (resp.status().as_u16() == 206 || resp.status().as_u16() == 200) {
                    let mime = resp
                        .headers()
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or(&resolved.mime_type)
                        .to_string();
                    let total = parse_total_from_headers(resp.headers(), resolved.content_length);
                    if let Ok(bytes) = resp.bytes().await {
                        proxy.audio_cache.store_head_bytes(
                            video_id,
                            &mime,
                            &bytes,
                            total.unwrap_or(0),
                        );
                    }
                }
        }
        let resp = format!("HTTP/1.1 202 Accepted\r\n{cors_origin}Content-Length: 0\r\n\r\n");
        let _ = socket.write_all(resp.as_bytes()).await;
        return Ok(());
    }
    let Some((req_start, req_end_opt)) = parse_byte_range(range_header.as_deref()) else {
        return respond_status(&mut socket, "416 Range Not Satisfiable").await;
    };
    let head_hit = proxy.audio_cache.head_bytes(video_id);
    if method != "HEAD" && req_start == 0
        && let Some((ref ctype, ref head_bytes, head_total)) = head_hit
            && let Some(req_end) = req_end_opt
                && (req_end as usize) < head_bytes.len() && head_total > 0 {
                    let slice_end = (req_end as usize) + 1;
                    return write_memory_range(
                        &mut socket,
                        ctype,
                        &head_bytes[..slice_end],
                        0,
                        req_end,
                        head_total,
                        &cors_origin,
                    )
                    .await;
                }

    // 3. Open-ended or large requests use bounded 2 MiB chunking to bypass YouTube's 2x realtime throttle.
    let known_total = resolved
        .content_length
        .or_else(|| head_hit.as_ref().map(|(_, _, t)| *t).filter(|t| *t > 0));
    let mut cur_start = req_start;
    let first_chunk_end = if let Some(req_end) = req_end_opt {
        req_end.min(cur_start + PROXY_CHUNK_BYTES - 1)
    } else if let Some(total) = known_total {
        total
            .saturating_sub(1)
            .min(cur_start + PROXY_CHUNK_BYTES - 1)
    } else {
        cur_start + PROXY_CHUNK_BYTES - 1
    };

    let mut upstream_resp =
        fetch_with_swap(&proxy, video_id, &mut resolved, cur_start, first_chunk_end).await;
    let Ok(mut resp) = upstream_resp else {
        let _ = socket
            .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            .await;
        return Ok(());
    };

    let mut status_code = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or(&resolved.mime_type)
        .to_string();
    let total_len = parse_total_from_headers(resp.headers(), known_total);
    let target_end = match (req_end_opt, total_len) {
        (Some(e), Some(t)) => Some(e.min(t.saturating_sub(1))),
        (Some(e), None) => Some(e),
        (None, Some(t)) => Some(t.saturating_sub(1)),
        (None, None) => None,
    };

    // If caller didn't send Range and total is known, still answer 200 (or 206 if Range was requested).
    if range_header.is_none() && status_code == 206 {
        status_code = 200;
    }
    let response_len = match (status_code, total_len, target_end) {
        (206, _, Some(end)) if end >= cur_start => Some(end - cur_start + 1),
        (200, Some(t), _) => Some(t),
        _ => resp
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok()),
    };

    let mut headers = format!(
        "HTTP/1.1 {status_code} {}\r\n{cors_origin}Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\nAccept-Ranges: bytes\r\nCache-Control: private, no-store\r\nContent-Type: {content_type}\r\n",
        if status_code == 206 {
            "Partial Content"
        } else {
            "OK"
        }
    );
    if let Some(len) = response_len {
        headers.push_str(&format!("Content-Length: {len}\r\n"));
    }
    if status_code == 206 {
        if let (Some(end), Some(total)) = (target_end, total_len) {
            headers.push_str(&format!(
                "Content-Range: bytes {cur_start}-{end}/{total}\r\n"
            ));
        } else if let Some(cr) = resp
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok())
        {
            headers.push_str(&format!("Content-Range: {cr}\r\n"));
        }
    }
    headers.push_str("Connection: close\r\n\r\n");
    if socket.write_all(headers.as_bytes()).await.is_err() || method == "HEAD" {
        return Ok(());
    }

    let disk_writer = if cur_start == 0
        && total_len.is_some_and(|t| t > 64 * 1024)
        && target_end == total_len.map(|t| t - 1)
    {
        proxy
            .audio_cache
            .register_full_download(video_id, &content_type, total_len.unwrap())
    } else {
        None
    };

    let mut streamed_ok = true;
    let mut stall_resumes = 0u32;
    loop {
        let mut chunk_written = 0u64;
        loop {
            match tokio::time::timeout(STALL_TIMEOUT, resp.chunk()).await {
                Ok(Ok(Some(bytes))) => {
                    if socket.write_all(&bytes).await.is_err() {
                        streamed_ok = false;
                        break;
                    }
                    if let Some(ref w) = disk_writer {
                        proxy
                            .audio_cache
                            .append_chunk(video_id, w, cur_start + chunk_written, &bytes)
                            .await;
                    } else if cur_start == 0 && chunk_written == 0 {
                        let cap = bytes.len().min(PREFETCH_HEAD_BYTES as usize);
                        proxy.audio_cache.store_head_bytes(
                            video_id,
                            &content_type,
                            &bytes[..cap],
                            total_len.unwrap_or(0),
                        );
                    }
                    stall_resumes = 0;
                    chunk_written += bytes.len() as u64;
                }
                Ok(Ok(None)) => break,
                Ok(Err(_)) | Err(_) => {
                    // Stalled mid-chunk: resume from cur_start + chunk_written via swap.
                    cur_start += chunk_written;
                    stall_resumes = if chunk_written == 0 { stall_resumes + 1 } else { 0 };
                    if let Some(end) = target_end {
                        if cur_start > end {
                            break;
                        }
                        // An upstream that answers headers and then errors instantly never
                        // moves cur_start; give up instead of resuming forever.
                        if stall_resumes > MAX_STALL_RESUMES {
                            streamed_ok = false;
                            break;
                        }
                        let next_end = end.min(cur_start + PROXY_CHUNK_BYTES - 1);
                        upstream_resp =
                            fetch_with_swap(&proxy, video_id, &mut resolved, cur_start, next_end)
                                .await;
                        if let Ok(next_resp) = upstream_resp {
                            resp = next_resp;
                            chunk_written = 0;
                            continue;
                        }
                    }
                    streamed_ok = false;
                    break;
                }
            }
        }
        if !streamed_ok {
            break;
        }
        cur_start += chunk_written;
        let Some(end) = target_end else {
            break;
        };
        if cur_start > end || chunk_written == 0 {
            break;
        }
        let next_end = end.min(cur_start + PROXY_CHUNK_BYTES - 1);
        match fetch_with_swap(&proxy, video_id, &mut resolved, cur_start, next_end).await {
            Ok(next_resp) => resp = next_resp,
            Err(_) => {
                streamed_ok = false;
                break;
            }
        }
    }

    if let Some(ref w) = disk_writer {
        proxy
            .audio_cache
            .finalize_download(video_id, w, streamed_ok)
            .await;
    }
    Ok(())
}

async fn fetch_with_swap(
    proxy: &YtStreamProxy,
    video_id: &str,
    resolved: &mut ResolvedYtStream,
    start: u64,
    end: u64,
) -> Result<reqwest::Response, String> {
    let range = format!("bytes={start}-{end}");
    const ACTIVATION_DELAYS_MS: &[u64] = &[200, 300, 400];

    for _attempt in 0..2 {
        let mut res = send_upstream(proxy, resolved, Some(&range)).await;
        if res.is_err() {
            // A stall or a reset connection is not the CDN refusing the URL, so
            // retry the exact same request once before concluding anything.
            res = send_upstream(proxy, resolved, Some(&range)).await;
        }
        let mut status = res.as_ref().ok().map(|r| r.status().as_u16());

        // Fresh TVHTML5 googlevideo URLs can return 403 briefly while CDN propagation settles.
        if matches!(status, Some(401 | 403))
            && resolved.client_key.eq_ignore_ascii_case("TVHTML5")
            && resolved.link_age() < Duration::from_secs(2)
        {
            for &delay_ms in ACTIVATION_DELAYS_MS {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                res = send_upstream(proxy, resolved, Some(&range)).await;
                status = res.as_ref().ok().map(|r| r.status().as_u16());
                if !matches!(status, Some(401 | 403)) {
                    break;
                }
            }
        }

        match status {
            Some(401 | 403) => {
                proxy.gates.record_refusal(
                    &resolved.client_key,
                    &resolved.direct_url,
                    resolved.link_age(),
                );
            }
            Some(_) => return res.map_err(|e| e.to_string()),
            // Transport failed even after the retry: swap the stream below, but
            // leave the gate map alone since no refusal was observed.
            None => {}
        }
        let failed_key = resolved.client_key.clone();
        if let Ok(swapped) = proxy.swap_refused_stream(video_id, resolved).await {
            if swapped.direct_url == resolved.direct_url && swapped.client_key == failed_key {
                break;
            }
            *resolved = swapped;
        } else {
            break;
        }
    }
    Err("Upstream refused stream".to_string())
}

async fn send_upstream(
    proxy: &YtStreamProxy,
    resolved: &ResolvedYtStream,
    range: Option<&str>,
) -> Result<reqwest::Response, String> {
    let client = match resolved.ip_param.as_deref() {
        Some(ip) if ip.parse::<IpAddr>().is_ok_and(|a| a.is_ipv6()) || ip.contains(':') => {
            &proxy.stream_http_v6
        }
        Some(ip) if ip.parse::<IpAddr>().is_ok_and(|a| a.is_ipv4()) || ip.contains('.') => {
            &proxy.stream_http_v4
        }
        _ => &proxy.stream_http,
    };
    let mut req = client
        .get(&resolved.direct_url)
        .header("User-Agent", &resolved.user_agent)
        .header("Accept", "*/*")
        .header("Accept-Encoding", "identity");
    if let Some(r) = range {
        req = req.header("Range", r);
    }
    tokio::time::timeout(STALL_TIMEOUT, req.send())
        .await
        .map_err(|_| "Upstream request timed out".to_string())?
        .map_err(|e| e.to_string())
}

fn parse_total_from_headers(
    headers: &reqwest::header::HeaderMap,
    fallback: Option<u64>,
) -> Option<u64> {
    if let Some(cr) = headers.get("content-range").and_then(|v| v.to_str().ok())
        && let Some((_, total_str)) = cr.rsplit_once('/')
            && let Ok(total) = total_str.trim().parse::<u64>() {
                return Some(total);
            }
    headers
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .or(fallback)
}

async fn write_memory_range(
    socket: &mut TcpStream,
    content_type: &str,
    data: &[u8],
    start: u64,
    end: u64,
    total: u64,
    cors_origin: &str,
) -> Result<(), String> {
    let hdr = format!(
        "HTTP/1.1 206 Partial Content\r\n{cors_origin}Accept-Ranges: bytes\r\nCache-Control: private, no-store\r\nContent-Type: {content_type}\r\nContent-Range: bytes {start}-{end}/{total}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        data.len()
    );
    let _ = socket.write_all(hdr.as_bytes()).await;
    let _ = socket.write_all(data).await;
    Ok(())
}

async fn respond_status(socket: &mut TcpStream, status: &str) -> Result<(), String> {
    let _ = socket
        .write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes())
        .await;
    Ok(())
}

/// Serves a file from the user's local library. Only ids registered by `local_scan` resolve.
async fn serve_registered_local(
    socket: &mut TcpStream,
    method: &str,
    range_header: Option<&str>,
    id: &str,
    cors_origin: &str,
) -> Result<(), String> {
    if !crate::local::is_valid_id(id) {
        return respond_status(socket, "400 Bad Request").await;
    }
    let Some(path) = crate::local::lookup(id) else {
        return respond_status(socket, "404 Not Found").await;
    };
    let Ok(meta) = tokio::fs::metadata(&path).await else {
        return respond_status(socket, "404 Not Found").await;
    };
    let ct = crate::local::content_type(&path);
    serve_local_file(socket, method, range_header, &path, meta.len(), ct, cors_origin).await
}

async fn serve_local_cover(socket: &mut TcpStream, id: &str, cors_origin: &str) -> Result<(), String> {
    if !crate::local::is_valid_id(id) {
        return respond_status(socket, "400 Bad Request").await;
    }
    let Some(path) = crate::local::lookup(id) else {
        return respond_status(socket, "404 Not Found").await;
    };
    let cover = tokio::task::spawn_blocking(move || crate::local::cover_bytes(&path)).await.ok().flatten();
    let Some((mime, bytes)) = cover else {
        return respond_status(socket, "404 Not Found").await;
    };
    let hdr = format!(
        "HTTP/1.1 200 OK\r\n{cors_origin}Content-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: private, max-age=86400\r\nConnection: close\r\n\r\n",
        bytes.len()
    );
    if socket.write_all(hdr.as_bytes()).await.is_ok() {
        let _ = socket.write_all(&bytes).await;
    }
    Ok(())
}

async fn serve_local_file(
    socket: &mut TcpStream,
    method: &str,
    range_header: Option<&str>,
    path: &std::path::Path,
    total: u64,
    content_type: &str,
    cors_origin: &str,
) -> Result<(), String> {
    let Some((start, end_opt)) = parse_byte_range(range_header) else {
        let _ = socket
            .write_all(
                format!(
                    "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\n\r\n"
                )
                .as_bytes(),
            )
            .await;
        return Ok(());
    };
    let end = end_opt.map_or_else(
        || total.saturating_sub(1),
        |e| e.min(total.saturating_sub(1)),
    );
    if start >= total || end < start {
        let _ = socket
            .write_all(
                format!(
                    "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\n\r\n"
                )
                .as_bytes(),
            )
            .await;
        return Ok(());
    }
    let len = end - start + 1;
    let status = if range_header.is_some() {
        "206 Partial Content"
    } else {
        "200 OK"
    };
    let mut hdr = format!(
        "HTTP/1.1 {status}\r\n{cors_origin}Accept-Ranges: bytes\r\nCache-Control: private, max-age=31536000, immutable\r\nContent-Type: {content_type}\r\nContent-Length: {len}\r\n"
    );
    if range_header.is_some() {
        hdr.push_str(&format!("Content-Range: bytes {start}-{end}/{total}\r\n"));
    }
    hdr.push_str("Connection: close\r\n\r\n");
    if socket.write_all(hdr.as_bytes()).await.is_err() || method == "HEAD" {
        return Ok(());
    }
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return Ok(());
    };
    let _ = file.seek(std::io::SeekFrom::Start(start)).await;
    let mut remaining = len;
    let mut buf = vec![0u8; 64 * 1024];
    while remaining > 0 {
        let to_read = (remaining as usize).min(buf.len());
        let Ok(read) = file.read(&mut buf[..to_read]).await else {
            break;
        };
        if read == 0 || socket.write_all(&buf[..read]).await.is_err() {
            break;
        }
        remaining -= read as u64;
    }
    Ok(())
}

#[cfg(test)]
mod origin_tests {
    use super::allowed_cors_origin;

    #[test]
    fn allows_only_application_origins_for_local_audio_requests() {
        assert_eq!(
            allowed_cors_origin("tauri://localhost"),
            Some("tauri://localhost")
        );
        assert_eq!(
            allowed_cors_origin("http://tauri.localhost"),
            Some("http://tauri.localhost")
        );
        assert_eq!(
            allowed_cors_origin("https://tauri.localhost"),
            Some("https://tauri.localhost")
        );
        assert_eq!(
            allowed_cors_origin("http://localhost:5173"),
            Some("http://localhost:5173")
        );
        assert_eq!(allowed_cors_origin("http://localhost.evil.test:5173"), None);
        assert_eq!(allowed_cors_origin("https://attacker.test"), None);
    }
}
