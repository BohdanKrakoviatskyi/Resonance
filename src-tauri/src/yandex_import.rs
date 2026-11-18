//! Yandex Music playlist and album import via the public (unauthenticated) API.
//!
//! Supported links on music.yandex.{ru,com,by,kz,uz}:
//!   /users/<owner>/playlists/<kind>   classic user playlists
//!   /playlists/<uuid>                 new-style shared playlists (lk.<uuid> or bare uuid)
//!   /album/<id>                       albums

use reqwest::Client;
use serde_json::Value;
use url::Url;

use crate::playlist_import::{ExternalPlaylistDto, ExternalPlaylistTrackDto};

const API: &str = "https://api.music.yandex.net";

pub fn is_yandex_music_host(host: &str) -> bool {
    matches!(
        host,
        "music.yandex.ru" | "music.yandex.com" | "music.yandex.by" | "music.yandex.kz" | "music.yandex.uz"
    )
}

#[derive(Debug, PartialEq, Eq)]
pub enum YandexTarget {
    UserPlaylist { owner: String, kind: String },
    SharedPlaylist { uuid: String },
    Album { id: String },
}

pub fn parse_target(url: &Url) -> Option<YandexTarget> {
    let seg: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    match seg.as_slice() {
        ["users", owner, "playlists", kind, ..] if digits(kind) && !owner.is_empty() => Some(YandexTarget::UserPlaylist {
            owner: (*owner).to_string(),
            kind: (*kind).to_string(),
        }),
        ["playlists", uuid, ..] if uuid.len() >= 8 && uuid.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.') => {
            Some(YandexTarget::SharedPlaylist { uuid: (*uuid).to_string() })
        }
        ["album", id, ..] if digits(id) => Some(YandexTarget::Album { id: (*id).to_string() }),
        _ => None,
    }
}

fn cover(uri: Option<&str>) -> Option<String> {
    let u = uri?.trim();
    if u.is_empty() {
        return None;
    }
    let sized = u.replace("%%", "400x400");
    Some(if sized.starts_with("http") { sized } else { format!("https://{sized}") })
}

/// One Yandex track object → our DTO. Returns None for unavailable/empty entries.
pub fn map_track(t: &Value) -> Option<ExternalPlaylistTrackDto> {
    let base = t.get("title")?.as_str()?.trim();
    if base.is_empty() {
        return None;
    }
    let title = match t.get("version").and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => format!("{base} ({v})"),
        None => base.to_string(),
    };
    let artist = t
        .get("artists")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.get("name")?.as_str()).map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", "))
        .unwrap_or_default();
    let album = t.pointer("/albums/0/title").and_then(Value::as_str).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    Some(ExternalPlaylistTrackDto {
        title,
        artist,
        album,
        duration_ms: t.get("durationMs").and_then(Value::as_i64).unwrap_or(0),
        artwork_url: cover(t.get("coverUri").and_then(Value::as_str)),
        native_id: None,
    })
}

async fn get_json(http: &Client, url: &str) -> Result<Value, String> {
    let resp = http
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .header("Accept-Language", "ru")
        .send()
        .await
        .map_err(|e| format!("Yandex Music request failed: {e}"))?;
    match resp.status().as_u16() {
        200 => {}
        451 => return Err("Yandex Music is not available in your region (HTTP 451).".into()),
        404 => return Err("Yandex Music playlist not found or not public.".into()),
        s => return Err(format!("Yandex Music returned HTTP {s}")),
    }
    let bytes = crate::playlist_import::read_limited(resp, 16 << 20).await?;
    serde_json::from_slice(&bytes).map_err(|e| format!("Invalid Yandex Music JSON: {e}"))
}

/// Big playlists list only track ids; hydrate them via POST /tracks in chunks.
async fn hydrate(http: &Client, ids: &[String]) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for chunk in ids.chunks(100) {
        let resp = http
            .post(format!("{API}/tracks"))
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
            .form(&[("track-ids", chunk.join(","))])
            .send()
            .await
            .map_err(|e| format!("Yandex Music request failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Yandex Music returned HTTP {}", resp.status().as_u16()));
        }
        let bytes = crate::playlist_import::read_limited(resp, 16 << 20).await?;
        let v: Value = serde_json::from_slice(&bytes).map_err(|e| format!("Invalid Yandex Music JSON: {e}"))?;
        if let Some(arr) = v.get("result").and_then(Value::as_array) {
            out.extend(arr.iter().cloned());
        }
    }
    Ok(out)
}

