//! SoundCloud client: every handler here is a port of the matching Go sidecar method.
//!
//! `Sc` is a per-call snapshot of what a request needs (token, client id, account id), taken under
//! a short lock — a slow network call therefore never holds the state lock, which is the same
//! discipline the Go dispatcher enforced with its per-call service clone.

use std::collections::HashSet;

use reqwest::{Client, StatusCode};
use serde_json::Value;
use url::Url;

use super::types::*;
use super::util::*;

pub const OFFICIAL_API_BASE: &str = "https://api.soundcloud.com";
/// Web API v2 — accepts the tokens of a SoundCloud web session.
pub const WEB_API_BASE: &str = "https://api-v2.soundcloud.com";
pub const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

#[derive(Clone)]
pub struct Sc {
    pub http: Client,
    /// Configured API base (`BSC_SOUNDCLOUD_API_BASE`, default the official host).
    pub api_base: String,
    pub token: String,
    pub client_id: String,
    pub user_id: i64,
}

fn web_headers(builder: reqwest::RequestBuilder, token: &str, base_is_web: bool) -> reqwest::RequestBuilder {
    let builder = builder
        .header("Authorization", format!("OAuth {token}"))
        .header("Accept", "application/json")
        .header("User-Agent", USER_AGENT);
    if base_is_web {
        builder.header("Origin", "https://soundcloud.com").header("Referer", "https://soundcloud.com/")
    } else {
        builder
    }
}

impl Sc {
    pub fn require_token(&self) -> BResult<()> {
        if self.token.is_empty() { Err(BErr::msg(NOT_CONNECTED)) } else { Ok(()) }
    }

    /// SoundCloud hosts in the order they are tried. Web-session tokens are served by api-v2,
    /// OAuth tokens of registered apps by the official host, so both are attempted.
    pub fn api_bases(&self) -> Vec<String> {
        let base = self.api_base.trim().trim_end_matches('/');
        if !base.is_empty() && base != OFFICIAL_API_BASE {
            return vec![base.to_string()];
        }
        vec![WEB_API_BASE.to_string(), OFFICIAL_API_BASE.to_string()]
    }

    pub fn v2_url(&self, path: &str, query: &[(&str, &str)]) -> BResult<String> {
        let mut url = Url::parse(&format!("{}{}", WEB_API_BASE.trim_end_matches('/'), path)).map_err(|e| BErr::msg(e.to_string()))?;
        {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in query {
                pairs.append_pair(key, value);
            }
        }
        set_query(&mut url, "client_id", &self.client_id);
        Ok(url.to_string())
    }

    pub fn v2_from_absolute(&self, raw: &str) -> BResult<String> {
        let mut url = Url::parse(raw)
            .ok()
            .filter(|u| u.scheme() == "https" && u.host_str().is_some_and(|h| h.eq_ignore_ascii_case("api-v2.soundcloud.com")))
            .ok_or_else(|| BErr::msg("ожидался HTTPS URL api-v2.soundcloud.com"))?;
        set_query(&mut url, "client_id", &self.client_id);
        Ok(url.to_string())
    }

    pub async fn get_json(&self, endpoint: &str) -> BResult<Value> {
        self.get_json_limit(endpoint, 2 << 20).await
    }

