use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use reqwest::Client;
use serde_json::{Value, json};
use url::Url;

use super::clients::{
    ClientProfile, ResolvedYtStream, expire_ttl, extract_query_param_str, extract_query_param_u64,
};
use super::identity::{compute_sapisidhash, extract_cookie_value, read_ytmusic_credentials};
use super::player_js::PlayerJsSolver;

const PLAYER_ENDPOINT: &str = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const YOUTUBE_ORIGIN: &str = "https://www.youtube.com";
const TV_SAMSUNG_UA: &str = "Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1";
const TV_SAMSUNG_CLIENT_VERSION: &str = "5.20260707";

pub async fn resolve_via_web_embedded(
    http: &Client,
    solver: &Arc<PlayerJsSolver>,
    video_id: &str,
) -> Result<ResolvedYtStream, String> {
    let (_, sts) = solver.ensure_ready(http).await?;
    let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    let payload = json!({
        "videoId": video_id,
        "context": {
            "client": {
                "clientName": "WEB_EMBEDDED_PLAYER",
                "clientVersion": "1.20260213.01.00",
                "hl": "en",
                "gl": "US",
            },
            "thirdParty": {
                "embedUrl": format!("https://www.youtube.com/watch?v={video_id}")
            }
        },
        "playbackContext": {
            "contentPlaybackContext": {
                "html5Preference": "HTML5_PREF_WANTS",
                "signatureTimestamp": sts,
            }
        },
        "contentCheckOk": true,
        "racyCheckOk": true
    });
    let resp = http
        .post(PLAYER_ENDPOINT)
        .header("Content-Type", "application/json")
        .header("User-Agent", ua)
        .header("X-Youtube-Client-Name", "56")
        .header("X-Youtube-Client-Version", "1.20260213.01.00")
        .header("Origin", YOUTUBE_ORIGIN)
        .header("Referer", "https://www.youtube.com/")
        .json(&payload)
        .send()
        .await
        .map_err(|_| "Network error requesting WEB_EMBEDDED_PLAYER".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("WEB_EMBEDDED_PLAYER returned HTTP {}", resp.status().as_u16()));
    }
    let data: Value = resp
        .json()
        .await
        .map_err(|_| "WEB_EMBEDDED_PLAYER returned invalid JSON".to_string())?;
    let status = data
        .pointer("/playabilityStatus/status")
        .and_then(|v| v.as_str())
        .unwrap_or("UNKNOWN");
    if status != "OK" {
        let reason = data
            .pointer("/playabilityStatus/reason")
            .and_then(|v| v.as_str())
            .unwrap_or(status);
        return Err(format!("WEB_EMBEDDED_PLAYER: {reason}"));
    }
    let formats = data
        .pointer("/streamingData/adaptiveFormats")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "WEB_EMBEDDED_PLAYER: missing adaptiveFormats".to_string())?;
    let dummy_profile = ClientProfile {
        key: "WEB_EMBEDDED_PLAYER".to_string(),
        client_name: "WEB_EMBEDDED_PLAYER".to_string(),
        client_version: "1.20260213.01.00".to_string(),
        client_id: "56".to_string(),
        user_agent: ua.to_string(),
        os_name: None,
        os_version: None,
        device_make: None,
        device_model: None,
        android_sdk_version: None,
        send_visitor_data: true,
        send_cookie: false,
        is_embedded: true,
        hl: "en".to_string(),
        gl: "US".to_string(),
    };
    resolve_ciphered_formats(
        http,
        solver,
        formats,
        &dummy_profile,
        ua,
        Some("InnerTube: WEB_EMBEDDED_PLAYER"),
    )
    .await
}

