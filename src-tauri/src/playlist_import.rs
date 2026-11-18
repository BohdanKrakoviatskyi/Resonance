use std::collections::HashSet;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use crate::yt::clients::is_valid_video_id;
use crate::yt::music_api::fetch_playlist_tracks_native;
use crate::yt::music_parse::{best_thumbnail, collect_by_key, runs_text};

const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPlaylistTrackDto {
    pub title: String,
    pub artist: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    pub duration_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artwork_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPlaylistDto {
    pub source: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artwork_url: Option<String>,
    pub tracks: Vec<ExternalPlaylistTrackDto>,
}

fn normalize_input_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Paste a playlist link first.".to_string());
    }
    if let Some(rest) = trimmed.strip_prefix("spotify:playlist:") {
        let id = rest.split(':').next().unwrap_or("").trim();
        if !id.is_empty() {
            return Url::parse(&format!("https://open.spotify.com/playlist/{id}"))
                .map_err(|e| format!("Invalid Spotify playlist URI: {e}"));
        }
    }
    let with_scheme = if trimmed.starts_with("https://") {
        trimmed.to_string()
    } else if trimmed.starts_with("http://") {
        return Err("Playlist links must use HTTPS.".to_string());
    } else {
        format!("https://{trimmed}")
    };
    Url::parse(&with_scheme).map_err(|_| "Unsupported or invalid link.".to_string())
}

fn is_allowed_playlist_url(url: &Url) -> bool {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return false;
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if crate::yandex_import::is_yandex_music_host(&host) || host == "api.music.yandex.net" {
        return true;
    }
    matches!(
        host.as_str(),
        "youtube.com"
            | "www.youtube.com"
            | "music.youtube.com"
            | "m.youtube.com"
            | "youtu.be"
            | "open.spotify.com"
            | "www.open.spotify.com"
            | "spotify.link"
            | "spoti.fi"
            | "deezer.com"
            | "www.deezer.com"
            | "deezer.page.link"
            | "link.deezer.com"
            | "api.deezer.com"
            | "music.apple.com"
            | "www.music.apple.com"
            | "geo.music.apple.com"
            | "itunes.apple.com"
    )
}

fn is_safe_deezer_api_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case("api.deezer.com"))
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
}

fn playlist_http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !is_allowed_playlist_url(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| format!("Could not initialize playlist networking: {e}"))
}

async fn resolve_redirects(http: &Client, url: &Url) -> Result<Url, String> {
    if !is_allowed_playlist_url(url) {
        return Err("Unsupported or unsafe playlist link.".to_string());
    }
    let resp = http
        .get(url.as_str())
        .header("User-Agent", BROWSER_UA)
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("Failed to open link: {e}"))?;
    let final_url = resp.url().clone();
    if !is_allowed_playlist_url(&final_url) {
        return Err("Playlist link redirected to an unsupported destination.".to_string());
    }
    Ok(final_url)
}

async fn fetch_html(http: &Client, url: &str) -> Result<String, String> {
    let resp = http
        .get(url)
        .header("User-Agent", BROWSER_UA)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("Network request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Service returned HTTP {}", resp.status().as_u16()));
    }
    let bytes = read_response_limited(resp, 8 << 20).await?;
    String::from_utf8(bytes).map_err(|e| format!("Invalid page encoding: {e}"))
}

pub(crate) async fn read_limited(response: reqwest::Response, max_bytes: usize) -> Result<Vec<u8>, String> {
    read_response_limited(response, max_bytes).await
}

async fn read_response_limited(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|size| size > max_bytes as u64)
    {
        return Err("Response exceeds the allowed size.".to_string());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Failed to read response: {e}"))?
    {
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err("Response exceeds the allowed size.".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn extract_script_by_id<'a>(html: &'a str, id: &str) -> Option<&'a str> {
    let needle_dq = format!("id=\"{id}\"");
    let needle_sq = format!("id='{id}'");
    let pos = html.find(&needle_dq).or_else(|| html.find(&needle_sq))?;
    let after_id = &html[pos..];
    let gt = after_id.find('>')?;
    let content = &after_id[gt + 1..];
    let end = content.find("</script>")?;
    Some(content[..end].trim())
}

fn extract_meta_content(html: &str, name: &str) -> Option<String> {
    for attr in ["property", "name"] {
        for quote in ['"', '\''] {
            let pat = format!("{attr}={quote}{name}{quote}");
            if let Some(pos) = html.find(&pat) {
                let slice = &html[pos..pos.saturating_add(600).min(html.len())];
                if let Some(c_pos) = slice.find("content=") {
                    let after = &slice[c_pos + 8..];
                    let q = after.chars().next()?;
                    if q == '"' || q == '\'' {
                        if let Some(end) = after[1..].find(q) {
                            return Some(html_unescape(&after[1..1 + end]));
                        }
                    }
                }
            }
        }
    }
    None
}

fn html_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace('\u{00a0}', " ")
}

