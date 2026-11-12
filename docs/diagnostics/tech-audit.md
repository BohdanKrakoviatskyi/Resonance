# Технический и секьюрити-аудит Resonance (Фаза 0а, без запуска приложения)

## Проверил (код/замер/ответ API с файл:строка)

### 1. Размеры сборок и установочных файлов на диске
*(Время старта и потребление RAM ночью НЕ измерялись согласно Предохранителю №4).*
- **Текущая установленная Tauri-сборка (`C:\Users\krako\AppData\Local\Resonance`):** **`36.53 MB` (`38 306 784 байт`)**:
  - `resonance.exe` — `16.50 MB` (`17 301 504 байт`);
  - `local-api.exe` (Go-сайдкар) — `10.44 MB` (`10 950 144 байт`);
  - `ytmusic-worker.exe` (Python-сайдкар) — `9.48 MB` (`9 936 448 байт`);
  - `uninstall.exe` — `0.08 MB` (`79 432 байт`).
- **Установочные файлы релизов Tauri (`v0.4.x`) в `C:\Users\krako\Downloads\`:**
  - `Resonance_0.4.14_x64-setup.exe` — **`18.22 MB` (`19 104 943 байт`)**;
  - `Resonance_0.4.13_x64-setup.exe` — **`18.22 MB` (`19 103 323 байт`)**;
  - `Resonance_0.4.4_aarch64.dmg` (macOS) — **`18.01 MB` (`18 880 162 байт`)**;
  - Локальный `src-tauri\target\release\bundle` для `v0.4.15` на диске отсутствует (`не измерено`, так как релиз `v0.4.15` собирался в GitHub Actions).
- **Устаревшая папка прошлой C++/Qt6-архитектуры (`C:\Users\krako\AppData\Local\Programs\Resonance`, `v0.2.x`):** `484.28 MB` (`507 808 701 байт`), установщик `packaging\windows\Output\Resonance-Setup-0.2.9.exe` — `152.41 MB` (`159 815 147 байт`), неотслеживаемый кэш CMake-сборки `build-windows\` в корне — `6 497.32 MB` (`6.5 GB`).

---

### 2. Остатки Spotify (в коде, файловой системе и `AppData` — НИЧЕГО не удалено)

1. **Активный код Tauri / React / Go (содержит только процедуры одноразовой зачистки старых данных):**
   - `src-tauri/src/lib.rs:411-439` и вызов в `src-tauri/src/lib.rs:489` — функция `purge_retired_spotify_storage(app: &AppHandle)`, удаляющая при старте записи `keyring::Entry::new("com.resonance.spotify", "oauth_tokens" | "oauth_tokens_v1")`, файлы `spotify_config.json`, `spotify_imports.json`, `spotify_profile_cache.json`, `spotify.json` и папку `spotify-webview`.
   - `src/state/library.ts:17-78` — функция `purgeRetiredSpotifyStorage()`, вычищающая из `localStorage['lyra.lib.v1']` поля `spotifyLiked`, `spotifyPlaylists`, `spotifyPlaylistTracks`, `spotifyAuthorized`, `spotifyProfile`, ID с префиксом `sp:` и флаг `foldSpotify` из `lyra.ui.v1`.
   - `src/lib/util.ts:105-114` — фильтрация тех же ключей `spotify*` и `foldSpotify` при восстановлении резервной копии из `frontend-state.json`.
   - `api/main.go:416-418` — удаление устаревшего `spotify.json` из `%APPDATA%\Resonance` при запуске Go-сайдкар-процесса.
2. **Неотслеживаемые (`untracked`) папки в рабочей директории репозитория (наследие C++/Qt сборки):**
   - `spotify-core/` — отдельный Rust-крейт на базе `librespot` (не входит в `src-tauri/Cargo.toml`).
   - `build-windows/x86_64-pc-windows-msvc-18146b3db2bc/swiftify/cargo/spotify-core_b34c0/` — скомпилированные артефакты `spotify-core` и `librespot` внутри старого CMake-билда.
   - `Swiftify/`, `Resonance/`, `backend/` — исходники старой версии плеера с упоминаниями Spotify.
3. **Данные пользователя в `%APPDATA%\Resonance` (проверено по копии в `$env:TEMP\resonance-overnight-copy`):**
   - Файлов `spotify*.json` в `%APPDATA%\Resonance` больше нет.
   - В `frontend-state.json` (строка 1) внутри сериализованного JSON-слепка `lyra.lib.v1` и в старом `Resonance.ini` (строка 4) ещё сохранились строковые упоминания ключей `spotify`, которые игнорируются/очищаются фронтендом при чтении.

---

### 3. Хранение секретов, сетевые границы и права Tauri (строго без значений секретов!)

1. **Где и как хранятся учётные данные (`%APPDATA%\Resonance\`):**
   - **`auth.json`** (`api/main.go:423, 750-755`): хранит OAuth-токен и кэш профиля SoundCloud в открытом JSON. При записи на POSIX выставляются права `0o600`, на директорию — `0o700` (`api/main.go:413`), однако на Windows стандартный `os.WriteFile` / `os.MkdirAll` не ограничивает ACL только текущим пользователем (наследуются права родительской папки `%APPDATA%`), а системный `Windows Credential Manager` (`keyring`) для SoundCloud/YouTube не задействован (хотя крейт `keyring` уже подключён в `src-tauri/Cargo.toml:34`).
   - **`settings.json`** (`api/main.go:421`): хранит `clientId` SoundCloud, а также base64-копию фонового изображения `backgroundImage` (из-за чего размер файла достигает **`15.78 MB`**).
   - **`ytmusic-auth.json`** (`api/ytmusic_worker.py:34, 288-305`): хранит сессионные заголовки (`Cookie`, включая `__Secure-3PAPISID`, и `Authorization: SAPISIDHASH ...`) для `music.youtube.com`. Запись атомарная через `.tmp` + `fsync`, но на Windows права файла также определяются стандартным ACL профиля пользователя (`if os.name != "nt": os.chmod(0o600)` на строках `296, 302`).
   - **`youtube.json`** (в `%APPDATA%\Resonance\`): оставшийся файл старой OAuth-сессии YouTube (`accessToken`, `refreshToken`, `expiresAt`).
2. **Передача токенов при авторизации во встроенном WebView:**
   - **SoundCloud (`src-tauri/src/lib.rs:14-56, 100-136`):** в окно `https://soundcloud.com/signin` инжектируется `initialization_script`, который оборачивает `window.fetch` и `XMLHttpRequest.prototype.open/setRequestHeader` во всех фреймах окна, перехватывает заголовок `Authorization` и `client_id` при обращении к `api-v2.soundcloud.com` и перенаправляет окно на кастомную схему `resonance://soundcloud-login?state=...&client_id=...&token=...`. Наличие UUID `state` (`src-tauri/src/lib.rs:96, 118`) защищает от подмены callback, но перехват глобального `fetch`/`XHR` внутри стороннего домена чувствителен к изменениям клиентского бандла SoundCloud.
   - **YouTube Music (`src-tauri/src/lib.rs:140-362`):** проверяет наличие cookie `__Secure-3PAPISID` через нативный API WebView (`cookies_for_url`) без инжекции JS-перехватчиков сетевых запросов.
