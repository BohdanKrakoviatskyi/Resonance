# Resonance

Music player in Material 3 Expressive style.

<img width="1920" height="1015" alt="Screenshot From 2026-11-06 19-00-32" src="https://github.com/user-attachments/assets/4909b9ff-cc0d-4db8-ab16-808fdb403096" />
<img width="1920" height="1015" alt="Screenshot From 2026-11-06 19-00-42" src="https://github.com/user-attachments/assets/8cbfe81a-0bea-4cec-a30e-0c62669c9dca" />

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
