use std::collections::HashSet;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::clients::{is_valid_video_id, registry_snapshot};
use super::identity::{
    YtMusicProfile, compute_sapisidhash, extract_cookie_value, read_ytmusic_credentials,
};
use super::music_parse::{
    YtMusicPlaylistDto, YtMusicTrackDto, YtSearchSuggestionsDto, YtSearchTrackDto, best_thumbnail,
    collect_by_key, extract_header_artwork, extract_playlist_title, find_continuation_token,
    parse_count_from_text, parse_duration_secs, parse_responsive_track, runs_text, to_search_dto,
    track_renderers,
};
use super::proxy::YtStreamProxy;

const MUSIC_BROWSE_URL: &str = "https://music.youtube.com/youtubei/v1/browse?prettyPrint=false";
const MUSIC_SEARCH_URL: &str = "https://music.youtube.com/youtubei/v1/search?prettyPrint=false";
const MUSIC_NEXT_URL: &str = "https://music.youtube.com/youtubei/v1/next?prettyPrint=false";
const MUSIC_SUGGEST_URL: &str =
    "https://music.youtube.com/youtubei/v1/music/get_search_suggestions?prettyPrint=false";
const MUSIC_ACCOUNT_URL: &str =
    "https://music.youtube.com/youtubei/v1/account/account_menu?prettyPrint=false";
const ORIGIN: &str = "https://music.youtube.com";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtMusicLibraryDto {
    pub profile: YtMusicProfile,
    pub playlists: Vec<YtMusicPlaylistDto>,
    pub liked_songs: Vec<YtMusicTrackDto>,
}

pub async fn post_music(
    http: &Client,
    url: &str,
    mut body: Value,
    authenticated: bool,
) -> Result<Value, String> {
    let reg = registry_snapshot();
    let remix = &reg.web_remix;
    if body.get("context").is_none() {
        body["context"] = remix.context_value(None);
    }

    let mut req = http
        .post(url)
        .header("Content-Type", "application/json")
        .header("User-Agent", &remix.user_agent)
        .header("Origin", ORIGIN)
        .header("Referer", "https://music.youtube.com/")
        .header("X-Origin", ORIGIN)
        .header("X-Youtube-Client-Name", &remix.client_id)
        .header("X-Youtube-Client-Version", &remix.client_version);

    if authenticated
        && let Some(creds) = tokio::task::spawn_blocking(read_ytmusic_credentials)
            .await
            .ok()
            .flatten()
            && let Some(sapisid) = extract_cookie_value(&creds.cookie, "__Secure-3PAPISID") {
                req = req
                    .header("Authorization", compute_sapisidhash(&sapisid, ORIGIN))
                    .header("Cookie", creds.cookie)
                    .header("X-Goog-AuthUser", creds.auth_user);
            }

    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("YouTube Music request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("YouTube Music returned HTTP {}", resp.status().as_u16()));
    }
    resp.json::<Value>()
        .await
        .map_err(|e| format!("Invalid YouTube Music JSON: {e}"))
}

