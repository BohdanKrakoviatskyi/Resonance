use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::clients::is_valid_video_id;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtMusicTrackDto {
    pub video_id: String,
    pub title: String,
    pub artist: String,
    pub artists: Vec<String>,
    pub artwork_url: Option<String>,
    pub duration_seconds: Option<f64>,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtMusicPlaylistDto {
    pub playlist_id: String,
    pub title: String,
    pub artwork_url: Option<String>,
    pub track_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracks: Option<Vec<YtMusicTrackDto>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtSearchTrackDto {
    pub native_id: String,
    pub source: String,
    pub urn: String,
    pub title: String,
    pub permalink: String,
    pub artwork_url: String,
    pub duration_ms: i64,
    pub artist: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtSearchSuggestionsDto {
    pub queries: Vec<String>,
    pub tracks: Vec<YtSearchTrackDto>,
}

pub fn collect_by_key<'a>(node: &'a Value, key: &str, out: &mut Vec<&'a Value>) {
    match node {
        Value::Object(map) => {
            if let Some(v) = map.get(key) {
                out.push(v);
            }
            for v in map.values() {
                collect_by_key(v, key, out);
            }
        }
        Value::Array(arr) => {
            for v in arr {
                collect_by_key(v, key, out);
            }
        }
        _ => {}
    }
}

/// Contents of the playlist's own `musicPlaylistShelfRenderer` shelf.
///
/// A browse response for a playlist also contains other shelves (e.g. the
/// section-list continuations used for suggestions/related). Those have their
/// own `nextContinuationData` tokens and must never be used to page through
/// the playlist's tracks — ytmusicapi pages playlists exclusively through
/// the last item of this shelf (`get_continuations_2025`).
pub fn playlist_shelf_contents<'a>(data: &'a Value) -> Option<&'a Vec<Value>> {
    if let Some(contents) = data
        .pointer("/contents/twoColumnBrowseResultsRenderer/secondaryContents/sectionListRenderer/contents/0/musicPlaylistShelfRenderer/contents")
        .and_then(|v| v.as_array())
    {
        return Some(contents);
    }
    let mut shelves = Vec::new();
    collect_by_key(data, "musicPlaylistShelfRenderer", &mut shelves);
    shelves
        .first()
        .and_then(|shelf| shelf.get("contents"))
        .and_then(|v| v.as_array())
}

/// Items appended by a continuation request:
/// `onResponseReceivedActions[0].appendContinuationItemsAction.continuationItems`
pub fn continuation_items<'a>(data: &'a Value) -> Option<&'a Vec<Value>> {
    data.pointer("/onResponseReceivedActions/0/appendContinuationItemsAction/continuationItems")
        .and_then(|v| v.as_array())
}

/// Continuation token for a shelf/item list. Only the LAST element can carry
/// it (`continuationItemRenderer`), exactly like ytmusicapi's
/// `get_continuation_token`: a direct `continuationCommand.token`, or a
/// `commandExecutorCommand` entry whose request is BROWSE (other commands,
/// e.g. playlist voting refresh, share the same list and must be skipped).
pub fn continuation_token_from_items(items: &[Value]) -> Option<String> {
    let last = items.last()?;
    let endpoint = last.pointer("/continuationItemRenderer/continuationEndpoint")?;
    if let Some(token) = endpoint
        .pointer("/continuationCommand/token")
        .and_then(|v| v.as_str())
        .filter(|token| !token.is_empty())
    {
        return Some(token.to_string());
    }
    let commands = endpoint
        .pointer("/commandExecutorCommand/commands")
        .and_then(|v| v.as_array())?;
    for command in commands {
        let Some(cmd) = command.get("continuationCommand") else {
            continue;
        };
        if cmd.get("request").and_then(|v| v.as_str()) != Some("CONTINUATION_REQUEST_TYPE_BROWSE") {
            continue;
        }
        if let Some(token) = cmd.get("token").and_then(|v| v.as_str()).filter(|t| !t.is_empty()) {
            return Some(token.to_string());
        }
    }
    None
}

/// Track renderers belonging to the playlist shelf (or to a continuation
/// page). Falls back to a whole-document search for non-playlist browse
/// responses (search, library grids) that have no playlist shelf.
pub fn track_renderers<'a>(data: &'a Value) -> Vec<&'a Value> {
    let scoped = playlist_shelf_contents(data)
        .or_else(|| continuation_items(data))
        .map(|items| track_renderers_from_items(items));
    if let Some(renderers) = scoped {
        return renderers;
    }
    let mut items = Vec::new();
    collect_by_key(data, "musicResponsiveListItemRenderer", &mut items);
    items
}

pub fn track_renderers_from_items<'a>(items: &'a [Value]) -> Vec<&'a Value> {
    items
        .iter()
        .filter_map(|item| item.get("musicResponsiveListItemRenderer"))
        .collect()
}

