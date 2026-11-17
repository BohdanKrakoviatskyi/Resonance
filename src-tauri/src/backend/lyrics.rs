//! `track.lyrics`: finds a canonical catalogue record on Deezer, then looks the text up on LRCLIB
//! (with a title/artist variant fallback). Port of the Go sidecar's `lyrics.go`, including the
//! scoring thresholds — those were tuned against real reuploads, so they are kept verbatim.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use super::util::{BErr, BResult, is_empty_str, is_false};
use super::Backend;

const LYRICS_USER_AGENT: &str = "Resonance/0.1.0 (lyrics sidebar)";
/// Caps the in-memory lyrics cache.
const MAX_LYRICS_CACHE_ENTRIES: usize = 200;
/// A miss is cached for five minutes only: it used to be permanent, so a track whose text was
/// missing (or whose first lookup failed) stayed empty for the whole session.
const MISS_TTL: Duration = Duration::from_secs(5 * 60);

/// Title and artist that are the same words make a useless search (`track_name=BATO&artist_name=BATO`).
/// 0.75 is shared by both query builders: at 0.6 the pair ("BATO - Miura", "Miura") scores 0.65 and a
/// legitimate query would be lost without preventing the defect this guards against.
const DEGENERATE_OVERLAP: f64 = 0.75;

// ---- wire types -------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackLyricsParams {
    #[serde(default)]
    pub track_id: i64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub duration_ms: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsLine {
    pub id: String,
    pub text: String,
    pub start_ms: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackLyrics {
    pub track_id: i64,
    pub lines: Vec<LyricsLine>,
    #[serde(skip_serializing_if = "is_empty_str")]
    pub source_url: String,
    #[serde(skip_serializing_if = "is_false")]
    pub is_synced: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub logs: Vec<String>,
}

fn null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LrclibRecord {
    #[serde(default, deserialize_with = "null_default")]
    pub track_name: String,
    #[serde(default, deserialize_with = "null_default")]
    pub artist_name: String,
    #[serde(default, deserialize_with = "null_default")]
    pub duration: f64,
    #[serde(default, deserialize_with = "null_default")]
    pub synced_lyrics: String,
    #[serde(default, deserialize_with = "null_default")]
    pub plain_lyrics: String,
    #[serde(default, deserialize_with = "null_default")]
    pub instrumental: bool,
}

#[derive(Debug, Clone, Default)]
pub struct DeezerTrack {
    pub title: String,
    pub duration: i64,
    pub artist: String,
}

#[derive(Debug, Clone, Default)]
pub struct LyricsQuery {
    pub title: String,
    pub artist: String,
    pub duration: i64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct CandidateScore {
    pub rank: f64,
    pub artist: f64,
}

#[derive(Debug, Clone)]
pub struct CachedLyrics {
    lyrics: TrackLyrics,
    cached_at: Instant,
}

// ---- text normalisation -----------------------------------------------------------------------
// Go's RE2 `\s`, `\S` and `\b` are ASCII-only; they are spelled out here because the `regex` crate
// is Unicode-aware by default, and the matching behaviour must stay the same.

const WS: &str = r"[\t\n\x0C\r ]";
const NOT_WS: &str = r"[^\t\n\x0C\r ]";

fn noise_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"\[[^\]]*\]".to_string(),
            r"\([^)]*\)".to_string(),
            format!(r"#{NOT_WS}+"),
            format!(r"\+{NOT_WS}+"),
            format!(r"https?://{NOT_WS}+"),
            format!(r"(?i)(?-u:\b)(?:prod|tgk|tg|vk|inst|sc|by)\.?{WS}*[:.]?{WS}*[\p{{L}}\p{{N}}_.@/-]+"),
            format!(r"(?i)(?-u:\b)(?:ft|feat|featuring|with)\.?{WS}+[\p{{L}}\p{{N}}&,'’. -]+"),
        ]
        .iter()
        .map(|p| Regex::new(p).expect("noise pattern"))
        .collect()
    })
}

const VERSION_WORDS: &[&str] = &[
    "slowed", "sped up", "speed up", "reverb", "bass boosted", "remix", "edit", "flip", "mashup", "slow version", "rework", "re-work", "bootleg", "vip",
    "nightcore", "8d", "reversed", "acapella", "capella", "spedup", "slowedit", "alt ver", "alt version",
];