async fn fetch_youtube_playlist(http: &Client, url: &Url) -> Result<ExternalPlaylistDto, String> {
    let list_id = url
        .query_pairs()
        .find(|(k, _)| k == "list")
        .map(|(_, v)| v.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "YouTube link does not contain a playlist (?list=...).".to_string())?;

    let pl = fetch_playlist_tracks_native(http, &list_id).await?;
    let raw_tracks = pl.tracks.unwrap_or_default();
    if raw_tracks.is_empty() {
        return Err("Playlist is empty or unavailable.".to_string());
    }
    let tracks = raw_tracks
        .into_iter()
        .filter(|t| is_valid_video_id(&t.video_id))
        .map(|t| ExternalPlaylistTrackDto {
            title: t.title,
            artist: if t.artist.is_empty() {
                t.artists.join(", ")
            } else {
                t.artist
            },
            album: None,
            duration_ms: t
                .duration_seconds
                .map_or(0, |s| (s * 1000.0).round() as i64),
            artwork_url: t.artwork_url,
            native_id: Some(t.video_id),
        })
        .collect();

    Ok(ExternalPlaylistDto {
        source: "youtube".to_string(),
        title: pl.title,
        artwork_url: pl.artwork_url,
        tracks,
    })
}

async fn fetch_deezer_playlist(
    http: &Client,
    initial_url: &Url,
) -> Result<ExternalPlaylistDto, String> {
    let host = initial_url
        .host_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let final_url = if host == "deezer.page.link" || host == "link.deezer.com" {
        resolve_redirects(http, initial_url).await?
    } else {
        initial_url.clone()
    };

    let segments: Vec<&str> = final_url
        .path_segments()
        .map(|s| s.collect())
        .unwrap_or_default();
    let playlist_id = segments
        .windows(2)
        .find(|w| w[0] == "playlist")
        .map(|w| w[1])
        .and_then(|s| {
            s.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .into()
        })
        .filter(|s: &String| !s.is_empty())
        .ok_or_else(|| "Could not extract Deezer playlist ID from link.".to_string())?;

    let meta_url = format!("https://api.deezer.com/playlist/{playlist_id}");
    let resp = http
        .get(&meta_url)
        .header("User-Agent", BROWSER_UA)
        .send()
        .await
        .map_err(|e| format!("Deezer request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Deezer returned HTTP {}", resp.status().as_u16()));
    }
    let bytes = read_response_limited(resp, 4 << 20).await?;
    let data: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid Deezer JSON: {e}"))?;
    if let Some(err_msg) = data.pointer("/error/message").and_then(|v| v.as_str()) {
        return Err(format!("Deezer: {err_msg}"));
    }

    let title = data
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Deezer Playlist")
        .to_string();
    let artwork_url = data
        .get("picture_xl")
        .or_else(|| data.get("picture_big"))
        .or_else(|| data.get("picture_medium"))
        .and_then(|v| v.as_str())
        .map(ToOwned::to_owned);

    let mut tracks = Vec::new();
    let mut seen = HashSet::new();
    let push_deezer_items =
        |arr: &[Value], out: &mut Vec<ExternalPlaylistTrackDto>, seen: &mut HashSet<String>| {
            for item in arr {
                let t_title = item
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                if t_title.is_empty() {
                    continue;
                }
                let artist = item
                    .pointer("/artist/name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let album = item
                    .pointer("/album/title")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                let duration_ms = item.get("duration").and_then(|v| v.as_i64()).unwrap_or(0) * 1000;
                let cover = item
                    .pointer("/album/cover_medium")
                    .or_else(|| item.pointer("/album/cover"))
                    .and_then(|v| v.as_str())
                    .map(ToOwned::to_owned);
                let id_key = item
                    .get("id")
                    .and_then(|v| v.as_i64())
                    .map(|id| id.to_string())
                    .unwrap_or_else(|| format!("{t_title}:{artist}:{duration_ms}"));
                if !seen.insert(id_key) {
                    continue;
                }
                out.push(ExternalPlaylistTrackDto {
                    title: t_title.to_string(),
                    artist,
                    album,
                    duration_ms,
                    artwork_url: cover,
                    native_id: None,
                });
            }
        };

    if let Some(initial_arr) = data.pointer("/tracks/data").and_then(|v| v.as_array()) {
        push_deezer_items(initial_arr, &mut tracks, &mut seen);
    }

    let mut next_url = data
        .pointer("/tracks/next")
        .and_then(|v| v.as_str())
        .map(ToOwned::to_owned);
    if next_url.is_none() {
        let total = data.get("nb_tracks").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        if total > tracks.len() && !tracks.is_empty() {
            next_url = Some(format!(
                "https://api.deezer.com/playlist/{playlist_id}/tracks?index={}&limit=100",
                tracks.len()
            ));
        }
    }

    for _page in 0..30 {
        let Some(url_str) = next_url.take() else {
            break;
        };
        let Ok(page_url) = Url::parse(&url_str) else {
            break;
        };
        if !is_safe_deezer_api_url(&page_url) {
            break;
        }
        let Ok(page_resp) = http
            .get(page_url)
            .header("User-Agent", BROWSER_UA)
            .send()
            .await
        else {
            break;
        };
        if !page_resp.status().is_success() {
            break;
        }
        let Ok(page_bytes) = read_response_limited(page_resp, 4 << 20).await else {
            break;
        };
        let Ok(page_json) = serde_json::from_slice::<Value>(&page_bytes) else {
            break;
        };
        let Some(arr) = page_json.get("data").and_then(|v| v.as_array()) else {
            break;
        };
        if arr.is_empty() {
            break;
        }
        let before = tracks.len();
        push_deezer_items(arr, &mut tracks, &mut seen);
        if tracks.len() == before {
            break;
        }
        next_url = page_json
            .get("next")
            .and_then(|v| v.as_str())
            .map(ToOwned::to_owned);
    }

    if tracks.is_empty() {
        return Err("Deezer playlist is empty or private.".to_string());
    }

    Ok(ExternalPlaylistDto {
        source: "deezer".to_string(),
        title,
        artwork_url,
        tracks,
    })
}