pub fn find_continuation_token(data: &Value) -> Option<String> {
    // Playlist tracks page exclusively through the playlist shelf /
    // continuation items. A `nextContinuationData` found elsewhere in the
    // document belongs to a different shelf (suggestions/related) and
    // paging with it returns non-track items, truncating the playlist at
    // the first page.
    let shelf_contents = playlist_shelf_contents(data);
    if let Some(contents) = shelf_contents {
        return continuation_token_from_items(contents);
    }
    if let Some(items) = continuation_items(data) {
        return continuation_token_from_items(items);
    }
    let mut renderers = Vec::new();
    collect_by_key(data, "continuationItemRenderer", &mut renderers);
    for renderer in renderers.iter().rev() {
        let endpoint = renderer.get("continuationEndpoint");
        if let Some(token) = endpoint
            .and_then(|e| e.pointer("/continuationCommand/token"))
            .and_then(|v| v.as_str())
            .filter(|token| !token.is_empty())
        {
            return Some(token.to_string());
        }
    }
    let mut conts = Vec::new();
    collect_by_key(data, "nextContinuationData", &mut conts);
    conts
        .first()
        .and_then(|c| c.get("continuation"))
        .and_then(|v| v.as_str())
        .map(ToOwned::to_owned)
}

pub fn extract_playlist_title(data: &Value) -> Option<String> {
    for key in [
        "musicResponsiveHeaderRenderer",
        "musicEditablePlaylistDetailHeaderRenderer",
        "musicDetailHeaderRenderer",
    ] {
        let mut found = Vec::new();
        collect_by_key(data, key, &mut found);
        if let Some(hdr) = found.first() {
            let t = runs_text(hdr.pointer("/title/runs"));
            if !t.is_empty() {
                return Some(t);
            }
        }
    }
    None
}

pub fn extract_header_artwork(data: &Value) -> Option<String> {
    for key in [
        "musicResponsiveHeaderRenderer",
        "musicEditablePlaylistDetailHeaderRenderer",
        "musicDetailHeaderRenderer",
    ] {
        let mut found = Vec::new();
        collect_by_key(data, key, &mut found);
        if let Some(hdr) = found.first() {
            if let Some(u) = best_thumbnail(hdr.pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails")) {
                return Some(u);
            }
        }
    }
    None
}

