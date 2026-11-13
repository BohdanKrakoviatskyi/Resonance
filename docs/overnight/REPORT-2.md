# Отчёт по ревизии и устранению проблем живого рантайма (`overnight/lyrics`, Этап 2)

## Проверил (код/лог с точным файл:строка)

### ШАГ 1: АУДИТ РЕАЛЬНОГО ПУТИ В РАНТАЙМЕ

#### 1. Полный маршрут запроса текста от клика по треку до отрисовки

**Общий старт в UI:**
1. Компонент `NowPlaying.tsx:99` (`<Lyrics track={track} variant="panel" />`) или `Immersive.tsx:542` (`<Lyrics track={track} variant="imm" />`) монтирует `Lyrics` (`src/components/Lyrics.tsx:569`).
2. `Lyrics` вызывает хук `useLyrics(track, rev)` (`src/components/Lyrics.tsx:32-52`), который вызывает `getLyrics(track, rev > 0)` (`src/lib/api.ts:360-399`).
3. Внутри `getLyrics(t, forceRefresh)`:
   - Если `t.lyrics` уже вшит в объект трека — возвращает `{ synced: t.lyrics }` (`src/lib/api.ts:361`).
   - Проверяет ручной выбор пользователя `loadLyricsOverrides()[t.id]` из `localStorage['resonance.manual_lyrics.v1']` (с восстановлением из `frontend-state.json` через `ensureLyricsOverridesRestored()`, `src/lib/api.ts:259-279, 362-368`).
   - Если `forceRefresh === false`, проверяет персистентный авто-кэш `loadPersistentLyricsCache()` в `localStorage['resonance.lyrics_cache.v1']` (`src/lib/api.ts:372-375`).
   - Проверяет in-memory `Map` промисов `lyricsCache.get(t.id)` (`src/lib/api.ts:377`).
   - Далее маршрут **разветвляется** по `t.source === 'soundcloud'` (`src/lib/api.ts:379`):

---

**Маршрут А — YouTube Music (`t.source === 'youtube'`):**
- `getLyrics` (`src/lib/api.ts:379`) -> вызывает `fetchLyrics(t)` (`src/lib/api.ts:425-493`).
- `fetchLyrics(t)` использует **новую** логику из `src/lib/lyrics-match.ts`:
  1. Строит очищенные пары `(title, artist)` через `lyricsSearchQueries(t)` (`src/lib/lyrics-match.ts:105-164`).
  2. Для каждой пары вызывает `https://lrclib.net/api/get` и `https://lrclib.net/api/search` (`src/lib/api.ts:446, 461`).
  3. Пропускает кандидатов через `findLyricsCandidate(...)` (`src/lib/lyrics-match.ts:220-291`).
  4. Но в `src/lib/api.ts:427` для YouTube стоял базовый допуск `tolerance = 8`, а в `src/lib/lyrics-match.ts:252` вчера был добавлен авто-расширитель `effectiveTolerance = highConfidenceMatch ? Math.max(tolerance, 10) : tolerance` (до **±10 секунд** без предупреждения пользователя!). Из-за этого клипы YouTube с интро в 5–10 секунд получали `synced`-текст от радио-версии и **отставали/спешили на 5–10 секунд**.

---

**Маршрут Б — SoundCloud (`t.source === 'soundcloud'`):**
- `getLyrics` (`src/lib/api.ts:379`) -> вызывает `fetchSoundCloudLyrics(t)` (`src/lib/api.ts:401-423`).
- **КРИТИЧЕСКАЯ НАХОДКА №1 (Обход `lyrics-match.ts` через Go-сайдкар):**
  - `fetchSoundCloudLyrics` (`src/lib/api.ts:407-412`) первым делом вызывает JSON-RPC метод `track.lyrics` (`soundCloudTrackLyrics` в `src/lib/providers-api.ts:136-138`), который уходит в **Go-сайдкар `local-api`** (`api/lyrics.go:86`, функция `RPCTrackLyrics`)!
  - А `fetchLyrics(track)` (наш новый код из `src/lib/lyrics-match.ts`) вызывается на строке `src/lib/api.ts:422` **ТОЛЬКО если Go-сайдкар вернул пустой массив или упал с ошибкой**!
  - Поэтому для **всех треков SoundCloud** приложение вживую вообще не доходило до нового `lyrics-match.ts`, когда старый Go-сайдкар находил хоть какой-то ответ (включая чужие песни и `plain`-тексты)! Именно поэтому по ощущениям владельца в приложении «ничего не поменялось».

