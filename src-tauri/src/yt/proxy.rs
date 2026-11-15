use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::Client;
use tokio::net::TcpListener;
use tokio::sync::{Mutex, Semaphore};
use url::Url;

use super::audio_cache::AudioCache;
use super::clients::{
    GateTracker, ResolvedYtStream, YtProxyStreamResponse, YtResolveAttemptTiming,
    app_data_root_dir, is_valid_video_id, now_unix_secs, registry,
};
use super::http_relay::handle_proxy_connection;
use super::identity::{VisitorIdentity, read_ytmusic_credentials};
use super::player_js::PlayerJsSolver;
use super::resolver::{
    is_bot_wall_reason, is_permanent_reason, resolve_via_profile, resolve_via_tv_samsung,
};
use super::stream_cache::{load_persisted_stream_cache, save_persisted_stream_cache};
use super::ytdlp_fallback::{
    check_daily_ytdlp_update, resolve_via_ytdlp_fallback, warmup_cache_needed,
};

const MAX_PRIORITY_YTDLP: usize = 2;
const MAX_BACKGROUND_YTDLP: usize = 1;
const MAX_TOTAL_YTDLP: usize = 3;
const MAX_CACHED_STREAMS: usize = 256;
const CLIENT_TIMEOUT: Duration = Duration::from_secs(6);
const BOT_WALL_GATE_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone)]
pub struct YtStreamProxy {
    pub playback_http: Client,
    pub browse_http: Client,
    pub stream_http: Client,
    pub stream_http_v4: Client,
    pub stream_http_v6: Client,
    pub visitor: Arc<VisitorIdentity>,
    pub player_js: Arc<PlayerJsSolver>,
    pub gates: Arc<GateTracker>,
    pub audio_cache: Arc<AudioCache>,
    pub cache: Arc<Mutex<HashMap<String, ResolvedYtStream>>>,
    inflight: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    priority_semaphore: Arc<Semaphore>,
    background_semaphore: Arc<Semaphore>,
    pub total_semaphore: Arc<Semaphore>,
    port: Arc<Mutex<Option<u16>>>,
    pub bin_lock: Arc<Mutex<bool>>,
    resolve_epoch: Arc<AtomicU64>,
    pub bundle_provision_started: Arc<AtomicBool>,
    disk_cache_path: PathBuf,
    pub ytdlp_cache_dir: PathBuf,
    pub token: String,
}

impl Default for YtStreamProxy {
    fn default() -> Self {
        Self::new()
    }
}

impl YtStreamProxy {
    pub fn new() -> Self {
        let playback_http = Client::builder()
            .timeout(Duration::from_secs(12))
            .connect_timeout(Duration::from_secs(5))
            .local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
            .build()
            .unwrap_or_else(|_| Client::new());

        let browse_http = Client::builder()
            .timeout(Duration::from_secs(20))
            .connect_timeout(Duration::from_secs(8))
            .local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
            .build()
            .unwrap_or_else(|_| Client::new());

        let stream_http = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| Client::new());

        let stream_http_v4 = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
            .build()
            .unwrap_or_else(|_| stream_http.clone());

        let stream_http_v6 = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .local_address(IpAddr::V6(Ipv6Addr::UNSPECIFIED))
            .build()
            .unwrap_or_else(|_| stream_http.clone());

        let base_dir = app_data_root_dir();
        let _ = std::fs::create_dir_all(&base_dir);
        let disk_cache_path = base_dir.join("yt_stream_url_cache.json");
        let ytdlp_cache_dir = base_dir.join("yt-dlp-cache");
        let _ = std::fs::create_dir_all(&ytdlp_cache_dir);
        let initial_cache = load_persisted_stream_cache(&disk_cache_path);

