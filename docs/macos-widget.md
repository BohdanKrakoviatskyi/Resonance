# Нативный виджет macOS (WidgetKit)

Виджет показывает текущий трек Resonance (обложка, название/артист, play/pause, акцент темы).
Работает только на macOS; на Windows/Linux весь код вырезан `#[cfg(target_os = "macos")]`
и фронтенд-мост ничего не делает.

## Архитектура

Виджет живёт в отдельном процессе и **только читает данные** — обмен односторонний, через файл:

```
стор плеера (TS) → widget-bridge.ts → Tauri command widget_update_now_playing
  → Rust (src-tauri/src/macos_widget.rs) пишет атомарно
      ~/Library/Application Support/Resonance/widget/now_playing.json
      ~/Library/Application Support/Resonance/widget/artwork.jpg
  → Swift-мост (macos-widget/reload-bridge, @_cdecl "resonance_widget_reload")
      → WidgetCenter.shared.reloadAllTimelines()
  → WidgetKit extension (macos-widget/) читает файлы и рисует
```

Контракт `now_playing.json` (версия 1):

```json
{
  "version": 1,
  "title": "string",
  "artist": "string",
  "isPlaying": true,
  "durationSec": 215,
  "positionSec": 42,
  "updatedAt": 1731744000,
  "artworkFile": "artwork.jpg",
  "accentColor": "#6750A4"
}
```

Запись атомарная (temp + rename). Обложка пережимается на фронтенде до ~512px по длинной
стороне (canvas → JPEG 0.85) и отправляется только при смене трека; Rust валидирует base64,
размер (≤4 МБ) и JPEG-сигнатуру. Rust не пишет файл и не перезагружает виджет, если контент
не изменился. Позиция отправляется только при смене трека / play-pause / seek (детект дрейфа
> 1.5 c), не на каждом тике.

## Сборка

Виджет собирается отдельно от Tauri и требует **полный Xcode** (`xcodebuild`) и XcodeGen:

```bash
brew install xcodegen
bash scripts/build-macos-widget.sh   # → src-tauri/macos-widget-build/ResonanceWidget.appex
npx tauri build --config src-tauri/tauri.macos.conf.json
```

Порядок важен: `bundle.macOS.files` копирует `.appex` в `Contents/PlugIns/`, и tauri-bundler
завершается ошибкой, если файла нет. `scripts/build-macos-widget.sh` подписывает `.appex`
ad-hoc (`codesign --force --sign - --entitlements ...`) **до** бандлинга — tauri-bundler
не использует `--deep` и не ре-подписывает `.appex`, поэтому entitlements виджета сохраняются
(подпись inner-first обеспечивает сам скрипт + бандлер).

Swift-мост для перезагрузки таймлайнов компилируется автоматически из `src-tauri/build.rs`
(только на macOS, через swift-rs → `swift build` пакета `macos-widget/reload-bridge`).

В GitHub Actions шаги «Install XcodeGen» и «Build macOS widget extension» добавлены только
в macOS-джобы перед `tauri-action`; `tauri-action` получает
`--config src-tauri/tauri.macos.conf.json` только на macOS.

## Подпись и песочница

- Главное приложение: ad-hoc (`signingIdentity: "-"`), entitlements пустые (без песочницы),
  `hardenedRuntime: false`, `minimumSystemVersion: "10.15"` (минимум для Swift runtime,
  который линкует swift-rs).
- Виджет: `com.apple.security.app-sandbox = true` + временная исключение на чтение
  `~/Library/Application Support/Resonance/`. В песочнице реальный home получают через
  `getpwuid(getuid())`, т.к. `homeDirectoryForCurrentUser` указывает на контейнер виджета.

## Известные ограничения и результаты отладки (macOS 27, ad-hoc)

Проверено экспериментально на macOS 27.2 (только Command Line Tools, без Xcode):

1. **`app-sandbox = false` у виджета — запрещено системой.** `AppleSystemPolicy`
   отказывает в запуске расширения (`ASP: Security policy would not allow process`,
   launchd spawn failed). Песочница для виджет-расширений обязательна.
2. **`temporary-exception.*` при ad-hoc подписи** — расширение запускается, но это
   не проверялось отдельно от п.3; исключение может не соблюдаться (виджет покажет
   заглушку). Fallback из старой версии доков (отключить песочницу) невозможен из-за п.1.
3. **Сборка виджета без Xcode (plain swiftc) — НЕ работает.** Бинарник корректно
   регистрируется в `pluginkit`, но падает при запуске: `EXC_BREAKPOINT` в
   `_EXRunningExtension.sharedInstance()` (ExtensionFoundation, bootstrapping
   `WidgetBundle.main()`). Система не показывает такой виджет в галерее.
   Воспроизведение локально: `__XPCBundleIdentifier=<bundle-id> <appex-binary>`.
   Это подтверждено независимыми проектами: xtool#313 (открытый issue), stint
   (перешли на xcodegen + Xcode). Причина: runtime требует метаданные, которые
   эмитит только Xcode-шаблон Widget Extension. Поэтому `scripts/build-macos-widget.sh`
   требует полный Xcode и не содержит swiftc-fallback.

Следствие: локальная проверка виджета возможна только с полным Xcode; без него —
через CI-артефакт (в CI установлен полный Xcode).

## Ручная проверка на чистом Mac

1. `bash scripts/build-macos-widget.sh` — без ошибок, `.appex` появился.
2. `npx tauri build --config src-tauri/tauri.macos.conf.json`.
3. `codesign -vv --deep src-tauri/target/release/bundle/macos/Resonance.app` — valid.
4. `codesign -d --entitlements - Resonance.app/Contents/PlugIns/ResonanceWidget.appex` —
   видны sandbox + temporary-exception.
5. Запустить app, добавить виджет (галерея / Notification Center) — отображается трек.
6. Сменить трек, play/pause, seek — виджет обновляется; обложка видна.
7. Если виджет показывает заглушку при играющем треке — исключение не соблюдено
   (см. п.2 выше); рабочее решение — писать данные в контейнер песочницы виджета
   `~/Library/Containers/com.resonance.app.widget/Data/...` из главного приложения.

## Этап 2 (не реализован)

Управление из виджета по `Link` со схемой `resonance://playpause|next|prev` через
tauri-plugin-deep-link. Отдельный коммит после проверки этапа 1.
