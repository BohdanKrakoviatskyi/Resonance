# Resonance

Native pure-Rust desktop music player built with **GPUI** (`gpui-kit`) and **Material 3 Expressive** (`gpui-kit-material` / `gpui-kit-material-color` / `gpui-material-symbols`).

<img width="1920" height="1015" alt="Screenshot From 2026-11-06 19-00-32" src="https://github.com/user-attachments/assets/4909b9ff-cc0d-4db8-ab16-808fdb403096" />
<img width="1920" height="1015" alt="Screenshot From 2026-11-06 19-00-42" src="https://github.com/user-attachments/assets/8cbfe81a-0bea-4cec-a30e-0c62669c9dca" />

## Workspace architecture

- `crates/resonance-core` — SoundCloud & YouTube Music backends, SQLite stores, progressive audio cache, QuickJS signature solver, playlist import/matching, lyrics engine (LRCLIB / NetEase / Musixmatch / SoundCloud / YouTube), Material 3 HCT color/theme engine, i18n (`ru`/`en`), keyboard shortcuts, state persistence, updater, and macOS WidgetKit bridge.
- `crates/resonance-audio` — Native `cpal` + `symphonia` (`symphonia-opus`) + `m3u8-rs` HLS/progressive streaming decoder, dual-deck crossfade engine (Linear / Equal-Power / S-Curve), 5-band RBJ biquad equalizer (`biquad`), loudness normalization + `-1 dBFS` limiter, and 4096-pt `rustfft` 72-bar spectrum tap.
- `crates/resonance-auth` — Isolated `tao` + `wry` OAuth/cookie capture helper binary (`resonance-auth --provider <soundcloud|ytmusic>`).
- `crates/resonance-ui` — Pure-Rust GPUI + Material 3 Expressive application binary (`resonance`), OS media controls (`souvlaki`), and global mute hotkey (`global-hotkey`).

## Run in development

```bash
cargo run -p resonance-ui
```

## Build release binaries (`resonance` & `resonance-auth`)

```bash
cargo build --release --workspace
```

Outputs are placed under `target/release/`:
- `target/release/resonance` — main desktop player
- `target/release/resonance-auth` — isolated provider sign-in helper

## Run tests & lints

```bash
cargo test --workspace
cargo clippy --workspace --all-targets
```

## Global mute shortcut

Configure shortcuts in **Appearance** / **Shortcuts**. The mute shortcut works globally while Resonance is running; other playback and navigation shortcuts work while the window is focused.

## macOS WidgetKit integration

See [`docs/macos-widget.md`](docs/macos-widget.md) and [`scripts/build-macos-widget.sh`](scripts/build-macos-widget.sh) for building the optional native `ResonanceWidget.appex` extension (`macos-widget/`).
