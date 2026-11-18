//! Word-timed ("karaoke") lyrics from NetEase Cloud Music's YRC format.
//!
//! YRC line: `[lineStartMs,lineDurMs](wordStartMs,wordDurMs,0)Word (…)next …`
//! The catalogue covers a lot of western music too. A match is accepted only when title,
//! artist and duration all agree, because wrong karaoke timing is worse than none.

use serde::Serialize;
use serde_json::Value;

const SEARCH: &str = "https://music.163.com/api/search/get";
const LYRIC: &str = "https://music.163.com/api/song/lyric";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub start_ms: i64,
    pub dur_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WordLine {
    pub start_ms: i64,
    pub words: Vec<Word>,
}

fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| matches!(c as u32, 0x4E00..=0x9FFF | 0x3400..=0x4DBF))
}

/// Credit lines like "作词 : Name" or "Composer : Name" at the top of NetEase lyrics.
fn is_credit_line(text: &str) -> bool {
    let t = text.trim();
    let Some((label, _)) = t.split_once(':').or_else(|| t.split_once('：')) else { return false };
    let label = label.trim();
    label.chars().count() <= 8 && (has_cjk(label) || matches!(label.to_lowercase().as_str(), "lyrics" | "composer" | "producer" | "arranger" | "written by"))
}

pub fn parse_yrc(src: &str) -> Vec<WordLine> {
    let mut out = Vec::new();
    for raw in src.lines() {
        let line = raw.trim();
        if !line.starts_with('[') {
            continue; // JSON metadata lines start with '{'
        }
        let Some(close) = line.find(']') else { continue };
        let Some(start_ms) = line[1..close].split(',').next().and_then(|s| s.trim().parse::<i64>().ok()) else { continue };
        let mut words = Vec::new();
        let mut rest = &line[close + 1..];
        while let Some(open) = rest.find('(') {
            let Some(end) = rest[open..].find(')').map(|e| open + e) else { break };
            let nums: Vec<i64> = rest[open + 1..end].split(',').filter_map(|s| s.trim().parse().ok()).collect();
            let after = &rest[end + 1..];
            let next = after.find('(').unwrap_or(after.len());
            let text = &after[..next];
            if nums.len() >= 2 && !text.is_empty() {
                words.push(Word { start_ms: nums[0], dur_ms: nums[1].max(1), text: text.to_string() });
            }
            rest = &after[next..];
        }
        let full: String = words.iter().map(|w| w.text.as_str()).collect();
        if words.is_empty() || full.trim().is_empty() || is_credit_line(&full) {
            continue;
        }
        out.push(WordLine { start_ms, words });
    }
    out.sort_by_key(|l| l.start_ms);
    out
}

