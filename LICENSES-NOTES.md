# Аудит лицензий зависимостей, ассетов и внешних сервисов (Resonance v0.4.16)

## Проверил (код/замер/ответ API с файл:строка)

Данные собраны автоматически по `package.json`, `node_modules/*/package.json`, `src-tauri/Cargo.toml` (`cargo metadata --format-version 1`), `api/go.mod`, `api/ytmusic_worker.py` и `index.html`.

### 1. Сводная таблица лицензий (Пакет / Ассет | Где используется | Лицензия | Допустимо ли в закрытом/коммерческом ПО)

| Пакет / Ассет | Где используется | Лицензия | Допустимо ли в закрытом/коммерческом ПО |
|---|---|---|---|
| `react@19.2.6`, `react-dom@19.2.6` | Фронтенд (`package.json:19-20`) | `MIT` | Да (при сохранении уведомления об авторских правах) |
| `@material/material-color-utilities@0.4.0` | Генерация палитр Material 3 (`src/lib/color.ts:1`) | `Apache-2.0` | Да |
| `hls.js@1.7.4` | Воспроизведение HLS-потоков (`src/lib/audio.ts:1`) | `Apache-2.0` | Да |
| `clsx@2.1.1`, `tailwind-merge@3.4.0` | CSS-утилиты фронтенда (`package.json:17,21`) | `MIT` | Да |
| `@tauri-apps/api@2.12.4`, `@tauri-apps/cli@2.12.4` | Tauri IPC / сборка (`package.json:24-25`) | `Apache-2.0 OR MIT` | Да |
| `@tauri-apps/plugin-global-shortcut@2.4.1` | Глобальные хоткеи (`package.json:13`) | `MIT OR Apache-2.0` | Да |
| `@tauri-apps/plugin-process@2.x` | Перезапуск процесса (`package.json:14`) | `MIT OR Apache-2.0` | Да |
| `@tauri-apps/plugin-shell@2.6.0` | Открытие внешних ссылок (`package.json:15`) | `MIT OR Apache-2.0` | Да |
| `@tauri-apps/plugin-updater@2.x` | Автообновление (`package.json:16`) | `MIT OR Apache-2.0` | Да |
| `tailwindcss@4.1.17`, `@tailwindcss/vite@4.1.17` | Сборка стилей (`package.json:23,30`) | `MIT` | Да |
| `vite@7.3.2`, `@vitejs/plugin-react@5.1.1`, `vite-plugin-singlefile@2.3.0` | Бандлер фронтенда (`package.json:29,32-33`) | `MIT` | Да |
| `typescript@5.9.3` | Компилятор типов (`package.json:31`) | `Apache-2.0` | Да |
| `tauri@2.12.5`, `tauri-build@2.7.4` | Ядро Rust-оболочки (`src-tauri/Cargo.toml:18,25`) | `Apache-2.0 OR MIT` | Да |
| `tauri-plugin-log@2.10.2`, `tauri-plugin-shell@2.6.0`, `tauri-plugin-global-shortcut@2.4.1`, `tauri-plugin-updater@2.14.1`, `tauri-plugin-process@2.4.0` | Плагины Rust-оболочки (`src-tauri/Cargo.toml:26-30`) | `Apache-2.0 OR MIT` | Да |
| `tokio@1.54.1` | Асинхронный рантайм Rust (`src-tauri/Cargo.toml:31`) | `MIT` | Да |
| `reqwest@0.12.28` (`rustls-tls`) | HTTP-клиент и локальный прокси (`src-tauri/Cargo.toml:32`) | `MIT OR Apache-2.0` | Да |
| `serde@1.0.229`, `serde_json@1.0.154` | Сериализация JSON (`src-tauri/Cargo.toml:21,23`) | `MIT OR Apache-2.0` | Да |
| `keyring@3.6.3` | Системное хранилище учётных данных (`src-tauri/Cargo.toml:34`) | `MIT OR Apache-2.0` | Да |
| `sha2@0.10.9`, `url@2.5.8`, `log@0.4.35`, `uuid@1.29.2` | Криптохэш, URL, логирование (`src-tauri/Cargo.toml:22,24,33,35`) | `MIT OR Apache-2.0` | Да |
| `golang.org/x/net@v0.35.0` (+ стандартная библиотека Go 1.22) | Локальный Go-сайдкар `local-api` (`api/go.mod:5`) | `BSD-3-Clause` | Да |
| `ytmusicapi` (Python-пакет внутри `ytmusic-worker`) | Сайдкар синхронизации YouTube Music (`api/ytmusic_worker.py:24`) | `MIT` | Да |
| `yt-dlp` (`yt-dlp.exe` / внешний бинарник) | Извлечение аудиопотоков и поиск YouTube (`src-tauri/src/yt_proxy.rs:146-210`, `api/ytmusic_worker.py:424`) | `Unlicense` (Public Domain) | Да (сам `yt-dlp` в общественном достоянии; если бандлится с PyInstaller/Python — применяется PSF License Agreement) |
| `Deno` (опциональный системный JS-рантайм для `yt-dlp`) | Вычисление `n`-challenge для `yt-dlp` (`src-tauri/src/yt_proxy.rs:185`) | `MIT` | Да |
| Шрифты `Google Sans Flex`, `Roboto Flex` | Подключаются из Google Fonts (`index.html:12`, `src/index.css:33`) | `OFL-1.1` (SIL Open Font License 1.1) | Да (разрешено коммерческое использование и бандлинг при сохранении OFL-уведомления) |
| Иконки `Material Symbols Rounded` | Подключаются из Google Fonts (`index.html:13`) | `Apache-2.0` | Да |
| Фоновые стоковые изображения `images.pexels.com` | Предустановленные обои в теме (`index.html:11`, `src/state/appearance.ts`) | `Pexels License` | Да (бесплатно для коммерческого и некоммерческого использования, без перепродажи самих фото как стока) |

