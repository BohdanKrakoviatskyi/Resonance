use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;
use tokio::sync::{Mutex, Semaphore};
use url::Url;

const MAX_PRIORITY_YTDLP: usize = 2;
const MAX_BACKGROUND_YTDLP: usize = 1;
const MAX_TOTAL_YTDLP: usize = 3;

const PLAYER_ENDPOINT: &str = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const SEARCH_ENDPOINT: &str = "https://music.youtube.com/youtubei/v1/search?prettyPrint=false";
const STREAM_CACHE_TTL: Duration = Duration::from_secs(45 * 60);
const DISK_EXPIRE_SAFETY_MARGIN_SECS: u64 = 15 * 60;
const YTDLP_UPDATE_INTERVAL_SECS: u64 = 24 * 60 * 60;
const YTDLP_WARMUP_VIDEO_ID: &str = "jNQXAC9IVRw";

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct ClientProfile {
    name: &'static str,
    version: &'static str,
    client_id: &'static str,
    user_agent: &'static str,
    context_client: Value,
}

/// Профиль клиента YouTube InnerTube (быстрый резервный уровень VISIONOS).
fn client_profiles() -> Vec<ClientProfile> {
    vec![
        ClientProfile {
            name: "VISIONOS",
            version: "0.1",
            client_id: "101",
            user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
            context_client: json!({
                "clientName": "VISIONOS",
                "clientVersion": "0.1",
                "deviceMake": "Apple",
                "deviceModel": "RealityDevice14,1",
                "osName": "visionOS",
                "osVersion": "1.0.21N307",
                "hl": "en",
                "gl": "US"
            }),
        },
    ]
}

#[derive(Debug, Clone)]
pub struct ResolvedYtStream {
    pub direct_url: String,
    pub user_agent: String,
    pub extra_headers: HashMap<String, String>,
    pub mime_type: String,
    pub content_length: Option<u64>,
    pub expires_at: Instant,
    pub expire_unix: Option<u64>,
    pub ip_param: Option<String>,
    pub level_label: String,
}