pub async fn resolve_via_profile(
    http: &Client,
    solver: &Arc<PlayerJsSolver>,
    video_id: &str,
    profile: &ClientProfile,
    visitor_data: Option<&str>,
    cookie_header: Option<&str>,
) -> Result<ResolvedYtStream, String> {
    let mut context = profile.context_value(visitor_data);
    if profile.is_embedded {
        context["thirdParty"] = json!({
            "embedUrl": format!("https://www.youtube.com/watch?v={video_id}")
        });
    }
    let mut payload = json!({
        "videoId": video_id,
        "context": context,
        "contentCheckOk": true,
        "racyCheckOk": true
    });
    if profile.send_cookie || profile.client_name == "WEB_REMIX" || profile.is_embedded {
        if let Some(sts) = solver.current_sts() {
            payload["playbackContext"] = json!({
                "contentPlaybackContext": {
                    "html5Preference": "HTML5_PREF_WANTS",
                    "signatureTimestamp": sts
                }
            });
        }
    }

    let mut req = http
        .post(PLAYER_ENDPOINT)
        .header("Content-Type", "application/json")
        .header("User-Agent", &profile.user_agent)
        .header("X-Youtube-Client-Name", &profile.client_id)
        .header("X-Youtube-Client-Version", &profile.client_version)
        .header("Origin", if profile.client_name == "WEB_REMIX" { "https://music.youtube.com" } else { "https://www.youtube.com" })
        .header("Referer", if profile.client_name == "WEB_REMIX" { "https://music.youtube.com/" } else { "https://www.youtube.com/" });
    if profile.send_visitor_data {
        if let Some(vd) = visitor_data.filter(|s| !s.is_empty()) {
            req = req.header("X-Goog-Visitor-Id", vd);
        }
    }
    if profile.send_cookie {
        if let Some(cookie) = cookie_header {
            let origin = if profile.client_name == "WEB_REMIX" { "https://music.youtube.com" } else { YOUTUBE_ORIGIN };
            if let Some(sapisid) = extract_cookie_value(cookie, "__Secure-3PAPISID") {
                req = req
                    .header("Authorization", compute_sapisidhash(&sapisid, origin))
                    .header("X-Origin", origin);
            }
            req = req.header("Cookie", cookie);
        }
    }

    let resp = req
        .json(&payload)
        .send()
        .await
        .map_err(|_| format!("Network error requesting {}", profile.key))?;

    if !resp.status().is_success() {
        return Err(format!("{} returned HTTP {}", profile.key, resp.status().as_u16()));
    }

    let data: Value = resp
        .json()
        .await
        .map_err(|_| format!("{} returned invalid JSON", profile.key))?;

    let status = data
        .pointer("/playabilityStatus/status")
        .and_then(|v| v.as_str())
        .unwrap_or("UNKNOWN");

    if status != "OK" {
        let reason = data
            .pointer("/playabilityStatus/reason")
            .and_then(|v| v.as_str())
            .unwrap_or(status);
        return Err(format!("{}: {}", profile.key, reason));
    }

    let formats = data
        .pointer("/streamingData/adaptiveFormats")
        .and_then(|v| v.as_array())
        .ok_or_else(|| format!("{}: missing adaptiveFormats", profile.key))?;

    if profile.send_cookie {
        return resolve_ciphered_formats(http, solver, formats, profile, &profile.user_agent, None).await;
    }

    if let Ok(direct) = pick_best_direct_audio_format(formats, profile) {
        return Ok(direct);
    }
    resolve_ciphered_formats(http, solver, formats, profile, &profile.user_agent, None).await
}