pub fn parse_responsive_track(r: &Value) -> Option<YtMusicTrackDto> {
    let video_id = r
        .pointer("/playlistItemData/videoId")
        .or_else(|| r.pointer("/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint/videoId"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|id| is_valid_video_id(id))?
        .to_string();

    let flex = r.get("flexColumns").and_then(|v| v.as_array())?;
    let title = runs_text(flex.first()?.pointer("/musicResponsiveListItemFlexColumnRenderer/text/runs"));
    if title.is_empty() {
        return None;
    }

    let mut artists = Vec::new();
    let mut duration_seconds: Option<f64> = None;
    if let Some(runs) = flex
        .get(1)
        .and_then(|c| c.pointer("/musicResponsiveListItemFlexColumnRenderer/text/runs"))
        .and_then(|v| v.as_array())
    {
        for run in runs {
            let txt = run.get("text").and_then(|v| v.as_str()).map(str::trim).unwrap_or("");
            if txt.is_empty() || matches!(txt, "•" | "&" | "," | "-" | "Song" | "Video" | "Трек") {
                continue;
            }
            if let Some(d) = parse_duration_secs(txt) {
                duration_seconds = Some(d);
                continue;
            }
            let page_type = run
                .pointer("/navigationEndpoint/browseEndpoint/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if page_type.contains("ARTIST") || artists.is_empty() {
                if !artists.iter().any(|a| a == txt) {
                    artists.push(txt.to_string());
                }
            }
        }
    }
    if duration_seconds.is_none() {
        if let Some(fixed) = r.get("fixedColumns").and_then(|v| v.as_array()) {
            for col in fixed {
                let txt = runs_text(col.pointer("/musicResponsiveListItemFixedColumnRenderer/text/runs"));
                if let Some(d) = parse_duration_secs(&txt) {
                    duration_seconds = Some(d);
                    break;
                }
            }
        }
    }

    let artwork_url = best_thumbnail(r.pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails"))
        .or_else(|| Some(format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg")));
    let artist = if artists.is_empty() {
        "YouTube Music".to_string()
    } else {
        artists.join(", ")
    };

    Some(YtMusicTrackDto {
        video_id,
        title,
        artist,
        artists,
        artwork_url,
        duration_seconds,
        available: true,
    })
}

pub fn to_search_dto(t: YtMusicTrackDto) -> YtSearchTrackDto {
    let dur_ms = t.duration_seconds.map_or(0, |s| (s * 1000.0).round() as i64);
    let artwork_url = t
        .artwork_url
        .unwrap_or_else(|| format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", t.video_id));
    YtSearchTrackDto {
        native_id: t.video_id.clone(),
        source: "youtube".to_string(),
        urn: format!("youtube:track:{}", t.video_id),
        title: t.title,
        permalink: format!("https://music.youtube.com/watch?v={}", t.video_id),
        artwork_url,
        duration_ms: dur_ms,
        artist: if t.artist.is_empty() { "YouTube Music".to_string() } else { t.artist },
    }
}

pub fn runs_text(val: Option<&Value>) -> String {
    let Some(arr) = val.and_then(|v| v.as_array()) else {
        return String::new();
    };
    arr.iter()
        .filter_map(|r| r.get("text").and_then(|t| t.as_str()))
        .collect::<String>()
        .trim()
        .to_string()
}

pub fn best_thumbnail(val: Option<&Value>) -> Option<String> {
    let arr = val.and_then(|v| v.as_array())?;
    arr.iter()
        .filter_map(|item| {
            let url = item.get("url").and_then(|v| v.as_str())?.trim();
            if !url.starts_with("http") {
                return None;
            }
            let w = item.get("width").and_then(|v| v.as_i64()).unwrap_or(0);
            let h = item.get("height").and_then(|v| v.as_i64()).unwrap_or(0);
            Some((w * h, url.to_string()))
        })
        .max_by_key(|(area, _)| *area)
        .map(|(_, url)| url)
}

pub fn parse_duration_secs(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if !trimmed.contains(':') {
        return None;
    }
    let mut total = 0u64;
    for part in trimmed.split(':') {
        total = total * 60 + part.parse::<u64>().ok()?;
    }
    Some(total as f64)
}

pub fn parse_count_from_text(text: &str) -> usize {
    let digits: String = text.chars().filter(|c| c.is_ascii_digit()).collect();
    digits.parse().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn track(video_id: &str) -> Value {
        json!({
            "musicResponsiveListItemRenderer": {
                "playlistItemData": { "videoId": video_id },
                "flexColumns": [
                    { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [{ "text": "Song" }] } } }
                ]
            }
        })
    }

    fn continuation(token: &str) -> Value {
        json!({
            "continuationItemRenderer": {
                "continuationEndpoint": { "continuationCommand": { "token": token } }
            }
        })
    }

    fn browse_response(shelf_contents: Vec<Value>) -> Value {
        json!({
            "contents": {
                "twoColumnBrowseResultsRenderer": {
                    "secondaryContents": {
                        "sectionListRenderer": {
                            "contents": [{ "musicPlaylistShelfRenderer": { "contents": shelf_contents } }],
                            // Suggestions/related shelf continuation. Paging a
                            // playlist with this token returns non-track items
                            // and truncates the playlist at the first page.
                            "continuations": [{ "nextContinuationData": { "continuation": "SECTION_TOKEN" } }]
                        }
                    }
                }
            }
        })
    }

    #[test]
    fn playlist_pages_through_shelf_token_not_section_token() {
        let data = browse_response(vec![track("AAAAAAAAAAA"), continuation("PLAYLIST_TOKEN")]);
        assert_eq!(find_continuation_token(&data).as_deref(), Some("PLAYLIST_TOKEN"));
        assert_eq!(track_renderers(&data).len(), 1);
    }

    #[test]
    fn continuation_page_uses_appended_items_token() {
        let data = json!({
            "onResponseReceivedActions": [{
                "appendContinuationItemsAction": {
                    "continuationItems": [track("BBBBBBBBBBB"), continuation("NEXT_TOKEN")]
                }
            }]
        });
        assert_eq!(find_continuation_token(&data).as_deref(), Some("NEXT_TOKEN"));
        assert_eq!(track_renderers(&data).len(), 1);
    }

    #[test]
    fn executor_token_requires_browse_request() {
        let data = browse_response(vec![
            track("AAAAAAAAAAA"),
            json!({
                "continuationItemRenderer": {
                    "continuationEndpoint": {
                        "commandExecutorCommand": {
                            "commands": [
                                { "playlistVotingRefreshPopupCommand": {} },
                                { "continuationCommand": { "request": "CONTINUATION_REQUEST_TYPE_BROWSE", "token": "EXEC_TOKEN" } }
                            ]
                        }
                    }
                }
            })
        ]);
        assert_eq!(find_continuation_token(&data).as_deref(), Some("EXEC_TOKEN"));
    }

    #[test]
    fn no_token_when_shelf_has_no_continuation_item() {
        let data = browse_response(vec![track("AAAAAAAAAAA"), track("CCCCCCCCCCC")]);
        assert_eq!(find_continuation_token(&data), None);
        assert_eq!(track_renderers(&data).len(), 2);
    }
}