    pub async fn get_json_limit(&self, endpoint: &str, max_bytes: usize) -> BResult<Value> {
        let parsed = Url::parse(endpoint).map_err(|e| BErr::msg(format!("некорректный адрес SoundCloud: {}", scrub_token(&e.to_string(), &self.token))))?;
        // The host is named in errors; the URL itself is never formatted (its query is sensitive).
        let host = parsed.host_str().map(|h| h.to_string()).unwrap_or_else(|| "unknown".into());
        let request = self
            .http
            .get(parsed)
            .header("Authorization", format!("OAuth {}", self.token))
            .header("Accept", "application/json")
            .header("User-Agent", USER_AGENT)
            .header("Origin", "https://soundcloud.com")
            .header("Referer", "https://soundcloud.com/");
        let response = match request.send().await {
            Ok(response) => response,
            Err(e) => {
                log::warn!("soundcloud.api stage=transport_error host={host} error={}", scrub_token(&e.without_url().to_string(), &self.token));
                return Err(BErr::msg(format!("сетевая ошибка при обращении к SoundCloud ({host})")));
            }
        };
        let status = response.status();
        log::debug!("soundcloud.api stage=response host={host} status={}", status.as_u16());
        if status != StatusCode::OK {
            if let Ok(body) = read_limited(response, 4096).await {
                let detail = String::from_utf8_lossy(&body).trim().to_string();
                if !detail.is_empty() {
                    log::warn!("soundcloud.api stage=error_body host={host} body={:?}", scrub_token(&detail, &self.token));
                }
            }
            if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) && !self.token.trim().is_empty() {
                // Every endpoint reached from here needs the session, so a 401/403 is the token
                // being refused, not this particular request: let the backend repair and retry.
                return Err(BErr::Rejected(format!("{TOKEN_REJECTED} (HTTP {})", status.as_u16())));
            }
            return Err(BErr::msg(format!("SoundCloud вернул ошибку HTTP {}", status.as_u16())));
        }
        let body = read_limited(response, max_bytes)
            .await
            .map_err(|e| BErr::msg(format!("ошибка чтения JSON: {}", scrub_token(&e.without_url().to_string(), &self.token))))?;
        serde_json::from_slice(&body).map_err(|e| BErr::msg(format!("ошибка чтения JSON: {}", scrub_token(&e.to_string(), &self.token))))
    }

    // ---- profile / auth -----------------------------------------------------------------------

    pub async fn fetch_profile(&self, token: &str) -> BResult<Profile> {
        let mut last_err: Option<BErr> = None;
        for base in self.api_bases() {
            match self.fetch_profile_from(&base, token).await {
                Ok(user) => return Ok(user),
                Err(e) => last_err = Some(e),
            }
        }
        Err(last_err.unwrap_or_else(|| BErr::msg("SoundCloud недоступен")))
    }

    async fn fetch_profile_from(&self, base: &str, token: &str) -> BResult<Profile> {
        let url = format!("{}/me", base.trim_end_matches('/'));
        let request = web_headers(self.http.get(url), token, base == WEB_API_BASE);
        let response = request
            .send()
            .await
            .map_err(|e| BErr::msg(format!("SoundCloud недоступен, проверьте подключение к интернету: {}", e.without_url())))?;
        match response.status() {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                return Err(BErr::Rejected(format!("{TOKEN_REJECTED} (HTTP {})", response.status().as_u16())));
            }
            StatusCode::TOO_MANY_REQUESTS => return Err(BErr::msg("SoundCloud временно ограничил запросы (HTTP 429), повторите позже")),
            StatusCode::OK => {}
            other => return Err(BErr::msg(format!("SoundCloud вернул HTTP {}", other.as_u16()))),
        }
        let unexpected = || BErr::msg("SoundCloud вернул неожиданный ответ при проверке токена");
        let body = read_limited(response, 1 << 20).await.map_err(|_| unexpected())?;
        let value: Value = serde_json::from_slice(&body).map_err(|_| unexpected())?;
        if vi(&value, "id") == 0 || vs(&value, "username").is_empty() {
            return Err(unexpected());
        }
        Ok(Profile::from_me(&value))
    }

    // ---- the account's own library ------------------------------------------------------------

    /// Likes of the signed-in account (the same endpoint the Python entrypoint displayed).
    pub async fn fetch_my_tracks(&self, token: &str, user_id: i64) -> BResult<Vec<TrackCard>> {
        if user_id == 0 {
            log::warn!("tracks.mine stage=profile error=missing_user_id");
            return Err(BErr::msg("SoundCloud не вернул ID аккаунта для загрузки треков"));
        }
        log::info!("tracks.mine stage=start user_id={user_id}");
        let mut last_err: Option<BErr> = None;
        'bases: for base in self.api_bases() {
            let base_url = Url::parse(&base).ok();
            let mut page_url = format!("{}/users/{user_id}/likes?limit=200&linked_partitioning=true", base.trim_end_matches('/'));
            let mut seen_pages = HashSet::new();
            let mut likes: Vec<Value> = Vec::new();
            let mut page_count = 0;
            while !page_url.is_empty() {
                if page_count >= 250 {
                    last_err = Some(BErr::msg("SoundCloud вернул слишком много страниц лайков (лимит 250)"));
                    continue 'bases;
                }
                let valid = match (Url::parse(&page_url), &base_url) {
                    (Ok(page), Some(base)) => page.scheme() == "https" && host_with_port(&page) == host_with_port(base),
                    _ => false,
                };
                if !valid {
                    last_err = Some(BErr::msg("SoundCloud вернул некорректную ссылку следующей страницы"));
                    continue 'bases;
                }
                if !seen_pages.insert(page_url.clone()) {
                    last_err = Some(BErr::msg("SoundCloud вернул повторяющуюся ссылку страницы лайков"));
                    continue 'bases;
                }
                page_count += 1;
                let request = web_headers(self.http.get(&page_url), token, base == WEB_API_BASE);
                let response = match request.send().await {
                    Ok(response) => response,
                    Err(e) => {
                        let e = e.without_url();
                        last_err = Some(BErr::msg(format!("SoundCloud недоступен, проверьте подключение к интернету: {e}")));
                        log::warn!("tracks.mine stage=response host={} page={page_count} error={e}", host_for_log(&base));
                        continue 'bases;
                    }
                };
                let status = response.status();
                if status != StatusCode::OK {
                    // 401/403 on the first page: this host rejected the token (expired web token or a
                    // token of another kind) — try the next host. Later pages are just reported.
                    last_err = Some(if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) && page_count == 1 {
                        BErr::rejected()
                    } else {
                        BErr::msg(format!("SoundCloud вернул HTTP {} при загрузке страницы лайков {page_count}", status.as_u16()))
                    });
                    log::warn!("tracks.mine stage=http_error host={} page={page_count} status={}", host_for_log(&base), status.as_u16());
                    continue 'bases;
                }
                let data = match read_limited(response, 4 << 20).await {
                    Ok(data) => data,
                    Err(e) => {
                        last_err = Some(BErr::msg(format!("не удалось прочитать страницу лайков: {}", e.without_url())));
                        continue 'bases;
                    }
                };
                let payload: Value = match serde_json::from_slice(&data) {
                    Ok(payload) => payload,
                    Err(e) => {
                        last_err = Some(BErr::msg(format!("не удалось разобрать страницу лайков: {e}")));
                        continue 'bases;
                    }
                };
                if let Some(items) = varr(&payload, "collection") {
                    likes.extend(items.iter().cloned());
                }
                page_url = vs(&payload, "next_href");
            }
            let mut result = Vec::with_capacity(likes.len());
            let mut seen = HashSet::new();
            for like in &likes {
                let Some(track) = vo(like, "track") else { continue };
                let track = ScTrack::parse(track);
                if !seen.insert(track.id) {
                    continue;
                }
                let artwork = if track.artwork_url.contains("-large.") { track.artwork_url.replacen("-large.", "-t500x500.", 1) } else { track.artwork_url.clone() };
                result.push(track.card_with_artwork(artwork));
            }
            log::info!("tracks.mine stage=complete count={} pages={page_count}", result.len());
            return Ok(result);
        }
        let err = last_err.unwrap_or_else(|| BErr::msg("не удалось загрузить треки SoundCloud"));
        log::warn!("tracks.mine stage=failed error={err}");
        Err(err)
    }

    // ---- playlists ----------------------------------------------------------------------------

    pub async fn playlists_mine(&self) -> BResult<Vec<PlaylistCard>> {
        self.require_token()?;
        let user_id = self.user_id;
        if user_id <= 0 {
            return Err(BErr::msg("SoundCloud не вернул ID аккаунта для загрузки плейлистов"));
        }
        let mut last_err: Option<BErr> = None;
        for base in self.api_bases() {
            let mut paths = vec![format!("/users/{user_id}/playlists")];
            if base == WEB_API_BASE {
                paths.insert(0, format!("/users/{user_id}/playlists/liked_and_owned"));
            }
            if base == OFFICIAL_API_BASE {
                paths.insert(0, "/me/playlists".to_string());
            }
            for path in paths {
                let mut endpoint = match Url::parse(&format!("{}{}", base.trim_end_matches('/'), path)) {
                    Ok(endpoint) => endpoint,
                    Err(e) => {
                        last_err = Some(BErr::msg(e.to_string()));
                        continue;
                    }
                };
                set_query(&mut endpoint, "limit", "200");
                set_query(&mut endpoint, "linked_partitioning", "true");
                set_query(&mut endpoint, "client_id", &self.client_id);
                match self.fetch_playlists_from(&base, endpoint.as_str()).await {
                    Ok(playlists) => return Ok(playlists),
                    Err(e) => {
                        log::warn!("playlists.mine stage=fallback host={} path={path} error={e}", host_for_log(&base));
                        last_err = Some(e);
                    }
                }
            }
        }
        let cause = last_err.map(|e| e.to_string()).unwrap_or_else(|| "SoundCloud API не вернул список плейлистов".into());
        Err(BErr::msg(format!("не удалось загрузить плейлисты SoundCloud: {cause}")))
    }

    pub async fn playlist_tracks(&self, playlist_urn: &str) -> BResult<Vec<TrackCard>> {
        self.require_token()?;
        let playlist_urn = playlist_urn.trim();
        if playlist_urn.is_empty() {
            return Err(BErr::msg("у плейлиста отсутствует идентификатор SoundCloud"));
        }
        let playlist_id = playlist_urn.strip_prefix("soundcloud:playlists:").unwrap_or(playlist_urn);
        let mut last_err: Option<BErr> = None;
        for base in self.api_bases() {
            let mut endpoint = match Url::parse(&format!("{}/playlists/{}", base.trim_end_matches('/'), path_escape(playlist_id))) {
                Ok(endpoint) => endpoint,
                Err(e) => {
                    last_err = Some(BErr::msg(e.to_string()));
                    continue;
                }
            };
            set_query(&mut endpoint, "representation", "full");
            set_query(&mut endpoint, "limit", "500");
            set_query(&mut endpoint, "client_id", &self.client_id);
            match self.fetch_playlist_tracks_from(&base, endpoint.as_str()).await {
                Ok(tracks) => return Ok(tracks),
                Err(e) => {
                    log::warn!("playlist.tracks stage=fallback host={} error={e}", host_for_log(&base));
                    last_err = Some(e);
                }
            }
        }
        let cause = last_err.map(|e| e.to_string()).unwrap_or_else(|| "SoundCloud API не вернул треки плейлиста".into());
        Err(BErr::msg(format!("не удалось загрузить треки плейлиста: {cause}")))
    }

    async fn fetch_playlist_tracks_from(&self, base: &str, endpoint: &str) -> BResult<Vec<TrackCard>> {
        let base_url = Url::parse(base.trim_end_matches('/')).map_err(|e| BErr::msg(e.to_string()))?;
        let mut playlist_url = Url::parse(endpoint)
            .ok()
            .filter(|u| u.scheme() == base_url.scheme() && host_with_port(u).eq_ignore_ascii_case(&host_with_port(&base_url)))
            .ok_or_else(|| BErr::msg("SoundCloud вернул некорректный URL плейлиста"))?;
        set_query(&mut playlist_url, "client_id", &self.client_id);
        let payload = self.get_json_limit(playlist_url.as_str(), 16 << 20).await?;
        self.hydrate_playlist_tracks(base, playlist_or_collection_tracks(&payload)).await
    }

    async fn hydrate_playlist_tracks(&self, base: &str, playlist_tracks: Vec<ScTrack>) -> BResult<Vec<TrackCard>> {
        let mut ids = Vec::with_capacity(playlist_tracks.len());
        let mut seen = HashSet::new();
        for track in &playlist_tracks {
            if track.id > 0 && seen.insert(track.id) {
                ids.push(track.id);
            }
        }
        let mut by_id = std::collections::HashMap::with_capacity(ids.len());
        for (batch, chunk) in ids.chunks(50).enumerate() {
            let full = self
                .fetch_tracks_by_ids(base, chunk)
                .await
                .map_err(|e| BErr::msg(format!("не удалось дозагрузить треки плейлиста (пакет {}): {e}", batch + 1)))?;
            for track in full {
                if track.id > 0 && !track.title.is_empty() {
                    by_id.insert(track.id, track);
                }
            }
        }
        Ok(order_cards(&playlist_tracks, &by_id, false))
    }

    async fn fetch_tracks_by_ids(&self, base: &str, ids: &[i64]) -> BResult<Vec<ScTrack>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let base_url = Url::parse(base.trim_end_matches('/')).ok().filter(|u| u.host_str().is_some()).ok_or_else(|| BErr::msg("некорректный адрес SoundCloud API"))?;
        let mut endpoint = base_url.clone();
        endpoint.set_path(&format!("{}/tracks", base_url.path().trim_end_matches('/')));
        endpoint.set_query(None);
        let joined = ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
        set_query(&mut endpoint, "ids", &joined);
        set_query(&mut endpoint, "client_id", &self.client_id);
        let response = self.get_json_limit(endpoint.as_str(), 16 << 20).await?;
        let parse_err = |e: String| BErr::msg(format!("не удалось разобрать список треков SoundCloud: {e}"));
        let items: Vec<Value> = match &response {
            Value::Array(items) => items.clone(),
            Value::Object(_) => match (vo(&response, "collection"), vo(&response, "tracks")) {
                (Some(Value::Array(items)), _) | (None, Some(Value::Array(items))) => items.clone(),
                (None, None) => Vec::new(),
                _ => return Err(parse_err("unexpected tracks shape".into())),
            },
            _ => return Err(BErr::msg("SoundCloud вернул пустой или некорректный список треков")),
        };
        Ok(items.iter().map(ScTrack::parse).collect())
    }

    async fn fetch_playlists_from(&self, base: &str, first_endpoint: &str) -> BResult<Vec<PlaylistCard>> {
        let base_url = Url::parse(base.trim_end_matches('/')).map_err(|e| BErr::msg(e.to_string()))?;
        let mut playlists = Vec::new();
        let mut seen_pages = HashSet::new();
        let mut endpoint = first_endpoint.to_string();
        let mut page = 0;
        while !endpoint.is_empty() {
            if page >= 100 {
                return Err(BErr::msg("SoundCloud вернул слишком много страниц плейлистов (лимит 100)"));
            }
            let mut parsed = Url::parse(&endpoint)
                .ok()
                .filter(|u| u.scheme() == base_url.scheme() && host_with_port(u).eq_ignore_ascii_case(&host_with_port(&base_url)))
                .ok_or_else(|| BErr::msg("SoundCloud вернул некорректную ссылку страницы плейлистов"))?;
            if !seen_pages.insert(endpoint.clone()) {
                return Err(BErr::msg("SoundCloud вернул повторяющуюся ссылку страницы плейлистов"));
            }
            set_query(&mut parsed, "client_id", &self.client_id);
            endpoint = parsed.to_string();
            let payload = self.get_json_limit(&endpoint, 16 << 20).await?;
            for item in varr(&payload, "collection").into_iter().flatten() {
                let source = ScPlaylist::parse(vo(item, "playlist").unwrap_or(item));
                let (playlist_id, playlist_urn) = source.card_ids();
                if playlist_id.is_empty() || source.title.is_empty() {
                    continue;
                }
                let mut artwork = normalize_artwork(&source.artwork_url);
                if artwork.is_empty()
                    && let Some(first) = source.tracks.first() {
                        artwork = normalize_artwork(&first.artwork_url);
                    }
                if artwork.is_empty() && source.id > 0 {
                    match self.fetch_first_playlist_track_artwork(base, source.id).await {
                        Ok(fallback) => artwork = fallback,
                        Err(e) => log::warn!("playlists.mine stage=cover_fallback playlist_id={} error={e}", source.id),
                    }
                }
                playlists.push(PlaylistCard {
                    id: playlist_id,
                    urn: playlist_urn,
                    title: source.title.clone(),
                    permalink_url: source.permalink_url.clone(),
                    artwork_url: artwork,
                    track_count: source.track_count,
                    user: UserName { username: source.username.clone() },
                });
            }
            endpoint = vs(&payload, "next_href");
            page += 1;
        }
        Ok(playlists)
    }

    async fn fetch_first_playlist_track_artwork(&self, base: &str, playlist_id: i64) -> BResult<String> {
        let base_url = Url::parse(base.trim_end_matches('/')).ok().filter(|u| u.host_str().is_some() && playlist_id > 0).ok_or_else(|| BErr::msg("некорректный адрес или ID плейлиста"))?;
        let mut endpoint = base_url.clone();
        endpoint.set_path(&format!("{}/playlists/{playlist_id}", base_url.path().trim_end_matches('/')));
        endpoint.set_query(None);
        set_query(&mut endpoint, "representation", "full");
        set_query(&mut endpoint, "limit", "5");
        set_query(&mut endpoint, "client_id", &self.client_id);
        let payload = self.get_json_limit(endpoint.as_str(), 16 << 20).await?;
        let tracks = playlist_or_collection_tracks(&payload);
        let Some(first) = tracks.first() else { return Ok(String::new()) };
        let artwork = normalize_artwork(&first.artwork_url);
        if !artwork.is_empty() {
            return Ok(artwork);
        }
        if first.id <= 0 {
            return Ok(String::new());
        }
        for track in self.fetch_tracks_by_ids(base, &[first.id]).await? {
            if track.id == first.id {
                return Ok(normalize_artwork(&track.artwork_url));
            }
        }
        Ok(String::new())
    }

    // ---- single track / search ----------------------------------------------------------------

    pub async fn search_tracks(&self, query: &str) -> BResult<Vec<SearchTrack>> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        self.require_token()?;
        let endpoint = self.v2_url("/search/tracks", &[("q", query), ("limit", "5")]).map_err(|e| BErr::msg(format!("не удалось сформировать запрос поиска: {e}")))?;
        let response = self.get_json(&endpoint).await.map_err(|e| {
            log::warn!("tracks.search stage=failed error={e}");
            e.context(|d| format!("поиск SoundCloud не выполнен: {d}"))
        })?;
        let mut results = Vec::new();
        for item in varr(&response, "collection").into_iter().flatten() {
            let user = item.get("user").cloned().unwrap_or(Value::Null);
            let mut artwork = vs(item, "artwork_url");
            if artwork.is_empty() {
                artwork = vs(&user, "avatar_url");
            }
            if !artwork.is_empty() {
                artwork = artwork.replacen("-large.", "-t300x300.", 1);
            }
            let id = vi(item, "id");
            results.push(SearchTrack {
                id,
                urn: track_urn_or_default(&vs(item, "urn"), id),
                title: vs(item, "title"),
                permalink_url: vs(item, "permalink_url"),
                artwork_url: artwork,
                duration: vi(item, "duration"),
                user: SearchUser { username: vs(&user, "username"), avatar_url: vs(&user, "avatar_url") },
                publisher_artist: publisher_artist_of(item),
            });
        }
        Ok(results)
    }

    pub async fn track_related(&self, track_id: i64) -> BResult<Vec<SearchTrack>> {
        self.require_token()?;
        if track_id <= 0 {
            return Err(BErr::msg("некорректный ID трека"));
        }
        let endpoint = self.v2_url(&format!("/tracks/{track_id}/related"), &[("limit", "10")]).map_err(|e| BErr::msg(format!("не удалось сформировать запрос похожих треков: {e}")))?;
        let response = self.get_json(&endpoint).await.map_err(|e| {
            log::warn!("track.related stage=failed track_id={track_id} error={e}");
            e.context(|d| format!("не удалось загрузить похожие треки: {d}"))
        })?;
        Ok(varr(&response, "collection")
            .into_iter()
            .flatten()
            .map(|item| {
                let user = item.get("user").cloned().unwrap_or(Value::Null);
                let mut t = normalize_search_track(vi(item, "id"), &vs(item, "urn"), &vs(item, "title"), &vs(item, "permalink_url"), &vs(item, "artwork_url"), &vs(&user, "avatar_url"), vi(item, "duration"), &vs(&user, "username"));
                t.publisher_artist = publisher_artist_of(item);
                t
            })
            .collect())
    }
}