async fn resolve_ciphered_formats(
    http: &Client,
    solver: &Arc<PlayerJsSolver>,
    formats: &[Value],
    profile: &ClientProfile,
    user_agent: &str,
    label_override: Option<&str>,
) -> Result<ResolvedYtStream, String> {
    let (raw_url, cipher_s, cipher_sp, mime_type, content_length, itag) =
        pick_best_audio_candidate(formats)
            .ok_or_else(|| format!("{}: no audio format", profile.key))?;
    let n_param = extract_query_param_str(&raw_url, "n").filter(|s| !s.is_empty());
    let final_url = if cipher_s.is_some() || n_param.is_some() {
        let (solved_sig, solved_n) = solver
            .solve_sig_and_n(http, cipher_s.as_deref(), n_param.as_deref())
            .await?;
        let mut parsed = Url::parse(&raw_url)
            .map_err(|e| format!("{} invalid URL: {e}", profile.key))?;
        let mut pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        if let Some(sig) = solved_sig {
            let sp = cipher_sp.as_deref().unwrap_or("sig");
            pairs.retain(|(k, _)| k != sp);
            pairs.push((sp.to_string(), sig));
        }
        if let Some(n_val) = solved_n {
            pairs.retain(|(k, _)| k != "n");
            pairs.push(("n".to_string(), n_val));
        }
        parsed.query_pairs_mut().clear().extend_pairs(pairs);
        parsed.to_string()
    } else {
        raw_url
    };
    let expire_unix = extract_query_param_u64(&final_url, "expire");
    let ip_param = extract_query_param_str(&final_url, "ip");
    let lmt = extract_query_param_u64(&final_url, "lmt");
    let client_key = extract_query_param_str(&final_url, "c").unwrap_or_else(|| profile.key.clone());
    Ok(ResolvedYtStream {
        direct_url: final_url,
        user_agent: user_agent.to_string(),
        extra_headers: HashMap::new(),
        mime_type,
        content_length,
        itag,
        lmt,
        client_key,
        issued_at: Instant::now(),
        expires_at: Instant::now() + expire_ttl(expire_unix),
        expire_unix,
        ip_param,
        level_label: label_override
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("InnerTube: {}", profile.key)),
    })
}

fn pick_best_direct_audio_format(
    formats: &[Value],
    profile: &ClientProfile,
) -> Result<ResolvedYtStream, String> {
    let mut best: Option<(i64, String, String, Option<u64>, Option<u64>)> = None;
    for fmt in formats {
        let Some(url) = fmt.get("url").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
            continue;
        };
        if extract_query_param_str(url, "n").is_some_and(|v| !v.is_empty()) {
            continue;
        }
        let mime_raw = fmt.get("mimeType").and_then(|v| v.as_str()).unwrap_or_default();
        if !mime_raw.starts_with("audio/") {
            continue;
        }
        let base_mime = mime_raw.split(';').next().unwrap_or("audio/mp4").trim().to_string();
        let itag = fmt.get("itag").and_then(|v| v.as_i64()).unwrap_or(0);
        let bitrate = fmt
            .get("averageBitrate")
            .or_else(|| fmt.get("bitrate"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let is_drc = fmt.get("isDrc").and_then(|v| v.as_bool()).unwrap_or(false);
        let is_default_track = fmt
            .pointer("/audioTrack/audioIsDefault")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let itag_bonus = if itag == 251 || itag == 140 { 500_000 } else { 0 };
        let codec_bonus = if base_mime.contains("webm") || base_mime.contains("opus") { 25_000 } else { 0 };
        let orig_bonus = if is_default_track { 1_000_000 } else { 0 };
        let drc_penalty = if is_drc { -200_000 } else { 0 };
        let score = bitrate + itag_bonus + codec_bonus + orig_bonus + drc_penalty;
        let content_length = fmt
            .get("contentLength")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<u64>().ok())
            .or_else(|| extract_query_param_u64(url, "clen"));
        let itag_u = u64::try_from(itag).ok().or_else(|| extract_query_param_u64(url, "itag"));

        if best.as_ref().is_none_or(|(b, _, _, _, _)| score > *b) {
            best = Some((score, url.to_string(), base_mime, content_length, itag_u));
        }
    }

    let Some((_, direct_url, mime_type, content_length, itag)) = best else {
        return Err(format!("{}: no clean direct audio URL", profile.key));
    };

    let expire_unix = extract_query_param_u64(&direct_url, "expire");
    let ip_param = extract_query_param_str(&direct_url, "ip");
    let lmt = extract_query_param_u64(&direct_url, "lmt");
    let client_key = extract_query_param_str(&direct_url, "c").unwrap_or_else(|| profile.key.clone());

    Ok(ResolvedYtStream {
        direct_url,
        user_agent: profile.user_agent.clone(),
        extra_headers: HashMap::new(),
        mime_type,
        content_length,
        itag,
        lmt,
        client_key,
        issued_at: Instant::now(),
        expires_at: Instant::now() + expire_ttl(expire_unix),
        expire_unix,
        ip_param,
        level_label: format!("InnerTube: {}", profile.key),
    })
}

