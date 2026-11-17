use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::models::{LyricLine, Source, Track};

/// Normalizes any duration value (seconds or milliseconds > 1800) strictly into seconds.
pub fn to_seconds(val: f64) -> f64 {
    if !val.is_finite() || val <= 0.0 {
        return 0.0;
    }
    if val > 1800.0 { val / 1000.0 } else { val }
}

pub fn to_seconds_str(s: &str) -> f64 {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    if trimmed.contains(':') {
        let mut acc = 0.0;
        for part in trimmed.split(':') {
            let Ok(num) = part.parse::<f64>() else {
                return 0.0;
            };
            if !num.is_finite() || num < 0.0 {
                return 0.0;
            }
            acc = acc * 60.0 + num;
        }
        return acc;
    }
    trimmed.parse::<f64>().map(to_seconds).unwrap_or(0.0)
}

fn non_alnum_compact_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[^\p{L}\p{N}]+").unwrap())
}

fn non_alnum_space_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[^\p{L}\p{N}]+").unwrap())
}

pub fn normalize_lyrics_text(value: &str) -> String {
    let lower = value.to_lowercase().replace('ё', "е");
    non_alnum_compact_re().replace_all(&lower, "").into_owned()
}

pub fn tokenize_lyrics_text(value: &str) -> Vec<String> {
    let lower = value.to_lowercase().replace('ё', "е");
    non_alnum_space_re()
        .split(&lower)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

const FILLER_WORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "i", "if", "in", "is",
    "it", "me", "my", "of", "on", "or", "the", "to", "up", "we", "you", "your",
];

pub fn title_word_count(value: &str) -> usize {
    let cleaned = strip_track_noise(value);
    tokenize_lyrics_text(&cleaned)
        .into_iter()
        .filter(|w| !FILLER_WORDS.contains(&w.as_str()))
        .collect::<HashSet<_>>()
        .len()
}

fn first_artist_split_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(?:,|&|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+|\s+x\s+|\s+и\s+)").unwrap()
    })
}

