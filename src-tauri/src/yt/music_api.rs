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
const MUSIC_LIKE_URL: &str = "https://music.youtube.com/youtubei/v1/like";
const MUSIC_PLAYLIST_EDIT_URL: &str =
    "https://music.youtube.com/youtubei/v1/browse/edit_playlist?prettyPrint=false";
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

    if authenticated {
        let creds = tokio::task::spawn_blocking(read_ytmusic_credentials)
            .await
            .map_err(|e| format!("Could not read YouTube Music credentials: {e}"))?
            .ok_or_else(|| "Connect YouTube Music before changing your library.".to_string())?;
        let sapisid =
            extract_cookie_value(&creds.cookie, "__Secure-3PAPISID").ok_or_else(|| {
                "YouTube Music session is missing an authentication cookie. Reconnect your account."
                    .to_string()
            })?;
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
        return Err(format!(
            "YouTube Music returned HTTP {}",
            resp.status().as_u16()
        ));
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
        return Err(format!(
            "Account validation failed: HTTP {}",
            resp.status().as_u16()
        ));
    }
    let data: Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid account JSON: {e}"))?;
    let mut hdrs = Vec::new();
    collect_by_key(&data, "activeAccountHeaderRenderer", &mut hdrs);
    let hdr = hdrs
        .first()
        .copied()
        .ok_or_else(|| "YouTube Music rejected the session.".to_string())?;
    let name = runs_text(hdr.pointer("/accountName/runs"));
    let handle = runs_text(hdr.pointer("/channelHandle/runs"));
    let picture = best_thumbnail(hdr.pointer("/accountPhoto/thumbnails")).unwrap_or_default();
    if name.is_empty() && handle.is_empty() {
        return Err("YouTube Music did not return an account.".to_string());
    }
    Ok(YtMusicProfile {
        name,
        handle,
        picture,
    })
}

fn require_mutation_success(data: &Value, operation: &str) -> Result<(), String> {
    if let Some(status) = data.get("status").and_then(Value::as_str) {
        if status.contains("SUCCEEDED") {
            return Ok(());
        }
        return Err(format!(
            "YouTube Music did not confirm {operation} (status: {status})."
        ));
    }
    let results = data
        .get("playlistEditResults")
        .and_then(Value::as_array)
        .filter(|results| !results.is_empty());
    if let Some(results) = results
        && results.iter().all(|result| {
            result.get("error").is_none()
                && result.get("status").is_none_or(|s| {
                    s.as_str()
                        .is_some_and(|status| status.contains("SUCCEEDED"))
                })
        })
    {
        return Ok(());
    }
    Err(format!(
        "YouTube Music returned no confirmation for {operation}."
    ))
}

fn require_like_success(data: &Value, action: &str) -> Result<(), String> {
    if data.get("error").is_some() {
        return Err(format!("YouTube Music rejected the {action} request."));
    }
    match data.get("status").and_then(Value::as_str) {
        Some(status) if status.contains("SUCCEEDED") => Ok(()),
        Some(status) => Err(format!(
            "YouTube Music did not confirm the {action} request (status: {status})."
        )),
        None if data.get("responseContext").is_some() => Ok(()),
        None => Err(format!(
            "YouTube Music returned no confirmation for the {action} request."
        )),
    }
}

pub async fn set_song_liked(http: &Client, video_id: &str, liked: bool) -> Result<(), String> {
    let video_id = video_id.trim();
    if !is_valid_video_id(video_id) {
        return Err("Invalid YouTube video ID.".to_string());
    }
    let action = if liked { "like" } else { "removelike" };
    let url = format!("{MUSIC_LIKE_URL}/{action}?prettyPrint=false");
    let data = post_music(
        http,
        &url,
        json!({ "target": { "videoId": video_id } }),
        true,
    )
    .await?;
    require_like_success(&data, action)
}