impl ResolvedYtStream {
    pub fn is_expired(&self) -> bool {
        if Instant::now() >= self.expires_at {
            return true;
        }
        if let Some(exp_unix) = self.expire_unix {
            let now_unix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            if now_unix + DISK_EXPIRE_SAFETY_MARGIN_SECS >= exp_unix {
                return true;
            }
        }
        false
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedYtStreamEntry {
    pub video_id: String,
    pub direct_url: String,
    pub user_agent: String,
    pub extra_headers: HashMap<String, String>,
    pub mime_type: String,
    pub content_length: Option<u64>,
    pub expire_unix: Option<u64>,
    pub saved_at_unix: u64,
    pub ip_param: Option<String>,
    pub level_label: String,
}

impl PersistedYtStreamEntry {
    fn from_resolved(video_id: &str, r: &ResolvedYtStream) -> Self {
        let now_unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        Self {
            video_id: video_id.to_string(),
            direct_url: r.direct_url.clone(),
            user_agent: r.user_agent.clone(),
            extra_headers: r.extra_headers.clone(),
            mime_type: r.mime_type.clone(),
            content_length: r.content_length,
            expire_unix: r.expire_unix,
            saved_at_unix: now_unix,
            ip_param: r.ip_param.clone(),
            level_label: r.level_label.clone(),
        }
    }

    fn to_resolved(&self, now_unix: u64) -> Option<ResolvedYtStream> {
        let remaining_secs = if let Some(exp) = self.expire_unix {
            if now_unix + DISK_EXPIRE_SAFETY_MARGIN_SECS >= exp {
                return None;
            }
            exp.saturating_sub(now_unix + DISK_EXPIRE_SAFETY_MARGIN_SECS)
        } else {
            let max_ttl = STREAM_CACHE_TTL.as_secs();
            let elapsed = now_unix.saturating_sub(self.saved_at_unix);
            if elapsed >= max_ttl {
                return None;
            }
            max_ttl - elapsed
        };

        Some(ResolvedYtStream {
            direct_url: self.direct_url.clone(),
            user_agent: self.user_agent.clone(),
            extra_headers: self.extra_headers.clone(),
            mime_type: self.mime_type.clone(),
            content_length: self.content_length,
            expires_at: Instant::now() + Duration::from_secs(remaining_secs),
            expire_unix: self.expire_unix,
            ip_param: self.ip_param.clone(),
            level_label: self.level_label.clone(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtResolveAttemptTiming {
    pub method: String,
    pub outcome: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtProxyStreamResponse {
    pub url: String,
    pub cache_hit: bool,
    pub resolve_ms: u64,
    pub attempts: Vec<YtResolveAttemptTiming>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtSearchTrack {
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
pub struct YtPlaylistTrackItem {
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
pub struct YtPlaylistResponse {
    pub playlist_id: String,
    pub title: String,
    pub artwork_url: Option<String>,
    pub track_count: usize,
    pub tracks: Vec<YtPlaylistTrackItem>,
}

#[derive(Clone)]
pub struct YtStreamProxy {
    pub http: Client,
    stream_http: Client,
    stream_http_v4: Client,
    stream_http_v6: Client,
    cache: Arc<Mutex<HashMap<String, ResolvedYtStream>>>,
    inflight: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    priority_semaphore: Arc<Semaphore>,
    background_semaphore: Arc<Semaphore>,
    total_semaphore: Arc<Semaphore>,
    port: Arc<Mutex<Option<u16>>>,
    bin_lock: Arc<Mutex<bool>>,
    consecutive_403: Arc<Mutex<u32>>,
    disk_cache_path: PathBuf,
    ytdlp_cache_dir: PathBuf,
}

impl Default for YtStreamProxy {
    fn default() -> Self {
        Self::new()
    }
}

impl YtStreamProxy {
    pub fn new() -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(25))
            .build()
            .unwrap_or_else(|_| Client::new());

        let stream_http = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| Client::new());

        let stream_http_v4 = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
            .build()
            .unwrap_or_else(|_| stream_http.clone());

        let stream_http_v6 = Client::builder()
            .connect_timeout(Duration::from_secs(15))
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
            http,
            stream_http,
            stream_http_v4,
            stream_http_v6,
            cache: Arc::new(Mutex::new(initial_cache)),
            inflight: Arc::new(Mutex::new(HashMap::new())),
            priority_semaphore: Arc::new(Semaphore::new(MAX_PRIORITY_YTDLP)),
            background_semaphore: Arc::new(Semaphore::new(MAX_BACKGROUND_YTDLP)),
            total_semaphore: Arc::new(Semaphore::new(MAX_TOTAL_YTDLP)),
            port: Arc::new(Mutex::new(None)),
            bin_lock: Arc::new(Mutex::new(false)),
            consecutive_403: Arc::new(Mutex::new(0)),
            disk_cache_path,
            ytdlp_cache_dir,
        }
    }

    pub fn select_stream_client(&self, resolved: &ResolvedYtStream) -> (&Client, &'static str) {
        if let Some(ip_str) = resolved.ip_param.as_deref() {
            if let Ok(parsed_ip) = ip_str.parse::<IpAddr>() {
                return match parsed_ip {
                    IpAddr::V4(_) => (&self.stream_http_v4, "IPv4"),
                    IpAddr::V6(_) => (&self.stream_http_v6, "IPv6"),
                };
            }
            if ip_str.contains(':') {
                return (&self.stream_http_v6, "IPv6");
            }
            if ip_str.contains('.') {
                return (&self.stream_http_v4, "IPv4");
            }
        }
        (&self.stream_http, "Auto")
    }

    pub async fn ensure_server_port(&self) -> Result<u16, String> {
        let mut guard = self.port.lock().await;
        if let Some(p) = *guard {
            return Ok(p);
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("Не удалось запустить локальный аудио-прокси YouTube: {e}"))?;
        let local_port = listener
            .local_addr()
            .map_err(|e| format!("Не удалось определить порт прокси YouTube: {e}"))?
            .port();

        *guard = Some(local_port);
        let proxy = self.clone();

        tokio::spawn(async move {
            loop {
                if let Ok((stream, _)) = listener.accept().await {
                    let peer_proxy = proxy.clone();
                    tokio::spawn(async move {
                        let _ = handle_proxy_connection(stream, peer_proxy).await;
                    });
                }
            }
        });

        // Фоновая проверка автообновления yt-dlp раз в сутки + прогрев кэша youtube-sigfuncs (Deno)
        let bg_proxy = self.clone();
        tokio::spawn(async move {
            bg_proxy.check_daily_ytdlp_update().await;
            bg_proxy.warmup_ytdlp_solver_cache().await;
        });

        Ok(local_port)
    }

    pub async fn get_or_resolve_stream(
        &self,
        video_id: &str,
        force_refresh: bool,
        priority: bool,
    ) -> Result<(ResolvedYtStream, bool, u64, Vec<YtResolveAttemptTiming>), String> {
        let total_start = Instant::now();
        let trimmed = video_id.trim();
        if !is_valid_video_id(trimmed) {
            return Err("Некорректный ID видео YouTube.".to_string());
        }

        if !force_refresh {
            let cache_start = Instant::now();
            let cache = self.cache.lock().await;
            if let Some(existing) = cache.get(trimmed) {
                if !existing.is_expired() {
                    let cache_ms = cache_start.elapsed().as_millis() as u64;
                    let total_ms = total_start.elapsed().as_millis() as u64;
                    println!(
                        "[AudioProxy][Timing] video={} stage=cache_hit level=\"{}\" ip={:?} elapsed_ms={} total_ms={}",
                        trimmed,
                        existing.level_label,
                        existing.ip_param,
                        cache_ms,
                        total_ms
                    );
                    return Ok((
                        existing.clone(),
                        true,
                        total_ms,
                        vec![YtResolveAttemptTiming {
                            method: format!("cache ({})", existing.level_label),
                            outcome: "hit".to_string(),
                            duration_ms: cache_ms,
                        }],
                    ));
                }
            }
        } else {
            self.invalidate_stream(trimmed).await;
        }

        // In-flight дедупликация по video_id: параллельные запросы к одному и тому же video_id
        // ждут завершения единственного процесса резолва, вместо порождения дубликатов yt-dlp.
        let video_lock = {
            let mut inflight = self.inflight.lock().await;
            inflight
                .entry(trimmed.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };

        let wait_start = Instant::now();
        let _inflight_guard = video_lock.lock().await;
        let inflight_wait_ms = wait_start.elapsed().as_millis() as u64;

        // Повторно проверяем кэш после ожидания in-flight блокировки (если параллельный запрос уже зарезолвил поток)
        if !force_refresh {
            let cache = self.cache.lock().await;
            if let Some(existing) = cache.get(trimmed) {
                if !existing.is_expired() {
                    let total_ms = total_start.elapsed().as_millis() as u64;
                    println!(
                        "[AudioProxy][Timing] video={} stage=inflight_shared_hit level=\"{}\" wait_ms={} total_ms={}",
                        trimmed,
                        existing.level_label,
                        inflight_wait_ms,
                        total_ms
                    );
                    return Ok((
                        existing.clone(),
                        true,
                        total_ms,
                        vec![YtResolveAttemptTiming {
                            method: format!("inflight_dedup ({})", existing.level_label),
                            outcome: "shared_ok".to_string(),
                            duration_ms: inflight_wait_ms,
                        }],
                    ));
                }
            }
        }

        let mut attempts = Vec::new();
        if inflight_wait_ms > 2 {
            attempts.push(YtResolveAttemptTiming {
                method: "inflight_lock_wait".to_string(),
                outcome: "acquired".to_string(),
                duration_ms: inflight_wait_ms,
            });
        }

        // Автономный двухуровневый резолвер с точным логированием каждой попытки и верификацией первого чанка (HTTP 206):
        // 1) Уровень 1 (Быстрый встроенный Rust InnerTube VISIONOS): ~120-250 мс + быстрая проверка Range bytes=0-1023 на 206 Partial Content.
        //    Если /player вернул ошибку или googlevideo.com ответил 403/таймаутом при чтении первого байта — мгновенно переходим на Уровень 2!
        // 2) Уровень 2 (Надёжный фоллбэк через yt-dlp -g с web_embedded и Deno, раздельные семафоры для кликов и фона).
        let l1_start = Instant::now();
        match resolve_youtubei_player_stream(&self.http, trimmed).await {
            Ok(resolved) => {
                let l1_api_ms = l1_start.elapsed().as_millis() as u64;
                let probe_start = Instant::now();
                let (probe_client, ip_family) = self.select_stream_client(&resolved);
                let probe_res = tokio::time::timeout(
                    Duration::from_millis(1200),
                    send_upstream_request(probe_client, &resolved, Some("bytes=0-1023")),
                )
                .await;

                let probe_status = match probe_res {
                    Ok(Ok(mut resp)) => {
                        let code = resp.status().as_u16();
                        if code == 206 || code == 200 {
                            let has_bytes = resp
                                .chunk()
                                .await
                                .ok()
                                .flatten()
                                .map(|b| !b.is_empty())
                                .unwrap_or(false);
                            if has_bytes { code } else { 502 }
                        } else {
                            code
                        }
                    }
                    Ok(Err(_)) => 502,
                    Err(_) => 504,
                };
                let probe_ms = probe_start.elapsed().as_millis() as u64;
                let l1_total_ms = l1_start.elapsed().as_millis() as u64;

                if probe_status == 206 || probe_status == 200 {
                    let total_ms = total_start.elapsed().as_millis() as u64;
                    println!(
                        "[AudioProxy][Timing] video={} stage=level1_rust_innertube outcome=ok_verified_{} level=\"{}\" family={} ip={:?} api_ms={} probe_ms={} total_ms={}",
                        trimmed,
                        probe_status,
                        resolved.level_label,
                        ip_family,
                        resolved.ip_param,
                        l1_api_ms,
                        probe_ms,
                        total_ms
                    );
                    attempts.push(YtResolveAttemptTiming {
                        method: resolved.level_label.clone(),
                        outcome: format!("ok (upstream HTTP {probe_status}, {ip_family})"),
                        duration_ms: l1_total_ms,
                    });
                    self.insert_cached_stream(trimmed, resolved.clone()).await;
                    self.cleanup_inflight_entry(trimmed, &video_lock).await;
                    return Ok((resolved, false, total_ms, attempts));
                } else {
                    eprintln!(
                        "[AudioProxy][Timing] video={} stage=level1_rust_innertube outcome=upstream_rejected status={} family={} api_ms={} probe_ms={}",
                        trimmed, probe_status, ip_family, l1_api_ms, probe_ms
                    );
                    attempts.push(YtResolveAttemptTiming {
                        method: resolved.level_label.clone(),
                        outcome: format!("upstream HTTP {probe_status} (rejected)"),
                        duration_ms: l1_total_ms,
                    });
                }
            }
            Err(innertube_err) => {
                let l1_ms = l1_start.elapsed().as_millis() as u64;
                eprintln!(
                    "[AudioProxy][Timing] video={} stage=level1_rust_innertube outcome=err elapsed_ms={} err=\"{}\"",
                    trimmed,
                    l1_ms,
                    innertube_err
                );
                attempts.push(YtResolveAttemptTiming {
                    method: "Level 1: VISIONOS".to_string(),
                    outcome: format!("err: {innertube_err}"),
                    duration_ms: l1_ms,
                });
            }
        }

        // Уровень 2 (Надёжный основной фоллбэк с Deno JS-решателем, дисковым --cache-dir и web_embedded):
        let l2_start = Instant::now();
        let res = match self.resolve_via_ytdlp(trimmed, priority).await {
            Ok(resolved) => {
                let l2_ms = l2_start.elapsed().as_millis() as u64;
                let total_ms = total_start.elapsed().as_millis() as u64;
                println!(
                    "[AudioProxy][Timing] video={} stage=level2_ytdlp priority={} outcome=ok ip={:?} elapsed_ms={} total_ms={} expire_unix={:?}",
                    trimmed,
                    priority,
                    resolved.ip_param,
                    l2_ms,
                    total_ms,
                    resolved.expire_unix
                );
                attempts.push(YtResolveAttemptTiming {
                    method: resolved.level_label.clone(),
                    outcome: "ok".to_string(),
                    duration_ms: l2_ms,
                });
                self.insert_cached_stream(trimmed, resolved.clone()).await;
                Ok((resolved, false, total_ms, attempts))
            }
            Err(l2_err) => {
                let l2_ms = l2_start.elapsed().as_millis() as u64;
                let total_ms = total_start.elapsed().as_millis() as u64;
                eprintln!(
                    "[AudioProxy][Timing] video={} stage=level2_ytdlp priority={} outcome=err elapsed_ms={} total_ms={} err=\"{}\"",
                    trimmed,
                    priority,
                    l2_ms,
                    total_ms,
                    l2_err
                );
                Err(l2_err)
            }
        };

        self.cleanup_inflight_entry(trimmed, &video_lock).await;
        res
    }

    async fn cleanup_inflight_entry(&self, video_id: &str, lock_ref: &Arc<Mutex<()>>) {
        let mut inflight = self.inflight.lock().await;
        if let Some(existing) = inflight.get(video_id) {
            if Arc::ptr_eq(existing, lock_ref) && Arc::strong_count(existing) <= 2 {
                inflight.remove(video_id);
            }
        }
    }

    pub async fn insert_cached_stream(&self, video_id: &str, resolved: ResolvedYtStream) {
        let snapshot = {
            let mut cache = self.cache.lock().await;
            cache.insert(video_id.trim().to_string(), resolved);
            cache.clone()
        };
        save_persisted_stream_cache(&self.disk_cache_path, &snapshot);
    }

    pub async fn invalidate_stream(&self, video_id: &str) {
        let snapshot = {
            let mut cache = self.cache.lock().await;
            cache.remove(video_id.trim());
            cache.clone()
        };
        save_persisted_stream_cache(&self.disk_cache_path, &snapshot);
    }

    pub async fn invalidate_streams_matching_ip(
        &self,
        video_id: &str,
        stale_ip: Option<&str>,
    ) -> usize {
        let (removed_count, snapshot) = {
            let mut cache = self.cache.lock().await;
            let mut removed = 0usize;
            if cache.remove(video_id.trim()).is_some() {
                removed += 1;
            }
            if let Some(target_ip) = stale_ip.map(str::trim).filter(|s| !s.is_empty()) {
                let matching_keys: Vec<String> = cache
                    .iter()
                    .filter_map(|(k, v)| {
                        if v.ip_param.as_deref() == Some(target_ip) {
                            Some(k.clone())
                        } else {
                            None
                        }
                    })
                    .collect();
                for key in matching_keys {
                    if cache.remove(&key).is_some() {
                        removed += 1;
                    }
                }
            }
            (removed, cache.clone())
        };
        save_persisted_stream_cache(&self.disk_cache_path, &snapshot);
        println!(
            "[AudioProxy][Cache] Invalidated {} entry(ies) on 403 (video={} stale_ip={:?})",
            removed_count, video_id, stale_ip
        );
        removed_count
    }

    async fn resolve_via_ytdlp(
        &self,
        video_id: &str,
        priority: bool,
    ) -> Result<ResolvedYtStream, String> {
        let sem_start = Instant::now();
        let lane_sem = if priority {
            &self.priority_semaphore
        } else {
            &self.background_semaphore
        };
        let _lane_permit = lane_sem
            .acquire()
            .await
            .map_err(|_| "Семафор очереди yt-dlp закрыт".to_string())?;
        let _total_permit = self
            .total_semaphore
            .acquire()
            .await
            .map_err(|_| "Общий семафор yt-dlp закрыт".to_string())?;
        let sem_wait_ms = sem_start.elapsed().as_millis();

        let env_start = Instant::now();
        let (ytdlp_bin, env_path) = self.ensure_ytdlp_environment().await?;
        let env_ms = env_start.elapsed().as_millis();

        let watch_url = format!("https://www.youtube.com/watch?v={video_id}");
        let cache_dir_str = self.ytdlp_cache_dir.to_string_lossy().to_string();
        let cmd_start = Instant::now();

        let mut cmd = Command::new(&ytdlp_bin);
        cmd.args([
            "-g",
            "-f",
            "251/140/bestaudio[protocol=https]/bestaudio",
            "--extractor-args",
            "youtube:player_client=web_embedded",
            "--cache-dir",
            &cache_dir_str,
            "--no-playlist",
            "--no-warnings",
            &watch_url,
        ])
        .env("PATH", &env_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut output = tokio::time::timeout(Duration::from_secs(20), cmd.output())
            .await
            .map_err(|_| "Таймаут вызова yt-dlp (20 сек)".to_string())?
            .map_err(|e| format!("Не удалось запустить yt-dlp: {e}"))?;

        let mut cmd_ms = cmd_start.elapsed().as_millis();
        let mut level_label = "Level 2: yt-dlp -g (web_embedded + cache-dir)".to_string();

        // Последний уровень: если принудительный player_client=web_embedded не смог отдать поток,
        // пробуем стандартный yt-dlp по умолчанию без принудительных --extractor-args
        if !output.status.success() {
            let l3_start = Instant::now();
            let mut default_cmd = Command::new(&ytdlp_bin);
            default_cmd
                .args([
                    "-g",
                    "-f",
                    "251/140/bestaudio[protocol=https]/bestaudio",
                    "--cache-dir",
                    &cache_dir_str,
                    "--no-playlist",
                    "--no-warnings",
                    &watch_url,
                ])
                .env("PATH", &env_path)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());

            #[cfg(target_os = "windows")]
            default_cmd.creation_flags(CREATE_NO_WINDOW);

            if let Ok(Ok(default_out)) =
                tokio::time::timeout(Duration::from_secs(20), default_cmd.output()).await
            {
                cmd_ms += l3_start.elapsed().as_millis();
                output = default_out;
                level_label = "Level 3: yt-dlp -g (default without extractor-args)".to_string();
            }
        }

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "yt-dlp -g завершился с ошибкой ({cmd_ms} мс): {}",
                stderr.trim()
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let direct_url = stdout
            .lines()
            .map(str::trim)
            .find(|l| l.starts_with("http://") || l.starts_with("https://"))
            .ok_or_else(|| "В ответе yt-dlp -g отсутствует прямая ссылка на поток.".to_string())?
            .to_string();

        let extra_headers = HashMap::new();
        let user_agent =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                .to_string();

        let mime_param = extract_query_param_str(&direct_url, "mime").unwrap_or_default();
        let itag = extract_query_param_u64(&direct_url, "itag").unwrap_or(251);
        let mime_type = if mime_param.contains("mp4") || itag == 140 || itag == 139 {
            "audio/mp4".to_string()
        } else {
            "audio/webm".to_string()
        };

        let content_length = extract_query_param_u64(&direct_url, "clen");
        let expire_unix = extract_query_param_u64(&direct_url, "expire");
        let ip_param = extract_query_param_str(&direct_url, "ip");
        let now_unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let ttl = if let Some(exp) = expire_unix {
            if exp > now_unix + DISK_EXPIRE_SAFETY_MARGIN_SECS + 60 {
                Duration::from_secs(exp - now_unix - DISK_EXPIRE_SAFETY_MARGIN_SECS)
            } else {
                Duration::from_secs(300)
            }
        } else {
            STREAM_CACHE_TTL
        };

        println!(
            "[AudioProxy][Timing] video={} sub=ytdlp_g priority={} sem_wait_ms={} env_ms={} spawn_exec_ms={} itag={} clen={:?} expire={:?} ip={:?}",
            video_id, priority, sem_wait_ms, env_ms, cmd_ms, itag, content_length, expire_unix, ip_param
        );

        Ok(ResolvedYtStream {
            direct_url,
            user_agent,
            extra_headers,
            mime_type,
            content_length,
            expires_at: Instant::now() + ttl,
            expire_unix,
            ip_param,
            level_label,
        })
    }

    pub async fn fetch_playlist_tracks(&self, playlist_id: &str) -> Result<YtPlaylistResponse, String> {
        let start = Instant::now();
        let raw_id = playlist_id.trim();
        if raw_id.is_empty() {
            return Err("Не указан ID плейлиста YouTube Music.".to_string());
        }
        let clean_id = raw_id.strip_prefix("VL").unwrap_or(raw_id);
        let playlist_url = format!("https://music.youtube.com/playlist?list={clean_id}");

        let (ytdlp_bin, env_path) = self.ensure_ytdlp_environment().await?;
        let cache_dir_str = self.ytdlp_cache_dir.to_string_lossy().to_string();

        let mut cmd = Command::new(&ytdlp_bin);
        cmd.args([
            "--flat-playlist",
            "-J",
            "--cache-dir",
            &cache_dir_str,
            "--no-warnings",
            &playlist_url,
        ])
        .env("PATH", &env_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = tokio::time::timeout(Duration::from_secs(30), cmd.output())
            .await
            .map_err(|_| "Таймаут загрузки плейлиста через yt-dlp (30 сек)".to_string())?
            .map_err(|e| format!("Не удалось запустить yt-dlp для плейлиста: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        if !output.status.success() && stdout.trim().is_empty() {
            eprintln!(
                "[YtPlaylist] yt-dlp --flat-playlist -J failed for {clean_id} ({} ms). stderr: {}",
                start.elapsed().as_millis(),
                stderr.trim()
            );
            return Err(format!(
                "Не удалось загрузить плейлист YouTube Music: {}",
                stderr.trim()
            ));
        }

        let data: Value = serde_json::from_str(stdout.trim()).map_err(|e| {
            let preview: String = stdout.chars().take(600).collect();
            eprintln!(
                "[YtPlaylist] JSON parse error for {clean_id}: {e}. Raw stdout preview: {preview} | stderr: {}",
                stderr.trim()
            );
            format!("Ошибка разбора данных плейлиста YouTube Music: {e}")
        })?;

        let title = data
            .get("title")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Playlist")
            .to_string();

        let playlist_thumb = extract_best_thumbnail_url(data.get("thumbnails"));

        let mut tracks = Vec::new();
        let mut seen = std::collections::HashSet::new();

        if let Some(entries) = data.get("entries").and_then(|v| v.as_array()) {
            for entry in entries {
                if entry.is_null() {
                    continue;
                }
                let Some(vid) = entry
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|id| is_valid_video_id(id))
                else {
                    continue;
                };
                if !seen.insert(vid.to_string()) {
                    continue;
                }

                let raw_title = entry
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .unwrap_or_default();

                // Пропускаем скрытые/удаленные видео, не роняя весь плейлист
                if raw_title.is_empty()
                    || raw_title.eq_ignore_ascii_case("[Private video]")
                    || raw_title.eq_ignore_ascii_case("[Deleted video]")
                {
                    continue;
                }

                let raw_uploader = entry
                    .get("uploader")
                    .and_then(|v| v.as_str())
                    .or_else(|| entry.get("channel").and_then(|v| v.as_str()))
                    .or_else(|| entry.get("artist").and_then(|v| v.as_str()))
                    .map(str::trim)
                    .unwrap_or_default();

                let cleaned_artist = raw_uploader
                    .trim_end_matches(" - Topic")
                    .trim();
                let artist = if cleaned_artist.is_empty() {
                    "YouTube Music".to_string()
                } else {
                    cleaned_artist.to_string()
                };

                let duration_seconds = entry.get("duration").and_then(|v| v.as_f64());

                let artwork_url = extract_best_thumbnail_url(entry.get("thumbnails"))
                    .or_else(|| {
                        entry
                            .get("thumbnail")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_else(|| format!("https://i.ytimg.com/vi/{vid}/hqdefault.jpg"));

                tracks.push(YtPlaylistTrackItem {
                    video_id: vid.to_string(),
                    title: raw_title.to_string(),
                    artist: artist.clone(),
                    artists: vec![artist],
                    artwork_url: Some(artwork_url),
                    duration_seconds,
                    available: true,
                });
            }
        }

        if tracks.is_empty() {
            let raw_preview: String = stdout.chars().take(1000).collect();
            eprintln!(
                "[YtPlaylist] 0 tracks parsed for playlist {clean_id} ({} ms). Raw yt-dlp stdout: {} | stderr: {}",
                start.elapsed().as_millis(),
                raw_preview,
                stderr.trim()
            );
            return Err(format!(
                "Плейлист «{title}» не вернул доступных треков (возможно, он приватный или пуст)."
            ));
        }

        let artwork_url = playlist_thumb.or_else(|| {
            tracks
                .first()
                .and_then(|t| t.artwork_url.clone())
        });

        println!(
            "[YtPlaylist] Loaded playlist {clean_id} (\"{}\"): {} tracks in {} ms",
            title,
            tracks.len(),
            start.elapsed().as_millis()
        );

        Ok(YtPlaylistResponse {
            playlist_id: clean_id.to_string(),
            title,
            artwork_url,
            track_count: tracks.len(),
            tracks,
        })
    }

    async fn ensure_ytdlp_environment(&self) -> Result<(PathBuf, String), String> {
        let app_bin = app_data_bin_dir();
        let _ = std::fs::create_dir_all(&app_bin);

        let extra_dirs = collect_tool_directories(&app_bin);
        let current_path = std::env::var("PATH").unwrap_or_default();
        let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
        let mut path_parts: Vec<String> = extra_dirs
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        if !current_path.is_empty() {
            path_parts.push(current_path);
        }
        let combined_path = path_parts.join(sep);

        let ytdlp_name = if cfg!(target_os = "windows") {
            "yt-dlp.exe"
        } else {
            "yt-dlp"
        };

        if let Some(found) = find_executable_in_dirs(ytdlp_name, &extra_dirs) {
            return Ok((found, combined_path));
        }

        // Если yt-dlp не найден в системе, скачиваем с официального GitHub Releases с проверкой SHA-256
        let mut lock = self.bin_lock.lock().await;
        if let Some(found) = find_executable_in_dirs(ytdlp_name, &extra_dirs) {
            return Ok((found, combined_path));
        }

        let target_path = app_bin.join(ytdlp_name);
        download_and_verify_ytdlp(&self.http, &target_path).await?;
        *lock = true;

        Ok((target_path, combined_path))
    }

    pub async fn check_daily_ytdlp_update(&self) {
        let app_bin = app_data_bin_dir();
        let _ = std::fs::create_dir_all(&app_bin);
        let stamp_file = app_bin.join("ytdlp_last_update.txt");
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        if let Ok(raw) = std::fs::read_to_string(&stamp_file) {
            if let Ok(last_secs) = raw.trim().parse::<u64>() {
                if now_secs.saturating_sub(last_secs) < YTDLP_UPDATE_INTERVAL_SECS {
                    return;
                }
            }
        }

        let _ = std::fs::write(&stamp_file, now_secs.to_string());
        self.trigger_ytdlp_self_update().await;
    }

    pub async fn trigger_ytdlp_self_update(&self) {
        let Ok((ytdlp_bin, env_path)) = self.ensure_ytdlp_environment().await else {
            return;
        };
        tokio::spawn(async move {
            let mut cmd = Command::new(&ytdlp_bin);
            cmd.arg("-U")
                .env("PATH", &env_path)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = cmd.status().await;
        });
    }

    /// Фоновый прогрев кэша yt-dlp (`youtube-sigfuncs` и Deno JS-решателя) на старте приложения.
    /// Выполняется строго в низкоприоритетном `background_semaphore`, не блокируя пользовательские клики.
    pub async fn warmup_ytdlp_solver_cache(&self) {
        let sigfuncs_dir = self.ytdlp_cache_dir.join("youtube-sigfuncs");
        let has_cached_sigfuncs = std::fs::read_dir(&sigfuncs_dir)
            .ok()
            .and_then(|mut it| it.next())
            .is_some();

        let start = Instant::now();
        match self.resolve_via_ytdlp(YTDLP_WARMUP_VIDEO_ID, false).await {
            Ok(resolved) => {
                self.insert_cached_stream(YTDLP_WARMUP_VIDEO_ID, resolved).await;
                println!(
                    "[AudioProxy][Warmup] yt-dlp solver cache warmed up (had_sigfuncs={}) in {} ms",
                    has_cached_sigfuncs,
                    start.elapsed().as_millis()
                );
            }
            Err(err) => {
                eprintln!(
                    "[AudioProxy][Warmup] yt-dlp warmup skipped/failed ({} ms): {}",
                    start.elapsed().as_millis(),
                    err
                );
            }
        }
    }
}

fn app_data_root_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("Resonance");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".resonance");
    }
    std::env::temp_dir().join("Resonance")
}

fn app_data_bin_dir() -> PathBuf {
    app_data_root_dir().join("bin")
}

fn load_persisted_stream_cache(path: &Path) -> HashMap<String, ResolvedYtStream> {
    let mut map = HashMap::new();
    let Ok(raw) = std::fs::read_to_string(path) else {
        return map;
    };
    let Ok(entries) = serde_json::from_str::<Vec<PersistedYtStreamEntry>>(&raw) else {
        return map;
    };
    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for entry in entries {
        if !is_valid_video_id(&entry.video_id) {
            continue;
        }
        if let Some(resolved) = entry.to_resolved(now_unix) {
            map.insert(entry.video_id, resolved);
        }
    }
    if !map.is_empty() {
        println!(
            "[AudioProxy][Cache] Loaded {} valid stream URL(s) from disk cache ({})",
            map.len(),
            path.display()
        );
    }
    map
}

fn save_persisted_stream_cache(path: &Path, cache: &HashMap<String, ResolvedYtStream>) {
    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let entries: Vec<PersistedYtStreamEntry> = cache
        .iter()
        .filter(|(_, v)| !v.is_expired())
        .filter(|(_, v)| {
            v.expire_unix
                .map_or(true, |exp| now_unix + DISK_EXPIRE_SAFETY_MARGIN_SECS < exp)
        })
        .map(|(k, v)| PersistedYtStreamEntry::from_resolved(k, v))
        .collect();
    if let Ok(serialized) = serde_json::to_string(&entries) {
        let _ = std::fs::write(path, serialized);
    }
}

fn collect_tool_directories(app_bin: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    dirs.push(app_bin.to_path_buf());

    #[cfg(target_os = "windows")]
    {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let local_base = PathBuf::from(&local_app_data);
            let links = local_base.join("Microsoft").join("WinGet").join("Links");
            if links.exists() {
                dirs.push(links);
            }
            let packages = local_base.join("Microsoft").join("WinGet").join("Packages");
            if let Ok(entries) = std::fs::read_dir(&packages) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_lowercase();
                    if name.contains("yt-dlp") || name.contains("deno") || name.contains("ffmpeg") {
                        let pkg_path = entry.path();
                        dirs.push(pkg_path.clone());
                        if let Ok(sub_entries) = std::fs::read_dir(&pkg_path) {
                            for sub in sub_entries.flatten() {
                                if sub.path().is_dir() {
                                    dirs.push(sub.path());
                                }
                            }
                        }
                    }
                }
            }
        }
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let up = PathBuf::from(user_profile);
            let deno_bin = up.join(".deno").join("bin");
            if deno_bin.exists() {
                dirs.push(deno_bin);
            }
            let scoop = up.join("scoop").join("shims");
            if scoop.exists() {
                dirs.push(scoop);
            }
        }
    }

    if let Ok(path_var) = std::env::var("PATH") {
        let sep = if cfg!(target_os = "windows") { ';' } else { ':' };
        for part in path_var.split(sep) {
            let trimmed = part.trim();
            if !trimmed.is_empty() {
                dirs.push(PathBuf::from(trimmed));
            }
        }
    }

    dirs
}

fn find_executable_in_dirs(exe_name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    for dir in dirs {
        let candidate = dir.join(exe_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

async fn download_and_verify_ytdlp(http: &Client, target_path: &Path) -> Result<(), String> {
    let asset_name = if cfg!(target_os = "windows") {
        "yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "yt-dlp_macos"
    } else {
        "yt-dlp_linux"
    };

    let bin_url = format!(
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/{asset_name}"
    );
    let sums_url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA256SUMS";

    let sums_text = http
        .get(sums_url)
        .send()
        .await
        .map_err(|e| format!("Не удалось загрузить SHA256SUMS для yt-dlp: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Ошибка чтения SHA256SUMS: {e}"))?;

    let expected_hash = sums_text
        .lines()
        .find_map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            let file = parts.next()?;
            if file.trim_start_matches('*') == asset_name {
                Some(hash.to_lowercase())
            } else {
                None
            }
        })
        .ok_or_else(|| format!("Хэш SHA-256 для {asset_name} не найден в SHA256SUMS"))?;

    let bytes = http
        .get(&bin_url)
        .send()
        .await
        .map_err(|e| format!("Не удалось скачать {asset_name}: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("Ошибка чтения бинарника {asset_name}: {e}"))?;

    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let actual_hash = format!("{:x}", hasher.finalize());

    if actual_hash != expected_hash {
        return Err(format!(
            "Проверка SHA-256 для {asset_name} не пройдена (ожидался {expected_hash}, получен {actual_hash})"
        ));
    }

    tokio::fs::write(target_path, &bytes)
        .await
        .map_err(|e| format!("Не удалось сохранить {asset_name}: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(target_path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(target_path, perms);
        }
    }

    Ok(())
}

fn extract_query_param_u64(raw_url: &str, key: &str) -> Option<u64> {
    let full = if raw_url.starts_with('/') {
        format!("http://localhost{raw_url}")
    } else {
        raw_url.to_string()
    };
    let parsed = Url::parse(&full).ok()?;
    for (k, v) in parsed.query_pairs() {
        if k == key {
            if let Ok(num) = v.parse::<u64>() {
                return Some(num);
            }
        }
    }
    None
}

fn extract_query_param_str(raw_url: &str, key: &str) -> Option<String> {
    let full = if raw_url.starts_with('/') {
        format!("http://localhost{raw_url}")
    } else {
        raw_url.to_string()
    };
    let parsed = Url::parse(&full).ok()?;
    for (k, v) in parsed.query_pairs() {
        if k == key {
            return Some(v.to_string());
        }
    }
    None
}

fn extract_best_thumbnail_url(thumbs_val: Option<&Value>) -> Option<String> {
    let arr = thumbs_val?.as_array()?;
    let mut best_url: Option<String> = None;
    let mut best_score: i64 = -1;
    for item in arr {
        let Some(url) = item.get("url").and_then(|v| v.as_str()).map(str::trim) else {
            continue;
        };
        if url.is_empty() || (!url.starts_with("https://") && !url.starts_with("http://")) {
            continue;
        }
        let w = item.get("width").and_then(|v| v.as_i64()).unwrap_or(0);
        let h = item.get("height").and_then(|v| v.as_i64()).unwrap_or(0);
        let pref = item.get("preference").and_then(|v| v.as_i64()).unwrap_or(0);
        let score = w * h + pref * 1000;
        if score >= best_score {
            best_score = score;
            best_url = Some(url.to_string());
        }
    }
    best_url
}

fn is_valid_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

async fn resolve_youtubei_player_stream(
    http: &Client,
    video_id: &str,
) -> Result<ResolvedYtStream, String> {
    let mut last_error = String::new();

    for profile in client_profiles() {
        let payload = json!({
            "videoId": video_id,
            "context": {
                "client": profile.context_client
            },
            "contentCheckOk": true,
            "racyCheckOk": true
        });

        let response = http
            .post(PLAYER_ENDPOINT)
            .header("Content-Type", "application/json")
            .header("User-Agent", profile.user_agent)
            .header("X-Youtube-Client-Name", profile.client_id)
            .header("X-Youtube-Client-Version", profile.version)
            .json(&payload)
            .send()
            .await;

        let Ok(resp) = response else {
            last_error = format!("Сетевая ошибка при запросе клиента {}", profile.name);
            continue;
        };

        if !resp.status().is_success() {
            last_error = format!("Клиент {} вернул HTTP {}", profile.name, resp.status().as_u16());
            continue;
        }

        let Ok(data) = resp.json::<Value>().await else {
            continue;
        };

        let status = data
            .pointer("/playabilityStatus/status")
            .and_then(|v| v.as_str())
            .unwrap_or("UNKNOWN");

        if status != "OK" {
            let reason = data
                .pointer("/playabilityStatus/reason")
                .and_then(|v| v.as_str())
                .unwrap_or(status);
            last_error = format!("{}: {}", profile.name, reason);
            continue;
        }

        let Some(formats) = data
            .pointer("/streamingData/adaptiveFormats")
            .and_then(|v| v.as_array())
        else {
            continue;
        };

        let mut best_format: Option<(i64, String, String, Option<u64>)> = None;

        for fmt in formats {
            let Some(url) = fmt.get("url").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
                continue;
            };
            let mime_raw = fmt
                .get("mimeType")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if !mime_raw.starts_with("audio/") {
                continue;
            }
            let base_mime = mime_raw
                .split(';')
                .next()
                .unwrap_or("audio/mp4")
                .trim()
                .to_string();

            let itag = fmt.get("itag").and_then(|v| v.as_i64()).unwrap_or(0);
            let bitrate = fmt.get("bitrate").and_then(|v| v.as_i64()).unwrap_or(0);
            let itag_bonus = if itag == 251 || itag == 140 { 500_000 } else { 0 };
            let score = bitrate + itag_bonus;

            let content_length = fmt
                .get("contentLength")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u64>().ok())
                .or_else(|| extract_query_param_u64(url, "clen"));

            if best_format.as_ref().map_or(true, |(best_score, _, _, _)| score > *best_score) {
                best_format = Some((score, url.to_string(), base_mime, content_length));
            }
        }

        if let Some((_, direct_url, mime_type, content_length)) = best_format {
            let expire_unix = extract_query_param_u64(&direct_url, "expire");
            let ip_param = extract_query_param_str(&direct_url, "ip");
            return Ok(ResolvedYtStream {
                direct_url,
                user_agent: profile.user_agent.to_string(),
                extra_headers: HashMap::new(),
                mime_type,
                content_length,
                expires_at: Instant::now() + STREAM_CACHE_TTL,
                expire_unix,
                ip_param,
                level_label: format!("Level 1: {}", profile.name),
            });
        }
    }

    Err(if last_error.is_empty() {
        "Не удалось получить прямой аудиопоток YouTube ни через один клиент.".to_string()
    } else {
        format!("Не удалось получить аудиопоток YouTube ({last_error})")
    })
}

async fn handle_proxy_connection(mut socket: TcpStream, proxy: YtStreamProxy) -> Result<(), String> {
    let req_received_at = Instant::now();
    let mut buf = vec![0u8; 8192];
    let n = socket
        .read(&mut buf)
        .await
        .map_err(|e| format!("read error: {e}"))?;
    if n == 0 {
        return Ok(());
    }

    let req_text = String::from_utf8_lossy(&buf[..n]);
    let mut lines = req_text.lines();
    let request_line = lines.next().unwrap_or_default();
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        return Ok(());
    }

    let method = parts[0].to_uppercase();
    let raw_target = parts[1];

    if method == "OPTIONS" {
        let resp = "HTTP/1.1 204 No Content\r\n\
            Access-Control-Allow-Origin: *\r\n\
            Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
            Access-Control-Allow-Headers: Range, If-Range, Content-Type\r\n\
            Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, X-Proxy-Ttfb-Ms, X-Proxy-Resolve-Ms, X-Proxy-Cache-Hit\r\n\r\n";
        let _ = socket.write_all(resp.as_bytes()).await;
        return Ok(());
    }

    let mut range_header: Option<String> = None;
    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range_header = Some(v.trim().to_string());
            }
        }
    }

    let path = raw_target.split('?').next().unwrap_or(raw_target);
    let is_prefetch = raw_target.contains("prefetch=1");
    let req_id_param = extract_query_param_str(raw_target, "reqId").unwrap_or_else(|| "-".to_string());
    let click_ts_param = extract_query_param_u64(raw_target, "clickTs");
    let video_id = path.trim_start_matches("/yt-stream/").trim();

    if !is_valid_video_id(video_id) {
        let resp = "HTTP/1.1 400 Bad Request\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n";
        let _ = socket.write_all(resp.as_bytes()).await;
        return Ok(());
    }

    let resolve_start = Instant::now();
    let (mut resolved, mut cache_hit, mut resolve_ms, _) = match proxy.get_or_resolve_stream(video_id, false, !is_prefetch).await {
        Ok(res) => res,
        Err(_) => {
            let resp = "HTTP/1.1 502 Bad Gateway\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n";
            let _ = socket.write_all(resp.as_bytes()).await;
            return Ok(());
        }
    };
    let resolve_wall_ms = resolve_start.elapsed().as_millis();

    if is_prefetch {
        let resp = "HTTP/1.1 202 Accepted\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n";
        let _ = socket.write_all(resp.as_bytes()).await;
        return Ok(());
    }

    let upstream_start = Instant::now();
    let (stream_client, mut ip_family) = proxy.select_stream_client(&resolved);
    let mut upstream_resp =
        send_upstream_request(stream_client, &resolved, range_header.as_deref()).await;

    // Прозрачный фоллбэк внутри ОДНОГО запроса к прокси при 403/401 от кэшированной или устаревшей ссылки
    // (включая смену внешнего IPv4/IPv6 адреса: сбрасываем все записи кэша со старым ip= и перерезолвим один раз):
    if upstream_resp
        .as_ref()
        .map_or(true, |r| r.status().as_u16() == 403 || r.status().as_u16() == 401)
    {
        let stale_ip = resolved.ip_param.clone();
        eprintln!(
            "[AudioProxy] Upstream returned 403/expired for {video_id} (level=\"{}\" family={} stale_ip={:?}), invalidating stale IP entries and re-resolving once via yt-dlp...",
            resolved.level_label,
            ip_family,
            stale_ip
        );
        proxy
            .invalidate_streams_matching_ip(video_id, stale_ip.as_deref())
            .await;
        {
            let mut c403 = proxy.consecutive_403.lock().await;
            *c403 += 1;
            if *c403 >= 3 {
                *c403 = 0;
                proxy.trigger_ytdlp_self_update().await;
            }
        }
        let refresh_start = Instant::now();
        if let Ok(fresh) = proxy.resolve_via_ytdlp(video_id, true).await {
            let fresh_ms = refresh_start.elapsed().as_millis() as u64;
            proxy.insert_cached_stream(video_id, fresh.clone()).await;
            resolved = fresh;
            cache_hit = false;
            resolve_ms += fresh_ms;
            let (fresh_client, fresh_family) = proxy.select_stream_client(&resolved);
            ip_family = fresh_family;
            upstream_resp =
                send_upstream_request(fresh_client, &resolved, range_header.as_deref()).await;
        }
    } else {
        let mut c403 = proxy.consecutive_403.lock().await;
        *c403 = 0;
    }

    let Ok(mut resp) = upstream_resp else {
        let err_resp = "HTTP/1.1 502 Bad Gateway\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n";
        let _ = socket.write_all(err_resp.as_bytes()).await;
        return Ok(());
    };

    let upstream_headers_ms = upstream_start.elapsed().as_millis();
    let status_code = resp.status().as_u16();
    let reason = resp.status().canonical_reason().unwrap_or("OK");

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or(&resolved.mime_type)
        .to_string();

    let content_length = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let content_range = resp
        .headers()
        .get("content-range")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // Для GET-запросов ждём первый байт (первый чанк) от CDN, чтобы точно измерить TTFB прокси
    let first_chunk = if method != "HEAD" {
        match resp.chunk().await {
            Ok(Some(chunk)) => Some(chunk),
            Ok(None) => None,
            Err(_) => None,
        }
    } else {
        None
    };

    let proxy_ttfb_ms = req_received_at.elapsed().as_millis();
    let since_click_ms = click_ts_param.and_then(|ts| {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        now_ms.checked_sub(ts)
    });

    println!(
        "[AudioProxy][TTFB] reqId={} video={} method={} range={:?} status={} family={} url_ip={:?} level=\"{}\" cache_hit={} resolve_ms={} upstream_hdr_ms={} proxy_ttfb_ms={} since_click_ms={:?}",
        req_id_param,
        video_id,
        method,
        range_header.as_deref().unwrap_or("none"),
        status_code,
        ip_family,
        resolved.ip_param,
        resolved.level_label,
        cache_hit,
        resolve_wall_ms,
        upstream_headers_ms,
        proxy_ttfb_ms,
        since_click_ms
    );

    let mut header_block = format!(
        "HTTP/1.1 {status_code} {reason}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, X-Proxy-Ttfb-Ms, X-Proxy-Resolve-Ms, X-Proxy-Cache-Hit\r\n\
         Accept-Ranges: bytes\r\n\
         Cache-Control: private, no-store\r\n\
         X-Proxy-Ttfb-Ms: {proxy_ttfb_ms}\r\n\
         X-Proxy-Resolve-Ms: {resolve_ms}\r\n\
         X-Proxy-Cache-Hit: {cache_hit}\r\n\
         Content-Type: {content_type}\r\n"
    );

    if let Some(cl) = content_length {
        header_block.push_str(&format!("Content-Length: {cl}\r\n"));
    } else if status_code == 200 {
        if let Some(total) = resolved.content_length {
            header_block.push_str(&format!("Content-Length: {total}\r\n"));
        }
    }

    if let Some(cr) = content_range {
        header_block.push_str(&format!("Content-Range: {cr}\r\n"));
    }

    header_block.push_str("Connection: close\r\n\r\n");

    if socket.write_all(header_block.as_bytes()).await.is_err() {
        return Ok(());
    }

    if method == "HEAD" {
        return Ok(());
    }

    if let Some(first) = first_chunk {
        if socket.write_all(&first).await.is_err() {
            return Ok(());
        }
    }

    while let Ok(Some(chunk)) = resp.chunk().await {
        if socket.write_all(&chunk).await.is_err() {
            break;
        }
    }

    Ok(())
}

async fn send_upstream_request(
    http: &Client,
    resolved: &ResolvedYtStream,
    range_header: Option<&str>,
) -> Result<reqwest::Response, reqwest::Error> {
    let mut req = http
        .get(&resolved.direct_url)
        .header("User-Agent", &resolved.user_agent)
        .header("Accept", "*/*");

    for (k, v) in &resolved.extra_headers {
        if !k.eq_ignore_ascii_case("range") && !k.eq_ignore_ascii_case("user-agent") {
            req = req.header(k.as_str(), v.as_str());
        }
    }

    if let Some(range) = range_header {
        req = req.header("Range", range);
    }

    req.send().await
}

/// Поиск треков напрямую через YouTube Music InnerTube (`WEB_REMIX`) без внешних утилит.
pub async fn search_youtube_tracks(
    http: &Client,
    query: &str,
) -> Result<Vec<YtSearchTrack>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let payload = json!({
        "query": trimmed,
        "params": "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D", // Фильтр "Songs" в YouTube Music
        "context": {
            "client": {
                "clientName": "WEB_REMIX",
                "clientVersion": "1.20250101.01.00",
                "hl": "en",
                "gl": "US"
            }
        }
    });