async fn fetch_spotify_playlist(
    http: &Client,
    initial_url: &Url,
) -> Result<ExternalPlaylistDto, String> {
    let host = initial_url
        .host_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let final_url = if host == "spotify.link" || host == "spoti.fi" {
        resolve_redirects(http, initial_url).await?
    } else {
        initial_url.clone()
    };

    let segments: Vec<&str> = final_url
        .path_segments()
        .map(|s| s.collect())
        .unwrap_or_default();
    let playlist_id = segments
        .windows(2)
        .find(|w| w[0] == "playlist")
        .map(|w| w[1].trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Only Spotify playlist links are supported.".to_string())?;

    let embed_url = format!("https://open.spotify.com/embed/playlist/{playlist_id}");
    let html = fetch_html(http, &embed_url).await?;
    let next_json = extract_script_by_id(&html, "__NEXT_DATA__")
        .ok_or_else(|| "Could not read Spotify playlist metadata.".to_string())?;
    let parsed: Value =
        serde_json::from_str(next_json).map_err(|e| format!("Invalid Spotify embed data: {e}"))?;

    let entity = parsed
        .pointer("/props/pageProps/state/data/entity")
        .ok_or_else(|| "Spotify playlist is private or unavailable.".to_string())?;

    let title = entity
        .get("name")
        .or_else(|| entity.get("title"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Spotify Playlist")
        .to_string();

    let artwork_url = entity
        .pointer("/coverArt/sources")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let u = item.get("url").and_then(|v| v.as_str())?;
                    let w = item.get("width").and_then(|v| v.as_i64()).unwrap_or(0);
                    Some((w, u.to_string()))
                })
                .max_by_key(|(w, _)| *w)
                .map(|(_, u)| u)
        });

    let track_list = entity
        .get("trackList")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Spotify playlist contains no readable tracks.".to_string())?;

    let mut tracks = Vec::with_capacity(track_list.len());
    for item in track_list {
        let t_title = item
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if t_title.is_empty() {
            continue;
        }
        let artist = item
            .get("subtitle")
            .and_then(|v| v.as_str())
            .map(|s| s.replace('\u{00a0}', " ").trim().to_string())
            .unwrap_or_default();
        let duration_ms = item.get("duration").and_then(|v| v.as_i64()).unwrap_or(0);
        tracks.push(ExternalPlaylistTrackDto {
            title: t_title.to_string(),
            artist,
            album: None,
            duration_ms,
            artwork_url: None,
            native_id: None,
        });
    }

    if tracks.is_empty() {
        return Err("Spotify playlist is empty or private.".to_string());
    }

    Ok(ExternalPlaylistDto {
        source: "spotify".to_string(),
        title,
        artwork_url,
        tracks,
    })
}