        Self {
            playback_http,
            browse_http,
            stream_http,
            stream_http_v4,
            stream_http_v6,
            visitor: Arc::new(VisitorIdentity::new()),
            player_js: Arc::new(PlayerJsSolver::new()),
            gates: Arc::new(GateTracker::default()),
            audio_cache: Arc::new(AudioCache::new()),
            cache: Arc::new(Mutex::new(initial_cache)),
            inflight: Arc::new(Mutex::new(HashMap::new())),
            priority_semaphore: Arc::new(Semaphore::new(MAX_PRIORITY_YTDLP)),
            background_semaphore: Arc::new(Semaphore::new(MAX_BACKGROUND_YTDLP)),
            total_semaphore: Arc::new(Semaphore::new(MAX_TOTAL_YTDLP)),
            port: Arc::new(Mutex::new(None)),
            bin_lock: Arc::new(Mutex::new(false)),
            resolve_epoch: Arc::new(AtomicU64::new(0)),
            bundle_provision_started: Arc::new(AtomicBool::new(false)),
            disk_cache_path,
            ytdlp_cache_dir,
            token: uuid::Uuid::new_v4().simple().to_string(),
        }
    }

    pub async fn ensure_server_port(&self) -> Result<u16, String> {
        let mut guard = self.port.lock().await;
        if let Some(p) = *guard {
            return Ok(p);
        }
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("Failed to bind local YouTube audio proxy: {e}"))?;
        let local_port = listener
            .local_addr()
            .map_err(|e| format!("Failed to read YouTube proxy port: {e}"))?
            .port();
        *guard = Some(local_port);

        let proxy = self.clone();
        tokio::spawn(async move {
            loop {
                if let Ok((stream, _)) = listener.accept().await {
                    let p = proxy.clone();
                    tokio::spawn(async move {
                        let _ = handle_proxy_connection(stream, p).await;
                    });
                }
            }
        });

        let bg = self.clone();
        tokio::spawn(async move {
            let _ = bg.visitor.ensure(&bg.playback_http).await;
            let _ = bg.player_js.ensure_ready(&bg.browse_http).await;
            check_daily_ytdlp_update(&bg.browse_http, &bg.bundle_provision_started, &bg.bin_lock).await;
            if let Some(warmup_id) = warmup_cache_needed(&bg.ytdlp_cache_dir) {
                let _ = bg.resolve_ytdlp_only(warmup_id, false, None).await;
            }
        });

        Ok(local_port)
    }

    pub fn begin_user_resolve(&self) -> u64 { self.resolve_epoch.fetch_add(1, Ordering::Relaxed) + 1 }
    fn is_stale(&self, epoch: Option<u64>) -> bool { epoch.is_some_and(|ep| self.resolve_epoch.load(Ordering::Relaxed) > ep) }

    pub async fn get_or_resolve_stream(&self, video_id: &str, force_refresh: bool, priority: bool, epoch: Option<u64>) -> Result<(ResolvedYtStream, bool, u64, Vec<YtResolveAttemptTiming>), String> {
        let total_start = Instant::now();
        let trimmed = video_id.trim();
        if !is_valid_video_id(trimmed) { return Err("Invalid YouTube video ID.".to_string()); }
        if self.is_stale(epoch) { return Err("Cancelled: superseded by newer track request.".to_string()); }
        if !force_refresh {
            if let Some(existing) = self.cached_valid(trimmed).await {
                let ms = total_start.elapsed().as_millis() as u64;
                return Ok((existing.clone(), true, ms, vec![YtResolveAttemptTiming { method: format!("cache ({})", existing.level_label), outcome: "hit".to_string(), duration_ms: ms }]));
            }
        } else {
            self.invalidate_stream(trimmed).await;
        }
        let video_lock = {
            let mut inflight = self.inflight.lock().await;
            inflight.entry(trimmed.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
        };
        let _inflight_guard = video_lock.lock().await;
        if !force_refresh {
            if let Some(existing) = self.cached_valid(trimmed).await {
                let ms = total_start.elapsed().as_millis() as u64;
                return Ok((existing.clone(), true, ms, vec![YtResolveAttemptTiming { method: format!("inflight ({})", existing.level_label), outcome: "shared_ok".to_string(), duration_ms: ms }]));
            }
        }
        let res = self.resolve_ladder(trimmed, priority, epoch, total_start).await;
        self.cleanup_inflight(trimmed, &video_lock).await;
        res
    }

    async fn resolve_ladder(&self, video_id: &str, priority: bool, epoch: Option<u64>, total_start: Instant) -> Result<(ResolvedYtStream, bool, u64, Vec<YtResolveAttemptTiming>), String> {
        let mut attempts = Vec::new();
        let ladder = &registry().stream_ladder;
        let open_profiles = self.gates.open_only(ladder);
        if !open_profiles.is_empty() {
            let mut visitor_data = self.visitor.ensure(&self.playback_http).await;
            let mut identity_rerolled = false;
            let cookie = tokio::task::spawn_blocking(|| read_ytmusic_credentials().map(|c| c.cookie)).await.ok().flatten();
            for profile in open_profiles {
                if self.is_stale(epoch) { return Err("Cancelled: superseded by newer track request.".to_string()); }
                if self.gates.is_gated(&profile.key) {
                    continue;
                }
                let t0 = Instant::now();
                let mut step = tokio::time::timeout(CLIENT_TIMEOUT, resolve_via_profile(&self.playback_http, video_id, profile, visitor_data.as_deref(), cookie.as_deref())).await.unwrap_or_else(|_| Err(format!("{}: timeout", profile.key)));
                if !identity_rerolled && step.as_ref().is_err_and(|e| is_bot_wall_reason(e)) {
                    identity_rerolled = true;
                    if let Some(fresh_vd) = self.visitor.reroll(&self.playback_http).await {
                        self.gates.clear();
                        visitor_data = Some(fresh_vd);
                        step = tokio::time::timeout(CLIENT_TIMEOUT, resolve_via_profile(&self.playback_http, video_id, profile, visitor_data.as_deref(), cookie.as_deref())).await.unwrap_or_else(|_| Err(format!("{}: timeout", profile.key)));
                    }
                }
                let dt = t0.elapsed().as_millis() as u64;
                match step {
                    Ok(resolved) => {
                        attempts.push(YtResolveAttemptTiming { method: resolved.level_label.clone(), outcome: "ok".to_string(), duration_ms: dt });
                        self.insert_cached_stream(video_id, resolved.clone()).await;
                        return Ok((resolved, false, total_start.elapsed().as_millis() as u64, attempts));
                    }
                    Err(err) => {
                        attempts.push(YtResolveAttemptTiming { method: format!("InnerTube: {}", profile.key), outcome: format!("err: {err}"), duration_ms: dt });
                        if is_bot_wall_reason(&err) {
                            if !profile.send_cookie {
                                for p in ladder.iter().filter(|p| !p.send_cookie) {
                                    self.gates.record_player_gate(&p.key, BOT_WALL_GATE_TTL);
                                }
                            } else {
                                self.gates.record_player_gate(&profile.key, BOT_WALL_GATE_TTL);
                            }
                        } else if !profile.send_cookie && is_permanent_reason(&err) {
                            // Unauthenticated clients return "This video is not available" for age/kids/cookie-gated
                            // tracks; skip straight to authenticated WEB_REMIX instead of probing 3 more unauth clients.
                            break;
                        } else if is_permanent_reason(&err) {
                            return Err(err);
                        }
                    }
                }
            }
        } else {
            attempts.push(YtResolveAttemptTiming {
                method: "InnerTube: gated".to_string(),
                outcome: "skipped (bot-wall cooldown)".to_string(),
                duration_ms: 0,
            });
        }

        // Fast direct TVHTML5_SAMSUNG + embedded QuickJS sig/n solver (~270ms resolve, no 1MB PO-token cap).
        if !self.gates.is_gated("TVHTML5") && !self.gates.is_gated("TVHTML5_SAMSUNG_FAST") {
            if self.is_stale(epoch) { return Err("Cancelled: superseded by newer track request.".to_string()); }
            let t_tv = Instant::now();
            let tv_res = tokio::time::timeout(
                Duration::from_secs(20),
                resolve_via_tv_samsung(&self.playback_http, &self.player_js, video_id),
            )
            .await
            .unwrap_or_else(|_| Err("TVHTML5_SAMSUNG: timeout".to_string()));
            let dt_tv = t_tv.elapsed().as_millis() as u64;
            match tv_res {
                Ok(resolved) => {
                    attempts.push(YtResolveAttemptTiming {
                        method: resolved.level_label.clone(),
                        outcome: "ok".to_string(),
                        duration_ms: dt_tv,
                    });
                    self.insert_cached_stream(video_id, resolved.clone()).await;
                    return Ok((resolved, false, total_start.elapsed().as_millis() as u64, attempts));
                }
                Err(err) => {
                    attempts.push(YtResolveAttemptTiming {
                        method: "InnerTube: TVHTML5_SAMSUNG (fast)".to_string(),
                        outcome: format!("err: {err}"),
                        duration_ms: dt_tv,
                    });
                    if is_permanent_reason(&err) {
                        return Err(err);
                    }
                    if is_bot_wall_reason(&err) {
                        self.gates.record_player_gate("TVHTML5_SAMSUNG_FAST", BOT_WALL_GATE_TTL);
                    }
                }
            }
        }

        let t_fb = Instant::now();
        let resolved = self.resolve_ytdlp_only(video_id, priority, epoch).await?;
        attempts.push(YtResolveAttemptTiming { method: resolved.level_label.clone(), outcome: "ok".to_string(), duration_ms: t_fb.elapsed().as_millis() as u64 });
        self.insert_cached_stream(video_id, resolved.clone()).await;
        Ok((resolved, false, total_start.elapsed().as_millis() as u64, attempts))
    }

    async fn resolve_ytdlp_only(&self, video_id: &str, priority: bool, epoch: Option<u64>) -> Result<ResolvedYtStream, String> {
        let sem = if priority { &self.priority_semaphore } else { &self.background_semaphore };
        let _lane = sem.acquire().await.map_err(|_| "yt-dlp lane closed".to_string())?;
        let _total = self.total_semaphore.acquire().await.map_err(|_| "yt-dlp pool closed".to_string())?;
        if self.is_stale(epoch) { return Err("Cancelled: superseded by newer track request.".to_string()); }
        resolve_via_ytdlp_fallback(&self.playback_http, &self.ytdlp_cache_dir, &self.bundle_provision_started, &self.bin_lock, &self.gates, video_id).await
    }

    pub async fn swap_refused_stream(&self, video_id: &str, refused: &ResolvedYtStream) -> Result<ResolvedYtStream, String> {
        self.invalidate_stream(video_id).await;
        if refused.level_label.contains("TVHTML5_SAMSUNG") {
            self.player_js.invalidate_player();
        }
        let (fresh, _, _, _) = self.get_or_resolve_stream(video_id, true, true, None).await?;
        let same_itag = refused.itag.is_none() || fresh.itag.is_none() || refused.itag == fresh.itag;
        let same_len = refused.content_length.is_none() || fresh.content_length.is_none() || refused.content_length == fresh.content_length;
        if same_itag && same_len { Ok(fresh) } else { Ok(fresh) }
    }

    async fn cached_valid(&self, video_id: &str) -> Option<ResolvedYtStream> {
        let cache = self.cache.lock().await;
        cache.get(video_id).filter(|v| !v.is_expired()).cloned()
    }

    pub async fn insert_cached_stream(&self, video_id: &str, resolved: ResolvedYtStream) {
        let snapshot = {
            let mut cache = self.cache.lock().await;
            cache.retain(|_, v| !v.is_expired());
            if cache.len() >= MAX_CACHED_STREAMS && !cache.contains_key(video_id) {
                if let Some(oldest) = cache.iter().min_by_key(|(_, v)| v.expires_at).map(|(k, _)| k.clone()) {
                    cache.remove(&oldest);
                }
            }
            cache.insert(video_id.to_string(), resolved);
            cache.clone()
        };
        let path = self.disk_cache_path.clone();
        tokio::task::spawn_blocking(move || save_persisted_stream_cache(&path, &snapshot));
    }

    pub async fn invalidate_stream(&self, video_id: &str) {
        let snapshot = {
            let mut cache = self.cache.lock().await;
            cache.remove(video_id.trim());
            cache.clone()
        };
        let path = self.disk_cache_path.clone();
        tokio::task::spawn_blocking(move || save_persisted_stream_cache(&path, &snapshot));
    }

    pub async fn clear_all_caches(&self) -> (usize, u64, usize) {
        let stream_count = {
            let mut cache = self.cache.lock().await;
            let n = cache.len();
            cache.clear();
            n
        };
        let _ = std::fs::remove_file(&self.disk_cache_path);
        let (audio_files, audio_bytes) = self.audio_cache.clear_all();
        (audio_files, audio_bytes, stream_count)
    }

    async fn cleanup_inflight(&self, video_id: &str, lock_ref: &Arc<Mutex<()>>) {
        let mut inflight = self.inflight.lock().await;
        if let Some(existing) = inflight.get(video_id) {
            if Arc::ptr_eq(existing, lock_ref) && Arc::strong_count(existing) == 2 {
                inflight.remove(video_id);
            }
        }
    }
}