---

### 2. Особое внимание: пакеты с `GPL / AGPL / LGPL / MPL / CC / Non-Commercial`

При полном сканировании дерева `node_modules` и `cargo metadata` в основном приложении (`src/`, `src-tauri/`, `api/`):
1. **`GPL` / `AGPL` / `Non-Commercial` в основном приложении (`src/`, `src-tauri/`, `api/`):** **НЕ ОБНАРУЖЕНО** (0 пакетов).
2. **`MPL-2.0` (Weak Copyleft — Mozilla Public License 2.0):**
   - `lightningcss@1.30.2` и `lightningcss-win32-x64-msvc@1.30.2` (транзитивная dev-зависимость `@tailwindcss/vite`, используется только на этапе сборки CSS и не входит в бинарник релиза).
   - `cssparser@0.37.0 / 0.38.0`, `cssparser-macros@0.7.1`, `selectors@0.38.0 / 0.41.0`, `dtoa-short@0.3.5`, `option-ext@0.2.0` (транзитивные зависимости `tauri` / `tauri-build` для парсинга CSS/иконок).
   - *Статус для закрытого/коммерческого ПО:* **Допустимо**. Лицензия `MPL-2.0` действует пофайлово и разрешает статическую и динамическую линковку с проприетарным кодом при условии, что сами исходные файлы под `MPL-2.0` не модифицировались (либо изменения в этих конкретных файлах остаются открытыми).
3. **`MIT OR Apache-2.0 OR LGPL-2.1-or-later` (мультилицензия):**
   - `r-efi@5.3.0 / 6.0.0` (транзитивная зависимость в дереве Cargo).
   - *Статус для закрытого/коммерческого ПО:* **Допустимо** — пакет распространяется по выбору под пермиссивными `MIT` или `Apache-2.0`, поэтому условия `LGPL-2.1` выполнять не требуется.
4. **`CC-BY-4.0` (Creative Commons Attribution 4.0):**
   - `caniuse-lite@1.0.30001819` (транзитивная build-time база таблиц браузеров для Vite/Tailwind, не входит в бинарник приложения).
5. **Устаревшие неотслеживаемые папки вне текущей Tauri-сборки (`build-windows/`, `spotify-core/`, `Swiftify/`, `C:\Users\krako\AppData\Local\Programs\Resonance\Qt6*.dll`):**
   - В старой C++/Qt6 сборке (`v0.2.x`, папка `C:\Users\krako\AppData\Local\Programs\Resonance`) присутствовали библиотеки `Qt6Core.dll`, `Qt6Gui.dll`, `Qt6WebEngineCore.dll` (`LGPL-3.0` / `GPL-3.0`) и крейт `librespot` (`MIT`) в `spotify-core/`. В актуальной архитектуре Tauri 2 (`v0.4.x`, `src-tauri/`) ни Qt6, ни `spotify-core` не используются и не линкуются.
6. **Поле `license` в `src-tauri/Cargo.toml:6`:** сейчас указано пустое значение `license = ""` (при этом в `package.json` поле лицензии не задано). Рекомендуется явно прописать выбранную владельцем лицензию репозитория.

---

### 3. Внешние сервисы и неофициальные API (Фактическая сводка)

- **YouTube / YouTube Music (`InnerTube`, `googlevideo.com`, `ytmusicapi`, `yt-dlp`):** условия использования YouTube (`Terms of Service`, раздел *Permissions and Restrictions*) запрещают доступ к потокам и метаданным автоматизированными средствами в обход официального встроенного плеера и без явного разрешения сервиса.
- **SoundCloud (`api-v2.soundcloud.com`, веб-клиент и OAuth/сессионные cookies):** официальная регистрация новых ключей SoundCloud Public API ограничена, а прямое обращение к непубличному клиентскому API `api-v2` с извлечённым `client_id` и сессионными cookies браузера не документировано для сторонних десктопных клиентов.
- **`lrclib.net` (`https://lrclib.net/api/get`, `https://lrclib.net/api/search`):** бесплатный открытый сервис синхронизированных текстов песен без API-ключей, требующий от клиентов указания идентифицирующего заголовка `User-Agent` с названием приложения и ссылкой на проект.
- **Genius (`https://genius.com/api/search/song` в Go-сайдкар-модуле `api/lyrics.go:554`):** публичные веб-эндпоинты и HTML-страницы Genius используются для чтения текста песни при фоллбэке; согласно условиям Genius API, официальный доступ к данным предполагается через зарегистрированный токен `api.genius.com`.
- **Google Fonts (`fonts.googleapis.com` / `fonts.gstatic.com`) и Pexels (`images.pexels.com`):** публичные CDN для загрузки шрифтов (`OFL-1.1` / `Apache-2.0`) и фоновых изображений по `Pexels License`, получающие при запросе IP-адрес клиента.

---

## Предполагаю
- Поскольку `vite-plugin-singlefile` упаковывает фронтенд в единый бандл, для полного соблюдения формальных требований `MIT` и `Apache-2.0` при публичном распространении закрытых бинарников достаточно включить файл `THIRD-PARTY-NOTICES.txt` с копиями текстов `MIT`, `Apache-2.0`, `BSD-3-Clause`, `MPL-2.0` и `OFL-1.1` в архив релиза или окно «О программе».
