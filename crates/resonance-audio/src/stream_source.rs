use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{
    Arc, Condvar, Mutex,
    atomic::{AtomicBool, Ordering},
};

use anyhow::{Context, Result, anyhow};
use m3u8_rs::Playlist;
use symphonia::core::io::MediaSource;
use url::Url;

struct SharedInner {
    data: Vec<u8>,
    eof: bool,
    error: Option<String>,
    expected_len: Option<u64>,
}

#[derive(Clone)]
pub struct SharedStreamBuffer {
    inner: Arc<(Mutex<SharedInner>, Condvar)>,
    cancelled: Arc<AtomicBool>,
}

impl SharedStreamBuffer {
    pub fn new(expected_len: Option<u64>, cancelled: Arc<AtomicBool>) -> Self {
        Self {
            inner: Arc::new((
                Mutex::new(SharedInner {
                    data: Vec::new(),
                    eof: false,
                    error: None,
                    expected_len,
                }),
                Condvar::new(),
            )),
            cancelled,
        }
    }

    pub fn push(&self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        let (lock, cv) = &*self.inner;
        if let Ok(mut guard) = lock.lock() {
            guard.data.extend_from_slice(chunk);
            cv.notify_all();
        }
    }

    pub fn finish(&self) {
        let (lock, cv) = &*self.inner;
        if let Ok(mut guard) = lock.lock() {
            guard.eof = true;
            if guard.expected_len.is_none() {
                guard.expected_len = Some(guard.data.len() as u64);
            }
            cv.notify_all();
        }
    }

    pub fn fail(&self, err: impl Into<String>) {
        let (lock, cv) = &*self.inner;
        if let Ok(mut guard) = lock.lock() {
            guard.error = Some(err.into());
            guard.eof = true;
            cv.notify_all();
        }
    }

    pub fn set_expected_len(&self, len: Option<u64>) {
        let (lock, _) = &*self.inner;
        if let Ok(mut guard) = lock.lock()
            && len.is_some() {
                guard.expected_len = len;
            }
    }

    pub fn wait_for_initial(&self, min_bytes: usize) -> Result<()> {
        let (lock, cv) = &*self.inner;
        let mut guard = lock.lock().map_err(|_| anyhow!("stream lock poisoned"))?;
        while guard.data.len() < min_bytes && !guard.eof && !self.cancelled.load(Ordering::Relaxed) {
            guard = cv.wait(guard).map_err(|_| anyhow!("stream wait failed"))?;
        }
        if let Some(ref e) = guard.error
            && guard.data.is_empty() {
                return Err(anyhow!("{e}"));
            }
        Ok(())
    }

    pub fn reader(&self) -> ProgressiveReader {
        ProgressiveReader {
            buf: self.clone(),
            pos: 0,
        }
    }
}

pub struct ProgressiveReader {
    buf: SharedStreamBuffer,
    pos: u64,
}

impl Read for ProgressiveReader {
    fn read(&mut self, dst: &mut [u8]) -> io::Result<usize> {
        if dst.is_empty() {
            return Ok(0);
        }
        let (lock, cv) = &*self.buf.inner;
        let mut guard = lock
            .lock()
            .map_err(|_| io::Error::other("stream lock poisoned"))?;
        loop {
            if self.buf.cancelled.load(Ordering::Relaxed) {
                return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
            }
            let pos = self.pos as usize;
            if pos < guard.data.len() {
                let n = dst.len().min(guard.data.len() - pos);
                dst[..n].copy_from_slice(&guard.data[pos..pos + n]);
                self.pos += n as u64;
                return Ok(n);
            }
            if let Some(ref err) = guard.error {
                return Err(io::Error::other(err.clone()));
            }
            if guard.eof {
                return Ok(0);
            }
            guard = cv
                .wait(guard)
                .map_err(|_| io::Error::other("stream condvar poisoned"))?;
        }
    }
}