/// Splits playlist items into full track objects and ids that still need hydration.
pub fn split_playlist_items(items: &[Value]) -> (Vec<Value>, Vec<String>) {
    let mut full = Vec::new();
    let mut missing = Vec::new();
    for it in items {
        if let Some(t) = it.get("track").filter(|t| t.get("title").is_some()) {
            full.push(t.clone());
        } else if let Some(id) = it.get("id").and_then(|v| v.as_str().map(str::to_string).or_else(|| v.as_i64().map(|n| n.to_string()))) {
            let album = it.get("albumId").and_then(|v| v.as_i64().map(|n| n.to_string()).or_else(|| v.as_str().map(str::to_string)));
            missing.push(match album {
                Some(a) => format!("{id}:{a}"),
                None => id,
            });
        }
    }
    (full, missing)
}

pub async fn fetch_yandex_music(http: &Client, url: &Url) -> Result<ExternalPlaylistDto, String> {
    let target = parse_target(url).ok_or("Use a Yandex Music playlist or album link.")?;
    let (title, artwork, raw_tracks) = match &target {
        YandexTarget::Album { id } => {
            let v = get_json(http, &format!("{API}/albums/{id}/with-tracks")).await?;
            let r = v.get("result").ok_or("Empty Yandex Music response.")?;
            let tracks: Vec<Value> = r
                .get("volumes")
                .and_then(Value::as_array)
                .map(|vols| vols.iter().filter_map(Value::as_array).flatten().cloned().collect())
                .unwrap_or_default();
            (r.get("title").and_then(Value::as_str).unwrap_or("Yandex Music").to_string(), cover(r.get("coverUri").and_then(Value::as_str)), tracks)
        }
        YandexTarget::UserPlaylist { .. } | YandexTarget::SharedPlaylist { .. } => {
            let endpoint = match &target {
                YandexTarget::UserPlaylist { owner, kind } => format!("{API}/users/{owner}/playlists/{kind}"),
                YandexTarget::SharedPlaylist { uuid } => format!("{API}/playlist/{uuid}"),
                YandexTarget::Album { .. } => unreachable!(),
            };
            let v = get_json(http, &endpoint).await?;
            let r = v.get("result").ok_or("Empty Yandex Music response.")?;
            let items = r.get("tracks").and_then(Value::as_array).cloned().unwrap_or_default();
            let (mut full, missing) = split_playlist_items(&items);
            if !missing.is_empty() {
                full.extend(hydrate(http, &missing).await?);
            }
            let art = cover(r.pointer("/cover/uri").and_then(Value::as_str)).or_else(|| cover(r.get("ogImage").and_then(Value::as_str)));
            (r.get("title").and_then(Value::as_str).unwrap_or("Yandex Music").to_string(), art, full)
        }
    };
    let tracks: Vec<_> = raw_tracks.iter().filter_map(map_track).collect();
    if tracks.is_empty() {
        return Err("The Yandex Music playlist is empty or private.".into());
    }
    Ok(ExternalPlaylistDto { source: "yandex".into(), title: title.trim().to_string(), artwork_url: artwork, tracks })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn parses_link_shapes() {
        assert_eq!(
            parse_target(&u("https://music.yandex.ru/users/someone/playlists/1003")),
            Some(YandexTarget::UserPlaylist { owner: "someone".into(), kind: "1003".into() })
        );
        assert_eq!(
            parse_target(&u("https://music.yandex.ru/playlists/lk.4f0e3c1a-7d1e-4b9a-9a1e-2f0e1c2d3e4f?utm=x")),
            Some(YandexTarget::SharedPlaylist { uuid: "lk.4f0e3c1a-7d1e-4b9a-9a1e-2f0e1c2d3e4f".into() })
        );
        assert_eq!(parse_target(&u("https://music.yandex.com/album/4766/track/57703")), Some(YandexTarget::Album { id: "4766".into() }));
        assert_eq!(parse_target(&u("https://music.yandex.ru/artist/1")), None);
        assert_eq!(parse_target(&u("https://music.yandex.ru/users/x/playlists/abc")), None);
    }

    #[test]
    fn maps_track_objects() {
        let t = json!({
            "title": "Song", "version": "Remix", "durationMs": 201000,
            "artists": [{"name": "A"}, {"name": "B"}],
            "albums": [{"title": "Album"}],
            "coverUri": "avatars.yandex.net/get-music-content/1/x/%%"
        });
        let d = map_track(&t).unwrap();
        assert_eq!(d.title, "Song (Remix)");
        assert_eq!(d.artist, "A, B");
        assert_eq!(d.album.as_deref(), Some("Album"));
        assert_eq!(d.duration_ms, 201000);
        assert_eq!(d.artwork_url.as_deref(), Some("https://avatars.yandex.net/get-music-content/1/x/400x400"));
        assert!(map_track(&json!({"title": " "})).is_none());
    }

    #[test]
    fn splits_full_and_id_only_items() {
        let items = vec![json!({"id": 1, "track": {"title": "x"}}), json!({"id": 2, "albumId": 9}), json!({"id": "3"})];
        let (full, missing) = split_playlist_items(&items);
        assert_eq!(full.len(), 1);
        assert_eq!(missing, vec!["2:9".to_string(), "3".to_string()]);
    }
}