pub async fn edit_playlist_track(
    http: &Client,
    playlist_id: &str,
    video_id: &str,
    set_video_id: Option<&str>,
    add: bool,
) -> Result<(), String> {
    let playlist_id = playlist_id
        .trim()
        .strip_prefix("VL")
        .unwrap_or(playlist_id.trim());
    let video_id = video_id.trim();
    if playlist_id.is_empty()
        || playlist_id.len() > 128
        || !playlist_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
    {
        return Err("Invalid YouTube Music playlist ID.".to_string());
    }
    if !is_valid_video_id(video_id) {
        return Err("Invalid YouTube video ID.".to_string());
    }
    let action = if add {
        // Avoid duplicate additions when the picker is opened from a stale snapshot.
        let current = fetch_playlist_tracks_native(http, playlist_id).await?;
        if current
            .tracks
            .unwrap_or_default()
            .iter()
            .any(|track| track.video_id == video_id)
        {
            return Err(
                "This track is already in the YouTube Music playlist. The playlist was refreshed."
                    .to_string(),
            );
        }
        json!({ "action": "ACTION_ADD_VIDEO", "addedVideoId": video_id })
    } else {
        let set_video_id = set_video_id.map(str::trim).filter(|id| !id.is_empty())
            .ok_or_else(|| "This playlist item is missing its YouTube Music entry ID; refresh the playlist and try again.".to_string())?;
        let current = fetch_playlist_tracks_native(http, playlist_id).await?;
        if !current.tracks.unwrap_or_default().iter().any(|track| {
            track.video_id == video_id && track.set_video_id.as_deref() == Some(set_video_id)
        }) {
            return Err(
                "This YouTube Music playlist item changed. Refresh the playlist and try again."
                    .to_string(),
            );
        }
        json!({ "action": "ACTION_REMOVE_VIDEO", "setVideoId": set_video_id, "removedVideoId": video_id })
    };
    let data = post_music(
        http,
        MUSIC_PLAYLIST_EDIT_URL,
        json!({ "playlistId": playlist_id, "actions": [action] }),
        true,
    )
    .await?;
    require_mutation_success(
        &data,
        if add {
            "adding the track to the playlist"
        } else {
            "removing the track from the playlist"
        },
    )
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
        return Err(
            "Сессия YouTube Music истекла. Переподключите аккаунт в настройках.".to_string(),
        );
    }

    Ok(YtMusicLibraryDto {
        profile,
        playlists,
        liked_songs,
    })
}

async fn fetch_user_playlists(http: &Client) -> Result<Vec<YtMusicPlaylistDto>, String> {
    let data = post_music(
        http,
        MUSIC_BROWSE_URL,
        json!({ "browseId": "FEmusic_liked_playlists" }),
        true,
    )
    .await?;
    let mut cards = Vec::new();
    collect_by_key(&data, "musicTwoRowItemRenderer", &mut cards);

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for card in cards {
        let Some(browse_id) = card
            .pointer("/navigationEndpoint/browseEndpoint/browseId")
            .and_then(|v| v.as_str())
        else {
            continue;
        };
        let playlist_id = browse_id
            .strip_prefix("VL")
            .unwrap_or(browse_id)
            .to_string();
        if playlist_id == "LM" || playlist_id == "SE" || playlist_id.starts_with("FEmusic") {
            continue;
        }
        let title = runs_text(card.pointer("/title/runs"));
        let lower = title.trim().to_lowercase();
        if matches!(
            lower.as_str(),
            "episodes for later" | "sounds from shorts" | "liked music"
        ) {
            continue;
        }
        if !seen.insert(playlist_id.clone()) {
            continue;
        }
        let subtitle = runs_text(card.pointer("/subtitle/runs"));
        let track_count = parse_count_from_text(&subtitle);
        let artwork_url = best_thumbnail(
            card.pointer("/thumbnailRenderer/musicThumbnailRenderer/thumbnail/thumbnails"),
        );
        out.push(YtMusicPlaylistDto {
            playlist_id,
            title: if title.is_empty() {
                "Untitled playlist".to_string()
            } else {
                title
            },
            artwork_url,
            track_count,
            tracks: None,
        });
    }
    Ok(out)
}

async fn fetch_liked_songs(http: &Client) -> Result<Vec<YtMusicTrackDto>, String> {
    let mut tracks = fetch_browse_tracks(http, "VLLM").await.unwrap_or_default();
    if tracks.is_empty() {
        tracks = fetch_browse_tracks(http, "FEmusic_liked_videos")
            .await
            .unwrap_or_default();
    }
    Ok(tracks)
}

