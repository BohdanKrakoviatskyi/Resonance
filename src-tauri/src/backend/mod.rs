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
mod transcode;
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
use store::{Paths, State, remove_file_if_exists, to_pretty_json, valid_accent, valid_background_image, valid_client_id, write_secret_file, write_state_file};
use types::*;
use util::*;

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
    analysis_generation: Arc<std::sync::atomic::AtomicU64>,
    /// Gate and outcome of the last silent session re-pull: concurrent failures share one attempt.
    session_recovery: tokio::sync::Mutex<Option<RepullAttempt>>,
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
        Self { inner: Arc::new(Inner { http, state: RwLock::new(state), paths, api_base, public_client_id: Mutex::new(String::new()), lyrics_cache: Mutex::new(HashMap::new()), analysis_generation: Arc::new(std::sync::atomic::AtomicU64::new(0)), session_recovery: tokio::sync::Mutex::new(None) }) }
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

    async fn soundcloud_analysis_pcm(&self, track_urn: &str) -> Result<Vec<f32>, String> {
        let generation = self.inner.analysis_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let sc = self.sc().await;
        let stream = sc.track_analysis_stream(track_urn).await.map_err(|e| e.to_string())?;
        let is_hls = stream.hls;
        let url = url::Url::parse(&stream.url).map_err(|_| "SoundCloud returned an invalid audio stream".to_string())?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(90))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                let url = attempt.url();
                if url.scheme() == "https"
                    && url.host_str().is_some_and(stream::is_soundcloud_media_host)
                {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .map_err(|e| format!("could not initialize audio download: {e}"))?;
        let current = self.inner.analysis_generation.clone();
        transcode::analysis_audio_to_pcm(http, url, is_hls, current, generation).await
    }

    fn cancel_soundcloud_analysis(&self) {
        self.inner.analysis_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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
            "settings.update" => to_value(self.settings_update(parse(method, params)?).await?),

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
                if p.analysis {
                    self.cancel_soundcloud_analysis();
                }
                let stream = self
                    .soundcloud_call(|sc| {
                        let track_urn = p.track_urn.clone();
                        async move {
                            if p.analysis { sc.track_analysis_stream(&track_urn).await } else { sc.track_stream(&track_urn).await }
                        }
                    })
                    .await;
                to_value(stream.map_err(s)?)
            }
            "track.lyrics" => to_value(self.track_lyrics(parse(method, params)?).await.map_err(s)?),

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

    // ---- frontend state -----------------------------------------------------------------------

    /// Merges the keys and serialises the map under a short write lock, then writes the file outside
    /// it. Only the keys that were just stored come back, because echoing the whole map means
    /// shipping the entire app state over IPC on every save (the renderer ignores the answer either
    /// way; `frontend.restore` is the read).
    async fn frontend_backup(&self, entries: HashMap<String, String>) -> HashMap<String, String> {
        let accepted: HashMap<String, String> = entries.iter().filter(|(key, _)| !key.is_empty()).map(|(k, v)| (k.clone(), v.clone())).collect();
        let data = {
            let mut state = self.inner.state.write().await;
            for (key, value) in entries {
                if !key.is_empty() {
                    state.frontend_backup.insert(key, value);
                }
            }
            serde_json::to_vec(&state.frontend_backup).ok()
        };
        // Best effort, like the original: the in-memory copy is still there if the write fails.
        if let Some(data) = data {
            let _ = write_state_file(&self.inner.paths.frontend_backup, data).await;
        }
        accepted
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
        let auth = AuthState { token, profile: user, saved_at, rejected: false };
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
        // Network first, lock only for the save, as everywhere else in this module.
        let fetched = self.sc().await.fetch_profile(&token).await;
        let stale = {
            let mut state = self.inner.state.write().await;
            if state.auth.token != token {
                // The session changed while we were fetching (e.g. a fresh login): report the current
                // state instead of overwriting it with stale data.
                return Ok(auth_status(&state));
            }
            self.refresh_auth_locked(&mut state, fetched).await?.stale
        };
        // A refresh is the natural moment to try the repair the playback path would attempt anyway.
        if stale && let Err(e) = self.repull_session(&token).await {
            log::warn!("auth.refresh stage=repull_failed error={e}");
        }
        Ok(auth_status(&*self.inner.state.read().await))
    }

    /// Applies a profile fetch result. The caller holds the write lock and has confirmed the stored
    /// token is the one that was fetched.
    async fn refresh_auth_locked(&self, state: &mut State, fetched: BResult<Profile>) -> Result<AuthStatus, String> {
        match fetched {
            Err(e) if e.is_rejected() => {
                // One rejection does not invalidate the session for good (a hiccup on SoundCloud's
                // side looks the same). Keep the token and mark it stale, so the silent re-pull —
                // or the user signing in again — can repair it. Only an explicit logout deletes it.
                log::warn!("auth stage=token_rejected action=mark_stale error={e}");
                state.auth.rejected = true;
                write_secret_file(&self.inner.paths.auth, to_pretty_json(&state.auth)?).await.map_err(|e| format!("save auth: {e}"))?;
                Ok(auth_status(state))
            }
            // Offline: keep the session and answer with the cached profile.
            Err(_) => Ok(auth_status(state)),
            Ok(user) => {
                state.auth.profile = user;
                state.auth.rejected = false;
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

    /// The account's liked tracks, with the same session repair every other SoundCloud call gets.
    async fn tracks_mine(&self) -> Result<Vec<TrackCard>, String> {
        self.soundcloud_call(|sc| async move {
            sc.require_token()?;
            let (token, user_id) = (sc.token.clone(), sc.user_id);
            sc.fetch_my_tracks(&token, user_id).await
        })
        .await
        .map_err(s)
    }

    // ---- session repair -----------------------------------------------------------------------

    /// Runs one SoundCloud call. A failure caused by the session itself triggers a single silent
    /// re-pull of the web session, after which the call is retried with the fresh token; every other
    /// failure passes through untouched. One retry per call, so a dead session can never loop.
    async fn soundcloud_call<T, F, Fut>(&self, call: F) -> BResult<T>
    where
        F: Fn(Sc) -> Fut,
        Fut: std::future::Future<Output = BResult<T>>,
    {
        let sc = self.sc().await;
        let rejected_token = sc.token.clone();
        match call(sc).await {
            Err(e) if e.is_auth() => {
                log::info!("soundcloud.session stage=rejected connected={} error={e}", !rejected_token.is_empty());
                self.repull_session(&rejected_token).await?;
                let retried = call(self.sc().await).await;
                if let Err(e) = &retried
                    && e.is_auth()
                {
                    log::warn!("soundcloud.session stage=still_rejected error={e}");
                    self.mark_session_stale().await;
                    return Err(BErr::session_failure(!self.inner.state.read().await.auth.token.is_empty()));
                }
                retried
            }
            other => other,
        }
    }

    /// Pulls the web session again and stores it. Holding the gate across the attempt is what makes
    /// concurrent failures share one hidden window: the next caller waits here and then retries with
    /// the token the first one captured.
    async fn repull_session(&self, rejected_token: &str) -> BResult<()> {
        let mut last = self.inner.session_recovery.lock().await;
        let current = self.inner.state.read().await.auth.token.clone();
        match plan_repull(&current, rejected_token, last.as_ref(), std::time::Instant::now()) {
            RepullPlan::Retry => return if current.is_empty() { Err(BErr::session_failure(false)) } else { Ok(()) },
            RepullPlan::Skip => return Err(BErr::session_failure(!current.is_empty())),
            RepullPlan::Pull => {}
        }
        log::info!("soundcloud.session stage=repull_start");
        let repaired = match crate::auth_windows::pull_soundcloud_session().await {
            Ok(session) => self.store_session(&session.client_id, &session.token).await,
            Err(e) => Err(e),
        };
        let token = self.inner.state.read().await.auth.token.clone();
        *last = Some(RepullAttempt { token: token.clone(), captured: repaired.is_ok(), at: std::time::Instant::now() });
        match repaired {
            Ok(()) => {
                log::info!("soundcloud.session stage=repull_complete");
                Ok(())
            }
            Err(e) => {
                log::warn!("soundcloud.session stage=repull_failed error={e}");
                self.mark_session_stale().await;
                Err(BErr::session_failure(!token.is_empty()))
            }
        }
    }

    /// Stores a session captured from the webview: the client id the page used, and the token once
    /// SoundCloud has confirmed it still works.
    async fn store_session(&self, client_id: &str, token: &str) -> Result<(), String> {
        let (client_id, token) = (client_id.trim().to_string(), token.trim().to_string());
        if client_id.is_empty() || token.is_empty() {
            return Err("captured SoundCloud session is incomplete".into());
        }
        let user = self.sc().await.fetch_profile(&token).await.map_err(|e| e.to_string())?;
        let auth = AuthState { token, profile: user, saved_at: chrono_like_rfc3339(), rejected: false };
        let mut state = self.inner.state.write().await;
        if valid_client_id(&client_id) && state.settings.client_id != client_id {
            // The page's requests carry the client id this session belongs to; api-v2 wants both.
            state.settings.client_id = client_id;
            write_secret_file(&self.inner.paths.settings, to_pretty_json(&state.settings)?).await.map_err(|e| format!("save settings: {e}"))?;
        }
        write_secret_file(&self.inner.paths.auth, to_pretty_json(&auth)?).await.map_err(|e| format!("save auth: {e}"))?;
        state.auth = auth;
        Ok(())
    }

    /// Repairs the SoundCloud session at startup, before the user asks for a track. A session this
    /// app has used before (a stored token, or the client id only a SoundCloud session leaves
    /// behind) is re-pulled silently, so an expired session is not discovered mid-playback.
    pub async fn restore_session_on_start(&self) {
        let (token, rejected, known) = {
            let state = self.inner.state.read().await;
            (state.auth.token.clone(), state.auth.rejected, !state.settings.client_id.trim().is_empty())
        };
        if !rejected && (!token.is_empty() || !known) {
            return;
        }
        log::info!("soundcloud.session stage=startup_repull rejected={rejected} token={}", !token.is_empty());
        match self.repull_session(&token).await {
            Ok(()) => log::info!("soundcloud.session stage=startup_repull_complete"),
            Err(e) => log::warn!("soundcloud.session stage=startup_repull_failed error={e}"),
        }
    }

    /// Marks a live token as refused by SoundCloud, so the account page can offer a fresh sign-in.
    async fn mark_session_stale(&self) {
        let mut state = self.inner.state.write().await;
        if state.auth.token.is_empty() || state.auth.rejected {
            return;
        }
        state.auth.rejected = true;
        if let Ok(data) = to_pretty_json(&state.auth) {
            let _ = write_secret_file(&self.inner.paths.auth, data).await;
        }
    }
}

/// Outcome of one silent re-pull, remembered so a broken session does not open a window per click.
#[derive(Debug, Clone)]
struct RepullAttempt {
    token: String,
    captured: bool,
    at: std::time::Instant,
}

#[derive(Debug, PartialEq, Eq)]
enum RepullPlan {
    /// The stored token already differs from the rejected one: retry, no window needed.
    Retry,
    /// A re-pull for this very token just failed; repeating it immediately would only repeat itself.
    Skip,
    /// Pull the session again.
    Pull,
}

/// Wait before another silent re-pull is attempted for the same token.
const REPULL_COOLDOWN: Duration = Duration::from_secs(20);

/// Decides what a rejected call does about the session. Kept away from the webview so the decision
/// and its cooldown are testable without a window.
fn plan_repull(current_token: &str, rejected_token: &str, last: Option<&RepullAttempt>, now: std::time::Instant) -> RepullPlan {
    if current_token != rejected_token {
        return RepullPlan::Retry;
    }
    match last {
        Some(attempt) if attempt.token == current_token && !attempt.captured && now.duration_since(attempt.at) < REPULL_COOLDOWN => RepullPlan::Skip,
        _ => RepullPlan::Pull,
    }
}

fn auth_status(state: &State) -> AuthStatus {
    if state.auth.token.is_empty() {
        AuthStatus::default()
    } else {
        AuthStatus { authorized: true, profile: Some(state.auth.profile.clone()), stale: state.auth.rejected }
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
    analysis: bool,
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

#[tauri::command]
pub async fn soundcloud_analysis_pcm_command(backend: TauriState<'_, Backend>, track_urn: String) -> Result<tauri::ipc::Response, String> {
    let pcm = backend.soundcloud_analysis_pcm(&track_urn).await?;
    let bytes: Vec<u8> = pcm.into_iter().flat_map(f32::to_le_bytes).collect();
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn cancel_soundcloud_analysis_command(backend: TauriState<'_, Backend>) {
    backend.cancel_soundcloud_analysis();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The renderer calls these by name; a typo or a dropped arm would only surface at runtime as
    /// "unknown method". This mirrors the table the Go sidecar pinned in `TestRPCMethodNames`.
    const METHODS: [&str; 17] = [
        "auth.login", "auth.logout", "auth.refresh", "auth.status", "cache.clear", "frontend.backup", "frontend.restore", "playlist.tracks", "playlists.mine",
        "resolve.playlist", "search.tracks", "settings.update", "track.lyrics", "track.related", "track.stream", "tracks.mine", "user.likes.by.input",
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
                analysis_generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
                session_recovery: tokio::sync::Mutex::new(None),
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
    }

    #[tokio::test]
    async fn frontend_backup_merges_and_persists() {
        let backend = temp_backend();
        backend.call("frontend.backup", serde_json::json!({"entries": {"a": "1", "": "ignored"}})).await.unwrap();
        let accepted = backend.call("frontend.backup", serde_json::json!({"entries": {"b": "2"}})).await.unwrap();
        assert_eq!(accepted, serde_json::json!({"b": "2"}));
        assert_eq!(backend.call("frontend.restore", Value::Null).await.unwrap(), serde_json::json!({"a": "1", "b": "2"}));
        assert_eq!(State::load(&backend.inner.paths).frontend_backup.len(), 2);
    }

    #[tokio::test]
    async fn account_calls_require_a_connected_account() {
        let backend = temp_backend();
        assert_eq!(backend.call("auth.status", Value::Null).await.unwrap(), serde_json::json!({"authorized": false}));
        for method in ["tracks.mine", "playlists.mine"] {
            assert_eq!(backend.call(method, Value::Null).await.unwrap_err(), NOT_CONNECTED, "{method}");
        }
        assert_eq!(backend.call("search.tracks", serde_json::json!({"query": "  "})).await.unwrap(), serde_json::json!([]));
        assert!(backend.call("auth.login", serde_json::json!({"token": "  "})).await.is_err());
    }

    #[test]
    fn rejected_sessions_are_repulled_once_then_left_alone() {
        let now = std::time::Instant::now();
        let first = plan_repull("tok", "tok", None, now);
        assert_eq!(first, RepullPlan::Pull);
        // The same token, freshly failed: no second window within the cooldown.
        let failed = RepullAttempt { token: "tok".into(), captured: false, at: now };
        assert_eq!(plan_repull("tok", "tok", Some(&failed), now + Duration::from_secs(5)), RepullPlan::Skip);
        // Past the cooldown a click is allowed to try again.
        assert_eq!(plan_repull("tok", "tok", Some(&failed), now + REPULL_COOLDOWN), RepullPlan::Pull);
        // A captured session is never held back: the token now differs, so callers just retry.
        let captured = RepullAttempt { token: "fresh".into(), captured: true, at: now };
        assert_eq!(plan_repull("fresh", "tok", Some(&captured), now), RepullPlan::Retry);
        // A concurrent logout/re-pull that changed the token needs no window either.
        assert_eq!(plan_repull("fresh", "", Some(&failed), now), RepullPlan::Retry);
    }

    #[test]
    fn only_session_errors_count_as_auth_failures() {
        assert!(BErr::rejected().is_auth());
        assert!(BErr::SessionExpired.is_auth());
        assert!(BErr::msg(NOT_CONNECTED).is_auth());
        assert!(!BErr::msg("SoundCloud вернул ошибку HTTP 500").is_auth());
        assert!(!BErr::msg("SoundCloud временно ограничил запросы (HTTP 429), повторите позже").is_auth());
        assert!(!BErr::Captcha("x".into()).is_auth());
        // The marker the renderer branches on leads the message a user may end up reading.
        assert!(BErr::SessionExpired.to_string().starts_with("soundcloud_session_expired"));
        assert_eq!(BErr::session_failure(false).to_string(), NOT_CONNECTED);
        assert_eq!(BErr::session_failure(true).to_string(), SESSION_EXPIRED);
        // Wrapping an error must not hide a session failure from the repair path.
        assert!(BErr::rejected().context(|d| format!("x: {d}")).is_auth());
        assert_eq!(BErr::msg("boom").context(|d| format!("x: {d}")).to_string(), "x: boom");
    }

    #[tokio::test]
    async fn a_rejected_profile_keeps_the_session_and_marks_it_stale() {
        let backend = temp_backend();
        {
            let mut state = backend.inner.state.write().await;
            state.auth = AuthState { token: "tok".into(), profile: Profile { id: 7, username: "me".into(), ..Default::default() }, saved_at: "2026-01-02T03:04:05Z".into(), rejected: false };
        }
        let status = {
            let mut state = backend.inner.state.write().await;
            backend.refresh_auth_locked(&mut state, Err(BErr::rejected())).await.unwrap()
        };
        assert!(status.authorized && status.stale);
        // The token survives the rejection: only an explicit logout clears it.
        assert_eq!(status.profile.as_ref().map(|p| p.id), Some(7));
        let reloaded = State::load(&backend.inner.paths);
        assert_eq!((reloaded.auth.token.as_str(), reloaded.auth.rejected), ("tok", true));

        // A profile that works again clears the flag.
        let profile = Profile { id: 7, username: "me".into(), ..Default::default() };
        let status = {
            let mut state = backend.inner.state.write().await;
            backend.refresh_auth_locked(&mut state, Ok(profile)).await.unwrap()
        };
        assert!(!status.stale);

        // Logout is the only path that deletes the session.
        backend.auth_logout().await.unwrap();
        assert!(!backend.inner.paths.auth.exists());
        assert_eq!(backend.call("auth.status", Value::Null).await.unwrap(), serde_json::json!({"authorized": false}));
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
                analysis_generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
                session_recovery: tokio::sync::Mutex::new(None),
            }),
        };
        let params: Value = std::env::var("LIVE_PARAMS").ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_else(|| serde_json::json!({"trackId": 1, "title": "Blinding Lights", "artist": "The Weeknd", "durationMs": 200000}));
        let out = backend.call("track.lyrics", params).await.unwrap();
        println!("{}", serde_json::to_string(&out).unwrap());
    }
}