fn format_apple_artwork(template: &str, size: u32) -> String {
    let s = size.to_string();
    template
        .replace("{w}", &s)
        .replace("{h}", &s)
        .replace("{f}", "jpg")
}

async fn fetch_apple_music_playlist(
    http: &Client,
    url: &Url,
) -> Result<ExternalPlaylistDto, String> {
    let html = fetch_html(http, url.as_str()).await?;
    let mut title = extract_meta_content(&html, "apple:title")
        .or_else(|| extract_meta_content(&html, "og:title"))
        .unwrap_or_else(|| "Apple Music Playlist".to_string());
    let mut artwork_url = extract_meta_content(&html, "og:image");
    let mut tracks = Vec::new();

    if let Some(raw_json) = extract_script_by_id(&html, "serialized-server-data") {
        if let Ok(parsed) = serde_json::from_str::<Value>(raw_json) {
            let mut headers = Vec::new();
            collect_by_key(&parsed, "containerDetailHeaderLockup", &mut headers);
            if let Some(hdr) = headers.first() {
                if let Some(t) = hdr
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    title = t.to_string();
                }
                if let Some(art_tpl) = hdr
                    .pointer("/artwork/dictionary/url")
                    .and_then(|v| v.as_str())
                {
                    artwork_url = Some(format_apple_artwork(art_tpl, 500));
                } else if let Some(u) = best_thumbnail(hdr.pointer("/artwork/sources")) {
                    artwork_url = Some(u);
                }
            }

            let mut lockups = Vec::new();
            collect_by_key(&parsed, "trackLockup", &mut lockups);
            // serialized-server-data stores sections[].items for trackLockup; if trackLockup is itemKind rather than key:
            if lockups.is_empty() {
                if let Some(sections) = parsed
                    .pointer("/data/0/data/sections")
                    .or_else(|| parsed.pointer("/0/data/sections"))
                    .and_then(|v| v.as_array())
                {
                    for sec in sections {
                        let kind = sec.get("itemKind").and_then(|v| v.as_str()).unwrap_or("");
                        if kind == "containerDetailHeaderLockup" {
                            if let Some(hdr) = sec.pointer("/items/0") {
                                if let Some(t) = hdr
                                    .get("title")
                                    .and_then(|v| v.as_str())
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty())
                                {
                                    title = t.to_string();
                                }
                                if let Some(art_tpl) = hdr
                                    .pointer("/artwork/dictionary/url")
                                    .and_then(|v| v.as_str())
                                {
                                    artwork_url = Some(format_apple_artwork(art_tpl, 500));
                                }
                            }
                        } else if kind == "trackLockup" {
                            if let Some(items) = sec.get("items").and_then(|v| v.as_array()) {
                                lockups.extend(items.iter());
                            }
                        }
                    }
                }
            }

            let mut seen = HashSet::new();
            for item in lockups {
                let t_title = item
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                if t_title.is_empty() {
                    continue;
                }
                let artists: Vec<String> = item
                    .get("subtitleLinks")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|link| link.get("title").and_then(|v| v.as_str()))
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                            .collect()
                    })
                    .unwrap_or_default();
                let artist = if !artists.is_empty() {
                    artists.join(", ")
                } else {
                    runs_text(item.pointer("/subtitle/runs"))
                };
                let album = item
                    .pointer("/tertiaryLinks/0/title")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                let duration_ms = item
                    .get("duration")
                    .or_else(|| item.get("durationInMillis"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                let cover = item
                    .pointer("/artwork/dictionary/url")
                    .and_then(|v| v.as_str())
                    .map(|tpl| format_apple_artwork(tpl, 240));
                let id_key = item
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| format!("{t_title}:{artist}:{duration_ms}"));
                if !seen.insert(id_key) {
                    continue;
                }
                tracks.push(ExternalPlaylistTrackDto {
                    title: t_title.to_string(),
                    artist,
                    album,
                    duration_ms,
                    artwork_url: cover,
                    native_id: None,
                });
            }
        }
    }

    if tracks.is_empty() {
        return Err("Apple Music playlist is empty or could not be parsed.".to_string());
    }

    Ok(ExternalPlaylistDto {
        source: "apple_music".to_string(),
        title,
        artwork_url,
        tracks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn playlist_urls_require_https_and_allowed_provider_hosts() {
        let allowed: Url = "https://open.spotify.com/playlist/abc".parse().unwrap();
        let http: Url = "http://open.spotify.com/playlist/abc".parse().unwrap();
        let lookalike: Url = "https://open.spotify.com.attacker.test/playlist/abc"
            .parse()
            .unwrap();
        let provider_subdomain: Url = "https://attacker.music.apple.com/playlist/abc"
            .parse()
            .unwrap();
        let credentials: Url = "https://user:pass@open.spotify.com/playlist/abc"
            .parse()
            .unwrap();
        assert!(is_allowed_playlist_url(&allowed));
        assert!(!is_allowed_playlist_url(&http));
        assert!(!is_allowed_playlist_url(&lookalike));
        assert!(!is_allowed_playlist_url(&provider_subdomain));
        assert!(!is_allowed_playlist_url(&credentials));
    }

    #[test]
    fn deezer_pagination_accepts_only_https_api_origin() {
        let valid: Url = "https://api.deezer.com/playlist/42/tracks?index=100"
            .parse()
            .unwrap();
        let http: Url = "http://api.deezer.com/playlist/42/tracks".parse().unwrap();
        let private: Url = "http://127.0.0.1/admin".parse().unwrap();
        let lookalike: Url = "https://api.deezer.com.attacker.test/tracks"
            .parse()
            .unwrap();
        let nonstandard_port: Url = "https://api.deezer.com:444/tracks".parse().unwrap();
        assert!(is_safe_deezer_api_url(&valid));
        assert!(!is_safe_deezer_api_url(&http));
        assert!(!is_safe_deezer_api_url(&private));
        assert!(!is_safe_deezer_api_url(&lookalike));
        assert!(!is_safe_deezer_api_url(&nonstandard_port));
    }

    #[test]
    fn insecure_playlist_input_is_rejected() {
        assert!(normalize_input_url("http://open.spotify.com/playlist/abc").is_err());
        assert!(normalize_input_url("open.spotify.com/playlist/abc").is_ok());
    }
}

#[tauri::command]
pub async fn fetch_external_playlist(url: String) -> Result<ExternalPlaylistDto, String> {
    let parsed = normalize_input_url(&url)?;
    if !is_allowed_playlist_url(&parsed) {
        return Err("Unsupported or unsafe playlist link.".to_string());
    }
    let http = playlist_http_client()?;
    let host = parsed
        .host_str()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .trim_start_matches("www.")
        .to_string();

    if matches!(
        host.as_str(),
        "youtube.com" | "music.youtube.com" | "m.youtube.com" | "youtu.be"
    ) {
        return fetch_youtube_playlist(&http, &parsed).await;
    }
    if host == "open.spotify.com" || host == "spotify.link" || host == "spoti.fi" {
        return fetch_spotify_playlist(&http, &parsed).await;
    }
    if host == "deezer.com"
        || host.ends_with(".deezer.com")
        || host == "deezer.page.link"
        || host == "link.deezer.com"
    {
        return fetch_deezer_playlist(&http, &parsed).await;
    }
    if matches!(
        host.as_str(),
        "music.apple.com" | "geo.music.apple.com" | "itunes.apple.com"
    ) || host.ends_with(".music.apple.com")
    {
        return fetch_apple_music_playlist(&http, &parsed).await;
    }
    if crate::yandex_import::is_yandex_music_host(&host) {
        return crate::yandex_import::fetch_yandex_music(&http, &parsed).await;
    }

    Err("Unsupported playlist link.".to_string())
}
