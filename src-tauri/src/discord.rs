//! Discord Rich Presence ("Listening to …").
//!
//! Discord IPC is blocking and Discord may start or quit at any time, so a single worker thread
//! owns the client, reconnects lazily and always applies only the latest requested state.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;

use discord_rich_presence::activity::{Activity, ActivityType, Assets, Button, StatusDisplayType, Timestamps};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PresenceTrack {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    /// https URL of the cover; Discord fetches external images itself.
    pub cover_url: Option<String>,
    /// Whether playback is currently active.
    pub playing: bool,
    /// Unix milliseconds when the track (virtually) started; present only while playing.
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
}

enum Msg {
    Set { client_id: String, track: PresenceTrack },
    Clear,
}

pub struct DiscordPresence {
    tx: Mutex<Sender<Msg>>,
}

impl Default for DiscordPresence {
    fn default() -> Self {
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("discord-presence".into())
            .spawn(move || worker(rx))
            .expect("spawn discord presence worker");
        Self { tx: Mutex::new(tx) }
    }
}

/// Discord limits text fields to 2..=128 characters.
fn field(s: &str) -> String {
    let t: String = s.trim().chars().take(128).collect();
    if t.chars().count() < 2 { format!("{t:<2}") } else { t }
}

fn build(track: &PresenceTrack) -> Activity<'_> {
    let state = if track.playing {
        field(&track.artist)
    } else {
        field(&format!("Paused · {}", track.artist))
    };
    let mut a = Activity::new()
        .activity_type(ActivityType::Listening)
        .status_display_type(StatusDisplayType::Details)
        .details(field(&track.title))
        .state(state);
    let mut assets = Assets::new().small_image("logo").small_text("Resonance");
    if let Some(cover) = track.cover_url.as_deref().filter(|u| u.starts_with("https://")) {
        assets = assets.large_image(cover);
        if let Some(album) = track.album.as_deref().filter(|s| !s.trim().is_empty()) {
            assets = assets.large_text(field(album));
        }
    }
    a = a.assets(assets);
    if track.playing {
        if let (Some(start), Some(end)) = (track.start_ms, track.end_ms) {
            a = a.timestamps(Timestamps::new().start(start).end(end));
        }
    }
    a = a.buttons(vec![Button::new(
        "Get Resonance",
        "https://github.com/BohdanKrakoviatskyi/Resonance/releases/latest",
    )]);
    a
}

fn worker(rx: Receiver<Msg>) {
    let mut client: Option<(String, DiscordIpcClient)> = None;
    let mut wanted: Option<(String, PresenceTrack)> = None;
    let mut dirty = false;
    loop {
        // Retry every few seconds while a state is pending (Discord may not be running yet).
        let msg = if dirty { rx.recv_timeout(Duration::from_secs(5)) } else { rx.recv().map_err(|_| RecvTimeoutError::Disconnected) };
        match msg {
            Ok(Msg::Set { client_id, track }) => {
                wanted = Some((client_id, track));
                dirty = true;
            }
            Ok(Msg::Clear) => {
                wanted = None;
                dirty = true;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        // Coalesce bursts: only the latest message matters.
        while let Ok(m) = rx.try_recv() {
            match m {
                Msg::Set { client_id, track } => wanted = Some((client_id, track)),
                Msg::Clear => wanted = None,
            }
        }

        let Some((id, track)) = wanted.as_ref() else {
            if let Some((_, mut c)) = client.take() {
                let _ = c.clear_activity();
                let _ = c.close();
            }
            dirty = false;
            continue;
        };

        if client.as_ref().is_some_and(|(cid, _)| cid != id) {
            if let Some((_, mut c)) = client.take() {
                let _ = c.close();
            }
        }
        if client.is_none() {
            let mut c = DiscordIpcClient::new(id);
            if c.connect().is_err() {
                continue; // Discord not running; retry on the next timeout.
            }
            client = Some((id.clone(), c));
        }
        let ok = client.as_mut().map(|(_, c)| c.set_activity(build(track)).is_ok()).unwrap_or(false);
        if ok {
            dirty = false;
        } else {
            client = None; // Broken pipe (Discord quit); reconnect on retry.
        }
    }
}

fn valid_client_id(id: &str) -> bool {
    (17..=20).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

#[tauri::command]
pub fn discord_set_presence(state: tauri::State<'_, DiscordPresence>, client_id: String, track: Option<PresenceTrack>) -> Result<(), String> {
    let msg = match track {
        Some(track) if valid_client_id(&client_id) => Msg::Set { client_id, track },
        Some(_) => return Err("invalid Discord application id".into()),
        None => Msg::Clear,
    };
    state.tx.lock().map_err(|e| e.to_string())?.send(msg).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pads_and_truncates_fields() {
        assert_eq!(field("a"), "a ");
        assert_eq!(field(&"x".repeat(300)).chars().count(), 128);
        assert_eq!(field("  Song  "), "Song");
    }

    #[test]
    fn always_shows_the_download_button_instead_of_a_track_link() {
        let track: PresenceTrack = serde_json::from_value(serde_json::json!({
            "title": "Song",
            "artist": "Artist",
            "playing": true
        }))
        .unwrap();
        let activity = serde_json::to_value(build(&track)).unwrap();

        assert_eq!(activity["buttons"][0]["label"], "Get Resonance");
        assert_eq!(
            activity["buttons"][0]["url"],
            "https://github.com/BohdanKrakoviatskyi/Resonance/releases/latest"
        );
        assert_eq!(activity["buttons"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn paused_activity_is_labelled_and_has_no_timer() {
        let track: PresenceTrack = serde_json::from_value(serde_json::json!({
            "title": "Song",
            "artist": "Artist",
            "playing": false,
            "startMs": 1000,
            "endMs": 5000
        }))
        .unwrap();
        let activity = serde_json::to_value(build(&track)).unwrap();

        assert_eq!(activity["state"], "Paused · Artist");
        assert!(activity.get("timestamps").is_none());
    }

    #[test]
    fn validates_snowflake_ids() {
        assert!(valid_client_id("1234567890123456789"));
        assert!(!valid_client_id("abc"));
        assert!(!valid_client_id("12345"));
    }
}