async fn fetch_browse_tracks(
    http: &Client,
    browse_id: &str,
) -> Result<Vec<YtMusicTrackDto>, String> {
    let mut tracks = Vec::new();
    let mut seen = HashSet::new();
    let mut seen_tokens = HashSet::new();
    let mut data = post_music(
        http,
        MUSIC_BROWSE_URL,
        json!({ "browseId": browse_id }),
        true,
    )
    .await?;

    loop {
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
        let Some(token) = find_continuation_token(&data) else {
            break;
        };
        // A repeated token means the server is stuck on the same page, so
        // paging further would loop forever.
        if !seen_tokens.insert(token.clone()) {
            break;
        }
        data = post_music(
            http,
            MUSIC_BROWSE_URL,
            json!({ "continuation": token }),
            true,
        )
        .await?;
    }
    Ok(tracks)
}

pub async fn fetch_playlist_tracks_native(
    http: &Client,
    playlist_id: &str,
) -> Result<YtMusicPlaylistDto, String> {
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

    let mut data = post_music(
        http,
        MUSIC_BROWSE_URL,
        json!({ "browseId": browse_id }),
        true,
    )
    .await?;
    let title = extract_playlist_title(&data).unwrap_or_else(|| "Playlist".to_string());
    let mut artwork_url = extract_header_artwork(&data);

    let mut tracks = Vec::new();
    let mut seen_tokens = HashSet::new();
    loop {
        let mut parsed = 0;
        for r in track_renderers(&data) {
            if let Some(t) = parse_responsive_track(r) {
                // Preserve duplicate videos: every occurrence has its own setVideoId and
                // must remain individually removable from the provider playlist.
                parsed += 1;
                tracks.push(t);
            }
        }
        if parsed == 0 {
            break;
        }
        let Some(token) = find_continuation_token(&data) else {
            break;
        };
        // A repeated token means the server is stuck on the same page, so
        // paging further would loop forever.
        if !seen_tokens.insert(token.clone()) {
            break;
        }
        data = post_music(
            http,
            MUSIC_BROWSE_URL,
            json!({ "continuation": token }),
            true,
        )
        .await?;
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

pub async fn search_music_tracks(
    http: &Client,
    query: &str,
) -> Result<Vec<YtSearchTrackDto>, String> {
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
            && seen.insert(t.video_id.clone())
        {
            tracks.push(to_search_dto(t));
            if tracks.len() >= 15 {
                break;
            }
        }
    }
    Ok(tracks)
}

pub async fn search_music_suggestions(
    http: &Client,
    query: &str,
) -> Result<YtSearchSuggestionsDto, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(YtSearchSuggestionsDto {
            queries: Vec::new(),
            tracks: Vec::new(),
        });
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
    let tracks = items
        .into_iter()
        .filter_map(parse_responsive_track)
        .take(4)
        .map(to_search_dto)
        .collect();
    Ok(YtSearchSuggestionsDto { queries, tracks })
}

pub async fn fetch_radio_tracks(
    http: &Client,
    video_id: &str,
) -> Result<Vec<YtSearchTrackDto>, String> {
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
        let Some(vid) = r
            .get("videoId")
            .and_then(|v| v.as_str())
            .filter(|id| is_valid_video_id(id))
        else {
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
            artist: if artist.is_empty() {
                "YouTube Music".to_string()
            } else {
                artist.to_string()
            },
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

#[cfg(test)]
mod mutation_tests {
    use super::{require_like_success, require_mutation_success};
    use serde_json::json;

    #[test]
    fn like_response_must_be_confirmed() {
        assert!(require_like_success(&json!({ "status": "STATUS_SUCCEEDED" }), "like").is_ok());
        assert!(require_like_success(&json!({ "responseContext": {} }), "like").is_ok());
        assert!(require_like_success(&json!({ "status": "STATUS_FAILED" }), "like").is_err());
        assert!(require_like_success(&json!({}), "like").is_err());
        assert!(require_like_success(&json!({ "error": {} }), "like").is_err());
    }

    #[test]
    fn playlist_response_must_be_confirmed() {
        assert!(
            require_mutation_success(&json!({ "status": "STATUS_SUCCEEDED" }), "adding").is_ok()
        );
        assert!(require_mutation_success(&json!({ "playlistEditResults": [{ "playlistEditVideoAddedResultData": { "videoId": "id" } }] }), "adding").is_ok());
        assert!(require_mutation_success(&json!({ "status": "STATUS_FAILED" }), "adding").is_err());
        assert!(require_mutation_success(&json!({ "playlistEditResults": [] }), "adding").is_err());
        assert!(require_mutation_success(&json!({}), "adding").is_err());
    }
}
