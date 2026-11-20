//! Public SoundCloud lookups that work without an account: `resolve.playlist` (a playlist/user URL)
//! and `user.likes.by.input` (any profile's public likes). Port of the Go sidecar's `import.go`.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;
use url::Url;

use super::Backend;
use super::soundcloud::{Sc, USER_AGENT, WEB_API_BASE};
use super::types::*;
use super::util::*;

fn script_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"https://a-v2\.sndcdn\.com/assets/[^"'\t\n\x0C\r ]+\.js"#).expect("script pattern"))
}

fn client_id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"client_id[\t\n\x0C\r ]*:[\t\n\x0C\r ]*["']([a-zA-Z0-9]{24,64})["']"#).expect("client id pattern"))
}

/// Cards from a `collection` of likes: each item is `{track: {...}}` or a bare track. Tracks with a
/// blank title are skipped here (unlike the authenticated listing).
fn like_cards(items: &[Value], seen: &mut HashSet<i64>, cards: &mut Vec<TrackCard>) {
    for item in items {
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
        if track.title.trim().is_empty() || !seen.insert(track.id) {
            continue;
        }
        cards.push(track.card());
    }
}

impl Sc {
    /// Like `get_json`, but the token is optional and errors stay generic.
    async fn get_optional_auth_json(&self, endpoint: &str, max_bytes: usize) -> BResult<Value> {
        let mut request = self
            .http
            .get(endpoint)
            .header("Accept", "application/json")
            .header("User-Agent", USER_AGENT)
            .header("Origin", "https://soundcloud.com")
            .header("Referer", "https://soundcloud.com/");
        let token = self.token.trim();
        if !token.is_empty() {
            request = request.header("Authorization", format!("OAuth {token}"));
        }
        let response = request.send().await.map_err(|_| BErr::msg("сетевая ошибка при обращении к SoundCloud"))?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(BErr::msg(format!("SoundCloud вернул ошибку HTTP {}", response.status().as_u16())));
        }
        let body = read_limited(response, max_bytes).await.map_err(|_| BErr::msg("сетевая ошибка при обращении к SoundCloud"))?;
        serde_json::from_slice(&body).map_err(|e| BErr::msg(format!("ошибка чтения JSON: {}", scrub_token(&e.to_string(), token))))
    }

    /// Expands short links (`on.soundcloud.com`, `snd.click`) by following their redirects.
    async fn resolve_redirect(&self, raw_url: &str) -> BResult<String> {
        let parsed = Url::parse(raw_url.trim()).map_err(|_| BErr::msg("некорректная ссылка SoundCloud"))?;
        let host = parsed.host_str().unwrap_or("").to_lowercase();
        if host == "on.soundcloud.com" || host == "snd.click" {
            let response = self
                .http
                .get(parsed.as_str())
                .header("User-Agent", USER_AGENT)
                .send()
                .await
                .map_err(|e| BErr::msg(format!("не удалось раскрыть короткую ссылку SoundCloud: {}", e.without_url())))?;
            return Ok(response.url().to_string());
        }
        Ok(parsed.to_string())
    }

    async fn resolve_resource(&self, target_url: &str, client_id: &str) -> BResult<Value> {
        let mut endpoint = Url::parse(&format!("{WEB_API_BASE}/resolve")).map_err(|e| BErr::msg(e.to_string()))?;
        endpoint.query_pairs_mut().append_pair("url", target_url).append_pair("client_id", client_id);
        self.get_optional_auth_json(endpoint.as_str(), 16 << 20).await
    }

    async fn hydrate_public_playlist_tracks(&self, client_id: &str, playlist_tracks: Vec<ScTrack>) -> Vec<TrackCard> {
        let mut ids = Vec::with_capacity(playlist_tracks.len());
        let mut seen = HashSet::new();
        for track in &playlist_tracks {
            if track.id > 0 && seen.insert(track.id) {
                ids.push(track.id);
            }
        }
        let mut by_id = std::collections::HashMap::with_capacity(ids.len());
        for chunk in ids.chunks(50) {
            let joined = chunk.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
            let Ok(mut endpoint) = Url::parse(&format!("{WEB_API_BASE}/tracks")) else { continue };
            endpoint.query_pairs_mut().append_pair("ids", &joined).append_pair("client_id", client_id);
            // A failed batch is skipped: the un-hydrated originals are still used below.
            let Ok(batch) = self.get_optional_auth_json(endpoint.as_str(), 16 << 20).await else { continue };
            for raw in batch.as_array().into_iter().flatten() {
                let track = ScTrack::parse(raw);
                if track.id > 0 && !track.title.is_empty() {
                    by_id.insert(track.id, track);
                }
            }
        }
        super::soundcloud::order_cards(&playlist_tracks, &by_id, true)
    }
}