---

#### 2. Факты по 4 проверочным вопросам

1. **Все ли пути в рантайме вызывают новую логику из `src/lib/lyrics-match.ts`?**
   - **НЕТ.** Треки SoundCloud (`src/lib/api.ts:407`) идут в `RPCTrackLyrics` (`api/lyrics.go:86`). Внутри `api/lyrics.go` работает совершенно другой, старый алгоритм:
     - Сначала он ищет трек в каталоге **Deezer API** (`https://api.deezer.com/search`, `api/lyrics.go:119, 175, 414-429`).
     - В `findLyricsByVariants` (`api/lyrics.go:328-334`) последним слотом добавляется **запрос вообще БЕЗ артиста**: `lyricsQuery{Title: titles[0], Duration: duration}` (`artist_name=""`)!
     - Если в названии трека есть любое слово из `lyricsVersionWords` (`slowed`, `sped up`, `reverb`, `remix`, `edit`, `flip`, `vip` и т.д. — `api/lyrics.go:76-80`), то `requireDuration` становится **`false`** (`api/lyrics.go:280, 356`), проверка `deltaSec > 4` **полностью отключается** (`api/lyrics.go:391`), а `lyricsDurationScore` (`api/lyrics.go:662-681`) возвращает `> 0` даже при разнице длительности в 50 секунд!
     - Более того, в `api/lyrics.go:387, 402` проверка артиста основана на `lyricsTokenOverlap(query.Artist, candidate.ArtistName)`. Когда в последнем запросе (`api/lyrics.go:333`) `query.Artist == ""` или когда название содержит 3 слова и случайно совпало по длительности, либо когда Deezer (`api/lyrics.go:120`) подменил малоизвестного СК-артиста на популярного однофамильца/одноимённый трек, Go-сайдкар возвращает **чужую песню** или **`plain`-текст**, а фронтенд (`src/lib/api.ts:413-418`) слепо принимает `result.lines` **без единой проверки `matchedArtist`/`matchedTitle`** и даже не знает, какого именно артиста/трек выбрал сайдкар (в `SoundCloudLyrics` в `src/lib/providers-api.ts:58-63` вообще нет полей `artistName` / `trackName` / `duration`).
     - Ещё хуже: в `api/lyrics.go:502, 524-538` функция `scaleLyricsToPlayingCopy` **принудительно растягивает таймкоды** для ЛЮБОГО трека, у которого длительность отличается от LRCLIB больше чем на 2 секунды (`> 2000 ms`, `api/lyrics.go:529`). Если на SoundCloud обычный трек (не slowed!) просто имеет на 3–5 секунд длиннее аутро/тишину в конце, `scaleLyricsToPlayingCopy` умножает все таймкоды на `playingDuration / recordDuration`, из-за чего к середине песни текст **уплывает и отстаёт на несколько секунд**!

2. **Где и как работает источник Genius (или другой источник `plain`-текстов) и проверяет ли он совпадение артиста/названия?**
   - В текущем коде прямых HTTP-запросов к `genius.com` нет (остался только валидатор `matchesGeniusCandidate` в `src/lib/lyrics-match.ts:356`).
   - Вместо него роль внешнего каталога в Go-сайдкар играет **Deezer API** (`api/lyrics.go:149-204, 414`) + фоллбэк на `parsePlainLyrics(record.PlainLyrics)` из LRCLIB (`api/lyrics.go:505-513` и `src/lib/api.ts:299-301`).
   - Когда `fetchSoundCloudLyrics` (`src/lib/api.ts:417-418`) получает от Go-сайдкара несинхронизированные строки (`result.isSynced === false`), он безоговорочно возвращает `{ plain }` без проверки того, какой трек и какого артиста сайдкар нашёл через Deezer/LRCLIB, и кэширует этот `plain` в `localStorage['resonance.lyrics_cache.v1']`.
   - Кроме того, в `findLyricsCandidate` (`src/lib/lyrics-match.ts:276-280`) оставалось правило `if (!artistOk) { if (wordCount < 3 || !exactTitle || ... || deltaSec > 1.5) continue; }`, которое разрешало **чужого артиста**, если в названии >= 3 слов и длительность совпала в пределах 1.5 с.