pub fn norm(s: &str) -> String {
    let lowered = s.to_lowercase();
    // Drop bracketed qualifiers: "(Remastered 2009)", "[Live]", "(feat. X)".
    let mut out = String::new();
    let mut depth = 0;
    for c in lowered.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = (depth - 1).max(0),
            _ if depth == 0 => out.push(if c.is_alphanumeric() { c } else { ' ' }),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Picks the NetEase song id that matches title, artist and duration (±3 s).
pub fn pick_song(songs: &[Value], title: &str, artist: &str, duration_ms: i64) -> Option<i64> {
    let want_title = norm(title);
    let want_artist = norm(artist.split([',', '&']).next().unwrap_or(artist));
    if want_title.is_empty() {
        return None;
    }
    songs
        .iter()
        .filter_map(|s| {
            let id = s.get("id")?.as_i64()?;
            let name = norm(s.get("name")?.as_str()?);
            let dur = s.get("duration").and_then(Value::as_i64).unwrap_or(0);
            let artists: Vec<String> = s.get("artists")?.as_array()?.iter().filter_map(|a| a.get("name")?.as_str().map(norm)).collect();
            let artist_ok = artists.iter().any(|a| !a.is_empty() && (a == &want_artist || want_artist.contains(a.as_str()) || a.contains(want_artist.as_str())));
            let dur_diff = (dur - duration_ms).abs();
            (name == want_title && artist_ok && (duration_ms <= 0 || dur_diff <= 3000)).then_some((id, dur_diff))
        })
        .min_by_key(|(_, d)| *d)
        .map(|(id, _)| id)
}

async fn get(http: &reqwest::Client, url: &str, query: &[(&str, String)]) -> Result<Value, String> {
    http.get(url)
        .query(query)
        .header("User-Agent", UA)
        .header("Referer", "https://music.163.com/")
        .timeout(std::time::Duration::from_secs(6))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Plain LRC (`[mm:ss.xx]text`) → one "word" per line spanning until the next line.
pub fn parse_lrc_lines(src: &str) -> Vec<WordLine> {
    let mut stamped: Vec<(i64, String)> = Vec::new();
    for raw in src.lines() {
        let mut rest = raw.trim();
        let mut times = Vec::new();
        while let Some(stripped) = rest.strip_prefix('[') {
            let Some(end) = stripped.find(']') else { break };
            let tag = &stripped[..end];
            let ms = tag.split_once(':').and_then(|(m, s)| Some(m.parse::<i64>().ok()? * 60_000 + (s.parse::<f64>().ok()? * 1000.0) as i64));
            match ms {
                Some(ms) => times.push(ms),
                None => break,
            }
            rest = &stripped[end + 1..];
        }
        let text = rest.trim();
        if text.is_empty() || is_credit_line(text) {
            continue;
        }
        for t in times {
            stamped.push((t, text.to_string()));
        }
    }
    stamped.sort_by_key(|(t, _)| *t);
    let mut out = Vec::new();
    for (i, (t, text)) in stamped.iter().enumerate() {
        let next = stamped.get(i + 1).map_or(t + 4000, |(n, _)| *n);
        out.push(WordLine { start_ms: *t, words: vec![Word { start_ms: *t, dur_ms: (next - t).clamp(1, 8000), text: text.clone() }] });
    }
    out
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseLyrics {
    /// true: real per-word timing; false: line timing only (each line is a single "word").
    pub word_level: bool,
    pub lines: Vec<WordLine>,
}

/// Word-timed lines when available, otherwise NetEase's line-synced lyrics; empty when no trustworthy match.
#[tauri::command]
pub async fn lyrics_word_synced(title: String, artist: String, duration_ms: i64) -> Result<NeteaseLyrics, String> {
    let http = reqwest::Client::new();
    let q = format!("{artist} {title}");
    let found = get(&http, SEARCH, &[("s", q), ("type", "1".into()), ("limit", "10".into())]).await?;
    let songs = found.pointer("/result/songs").and_then(Value::as_array).cloned().unwrap_or_default();
    let Some(id) = pick_song(&songs, &title, &artist, duration_ms) else {
        return Ok(NeteaseLyrics { word_level: false, lines: Vec::new() });
    };
    let lyr = get(&http, LYRIC, &[("id", id.to_string()), ("lv", "1".into()), ("yv", "1".into()), ("tv", "-1".into())]).await?;
    let words = parse_yrc(lyr.pointer("/yrc/lyric").and_then(Value::as_str).unwrap_or_default());
    if !words.is_empty() {
        return Ok(NeteaseLyrics { word_level: true, lines: words });
    }
    let lines = parse_lrc_lines(lyr.pointer("/lrc/lyric").and_then(Value::as_str).unwrap_or_default());
    Ok(NeteaseLyrics { word_level: false, lines })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SAMPLE: &str = "{\"t\":0,\"c\":[{\"tx\":\"meta\"}]}\n\
[0,1000](0,1000,0)作词 : Someone\n\
[30260,2040](30260,480,0)One (30740,480,0)more (31220,1080,0)time\n\
[45920,1770](45920,480,0)We're (46400,450,0)gonna (46850,840,0)celebrate";

    #[test]
    fn parses_words_and_skips_credits_and_json() {
        let lines = parse_yrc(SAMPLE);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].start_ms, 30260);
        assert_eq!(lines[0].words.len(), 3);
        assert_eq!(lines[0].words[0], Word { start_ms: 30260, dur_ms: 480, text: "One ".into() });
        assert_eq!(lines[0].words[2].text, "time");
        assert_eq!(lines[1].words.iter().map(|w| w.text.as_str()).collect::<String>(), "We're gonna celebrate");
    }

    /// Network test: `cargo test --lib lyrics_words -- --ignored`.
    #[test]
    #[ignore]
    fn live_netease_lookup() {
        let res = tauri::async_runtime::block_on(lyrics_word_synced("One More Time".into(), "Daft Punk".into(), 320_000)).unwrap();
        assert!(res.word_level);
        let lines = res.lines;
        assert!(lines.len() > 10, "got {} lines", lines.len());
        assert!(lines.iter().all(|l| !l.words.is_empty()));
        println!("first: {:?}", lines[0]);
    }

    #[test]
    fn parses_plain_lrc_fallback() {
        let l = parse_lrc_lines("[00:00.00] 作词 : X\n[00:10.50]Hello\n[00:12.00][00:20.00]Again\n[bad]skip");
        assert_eq!(l.len(), 3);
        assert_eq!(l[0].start_ms, 10_500);
        assert_eq!(l[0].words[0].dur_ms, 1_500);
        assert_eq!(l[2].words[0].text, "Again");
    }

    #[test]
    fn normalizes_titles() {
        assert_eq!(norm("One More Time (Radio Edit)"), "one more time");
        assert_eq!(norm("Don't Stop  Me-Now [Remastered]"), "don t stop me now");
    }

    #[test]
    fn picks_only_strict_matches() {
        let songs = vec![
            json!({"id": 1, "name": "One More Time", "duration": 320000, "artists": [{"name": "Daft Punk"}]}),
            json!({"id": 2, "name": "One More Time", "duration": 200000, "artists": [{"name": "Cover Band"}]}),
            json!({"id": 3, "name": "One More Time (Live)", "duration": 321500, "artists": [{"name": "Daft Punk"}]}),
        ];
        assert_eq!(pick_song(&songs, "One More Time", "Daft Punk", 321000), Some(3), "closest duration among strict matches");
        assert_eq!(pick_song(&songs, "One More Time", "Daft Punk", 250000), None, "duration too far");
        assert_eq!(pick_song(&songs, "Other Song", "Daft Punk", 320000), None);
        assert_eq!(pick_song(&songs, "One More Time", "Daft Punk, Romanthony", 320000), Some(1));
    }
}
