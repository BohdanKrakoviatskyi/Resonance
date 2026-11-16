use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::Client;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinSet;
use url::Url;

use super::audio_cache::AudioCache;
use super::clients::{
    ClientProfile, GateTracker, ResolvedYtStream, YtProxyStreamResponse, YtResolveAttemptTiming,
    app_data_root_dir, is_valid_video_id, now_unix_secs, refresh_remote_clients_if_stale,
    registry_snapshot,
};
use super::http_relay::handle_proxy_connection;
use super::identity::{VisitorIdentity, read_ytmusic_credentials};
use super::player_js::PlayerJsSolver;
use super::resolver::{
    is_bot_wall_reason, is_permanent_reason, resolve_via_profile, resolve_via_tv_samsung,
    resolve_via_web_embedded,
};
use super::stream_cache::{load_persisted_stream_cache, save_persisted_stream_cache};

const MAX_CACHED_STREAMS: usize = 256;
const CLIENT_TIMEOUT: Duration = Duration::from_millis(850);
const TV_SAMSUNG_TIMEOUT: Duration = Duration::from_millis(1200);
const TV_SAMSUNG_COLD_TIMEOUT: Duration = Duration::from_millis(5000);
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
    port: Arc<Mutex<Option<u16>>>,
    resolve_epoch: Arc<AtomicU64>,
    disk_cache_path: PathBuf,
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
            .timeout(Duration::from_millis(1500))
            .connect_timeout(Duration::from_millis(800))
            .local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
            .build()
            .unwrap_or_else(|_| Client::new());

        let browse_http = Client::builder()
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(5))
            .local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
            .build()
            .unwrap_or_else(|_| Client::new());

        let stream_http = Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .build()
            .unwrap_or_else(|_| Client::new());

        let stream_http_v4 = Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
            .build()
            .unwrap_or_else(|_| stream_http.clone());

        let stream_http_v6 = Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .local_address(IpAddr::V6(Ipv6Addr::UNSPECIFIED))
            .build()
            .unwrap_or_else(|_| stream_http.clone());

        let base_dir = app_data_root_dir();
        let _ = std::fs::create_dir_all(&base_dir);
        let disk_cache_path = base_dir.join("yt_stream_url_cache.json");
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
            port: Arc::new(Mutex::new(None)),
            resolve_epoch: Arc::new(AtomicU64::new(0)),
            disk_cache_path,
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
            let _ = tokio::join!(
                refresh_remote_clients_if_stale(&bg.browse_http),
                bg.visitor.ensure(&bg.browse_http),
                bg.player_js.ensure_ready(&bg.browse_http),
            );
        });

        Ok(local_port)
    }

    pub fn begin_user_resolve(&self) -> u64 {
        self.resolve_epoch.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn is_stale(&self, epoch: Option<u64>) -> bool {
        epoch.is_some_and(|ep| self.resolve_epoch.load(Ordering::Relaxed) > ep)
    }

    pub async fn get_or_resolve_stream(
        &self,
        video_id: &str,
        force_refresh: bool,
        _priority: bool,
        epoch: Option<u64>,
    ) -> Result<(ResolvedYtStream, bool, u64, Vec<YtResolveAttemptTiming>), String> {
        let total_start = Instant::now();
        let trimmed = video_id.trim();
        if !is_valid_video_id(trimmed) {
            return Err("Invalid YouTube video ID.".to_string());
        }
        if self.is_stale(epoch) {
            return Err("Cancelled: superseded by newer track request.".to_string());
        }
        if !force_refresh {
            if let Some(existing) = self.cached_valid(trimmed).await {
                let ms = total_start.elapsed().as_millis() as u64;
                return Ok((
                    existing.clone(),
                    true,
                    ms,
                    vec![YtResolveAttemptTiming {
                        method: format!("cache ({})", existing.level_label),
                        outcome: "hit".to_string(),
                        duration_ms: ms,
                    }],
                ));
            }
        } else {
            self.invalidate_stream(trimmed).await;
        }
        let video_lock = {
            let mut inflight = self.inflight.lock().await;
            inflight
                .entry(trimmed.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _inflight_guard = video_lock.lock().await;
        if !force_refresh {
            if let Some(existing) = self.cached_valid(trimmed).await {
                let ms = total_start.elapsed().as_millis() as u64;
                return Ok((
                    existing.clone(),
                    true,
                    ms,
                    vec![YtResolveAttemptTiming {
                        method: format!("inflight ({})", existing.level_label),
                        outcome: "shared_ok".to_string(),
                        duration_ms: ms,
                    }],
                ));
            }
        }
        let res = self.resolve_fast(trimmed, epoch, total_start).await;
        self.cleanup_inflight(trimmed, &video_lock).await;
        res
    }

    async fn resolve_fast(
        &self,
        video_id: &str,
        epoch: Option<u64>,
        total_start: Instant,
    ) -> Result<(ResolvedYtStream, bool, u64, Vec<YtResolveAttemptTiming>), String> {
        let mut attempts = Vec::new();
        let reg = registry_snapshot();
        let open_profiles: Vec<ClientProfile> = self
            .gates
            .open_only(&reg.stream_ladder)
            .into_iter()
            .cloned()
            .collect();
        let tv_allowed = !self.gates.is_gated("TVHTML5") && !self.gates.is_gated("TVHTML5_SAMSUNG_FAST");

        // Never stall playback waiting for visitor_id minting; use cached value immediately if ready.
        let mut visitor_data = self.visitor.current();
        if visitor_data.is_none() {
            let v = self.visitor.clone();
            let h = self.browse_http.clone();
            tokio::spawn(async move {
                let _ = v.ensure(&h).await;
            });
        }
        let cookie = tokio::task::spawn_blocking(|| read_ytmusic_credentials().map(|c| c.cookie))
            .await
            .ok()
            .flatten();

        // Phase 1: Race the first 2 open InnerTube profiles (and TVHTML5_SAMSUNG when warm) in parallel
        // so tracks resolve in the latency of the fastest healthy client (~100-350ms).
        if !open_profiles.is_empty() {
            if self.is_stale(epoch) {
                return Err("Cancelled: superseded by newer track request.".to_string());
            }
            let tv_warm = tv_allowed && self.player_js.current_sts().is_some();
            let mut set = JoinSet::new();
            for prof in open_profiles.iter().take(3).cloned() {
                let http1 = self.playback_http.clone();
                let solver1 = self.player_js.clone();
                let vid1 = video_id.to_string();
                let vd1 = visitor_data.clone();
                let ck1 = cookie.clone();
                set.spawn(async move {
                    let t0 = Instant::now();
                    let res = tokio::time::timeout(
                        CLIENT_TIMEOUT,
                        resolve_via_profile(&http1, &solver1, &vid1, &prof, vd1.as_deref(), ck1.as_deref()),
                    )
                    .await
                    .unwrap_or_else(|_| Err(format!("{}: timeout", prof.key)));
                    (format!("InnerTube: {}", prof.key), prof.key, prof.send_cookie, t0.elapsed().as_millis() as u64, res)
                });
            }

            if tv_warm {
                let http2 = self.playback_http.clone();
                let solver = self.player_js.clone();
                let vid2 = video_id.to_string();
                set.spawn(async move {
                    let t0 = Instant::now();
                    let res = tokio::time::timeout(
                        TV_SAMSUNG_TIMEOUT,
                        resolve_via_tv_samsung(&http2, &solver, &vid2),
                    )
                    .await
                    .unwrap_or_else(|_| Err("TVHTML5_SAMSUNG: timeout".to_string()));
                    ("InnerTube: TVHTML5_SAMSUNG (fast)".to_string(), "TVHTML5_SAMSUNG_FAST".to_string(), false, t0.elapsed().as_millis() as u64, res)
                });
            }

            let mut saw_bot_wall = false;
            while let Some(joined) = set.join_next().await {
                if self.is_stale(epoch) {
                    set.abort_all();
                    return Err("Cancelled: superseded by newer track request.".to_string());
                }
                let Ok((method, key, send_cookie, dt, res)) = joined else {
                    continue;
                };
                match res {
                    Ok(resolved) => {
                        set.abort_all();
                        attempts.push(YtResolveAttemptTiming {
                            method: resolved.level_label.clone(),
                            outcome: "ok".to_string(),
                            duration_ms: dt,
                        });
                        self.insert_cached_stream(video_id, resolved.clone()).await;
                        return Ok((resolved, false, total_start.elapsed().as_millis() as u64, attempts));
                    }
                    Err(err) => {
                        attempts.push(YtResolveAttemptTiming {
                            method,
                            outcome: format!("err: {err}"),
                            duration_ms: dt,
                        });
                        if is_bot_wall_reason(&err) {
                            saw_bot_wall = true;
                            if key == "TVHTML5_SAMSUNG_FAST" {
                                self.gates.record_player_gate("TVHTML5_SAMSUNG_FAST", BOT_WALL_GATE_TTL);
                            } else if !send_cookie {
                                // Only gate the specific profile that got bot-walled; ANDROID_MUSIC
                                // returning "Please sign in" must not poison VISIONOS/ANDROID_VR.
                                self.gates.record_player_gate(&key, BOT_WALL_GATE_TTL);
                            }
                        } else if is_permanent_reason(&err) && send_cookie {
                            set.abort_all();
                            return Err(err);
                        }
                    }
                }
            }
            if saw_bot_wall {
                if let Some(fresh_vd) = self.visitor.reroll(&self.playback_http).await {
                    self.gates.clear();
                    visitor_data = Some(fresh_vd);
                }
            }
        }

        // Phase 2: Race remaining open InnerTube profiles concurrently in one shot (bounded by CLIENT_TIMEOUT).
        let raced_keys: std::collections::HashSet<&str> = open_profiles.iter().take(3).map(|p| p.key.as_str()).collect();
        let remaining_profiles: Vec<ClientProfile> = self
            .gates
            .open_only(&reg.stream_ladder)
            .into_iter()
            .filter(|p| !raced_keys.contains(p.key.as_str()))
            .cloned()
            .collect();
        if !remaining_profiles.is_empty() {
            let mut set = JoinSet::new();
            for prof in remaining_profiles {
                let http = self.playback_http.clone();
                let solver = self.player_js.clone();
                let vid = video_id.to_string();
                let vd = visitor_data.clone();
                let ck = cookie.clone();
                set.spawn(async move {
                    let t0 = Instant::now();
                    let res = tokio::time::timeout(
                        CLIENT_TIMEOUT,
                        resolve_via_profile(&http, &solver, &vid, &prof, vd.as_deref(), ck.as_deref()),
                    )
                    .await
                    .unwrap_or_else(|_| Err(format!("{}: timeout", prof.key)));
                    (prof.key, prof.send_cookie, t0.elapsed().as_millis() as u64, res)
                });
            }

            while let Some(joined) = set.join_next().await {
                if self.is_stale(epoch) {
                    set.abort_all();
                    return Err("Cancelled: superseded by newer track request.".to_string());
                }
                let Ok((key, send_cookie, dt, res)) = joined else {
                    continue;
                };
                match res {
                    Ok(resolved) => {
                        set.abort_all();
                        attempts.push(YtResolveAttemptTiming {
                            method: resolved.level_label.clone(),
                            outcome: "ok".to_string(),
                            duration_ms: dt,
                        });
                        self.insert_cached_stream(video_id, resolved.clone()).await;
                        return Ok((resolved, false, total_start.elapsed().as_millis() as u64, attempts));
                    }
                    Err(err) => {
                        attempts.push(YtResolveAttemptTiming {
                            method: format!("InnerTube: {key}"),
                            outcome: format!("err: {err}"),
                            duration_ms: dt,
                        });
                        if is_bot_wall_reason(&err) {
                            self.gates.record_player_gate(&key, BOT_WALL_GATE_TTL);
                        } else if send_cookie && is_permanent_reason(&err) {
                            set.abort_all();
                            return Err(err);
                        }
                    }
                }
            }
        } else if attempts.is_empty() {
            attempts.push(YtResolveAttemptTiming {
                method: "InnerTube: gated".to_string(),
                outcome: "skipped (bot-wall cooldown)".to_string(),
                duration_ms: 0,
            });
        }

        // Phase 3: Direct TVHTML5_SAMSUNG + WEB_EMBEDDED_PLAYER with QuickJS sig/n solver.
        if !self.gates.is_gated("TVHTML5") && !self.gates.is_gated("TVHTML5_SAMSUNG_FAST") {
            if self.is_stale(epoch) {
                return Err("Cancelled: superseded by newer track request.".to_string());
            }
            let tv_timeout = if self.player_js.current_sts().is_some() {
                TV_SAMSUNG_TIMEOUT
            } else {
                TV_SAMSUNG_COLD_TIMEOUT
            };
            let t_tv = Instant::now();
            let tv_res = tokio::time::timeout(
                tv_timeout,
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
                    if is_bot_wall_reason(&err) {
                        self.gates.record_player_gate("TVHTML5_SAMSUNG_FAST", BOT_WALL_GATE_TTL);
                    }
                }
            }
        }

        if let Ok(emb) = tokio::time::timeout(
            TV_SAMSUNG_TIMEOUT,
            resolve_via_web_embedded(&self.playback_http, &self.player_js, video_id),
        )
        .await
        .unwrap_or_else(|_| Err("WEB_EMBEDDED_PLAYER: timeout".to_string()))
        {
            attempts.push(YtResolveAttemptTiming {
                method: emb.level_label.clone(),
                outcome: "ok".to_string(),
                duration_ms: total_start.elapsed().as_millis() as u64,
            });
            self.insert_cached_stream(video_id, emb.clone()).await;
            return Ok((emb, false, total_start.elapsed().as_millis() as u64, attempts));
        }

        // Last resort: authenticated WEB_REMIX with QuickJS sig/n solver when all unauth profiles are gated.
        // Never gate TVHTML5 permanently from a single stream refusal in swap_refused_stream if
        // it just failed on another video — only gate the specific key if TVHTML5 returned 403.
        if !self.gates.is_gated("WEB_REMIX") && cookie.is_some() {
            if self.is_stale(epoch) {
                return Err("Cancelled: superseded by newer track request.".to_string());
            }
            let t_wr = Instant::now();
            let wr_res = tokio::time::timeout(
                CLIENT_TIMEOUT,
                resolve_via_profile(&self.playback_http, &self.player_js, video_id, &reg.web_remix, visitor_data.as_deref(), cookie.as_deref()),
            )
            .await
            .unwrap_or_else(|_| Err("WEB_REMIX: timeout".to_string()));
            let dt_wr = t_wr.elapsed().as_millis() as u64;
            match wr_res {
                Ok(resolved) => {
                    attempts.push(YtResolveAttemptTiming {
                        method: resolved.level_label.clone(),
                        outcome: "ok".to_string(),
                        duration_ms: dt_wr,
                    });
                    self.insert_cached_stream(video_id, resolved.clone()).await;
                    return Ok((resolved, false, total_start.elapsed().as_millis() as u64, attempts));
                }
                Err(err) => {
                    attempts.push(YtResolveAttemptTiming {
                        method: "InnerTube: WEB_REMIX".to_string(),
                        outcome: format!("err: {err}"),
                        duration_ms: dt_wr,
                    });
                    return Err(err);
                }
            }
        }

        // Fallback: authenticated ANDROID_VR or other cookie-capable profile via ANDROID_MUSIC / WEB_REMIX
        Err(attempts
            .last()
            .map(|a| format!("{}: {}", a.method, a.outcome))
            .unwrap_or_else(|| "Unable to resolve YouTube audio stream.".to_string()))
    }

    pub async fn swap_refused_stream(
        &self,
        video_id: &str,
        refused: &ResolvedYtStream,
    ) -> Result<ResolvedYtStream, String> {
        self.invalidate_stream(video_id).await;
        if refused.level_label.contains("TVHTML5_SAMSUNG") {
            self.gates.record_player_gate("TVHTML5_SAMSUNG_FAST", BOT_WALL_GATE_TTL);
            self.player_js.invalidate_player();
        } else if !refused.client_key.is_empty() {
            let reg = registry_snapshot();
            for p in &reg.stream_ladder {
                if p.client_name.eq_ignore_ascii_case(&refused.client_key)
                    || p.key.eq_ignore_ascii_case(&refused.client_key)
                {
                    self.gates.record_player_gate(&p.key, BOT_WALL_GATE_TTL);
                }
            }
        }
        let (fresh, _, _, _) = self.get_or_resolve_stream(video_id, true, true, None).await?;
        Ok(fresh)
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
                if let Some(oldest) = cache
                    .iter()
                    .min_by_key(|(_, v)| v.expires_at)
                    .map(|(k, _)| k.clone())
                {
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
    let epoch = if is_priority {
        Some(state.begin_user_resolve())
    } else {
        None
    };
    let (_, cache_hit, resolve_ms, attempts) = state
        .get_or_resolve_stream(&video_id, false, is_priority, epoch)
        .await?;
    let trimmed = video_id.trim();
    let mut q = vec![format!("t={}", state.token)];
    if let Some(id) = request_id {
        q.push(format!("reqId={id}"));
    }
    if let Some(ts) = click_ts_ms {
        q.push(format!("clickTs={ts}"));
    }
    let url = Url::parse(&format!(
        "http://127.0.0.1:{port}/yt-stream/{trimmed}?{}",
        q.join("&")
    ))
    .map_err(|e| format!("Failed to build proxy URL: {e}"))?;
    Ok(YtProxyStreamResponse {
        url: url.to_string(),
        cache_hit,
        resolve_ms,
        attempts,
    })
}

#[tauri::command]
pub async fn frontend_log(message: String) {
    let path = app_data_root_dir().join("player-timing.log");
    let line = format!("[ts={}] {message}\n", now_unix_secs());
    if let Ok(mut f) = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
    {
        use tokio::io::AsyncWriteExt;
        let _ = f.write_all(line.as_bytes()).await;
    }
}