/// Cards for `ordered` tracks, preferring the fully hydrated copy when one was fetched. With
/// `trim_title` the "hydrated copy must have a non-blank title" check also trims whitespace.
pub fn order_cards(original: &[ScTrack], by_id: &std::collections::HashMap<i64, ScTrack>, trim_title: bool) -> Vec<TrackCard> {
    let mut ordered = Vec::with_capacity(original.len());
    for track in original {
        if track.id <= 0 {
            continue;
        }
        let chosen = match by_id.get(&track.id) {
            Some(full) => full,
            None => {
                if track.title.trim().is_empty() {
                    continue;
                }
                track
            }
        };
        let blank = if trim_title { chosen.title.trim().is_empty() } else { chosen.title.is_empty() };
        if blank {
            continue;
        }
        ordered.push(chosen.card());
    }
    ordered
}

pub fn normalize_search_track(id: i64, urn: &str, title: &str, permalink_url: &str, artwork_url: &str, avatar_url: &str, duration: i64, username: &str) -> SearchTrack {
    let mut artwork = if artwork_url.is_empty() { avatar_url.to_string() } else { artwork_url.to_string() };
    if !artwork.is_empty() {
        artwork = artwork.replacen("-large.", "-t300x300.", 1);
    }
    SearchTrack {
        id,
        urn: track_urn_or_default(urn, id),
        title: title.to_string(),
        permalink_url: permalink_url.to_string(),
        artwork_url: artwork,
        duration,
        user: SearchUser { username: username.to_string(), avatar_url: avatar_url.to_string() },
        publisher_artist: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sc() -> Sc {
        Sc { http: Client::new(), api_base: OFFICIAL_API_BASE.into(), token: "secret-token".into(), client_id: "client123".into(), user_id: 7 }
    }

    #[test]
    fn api_bases_try_web_then_official_unless_overridden() {
        assert_eq!(sc().api_bases(), vec![WEB_API_BASE.to_string(), OFFICIAL_API_BASE.to_string()]);
        let custom = Sc { api_base: "http://localhost:9999/".into(), ..sc() };
        assert_eq!(custom.api_bases(), vec!["http://localhost:9999".to_string()]);
    }

    #[test]
    fn v2_urls_carry_client_id_and_reject_foreign_hosts() {
        let url = sc().v2_url("/search/tracks", &[("q", "a b"), ("limit", "5")]).unwrap();
        assert!(url.starts_with("https://api-v2.soundcloud.com/search/tracks?"));
        assert!(url.contains("q=a+b") && url.contains("limit=5") && url.contains("client_id=client123"));
        assert!(sc().v2_from_absolute("https://evil.example.com/x").is_err());
        assert!(sc().v2_from_absolute("http://api-v2.soundcloud.com/x").is_err());
        assert!(sc().v2_from_absolute("https://api-v2.soundcloud.com/x?client_id=old").unwrap().ends_with("client_id=client123"));
    }

    #[test]
    fn path_escape_matches_go() {
        assert_eq!(path_escape("soundcloud:tracks:123"), "soundcloud:tracks:123");
        assert_eq!(path_escape("a/b c"), "a%2Fb%20c");
    }
}