pub async fn fetch_account_profile(
    http: &Client,
    cookie: &str,
    auth_user: &str,
) -> Result<YtMusicProfile, String> {
    let sapisid = extract_cookie_value(cookie, "__Secure-3PAPISID")
        .ok_or_else(|| "YouTube Music session cookie missing.".to_string())?;
    let reg = registry_snapshot();
    let remix = &reg.web_remix;
    let body = json!({
        "context": remix.context_value(None),
        "deviceOutputType": "BROWSER_UNKNOWN"
    });
    let resp = http
        .post(MUSIC_ACCOUNT_URL)
        .header("Content-Type", "application/json")
        .header("User-Agent", &remix.user_agent)
        .header("Origin", ORIGIN)
        .header("Referer", "https://music.youtube.com/")
        .header("X-Origin", ORIGIN)
        .header("Authorization", compute_sapisidhash(&sapisid, ORIGIN))
        .header("Cookie", cookie)
        .header("X-Goog-AuthUser", auth_user)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to validate YouTube Music account: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Account validation failed: HTTP {}", resp.status().as_u16()));
    }
    let data: Value = resp.json().await.map_err(|e| format!("Invalid account JSON: {e}"))?;
    let mut hdrs = Vec::new();
    collect_by_key(&data, "activeAccountHeaderRenderer", &mut hdrs);
    let hdr = hdrs.first().copied().ok_or_else(|| "YouTube Music rejected the session.".to_string())?;
    let name = runs_text(hdr.pointer("/accountName/runs"));
    let handle = runs_text(hdr.pointer("/channelHandle/runs"));
    let picture = best_thumbnail(hdr.pointer("/accountPhoto/thumbnails")).unwrap_or_default();
    if name.is_empty() && handle.is_empty() {
        return Err("YouTube Music did not return an account.".to_string());
    }
    Ok(YtMusicProfile { name, handle, picture })
}

pub async fn sync_library(http: &Client) -> Result<YtMusicLibraryDto, String> {
    let creds = tokio::task::spawn_blocking(read_ytmusic_credentials)
        .await
        .ok()
        .flatten()
        .ok_or_else(|| "Connect YouTube Music before loading your library.".to_string())?;

    let saved_profile = creds.profile.clone().unwrap_or_default();
    let (acc_res, pls_res, liked_res) = tokio::join!(
        fetch_account_profile(http, &creds.cookie, &creds.auth_user),
        fetch_user_playlists(http),
        fetch_liked_songs(http),
    );

    let profile = match acc_res {
        Ok(p) if !p.name.is_empty() => p,
        _ => saved_profile,
    };
    let playlists = pls_res.unwrap_or_default();
    let liked_songs = liked_res.unwrap_or_default();

    if profile.name.is_empty() && playlists.is_empty() && liked_songs.is_empty() {
        return Err("Сессия YouTube Music истекла. Переподключите аккаунт в настройках.".to_string());
    }

    Ok(YtMusicLibraryDto { profile, playlists, liked_songs })
}

async fn fetch_user_playlists(http: &Client) -> Result<Vec<YtMusicPlaylistDto>, String> {
    let data = post_music(http, MUSIC_BROWSE_URL, json!({ "browseId": "FEmusic_liked_playlists" }), true).await?;
    let mut cards = Vec::new();
    collect_by_key(&data, "musicTwoRowItemRenderer", &mut cards);

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for card in cards {
        let Some(browse_id) = card.pointer("/navigationEndpoint/browseEndpoint/browseId").and_then(|v| v.as_str()) else {
            continue;
        };
        let playlist_id = browse_id.strip_prefix("VL").unwrap_or(browse_id).to_string();
        if playlist_id == "LM" || playlist_id == "SE" || playlist_id.starts_with("FEmusic") {
            continue;
        }
        let title = runs_text(card.pointer("/title/runs"));
        let lower = title.trim().to_lowercase();
        if matches!(lower.as_str(), "episodes for later" | "sounds from shorts" | "liked music") {
            continue;
        }
        if !seen.insert(playlist_id.clone()) {
            continue;
        }
        let subtitle = runs_text(card.pointer("/subtitle/runs"));
        let track_count = parse_count_from_text(&subtitle);
        let artwork_url = best_thumbnail(card.pointer("/thumbnailRenderer/musicThumbnailRenderer/thumbnail/thumbnails"));
        out.push(YtMusicPlaylistDto {
            playlist_id,
            title: if title.is_empty() { "Untitled playlist".to_string() } else { title },
            artwork_url,
            track_count,
            tracks: None,
        });
    }
    Ok(out)
}

async fn fetch_liked_songs(http: &Client) -> Result<Vec<YtMusicTrackDto>, String> {
    let mut tracks = fetch_browse_tracks(http, "VLLM", 12).await.unwrap_or_default();
    if tracks.is_empty() {
        tracks = fetch_browse_tracks(http, "FEmusic_liked_videos", 12).await.unwrap_or_default();
    }
    Ok(tracks)
}