3. **Анализ `CSP` в `src-tauri/tauri.conf.json:41-43`:**
   - Текущая политика:
     `default-src 'self'; img-src 'self' https: data: blob:; media-src 'self' https: blob: http://127.0.0.1:*; connect-src 'self' https: http://127.0.0.1:*; script-src 'self' https://www.youtube.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; frame-src https://www.youtube.com; font-src 'self' data: https://fonts.gstatic.com`
   - **Плюсы:** отсутствует `'unsafe-eval'`, `default-src` ограничен `'self'`, локальные HTTP-потоки разрешены только с `127.0.0.1:*`.
   - **Риски:** `connect-src 'self' https: http://127.0.0.1:*` разрешает отправку HTTPS-запросов на любой внешний хост, а `script-src 'self' https://www.youtube.com` доверяет внешним скриптам домена `www.youtube.com` в контексте главного окна Tauri (где доступны IPC-команды).
4. **Права Tauri (`src-tauri/capabilities/default.json:1-32`):**
   - Окнам `main` и `splash` выданы права `shell:allow-spawn` строго для двух фиксированных сайдкаров (`binaries/local-api` и `binaries/ytmusic-worker` с `"args": false`, строки `23-28`), что предотвращает запуск произвольных бинарников через плагин `shell`.
   - При этом включены `shell:allow-stdin-write` (`строка 30`) и `shell:allow-open` (`строка 29`), а также кастомная команда `allow-uninstall-app` (`строка 18`), вызывающая деинсталлятор без дополнительного диалога подтверждения на стороне Rust (`src-tauri/src/lib.rs:365-401`).