pub fn first_artist(value: &str) -> String {
    first_artist_split_re()
        .split(value)
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

pub fn strip_track_noise(value: &str) -> String {
    static URL_RE: OnceLock<Regex> = OnceLock::new();
    static HASH_RE: OnceLock<Regex> = OnceLock::new();
    static PLUS_RE: OnceLock<Regex> = OnceLock::new();
    static BRACKET1_RE: OnceLock<Regex> = OnceLock::new();
    static BRACKET2_RE: OnceLock<Regex> = OnceLock::new();
    static TAG_RE: OnceLock<Regex> = OnceLock::new();
    static FEAT_RE: OnceLock<Regex> = OnceLock::new();
    static TAIL_RE: OnceLock<Regex> = OnceLock::new();
    static WS_RE: OnceLock<Regex> = OnceLock::new();

    let s = URL_RE.get_or_init(|| Regex::new(r"(?i)https?://\S+").unwrap()).replace_all(value, " ");
    let s = HASH_RE.get_or_init(|| Regex::new(r"#\S+").unwrap()).replace_all(&s, " ");
    let s = PLUS_RE.get_or_init(|| Regex::new(r"\+\S+").unwrap()).replace_all(&s, " ");
    let s = BRACKET1_RE
        .get_or_init(|| Regex::new(r"(?i)\s*[\[(](?:official\b|lyrics?\b|audio\b|music video\b|visuali[sz]er\b|4k\b|hd\b|mv\b|prod\b|slowed\b|reverb\b|sped\s*up\b|speed\s*up\b|nightcore\b|alt\s*ver\b|tgk?\b|vk\b|by\b|feat\b|ft\b)[^\])]*[\])]").unwrap())
        .replace_all(&s, " ");
    let s = BRACKET2_RE
        .get_or_init(|| Regex::new(r"(?i)\s*[\[(][^\])]*(?:prod\.?|slowed|reverb|speed\s*up|sped\s*up|nightcore|alt\s*ver|tgk?:|vk:)[^\])]*[\])]").unwrap())
        .replace_all(&s, " ");
    let s = TAG_RE
        .get_or_init(|| Regex::new(r"(?iu)\b(?:prod\.?|tgk?:?|vk:?)\s*[\p{L}\p{N}_.@/-]+").unwrap())
        .replace_all(&s, " ");
    let s = FEAT_RE
        .get_or_init(|| Regex::new(r"(?iu)\b(?:ft|feat|featuring)\.?\s+[\p{L}\p{N}&,'’. -]+").unwrap())
        .replace_all(&s, " ");
    let s = TAIL_RE
        .get_or_init(|| Regex::new(r"(?i)\s*(?:[-–—|])\s*(?:official\b|lyrics?\b|audio\b|music video\b|visuali[sz]er\b|slowed\b|sped\s*up\b|speed\s*up\b|reverb\b|nightcore\b|alt\s*ver\b).*$").unwrap())
        .replace_all(&s, "");
    WS_RE
        .get_or_init(|| Regex::new(r"\s+").unwrap())
        .replace_all(&s, " ")
        .trim()
        .to_string()
}

pub fn token_overlap_score(want: &str, have: &str) -> f64 {
    let a: HashSet<String> = tokenize_lyrics_text(&strip_track_noise(want)).into_iter().collect();
    let b: HashSet<String> = tokenize_lyrics_text(&strip_track_noise(have)).into_iter().collect();
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let forward = a.iter().filter(|t| b.contains(*t)).count() as f64;
    let reverse = b.iter().filter(|t| a.contains(*t)).count() as f64;
    let base = (forward / a.len() as f64) * 0.7 + (reverse / b.len() as f64) * 0.3;
    let surplus = b.len().saturating_sub(a.len()) as f64;
    let penalty = ((surplus / b.len() as f64) * 0.45).min(0.45);
    base * (1.0 - penalty)
}

pub fn artists_match(query_artist: &str, candidate_artist: &str) -> bool {
    let qa = normalize_lyrics_text(&first_artist(query_artist));
    let ca = normalize_lyrics_text(&first_artist(candidate_artist));
    if qa.is_empty() || ca.is_empty() {
        return false;
    }
    if qa == ca {
        return true;
    }
    token_overlap_score(query_artist, candidate_artist) >= 0.65
}

pub fn lyrics_search_queries(title: &str, artist: &str) -> Vec<(String, String)> {
    let cleaned_title = strip_track_noise(title);
    let uploader = first_artist(&strip_track_noise(artist));
    let mut queries: Vec<(String, String)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let mut add = |next_title: &str, next_artist: &str| {
        let ct = strip_track_noise(next_title);
        let ca = first_artist(&strip_track_noise(next_artist));
        if !ct.is_empty() && !ca.is_empty() {
            let key = format!("{}::{}", normalize_lyrics_text(&ct), normalize_lyrics_text(&ca));
            if seen.insert(key) {
                queries.push((ct, ca));
            }
        }
    };

    static DASH_RE: OnceLock<Regex> = OnceLock::new();
    let dash_re = DASH_RE.get_or_init(|| Regex::new(r"^(.+?)\s+[–—-]\s+(.+)$").unwrap());
    if let Some(caps) = dash_re.captures(&cleaned_title) {
        let left = caps.get(1).map(|m| m.as_str().trim()).unwrap_or("");
        let right = caps.get(2).map(|m| m.as_str().trim()).unwrap_or("");
        if normalize_lyrics_text(right) == normalize_lyrics_text(&uploader) {
            add(left, right);
        } else {
            add(right, left);
            if !uploader.is_empty() && normalize_lyrics_text(left) != normalize_lyrics_text(&uploader) {
                add(right, &uploader);
            }
        }
    }

    add(&cleaned_title, &uploader);
    if cleaned_title != title.trim() {
        add(title, &uploader);
    }
    queries
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualLyricsChoice {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub track_name: String,
    #[serde(default)]
    pub artist_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album_name: Option<String>,
    #[serde(default)]
    pub duration: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synced_lyrics: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plain_lyrics: Option<String>,
    #[serde(default)]
    pub instrumental: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LyricsData {
    pub synced: Option<Vec<LyricLine>>,
    pub plain: Option<Vec<String>>,
    pub instrumental: bool,
    pub preview: bool,
    pub matched_title: Option<String>,
    pub matched_artist: Option<String>,
}

pub fn find_lyrics_candidate<'a>(
    candidates: &'a [ManualLyricsChoice],
    query_title: &str,
    query_artist: &str,
    raw_duration: f64,
    tolerance: f64,
) -> Option<&'a ManualLyricsChoice> {
    let want_sec = to_seconds(raw_duration);
    let query_title_norm = normalize_lyrics_text(&strip_track_noise(query_title));
    if query_title_norm.is_empty() {
        return None;
    }
    let word_count = title_word_count(query_title);
    let mut best: Option<(&'a ManualLyricsChoice, f64)> = None;

    for cand in candidates {
        let has_content = cand.synced_lyrics.as_deref().is_some_and(|s| !s.is_empty())
            || cand.plain_lyrics.as_deref().is_some_and(|s| !s.is_empty())
            || cand.instrumental;
        if !has_content {
            continue;
        }
        let cand_sec = to_seconds(cand.duration);
        let title_sim = token_overlap_score(query_title, &cand.track_name);
        let exact_title = normalize_lyrics_text(&strip_track_noise(&cand.track_name)) == query_title_norm;
        if !exact_title && title_sim < 0.75 {
            continue;
        }

        let artist_ok = artists_match(query_artist, &cand.artist_name);
        let delta_sec = if want_sec > 0.0 && cand_sec > 0.0 {
            (want_sec - cand_sec).abs()
        } else {
            0.0
        };
        if want_sec > 0.0 && cand_sec > 0.0 && delta_sec > tolerance {
            continue;
        }
        if !artist_ok && (word_count < 3 || !exact_title || want_sec <= 0.0 || cand_sec <= 0.0 || delta_sec > 1.5) {
            continue;
        }

        let dur_bonus = if want_sec > 0.0 && cand_sec > 0.0 {
            (1.0 - delta_sec / tolerance.max(1.0)).max(0.0)
        } else {
            0.5
        };
        let sync_bonus = if cand.synced_lyrics.as_deref().is_some_and(|s| !s.is_empty()) {
            0.15
        } else {
            0.0
        };
        let score = (if exact_title { 1.0 } else { title_sim }) * 0.55
            + if artist_ok { 0.35 } else { 0.0 }
            + dur_bonus * 0.1
            + sync_bonus;
        if best.is_none_or(|(_, s)| score > s) {
            best = Some((cand, score));
        }
    }

    best.map(|(c, _)| c)
}

pub fn parse_lrc(lrc: &str) -> Vec<LyricLine> {
    static TS_RE: OnceLock<Regex> = OnceLock::new();
    let ts_re = TS_RE.get_or_init(|| Regex::new(r"\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]").unwrap());
    let mut out = Vec::new();
    for raw_line in lrc.lines() {
        let mut times = Vec::new();
        for caps in ts_re.captures_iter(raw_line) {
            let min: f64 = caps.get(1).and_then(|m| m.as_str().parse().ok()).unwrap_or(0.0);
            let sec: f64 = caps.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(0.0);
            let frac_str = caps.get(3).map(|m| m.as_str()).unwrap_or("");
            let frac = if frac_str.is_empty() {
                0.0
            } else {
                let div = 10f64.powi(frac_str.len() as i32);
                frac_str.parse::<f64>().unwrap_or(0.0) / div
            };
            times.push(min * 60.0 + sec + frac);
        }
        if times.is_empty() {
            continue;
        }
        let text = ts_re.replace_all(raw_line, "").trim().to_string();
        for t in times {
            out.push(LyricLine {
                t,
                text: text.clone(),
                gap: false,
            });
        }
    }
    out.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    out
}

pub fn with_gaps(lines: Vec<LyricLine>) -> Vec<LyricLine> {
    let mut src = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if !line.text.is_empty() || lines.get(i + 1).is_some_and(|n| n.t - line.t > 6.0) {
            src.push(line.clone());
        }
    }
    let mut out = Vec::new();
    if src.first().is_some_and(|l| l.t > 5.0) {
        out.push(LyricLine {
            t: 0.0,
            text: String::new(),
            gap: true,
        });
    }
    for (i, l) in src.iter().enumerate() {
        if l.text.is_empty() {
            out.push(LyricLine {
                t: l.t,
                text: String::new(),
                gap: true,
            });
            continue;
        }
        out.push(l.clone());
        if let Some(nx) = src.get(i + 1)
            && !nx.text.is_empty() && nx.t - l.t > 14.0 {
                out.push(LyricLine {
                    t: l.t + 6.5,
                    text: String::new(),
                    gap: true,
                });
            }
    }
    out
}

pub fn lyrics_data_from_record(rec: &ManualLyricsChoice) -> Option<LyricsData> {
    if rec.instrumental {
        return Some(LyricsData {
            instrumental: true,
            matched_title: (!rec.track_name.is_empty()).then(|| rec.track_name.clone()),
            matched_artist: (!rec.artist_name.is_empty()).then(|| rec.artist_name.clone()),
            ..Default::default()
        });
    }
    if let Some(synced_src) = rec.synced_lyrics.as_deref().filter(|s| !s.is_empty()) {
        let synced = with_gaps(parse_lrc(synced_src));
        if !synced.is_empty() {
            return Some(LyricsData {
                synced: Some(synced),
                matched_title: (!rec.track_name.is_empty()).then(|| rec.track_name.clone()),
                matched_artist: (!rec.artist_name.is_empty()).then(|| rec.artist_name.clone()),
                ..Default::default()
            });
        }
    }
    static TAG_STRIP_RE: OnceLock<Regex> = OnceLock::new();
    let plain_src = rec
        .plain_lyrics
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            rec.synced_lyrics
                .as_deref()
                .map(|s| TAG_STRIP_RE.get_or_init(|| Regex::new(r"\[[^\]]*\]").unwrap()).replace_all(s, "").into_owned())
                .unwrap_or_default()
        });
    let plain: Vec<String> = plain_src
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if plain.is_empty() {
        None
    } else {
        Some(LyricsData {
            plain: Some(plain),
            matched_title: (!rec.track_name.is_empty()).then(|| rec.track_name.clone()),
            matched_artist: (!rec.artist_name.is_empty()).then(|| rec.artist_name.clone()),
            ..Default::default()
        })
    }
}

