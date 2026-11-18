//! SoundCloud client: every handler here is a port of the matching Go sidecar method.
//!
//! `Sc` is a per-call snapshot of what a request needs (token, client id, account id), taken under
//! a short lock — a slow network call therefore never holds the state lock, which is the same
//! discipline the Go dispatcher enforced with its per-call service clone.

use std::collections::HashSet;

use reqwest::{Client, Method, StatusCode};
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

    fn require_user(&self, user_id: i64) -> BResult<()> {
        self.require_token()?;
        if user_id <= 0 {
            return Err(BErr::msg("некорректный ID пользователя"));
        }
        Ok(())
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
                if artwork.is_empty() {
                    if let Some(first) = source.tracks.first() {
                        artwork = normalize_artwork(&first.artwork_url);
                    }
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

    pub async fn track_details(&self, track_id: i64) -> BResult<TrackDetails> {
        self.require_token()?;
        if track_id <= 0 {
            return Err(BErr::msg("некорректный ID трека"));
        }
        let endpoint = self.v2_url(&format!("/tracks/{track_id}"), &[]).map_err(|e| BErr::msg(format!("не удалось сформировать запрос деталей трека: {e}")))?;
        let track = self.get_json(&endpoint).await.map_err(|e| {
            log::warn!("track.details stage=failed track_id={track_id} error={e}");
            BErr::msg(format!("не удалось загрузить информацию о треке из SoundCloud: {e}"))
        })?;
        let user = track.get("user").cloned().unwrap_or(Value::Null);
        let mut artwork = vs(&track, "artwork_url");
        if !artwork.is_empty() {
            artwork = artwork.replacen("-large.", "-t500x500.", 1).replacen("/large/", "/t500x500/", 1);
        }
        Ok(TrackDetails {
            id: vi(&track, "id"),
            urn: vs(&track, "urn"),
            title: vs(&track, "title"),
            permalink_url: vs(&track, "permalink_url"),
            artwork_url: artwork,
            description: vs(&track, "description"),
            genre: vs(&track, "genre"),
            tag_list: vs(&track, "tag_list"),
            duration: vi(&track, "duration"),
            playback_count: vi(&track, "playback_count"),
            likes_count: vi(&track, "likes_count"),
            reposts_count: vi(&track, "reposts_count"),
            comment_count: vi(&track, "comment_count"),
            created_at: vs(&track, "created_at"),
            display_date: vs(&track, "display_date"),
            waveform_url: vs(&track, "waveform_url"),
            user: TrackDetailsUser {
                id: vi(&user, "id"),
                username: vs(&user, "username"),
                avatar_url: vs(&user, "avatar_url"),
                permalink_url: vs(&user, "permalink_url"),
                followers_count: vi(&user, "followers_count"),
            },
        })
    }

    pub async fn search_tracks(&self, query: &str) -> BResult<Vec<SearchTrack>> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        self.require_token()?;
        let endpoint = self.v2_url("/search/tracks", &[("q", query), ("limit", "5")]).map_err(|e| BErr::msg(format!("не удалось сформировать запрос поиска: {e}")))?;
        let response = self.get_json(&endpoint).await.map_err(|e| {
            log::warn!("tracks.search stage=failed error={e}");
            BErr::msg(format!("поиск SoundCloud не выполнен: {e}"))
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
            BErr::msg(format!("не удалось загрузить похожие треки: {e}"))
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

    // ---- other users --------------------------------------------------------------------------

    pub async fn user_profile(&self, user_id: i64) -> BResult<UserProfile> {
        self.require_user(user_id)?;
        let endpoint = self.v2_url(&format!("/users/{user_id}"), &[]).map_err(|e| BErr::msg(format!("не удалось сформировать запрос профиля: {e}")))?;
        let user = self.get_json(&endpoint).await.map_err(|e| {
            log::warn!("user.profile stage=failed user_id={user_id} error={e}");
            BErr::msg(format!("не удалось загрузить профиль автора: {e}"))
        })?;
        let mut avatar = vs(&user, "avatar_url");
        if !avatar.is_empty() {
            avatar = avatar.replacen("-large.", "-t500x500.", 1);
        }
        let mut banner = String::new();
        if let Some(visual) = vo(&user, "visuals").and_then(|v| varr(v, "visuals")).and_then(|items| items.first()) {
            banner = vs(visual, "visual_url");
            if banner.is_empty() {
                banner = visual.get("urls").map(|urls| vs(urls, "url")).unwrap_or_default();
            }
        }
        Ok(UserProfile {
            id: vi(&user, "id"),
            username: vs(&user, "username"),
            full_name: vs(&user, "full_name"),
            permalink_url: vs(&user, "permalink_url"),
            avatar_url: avatar,
            banner_url: banner,
            description: vs(&user, "description"),
            city: vs(&user, "city"),
            country: vs(&user, "country_code"),
            followers_count: vi(&user, "followers_count"),
            followings_count: vi(&user, "followings_count"),
            track_count: vi(&user, "track_count"),
            likes_count: vi(&user, "likes_count"),
            verified: vb(&user, "verified"),
        })
    }

    pub async fn user_tracks(&self, user_id: i64) -> BResult<Vec<TrackCard>> {
        self.require_user(user_id)?;
        let mut endpoint = self
            .v2_url(&format!("/users/{user_id}/tracks"), &[("limit", "200"), ("linked_partitioning", "1")])
            .map_err(|e| BErr::msg(format!("не удалось сформировать запрос треков автора: {e}")))?;
        let mut result = Vec::with_capacity(200);
        let mut seen_tracks = HashSet::new();
        let mut seen_pages = HashSet::new();
        let mut page_count = 0;
        while !endpoint.is_empty() && page_count < 100 {
            if !seen_pages.insert(endpoint.clone()) {
                break;
            }
            page_count += 1;
            let page = self.get_json(&endpoint).await.map_err(|e| {
                log::warn!("user.tracks stage=failed user_id={user_id} page={page_count} error={e}");
                BErr::msg(format!("не удалось загрузить треки автора: {e}"))
            })?;
            for raw in varr(&page, "collection").into_iter().flatten() {
                let track = ScTrack::parse(raw);
                if !seen_tracks.insert(track.id) {
                    continue;
                }
                let artwork = if track.artwork_url.is_empty() { String::new() } else { track.artwork_url.replacen("-large.", "-t500x500.", 1) };
                result.push(track.card_with_artwork(artwork));
            }
            let next = vs(&page, "next_href");
            if next.is_empty() {
                break;
            }
            endpoint = self.v2_from_absolute(&next).map_err(|e| BErr::msg(format!("SoundCloud вернул некорректную ссылку следующей страницы: {e}")))?;
        }
        Ok(result)
    }

    pub async fn user_likes(&self, user_id: i64, next: &str) -> BResult<TrackPage> {
        self.require_user(user_id)?;
        let mut endpoint = self
            .v2_url(&format!("/users/{user_id}/likes"), &[("limit", "20"), ("linked_partitioning", "1")])
            .map_err(|e| BErr::msg(format!("не удалось сформировать запрос лайков: {e}")))?;
        if !next.is_empty() {
            endpoint = self.v2_from_absolute(next).map_err(|e| BErr::msg(format!("некорректная ссылка следующей страницы лайков: {e}")))?;
        }
        let response = self.get_json(&endpoint).await.map_err(|e| BErr::msg(format!("не удалось загрузить публичные лайки автора: {e}")))?;
        let mut result = TrackPage { tracks: Vec::with_capacity(20), next_href: String::new() };
        let mut seen = HashSet::new();
        for item in varr(&response, "collection").into_iter().flatten() {
            let track = match vo(item, "track") {
                Some(inner) => ScTrack::parse(inner),
                None => {
                    let direct = ScTrack::parse(item);
                    if direct.id == 0 {
                        continue;
                    }
                    direct
                }
            };
            if !seen.insert(track.id) {
                continue;
            }
            let artwork = track.artwork_url.replacen("-large.", "-t500x500.", 1);
            result.tracks.push(track.card_with_artwork(artwork));
        }
        let next_href = vs(&response, "next_href");
        if !next_href.is_empty() {
            result.next_href = self
                .v2_from_absolute(&next_href)
                .map_err(|e| BErr::msg(format!("SoundCloud вернул некорректную ссылку следующей страницы лайков: {e}")))?;
        }
        Ok(result)
    }

    pub async fn user_social(&self, user_id: i64, next: &str, relation: &str) -> BResult<SocialPage> {
        self.require_user(user_id)?;
        let mut endpoint = self
            .v2_url(&format!("/users/{user_id}/{relation}"), &[("limit", "50"), ("linked_partitioning", "1")])
            .map_err(|e| BErr::msg(format!("не удалось сформировать запрос списка: {e}")))?;
        if !next.is_empty() {
            endpoint = self.v2_from_absolute(next).map_err(|e| BErr::msg(format!("некорректная ссылка следующей страницы: {e}")))?;
        }
        let source = self.get_json(&endpoint).await.map_err(|e| BErr::msg(format!("не удалось загрузить список {relation}: {e}")))?;
        let first_nonempty = |values: [String; 3]| values.into_iter().find(|v| !v.is_empty()).unwrap_or_default();
        let first_nonzero = |a: i64, b: i64| if a != 0 { a } else { b };
        let collection = varr(&source, "collection")
            .into_iter()
            .flatten()
            .map(|user| SocialUser {
                id: vi(user, "id"),
                username: vs(user, "username"),
                full_name: vs(user, "full_name"),
                permalink_url: vs(user, "permalink_url"),
                avatar_url: first_nonempty([vs(user, "avatar_url"), vs(user, "avatarUrl"), vs(user, "avatar")]),
                followers_count: first_nonzero(vi(user, "followers_count"), vi(user, "followersCount")),
                followings_count: first_nonzero(vi(user, "followings_count"), vi(user, "followingsCount")),
                track_count: vi(user, "track_count"),
            })
            .collect();
        Ok(SocialPage { collection, next_href: vs(&source, "next_href") })
    }

    pub async fn user_playlists(&self, user_id: i64) -> BResult<Vec<PlaylistCard>> {
        self.require_user(user_id)?;
        let mut last_err: Option<BErr> = None;
        for base in self.api_bases() {
            let mut endpoint = match Url::parse(&format!("{}/users/{user_id}/playlists", base.trim_end_matches('/'))) {
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
                    log::warn!("user.playlists stage=fallback host={} error={e}", host_for_log(&base));
                    last_err = Some(e);
                }
            }
        }
        let cause = last_err.map(|e| e.to_string()).unwrap_or_else(|| "SoundCloud API не вернул плейлисты автора".into());
        Err(BErr::msg(format!("не удалось загрузить плейлисты автора: {cause}")))
    }

    // ---- "mixed selections" (home recommendations) --------------------------------------------

    pub async fn mixed_selections(&self) -> BResult<Vec<MixedSelection>> {
        self.require_token()?;
        let endpoint = self.v2_url("/mixed-selections", &[]).map_err(|e| BErr::msg(format!("не удалось сформировать запрос подборок: {e}")))?;
        let response = self.get_json(&endpoint).await.map_err(|e| {
            log::warn!("mixed-selections stage=failed error={e}");
            BErr::msg(format!("не удалось загрузить подборки SoundCloud: {e}"))
        })?;
        let mut selections = Vec::new();
        for (index, item) in varr(&response, "collection").into_iter().flatten().enumerate() {
            let payloads = item.get("items").map(mixed_item_payloads).unwrap_or_default();
            let id = vs(item, "id");
            let title = vs(item, "title");
            let made_for_you = is_made_for_you(&id, &title);
            let mut selection = MixedSelection {
                id: if id.is_empty() { format!("selection-{index}") } else { id },
                title,
                description: vs(item, "description"),
                tracks: Vec::with_capacity(payloads.len()),
                playlists: Vec::new(),
                made_for_you,
            };
            if selection.made_for_you && selection.title.is_empty() {
                selection.title = "Made for you".into();
            }
            let mut seen_tracks = HashSet::new();
            let mut seen_playlists = HashSet::new();
            for raw in &payloads {
                if let Some(playlist) = decode_mixed_playlist(raw) {
                    if seen_playlists.insert(playlist.id.clone()) {
                        selection.playlists.push(playlist);
                    }
                    continue;
                }
                let Some(candidate) = decode_mixed_track(raw) else { continue };
                if !seen_tracks.insert(vi(&candidate, "id")) {
                    continue;
                }
                let user = candidate.get("user").cloned().unwrap_or(Value::Null);
                let mut track = normalize_search_track(
                    vi(&candidate, "id"),
                    &vs(&candidate, "urn"),
                    &vs(&candidate, "title"),
                    &vs(&candidate, "permalink_url"),
                    &vs(&candidate, "artwork_url"),
                    &vs(&user, "avatar_url"),
                    vi(&candidate, "duration"),
                    &vs(&user, "username"),
                );
                track.publisher_artist = publisher_artist_of(&candidate);
                selection.tracks.push(track);
            }
            if !selection.title.is_empty() && (!selection.tracks.is_empty() || !selection.playlists.is_empty()) {
                selections.push(selection);
            }
        }
        Ok(selections)
    }

    // ---- likes --------------------------------------------------------------------------------

    pub async fn set_track_liked(&self, track_id: i64, track_urn: &str, liked: bool, datadome_cookie: &str) -> BResult<TrackLikeResult> {
        let result = self.set_track_liked_inner(track_id, track_urn, liked, datadome_cookie).await;
        match result {
            Ok(()) => Ok(TrackLikeResult { liked, captcha_url: String::new() }),
            Err(BErr::Captcha(url)) => Ok(TrackLikeResult { liked: !liked, captcha_url: url }),
            Err(e) => Err(e),
        }
    }

    async fn set_track_liked_inner(&self, track_id: i64, track_urn: &str, liked: bool, datadome_cookie: &str) -> BResult<()> {
        let action = if liked { "like" } else { "unlike" };
        if self.token.is_empty() {
            log::warn!("track.{action} stage=auth_error track_id={track_id}");
            return Err(BErr::msg(NOT_CONNECTED));
        }
        if track_id <= 0 {
            return Err(BErr::msg("некорректный ID трека"));
        }
        let track_urn = if track_urn.trim().is_empty() { format!("soundcloud:tracks:{track_id}") } else { track_urn.to_string() };
        if datadome_cookie.len() > 4096 || datadome_cookie.chars().any(|c| (c as u32) < 0x21 || (c as u32) > 0x7e || ";,\\\"".contains(c)) {
            return Err(BErr::msg("некорректная cookie проверки SoundCloud"));
        }
        let method = if liked { Method::POST } else { Method::DELETE };
        let mut attempts: Vec<String> = Vec::new();
        let mut last_err: Option<BErr> = None;
        let mut bases = self.api_bases();
        bases.truncate(1);
        for base in bases {
            let mut request_method = method.clone();
            let is_web_api = base == WEB_API_BASE || (!self.api_base.is_empty() && self.api_base != OFFICIAL_API_BASE && base == self.api_base);
            let mut endpoint = format!("{}/likes/tracks/{}", base.trim_end_matches('/'), path_escape(&track_urn));
            if is_web_api {
                if self.user_id <= 0 {
                    return Err(BErr::msg("не удалось определить ID аккаунта SoundCloud для изменения лайка"));
                }
                let mut parsed = Url::parse(&format!("{}/users/{}/track_likes/{track_id}", base.trim_end_matches('/'), self.user_id)).map_err(|e| BErr::msg(e.to_string()))?;
                set_query(&mut parsed, "client_id", &self.client_id);
                endpoint = parsed.to_string();
                if liked {
                    request_method = Method::PUT;
                }
            }
            log::info!("track.{action} stage=request host={} track_id={track_id} method={request_method}", host_for_log(&base));
            let mut request = self
                .http
                .request(request_method, &endpoint)
                .header("Authorization", format!("OAuth {}", self.token))
                .header("Accept", "application/json")
                .header("User-Agent", USER_AGENT);
            if !datadome_cookie.is_empty() {
                request = request.header("Cookie", format!("datadome={datadome_cookie}")).header("X-Datadome-ClientId", datadome_cookie);
            }
            if base == WEB_API_BASE {
                request = request.header("Origin", "https://soundcloud.com").header("Referer", "https://soundcloud.com/");
            }
            let response = match request.send().await {
                Ok(response) => response,
                Err(e) => {
                    let e = e.without_url();
                    log::warn!("track.{action} stage=transport_error host={} track_id={track_id} error={e}", host_for_log(&base));
                    last_err = Some(BErr::msg(format!("SoundCloud недоступен, проверьте подключение к интернету: {e}")));
                    continue;
                }
            };
            let status = response.status();
            let location = response.headers().get("Location").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            let body = read_limited(response, 4096).await.unwrap_or_default();
            let mut body_text = String::from_utf8_lossy(&body).trim().to_string();
            if !self.token.is_empty() {
                body_text = body_text.replace(&self.token, "[redacted]");
            }
            body_text = body_text.split_whitespace().collect::<Vec<_>>().join(" ");
            let mut challenge_url = String::new();
            if status == StatusCode::FORBIDDEN {
                challenge_url = extract_captcha_url(&location, &body);
                if !challenge_url.is_empty() {
                    body_text = "[captcha challenge response; URL omitted]".into();
                }
            }
            if body_text.chars().count() > 600 {
                body_text = format!("{}…", body_text.chars().take(600).collect::<String>());
            }
            log::info!("track.{action} stage=response host={} track_id={track_id} status={} body={body_text:?}", host_for_log(&base), status.as_u16());
            if !challenge_url.is_empty() {
                log::info!("track.{action} stage=captcha_challenge track_id={track_id}");
                return Err(BErr::Captcha(challenge_url));
            }
            if status.is_success() {
                return Ok(());
            }
            let describe = |code: u16| {
                let mut message = format!("{} вернул HTTP {code}", host_for_log(&base));
                if !body_text.is_empty() {
                    message.push_str(": ");
                    message.push_str(&body_text);
                }
                message
            };
            match status {
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                    let message = describe(status.as_u16());
                    last_err = Some(BErr::msg(format!("SoundCloud отклонил запрос изменения лайка: {message}")));
                    attempts.push(message);
                }
                StatusCode::TOO_MANY_REQUESTS => {
                    last_err = Some(BErr::msg("SoundCloud временно ограничил запросы (HTTP 429), повторите позже"));
                    attempts.push(format!("{} вернул HTTP 429", host_for_log(&base)));
                }
                _ => {
                    let message = describe(status.as_u16());
                    last_err = Some(BErr::msg(format!("SoundCloud вернул ошибку при изменении лайка: {message}")));
                    attempts.push(message);
                }
            }
        }
        if attempts.len() > 1 {
            last_err = Some(BErr::msg(format!("изменить лайк не удалось: {}", attempts.join("; "))));
        }
        let err = last_err.unwrap_or_else(|| BErr::msg("не удалось изменить лайк SoundCloud"));
        log::warn!("track.{action} stage=failed track_id={track_id} error={err}");
        Err(err)
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

// ---- mixed selection decoding ------------------------------------------------------------------

fn is_made_for_you(id: &str, title: &str) -> bool {
    let id = id.to_lowercase();
    let title = title.trim().to_lowercase();
    id.contains("discovery") || id.contains("personalized") || id.contains("personalised") || title.contains("made for you") || title.contains("специально для вас")
}

const NESTED_PLAYLIST_KEYS: [&str; 4] = ["playlist", "resource", "item", "data"];

fn decode_mixed_playlist(raw: &Value) -> Option<PlaylistCard> {
    let object = raw.as_object()?;
    let item_type = object.get("type").and_then(Value::as_str).unwrap_or("");
    if item_type == "playlist" || item_type == "system-playlist" {
        for key in NESTED_PLAYLIST_KEYS {
            if let Some(nested) = object.get(key) {
                if let Some(source) = decode_playlist_source(nested) {
                    return mixed_playlist_card(&source);
                }
            }
        }
        return decode_playlist_source(raw).and_then(|source| mixed_playlist_card(&source));
    }
    for key in NESTED_PLAYLIST_KEYS {
        if let Some(nested) = object.get(key) {
            if let Some(playlist) = decode_mixed_playlist(nested) {
                return Some(playlist);
            }
        }
    }
    let source = decode_playlist_source(raw)?;
    if !source.urn.contains("soundcloud:playlists:") && !ScPlaylist::is_album_key_present(raw) {
        return None;
    }
    mixed_playlist_card(&source)
}

fn decode_playlist_source(raw: &Value) -> Option<ScPlaylist> {
    if !raw.is_object() {
        return None;
    }
    let playlist = ScPlaylist::parse(raw);
    if playlist.title.is_empty() || (playlist.id <= 0 && playlist.urn.is_empty()) { None } else { Some(playlist) }
}

fn mixed_playlist_card(source: &ScPlaylist) -> Option<PlaylistCard> {
    let (id, urn) = source.card_ids();
    if id.is_empty() || source.title.is_empty() {
        return None;
    }
    Some(PlaylistCard {
        id,
        urn,
        title: source.title.clone(),
        permalink_url: source.permalink_url.clone(),
        artwork_url: normalize_artwork(&source.artwork_url),
        track_count: source.track_count,
        user: UserName { username: source.username.clone() },
    })
}

fn mixed_item_payloads(raw: &Value) -> Vec<Value> {
    match raw {
        Value::Array(items) => items.clone(),
        Value::Object(object) => {
            for key in ["collection", "items", "tracks", "data"] {
                if let Some(nested) = object.get(key) {
                    let items = mixed_item_payloads(nested);
                    if !items.is_empty() {
                        return items;
                    }
                }
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn decode_mixed_track(raw: &Value) -> Option<Value> {
    let object = raw.as_object()?;
    let item_type = object.get("type").and_then(Value::as_str).unwrap_or("");
    if item_type == "playlist" || item_type == "system-playlist" {
        return None;
    }
    if vi(raw, "id") > 0 && !vs(raw, "title").is_empty() {
        return Some(raw.clone());
    }
    for key in ["track", "item", "resource", "data"] {
        if let Some(nested) = object.get(key) {
            if let Some(found) = decode_mixed_track(nested) {
                return Some(found);
            }
        }
    }
    None
}

// ---- captcha challenge extraction --------------------------------------------------------------

fn safe_challenge_url(candidate: &str) -> String {
    match Url::parse(candidate.trim()) {
        Ok(url) if url.scheme() == "https" && url.host_str().is_some_and(|h| !h.is_empty()) && url.username().is_empty() && url.password().is_none() => url.to_string(),
        _ => String::new(),
    }
}

fn find_challenge_url(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            for (key, nested) in map {
                let name = key.to_lowercase().replace(['_', '-'], "");
                if let Some(candidate) = nested.as_str() {
                    if name == "url" || name == "location" || name == "redirect" || name.contains("captcha") || name.contains("challenge") {
                        let safe = safe_challenge_url(candidate);
                        if !safe.is_empty() {
                            return safe;
                        }
                    }
                }
                let safe = find_challenge_url(nested);
                if !safe.is_empty() {
                    return safe;
                }
            }
            String::new()
        }
        Value::Array(items) => items.iter().map(find_challenge_url).find(|s| !s.is_empty()).unwrap_or_default(),
        _ => String::new(),
    }
}

/// Finds the captcha URL in a 403: the `Location` header, a JSON field, or any https URL in the text.
pub fn extract_captcha_url(location: &str, body: &[u8]) -> String {
    let from_header = safe_challenge_url(location);
    if !from_header.is_empty() {
        return from_header;
    }
    if let Ok(payload) = serde_json::from_slice::<Value>(body) {
        let found = find_challenge_url(&payload);
        if !found.is_empty() {
            return found;
        }
    }
    let text = String::from_utf8_lossy(body).into_owned();
    let mut remaining = text.as_str();
    loop {
        let Some(start) = remaining.find("https://") else { return String::new() };
        remaining = &remaining[start..];
        let end = remaining.find([' ', '\t', '\r', '\n', '"', '\'', '<', '>', ']']);
        let candidate = match end {
            Some(end) => &remaining[..end],
            None => remaining,
        };
        let candidate = candidate.trim_end_matches([',', '.', ';', ':', ')']);
        let safe = safe_challenge_url(candidate);
        if !safe.is_empty() {
            return safe;
        }
        match end {
            Some(end) => remaining = &remaining[end..],
            None => return String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    #[test]
    fn captcha_url_is_found_in_header_json_and_text() {
        assert_eq!(extract_captcha_url("https://geo.captcha-delivery.com/x", b""), "https://geo.captcha-delivery.com/x");
        assert_eq!(extract_captcha_url("", br#"{"captcha_url":"https://c.example.com/p?a=1"}"#), "https://c.example.com/p?a=1");
        assert_eq!(extract_captcha_url("", b"blocked, go to https://c.example.com/solve. thanks"), "https://c.example.com/solve");
        assert_eq!(extract_captcha_url("http://insecure.example.com", b"nothing"), "");
        assert_eq!(extract_captcha_url("", b"https://user:pw@host.example.com/x"), "");
    }

    #[test]
    fn mixed_selection_playlists_and_tracks_are_told_apart() {
        let playlist = json!({"type":"playlist","playlist":{"id":5,"title":"Mix","user":{"username":"u"},"artwork_url":"https://i/x-large.jpg"}});
        let card = decode_mixed_playlist(&playlist).expect("playlist");
        assert_eq!((card.id.as_str(), card.urn.as_str(), card.title.as_str()), ("5", "soundcloud:playlists:5", "Mix"));
        assert!(card.artwork_url.contains("-t500x500."));
        assert!(decode_mixed_track(&playlist).is_none());

        let track = json!({"track":{"id":9,"title":"T"}});
        assert!(decode_mixed_playlist(&track).is_none());
        assert_eq!(vi(&decode_mixed_track(&track).unwrap(), "id"), 9);

        let items = mixed_item_payloads(&json!({"collection":[{"id":1},{"id":2}]}));
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn made_for_you_detection() {
        assert!(is_made_for_you("soundcloud:selections:personalized-tracks", ""));
        assert!(is_made_for_you("x", "  Специально для вас "));
        assert!(!is_made_for_you("charts", "Top 50"));
    }
}
