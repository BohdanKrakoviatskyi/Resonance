//! Small shared helpers for the native backend: error type, tolerant JSON accessors,
//! URL building and capped body reads. Behaviour mirrors the Go sidecar these replace.

use std::fmt;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Serialize;
use serde_json::Value;
use url::Url;

/// SoundCloud rejected the token (401/403) — as opposed to the service being unreachable.
/// The message text is part of the contract: the renderer shows it verbatim.
pub const TOKEN_REJECTED: &str = "SoundCloud отклонил токен, проверьте, что вставлен действующий access token";

pub const NOT_CONNECTED: &str = "сначала подключите аккаунт SoundCloud";

#[derive(Debug, Clone)]
pub enum BErr {
    /// Equivalent of Go's `errTokenRejected` (possibly with a status suffix).
    Rejected(String),
    /// SoundCloud demands a captcha before a like can be changed.
    Captcha(String),
    Msg(String),
}

impl BErr {
    pub fn msg(text: impl Into<String>) -> Self {
        BErr::Msg(text.into())
    }

    pub fn rejected() -> Self {
        BErr::Rejected(TOKEN_REJECTED.to_string())
    }

    pub fn is_rejected(&self) -> bool {
        matches!(self, BErr::Rejected(_))
    }
}

impl fmt::Display for BErr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BErr::Rejected(text) | BErr::Msg(text) => f.write_str(text),
            BErr::Captcha(_) => f.write_str("SoundCloud требует пройти проверку перед изменением лайка"),
        }
    }
}

impl From<String> for BErr {
    fn from(value: String) -> Self {
        BErr::Msg(value)
    }
}

impl From<&str> for BErr {
    fn from(value: &str) -> Self {
        BErr::Msg(value.to_string())
    }
}

pub type BResult<T> = Result<T, BErr>;

// ---- omitempty helpers for serde (`skip_serializing_if`) -------------------------------------

pub fn is_empty_str(value: &str) -> bool {
    value.is_empty()
}

pub fn is_zero(value: &i64) -> bool {
    *value == 0
}

pub fn is_false(value: &bool) -> bool {
    !*value
}

// ---- tolerant JSON accessors -----------------------------------------------------------------
// Go decoded straight into structs where a missing key or an explicit `null` meant the zero
// value. These helpers keep that leniency without a `deserialize_with` on every field.

pub fn vs(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

pub fn vi(v: &Value, key: &str) -> i64 {
    match v.get(key) {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(0),
        _ => 0,
    }
}

pub fn vb(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// Nested object member that is neither missing nor `null`.
pub fn vo<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.get(key).filter(|inner| !inner.is_null())
}

pub fn varr<'a>(v: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    v.get(key).and_then(Value::as_array)
}

pub fn username_of(v: &Value) -> String {
    v.get("user").map(|user| vs(user, "username")).unwrap_or_default()
}

// ---- URLs ------------------------------------------------------------------------------------

/// Go's `url.PathEscape`: unreserved characters and `$&+:=@` stay, `/;,?` and the rest are escaped.
const PATH_SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~')
    .remove(b'$')
    .remove(b'&')
    .remove(b'+')
    .remove(b':')
    .remove(b'=')
    .remove(b'@');

pub fn path_escape(segment: &str) -> String {
    utf8_percent_encode(segment, PATH_SEGMENT).to_string()
}

/// Replaces (or adds) one query parameter, keeping the others.
pub fn set_query(url: &mut Url, key: &str, value: &str) {
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(existing, _)| existing != key)
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let mut pairs = url.query_pairs_mut();
    pairs.clear();
    for (k, v) in &kept {
        pairs.append_pair(k, v);
    }
    pairs.append_pair(key, value);
}

pub fn host_with_port(url: &Url) -> String {
    match (url.host_str(), url.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_string(),
        _ => String::new(),
    }
}

pub fn host_for_log(base: &str) -> &str {
    base.strip_prefix("https://").unwrap_or(base)
}

// ---- strings ---------------------------------------------------------------------------------

/// Removes the OAuth token from text that is about to be logged or shown. Transport errors quote
/// the full request URL, which carries the token.
pub fn scrub_token(text: &str, token: &str) -> String {
    if token.is_empty() {
        text.to_string()
    } else {
        text.replace(token, "<token>")
    }
}

pub fn normalize_artwork(artwork: &str) -> String {
    artwork.replacen("-large.", "-t500x500.", 1).replacen("/large/", "/t500x500/", 1)
}

pub fn track_urn_or_default(urn: &str, id: i64) -> String {
    if urn.is_empty() { format!("soundcloud:tracks:{id}") } else { urn.to_string() }
}

pub fn to_value<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| format!("encode response: {e}"))
}

/// Reads at most `limit` bytes of a response body. Like Go's `io.LimitReader`, an oversized body
/// is cut rather than rejected, so the caller's JSON decode fails on the truncated text.
pub async fn read_limited(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, reqwest::Error> {
    let mut out = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        let room = limit.saturating_sub(out.len());
        if chunk.len() >= room {
            out.extend_from_slice(&chunk[..room]);
            break;
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}