pub async fn search_lyrics_manual(http: &reqwest::Client, query: &str) -> Vec<ManualLyricsChoice> {
    let q = query.trim();
    if q.is_empty() {
        return Vec::new();
    }
    let Ok(resp) = http
        .get("https://lrclib.net/api/search")
        .query(&[("q", q)])
        .send()
        .await
    else {
        return Vec::new();
    };
    let Ok(mut items) = resp.json::<Vec<ManualLyricsChoice>>().await else {
        return Vec::new();
    };
    items.retain(|i| {
        i.instrumental
            || i.synced_lyrics.as_deref().is_some_and(|s| !s.is_empty())
            || i.plain_lyrics.as_deref().is_some_and(|s| !s.is_empty())
    });
    for (idx, item) in items.iter_mut().enumerate() {
        if item.id == 0 {
            item.id = (idx + 1) as i64;
        }
        if item.track_name.is_empty() {
            item.track_name = "Unknown".to_string();
        }
        if item.artist_name.is_empty() {
            item.artist_name = "Unknown".to_string();
        }
        item.duration = to_seconds(item.duration);
    }
    items.truncate(20);
    items
}

pub async fn fetch_lrclib_lyrics(http: &reqwest::Client, track: &Track) -> Option<LyricsData> {
    let duration_sec = to_seconds(track.full_duration.unwrap_or(track.duration));
    let tolerance = if track.source == Source::YouTube { 8.0 } else { 4.0 };
    for (title, artist) in lyrics_search_queries(&track.title, &track.artist) {
        let Ok(resp) = http
            .get("https://lrclib.net/api/search")
            .query(&[("track_name", title.as_str()), ("artist_name", artist.as_str())])
            .send()
            .await
        else {
            continue;
        };
        let Ok(candidates) = resp.json::<Vec<ManualLyricsChoice>>().await else {
            continue;
        };
        if let Some(best) = find_lyrics_candidate(&candidates, &title, &artist, duration_sec, tolerance) {
            return lyrics_data_from_record(best);
        }
    }
    None
}

