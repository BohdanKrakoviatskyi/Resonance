//! Native backend: SoundCloud API access, account/settings/history persistence and lyrics lookup.
//!
//! This replaces the Go sidecar (`api/`). The renderer used to spawn that binary and speak
//! line-delimited JSON-RPC over its stdio; it now calls the single `backend_rpc` command with the
//! same method names and payloads, so no caller changes shape. Everything runs inside the app
//! process: nothing to bundle per target, no child process to crash or respawn, and the token
//! never leaves the Rust side.

mod lyrics;
mod public;
mod soundcloud;
mod store;
mod stream;
mod types;
mod util;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tauri::State as TauriState;
use tokio::sync::RwLock;

use lyrics::CachedLyrics;
use soundcloud::{OFFICIAL_API_BASE, Sc};
use store::{MAX_RECENT_TRACKS, Paths, State, remove_file_if_exists, to_pretty_json, valid_accent, valid_background_image, valid_client_id, write_secret_file};
use types::*;
use util::*;

/// The version the renderer shows; kept in step with `Cargo.toml`.
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

struct Inner {
    http: reqwest::Client,
    state: RwLock<State>,
    paths: Paths,
    /// `BSC_SOUNDCLOUD_API_BASE`, default the official host.
    api_base: String,
    /// Client id scraped from soundcloud.com when the user has not configured one.
    public_client_id: Mutex<String>,
    /// Lyrics live behind their own lock: the state lock is held across disk writes, and a cache
    /// that outlives an HTTP lookup must not queue unrelated work behind them.
    lyrics_cache: Mutex<HashMap<i64, CachedLyrics>>,
}

/// Managed Tauri state. Cheap to clone; all clones share one backend.
#[derive(Clone)]
pub struct Backend {
    inner: Arc<Inner>,
}

impl Default for Backend {
    fn default() -> Self {
        Self::new()
    }
}

