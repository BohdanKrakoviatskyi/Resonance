//! Lyrics from YouTube Music itself (licensed from LyricFind / Musixmatch).
//!
//! 1. `next` for the video exposes a lyrics tab whose browseId starts with `MPLY`.
//! 2. `browse` with the Android Music client returns timed lyrics (`timedLyricsData`) when they
//!    exist; the web client returns the plain text (`musicDescriptionShelfRenderer`).

use reqwest::Client;
use serde::Serialize;
use serde_json::{Value, json};

use super::clients::{is_valid_video_id, registry_snapshot};
use super::music_parse::{collect_by_key, runs_text};
use super::music_api::post_music;
use super::proxy::YtStreamProxy;

const NEXT_URL: &str = "https://music.youtube.com/youtubei/v1/next?prettyPrint=false";
const BROWSE_URL: &str = "https://music.youtube.com/youtubei/v1/browse?prettyPrint=false";

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct YtmLyricLine {
    pub start_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct YtmLyrics {
    pub synced: Vec<YtmLyricLine>,
    pub plain: Vec<String>,
    /// "Source: LyricFind" etc.
    pub source: String,
}

/// Finds the lyrics tab's browseId in a `next` response.
pub fn lyrics_browse_id(next: &Value) -> Option<String> {
    let mut ids = Vec::new();
    collect_by_key(next, "browseId", &mut ids);
    ids.into_iter().filter_map(Value::as_str).find(|id| id.starts_with("MPLY")).map(str::to_string)
}

/// Timed lines from an Android Music `browse` response.
pub fn parse_timed(v: &Value) -> Vec<YtmLyricLine> {
    let mut arrays = Vec::new();
    collect_by_key(v, "timedLyricsData", &mut arrays);
    let mut out: Vec<YtmLyricLine> = arrays
        .into_iter()
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(|l| {
            let text = l.get("lyricLine")?.as_str()?.trim().to_string();
            let start = l.pointer("/cueRange/startTimeMilliseconds").and_then(|x| x.as_str().and_then(|s| s.parse().ok()).or_else(|| x.as_i64()))?;
            Some(YtmLyricLine { start_ms: start, text })
        })
        .collect();
    out.sort_by_key(|l| l.start_ms);
    // Instrumental breaks come back as "♪"; keep them as empty lines so gaps render.
    for l in &mut out {
        if l.text == "♪" {
            l.text.clear();
        }
    }
    out
}

/// Plain lyrics + source line from a web `browse` response.
pub fn parse_plain(v: &Value) -> (Vec<String>, String) {
    let mut shelves = Vec::new();
    collect_by_key(v, "musicDescriptionShelfRenderer", &mut shelves);
    let Some(shelf) = shelves.into_iter().next() else { return (Vec::new(), String::new()) };
    let text = runs_text(shelf.pointer("/description/runs"));
    let source = runs_text(shelf.pointer("/footer/runs"));
    (text.lines().map(|s| s.trim().to_string()).collect(), source)
}

async fn post_android(http: &Client, body: Value) -> Result<Value, String> {
    let reg = registry_snapshot();
    let c = &reg.lyrics_timed;
    let mut body = body;
    body["context"] = c.context_value(None);
    let resp = http
        .post(BROWSE_URL)
        .header("Content-Type", "application/json")
        .header("User-Agent", &c.user_agent)
        .header("X-Youtube-Client-Name", &c.client_id)
        .header("X-Youtube-Client-Version", &c.client_version)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("YouTube Music request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("YouTube Music returned HTTP {}", resp.status().as_u16()));
    }
    resp.json().await.map_err(|e| format!("Invalid YouTube Music JSON: {e}"))
}

pub async fn fetch_lyrics(http: &Client, video_id: &str) -> Result<YtmLyrics, String> {
    let id = video_id.trim();
    if !is_valid_video_id(id) {
        return Err("Invalid YouTube video ID.".into());
    }
    let next = post_music(http, NEXT_URL, json!({ "videoId": id, "isAudioOnly": true }), false).await?;
    let Some(browse_id) = lyrics_browse_id(&next) else { return Ok(YtmLyrics::default()) };

    if let Ok(timed) = post_android(http, json!({ "browseId": browse_id })).await {
        let synced = parse_timed(&timed);
        if synced.iter().filter(|l| !l.text.is_empty()).count() >= 3 {
            let (_, source) = parse_plain(&timed);
            return Ok(YtmLyrics { synced, plain: Vec::new(), source });
        }
    }
    let web = post_music(http, BROWSE_URL, json!({ "browseId": browse_id }), false).await?;
    let (plain, source) = parse_plain(&web);
    Ok(YtmLyrics { synced: Vec::new(), plain, source })
}

#[tauri::command]
pub async fn ytm_lyrics(state: tauri::State<'_, YtStreamProxy>, video_id: String) -> Result<YtmLyrics, String> {
    fetch_lyrics(&state.browse_http, &video_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_lyrics_tab() {
        let next = json!({"tabs": [{"endpoint": {"browseEndpoint": {"browseId": "MPREb_x"}}}, {"endpoint": {"browseEndpoint": {"browseId": "MPLYt_abc"}}}]});
        assert_eq!(lyrics_browse_id(&next).as_deref(), Some("MPLYt_abc"));
        assert_eq!(lyrics_browse_id(&json!({})), None);
    }

    #[test]
    fn parses_timed_and_plain() {
        let v = json!({"x": {"timedLyricsData": [
            {"lyricLine": "Second", "cueRange": {"startTimeMilliseconds": "5000"}},
            {"lyricLine": "First", "cueRange": {"startTimeMilliseconds": "1000"}},
            {"lyricLine": "♪", "cueRange": {"startTimeMilliseconds": "9000"}}
        ]}});
        let t = parse_timed(&v);
        assert_eq!(t.iter().map(|l| (l.start_ms, l.text.as_str())).collect::<Vec<_>>(), vec![(1000, "First"), (5000, "Second"), (9000, "")]);

        let w = json!({"musicDescriptionShelfRenderer": {"description": {"runs": [{"text": "a\nb"}]}, "footer": {"runs": [{"text": "Source: LyricFind"}]}}});
        assert_eq!(parse_plain(&w), (vec!["a".to_string(), "b".to_string()], "Source: LyricFind".to_string()));
    }

    /// Network: `cargo test --lib lyrics_ytm -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_ytm_lyrics() {
        let http = Client::new();
        let res = tauri::async_runtime::block_on(async {
            let q = std::env::var("LYRICS_Q").unwrap_or_else(|_| "Daft Punk One More Time".into());
            let found = super::super::music_api::search_music_tracks(&http, &q).await.unwrap();
            let id = found.first().expect("search result").native_id.clone();
            println!("video {id}");
            fetch_lyrics(&http, &id).await.unwrap()
        });
        println!("synced {} plain {} source {:?}", res.synced.len(), res.plain.len(), res.source);
        if let Some(l) = res.synced.get(3) {
            println!("sample {l:?}");
        }
        assert!(!res.synced.is_empty() || !res.plain.is_empty());
    }
}