// ---- YouTube fallback + Import matching ---------------------------------------------------------

pub fn normalize_match(value: &str) -> String {
    let lower = value.to_lowercase().replace(['’', '\''], "");
    non_alnum_space_re().replace_all(&lower, " ").trim().to_string()
}

pub fn featured_artist(value: &str) -> String {
    static FEAT_BRACKET_RE: OnceLock<Regex> = OnceLock::new();
    static FEAT_TAIL_RE: OnceLock<Regex> = OnceLock::new();
    let s = FEAT_BRACKET_RE
        .get_or_init(|| Regex::new(r"(?i)\s*[\[(]\s*(?:feat(?:uring)?|ft)\.?\s*[^)\]]*[)\]]").unwrap())
        .replace_all(value, " ");
    FEAT_TAIL_RE
        .get_or_init(|| Regex::new(r"(?i)\s*\b(?:feat(?:uring)?|ft)\.?\s+.*$").unwrap())
        .replace_all(&s, " ")
        .trim()
        .to_string()
}

pub fn title_tokens(value: &str) -> HashSet<String> {
    static NOISE_BRACKET_RE: OnceLock<Regex> = OnceLock::new();
    static NOISE_DASH_RE: OnceLock<Regex> = OnceLock::new();
    let base = featured_artist(value);
    let s = NOISE_BRACKET_RE
        .get_or_init(|| Regex::new(r"(?i)\s*[\[(]\s*(?:official(?: music)? video|official(?: audio| lyric video)?|lyrics?|audio|music video|mv|m/v|visuali[sz]er|4k|hd|hq|explicit(?: version)?|clean(?: version)?|remaster(?:ed)?(?: \d{4})?|clip|prod\.?[^\])]*)\s*[\])]").unwrap())
        .replace_all(&base, " ");
    let s = NOISE_DASH_RE
        .get_or_init(|| Regex::new(r"(?i)\s*[-–—|]\s*(?:official(?: music)? video|official(?: audio)?|lyrics?|audio|music video|mv|visuali[sz]er|explicit|clean|remaster(?:ed)?|hq|hd|4k|clip)\b.*$").unwrap())
        .replace_all(&s, " ");
    normalize_match(&s)
        .split(' ')
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

pub fn coverage(target: &HashSet<String>, candidate: &HashSet<String>) -> f64 {
    if target.is_empty() {
        return 0.0;
    }
    let shared = target.iter().filter(|t| candidate.contains(*t)).count();
    shared as f64 / target.len() as f64
}

fn variant_words(norm: &str) -> HashSet<String> {
    static VARIANT_RE: OnceLock<Regex> = OnceLock::new();
    VARIANT_RE
        .get_or_init(|| Regex::new(r"\b(?:live|acoustic|sped up|speed up|nightcore|slowed|reverb|remix|cover|karaoke|instrumental|8d)\b").unwrap())
        .find_iter(norm)
        .map(|m| m.as_str().to_string())
        .collect()
}

pub fn youtube_fallback_queries(title: &str, artist: &str) -> Vec<String> {
    let artist = featured_artist(artist);
    let mut title = featured_artist(title);
    let prefix = format!("{artist} - ");
    if !artist.is_empty() && title.to_lowercase().starts_with(&prefix.to_lowercase()) {
        title = title[prefix.len()..].trim().to_string();
    }
    let candidates = [
        if !artist.is_empty() && !title.is_empty() { format!("{artist} - {title}") } else { String::new() },
        if !artist.is_empty() && !title.is_empty() { format!("{title} {artist}") } else { String::new() },
        title.clone(),
    ];
    let norm_title = normalize_match(&title);
    let generic_title = norm_title.split_whitespace().count() <= 1 && norm_title.chars().count() <= 3;

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for (idx, q) in candidates.into_iter().enumerate() {
        if q.is_empty() || (idx == 2 && generic_title && !artist.is_empty()) {
            continue;
        }
        if seen.insert(q.clone()) {
            out.push(q);
        }
    }
    out
}

#[derive(Clone, Debug)]
pub struct YtCandidate<'a> {
    pub title: &'a str,
    pub artist: &'a str,
    pub duration_ms: f64,
}