impl Backend {
    pub fn new() -> Self {
        let dir = store::app_data_dir().unwrap_or_else(|e| {
            log::error!("local backend: no app data directory ({e}); using the working directory");
            PathBuf::from(".")
        });
        if let Err(e) = std::fs::create_dir_all(&dir) {
            log::error!("create app data directory: {e}");
        }
        // Retired provider credentials must not outlive the provider.
        if let Err(e) = remove_file_if_exists(&dir.join("spotify.json")) {
            log::warn!("could not remove retired provider credentials: {e}");
        }
        let paths = Paths::in_dir(&dir);
        let state = State::load(&paths);
        let api_base = std::env::var("BSC_SOUNDCLOUD_API_BASE").ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).unwrap_or_else(|| OFFICIAL_API_BASE.to_string());
        let http = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().expect("http client");
        Self { inner: Arc::new(Inner { http, state: RwLock::new(state), paths, api_base, public_client_id: Mutex::new(String::new()), lyrics_cache: Mutex::new(HashMap::new()) }) }
    }

    /// Snapshot of what a request needs, taken under a short read lock so a slow network call
    /// never holds the state lock while writers (settings/auth/history) wait behind it.
    async fn sc(&self) -> Sc {
        let state = self.inner.state.read().await;
        Sc {
            http: self.inner.http.clone(),
            api_base: self.inner.api_base.clone(),
            token: state.auth.token.clone(),
            client_id: state.settings.client_id.clone(),
            user_id: state.auth.profile.id,
        }
    }

    /// Resolves a SoundCloud URN (`soundcloud:tracks:123` or `123`) directly for the local mobile audio proxy.
    pub async fn resolve_soundcloud_stream(&self, track_urn: &str) -> Result<TrackStreamResult, String> {
        self.sc().await.track_stream(track_urn).await.map_err(s)
    }

    /// HTTP client shared with the local HLS manifest normalizer.
    pub fn http_client(&self) -> &reqwest::Client {
        &self.inner.http
    }

    // ---- dispatcher ---------------------------------------------------------------------------

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let started = std::time::Instant::now();
        log::debug!("rpc stage=received method={method:?}");
        let result = self.dispatch(method, params).await;
        match &result {
            Ok(_) => log::debug!("rpc stage=complete method={method:?} elapsed_ms={}", started.elapsed().as_millis()),
            Err(e) => log::warn!("rpc stage=handler_error method={method:?} elapsed_ms={} error={e:?}", started.elapsed().as_millis()),
        }
        result
    }

    async fn dispatch(&self, method: &str, params: Value) -> Result<Value, String> {
        let params = if params.is_null() { Value::Object(Default::default()) } else { params };
        match method {
            "app.info" => to_value(AppInfo { name: APP_NAME, version: APP_VERSION, backend: "rust-native" }),

            "settings.get" => to_value(self.inner.state.read().await.settings.clone()),
            "settings.update" => to_value(self.settings_update(parse(method, params)?).await?),
            "settings.clear" => to_value(self.settings_clear().await?),

            "history.list" => to_value(self.inner.state.read().await.history.clone()),
            "history.record" => {
                let p: HistoryTrackParams = parse(method, params)?;
                to_value(self.history_record(p.track).await?)
            }
            "history.clear" => to_value(self.history_clear().await?),

            "frontend.backup" => {
                let p: FrontendBackupParams = parse(method, params)?;
                to_value(self.frontend_backup(p.entries).await)
            }
            "frontend.restore" => to_value(self.inner.state.read().await.frontend_backup.clone()),

            "auth.status" => to_value(auth_status(&*self.inner.state.read().await)),
            "auth.login" => {
                let p: LoginParams = parse(method, params)?;
                to_value(self.auth_login(&p.token).await?)
            }
            "auth.refresh" => to_value(self.auth_refresh().await?),
            "auth.logout" => to_value(self.auth_logout().await?),

            "tracks.mine" => to_value(self.tracks_mine().await?),
            "playlists.mine" => to_value(self.sc().await.playlists_mine().await.map_err(s)?),
            "playlist.tracks" => {
                let p: PlaylistTracksParams = parse(method, params)?;
                to_value(self.sc().await.playlist_tracks(&p.playlist_urn).await.map_err(s)?)
            }
            "track.details" => {
                let p: TrackIdParams = parse(method, params)?;
                to_value(self.sc().await.track_details(p.track_id).await.map_err(s)?)
            }
            "search.tracks" => {
                let p: SearchParams = parse(method, params)?;
                to_value(self.sc().await.search_tracks(&p.query).await.map_err(s)?)
            }
            "track.related" => {
                let p: TrackIdParams = parse(method, params)?;
                to_value(self.sc().await.track_related(p.track_id).await.map_err(s)?)
            }
            "track.stream" => {
                let p: TrackStreamParams = parse(method, params)?;
                to_value(self.sc().await.track_stream(&p.track_urn).await.map_err(s)?)
            }
            "track.like" | "track.unlike" => {
                let p: TrackLikeParams = parse(method, params)?;
                let liked = method == "track.like";
                to_value(self.sc().await.set_track_liked(p.track_id, &p.track_urn, liked, &p.datadome_cookie).await.map_err(s)?)
            }
            "track.lyrics" => to_value(self.track_lyrics(parse(method, params)?).await.map_err(s)?),

            "user.profile" => {
                let p: UserParams = parse(method, params)?;
                to_value(self.sc().await.user_profile(p.user_id).await.map_err(s)?)
            }
            "user.tracks" => {
                let p: UserParams = parse(method, params)?;
                to_value(self.sc().await.user_tracks(p.user_id).await.map_err(s)?)
            }
            "user.playlists" => {
                let p: UserParams = parse(method, params)?;
                to_value(self.sc().await.user_playlists(p.user_id).await.map_err(s)?)
            }
            "user.likes" => {
                let p: UserPageParams = parse(method, params)?;
                to_value(self.sc().await.user_likes(p.user_id, &p.next).await.map_err(s)?)
            }
            "user.followers" | "user.followings" => {
                let p: UserPageParams = parse(method, params)?;
                let relation = if method == "user.followers" { "followers" } else { "followings" };
                to_value(self.sc().await.user_social(p.user_id, &p.next, relation).await.map_err(s)?)
            }
            "mixed.selections" => to_value(self.sc().await.mixed_selections().await.map_err(s)?),

            "resolve.playlist" => {
                let p: ResolvePlaylistParams = parse(method, params)?;
                to_value(self.resolve_playlist(&p.url).await.map_err(s)?)
            }
            "user.likes.by.input" => {
                let p: LikesByInputParams = parse(method, params)?;
                to_value(self.user_likes_by_input(&p.input).await.map_err(s)?)
            }

            "cache.clear" => to_value(CacheClearResult { lyrics_entries_cleared: self.clear_lyrics_cache() as i64, ..Default::default() }),

            _ => Err("unknown method".to_string()),
        }
    }

    // ---- settings -----------------------------------------------------------------------------

    async fn settings_update(&self, patch: SettingsPatch) -> Result<Settings, String> {
        let mut state = self.inner.state.write().await;
        let mut updated = state.settings.clone();
        if let Some(accent) = patch.accent {
            if !valid_accent(&accent) {
                return Err("акцент должен быть шестизначным цветом в формате hex".into());
            }
            updated.accent = accent.to_lowercase();
        }
        if let Some(volume) = patch.volume {
            if !(0..=100).contains(&volume) {
                return Err("громкость должна быть от 0 до 100".into());
            }
            updated.volume = volume;
        }
        if let Some(client_id) = patch.client_id {
            let client_id = client_id.trim().to_string();
            if !valid_client_id(&client_id) {
                return Err("client_id должен содержать от 8 до 128 латинских букв, цифр, дефисов или подчёркиваний".into());
            }
            updated.client_id = client_id;
        }
        if let Some(image) = patch.background_image {
            if !valid_background_image(&image) {
                return Err("фон должен быть изображением JPEG в формате data URL размером до 700 КБ".into());
            }
            updated.background_image = image;
        }
        if let Some(blur) = patch.background_blur {
            if !(0..=24).contains(&blur) {
                return Err("размытие фона должно быть от 0 до 24".into());
            }
            updated.background_blur = blur;
        }
        let data = to_pretty_json(&updated)?;
        write_secret_file(&self.inner.paths.settings, data).await.map_err(|e| format!("save settings: {e}"))?;
        state.settings = updated.clone();
        Ok(updated)
    }

    /// Clears locally persisted account credentials and preferences.
    async fn settings_clear(&self) -> Result<Settings, String> {
        let mut state = self.inner.state.write().await;
        let paths = &self.inner.paths;
        remove_file_if_exists(&paths.auth).map_err(|e| format!("clear auth: {e}"))?;
        remove_file_if_exists(&paths.settings).map_err(|e| format!("clear settings: {e}"))?;
        remove_file_if_exists(&paths.history).map_err(|e| format!("clear history: {e}"))?;
        remove_file_if_exists(&paths.frontend_backup).map_err(|e| format!("clear frontend backup: {e}"))?;
        state.auth = AuthState::default();
        state.settings = Settings::default();
        state.history = Vec::new();
        state.frontend_backup = HashMap::new();
        Ok(state.settings.clone())
    }

    // ---- history ------------------------------------------------------------------------------

    async fn history_record(&self, mut track: TrackCard) -> Result<Vec<TrackCard>, String> {
        let mut state = self.inner.state.write().await;
        if track.id <= 0 || track.title.trim().is_empty() {
            return Err("для записи истории нужны корректные ID и название трека".into());
        }
        if track.track_urn.is_empty() {
            track.track_urn = format!("soundcloud:tracks:{}", track.id);
        }
        let mut updated = Vec::with_capacity(MAX_RECENT_TRACKS);
        let id = track.id;
        updated.push(track);
        for existing in &state.history {
            if existing.id == id {
                continue;
            }
            updated.push(existing.clone());
            if updated.len() == MAX_RECENT_TRACKS {
                break;
            }
        }
        write_secret_file(&self.inner.paths.history, to_pretty_json(&updated)?).await.map_err(|e| format!("save playback history: {e}"))?;
        state.history = updated.clone();
        Ok(updated)
    }

    async fn history_clear(&self) -> Result<Vec<TrackCard>, String> {
        let mut state = self.inner.state.write().await;
        remove_file_if_exists(&self.inner.paths.history).map_err(|e| format!("clear playback history: {e}"))?;
        state.history = Vec::new();
        Ok(Vec::new())
    }

    async fn frontend_backup(&self, entries: HashMap<String, String>) -> HashMap<String, String> {
        let mut state = self.inner.state.write().await;
        for (key, value) in entries {
            if !key.is_empty() {
                state.frontend_backup.insert(key, value);
            }
        }
        // Best effort, like the original: the in-memory copy is still returned if the write fails.
        if let Ok(data) = serde_json::to_vec(&state.frontend_backup) {
            let _ = write_secret_file(&self.inner.paths.frontend_backup, data).await;
        }
        state.frontend_backup.clone()
    }

    // ---- auth ---------------------------------------------------------------------------------

    async fn auth_login(&self, token: &str) -> Result<AuthStatus, String> {
        let token = token.trim().to_string();
        if token.is_empty() {
            return Err("вставьте access token SoundCloud".into());
        }
        // Network first, lock only for the save: a slow SoundCloud response must not block other writes.
        let user = self.sc().await.fetch_profile(&token).await.map_err(s)?;
        let saved_at = chrono_like_rfc3339();
        let auth = AuthState { token, profile: user, saved_at };
        let mut state = self.inner.state.write().await;
        write_secret_file(&self.inner.paths.auth, to_pretty_json(&auth)?).await.map_err(|e| format!("save auth: {e}"))?;
        state.auth = auth;
        Ok(auth_status(&state))
    }

    async fn auth_refresh(&self) -> Result<AuthStatus, String> {
        let token = self.inner.state.read().await.auth.token.clone();
        if token.is_empty() {
            return Ok(AuthStatus::default());
        }
        let fetched = self.sc().await.fetch_profile(&token).await;
        let mut state = self.inner.state.write().await;
        if state.auth.token != token {
            // The session changed while we were fetching (e.g. a fresh login): report the current
            // state instead of overwriting it with stale data.
            return Ok(auth_status(&state));
        }
        self.refresh_auth_locked(&mut state, fetched).await
    }

    /// Applies a profile fetch result. The caller holds the write lock and has confirmed the stored
    /// token is the one that was fetched.
    async fn refresh_auth_locked(&self, state: &mut State, fetched: BResult<Profile>) -> Result<AuthStatus, String> {
        match fetched {
            Err(e) if e.is_rejected() => {
                remove_file_if_exists(&self.inner.paths.auth).map_err(|e| format!("clear auth: {e}"))?;
                state.auth = AuthState::default();
                Ok(AuthStatus::default())
            }
            // Offline: keep the session and answer with the cached profile.
            Err(_) => Ok(auth_status(state)),
            Ok(user) => {
                state.auth.profile = user;
                write_secret_file(&self.inner.paths.auth, to_pretty_json(&state.auth)?).await.map_err(|e| format!("save auth: {e}"))?;
                Ok(auth_status(state))
            }
        }
    }

    async fn auth_logout(&self) -> Result<AuthStatus, String> {
        let mut state = self.inner.state.write().await;
        remove_file_if_exists(&self.inner.paths.auth).map_err(|e| format!("clear auth: {e}"))?;
        state.auth = AuthState::default();
        Ok(AuthStatus::default())
    }

    /// The account's liked tracks. If both hosts reject the token the session is stale: revalidate
    /// the profile once, retry on success, and otherwise ask the user to sign in again.
    async fn tracks_mine(&self) -> Result<Vec<TrackCard>, String> {
        let sc = self.sc().await;
        if sc.token.is_empty() {
            return Err(NOT_CONNECTED.into());
        }
        let (token, user_id) = (sc.token.clone(), sc.user_id);
        let err = match sc.fetch_my_tracks(&token, user_id).await {
            Ok(tracks) => return Ok(tracks),
            Err(e) if e.is_rejected() => e,
            Err(e) => return Err(e.to_string()),
        };
        log::warn!("tracks.mine stage=token_rejected error={err}");
        // Only revalidate if the rejected token is still the stored one (a concurrent login may have
        // replaced it). The profile is fetched before taking the lock so the network never holds it.
        if self.inner.state.read().await.auth.token == token {
            let fetched = sc.fetch_profile(&token).await;
            let retry = {
                let mut state = self.inner.state.write().await;
                if state.auth.token == token {
                    let revalidated = self.refresh_auth_locked(&mut state, fetched).await;
                    match revalidated {
                        Ok(status) if status.authorized => Some((state.auth.token.clone(), state.auth.profile.id)),
                        _ => {
                            state.auth = AuthState::default();
                            let _ = remove_file_if_exists(&self.inner.paths.auth);
                            None
                        }
                    }
                } else {
                    None
                }
            };
            if let Some((token, user_id)) = retry {
                return self.sc().await.fetch_my_tracks(&token, user_id).await.map_err(s);
            }
        }
        Err("сессия SoundCloud устарела — войдите снова".into())
    }
}