    let resp = http
        .post(SEARCH_ENDPOINT)
        .header("Content-Type", "application/json")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        )
        .header("Origin", "https://music.youtube.com")
        .header("Referer", "https://music.youtube.com/")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Ошибка поиска YouTube Music: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("YouTube Music Search вернул HTTP {}", resp.status().as_u16()));
    }

    let data: Value = resp
        .json()
        .await
        .map_err(|e| format!("Ошибка разбора ответа поиска YouTube Music: {e}"))?;

    let mut renderers = Vec::new();
    collect_renderers_recursive(&data, &mut renderers);

    let mut tracks = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for renderer in renderers {
        if let Some(track) = parse_music_responsive_item(renderer) {
            if seen.insert(track.native_id.clone()) {
                tracks.push(track);
                if tracks.len() >= 10 {
                    break;
                }
            }
        }
    }

    Ok(tracks)
}

fn collect_renderers_recursive<'a>(node: &'a Value, out: &mut Vec<&'a Value>) {
    match node {
        Value::Object(map) => {
            if let Some(r) = map.get("musicResponsiveListItemRenderer") {
                out.push(r);
            }
            for v in map.values() {
                collect_renderers_recursive(v, out);
            }
        }
        Value::Array(arr) => {
            for v in arr {
                collect_renderers_recursive(v, out);
            }
        }
        _ => {}
    }
}