pub fn find_youtube_fallback_candidate_idx<'a>(
    track_title: &str,
    track_artist: &str,
    track_duration: f64,
    candidates: &[YtCandidate<'a>],
) -> Option<usize> {
    let has_known_dur = track_duration > 0.0;
    let max_diff = (track_duration * 0.1).max(10.0);
    let clean_title = normalize_match(&featured_artist(track_title));
    let clean_artist = normalize_match(&featured_artist(track_artist));
    let has_artist = clean_artist.chars().count() >= 2;
    let target_title = title_tokens(track_title);
    let target_artist: HashSet<String> = clean_artist
        .split(' ')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let requested = variant_words(&normalize_match(track_title));
    let is_short = clean_title.split_whitespace().count() <= 1 && clean_title.chars().count() <= 8;
    let min_title_score = if is_short { 0.9 } else { 0.75 };

    static TOPIC_RE: OnceLock<Regex> = OnceLock::new();
    let topic_re = TOPIC_RE.get_or_init(|| Regex::new(r"(?:\s+topic|\s*vevo)$").unwrap());
    let clean_compact = clean_artist.replace(' ', "");

    let mut best: Option<(usize, f64, f64, f64)> = None;
    for (idx, cand) in candidates.iter().enumerate() {
        let cand_sec = cand.duration_ms / 1000.0;
        let mut dur_score = 0.5;
        if has_known_dur && cand_sec > 0.0 {
            let diff = (track_duration - cand_sec).abs();
            if diff > max_diff {
                continue;
            }
            dur_score = 1.0 - diff / max_diff;
        }

        let cand_title = normalize_match(cand.title);
        if variant_words(&cand_title).iter().any(|w| !requested.contains(w)) {
            continue;
        }
        let title_score = coverage(&target_title, &title_tokens(cand.title));
        if title_score < min_title_score {
            continue;
        }

        let cand_artist_norm = topic_re.replace(&normalize_match(cand.artist), "").into_owned();
        let cand_compact = cand_artist_norm.replace(' ', "");
        let exact_artist = has_artist
            && ((cand_compact.len() >= 2 && cand_compact == clean_compact)
                || (cand_artist_norm.len() >= 2
                    && (format!(" {cand_artist_norm} ").contains(&format!(" {clean_artist} "))
                        || format!(" {clean_artist} ").contains(&format!(" {cand_artist_norm} "))))
                || format!(" {cand_title} ").contains(&format!(" {clean_artist} ")));
        let cand_artist_set: HashSet<String> = cand_artist_norm
            .split(' ')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        let artist_score = if exact_artist {
            1.0
        } else {
            coverage(&target_artist, &cand_artist_set)
        };
        let title_only_recovery =
            (title_score - 1.0).abs() < f64::EPSILON && !is_short && dur_score >= 0.8 && cand_artist_norm.len() >= 2;
        if !(artist_score >= 0.65 || title_only_recovery) {
            continue;
        }

        let better = match best {
            None => true,
            Some((_, bt, ba, bd)) => {
                title_score > bt
                    || (title_score == bt && (artist_score > ba || (artist_score == ba && dur_score > bd)))
            }
        };
        if better {
            best = Some((idx, title_score, artist_score, dur_score));
        }
    }
    best.map(|b| b.0)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportReviewReason {
    AutoMatched,
    LowConfidenceMatch,
    AmbiguousMatch,
    DurationMismatch,
    NoCatalogCandidates,
    CatalogLookupFailed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SourceTrackInput {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_ms: f64,
    pub artwork_url: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ScoredCandidate {
    pub track: Track,
    pub score: i32,
    pub title_score: f64,
    pub artist_score: f64,
    pub duration_score: f64,
    pub duration_diff_sec: f64,
    pub has_extra_variant: bool,
}

#[derive(Clone, Debug)]
pub struct MatchTrackOutcome {
    pub reason: ImportReviewReason,
    pub score: i32,
    pub best: Option<Track>,
    pub candidates: Vec<Track>,
}

pub fn score_import_candidate(source: &SourceTrackInput, candidate: &Track) -> ScoredCandidate {
    let source_dur_sec = (source.duration_ms / 1000.0).max(0.0);
    let cand_dur_sec = candidate.duration.max(0.0);
    let has_dur = source_dur_sec > 0.0 && cand_dur_sec > 0.0;
    let duration_diff_sec = if has_dur {
        (source_dur_sec - cand_dur_sec).abs()
    } else {
        0.0
    };
    let max_diff_sec = (source_dur_sec * 0.12).max(12.0);
    let duration_score = if has_dur {
        if duration_diff_sec <= max_diff_sec {
            1.0 - duration_diff_sec / max_diff_sec
        } else {
            (0.35 - (duration_diff_sec - max_diff_sec) / 120.0).max(0.0)
        }
    } else {
        0.65
    };

    let target_title = title_tokens(&source.title);
    let cand_title_tokens = title_tokens(&candidate.title);
    let fwd = coverage(&target_title, &cand_title_tokens);
    let rev = coverage(&cand_title_tokens, &target_title);
    let title_score = fwd * 0.72 + rev * 0.28;

    static TOPIC_RE: OnceLock<Regex> = OnceLock::new();
    let topic_re = TOPIC_RE.get_or_init(|| Regex::new(r"(?:\s+topic|\s*vevo)$").unwrap());
    let clean_src_artist = normalize_match(&featured_artist(&source.artist));
    let clean_cand_artist = topic_re
        .replace(&normalize_match(&featured_artist(&candidate.artist)), "")
        .into_owned();
    let cand_title_norm = normalize_match(&candidate.title);

    let exact_artist = clean_src_artist.chars().count() >= 2
        && ((clean_cand_artist.replace(' ', "") == clean_src_artist.replace(' ', "")
            && clean_cand_artist.chars().count() >= 2)
            || (clean_cand_artist.chars().count() >= 2
                && (format!(" {clean_cand_artist} ").contains(&format!(" {clean_src_artist} "))
                    || format!(" {clean_src_artist} ").contains(&format!(" {clean_cand_artist} "))))
            || format!(" {cand_title_norm} ").contains(&format!(" {clean_src_artist} ")));
    let src_set: HashSet<String> = clean_src_artist
        .split(' ')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let cand_set: HashSet<String> = clean_cand_artist
        .split(' ')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let artist_score = if exact_artist {
        1.0
    } else {
        coverage(&src_set, &cand_set)
    };

    let req_variants = variant_words(&normalize_match(&source.title));
    let has_extra_variant = variant_words(&cand_title_norm)
        .iter()
        .any(|v| !req_variants.contains(v));

    let mut raw = (title_score * 0.48 + artist_score * 0.37 + duration_score * 0.15) * 100.0;
    if has_extra_variant {
        raw -= 26.0;
    }
    if title_score < 0.4 {
        raw *= 0.6;
    }
    if artist_score < 0.25 && title_score < 0.9 {
        raw *= 0.65;
    }

    ScoredCandidate {
        track: candidate.clone(),
        score: (raw.round() as i32).clamp(0, 100),
        title_score,
        artist_score,
        duration_score,
        duration_diff_sec,
        has_extra_variant,
    }
}

pub fn classify_match_candidates(
    source: &SourceTrackInput,
    raw_candidates: &[Track],
    lookup_failed: bool,
) -> MatchTrackOutcome {
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for c in raw_candidates {
        if !c.id.is_empty() && seen.insert(c.id.clone()) {
            unique.push(c);
        }
    }
    if unique.is_empty() {
        return MatchTrackOutcome {
            reason: if lookup_failed {
                ImportReviewReason::CatalogLookupFailed
            } else {
                ImportReviewReason::NoCatalogCandidates
            },
            score: 0,
            best: None,
            candidates: Vec::new(),
        };
    }

    let mut scored: Vec<ScoredCandidate> = unique
        .into_iter()
        .map(|c| score_import_candidate(source, c))
        .collect();
    scored.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| b.title_score.partial_cmp(&a.title_score).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| b.artist_score.partial_cmp(&a.artist_score).unwrap_or(std::cmp::Ordering::Equal))
    });

    let top = &scored[0];
    let second = scored.get(1);
    let candidates: Vec<Track> = scored.iter().take(6).map(|s| s.track.clone()).collect();

    if top.score < 32 {
        return MatchTrackOutcome {
            reason: ImportReviewReason::NoCatalogCandidates,
            score: top.score,
            best: Some(top.track.clone()),
            candidates,
        };
    }

    let source_dur_sec = source.duration_ms / 1000.0;
    let max_allowed_diff = (source_dur_sec * 0.16).max(18.0);
    let duration_mismatch =
        source_dur_sec > 0.0 && top.track.duration > 0.0 && top.duration_diff_sec > max_allowed_diff;
    if duration_mismatch && top.title_score >= 0.72 && top.artist_score >= 0.6 {
        return MatchTrackOutcome {
            reason: ImportReviewReason::DurationMismatch,
            score: top.score,
            best: Some(top.track.clone()),
            candidates,
        };
    }

    if let Some(sec) = second
        && top.score - sec.score <= 5 && top.score < 88 && top.score >= 55 {
            return MatchTrackOutcome {
                reason: ImportReviewReason::AmbiguousMatch,
                score: top.score,
                best: Some(top.track.clone()),
                candidates,
            };
        }

    if top.score >= 76
        && !top.has_extra_variant
        && !duration_mismatch
        && top.title_score >= 0.68
        && top.artist_score >= 0.5
    {
        return MatchTrackOutcome {
            reason: ImportReviewReason::AutoMatched,
            score: top.score,
            best: Some(top.track.clone()),
            candidates,
        };
    }

    MatchTrackOutcome {
        reason: ImportReviewReason::LowConfidenceMatch,
        score: top.score,
        best: Some(top.track.clone()),
        candidates,
    }
}