impl Backend {
    /// The configured client id, else one scraped (once) from the public web app's bundles.
    pub(super) async fn ensure_public_client_id(&self, sc: &Sc) -> BResult<String> {
        let configured = sc.client_id.trim().to_string();
        if !configured.is_empty() {
            return Ok(configured);
        }
        if let Some(cached) = self.inner.public_client_id.lock().ok().map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) {
            return Ok(cached);
        }
        let response = sc
            .http
            .get("https://soundcloud.com/")
            .header("User-Agent", USER_AGENT)
            .header("Accept", "text/html")
            .send()
            .await
            .map_err(|e| BErr::msg(format!("не удалось открыть SoundCloud: {}", e.without_url())))?;
        let body = read_limited(response, 2 << 20).await.unwrap_or_default();
        let html = String::from_utf8_lossy(&body).into_owned();
        let scripts: Vec<&str> = script_re().find_iter(&html).map(|m| m.as_str()).collect();
        // Scan from the end: the app bundles at the bottom usually hold the api-v2 client_id.
        for script in scripts.iter().rev().take(8) {
            let Ok(response) = sc.http.get(*script).header("User-Agent", USER_AGENT).send().await else { continue };
            let js = read_limited(response, 6 << 20).await.unwrap_or_default();
            let text = String::from_utf8_lossy(&js);
            if let Some(captures) = client_id_re().captures(&text) {
                let id = captures[1].to_string();
                if let Ok(mut cached) = self.inner.public_client_id.lock() {
                    *cached = id.clone();
                }
                return Ok(id);
            }
        }
        Err(BErr::msg("не удалось получить публичный client_id SoundCloud"))
    }

    pub async fn resolve_playlist(&self, url: &str) -> BResult<ResolvedPlaylist> {
        let mut raw_url = url.trim().to_string();
        if raw_url.is_empty() {
            return Err(BErr::msg("укажите ссылку на плейлист SoundCloud"));
        }
        if !raw_url.starts_with("http://") && !raw_url.starts_with("https://") {
            raw_url = format!("https://{raw_url}");
        }
        let sc = self.sc().await;
        let resolved_url = sc.resolve_redirect(&raw_url).await?;
        let client_id = self.ensure_public_client_id(&sc).await?;

        let payload = sc
            .resolve_resource(&resolved_url, &client_id)
            .await
            .map_err(|e| BErr::msg(format!("не удалось загрузить плейлист SoundCloud: {e}")))?;
        let kind = vs(&payload, "kind");
        if !kind.is_empty() && kind != "playlist" {
            if kind == "user" {
                let likes = self.user_likes_by_input(&resolved_url).await?;
                let name = likes.username.trim();
                let title = if name.is_empty() { "SoundCloud Likes".to_string() } else { format!("{name} · Likes") };
                return Ok(ResolvedPlaylist { title, artwork_url: likes.artwork_url, tracks: likes.tracks });
            }
            return Err(BErr::msg("ссылка не указывает на плейлист SoundCloud"));
        }
        let cards = sc.hydrate_public_playlist_tracks(&client_id, playlist_or_collection_tracks(&payload)).await;
        if cards.is_empty() {
            return Err(BErr::msg("плейлист SoundCloud пуст или недоступен"));
        }
        let mut artwork = normalize_artwork(&vs(&payload, "artwork_url"));
        if artwork.is_empty() {
            artwork = cards.iter().find(|c| !c.artwork_url.is_empty()).map(|c| c.artwork_url.clone()).unwrap_or_default();
        }
        let title = vs(&payload, "title").trim().to_string();
        Ok(ResolvedPlaylist { title: if title.is_empty() { "SoundCloud Playlist".into() } else { title }, artwork_url: artwork, tracks: cards })
    }

    pub async fn user_likes_by_input(&self, input: &str) -> BResult<ResolvedLikes> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Err(BErr::msg("введите имя пользователя или ссылку SoundCloud"));
        }
        let sc = self.sc().await;
        let profile_url = if trimmed.starts_with("http://") || trimmed.starts_with("https://") || trimmed.contains("soundcloud.com/") {
            let full = if trimmed.starts_with("http://") || trimmed.starts_with("https://") { trimmed.to_string() } else { format!("https://{trimmed}") };
            let expanded = sc.resolve_redirect(&full).await?;
            let parsed = Url::parse(&expanded).map_err(|_| BErr::msg("некорректная ссылка SoundCloud"))?;
            let first = parsed.path().trim_matches('/').split('/').next().unwrap_or("").to_string();
            if first.is_empty() {
                return Err(BErr::msg("не удалось определить пользователя SoundCloud из ссылки"));
            }
            format!("https://soundcloud.com/{first}")
        } else {
            let handle = trimmed.strip_prefix('@').unwrap_or(trimmed).trim_matches('/');
            if handle.is_empty() || handle.contains([' ', '\t', '\n', '/', '?', '#']) {
                return Err(BErr::msg("некорректное имя пользователя SoundCloud"));
            }
            format!("https://soundcloud.com/{}", path_escape(handle))
        };

        let client_id = self.ensure_public_client_id(&sc).await?;
        let user = sc.resolve_resource(&profile_url, &client_id).await.map_err(|e| BErr::msg(format!("пользователь SoundCloud не найден: {e}")))?;
        let user_id = vi(&user, "id");
        if user_id <= 0 {
            return Err(BErr::msg("пользователь SoundCloud не найден"));
        }

        let mut page_url = format!("{WEB_API_BASE}/users/{user_id}/likes?limit=200&linked_partitioning=1&client_id={}", url::form_urlencoded::byte_serialize(client_id.as_bytes()).collect::<String>());
        let mut seen_pages = HashSet::new();
        let mut seen_tracks = HashSet::new();
        let mut cards: Vec<TrackCard> = Vec::new();
        let mut page = 0;
        while !page_url.is_empty() && page < 100 {
            page += 1;
            let Some(mut parsed) = Url::parse(&page_url).ok().filter(|u| u.scheme() == "https" && u.host_str().is_some_and(|h| h.eq_ignore_ascii_case("api-v2.soundcloud.com"))) else {
                break;
            };
            set_query(&mut parsed, "client_id", &client_id);
            let canonical = parsed.to_string();
            if !seen_pages.insert(canonical.clone()) {
                break;
            }
            let payload = match sc.get_optional_auth_json(&canonical, 16 << 20).await {
                Ok(payload) => payload,
                Err(e) => {
                    if !cards.is_empty() {
                        break;
                    }
                    return Err(BErr::msg(format!("не удалось загрузить лайки пользователя: {e}")));
                }
            };
            like_cards(varr(&payload, "collection").map(Vec::as_slice).unwrap_or(&[]), &mut seen_tracks, &mut cards);
            page_url = vs(&payload, "next_href");
        }
        if cards.is_empty() {
            return Err(BErr::msg("у пользователя нет публичных лайков"));
        }
        let avatar = normalize_artwork(&vs(&user, "avatar_url"));
        let mut artwork = avatar.clone();
        if artwork.is_empty() {
            artwork = cards.iter().find(|c| !c.artwork_url.is_empty()).map(|c| c.artwork_url.clone()).unwrap_or_default();
        }
        let username = vs(&user, "username").trim().to_string();
        Ok(ResolvedLikes { username: if username.is_empty() { "SoundCloud".into() } else { username }, avatar_url: avatar, artwork_url: artwork, tracks: cards })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn client_id_is_found_in_a_bundle() {
        let js = r#"...,client_id:"AbCdEfGhIjKlMnOpQrStUvWx12",other:1"#;
        assert_eq!(&client_id_re().captures(js).unwrap()[1], "AbCdEfGhIjKlMnOpQrStUvWx12");
        assert!(client_id_re().captures(r#"client_id:"short""#).is_none());
        let html = r#"<script src="https://a-v2.sndcdn.com/assets/0-abc.js"></script><script crossorigin src="https://a-v2.sndcdn.com/assets/49-def.js">"#;
        assert_eq!(script_re().find_iter(html).count(), 2);
    }

    #[test]
    fn like_cards_skip_blank_titles_and_duplicates() {
        let items = vec![
            json!({"track":{"id":1,"title":"A","artwork_url":"https://i/x-large.jpg","user":{"username":"u"}}}),
            json!({"track":{"id":1,"title":"A again"}}),
            json!({"id":2,"title":"   "}),
            json!({"id":3,"title":"Bare"}),
            json!({"foo":1}),
        ];
        let (mut seen, mut cards) = (HashSet::new(), Vec::new());
        like_cards(&items, &mut seen, &mut cards);
        let titles: Vec<_> = cards.iter().map(|c| c.title.as_str()).collect();
        assert_eq!(titles, ["A", "Bare"]);
        assert!(cards[0].artwork_url.contains("-t500x500."));
        assert_eq!(cards[1].track_urn, "soundcloud:tracks:3");
    }
}
