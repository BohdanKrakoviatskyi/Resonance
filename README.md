# Resonance

A fast, native music player for YouTube Music, SoundCloud and your own files, in Material 3 Expressive style.

<img width="1920" height="1015" alt="Screenshot From 2026-11-06 19-00-32" src="https://github.com/user-attachments/assets/4909b9ff-cc0d-4db8-ab16-808fdb403096" />
<img width="1920" height="1015" alt="Screenshot From 2026-11-06 19-00-42" src="https://github.com/user-attachments/assets/8cbfe81a-0bea-4cec-a30e-0c62669c9dca" />

## Why Resonance

- **Native, not Electron.** Built on Tauri 2 with a Rust core, so the installer is small and memory use is low. Streaming, caching and stream resolution run in Rust, with no bundled yt-dlp or ffmpeg.
- **No middleman server.** Everything runs on your machine. No account with us, no telemetry, no paid tier.
- **Your real libraries.** Sign in to YouTube Music and SoundCloud to get your own likes, playlists and mixes. Tokens are kept in the OS keychain.

## Features

**Sources**
- YouTube Music and SoundCloud, with sign-in.
- Local files: MP3, FLAC, WAV, OGG/Opus, M4A/AAC. Pick folders and Resonance reads tags and embedded covers.
- Playlist import from Spotify, Apple Music, Deezer, Yandex Music, YouTube and SoundCloud, with track matching and review.
- **Update from source**: an imported playlist can pull in new tracks from its original link later.

**Playback**
- Gapless-feel crossfade with linear, equal-power and S-curve transitions.
- Loudness normalization (−18 / −14 / −11 LUFS) with a brickwall limiter.
- Parametric equalizer with a live spectrum and presets.
- Effects: speed (0.5×–1.5×), keep-pitch or vinyl mode, reverb, and one-click **Slowed + reverb** and **Nightcore**.
- **Offline downloads** for YouTube Music tracks and whole playlists.
- Sleep timer, with a duration or "end of track", that fades out.
- Radio, recommendations and mood mixes, computed locally.

**Lyrics**
- Synced lyrics, with **word-by-word karaoke** highlighting when available.
- Pick different lyrics, load your own `.lrc` (Enhanced LRC word tags supported), and shift timing per track.

**Look and feel**
- Dynamic colors from cover art, glass and metallic styles, and an immersive fullscreen mode.
- A custom CSS editor with ready-made snippets.
- Mini player, global shortcuts, media keys, and Russian and English UI.

**Integrations** (Settings → Integrations)
- **Discord Rich Presence**: "Listening to …" with cover art and a progress bar. Enable or disable it in Settings → Integrations; no Discord setup is required.
- **Last.fm scrobbling**: follows the official rules, with "now playing" and an offline queue. Create API keys at <https://www.last.fm/api/account/create>, then log in. Your password is used once and is never stored.

## Run in development
```bash
npm install
npm run dev
```

## Run as Tauri app (development)
```bash
npm install
npx tauri dev
```

## Tests
```bash
npx tsc --noEmit
npm test
cargo test --manifest-path src-tauri/Cargo.toml
# network tests (YouTube download, NetEase lyrics), run manually:
cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored
```

## Global mute shortcut

Configure shortcuts in Appearance. The mute shortcut works globally in the Tauri desktop app while Resonance is running; other shortcuts work while its window is focused.

## Build
```bash
npm run build
```

## Build desktop apps (.AppImage, .exe, .dmg)

Prerequisites: [Rust](https://rustup.rs/), Tauri dependencies for your OS ([Tauri docs](https://v2.tauri.app/start/prerequisites/)).

```bash
npm install
npx tauri build
```

Output:
- Linux: `src-tauri/target/release/bundle/appimage/*.AppImage`, `src-tauri/target/release/bundle/deb/*.deb`
- Windows: `src-tauri/target/release/bundle/nsis/*.exe`, `src-tauri/target/release/bundle/msi/*.msi`
- macOS: `src-tauri/target/release/bundle/dmg/*.dmg`, `src-tauri/target/release/bundle/macos/*.app`

### Signed and notarized macOS builds

The release workflow signs and notarizes the macOS build when these repository secrets are set. Without them it builds ad-hoc signed, as before:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64 of your "Developer ID Application" `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | password of that `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Apple ID, an app-specific password, and your team ID (for notarization) |