fn parse_music_responsive_item(renderer: &Value) -> Option<YtSearchTrack> {
    let video_id = renderer
        .pointer("/playlistItemData/videoId")
        .and_then(|v| v.as_str())
        .or_else(|| {
            renderer
                .pointer("/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint/videoId")
                .and_then(|v| v.as_str())
        })
        .filter(|id| is_valid_video_id(id))?
        .to_string();

    let flex_columns = renderer.get("flexColumns")?.as_array()?;
    let title = flex_columns
        .first()
        .and_then(|col| {
            col.pointer("/musicResponsiveListItemFlexColumnRenderer/text/runs")
                .and_then(|runs| runs.as_array())
                .and_then(|arr| arr.first())
                .and_then(|r| r.get("text"))
                .and_then(|t| t.as_str())
        })
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;

    let mut artist = String::new();
    let mut duration_ms: i64 = 0;

    if let Some(second_col) = flex_columns.get(1) {
        if let Some(runs) = second_col
            .pointer("/musicResponsiveListItemFlexColumnRenderer/text/runs")
            .and_then(|v| v.as_array())
        {
            let mut artist_parts = Vec::new();
            for run in runs {
                let Some(text) = run.get("text").and_then(|t| t.as_str()) else {
                    continue;
                };
                let trimmed = text.trim();
                if trimmed.is_empty() || trimmed == "•" || trimmed == "-" || trimmed == "&" {
                    continue;
                }
                if let Some(dur) = parse_duration_ms(trimmed) {
                    duration_ms = dur;
                    continue;
                }
                let page_type = run
                    .pointer("/navigationEndpoint/browseEndpoint/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();

                if page_type.contains("ARTIST") || artist_parts.is_empty() {
                    if !trimmed.eq_ignore_ascii_case("Song")
                        && !trimmed.eq_ignore_ascii_case("Video")
                        && !trimmed.eq_ignore_ascii_case("Трек")
                    {
                        artist_parts.push(trimmed.to_string());
                    }
                }
            }
            if !artist_parts.is_empty() {
                artist = artist_parts.join(", ");
            }
        }
    }

    if duration_ms == 0 {
        if let Some(fixed_cols) = renderer.get("fixedColumns").and_then(|v| v.as_array()) {
            for col in fixed_cols {
                if let Some(text) = extract_runs_text(
                    col.pointer("/musicResponsiveListItemFixedColumnRenderer/text/runs"),
                ) {
                    if let Some(dur) = parse_duration_ms(&text) {
                        duration_ms = dur;
                        break;
                    }
                }
            }
        }
    }

    if artist.is_empty() {
        artist = "YouTube Music".to_string();
    }

    let artwork_url = renderer
        .pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.last())
        .and_then(|t| t.get("url"))
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"));

    Some(YtSearchTrack {
        native_id: video_id.clone(),
        source: "youtube".to_string(),
        urn: format!("youtube:track:{video_id}"),
        title,
        permalink: format!("https://music.youtube.com/watch?v={video_id}"),
        artwork_url,
        duration_ms,
        artist,
    })
}