pub async fn resolve_via_tv_samsung(
    http: &Client,
    solver: &Arc<PlayerJsSolver>,
    video_id: &str,
) -> Result<ResolvedYtStream, String> {
    let (_, sts) = solver.ensure_ready(http).await?;
    let payload = json!({
        "videoId": video_id,
        "context": {
            "client": {
                "clientName": "TVHTML5",
                "clientVersion": TV_SAMSUNG_CLIENT_VERSION,
                "deviceMake": "Samsung",
                "deviceModel": "UKS9800",
                "userAgent": TV_SAMSUNG_UA,
                "osName": "Tizen",
                "osVersion": "2.4.0",
                "hl": "en",
                "gl": "US",
            }
        },
        "playbackContext": {
            "contentPlaybackContext": {
                "html5Preference": "HTML5_PREF_WANTS",
                "signatureTimestamp": sts,
            }
        },
        "contentCheckOk": true,
        "racyCheckOk": true
    });

    let mut req = http
        .post(PLAYER_ENDPOINT)
        .header("Content-Type", "application/json")
        .header("User-Agent", TV_SAMSUNG_UA)
        .header("X-Youtube-Client-Name", "7")
        .header("X-Youtube-Client-Version", TV_SAMSUNG_CLIENT_VERSION)
        .header("Origin", YOUTUBE_ORIGIN)
        .header("Referer", "https://www.youtube.com/");

    if let Some(creds) = tokio::task::spawn_blocking(read_ytmusic_credentials)
        .await
        .ok()
        .flatten()
    {
        if let Some(sapisid) = extract_cookie_value(&creds.cookie, "__Secure-3PAPISID") {
            req = req
                .header("Authorization", compute_sapisidhash(&sapisid, YOUTUBE_ORIGIN))
                .header("Cookie", creds.cookie)
                .header("X-Goog-AuthUser", creds.auth_user)
                .header("X-Origin", YOUTUBE_ORIGIN);
        }
    }

    let resp = req
        .json(&payload)
        .send()
        .await
        .map_err(|_| "Network error requesting TVHTML5_SAMSUNG".to_string())?;

    if !resp.status().is_success() {
        return Err(format!("TVHTML5_SAMSUNG returned HTTP {}", resp.status().as_u16()));
    }

    let data: Value = resp
        .json()
        .await
        .map_err(|_| "TVHTML5_SAMSUNG returned invalid JSON".to_string())?;

    let status = data
        .pointer("/playabilityStatus/status")
        .and_then(|v| v.as_str())
        .unwrap_or("UNKNOWN");

    if status != "OK" {
        let reason = data
            .pointer("/playabilityStatus/reason")
            .and_then(|v| v.as_str())
            .unwrap_or(status);
        return Err(format!("TVHTML5_SAMSUNG: {reason}"));
    }

    let formats = data
        .pointer("/streamingData/adaptiveFormats")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "TVHTML5_SAMSUNG: missing adaptiveFormats".to_string())?;

    let (raw_url, cipher_s, cipher_sp, mime_type, content_length, itag) =
        pick_best_audio_candidate(formats)
            .ok_or_else(|| "TVHTML5_SAMSUNG: no audio format".to_string())?;

    let n_param = extract_query_param_str(&raw_url, "n").filter(|s| !s.is_empty());
    let final_url = if cipher_s.is_some() || n_param.is_some() {
        let (solved_sig, solved_n) = solver
            .solve_sig_and_n(http, cipher_s.as_deref(), n_param.as_deref())
            .await?;
        let mut parsed =
            Url::parse(&raw_url).map_err(|e| format!("TVHTML5_SAMSUNG invalid URL: {e}"))?;
        let mut pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();

        if let Some(sig) = solved_sig {
            let sp = cipher_sp.as_deref().unwrap_or("sig");
            pairs.retain(|(k, _)| k != sp);
            pairs.push((sp.to_string(), sig));
        }
        if let Some(n_val) = solved_n {
            pairs.retain(|(k, _)| k != "n");
            pairs.push(("n".to_string(), n_val));
        }

        parsed.query_pairs_mut().clear().extend_pairs(pairs);
        parsed.to_string()
    } else {
        raw_url
    };

    let expire_unix = extract_query_param_u64(&final_url, "expire");
    let ip_param = extract_query_param_str(&final_url, "ip");
    let lmt = extract_query_param_u64(&final_url, "lmt");
    let client_key = extract_query_param_str(&final_url, "c").unwrap_or_else(|| "TVHTML5".to_string());

    Ok(ResolvedYtStream {
        direct_url: final_url,
        user_agent: TV_SAMSUNG_UA.to_string(),
        extra_headers: HashMap::new(),
        mime_type,
        content_length,
        itag,
        lmt,
        client_key,
        issued_at: Instant::now(),
        expires_at: Instant::now() + expire_ttl(expire_unix),
        expire_unix,
        ip_param,
        level_label: "InnerTube: TVHTML5_SAMSUNG (fast)".to_string(),
    })
}