pub fn rank_recommendations<'a>(
    seeds: &[&Track],
    candidates: &'a [Track],
    queued: &HashSet<String>,
    disliked: &HashSet<String>,
    known: &HashSet<String>,
) -> Vec<Track> {
    let words = |s: &str| -> HashSet<String> {
        non_alnum_space_re()
            .split(&s.to_lowercase())
            .filter(|w| w.chars().count() > 1)
            .map(str::to_string)
            .collect()
    };
    let sim = |a: &HashSet<String>, b: &HashSet<String>| -> f64 {
        if a.is_empty() || b.is_empty() {
            return 0.0;
        }
        let shared = a.iter().filter(|w| b.contains(*w)).count();
        shared as f64 / a.len().max(b.len()) as f64
    };

    let seed_ids: HashSet<&str> = seeds.iter().map(|s| s.id.as_str()).collect();
    let seed_titles: HashSet<String> = seeds.iter().map(|s| normalize_match(&s.title)).collect();
    let mut scores: HashMap<&str, f64> = HashMap::new();

    for seed in seeds {
        let seed_title_norm = normalize_match(&seed.title);
        let seed_artist = words(&seed.artist);
        let seed_title_words = words(&seed.title);
        for cand in candidates {
            if cand.id == seed.id || normalize_match(&cand.title) == seed_title_norm {
                continue;
            }
            let artist_score = sim(&seed_artist, &words(&cand.artist));
            let title_score = sim(&seed_title_words, &words(&cand.title));
            let dur_score = if seed.duration > 0.0 && cand.duration > 0.0 {
                1.0 - ((seed.duration - cand.duration).abs() / seed.duration.max(cand.duration)).min(1.0)
            } else {
                0.0
            };
            let score = artist_score * 0.5 + title_score * 0.35 + dur_score * 0.15;
            scores
                .entry(cand.id.as_str())
                .and_modify(|s| *s = s.max(score))
                .or_insert(score);
        }
    }

    let mut ranked: Vec<(usize, f64, &'a Track)> = candidates
        .iter()
        .enumerate()
        .filter(|(_, c)| {
            !seed_ids.contains(c.id.as_str())
                && !seed_titles.contains(&normalize_match(&c.title))
                && !queued.contains(&c.id)
                && !disliked.contains(&c.id)
                && !known.contains(&c.id)
        })
        .map(|(idx, c)| (idx, *scores.get(c.id.as_str()).unwrap_or(&0.0), c))
        .collect();
    ranked.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    ranked.into_iter().map(|(_, _, c)| c.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_track(id: &str, title: &str, artist: &str, dur: f64) -> Track {
        Track {
            id: id.into(),
            title: title.into(),
            artist: artist.into(),
            album: None,
            cover: None,
            thumb: None,
            src: String::new(),
            duration: dur,
            full_duration: None,
            native_id: None,
            preview: None,
            playback: None,
            source: Source::YouTube,
            lyrics: None,
        }
    }

    #[test]
    fn parse_lrc_and_insert_gaps() {
        let lrc = "[00:08.50]First line\n[00:30.00]Second line after long pause\n";
        let lines = with_gaps(parse_lrc(lrc));
        assert!(lines[0].gap);
        assert_eq!(lines[1].text, "First line");
        assert!(lines.iter().any(|l| l.gap && l.t > 10.0));
    }

    #[test]
    fn rejects_false_positive_short_title_with_wrong_artist() {
        let cands = vec![ManualLyricsChoice {
            id: 1,
            track_name: "Самолет".into(),
            artist_name: "Wrong Artist".into(),
            duration: 180.0,
            plain_lyrics: Some("text".into()),
            ..Default::default()
        }];
        assert!(find_lyrics_candidate(&cands, "Самолёт", "Real Artist", 180.0, 4.0).is_none());
    }

    #[test]
    fn fallback_skips_slowed_reverb_unless_requested() {
        let cands = [
            YtCandidate { title: "Midnight City (Slowed + Reverb)", artist: "M83", duration_ms: 243_000.0 },
            YtCandidate { title: "Midnight City", artist: "M83", duration_ms: 243_000.0 },
        ];
        let idx = find_youtube_fallback_candidate_idx("Midnight City", "M83", 243.0, &cands);
        assert_eq!(idx, Some(1));
    }

    #[test]
    fn import_classification_auto_matches_exact_track() {
        let src = SourceTrackInput {
            title: "Starlight".into(),
            artist: "Muse".into(),
            album: None,
            duration_ms: 240_000.0,
            artwork_url: None,
        };
        let cands = vec![mk_track("1", "Starlight", "Muse", 240.0)];
        let outcome = classify_match_candidates(&src, &cands, false);
        assert_eq!(outcome.reason, ImportReviewReason::AutoMatched);
        assert!(outcome.score >= 95);
    }

    #[test]
    fn recommendation_ranking_filters_disliked_and_prefers_same_artist() {
        let seed = mk_track("s1", "Plug In Baby", "Muse", 218.0);
        let cands = vec![
            mk_track("c1", "Unrelated Song", "Other", 120.0),
            mk_track("c2", "Hysteria", "Muse", 227.0),
            mk_track("c3", "Supremacy", "Muse", 295.0),
        ];
        let disliked = HashSet::from(["c3".to_string()]);
        let ranked = rank_recommendations(&[&seed], &cands, &HashSet::new(), &disliked, &HashSet::new());
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].id, "c2");
    }
}