impl Seek for ProgressiveReader {
    fn seek(&mut self, style: SeekFrom) -> io::Result<u64> {
        let (lock, cv) = &*self.buf.inner;
        let mut guard = lock
            .lock()
            .map_err(|_| io::Error::other("stream lock poisoned"))?;

        let target: i64 = match style {
            SeekFrom::Start(offset) => offset as i64,
            SeekFrom::Current(delta) => self.pos as i64 + delta,
            SeekFrom::End(delta) => {
                while !guard.eof && guard.expected_len.is_none() && !self.buf.cancelled.load(Ordering::Relaxed) {
                    guard = cv
                        .wait(guard)
                        .map_err(|_| io::Error::other("stream condvar poisoned"))?;
                }
                let base = guard.expected_len.unwrap_or(guard.data.len() as u64) as i64;
                base + delta
            }
        };

        if target < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "negative seek position"));
        }
        let target_u = target as u64;
        while (target_u as usize) > guard.data.len()
            && !guard.eof
            && !self.buf.cancelled.load(Ordering::Relaxed)
        {
            guard = cv
                .wait(guard)
                .map_err(|_| io::Error::other("stream condvar poisoned"))?;
        }
        self.pos = target_u;
        Ok(self.pos)
    }
}

impl MediaSource for ProgressiveReader {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        let (lock, _) = &*self.buf.inner;
        let guard = lock.lock().ok()?;
        guard
            .expected_len
            .or_else(|| guard.eof.then_some(guard.data.len() as u64))
    }
}

pub fn hint_ext_for_source(src: &str) -> Option<&'static str> {
    let lower = src.to_ascii_lowercase();
    if lower.contains("mime=audio/webm") || lower.ends_with(".webm") {
        Some("webm")
    } else if lower.contains("mime=audio/mp4") || lower.ends_with(".m4a") || lower.ends_with(".mp4") || lower.contains(".m3u8") {
        Some("m4a")
    } else if lower.ends_with(".mp3") || lower.contains("/mp3") {
        Some("mp3")
    } else if lower.ends_with(".ogg") || lower.ends_with(".opus") {
        Some("ogg")
    } else if lower.ends_with(".wav") {
        Some("wav")
    } else if lower.ends_with(".flac") {
        Some("flac")
    } else {
        None
    }
}

