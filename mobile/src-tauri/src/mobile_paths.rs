use std::path::PathBuf;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

const DEFAULT_MOBILE_CACHE_BYTES: u64 = 512 * 1024 * 1024; // 512 MiB

struct MobilePaths {
    data_dir: PathBuf,
    cache_dir: PathBuf,
}

static PATHS: OnceLock<MobilePaths> = OnceLock::new();
static CACHE_LIMIT_BYTES: AtomicU64 = AtomicU64::new(DEFAULT_MOBILE_CACHE_BYTES);

pub fn init(data_dir: PathBuf, cache_dir: PathBuf) {
    let _ = std::fs::create_dir_all(&data_dir);
    let _ = std::fs::create_dir_all(&cache_dir);
    if let Ok(raw) = std::fs::read_to_string(data_dir.join("mobile_cache_limit.txt")) {
        if let Ok(parsed) = raw.trim().parse::<u64>() {
            CACHE_LIMIT_BYTES.store(parsed, Ordering::Relaxed);
        }
    }
    let _ = PATHS.set(MobilePaths { data_dir, cache_dir });
}

pub fn data_dir() -> PathBuf {
    if let Some(p) = PATHS.get() {
        return p.data_dir.clone();
    }
    if let Ok(dir) = std::env::var("BSC_DATA_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home).join(".resonance-mobile-data");
        }
    }
    std::env::temp_dir().join("resonance-mobile-data")
}

pub fn cache_dir() -> PathBuf {
    if let Some(p) = PATHS.get() {
        return p.cache_dir.clone();
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home).join(".resonance-mobile-cache");
        }
    }
    std::env::temp_dir().join("resonance-mobile-cache")
}

pub fn cache_limit_bytes() -> u64 {
    CACHE_LIMIT_BYTES.load(Ordering::Relaxed)
}

pub fn set_cache_limit_bytes(bytes: u64) {
    let clamped = bytes.min(4 * 1024 * 1024 * 1024); // up to 4 GiB or 0 to disable disk caching
    CACHE_LIMIT_BYTES.store(clamped, Ordering::Relaxed);
    let path = data_dir().join("mobile_cache_limit.txt");
    let _ = std::fs::write(path, clamped.to_string());
}