---

### 4. Топ багов и узких мест (по убыванию важности, с точным `файл:строка`)

1. **[Высокий | Lyrics Search] Суффикс `- Topic` у автогенерируемых каналов YouTube ломает поиск текстов в LRCLIB (`src/lib/lyrics-match.ts:76-124`):**
   - Поле `artist` вида `"Султан Лагучев - Topic"` или `"Calvin Harris - Topic"` передаётся в LRCLIB `/api/search` без удаления `- Topic`, из-за чего LRCLIB возвращает `[]` на популярных треках (подтверждено на треках №4 и №6 в `docs/diagnostics/lyrics-audit.md`).
2. **[Высокий | Lyrics Search] Дефис без пробелов и конструкция `Title by Artist` не разбираются на артиста и название (`src/lib/lyrics-match.ts:104`):**
   - Регулярное выражение `cleanedTitle.match(/^(.+?)\s+[–—-]\s+(.+)$/)` требует пробелы с обеих сторон дефиса и не знает паттерн `... by ...` и двойные дефисы `Title - Artist - (sped up)`. Из-за этого треки `"tame impala-loser (slowed)"`, `"Go With The Flow by Queens of the Stone Age (Slowed)"` и `"UH OH! - Sub Urban - (sped up/pitched)"` ищутся с ником загрузчика SoundCloud вместо реального артиста.
3. **[Высокий | Lyrics Search] Отсутствует вызов точного эндпоинта `/api/get`, заголовок `User-Agent` и таймаут `5 с` при запросах к LRCLIB (`src/lib/api.ts:201-208, 237-263`):**
   - Фронтенд делает `fetch('https://lrclib.net/api/search?...')` без `AbortSignal.timeout(5000)`, без заголовка `User-Agent` и без предварительного вызова `/api/get`, а при подвисании сети промис в `lyricsCache` может висеть неограниченно долго.
4. **[Высокий | Lyrics Scoring & Slowed] Жёсткий порог длительности `±4 с` отбрасывает `synced`-тексты при небольшом расхождении мастеринга и на `slowed / sped up` версиях (`src/lib/lyrics-match.ts:144-171`, `src/lib/api.ts:237`):**
   - На треке №18 (`Монеточка — Монополия`, `213.4s` vs `218.0s` в LRCLIB, `Δ = -4.6s`) отбрасывается идеальный `synced`-текст при 100% совпадении артиста и названия; на `slowed`/`sped up` треках (№28 `WesGhost — SPINE`, №29 `Sub Urban — UH OH!`, №30 `Britney Manson — FASHION`) синхронный текст оригинала отвергается вместо пропорционального масштабирования таймкодов (причём в Go-сайдкар-модуле `api/lyrics.go:519-546` масштабирование есть, а во фронтенде `src/lib/api.ts` — нет).