fn auth_status(state: &State) -> AuthStatus {
    if state.auth.token.is_empty() {
        AuthStatus::default()
    } else {
        AuthStatus { authorized: true, profile: Some(state.auth.profile.clone()) }
    }
}

fn s(e: BErr) -> String {
    e.to_string()
}

fn parse<T: DeserializeOwned>(method: &str, params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|e| format!("invalid {method} payload: {e}"))
}

/// RFC 3339 UTC timestamp (`2026-11-17T17:26:21Z`) without pulling in a date library.
fn chrono_like_rfc3339() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

// ---- request params ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct HistoryTrackParams {
    track: TrackCard,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct FrontendBackupParams {
    entries: HashMap<String, String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct LoginParams {
    token: String,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct PlaylistTracksParams {
    playlist_urn: String,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct TrackIdParams {
    track_id: i64,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct SearchParams {
    query: String,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct TrackStreamParams {
    track_urn: String,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct TrackLikeParams {
    track_id: i64,
    track_urn: String,
    #[serde(rename = "datadomeCookie")]
    datadome_cookie: String,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct UserParams {
    user_id: i64,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct UserPageParams {
    user_id: i64,
    next: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ResolvePlaylistParams {
    url: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct LikesByInputParams {
    input: String,
}

/// Single entry point for the renderer's backend calls (`rpc(method, params)` in `sidecar.ts`).
#[tauri::command]
pub async fn backend_rpc(backend: TauriState<'_, Backend>, method: String, params: Option<Value>) -> Result<Value, String> {
    backend.call(&method, params.unwrap_or(Value::Null)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The renderer calls these by name; a typo or a dropped arm would only surface at runtime as
    /// "unknown method". This mirrors the table the Go sidecar pinned in `TestRPCMethodNames`.
    const METHODS: [&str; 33] = [
        "app.info", "auth.login", "auth.logout", "auth.refresh", "auth.status", "cache.clear", "frontend.backup", "frontend.restore", "history.clear", "history.list",
        "history.record", "mixed.selections", "playlist.tracks", "playlists.mine", "resolve.playlist", "search.tracks", "settings.clear", "settings.get", "settings.update",
        "track.details", "track.like", "track.lyrics", "track.related", "track.stream", "track.unlike", "tracks.mine", "user.followers", "user.followings", "user.likes",
        "user.likes.by.input", "user.playlists", "user.profile", "user.tracks",
    ];

    fn temp_backend() -> Backend {
        let dir = std::env::temp_dir().join(format!("resonance-backend-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = Paths::in_dir(&dir);
        let state = State::load(&paths);
        Backend {
            inner: Arc::new(Inner {
                http: reqwest::Client::new(),
                state: RwLock::new(state),
                paths,
                api_base: OFFICIAL_API_BASE.into(),
                public_client_id: Mutex::new(String::new()),
                lyrics_cache: Mutex::new(HashMap::new()),
            }),
        }
    }

    #[tokio::test]
    async fn every_published_method_is_dispatched() {
        let backend = temp_backend();
        for method in METHODS {
            // Calls that would reach the network fail on the missing account before any request is made;
            // the point is only that the name is routed and never answers "unknown method".
            let result = backend.call(method, serde_json::json!({})).await;
            assert_ne!(result.as_ref().err().map(String::as_str), Some("unknown method"), "{method} is not routed");
        }
        assert_eq!(backend.call("no.such.method", Value::Null).await.unwrap_err(), "unknown method");
    }

    #[tokio::test]
    async fn settings_round_trip_and_validation() {
        let backend = temp_backend();
        let updated = backend.call("settings.update", serde_json::json!({"accent": "#ABCDEF", "volume": 40, "clientId": " abcdef123456 "})).await.unwrap();
        assert_eq!(updated["accent"], "#abcdef");
        assert_eq!(updated["volume"], 40);
        assert_eq!(updated["clientId"], "abcdef123456");
        assert!(backend.call("settings.update", serde_json::json!({"volume": 101})).await.is_err());
        assert!(backend.call("settings.update", serde_json::json!({"accent": "red"})).await.is_err());
        // Settings survive a restart.
        let reloaded = State::load(&backend.inner.paths);
        assert_eq!(reloaded.settings.volume, 40);
        let cleared = backend.call("settings.clear", Value::Null).await.unwrap();
        assert_eq!(cleared["volume"], 70);
    }

    #[tokio::test]
    async fn history_is_deduplicated_newest_first_and_capped() {
        let backend = temp_backend();
        for id in 1..=25 {
            backend.call("history.record", serde_json::json!({"track": {"id": id, "title": format!("T{id}")}})).await.unwrap();
        }
        let again = backend.call("history.record", serde_json::json!({"track": {"id": 20, "title": "T20"}})).await.unwrap();
        let ids: Vec<i64> = again.as_array().unwrap().iter().map(|t| t["id"].as_i64().unwrap()).collect();
        assert_eq!(ids.len(), MAX_RECENT_TRACKS);
        assert_eq!(ids[0], 20);
        assert_eq!(ids.iter().filter(|id| **id == 20).count(), 1);
        assert_eq!(again[0]["trackUrn"], "soundcloud:tracks:20");
        assert!(backend.call("history.record", serde_json::json!({"track": {"id": 0, "title": "x"}})).await.is_err());
        assert_eq!(backend.call("history.clear", Value::Null).await.unwrap(), serde_json::json!([]));
    }

    #[tokio::test]
    async fn frontend_backup_merges_and_persists() {
        let backend = temp_backend();
        backend.call("frontend.backup", serde_json::json!({"entries": {"a": "1", "": "ignored"}})).await.unwrap();
        let merged = backend.call("frontend.backup", serde_json::json!({"entries": {"b": "2"}})).await.unwrap();
        assert_eq!(merged, serde_json::json!({"a": "1", "b": "2"}));
        assert_eq!(backend.call("frontend.restore", Value::Null).await.unwrap(), merged);
        assert_eq!(State::load(&backend.inner.paths).frontend_backup.len(), 2);
    }

    #[tokio::test]
    async fn account_calls_require_a_connected_account() {
        let backend = temp_backend();
        assert_eq!(backend.call("auth.status", Value::Null).await.unwrap(), serde_json::json!({"authorized": false}));
        for method in ["tracks.mine", "playlists.mine", "mixed.selections"] {
            assert_eq!(backend.call(method, Value::Null).await.unwrap_err(), NOT_CONNECTED, "{method}");
        }
        assert_eq!(backend.call("search.tracks", serde_json::json!({"query": "  "})).await.unwrap(), serde_json::json!([]));
        assert!(backend.call("auth.login", serde_json::json!({"token": "  "})).await.is_err());
    }

    #[test]
    fn rfc3339_timestamps_are_well_formed() {
        let stamp = chrono_like_rfc3339();
        assert_eq!(stamp.len(), 20);
        assert!(stamp.ends_with('Z') && stamp.as_bytes()[10] == b'T');
    }

    #[test]
    fn cache_clear_result_keeps_the_four_renderer_fields() {
        let value = serde_json::to_value(CacheClearResult { lyrics_entries_cleared: 3, ..Default::default() }).unwrap();
        assert_eq!(value, serde_json::json!({"audioFilesDeleted": 0, "audioBytesFreed": 0, "lyricsEntriesCleared": 3, "streamEntriesCleared": 0}));
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// Network smoke test: `cargo test --lib live_lyrics -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_lyrics() {
        let dir = std::env::temp_dir().join("resonance-live-lyrics");
        let _ = std::fs::create_dir_all(&dir);
        let paths = Paths::in_dir(&dir);
        let backend = Backend {
            inner: Arc::new(Inner {
                http: reqwest::Client::builder().timeout(Duration::from_secs(15)).build().unwrap(),
                state: RwLock::new(State::load(&paths)),
                paths,
                api_base: OFFICIAL_API_BASE.into(),
                public_client_id: Mutex::new(String::new()),
                lyrics_cache: Mutex::new(HashMap::new()),
            }),
        };
        let params: Value = std::env::var("LIVE_PARAMS").ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_else(|| serde_json::json!({"trackId": 1, "title": "Blinding Lights", "artist": "The Weeknd", "durationMs": 200000}));
        let out = backend.call("track.lyrics", params).await.unwrap();
        println!("{}", serde_json::to_string(&out).unwrap());
    }
}