fn version_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        VERSION_WORDS
            .iter()
            .map(|word| Regex::new(&format!(r"(?i)(?-u:\b){}(?-u:\b)", regex::escape(word.trim_end_matches('.')))).expect("version pattern"))
            .collect()
    })
}

fn dash_parts() -> &'static Regex {
    static DASH: OnceLock<Regex> = OnceLock::new();
    DASH.get_or_init(|| Regex::new(&format!(r"{WS}+[-–—]{WS}+")).expect("dash pattern"))
}

fn fields_joined(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn trim_edges(value: &str) -> String {
    value.trim_matches(|c| " .-_–—".contains(c)).to_string()
}

pub fn strip_lyrics_noise(value: &str) -> String {
    let mut text = value.to_string();
    for pattern in noise_patterns() {
        text = pattern.replace_all(&text, " ").into_owned();
    }
    trim_edges(&fields_joined(&text))
}

pub fn strip_version_markers(value: &str) -> String {
    let mut text = value.to_string();
    for pattern in version_patterns() {
        text = pattern.replace_all(&text, " ").into_owned();
    }
    trim_edges(&fields_joined(&text))
}

fn normalize_punctuation(value: &str) -> String {
    let mut out = String::new();
    let mut space = true;
    for ch in value.to_lowercase().chars() {
        if ch.is_alphabetic() || ch.is_numeric() {
            out.push(ch);
            space = false;
        } else if !space {
            out.push(' ');
            space = true;
        }
    }
    out.trim().to_string()
}

pub fn has_version_marker(value: &str) -> bool {
    let normalized = format!(" {} ", normalize_punctuation(value));
    VERSION_WORDS.iter().any(|word| normalized.contains(&format!(" {} ", normalize_punctuation(word))))
}

fn token_set(value: &str) -> HashSet<String> {
    let mut tokens = HashSet::new();
    let mut token = String::new();
    for ch in value.to_lowercase().replace('ё', "е").chars() {
        if ch.is_alphabetic() || ch.is_numeric() {
            token.push(ch);
        } else if !token.is_empty() {
            tokens.insert(std::mem::take(&mut token));
        }
    }
    if !token.is_empty() {
        tokens.insert(token);
    }
    tokens
}

pub fn token_overlap(want: &str, have: &str) -> f64 {
    let a = token_set(&strip_lyrics_noise(want));
    let b = token_set(&strip_lyrics_noise(have));
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let forward = a.iter().filter(|t| b.contains(*t)).count();
    let reverse = b.iter().filter(|t| a.contains(*t)).count();
    let base = forward as f64 / a.len() as f64 * 0.7 + reverse as f64 / b.len() as f64 * 0.3;
    let surplus = b.len().saturating_sub(a.len());
    let penalty = (surplus as f64 / b.len() as f64 * 0.45).min(0.45);
    base * (1.0 - penalty)
}

fn title_specificity(value: &str) -> usize {
    const FILLER: &[&str] = &[
        "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "for", "from", "i", "if", "in", "is", "it", "me", "my", "of", "on", "or", "the", "to", "up", "we",
        "what", "when", "where", "who", "you", "your",
    ];
    token_set(value).iter().filter(|t| !FILLER.contains(&t.as_str())).count()
}

fn duration_score(want: i64, have: i64) -> f64 {
    if want <= 0 || have <= 0 {
        return 0.6;
    }
    let delta = (want - have).abs();
    if delta <= 2 {
        1.0
    } else if delta <= 5 {
        0.8
    } else if delta <= 12 {
        0.5
    } else if delta as f64 / (want + have) as f64 > 0.35 {
        0.0
    } else {
        0.2
    }
}

fn append_unique_fold(values: &mut Vec<String>, value: &str) {
    let value = value.trim();
    if value.is_empty() || values.iter().any(|existing| existing.to_lowercase() == value.to_lowercase()) {
        return;
    }
    values.push(value.to_string());
}

fn unique_strings(values: Vec<String>) -> Vec<String> {
    let mut result = Vec::with_capacity(values.len());
    for value in &values {
        append_unique_fold(&mut result, value);
    }
    result
}

fn artist_hints(params: &TrackLyricsParams, title: &str) -> Vec<String> {
    let mut hints = vec![params.artist.trim().to_string()];
    for part in dash_parts().split(title) {
        hints.push(strip_lyrics_noise(part));
    }
    unique_strings(hints)
}

fn title_variants(value: &str) -> Vec<String> {
    let mut variants = Vec::new();
    append_unique_fold(&mut variants, value.trim());
    for part in dash_parts().split(value) {
        append_unique_fold(&mut variants, &strip_lyrics_noise(part));
    }
    variants.truncate(4);
    variants
}

fn degenerate_pair(title: &str, artist: &str) -> bool {
    token_overlap(title, artist) >= DEGENERATE_OVERLAP
}

fn rounded_seconds(duration_ms: i64) -> i64 {
    (duration_ms + 500) / 1000
}

// ---- scoring ----------------------------------------------------------------------------------

pub fn score_deezer_candidate(params: &TrackLyricsParams, candidate: &DeezerTrack, titles: &[String], artists: &[String]) -> Option<CandidateScore> {
    let (mut best_title, mut best_title_score) = (String::new(), 0.0);
    for title in titles {
        let score = token_overlap(title, &candidate.title);
        if score > best_title_score {
            best_title = title.clone();
            best_title_score = score;
        }
    }
    if best_title_score < 0.72 {
        return None;
    }
    let artist_score = artists.iter().map(|artist| token_overlap(artist, &candidate.artist)).fold(0.0, f64::max);
    let specificity = title_specificity(&best_title);
    let want_sec = rounded_seconds(params.duration_ms);
    let delta_sec = (want_sec - candidate.duration).abs() as f64;
    let has_version = has_version_marker(&params.title);

    if want_sec > 0 && candidate.duration > 0 && !has_version && delta_sec > 4.0 {
        return None;
    }
    let duration = duration_score(want_sec, candidate.duration);
    // If the artist does not match, only accept a title of 3+ distinct words within ±1.5 s.
    if artist_score < 0.5 && (specificity < 3 || best_title_score < 0.98 || want_sec <= 0 || candidate.duration <= 0 || delta_sec > 1.5) {
        return None;
    }
    let rank = best_title_score * 0.62 + artist_score * 0.33 + duration * 0.05;
    Some(CandidateScore { rank, artist: artist_score })
}

pub fn score_lrclib_record(query: &LyricsQuery, candidate: &LrclibRecord, require_duration: bool) -> Option<CandidateScore> {
    let title_score = token_overlap(&query.title, &candidate.track_name);
    if title_score < 0.72 {
        return None;
    }
    let artist_score = token_overlap(&query.artist, &candidate.artist_name);
    let specificity = title_specificity(&query.title);
    let delta_sec = (query.duration as f64 - candidate.duration).abs();

    if require_duration && query.duration > 0 && candidate.duration > 0.0 && delta_sec > 4.0 {
        return None;
    }
    let duration = duration_score(query.duration, candidate.duration.round() as i64);
    if duration == 0.0 && require_duration {
        return None;
    }
    // Never accept a different artist unless the title has 3+ unique words AND the duration matches within ±1.5 s.
    if artist_score < 0.5 && (specificity < 3 || title_score < 0.98 || query.duration <= 0 || candidate.duration <= 0.0 || delta_sec > 1.5) {
        return None;
    }
    let mut rank = title_score * 0.62 + artist_score * 0.33 + duration * 0.05;
    if !parse_lrc(&candidate.synced_lyrics).is_empty() {
        rank += 0.04;
    }
    Some(CandidateScore { rank, artist: artist_score })
}

// ---- LRC parsing ------------------------------------------------------------------------------

pub fn parse_plain_lyrics(content: &str) -> Vec<LyricsLine> {
    let mut lines = Vec::new();
    for row in content.replace("\r\n", "\n").split('\n') {
        let text = row.trim();
        if !text.is_empty() {
            lines.push(LyricsLine { id: format!("lrclib-plain-{}", lines.len()), text: text.to_string(), start_ms: 0 });
        }
    }
    lines
}

pub fn parse_lrc(content: &str) -> Vec<LyricsLine> {
    let mut lines: Vec<LyricsLine> = Vec::new();
    let mut offset_ms: i64 = 0;
    for row in content.replace('\r', "").split('\n') {
        let mut row = row.trim();
        let mut timestamps: Vec<i64> = Vec::new();
        while row.starts_with('[') {
            let Some(end) = row.find(']') else { break };
            let tag = &row[1..end];
            let parts: Vec<&str> = tag.split(':').collect();
            if parts.len() != 2 {
                break;
            }
            let minutes = parts[0].parse::<i64>();
            let seconds = parts[1].parse::<f64>();
            match (minutes, seconds) {
                (Ok(minutes), Ok(seconds)) if (0.0..60.0).contains(&seconds) => {
                    timestamps.push(minutes * 60_000 + (seconds * 1000.0 + 0.5) as i64);
                    row = &row[end + 1..];
                }
                _ => {
                    // [offset:±ms] shifts every timestamp of the record; consume it so it is not
                    // mistaken for the text of the line.
                    if parts[0].eq_ignore_ascii_case("offset") {
                        if let Ok(value) = parts[1].parse::<i64>() {
                            offset_ms = value;
                            row = &row[end + 1..];
                            continue;
                        }
                    }
                    break;
                }
            }
        }
        let text = row.trim();
        if text.is_empty() {
            continue;
        }
        for start_ms in timestamps {
            let adjusted = (start_ms + offset_ms).max(0);
            let id = format!("lrclib-{}", lines.len());
            lines.push(LyricsLine { id, text: text.to_string(), start_ms: adjusted });
        }
    }
    // "[00:12][01:30] refrain" near the top of a file leaves the list out of order; the client
    // binary-searches it, so sort here (stable, like the original).
    lines.sort_by_key(|line| line.start_ms);
    lines
}

/// Stretches synced lines to the copy that is actually playing. A slowed or sped-up reupload keeps
/// the words and their order but moves every line in time, and the matched record usually belongs
/// to the original release. Differences up to two seconds are metadata rounding or an outro edit;
/// ratios outside 0.7..1.6 are clearly another version and are left alone.
fn scale_lyrics_to_playing_copy(lines: Vec<LyricsLine>, record_duration_sec: f64, playing_duration_ms: i64) -> Vec<LyricsLine> {
    if record_duration_sec <= 0.0 || playing_duration_ms <= 0 {
        return lines;
    }
    let ratio = playing_duration_ms as f64 / (record_duration_sec * 1000.0);
    if (playing_duration_ms as f64 - record_duration_sec * 1000.0).abs() <= 2000.0 || !(0.7..=1.6).contains(&ratio) {
        return lines;
    }
    lines.into_iter().map(|line| LyricsLine { start_ms: (line.start_ms as f64 * ratio) as i64, ..line }).collect()
}

fn lyrics_from_record(track_id: i64, record: &LrclibRecord, playing_duration_ms: i64) -> Option<TrackLyrics> {
    let lines = parse_lrc(&record.synced_lyrics);
    if !lines.is_empty() {
        let lines = scale_lyrics_to_playing_copy(lines, record.duration, playing_duration_ms);
        return Some(TrackLyrics { track_id, lines, source_url: "https://lrclib.net".into(), is_synced: true, logs: Vec::new() });
    }
    let lines = parse_plain_lyrics(&record.plain_lyrics);
    if lines.is_empty() {
        return None;
    }
    // Plain text has no timestamps and there is no honest way to invent them (an evenly spaced grid
    // drifts from the real vocals), so it is handed over as unsynced: shown, but not followed.
    Some(TrackLyrics { track_id, lines, source_url: "https://lrclib.net".into(), is_synced: false, logs: Vec::new() })
}

// ---- lookup -----------------------------------------------------------------------------------

struct ScoredRecord {
    record: LrclibRecord,
    score: CandidateScore,
}

fn is_blank_record(record: &LrclibRecord) -> bool {
    record.instrumental || format!("{}{}", record.synced_lyrics, record.plain_lyrics).trim().is_empty()
}

impl Backend {
    /// Finds a canonical catalogue record first, then falls back to a direct LRCLIB search. A real
    /// miss returns an empty line list; transport/provider errors stay in the logs.
    pub async fn track_lyrics(&self, params: TrackLyricsParams) -> BResult<TrackLyrics> {
        if params.track_id <= 0 || params.title.trim().is_empty() {
            return Err(BErr::msg("некорректные данные трека"));
        }
        if let Some(cached) = self.cached_lyrics(params.track_id) {
            return Ok(cached);
        }
        let mut logs = vec![format!("Старт поиска текста: {} — {}", params.title, params.artist)];
        if let Some(canonical) = self.resolve_lyrics_track(&params, &mut logs).await {
            logs.push(format!("Deezer выбрал: {} — {}", canonical.artist, canonical.title));
            if let Some(mut lyrics) = self.find_lyrics_for_query(&params, &canonical, &mut logs).await {
                lyrics.logs = logs;
                return Ok(self.store_lyrics(lyrics));
            }
        } else {
            logs.push("Deezer не подтвердил подходящую запись; пробую исходные название и исполнителя".into());
        }
        if let Some(mut lyrics) = self.find_lyrics_by_variants(&params, &mut logs).await {
            lyrics.logs = logs;
            return Ok(self.store_lyrics(lyrics));
        }
        logs.push("Текст не найден: LRCLIB не вернул подходящих синхронизированных или обычных лирик".into());
        Ok(self.store_lyrics(TrackLyrics { track_id: params.track_id, lines: Vec::new(), logs, ..Default::default() }))
    }

    fn cached_lyrics(&self, track_id: i64) -> Option<TrackLyrics> {
        let cache = self.inner.lyrics_cache.lock().ok()?;
        let cached = cache.get(&track_id)?;
        // Found text is returned for good (it does not stop being right); a miss only until it expires.
        (!cached.lyrics.lines.is_empty() || cached.cached_at.elapsed() < MISS_TTL).then(|| cached.lyrics.clone())
    }

    fn store_lyrics(&self, lyrics: TrackLyrics) -> TrackLyrics {
        if let Ok(mut cache) = self.inner.lyrics_cache.lock() {
            // Cap the cache so a long session cannot grow it without limit: drop the oldest entries.
            while cache.len() >= MAX_LYRICS_CACHE_ENTRIES {
                let oldest = cache.iter().min_by_key(|(_, entry)| entry.cached_at).map(|(id, _)| *id);
                match oldest {
                    Some(id) => cache.remove(&id),
                    None => break,
                };
            }
            cache.insert(lyrics.track_id, CachedLyrics { lyrics: lyrics.clone(), cached_at: Instant::now() });
        }
        lyrics
    }

    pub fn clear_lyrics_cache(&self) -> usize {
        match self.inner.lyrics_cache.lock() {
            Ok(mut cache) => {
                let count = cache.len();
                *cache = HashMap::new();
                count
            }
            Err(_) => 0,
        }
    }

    async fn resolve_lyrics_track(&self, params: &TrackLyricsParams, logs: &mut Vec<String>) -> Option<LyricsQuery> {
        let cleaned = strip_lyrics_noise(&params.title);
        let mut base = strip_version_markers(&cleaned);
        if base.is_empty() {
            base = cleaned;
        }
        let titles = title_variants(&base);
        let artists = artist_hints(params, &base);
        let mut queries = titles.clone();
        for title in &titles {
            for artist in &artists {
                if degenerate_pair(title, artist) {
                    continue;
                }
                append_unique_fold(&mut queries, &format!("{title} {artist}"));
            }
        }
        queries.truncate(8);

        let mut best: Option<(DeezerTrack, CandidateScore)> = None;
        let mut seen = HashSet::new();
        let (mut search_count, mut candidate_count, mut error_count) = (0, 0, 0);
        for query in &queries {
            search_count += 1;
            let candidates = match self.search_deezer(query).await {
                Ok(candidates) => candidates,
                Err(_) => {
                    error_count += 1;
                    continue;
                }
            };
            candidate_count += candidates.len();
            for candidate in candidates {
                let key = format!("{}\u{0}{}", candidate.artist, candidate.title).to_lowercase();
                if !seen.insert(key) {
                    continue;
                }
                let Some(score) = score_deezer_candidate(params, &candidate, &titles, &artists) else { continue };
                if best.as_ref().is_none_or(|(_, current)| score.rank > current.rank) {
                    best = Some((candidate, score));
                }
            }
            if best.as_ref().is_some_and(|(_, score)| score.rank >= 0.9 && score.artist >= 0.45) {
                break;
            }
        }
        logs.push(format!("Deezer: запросов {search_count}, найдено кандидатов {candidate_count}, ошибок {error_count}"));
        best.map(|(track, _)| LyricsQuery { title: track.title, artist: track.artist, duration: track.duration })
    }

    async fn find_lyrics_for_query(&self, params: &TrackLyricsParams, query: &LyricsQuery, logs: &mut Vec<String>) -> Option<TrackLyrics> {
        match self.fetch_lrclib_exact(params.track_id, query, params.duration_ms).await {
            Ok(Some(lyrics)) => {
                logs.push("LRCLIB: точный поиск нашёл текст".into());
                return Some(lyrics);
            }
            Ok(None) => logs.push("LRCLIB: точный поиск не дал подходящего текста; проверяю каталог".into()),
            Err(e) => logs.push(format!("LRCLIB: точный поиск — {e}")),
        }
        let records = match self.search_lrclib(query).await {
            Ok(records) => records,
            Err(e) => {
                logs.push(format!("LRCLIB: ошибка поиска — {e}"));
                return None;
            }
        };
        // The catalogue is scored against the duration of the track that is actually playing, not
        // the canonical one Deezer returned: a SoundCloud reupload is usually a few seconds off and
        // its synced lines must line up with that copy.
        let mut scoring = query.clone();
        if params.duration_ms > 0 {
            scoring.duration = rounded_seconds(params.duration_ms);
        }
        let require_duration = scoring.duration > 0 && !has_version_marker(&params.title);
        let mut best: Option<ScoredRecord> = None;
        for record in &records {
            if is_blank_record(record) {
                continue;
            }
            if let Some(score) = score_lrclib_record(&scoring, record, require_duration) {
                if best.as_ref().is_none_or(|current| score.rank > current.score.rank) {
                    best = Some(ScoredRecord { record: record.clone(), score });
                }
            }
        }
        let Some(best) = best else {
            logs.push(format!("LRCLIB: в каталоге проверено записей {}, подходящих нет", records.len()));
            return None;
        };
        logs.push(format!("LRCLIB: совпадение — {} — {}", best.record.artist_name, best.record.track_name));
        lyrics_from_record(params.track_id, &best.record, params.duration_ms)
    }

    pub async fn find_lyrics_by_variants(&self, params: &TrackLyricsParams, logs: &mut Vec<String>) -> Option<TrackLyrics> {
        let base = strip_lyrics_noise(&params.title);
        let mut titles = title_variants(&strip_version_markers(&base));
        if titles.is_empty() {
            titles = title_variants(&base);
        }
        let artists = artist_hints(params, &base);
        let duration = if params.duration_ms > 0 { rounded_seconds(params.duration_ms) } else { 0 };
        let mut queries: Vec<LyricsQuery> = Vec::new();
        'build: for title in &titles {
            for artist in &artists {
                // Checked before the query budget, so a skipped pair does not use one of the slots
                // that real variants need.
                if degenerate_pair(title, artist) {
                    continue;
                }
                if queries.len() >= 7 {
                    break 'build;
                }
                queries.push(LyricsQuery { title: title.clone(), artist: artist.clone(), duration });
            }
        }
        if queries.len() < 8 {
            if let Some(first) = titles.first() {
                queries.push(LyricsQuery { title: first.clone(), artist: String::new(), duration });
            }
        }

        let mut best: Option<ScoredRecord> = None;
        let mut seen = HashSet::new();
        let (mut search_count, mut record_count, mut error_count) = (0, 0, 0);
        for query in &queries {
            if !seen.insert(format!("{}\u{0}{}", query.title, query.artist).to_lowercase()) {
                continue;
            }
            search_count += 1;
            let candidates = match self.search_lrclib(query).await {
                Ok(candidates) => candidates,
                Err(_) => {
                    error_count += 1;
                    continue;
                }
            };
            record_count += candidates.len();
            for candidate in candidates {
                if is_blank_record(&candidate) {
                    continue;
                }
                let Some(score) = score_lrclib_record(query, &candidate, params.duration_ms > 0 && !has_version_marker(&params.title)) else { continue };
                if best.as_ref().is_none_or(|current| score.rank > current.score.rank) {
                    best = Some(ScoredRecord { record: candidate, score });
                }
            }
            // A strong catalogue identity is preferable to broadening the query matrix.
            if best.as_ref().is_some_and(|current| current.score.rank >= 0.93) {
                break;
            }
        }
        logs.push(format!("LRCLIB по вариантам: запросов {search_count}, записей {record_count}, ошибок {error_count}"));
        let best = best?;
        logs.push(format!("LRCLIB выбрал: {} — {}", best.record.artist_name, best.record.track_name));
        lyrics_from_record(params.track_id, &best.record, params.duration_ms)
    }

    async fn search_deezer(&self, query: &str) -> Result<Vec<DeezerTrack>, String> {
        let mut url = url::Url::parse("https://api.deezer.com/search").map_err(|e| e.to_string())?;
        url.query_pairs_mut().append_pair("limit", "8").append_pair("q", query);
        let payload = self.get_lyrics_json(url.as_str()).await?;
        if let Some(message) = payload.get("error").filter(|e| !e.is_null()).and_then(|e| e.get("message")).and_then(Value::as_str) {
            return Err(message.to_string());
        }
        Ok(payload
            .get("data")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| DeezerTrack {
                        title: super::util::vs(item, "title"),
                        duration: super::util::vi(item, "duration"),
                        artist: item.get("artist").map(|artist| super::util::vs(artist, "name")).unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    async fn search_lrclib(&self, query: &LyricsQuery) -> Result<Vec<LrclibRecord>, String> {
        let mut url = url::Url::parse("https://lrclib.net/api/search").map_err(|e| e.to_string())?;
        url.query_pairs_mut().append_pair("track_name", &query.title).append_pair("artist_name", &query.artist);
        let payload = self.get_lyrics_json(url.as_str()).await?;
        serde_json::from_value::<Option<Vec<LrclibRecord>>>(payload).map(Option::unwrap_or_default).map_err(|e| e.to_string())
    }

    async fn fetch_lrclib_exact(&self, track_id: i64, query: &LyricsQuery, playing_duration_ms: i64) -> Result<Option<TrackLyrics>, String> {
        let mut url = url::Url::parse("https://lrclib.net/api/get").map_err(|e| e.to_string())?;
        {
            let mut pairs = url.query_pairs_mut();
            pairs.append_pair("track_name", &query.title).append_pair("artist_name", &query.artist);
            if query.duration > 0 {
                pairs.append_pair("duration", &query.duration.to_string());
            }
        }
        let payload = self.get_lyrics_json(url.as_str()).await?;
        let record: LrclibRecord = serde_json::from_value(payload).map_err(|e| e.to_string())?;
        if record.instrumental || score_lrclib_record(query, &record, false).is_none() {
            return Ok(None);
        }
        Ok(lyrics_from_record(track_id, &record, playing_duration_ms))
    }

    /// GET with one retry: network errors, 5xx and undecodable bodies are retried after 250 ms,
    /// other HTTP errors are final.
    async fn get_lyrics_json(&self, endpoint: &str) -> Result<Value, String> {
        let mut last_err = String::new();
        for attempt in 0..2 {
            match self.inner.http.get(endpoint).header("User-Agent", LYRICS_USER_AGENT).send().await {
                Err(e) => last_err = e.without_url().to_string(),
                Ok(response) => {
                    let status = response.status();
                    if status.is_success() {
                        match super::util::read_limited(response, 4 << 20).await {
                            Ok(body) => match serde_json::from_slice(&body) {
                                Ok(value) => return Ok(value),
                                Err(e) => last_err = e.to_string(),
                            },
                            Err(e) => last_err = e.without_url().to_string(),
                        }
                    } else {
                        last_err = format!("источник текста вернул ошибку HTTP {}", status.as_u16());
                        if status.as_u16() < 500 {
                            return Err(last_err);
                        }
                    }
                }
            }
            if attempt == 0 {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
        Err(last_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(name: &str, artist: &str, duration: f64) -> LrclibRecord {
        LrclibRecord { track_name: name.into(), artist_name: artist.into(), duration, synced_lyrics: "[00:00]Line".into(), ..Default::default() }
    }

    #[test]
    fn reupload_matches_by_exact_title_and_duration_but_short_titles_do_not() {
        let query = LyricsQuery { title: "Love Me Not Forever Now".into(), artist: "Маргарита Попова".into(), duration: 204 };
        assert!(score_lrclib_record(&query, &record("Love Me Not Forever Now", "Ravyn Lenae", 203.0), true).is_some(), "3+ word exact title within 1.5s must match a different uploader artist");

        let short = LyricsQuery { title: "самолёт".into(), artist: "zer0cks".into(), duration: 113 };
        assert!(score_lrclib_record(&short, &record("Стратосферный самолёт", "Детский хор", 113.0), true).is_none(), "1-word title with another artist is rejected even at equal duration");
    }

    #[test]
    fn unrelated_duration_is_rejected_for_a_short_title() {
        let query = LyricsQuery { title: "Love Me Not".into(), artist: "unknown uploader".into(), duration: 206 };
        assert!(score_lrclib_record(&query, &record("Love Me Not", "Unknown Artist", 90.0), true).is_none());
    }

    #[test]
    fn lrc_parsing_handles_multi_stamps_offsets_and_order() {
        let lines = parse_lrc("[offset:+500]\n[00:12.00][01:30.00]refrain\n[00:01.50]first\n[ar:ignored]\nplain");
        let got: Vec<(i64, &str)> = lines.iter().map(|l| (l.start_ms, l.text.as_str())).collect();
        assert_eq!(got, [(2000, "first"), (12500, "refrain"), (90500, "refrain")]);
        assert_eq!(lines[0].id, "lrclib-2", "ids follow insertion order, before sorting");
    }

    #[test]
    fn plain_lyrics_are_unsynced_lines() {
        let lines = parse_plain_lyrics("one\r\n\r\n two \n");
        assert_eq!(lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["one", "two"]);
        assert_eq!(lines[1].id, "lrclib-plain-1");
    }

    #[test]
    fn noise_and_version_markers_are_stripped() {
        assert_eq!(strip_lyrics_noise("Song (Official Video) [HD] #tag feat. Someone Else"), "Song");
        assert_eq!(strip_version_markers("Song slowed reverb"), "Song");
        assert!(has_version_marker("Song - Sped Up"));
        assert!(!has_version_marker("Song"));
    }

    #[test]
    fn synced_lines_are_stretched_for_a_slowed_copy() {
        let lines = vec![LyricsLine { id: "a".into(), text: "x".into(), start_ms: 10_000 }];
        let scaled = scale_lyrics_to_playing_copy(lines.clone(), 200.0, 250_000);
        assert_eq!(scaled[0].start_ms, 12_500);
        let near = scale_lyrics_to_playing_copy(lines.clone(), 200.0, 201_000);
        assert_eq!(near[0].start_ms, 10_000, "≤2s difference is rounding, not a different copy");
        let unrelated = scale_lyrics_to_playing_copy(lines, 200.0, 60_000);
        assert_eq!(unrelated[0].start_ms, 10_000, "ratio outside 0.7..1.6 is left alone");
    }

    #[test]
    fn deezer_candidate_needs_close_duration_unless_the_title_is_a_version() {
        let params = TrackLyricsParams { track_id: 1, title: "Song".into(), artist: "Artist".into(), duration_ms: 200_000 };
        let titles = vec!["Song".to_string()];
        let artists = vec!["Artist".to_string()];
        let good = DeezerTrack { title: "Song".into(), duration: 201, artist: "Artist".into() };
        let far = DeezerTrack { title: "Song".into(), duration: 230, artist: "Artist".into() };
        assert!(score_deezer_candidate(&params, &good, &titles, &artists).is_some());
        assert!(score_deezer_candidate(&params, &far, &titles, &artists).is_none());
    }
}