#[tauri::command]
pub async fn resolve_yt_stream_url(
    state: tauri::State<'_, YtStreamProxy>,
    video_id: String,
    request_id: Option<u64>,
    click_ts_ms: Option<u64>,
    priority: Option<bool>,
) -> Result<YtProxyStreamResponse, String> {
    let port = state.ensure_server_port().await?;
    let is_priority = priority.unwrap_or(true);
    let epoch = if is_priority { Some(state.begin_user_resolve()) } else { None };
    let (_, cache_hit, resolve_ms, attempts) =
        state.get_or_resolve_stream(&video_id, false, is_priority, epoch).await?;
    let trimmed = video_id.trim();
    let mut q = vec![format!("t={}", state.token)];
    if let Some(id) = request_id {
        q.push(format!("reqId={id}"));
    }
    if let Some(ts) = click_ts_ms {
        q.push(format!("clickTs={ts}"));
    }
    let url = Url::parse(&format!("http://127.0.0.1:{port}/yt-stream/{trimmed}?{}", q.join("&")))
        .map_err(|e| format!("Failed to build proxy URL: {e}"))?;
    Ok(YtProxyStreamResponse { url: url.to_string(), cache_hit, resolve_ms, attempts })
}

#[tauri::command]
pub async fn frontend_log(message: String) {
    let path = app_data_root_dir().join("player-timing.log");
    let line = format!("[ts={}] {message}\n", now_unix_secs());
    if let Ok(mut f) = tokio::fs::OpenOptions::new().create(true).append(true).open(path).await {
        use tokio::io::AsyncWriteExt;
        let _ = f.write_all(line.as_bytes()).await;
    }
}