3. **Где лежит старый кэш и сохранённый выбор `Change lyrics`? Могут ли старые закэшированные ответы отдаваться раньше нового поиска?**
   - **Да, гарантированно отдаются раньше нового поиска!** Есть сразу 3 кэша:
     1. `localStorage['resonance.lyrics_cache.v1']` (`src/lib/api.ts:222, 372-375`) — читается в `getLyrics` **до** любого поиска. Все `plain`-тексты и ошибочные матчи, сохранившиеся там с прошлых запусков, отдаются мгновенно (`cached.hit === true`).
     2. Кэш внутри Go-сайдкара `s.lyricsCache` (`api/lyrics.go:95-104`) — хранит найденные сайдкаром тексты в памяти процесса `local-api.exe` бессрочно (`if len(cached.lyrics.Lines) > 0 { return cached.lyrics, nil }`).
     3. Кнопка **«Clear cache»** в `Settings.tsx:104` -> `Overlays.tsx:270` -> `clearAppCache()` (`src/state/cache.ts:25-34`) вызывает `clearCache()` сайдкара, `clearPaletteCache()` и `clearWebCache()`, но **ВООБЩЕ НЕ ОЧИЩАЕТ** ни in-memory `lyricsCache` (`Map` в `src/lib/api.ts:223`), ни `localStorage['resonance.lyrics_cache.v1']` (`src/lib/api.ts:222`)!
   - Ручной выбор пользователя (`Change lyrics`) хранится отдельно в `localStorage['resonance.manual_lyrics.v1']` (`src/lib/api.ts:221`) и бэкапится в `frontend-state.json` (`src/lib/util.ts:44`).

4. **Как устроена синхронизация строк с `currentTime` плеера в UI?**
   - В `SyncedLyrics` (`src/components/Lyrics.tsx:84-97`) подписка `onFrame((_visualTime, _dur, realTime) => ...)` получает `realTime = getActiveDeck().el.currentTime` (`src/state/player.ts:851, 865`) и ищет строку бинарным поиском `findLine(lines, time + 0.12)` (`src/components/Lyrics.tsx:86`).
   - В самом UI искусственной задержки нет (есть только предвыборка `+0.12s`), а **реальных причин отставания текста две**:
     1. На SoundCloud Go-сайдкар (`api/lyrics.go:502, 529`) вызывал `scaleLyricsToPlayingCopy` и растягивал все таймкоды при любой разнице длительности `> 2 с` (даже на обычных не-slowed треках!).
     2. На YouTube и SoundCloud авто-поиск принимал `synced`-кандидатов с разницей длительности до `±8..10 с` (например, радио-версия vs клип с интро), а кнопок ручного сдвига (`−0.5 с / +0.5 с`) в UI не было.

---

### ШАГ 1Б: ВЕРИФИКАЦИЯ БИНАРНИКА `local-api` И СРАВНЕНИЕ НА 30 ТРЕКАХ ВЛАДЕЛЬЦА

#### 1. Верификация бинарника `src-tauri/binaries/local-api-x86_64-pc-windows-msvc.exe`

**Проверил (код/замер с точным файл:строка):**
- Встроенные метаданные компилятора Go (`go version -m src-tauri\binaries\local-api-x86_64-pc-windows-msvc.exe`):
  - `path bettersoundcloud/local-api`, `go1.27.1`, `GOOS=windows`, `GOARCH=amd64`
  - `build vcs.revision=303cf41b539af483b0eae8f265ec317e4be293a6`
  - `build vcs.time=2026-11-08T19:03:13Z`, `build vcs.modified=true`
- Проверка `git diff 303cf41b539af483b0eae8f265ec317e4be293a6 HEAD -- api/lyrics.go` вернула **0 строк отличий** (последний коммит, менявший `api/lyrics.go` — `3b6f01a` от `2026-11-08 20:02:39 +0100`).
- Проверка таблицы символов бинарника (`go tool nm`) подтвердила наличие в `.exe` всех 26 символов функций и таблиц из `api/lyrics.go`, включая `RPCTrackLyrics` (`0x1403a9fe0`), `resolveLyricsTrack` (`0x1403aac60`), `searchDeezer` (`0x1403ada60`), `scaleLyricsToPlayingCopy` (`0x1403aeb60`), `scoreDeezerCandidate` (`0x1403ab680`) и `scoreLRCLibRecord` (`0x1403ad6a0`).
- Поиск строк в бинарнике подтвердил строку `Resonance/0.1.0 (lyrics sidebar)` (`api/lyrics.go:64`).