pub fn open_media_source(
    rt: &tokio::runtime::Handle,
    http: &reqwest::Client,
    src: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<(Box<dyn MediaSource>, Option<String>)> {
    if let Some(path_str) = src.strip_prefix("file://") {
        let path = Path::new(path_str);
        let ext = path.extension().and_then(|e| e.to_str()).map(str::to_string);
        let file = std::fs::File::open(path).with_context(|| format!("open local file {}", path.display()))?;
        return Ok((Box::new(file), ext));
    }
    if Path::new(src).exists() {
        let path = Path::new(src);
        let ext = path.extension().and_then(|e| e.to_str()).map(str::to_string);
        let file = std::fs::File::open(path).with_context(|| format!("open local file {}", path.display()))?;
        return Ok((Box::new(file), ext));
    }

    let url = Url::parse(src).with_context(|| format!("invalid audio url: {src}"))?;
    let is_hls = url.path().to_ascii_lowercase().ends_with(".m3u8");
    let buf = SharedStreamBuffer::new(None, cancelled.clone());
    let reader_buf = buf.clone();
    let http_cloned = http.clone();
    let url_str = url.to_string();

    let (tx_ext, rx_ext) = std::sync::mpsc::channel::<Option<String>>();

    rt.spawn(async move {
        if is_hls {
            let ext_hint = Some("m4a".to_string());
            let _ = tx_ext.send(ext_hint);
            if let Err(e) = stream_hls(&http_cloned, &url, &buf, &cancelled).await {
                buf.fail(format!("HLS stream failed: {e}"));
            }
            return;
        }

        let mut resp = match http_cloned.get(&url_str).send().await {
            Ok(r) => r,
            Err(e) => {
                let _ = tx_ext.send(None);
                buf.fail(format!("HTTP request failed: {e}"));
                return;
            }
        };
        if !resp.status().is_success() {
            let status = resp.status();
            let _ = tx_ext.send(None);
            buf.fail(format!("HTTP status {status}"));
            return;
        }

        let ct = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();

        if ct.contains("mpegurl") {
            let _ = tx_ext.send(Some("m4a".to_string()));
            match resp.text().await {
                Ok(text) => {
                    if let Err(e) = stream_hls_playlist_text(&http_cloned, &url, &text, &buf, &cancelled).await {
                        buf.fail(format!("HLS playlist failed: {e}"));
                    }
                }
                Err(e) => buf.fail(format!("HLS text failed: {e}")),
            }
            return;
        }

        let ext = if ct.contains("webm") {
            Some("webm".to_string())
        } else if ct.contains("mp4") || ct.contains("aac") {
            Some("m4a".to_string())
        } else if ct.contains("mpeg") || ct.contains("mp3") {
            Some("mp3".to_string())
        } else if ct.contains("ogg") {
            Some("ogg".to_string())
        } else if ct.contains("wav") {
            Some("wav".to_string())
        } else {
            hint_ext_for_source(&url_str).map(str::to_string)
        };
        let _ = tx_ext.send(ext);

        buf.set_expected_len(resp.content_length());
        loop {
            if cancelled.load(Ordering::Relaxed) {
                return;
            }
            match resp.chunk().await {
                Ok(Some(bytes)) => buf.push(&bytes),
                Ok(None) => break,
                Err(e) => {
                    buf.fail(format!("stream read error: {e}"));
                    return;
                }
            }
        }
        buf.finish();
    });

    reader_buf.wait_for_initial(24 * 1024)?;
    let ext = rx_ext
        .try_recv()
        .ok()
        .flatten()
        .or_else(|| hint_ext_for_source(src).map(str::to_string));
    Ok((Box::new(reader_buf.reader()), ext))
}

async fn stream_hls(
    http: &reqwest::Client,
    url: &Url,
    buf: &SharedStreamBuffer,
    cancelled: &AtomicBool,
) -> Result<()> {
    let text = http.get(url.as_str()).send().await?.error_for_status()?.text().await?;
    stream_hls_playlist_text(http, url, &text, buf, cancelled).await
}

async fn stream_hls_playlist_text(
    http: &reqwest::Client,
    base_url: &Url,
    text: &str,
    buf: &SharedStreamBuffer,
    cancelled: &AtomicBool,
) -> Result<()> {
    let parsed = m3u8_rs::parse_playlist_res(text.as_bytes())
        .map_err(|e| anyhow!("invalid m3u8 playlist: {e:?}"))?;

    let (media_url, media) = match parsed {
        Playlist::MasterPlaylist(master) => {
            let best = master
                .variants
                .iter()
                .max_by_key(|v| v.bandwidth)
                .ok_or_else(|| anyhow!("empty master playlist"))?;
            let sub_url = base_url.join(&best.uri)?;
            let sub_text = http.get(sub_url.as_str()).send().await?.error_for_status()?.text().await?;
            let sub = m3u8_rs::parse_media_playlist_res(sub_text.as_bytes())
                .map_err(|e| anyhow!("invalid media playlist: {e:?}"))?;
            (sub_url, sub)
        }
        Playlist::MediaPlaylist(media) => (base_url.clone(), media),
    };

    let mut fetched_init_uri: Option<String> = None;
    for seg in &media.segments {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(());
        }
        if let Some(ref map) = seg.map
            && fetched_init_uri.as_deref() != Some(map.uri.as_str()) {
                let init_url = media_url.join(&map.uri)?;
                let mut req = http.get(init_url.as_str());
                if let Some(ref range) = map.byte_range {
                    let offset = range.offset.unwrap_or(0);
                    let end = offset + range.length.saturating_sub(1);
                    req = req.header(reqwest::header::RANGE, format!("bytes={offset}-{end}"));
                }
                let bytes = req.send().await?.error_for_status()?.bytes().await?;
                buf.push(&bytes);
                fetched_init_uri = Some(map.uri.clone());
            }

        let seg_url = media_url.join(&seg.uri)?;
        let mut req = http.get(seg_url.as_str());
        if let Some(ref range) = seg.byte_range
            && let Some(offset) = range.offset {
                let end = offset + range.length.saturating_sub(1);
                req = req.header(reqwest::header::RANGE, format!("bytes={offset}-{end}"));
            }
        let bytes = req.send().await?.error_for_status()?.bytes().await?;
        buf.push(&bytes);
    }

    buf.finish();
    Ok(())
}