5. **[Средний | Lyrics Cache] Отсутствует персистентный кэш текстов с TTL и защита от кэширования сетевых сбоев между сессиями (`src/lib/api.ts:164, 290-310`):**
   - `lyricsCache` хранится только в RAM (`new Map<string, Promise<LyricsData | null>>()`). После перезапуска плеера все запросы к LRCLIB повторяются заново, а отрицательный результат («текст не найден») не кэшируется на 7 дней.
6. **[Средний | Storage / I/O] Файл `settings.json` в `%APPDATA%\Resonance` раздут до `15.78 MB` из-за хранения `backgroundImage` в JSON (`api/main.go:421, 615-660`):**
   - Go-сайдкар целиком читает и перезаписывает 15.8 МБ JSON при каждом изменении настроек (`volume`, `accent`), хотя фронтенд уже перешёл на хранение фоновой картинки в IndexedDB (`src/state/appearance.ts:65-80`).
7. **[Средний | Security / Storage] Токены `auth.json`, `ytmusic-auth.json` и `youtube.json` хранятся в открытом виде на диске без шифрования через ОС Keyring (`api/main.go:423`, `api/ytmusic_worker.py:288`):**
   - Несмотря на наличие зависимости `keyring = "3.6"` в `src-tauri/Cargo.toml:34`, актуальные токены SoundCloud и cookies YouTube Music лежат в текстовых JSON-файлах в `%APPDATA%\Resonance`.
8. **[Средний | Security / Local Proxy] Локальный HTTP-прокси аудиопотоков (`127.0.0.1:<port>`) не проверяет токен авторизации в заголовках/query (`src-tauri/src/yt_proxy.rs:640-720`):**
   - Любой локальный процесс на машине пользователя, угадав порт `127.0.0.1`, может обратиться к `/stream/<video_id>`. Добавление одноразового сессионного токена на время жизни процесса закрыло бы доступ посторонним локальным процессам.
9. **[Средний | Reliability / Sidecar IPC] Отсутствует авто-перезапуск Go/Python сайдкара с экспоненциальным бэкоффом при падении во время чтения длинной очереди (`src/lib/sidecar-base.ts:62-66`):**
   - При закрытии дочернего процесса все текущие RPC-запросы отклоняются через `failPending(opts.stoppedMessage)` без автоматического прозрачного ретрая идемпотентных вызовов чтения.
10. **[Низкий | Performance / State Backup] Полная сериализация всех ключей `localStorage` (`~742 KB` `frontend-state.json`) каждые `350 мс` при частых обновлениях сторов (`src/lib/util.ts:49-67, 130-150`):**
    - При быстрых изменениях состояния весь объём `lyra.lib.v1` (534 лайка SoundCloud + все плейлисты) пересылается через stdin в Go-сайдкар для записи на диск.
11. **[Низкий | Cleanup / Uninstaller] Команда `uninstall_app` (`src-tauri/src/lib.rs:383-399`) передаёт `UninstallString` из реестра в `cmd.exe /c` без дополнительной валидации пути:**
    - Хотя строка берётся из собственной ветки реестра `Uninstall`, безопаснее запускать исполняемый файл напрямую без оболочки `cmd.exe`.
12. **[Низкий | Metadata] Пустое поле `license = ""` и `authors = ["you"]` в `src-tauri/Cargo.toml:5-6`:**
    - Метаданные крейта Rust не синхронизированы с релизной версией и автором проекта.

---

## Предполагаю
- Сжатие или очистка устаревшего поля `backgroundImage` внутри `%APPDATA%\Resonance\settings.json` уменьшит размер файла с `15.78 MB` до `< 1 KB` и ускорит старт Go-сайдкар-процесса `local-api.exe`. (Ночью не трогаем, так как `api/main.go` и файлы в `%APPDATA%` находятся в запретной зоне).