fn pick_best_audio_candidate(
    formats: &[Value],
) -> Option<(String, Option<String>, Option<String>, String, Option<u64>, Option<u64>)> {
    let mut best: Option<(
        i64,
        String,
        Option<String>,
        Option<String>,
        String,
        Option<u64>,
        Option<u64>,
    )> = None;

    for fmt in formats {
        let mime_raw = fmt.get("mimeType").and_then(|v| v.as_str()).unwrap_or_default();
        if !mime_raw.starts_with("audio/") {
            continue;
        }
        let (url, sig, sp) = if let Some(u) = fmt.get("url").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            (u.to_string(), None, None)
        } else if let Some(sc) = fmt.get("signatureCipher").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            let parsed = Url::parse(&format!("https://example.invalid/?{sc}")).ok()?;
            let mut u = None;
            let mut s = None;
            let mut p = None;
            for (k, v) in parsed.query_pairs() {
                match k.as_ref() {
                    "url" => u = Some(v.into_owned()),
                    "s" => s = Some(v.into_owned()),
                    "sp" => p = Some(v.into_owned()),
                    _ => {}
                }
            }
            let raw_u = u?;
            (raw_u, s, p)
        } else {
            continue;
        };

        let base_mime = mime_raw.split(';').next().unwrap_or("audio/mp4").trim().to_string();
        let itag = fmt.get("itag").and_then(|v| v.as_i64()).unwrap_or(0);
        let bitrate = fmt
            .get("averageBitrate")
            .or_else(|| fmt.get("bitrate"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let is_drc = fmt.get("isDrc").and_then(|v| v.as_bool()).unwrap_or(false);
        let is_default_track = fmt
            .pointer("/audioTrack/audioIsDefault")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let itag_bonus = if itag == 251 || itag == 140 { 500_000 } else { 0 };
        let codec_bonus = if base_mime.contains("webm") || base_mime.contains("opus") { 25_000 } else { 0 };
        let orig_bonus = if is_default_track { 1_000_000 } else { 0 };
        let drc_penalty = if is_drc { -200_000 } else { 0 };
        let score = bitrate + itag_bonus + codec_bonus + orig_bonus + drc_penalty;
        let content_length = fmt
            .get("contentLength")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<u64>().ok())
            .or_else(|| extract_query_param_u64(&url, "clen"));
        let itag_u = u64::try_from(itag).ok().or_else(|| extract_query_param_u64(&url, "itag"));

        if best.as_ref().is_none_or(|(b, _, _, _, _, _, _)| score > *b) {
            best = Some((score, url, sig, sp, base_mime, content_length, itag_u));
        }
    }

    best.map(|(_, u, s, sp, m, clen, itag)| (u, s, sp, m, clen, itag))
}

pub fn is_permanent_reason(reason: &str) -> bool {
    let r = reason.to_lowercase();
    [
        "video unavailable",
        "this video is not available",
        "private video",
        "this video has been removed",
        "has been removed",
        "not available in your country",
        "blocked it in your country",
        "copyright",
        "account associated with this video has been terminated",
    ]
    .iter()
    .any(|needle| r.contains(needle))
}

pub fn is_bot_wall_reason(reason: &str) -> bool {
    let r = reason.to_lowercase();
    r.contains("sign in to confirm") || r.contains("not a bot") || r.contains("please sign in")
}