fn extract_runs_text(runs_val: Option<&Value>) -> Option<String> {
    let arr = runs_val?.as_array()?;
    let joined: String = arr
        .iter()
        .filter_map(|r| r.get("text").and_then(|t| t.as_str()))
        .collect();
    let trimmed = joined.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn parse_duration_ms(text: &str) -> Option<i64> {
    let trimmed = text.trim();
    if !trimmed.contains(':') {
        return None;
    }
    let parts: Vec<&str> = trimmed.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let mut total_secs: i64 = 0;
    for part in parts {
        let num = part.parse::<i64>().ok()?;
        total_secs = total_secs * 60 + num;
    }
    Some(total_secs * 1000)
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
    // Предварительно резолвим и кэшируем поток через Level 1 (VISIONOS) -> Level 2 (yt-dlp web_embedded + cache-dir)
    let (_, cache_hit, resolve_ms, attempts) = state
        .get_or_resolve_stream(&video_id, false, is_priority)
        .await?;
    let trimmed = video_id.trim();
    let mut query_parts = Vec::new();
    if let Some(req_id) = request_id {
        query_parts.push(format!("reqId={req_id}"));
    }
    if let Some(click_ts) = click_ts_ms {
        query_parts.push(format!("clickTs={click_ts}"));
    }
    let query_suffix = if query_parts.is_empty() {
        String::new()
    } else {
        format!("?{}", query_parts.join("&"))
    };
    let url = Url::parse(&format!(
        "http://127.0.0.1:{port}/yt-stream/{trimmed}{query_suffix}"
    ))
    .map_err(|e| format!("Ошибка формирования прокси URL: {e}"))?;
    Ok(YtProxyStreamResponse {
        url: url.to_string(),
        cache_hit,
        resolve_ms,
        attempts,
    })
}

#[tauri::command]
pub async fn search_yt_tracks(
    state: tauri::State<'_, YtStreamProxy>,
    query: String,
) -> Result<Vec<YtSearchTrack>, String> {
    search_youtube_tracks(&state.http, &query).await
}

#[tauri::command]
pub async fn fetch_yt_playlist_tracks(
    state: tauri::State<'_, YtStreamProxy>,
    playlist_id: String,
) -> Result<YtPlaylistResponse, String> {
    state.fetch_playlist_tracks(&playlist_id).await
}