async fn fetch_browse_tracks(http: &Client, browse_id: &str, max_pages: usize) -> Result<Vec<YtMusicTrackDto>, String> {
    let mut tracks = Vec::new();
    let mut seen = HashSet::new();
    let mut data = post_music(http, MUSIC_BROWSE_URL, json!({ "browseId": browse_id }), true).await?;

    for page_idx in 0..max_pages {
        let mut parsed = 0;
        for r in track_renderers(&data) {
            if let Some(t) = parse_responsive_track(r) {
                parsed += 1;
                if seen.insert(t.video_id.clone()) {
                    tracks.push(t);
                }
            }
        }
        // A page with no parseable tracks means the continuation pointed at a
        // non-track shelf (or repeated itself): following it further can only
        // loop, so stop like ytmusicapi does on empty contents.
        if parsed == 0 {
            break;
        }
        if page_idx + 1 >= max_pages {
            break;
        }
        let Some(token) = find_continuation_token(&data) else {
            break;
        };
        data = post_music(http, MUSIC_BROWSE_URL, json!({ "continuation": token }), true).await?;
    }
    Ok(tracks)
}

pub async fn fetch_playlist_tracks_native(http: &Client, playlist_id: &str) -> Result<YtMusicPlaylistDto, String> {
    let trimmed = playlist_id.trim();
    if trimmed.is_empty() {
        return Err("Playlist ID is required.".to_string());
    }
    let clean_id = trimmed.strip_prefix("VL").unwrap_or(trimmed).to_string();
    let browse_id = if trimmed.starts_with("VL") || trimmed.starts_with("FEmusic") {
        trimmed.to_string()
    } else {
        format!("VL{clean_id}")
    };

    let mut data = post_music(http, MUSIC_BROWSE_URL, json!({ "browseId": browse_id }), true).await?;
    let title = extract_playlist_title(&data).unwrap_or_else(|| "Playlist".to_string());
    let mut artwork_url = extract_header_artwork(&data);

    let mut tracks = Vec::new();
    let mut seen = HashSet::new();
    for page_idx in 0..20 {
        let mut parsed = 0;
        for r in track_renderers(&data) {
            if let Some(t) = parse_responsive_track(r) {
                parsed += 1;
                if seen.insert(t.video_id.clone()) {
                    tracks.push(t);
                }
            }
        }
        if parsed == 0 {
            break;
        }
        if page_idx >= 19 {
            break;
        }
        let Some(token) = find_continuation_token(&data) else {
            break;
        };
        data = post_music(http, MUSIC_BROWSE_URL, json!({ "continuation": token }), true).await?;
    }

    if artwork_url.is_none() {
        artwork_url = tracks.first().and_then(|t| t.artwork_url.clone());
    }

    Ok(YtMusicPlaylistDto {
        playlist_id: clean_id,
        title,
        artwork_url,
        track_count: tracks.len(),
        tracks: Some(tracks),
    })
}

pub async fn search_music_tracks(http: &Client, query: &str) -> Result<Vec<YtSearchTrackDto>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let payload = json!({ "query": trimmed, "params": "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D" });
    let data = post_music(http, MUSIC_SEARCH_URL, payload, false).await?;
    let mut renderers = Vec::new();
    collect_by_key(&data, "musicResponsiveListItemRenderer", &mut renderers);

    let mut tracks = Vec::new();
    let mut seen = HashSet::new();
    for r in renderers {
        if let Some(t) = parse_responsive_track(r)
            && seen.insert(t.video_id.clone()) {
                tracks.push(to_search_dto(t));
                if tracks.len() >= 15 {
                    break;
                }
            }
    }
    Ok(tracks)
}