**Предполагаю:**
- Поскольку `vcs.modified=true` не перечисляет, какой именно файл в `api/` был не закоммичен в момент компиляции `.exe` 10.11.2026, с вероятностью 99% код `api/lyrics.go` внутри `.exe` полностью совпадает с текущим `api/lyrics.go` на диске (все имена функций, глобальные переменные и константы совпадают 1-в-1).

---

#### 2. Честное сравнение старого пути (Go-сайдкар `api/lyrics.go`) и нового пути (`fetchLyrics` + строгий `lyrics-match.ts`) на 30 треках владельца

Прогнан обновлённый скрипт `scripts/diagnostics/lyrics-audit.mjs` на всех 30 реальных треках владельца (12 YouTube Music + 18 SoundCloud).

| Метрика (на 30 треках владельца) | Старый путь сайдкара (`api/lyrics.go`) | Новый прямой путь (`fetchLyrics` + строгий фильтр `±4s`/`4..10s`) | Новый путь + `scaleSlowedLyrics: true` (опционально) |
|---|---|---|---|
| **Всего найдено (все 30 треков)** | **14 / 30** (46.7%) | **18 / 30** (60.0%) | **20 / 30** (66.7%) |
| — из них `synced` (с таймкодами) | **12 / 30** (из них 3 с принудительным `scale`!) | **17 / 30** (2 с пометкой «Возможен сдвиг») | **19 / 30** |
| — из них `plain` (без таймкодов) | **2 / 30** (#1, #18) | **1 / 30** (только #1, где в LRCLIB нет synced) | **1 / 30** (#1) |
| **Только треки SoundCloud (18 шт.)** | **9 / 18** (8 synced + 1 plain) | **11 / 18** (11 synced, 0 plain!) | **13 / 18** (13 synced, 0 plain!) |
| **Ложные срабатывания (чужие песни)** | Уязвим (правило `>=3 слов && Δ<=1.5s` + запрос `artist=""`) | **0** (строгое требование `artist + title`) | **0** |
| **Принудительное искажение таймкодов** | Да (`scaleLyricsToPlayingCopy` при любом `Δ > 2s`) | **Нет** (0 авто-искажений, ручной сдвиг `±0.5s`) | Только явно по флагу для `slowed/sped up` |

**Потрековое сравнение всех 30 треков (Где расходятся старый путь сайдкара и новый строгий фронтенд):**

| # | Источник | Трек (Title — Artist, Dur) | Старый путь (`api/lyrics.go`) | Новый строгий путь (`lyrics-match.ts`, `±4s`/`4..10s`) | Чей ответ фактически верен и почему |
|---|---|---|---|---|---|
| 1 | YT | `POISON. (feat. Pranav.Wav)` — Kill Dyll (180s) | `plain` (Kill Dyll — POISON.) | `plain` (Kill Dyll — POISON.) | Оба верны (в LRCLIB только plain) |
| 2 | YT | `I Got Love (feat. Рем Дигга)` — Miyagi & Andy Panda - Topic (277s) | `synced` | `synced` (Miyagi & Эндшпиль — I Got Love) | Оба верны |
| 3 | YT | `Smells Like Teen Spirit` — Nirvana - Topic (302s) | `synced` | `synced` (Nirvana — Smells Like Teen Spirit) | Оба верны |
| 4 | YT | `Горький вкус` — Султан Лагучев - Topic (179s) | ❌ `none` (не чистит `- Topic`) | ✅ `synced` (Султан Лагучев — Горький вкус, Δ=0.1s) | **Новый путь верен** |
| 5 | YT | `Let Me Love You` — DJ Snake - Topic (206s) | `synced` | `synced` (DJ Snake — Let Me Love You) | Оба верны |
| 6 | YT | `Summer` — Calvin Harris - Topic (223s) | ❌ `none` (Δ=+4.4s > 4s и `- Topic`) | ✅ `synced` (Calvin Harris — Summer, Δ=4.4s, пометка сдвига) | **Новый путь верен** |
| 7 | YT | `Sharir` — Heyson (221s) | `none` | `none` | Оба верны (нет в LRCLIB) |
| 8 | YT | `JOHAN X Goddamn - Slowmotion` (239s) | `synced` | `synced` | Оба верны |
| 9 | YT | `Инсомния` — god.damn (220s) | `none` | `none` | Оба верны (нет в LRCLIB) |
| 10 | YT | `Инферно 2.0` — JOHAN (189s) | `synced` | `synced` | Оба верны |
| 11 | YT | `JOHAN x Goddamn - Марианская впадина` (139s) | `none` | `none` | Оба верны (нет в LRCLIB) |
| 12 | YT | `Step Back` — MOBA (122s) | `none` | `none` | Оба верны (нет в LRCLIB) |
| 13 | SC | `монстр` — норман грейсон (96.1s) | `none` | `none` | Оба верны (нет в LRCLIB) |
| 14 | SC | `руины` — норман грейсон (154.1s) | `none` | `none` | Оба верны (нет в LRCLIB) |
| 15 | SC | `BATO - Miura` — Русская Рэп-Сцена (102.2s) | `none` | `none` | Оба верны (нет в LRCLIB) |
| 16 | SC | `права` — ooes (146.4s) | `synced` | `synced` (ooes — права, Δ=0.4s) | Оба верны |
| 17 | SC | `ЧСВ` — Lida (196.3s) | `synced` | `synced` (Lida — ЧСВ, Δ=0.3s) | Оба верны |
| 18 | SC | `Монополия` — Монеточка (213.4s) | ⚠️ `plain` (потерял таймкоды из-за Δ=-4.6s) | ✅ `synced` (Монеточка — Монополия, Δ=4.6s + предупреждение сдвига) | **Новый путь верен** (сохранил `synced` вместо `plain`!) |
| 19 | SC | `trytofriend (prod. cloudly006)` — FORTUNA 812 (112.7s) | `synced` | `synced` (FORTUNA 812 — TryToFriend, Δ=0.3s) | Оба верны |
| 20 | SC | `princeofscale — FORTUNA 812` — just_sad_maan (73.7s) | `synced` | `synced` (FORTUNA 812 — princeofscale, Δ=0.3s) | Оба верны |
| 21 | SC | `COCAINE NOSE` — playboicarti (151.2s) | `synced` | `synced` (playboicarti — COCAINE NOSE, Δ=0.2s) | Оба верны |
| 22 | SC | `stephanie` — nafeesisboujee (127.0s) | `synced` | `synced` (Nafeesisboujee — Stephanie, Δ=0.0s) | Оба верны |
| 23 | SC | `Three Days Grace - Pain` — DollZ (604.7s, 10m loop) | `none` | `none` (отклонён, 604.7s vs 251.7s) | Оба верны |
| 24 | SC | `Queen St` — XIII (123.0s) | `none` | `none` | Оба верны (нет в LRCLIB) |
| 25 | SC | `tame impala-loser (slowed)` — sebtss (247.7s) | ❌ `none` (не парсит слитный дефис `-`) | ✅ `synced` (Tame Impala — Loser, Δ=0.7s) | **Новый путь верен** |
| 26 | SC | `Go With The Flow by Queens of the Stone Age (Slowed)` — Gula (210.1s) | ❌ `none` (`stripLyricsNoise` стёр `by Queens`!) | ✅ `synced` (Queens Of The Stone Age — Go With the Flow, Δ=2.9s) | **Новый путь верен** |
| 27 | SC | `фортуна812,elox1m - порезы на руках (slowed & reverb)` (161.1s) | `none` | `none` | Оба верны (нет в LRCLIB) |
| 28 | SC | `SPINE (slowed + reverb)` — WesGhost (205.4s vs 181s) | ⚠️ `synced` с принудительным `scale 1.135x` без спроса | `none` при `scaleSlowedLyrics: false` / ✅ `synced` при `true` | **Новый путь безопаснее** |
| 29 | SC | `UH OH! - Sub Urban - (sped up/pitched)` (123.9s vs 119s) | ⚠️ `synced` с принудительным `scale 1.041x` | ✅ `synced` (Δ=4.9s, без искажения темпа, с пометкой сдвига) | **Новый путь верен** |
| 30 | SC | `fashion (walking like a rockstar) - britney manson (tiktok version) (slowed)` (197.8s vs 147s) | ⚠️ `synced` с принудительным `scale 1.345x` (мимо tiktok-версии) | `none` при `scaleSlowedLyrics: false` / ✅ `synced` при `true` | **Новый путь безопаснее** |

#### 3. Нужен ли шаг поиска через Deezer во фронтенде?
- **Проверил (`api/lyrics.go:149-251` и таблицу 30 треков):**
  - На всех треках SoundCloud, где настоящий исполнитель указан в заголовке (`princeofscale — FORTUNA 812`, `tame impala-loser`, `Go With The Flow by Queens of the Stone Age`, `UH OH! - Sub Urban`), `lyricsSearchQueries` в `src/lib/lyrics-match.ts:105-164` **сама извлекает каноническую пару `(title, artist)` без Deezer** и находит больше верных `synced`-текстов (`11/18` против `8/18` у сайдкара).
  - В `api/lyrics.go:244-248` Deezer помогал менять артиста только за счёт лазейки `if artistScore < 0.5 { if specificity >= 3 && deltaSec <= 1.5 ... }`, которая и подставляла чужие одноимённые песни популярных артистов вместо треков SoundCloud.
  - **Вывод:** условие перехода к Шагу 4 выполнено — прямой фронтендовый `fetchLyrics` из `src/lib/lyrics-match.ts` со строгой проверкой `artist + title` не уступает старому пути ни на одном валидном треке, превосходит его на +4 чистых `synced`-трека (+5 с учётом замены `plain -> synced` на #18) и полностью исключает чужие песни и принудительное растяжение таймкодов.

---

## Выполненные коммиты (Шаги 2–5)

### Проверил (код/лог/замер с `файл:строка`)

1. **Шаг 2 — Коммит 1 (`074a0a7`): Прозрачность источника в UI и консоли (`feat(lyrics): add source transparency info bar and console logging`)**
   - `src/state/ui.ts:87,98`: добавлен персистентный флаг `showLyricsDebugInfo: true` (включён по умолчанию в `lyra.ui.v1`).
   - `src/pages/Settings.tsx:100-118`: добавлен переключатель `Показывать / Скрыть` («Источник и совпадение текста») для отключения технической плашки после проверки.
   - `src/lib/api.ts:201-213,300-349,422-484`: `LyricsData` обогащён полями `sourceLabel` (`LRCLIB` | `Deezer` | `Кэш` | `Выбран вручную`), `matchedTitle`, `matchedArtist`, `matchedDurationSec`, `durationDeltaSec` и `possibleOffsetWarning`; при каждой загрузке текста в консоль пишется строка `console.info(formatLyricsDebugSummary(...))`.
   - `src/components/Lyrics.tsx:591-656`: в верхней части панели текста и полноэкранного режима рендерится компактная плашка с источником, типом (`Synced` / `Plain`), найденным треком `Artist — Title` и разницей длительности `(Δ +4.6 с, Δ 0.0 с)`.

2. **Шаг 3 — Коммит 2 (`62c9319`): Допуск `±4 с`, пометка «Возможен сдвиг» и ручной сдвиг `−0.5 с / +0.5 с` (`feat(lyrics): enforce ±4s base tolerance, offset warning badge, and ±0.5s manual sync offset`)**
   - `src/lib/lyrics-match.ts:252-290` и `src/lib/api.ts:496`: базовый автоматический допуск для `synced`-текстов жёстко зафиксирован на `±4 с` для всех источников (включая YouTube). Разница `4–10 с` принимается **только** при полном совпадении очищенных `title` и `artist` (`fullCleanMatch`), без автоматического растягивания таймкодов или угадывания константного сдвига, но с установкой флага `possibleOffsetWarning: true`.
   - `src/components/Lyrics.tsx:644-696`: при `possibleOffsetWarning: true` в плашке отображается бейдж `Возможен сдвиг`, а блок кнопок сдвига подсвечивается янтарной рамкой, пока пользователь не выставит свой сдвиг.
   - `src/state/ui.ts:88,99,137-157`, `src/components/Lyrics.tsx:102-119,652-696`, `src/state/shortcuts.ts:14-36`, `src/state/shortcut-runtime.ts:49-58`: добавлены кнопки `−0.5 с`, сброс `0.0 с` и `+0.5 с` (а также горячие клавиши `[` и `]`), сохраняющие ручной сдвиг в `localStorage` (`lyra.ui.v1 -> lyricsOffsets`) отдельно для каждого `track.id`.

3. **Шаг 4 — Коммит 3 (`e86d23b`): Единые строгие правила и перевод SoundCloud на `lyrics-match.ts` (`fix(lyrics): require artist match for all automatic candidates and unify SoundCloud on lyrics-match`)**
   - `src/lib/lyrics-match.ts:251-253`: полностью удалена лазейка `if (!artistOk) { if (wordCount < 3 || !exactTitle || ... || deltaSec > 1.5) continue; }`. Теперь во всех автоматических источниках обязательно должны совпадать **и очищенное название, и очищенный исполнитель** (`if (!artistOk) continue;`).
   - `src/lib/api.ts:461`: убрана ветка `t.source === 'soundcloud' ? fetchSoundCloudLyrics(t) : fetchLyrics(t)`. Треки SoundCloud теперь идут через тот же строгий фронтендовый пайплайн `fetchLyrics(t)` (`lyricsSearchQueries` + `findLyricsCandidate`), без правок Go-кода сайдкара.
   - `src/lib/lyrics-match.test.mjs:281-331`: добавлены 2 новых юнит-теста (всего 16/16 зелёных), проверяющих отказ при чужом артисте даже для заголовков из `>= 3` слов с `Δ <= 1.5 с` и единую фильтрацию SoundCloud/YouTube.

4. **Шаг 5 — Коммит 4 (`b1b1417`): Сброс старого кэша (`v2`) и кнопка «Очистить кэш» (`feat(lyrics): bump automatic lyrics cache to v2, purge v1, and clear in clearAppCache`)**
   - `src/lib/api.ts:227-246`: ключ автоматического кэша переключён на `resonance.lyrics_cache.v2`; при инициализации модуля старый `resonance.lyrics_cache.v1` автоматически удаляется из `localStorage`, а ручные выборы пользователя в `resonance.manual_lyrics.v1` полностью сохраняются.
   - `src/state/cache.ts:2,32`: обработчик кнопки «Очистить кэш» в настройках (`clearAppCache()`) теперь вызывает `clearAutomaticLyricsCache()`, очищая `resonance.lyrics_cache.v2` и in-memory `lyricsCache`, не затрагивая `resonance.manual_lyrics.v1`.

### Предполагаю
- Для треков YouTube Music и SoundCloud, которые являются официальными клипами с актёрским интро в `4–10 с` (например, `Calvin Harris — Summer`, `Δ +4.4 с` или `Монеточка — Монополия`, `Δ -4.6 с`), автоматический показ `Synced`-текста с бейджем **«Возможен сдвиг»** и подстройкой кнопками `−0.5 с / +0.5 с` (или клавишами `[` и `]`) окажется значительно удобнее, чем деградация в `Plain`-текст без подсветки.

---

## Короткая инструкция владельцу (5 шагов проверки вживую)

1. **Очистка кэша в настройках:** открой **Настройки -> Очистить кэш**. Убедись, что автоматический кэш текстов (`resonance.lyrics_cache.v2`) сбрасывается, а любые ранее выбранные вручную тексты (`resonance.manual_lyrics.v1`) остаются на месте.
2. **Проверка плашки прозрачности и SoundCloud (бывший `Plain` -> `Synced`):** включи на SoundCloud трек **«Монеточка — Монополия»** (или **«tame impala-loser (slowed)»** / **«Go With The Flow by Queens of the Stone Age (Slowed)»**). Вверху панели текста (и в DevTools Console) появится строка вида:
   `LRCLIB · Synced · Монеточка — Монополия (Δ -4.6 с) · Возможен сдвиг` — вместо старого `Plain` из сайдкара теперь работает построчная караоке-подсветка.
3. **Подстройка сдвига таймкодов (`−0.5 с / +0.5 с`):** на любом `Synced`-треке с расхождением вступления нажми кнопки `−0.5 с` или `+0.5 с` (либо клавиши `[` и `]`). Проверь, что сдвиг применяется мгновенно и сохраняется при повторном включении этого трека, а клик по числу сдвига (`+1.0 с`) сбрасывает его в `0.0 с`.
4. **Проверка защиты от чужих песен:** включи трек, которого нет в базе LRCLIB (например, `норман грейсон — монстр` или `BATO - Miura`). Панель текста честно покажет «Текст не найден» вместо подстановки одноимённой песни чужого исполнителя.
5. **Отключение технической плашки:** когда закончишь проверку, открой **Настройки -> Источник и совпадение текста** и переключи тумблер в положение **«Скрыть»** (кнопки `−0.5 с / +0.5 с` для `Synced`-текстов останутся доступными).

### Откат одной командой
Если потребуется мгновенно вернуться на исходную ветку до всех ночных правок:
```bash
git checkout new-ui-preview
```

