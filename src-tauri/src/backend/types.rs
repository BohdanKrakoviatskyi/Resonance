//! Wire types shared with the renderer. Field names and `omitempty` behaviour match the JSON the
//! Go sidecar produced, so the TypeScript side keeps working unchanged. Several of these are also
//! the on-disk format (`settings.json`, `auth.json`, `history.json`), so existing user data loads.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::util::{is_empty_str, is_zero, normalize_artwork, track_urn_or_default, username_of, vi, vs, vo, varr};

pub const APP_NAME: &str = "Resonance";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub accent: String,
    pub volume: i64,
    pub client_id: String,
    pub background_image: String,
    pub background_blur: i64,
}

impl Default for Settings {
    fn default() -> Self {
        Self { accent: "#ff765d".into(), volume: 70, client_id: String::new(), background_image: String::new(), background_blur: 0 }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    pub accent: Option<String>,
    pub volume: Option<i64>,
    pub client_id: Option<String>,
    pub background_image: Option<String>,
    pub background_blur: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Profile {
    pub id: i64,
    pub username: String,
    #[serde(skip_serializing_if = "is_empty_str")]
    pub full_name: String,
    #[serde(skip_serializing_if = "is_empty_str")]
    pub permalink_url: String,
    #[serde(skip_serializing_if = "is_empty_str")]
    pub avatar_url: String,
    #[serde(skip_serializing_if = "is_empty_str")]
    pub city: String,
    #[serde(skip_serializing_if = "is_empty_str")]
    pub country: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub followers_count: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub track_count: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub likes_count: i64,
}

impl Profile {
    /// Builds the stored profile from a `/me` response.
    pub fn from_me(v: &Value) -> Self {
        let mut avatar = vs(v, "avatar_url");
        if avatar.contains("-large.") {
            avatar = avatar.replacen("-large.", "-t500x500.", 1);
        }
        Self {
            id: vi(v, "id"),
            username: vs(v, "username"),
            full_name: vs(v, "full_name"),
            permalink_url: vs(v, "permalink_url"),
            avatar_url: avatar,
            city: vs(v, "city"),
            country: vs(v, "country"),
            followers_count: vi(v, "followers_count"),
            track_count: vi(v, "track_count"),
            likes_count: vi(v, "likes_count"),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AuthState {
    pub token: String,
    pub profile: Profile,
    pub saved_at: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct AuthStatus {
    pub authorized: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<Profile>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct UserName {
    #[serde(default)]
    pub username: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TrackCard {
    pub id: i64,
    pub track_urn: String,
    pub title: String,
    #[serde(skip_serializing_if = "is_empty_str")]
    pub permalink_url: String,
    #[serde(skip_serializing_if = "is_empty_str")]
    pub artwork_url: String,
    pub duration: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub playback_count: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub likes_count: i64,
    pub user: UserName,
    #[serde(skip_serializing_if = "is_empty_str")]
    pub publisher_artist: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistCard {
    pub id: String,
    pub urn: String,
    pub title: String,
    pub permalink_url: String,
    pub artwork_url: String,
    pub track_count: i64,
    pub user: UserName,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchUser {
    pub username: String,
    pub avatar_url: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTrack {
    pub id: i64,
    pub urn: String,
    pub title: String,
    pub permalink_url: String,
    pub artwork_url: String,
    pub duration: i64,
    pub user: SearchUser,
    #[serde(skip_serializing_if = "is_empty_str")]
    pub publisher_artist: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackStreamOption {
    pub url: String,
    pub preview: bool,
    pub hls: bool,
    pub quality: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackStreamResult {
    pub url: String,
    pub preview: bool,
    pub hls: bool,
    pub quality: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub alternatives: Vec<TrackStreamOption>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPlaylist {
    pub title: String,
    #[serde(skip_serializing_if = "is_empty_str")]
    pub artwork_url: String,
    pub tracks: Vec<TrackCard>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLikes {
    pub username: String,
    #[serde(skip_serializing_if = "is_empty_str")]
    pub avatar_url: String,
    #[serde(skip_serializing_if = "is_empty_str")]
    pub artwork_url: String,
    pub tracks: Vec<TrackCard>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheClearResult {
    pub audio_files_deleted: i64,
    pub audio_bytes_freed: i64,
    pub lyrics_entries_cleared: i64,
    pub stream_entries_cleared: i64,
}

// ---- parsed SoundCloud source objects (not sent to the renderer) -----------------------------

/// One track object as SoundCloud returns it (`snake_case` keys).
#[derive(Debug, Clone, Default)]
pub struct ScTrack {
    pub id: i64,
    pub urn: String,
    pub title: String,
    pub permalink_url: String,
    pub artwork_url: String,
    pub duration: i64,
    pub playback_count: i64,
    pub likes_count: i64,
    pub username: String,
    /// Real performer from SoundCloud's publisher metadata; the uploader is often a re-upload account.
    pub publisher_artist: String,
}

/// `publisher_metadata.artist`, falling back to the legacy `metadata_artist` field.
pub fn publisher_artist_of(v: &Value) -> String {
    let p = v.pointer("/publisher_metadata/artist").and_then(Value::as_str).unwrap_or_default().trim();
    if !p.is_empty() {
        return p.to_string();
    }
    vs(v, "metadata_artist").trim().to_string()
}

impl ScTrack {
    pub fn parse(v: &Value) -> Self {
        Self {
            publisher_artist: publisher_artist_of(v),
            id: vi(v, "id"),
            urn: vs(v, "urn"),
            title: vs(v, "title"),
            permalink_url: vs(v, "permalink_url"),
            artwork_url: vs(v, "artwork_url"),
            duration: vi(v, "duration"),
            playback_count: vi(v, "playback_count"),
            likes_count: vi(v, "likes_count"),
            username: username_of(v),
        }
    }

    /// Track card with an explicit, already-normalised artwork URL.
    pub fn card_with_artwork(&self, artwork: String) -> TrackCard {
        TrackCard {
            id: self.id,
            track_urn: track_urn_or_default(&self.urn, self.id),
            title: self.title.clone(),
            permalink_url: self.permalink_url.clone(),
            artwork_url: artwork,
            duration: self.duration,
            playback_count: self.playback_count,
            likes_count: self.likes_count,
            user: UserName { username: self.username.clone() },
            publisher_artist: self.publisher_artist.clone(),
        }
    }

    /// Card using the full `normalizeArtworkURL` rules (`-large.` and `/large/`).
    pub fn card(&self) -> TrackCard {
        self.card_with_artwork(normalize_artwork(&self.artwork_url))
    }
}

/// Playlist object as SoundCloud returns it.
#[derive(Debug, Clone, Default)]
pub struct ScPlaylist {
    pub id: i64,
    pub urn: String,
    pub title: String,
    pub permalink_url: String,
    pub artwork_url: String,
    pub track_count: i64,
    pub tracks: Vec<ScTrack>,
    pub username: String,
}

impl ScPlaylist {
    pub fn parse(v: &Value) -> Self {
        Self {
            id: vi(v, "id"),
            urn: vs(v, "urn"),
            title: vs(v, "title"),
            permalink_url: vs(v, "permalink_url"),
            artwork_url: vs(v, "artwork_url"),
            track_count: vi(v, "track_count"),
            tracks: varr(v, "tracks").map(|items| items.iter().map(ScTrack::parse).collect()).unwrap_or_default(),
            username: username_of(v),
        }
    }


    /// `(id, urn)` as shown to the renderer: the numeric id wins when present.
    pub fn card_ids(&self) -> (String, String) {
        let urn = if self.urn.is_empty() && self.id > 0 { format!("soundcloud:playlists:{}", self.id) } else { self.urn.clone() };
        let id = if self.id > 0 { self.id.to_string() } else { urn.clone() };
        (id, urn)
    }
}

/// `tracks` of a playlist/collection payload: `tracks` first, `collection` as the fallback —
/// only when the key is absent (an empty `tracks` array is still "present" in Go terms).
pub fn playlist_or_collection_tracks(v: &Value) -> Vec<ScTrack> {
    let list = match vo(v, "tracks").and_then(Value::as_array) {
        Some(items) => Some(items),
        None => varr(v, "collection"),
    };
    list.map(|items| items.iter().map(ScTrack::parse).collect()).unwrap_or_default()
}