pub async fn search_music_suggestions(http: &Client, query: &str) -> Result<YtSearchSuggestionsDto, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(YtSearchSuggestionsDto { queries: Vec::new(), tracks: Vec::new() });
    }
    let data = post_music(http, MUSIC_SUGGEST_URL, json!({ "input": trimmed }), false).await?;
    let mut suggest_nodes = Vec::new();
    collect_by_key(&data, "searchSuggestionRenderer", &mut suggest_nodes);
    let queries = suggest_nodes
        .into_iter()
        .filter_map(|n| {
            let txt = runs_text(n.pointer("/suggestion/runs"));
            (!txt.is_empty()).then_some(txt)
        })
        .take(6)
        .collect();

    let mut items = Vec::new();
    collect_by_key(&data, "musicResponsiveListItemRenderer", &mut items);
    let tracks = items.into_iter().filter_map(parse_responsive_track).take(4).map(to_search_dto).collect();
    Ok(YtSearchSuggestionsDto { queries, tracks })
}

pub async fn fetch_radio_tracks(http: &Client, video_id: &str) -> Result<Vec<YtSearchTrackDto>, String> {
    let trimmed = video_id.trim();
    if !is_valid_video_id(trimmed) {
        return Err("Invalid YouTube video ID.".to_string());
    }
    let data = post_music(
        http,
        MUSIC_NEXT_URL,
        json!({ "videoId": trimmed, "playlistId": format!("RDAMVM{trimmed}"), "isAudioOnly": true }),
        false,
    )
    .await?;
    let mut panels = Vec::new();
    collect_by_key(&data, "playlistPanelVideoRenderer", &mut panels);
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for r in panels {
        let Some(vid) = r.get("videoId").and_then(|v| v.as_str()).filter(|id| is_valid_video_id(id)) else {
            continue;
        };
        if vid == trimmed || !seen.insert(vid.to_string()) {
            continue;
        }
        let title = runs_text(r.pointer("/title/runs"));
        if title.is_empty() {
            continue;
        }
        let raw_artist = runs_text(r.pointer("/shortBylineText/runs"));
        let artist = raw_artist.trim_end_matches(" - Topic").trim();
        let dur_txt = runs_text(r.pointer("/lengthText/runs"));
        let duration_ms = parse_duration_secs(&dur_txt).map_or(0, |s| (s * 1000.0).round() as i64);
        let artwork_url = best_thumbnail(r.pointer("/thumbnail/thumbnails"))
            .unwrap_or_else(|| format!("https://i.ytimg.com/vi/{vid}/hqdefault.jpg"));
        out.push(YtSearchTrackDto {
            native_id: vid.to_string(),
            source: "youtube".to_string(),
            urn: format!("youtube:track:{vid}"),
            title,
            permalink: format!("https://music.youtube.com/watch?v={vid}"),
            artwork_url,
            duration_ms,
            artist: if artist.is_empty() { "YouTube Music".to_string() } else { artist.to_string() },
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn search_yt_tracks(
    state: tauri::State<'_, YtStreamProxy>,
    query: String,
) -> Result<Vec<YtSearchTrackDto>, String> {
    search_music_tracks(&state.browse_http, &query).await
}

#[tauri::command]
pub async fn yt_search_suggestions(
    state: tauri::State<'_, YtStreamProxy>,
    query: String,
) -> Result<YtSearchSuggestionsDto, String> {
    search_music_suggestions(&state.browse_http, &query).await
}

#[tauri::command]
pub async fn yt_radio_tracks(
    state: tauri::State<'_, YtStreamProxy>,
    video_id: String,
) -> Result<Vec<YtSearchTrackDto>, String> {
    fetch_radio_tracks(&state.browse_http, &video_id).await
}

#[tauri::command]
pub async fn fetch_yt_playlist_tracks(
    state: tauri::State<'_, YtStreamProxy>,
    playlist_id: String,
) -> Result<YtMusicPlaylistDto, String> {
    fetch_playlist_tracks_native(&state.browse_http, &playlist_id).await
}
