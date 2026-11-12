# Аудит поиска текстов песен (Фаза 0б) — 30 реальных треков владельца

## Проверил (код/замер/ответ API с файл:строка)

### 1. Карта текущего кода модуля текстов песен (`src/`, `src-tauri/`, `api/`)
- **`src-tauri/src/`**: поиск по регулярному выражению `lyrics|lrclib` не вернул совпадений — в Rust-слое Tauri (`src-tauri/src/lib.rs`, `src-tauri/src/yt_proxy.rs`) логики поиска текстов нет.
- **`src/lib/lyrics-match.ts`**:
  - `toSeconds` (`src/lib/lyrics-match.ts:4-23`) — нормализация длительности трека/кандидата (мс `> 1800` → секунды, строки `m:ss` → секунды).
  - `normalizeLyricsText` (`src/lib/lyrics-match.ts:25-30`) — приведение к нижнему регистру, замена `ё → е`, удаление не-буквенно-цифровых символов.
  - `tokenizeLyricsText` (`src/lib/lyrics-match.ts:32-38`) — разбиение строки на токены.
  - `stripTrackNoise` (`src/lib/lyrics-match.ts:40-53`) — очистка URL, хэштегов, скобок `(official/lyrics/audio/prod/slowed/reverb/sped up/nightcore/feat/ft...)` и хвостов после дефиса.
  - `tokenOverlapScore` (`src/lib/lyrics-match.ts:55-71`) — взвешенная оценка пересечения токенов (`0.7 * forward + 0.3 * reverse` со штрафом за лишние слова).
  - `artistsMatch` (`src/lib/lyrics-match.ts:76-83`) — сравнение первого артиста (`firstArtist`, разбиение по `, | & | feat | ft | x | и`).
  - `lyricsSearchQueries` (`src/lib/lyrics-match.ts:85-124`) — генерация поисковых пар `{ title, artist }` (разбор `Артист - Название` по `\s+[–—-]\s+`, но **только с пробелами вокруг дефиса** и **без удаления `- Topic`** у YouTube-каналов).
  - `findLyricsCandidate` (`src/lib/lyrics-match.ts:144-205`) — фильтрация и скоринг кандидатов LRCLIB: требует `exactTitle || titleSim >= 0.75`, совпадение артиста `artistsMatch` (либо `>= 3` значимых слов в названии + точное совпадение названия + `deltaSec <= 1.5`), жёсткий фильтр по длительности `deltaSec <= tolerance` (`4 с` для SoundCloud, `8 с` для YouTube) **без учёта `slowed`/`sped up` и без расширенного допуска `±10 с` при полном совпадении артиста и названия**.
- **`src/lib/api.ts`**:
  - `parseLrc` (`src/lib/api.ts:135-144`) и `withGaps` (`src/lib/api.ts:147-162`) — парсинг `[mm:ss.xx]` и вставка маркеров инструментальных пауз.
  - `lyricsCache` (`src/lib/api.ts:164`) — только `Map<string, Promise<LyricsData | null>>` в оперативной памяти (сбрасывается при перезапуске, не хранит TTL `7 дней` для «не найдено» в `localStorage` и не отличает `404 / пустой ответ` от сетевого сбоя при повторных сессиях).
  - `fetchSoundCloudLyrics` (`src/lib/api.ts:212-235`) — обращается к локальному Go-сайдкар-серверу `/api/tracks/:id/lyrics`, а при неудаче падает в `fetchLyrics(t, 4)`.
  - `fetchLyrics` (`src/lib/api.ts:237-263`) — делает запросы **только к `https://lrclib.net/api/search`** без предварительного точного вызова `/api/get`, без заголовка `User-Agent` и без `AbortController` таймаута `5 с`.
  - `getLyrics` (`src/lib/api.ts:290-310`) — проверяет `t.lyrics`, ручные оверрайды `lyra.lyrics.overrides.v1`, `lyricsCache` и вызывает `fetchSoundCloudLyrics` / `fetchLyrics`.
- **`src/components/LyricsModal.tsx:1-140`** и **`src/components/RightPanel.tsx:222-330`**: UI-компоненты отображения синхронных/обычных текстов и модалка ручного выбора текста.
- **`api/lyrics.go:1-614`** (Go-сайдкар `local-api.exe`): содержит серверный поиск LRCLIB/Genius и функцию `scaleLyricsToPlayingCopy` (`api/lyrics.go:519-546`), однако во фронтенде (`src/lib/api.ts:237-263`), который напрямую обслуживает YouTube Music и выступает фоллбэком для SoundCloud, ни `/api/get`, ни масштабирование таймкодов `slowed/sped up`, ни очистка `- Topic` и слитных дефисов не реализованы.

---

### 2. Источник выборки (30 реальных треков владельца)
Выборка извлечена из резервной копии пользовательских данных в `$env:TEMP\resonance-overnight-copy\C__Users_krako_AppData_Roaming_Resonance\`:
- `frontend-state.json` (`lyra.lib.v1.ytmusicLiked`, `lyra.lib.v1.ytmusicPlaylistTracks`, `lyra.lib.v1.soundcloudLiked`);
- `youtube-discover.json` (сохранённая локально выдача главной страницы YouTube).
Оригинальные файлы в `%APPDATA%\Resonance` не изменялись. Диагностический скрипт: `scripts/diagnostics/lyrics-audit.mjs` (импортирует напрямую `src/lib/lyrics-match.ts` и хранит слепок базового алгоритма для честного сравнения «ДО / ПОСЛЕ»). Все запросы к `https://lrclib.net` выполнялись с заголовком `User-Agent: Resonance/0.4.16 (https://github.com/BohdanKrakoviatskyi/Resonance)`, паузой `>= 550 мс` и таймаутом `5000 мс`.

---

### 3. Полная таблица диагностики 30 треков (Базовый алгоритм ДО правок vs LRCLIB после глубокой очистки)

| № | Группа | Источник / ID | Исходный `title` | Исходный `artist` | Длит. трека | Текущий алгоритм (ДО) | Скор (ДО) | Причина отказа / Выбор (ДО) | LRCLIB (после очистки) | Лучший кандидат в LRCLIB | Длит. LRCLIB | Δs (с) | Δ% | Ratio (`track/orig`) | Поле `description` в локальном кэше |
|---:|---|---|---|---|---:|---|---:|---|---|---|---:|---:|---:|---:|---|
| 1 | 1. Популярные YT | `yt:yq5uy4tMOW8` | `POISON. (feat. Pranav.Wav)` | `Kill Dyll` | 180.0s | **plain** | 0.99 | OK (`Kill Dyll - POISON.`) | **plain** | `Kill Dyll — POISON.` | 179.4s | +0.6s | +0.4% | 1.004 | не проверено (нет в локальном кэше) |
| 2 | 1. Популярные YT | `yt:YkY4X_OaF6o` | `I Got Love (feat. Рем Дигга)` | `Miyagi & Andy Panda - Topic` | 277.0s | **synced** | 1.15 | OK (`Miyagi & Эндшпиль - I Got Love`) | **synced** | `Miyagi & Andy Panda — I Got Love (feat. Rem Digga)` | 277.0s | 0.0s | 0.0% | 1.000 | не проверено (нет в локальном кэше) |
| 3 | 1. Популярные YT | `yt:ljUtuoFt-8c` | `Smells Like Teen Spirit` | `Nirvana - Topic` | 302.0s | **synced** | 1.15 | OK (`Nirvana - Topic - Smells Like Teen Spirit`) | **synced** | `Nirvana — Smells Like Teen Spirit` | 302.0s | 0.0s | 0.0% | 1.000 | не проверено (нет в локальном кэше) |
| 4 | 1. Популярные YT | `yt:Wa29AenQ0Pg` | `Горький вкус` | ` Султан Лагучев - Topic` | 179.0s | **нет** | 0.00 | `0 candidates from LRCLIB` (суффикс `- Topic` сломал поиск) | **synced** | `Султан Лагучев — Горький вкус` | 179.0s | 0.0s | 0.0% | 1.000 | не проверено (нет в локальном кэше) |
| 5 | 1. Популярные YT | `yt:rJ0D1GbDq1Q` | `Let Me Love You` | `DJ Snake - Topic` | 206.0s | **synced** | 1.15 | OK (`DJ Snake - Topic - Let Me Love You`) | **synced** | `DJ Snake — Let Me Love You` | 206.0s | 0.0s | 0.0% | 1.000 | не проверено (нет в локальном кэше) |
| 6 | 1. Популярные YT | `yt:KSgKKSny0Qo` | `Summer` | `Calvin Harris - Topic` | 223.0s | **нет** | 0.00 | `0 candidates from LRCLIB` (суффикс `- Topic` сломал поиск) | **synced** | `Calvin Harris — Summer` | 223.0s | 0.0s | 0.0% | 1.000 | не проверено (нет в локальном кэше) |
| 7 | 2. Нишевые YT | `yt:Jo0BrxWv_ZY` | `Sharir` | `Heyson` | 221.0s | **нет** | 0.00 | `0 candidates from LRCLIB` (инструментал/нет в базе) | **нет** | — | — | — | — | — | не проверено (нет в локальном кэше) |
| 8 | 2. Нишевые YT | `yt:xM8_mp6WHvM` | `JOHAN X Goddamn - Slowmotion` | `JOHAN X Goddamn` | 239.0s | **synced** | 1.15 | OK (`Goddamn, JOHAN - Slowmotion`) | **synced** | `JOHAN x Goddamn — Slowmotion` | 238.0s | +1.0s | +0.4% | 1.004 | не проверено (нет в локальном кэше) |
| 9 | 2. Нишевые YT | `yt:uVHy_yYTmQ8` | `Инсомния` | `god.damn` | 220.0s | **нет** | 0.00 | `0 candidates from LRCLIB` (нет в базе) | **нет** | — | — | — | — | — | не проверено (нет в локальном кэше) |
| 10 | 2. Нишевые YT | `yt:Z9e87ShPWkg` | `Инферно 2.0` | `JOHAN` | 189.0s | **synced** | 1.15 | OK (`JOHAN - Инферно 2.0`) | **synced** | `JOHAN — Инферно 2.0` | 189.0s | 0.0s | 0.0% | 1.000 | не проверено (нет в локальном кэше) |
| 11 | 2. Нишевые YT | `yt:HY1maTNlhro` | `JOHAN x Goddamn - Марианская впадина` | `JOHAN X Goddamn` | 139.0s | **нет** | 0.00 | `0 candidates from LRCLIB` (нет в базе) | **нет** | — | — | — | — | — | не проверено (нет в локальном кэше) |
| 12 | 2. Нишевые YT | `yt:sf268FLvIFo` | `Step Back` | `MOBA` | 122.0s | **нет** | 0.00 | `0 candidates from LRCLIB` (нет в базе) | **нет** | — | — | — | — | — | не проверено (нет в локальном кэше) |
| 13 | 3. Русский SC | `sc:2244975557` | `монстр` | `норман грейсон` | 96.1s | **нет** | 0.00 | `0 candidates from LRCLIB` (андеграунд, нет в базе) | **нет** | — | — | — | — | — | не проверено (нет в локальном кэше) |
| 14 | 3. Русский SC | `sc:2378331938` | `руины` | `норман грейсон` | 154.1s | **нет** | 0.00 | `0 candidates from LRCLIB` (андеграунд, нет в базе) | **нет** | — | — | — | — | — | не проверено (нет в локальном кэше) |
| 15 | 3. Русский SC | `sc:2181168775` | `BATO - Miura` | `Русская Рэп-Сцена` | 102.2s | **нет** | 0.00 | `0 candidates from LRCLIB` (нет в базе) | **нет** | — | — | — | — | — | не проверено (нет в локальном кэше) |
| 16 | 3. Русский SC | `sc:1329114463` | `права` | `ooes` | 146.4s | **synced** | 1.14 | OK (`ooes - права`) | **synced** | `ooes — права` | 146.0s | +0.4s | +0.3% | 1.003 | не проверено (нет в локальном кэше) |
| 17 | 3. Русский SC | `sc:1736194716` | `ЧСВ` | `Lida` | 196.3s | **synced** | 1.14 | OK (`Lida - ЧСВ`) | **synced** | `Lida — ЧСВ` | 196.0s | +0.3s | +0.1% | 1.001 | не проверено (нет в локальном кэше) |
| 18 | 3. Русский SC | `sc:1828902918` | `Монополия` | `Монеточка` | 213.4s | **plain** | 0.99 | OK (`Монеточка - Монополия`, но упущен `synced` с Δ=-4.6s > 4s) | **synced** | `Монеточка — Монополия` | 218.0s | -4.6s | -2.1% | 0.979 | не проверено (нет в локальном кэше) |
| 19 | 4. Англ. SC | `sc:1671739464` | `trytofriend (prod. cloudly006)` | `FORTUNA 812` | 112.7s | **synced** | 1.13 | OK (`FORTUNA 812 - TryToFriend`) | **synced** | `FORTUNA 812 — TryToFriend` | 112.0s | +0.7s | +0.6% | 1.006 | не проверено (нет в локальном кэше) |
| 20 | 4. Англ. SC | `sc:1809057783` | `princeofscale — FORTUNA 812` | `just_sad_maan` | 73.7s | **нет** | 0.00 | `0 candidates from LRCLIB` (порядок `Название — Артист` у перезалива) | **synced** | `FORTUNA 812 — princeofscale` | 74.0s | -0.3s | -0.4% | 0.996 | не проверено (нет в локальном кэше) |
| 21 | 4. Англ. SC | `sc:2054341756` | `COCAINE NOSE` | `playboicarti` | 151.2s | **synced** | 1.15 | OK (`playboicarti - COCAINE NOSE`) | **synced** | `playboicarti — COCAINE NOSE` | 151.0s | +0.2s | +0.1% | 1.001 | не проверено (нет в локальном кэше) |
| 22 | 4. Англ. SC | `sc:1621195320` | `stephanie` | `nafeesisboujee` | 127.0s | **synced** | 1.15 | OK (`Nafeesisboujee - Stephanie`) | **synced** | `Nafeesisboujee — Stephanie` | 127.0s | 0.0s | 0.0% | 1.000 | не проверено (нет в локальном кэше) |
| 23 | 4. Англ. SC | `sc:1079294878` | `Three Days Grace - Pain` | `DollZ` | 604.7s | **нет** | 0.00 | `Δdur=353.0s > 4s` (склейка/растянутый трек 10 мин vs оригинал 251.7s) | **synced** | `Three Days Grace — Pain` | 251.7s | +353.0s | +140.3% | 2.403 | не проверено (нет в локальном кэше) |
| 24 | 4. Англ. SC | `sc:2404993503` | `Queen St` | `XIII` | 123.0s | **нет** | 0.00 | `0 candidates from LRCLIB` (нет в базе) | **нет** | — | — | — | — | — | не проверено (нет в локальном кэше) |
| 25 | 5. Slowed/SpedUp | `sc:2374954142` | `tame impala-loser (slowed)` | `sebtss` | 247.7s | **нет** | 0.00 | `0 candidates from LRCLIB` (слитный дефис без пробелов `tame impala-loser`) | **synced** | `Tame Impala — Loser` | 248.0s | -0.3s | -0.1% | 0.999 | не проверено (нет в локальном кэше) |
| 26 | 5. Slowed/SpedUp | `sc:1087041055` | `Go With The Flow by Queens of the Stone Age (Slowed)` | `Gula` | 210.1s | **нет** | 0.00 | `0 candidates from LRCLIB` (конструкция `Title by Artist` + `by` вырезал часть строки) | **synced** | `Queens Of The Stone Age — Go With the Flow` | 212.0s | -1.9s | -0.9% | 0.991 | не проверено (нет в локальном кэше) |
| 27 | 5. Slowed/SpedUp | `sc:2188476955` | `фортуна812,elox1m - порезы на руках (slowed & reverb)` | `kyzuk` | 161.1s | **нет** | 0.00 | `0 candidates from LRCLIB` (нет в базе) | **нет** | — | — | — | — | — | не проверено (нет в локальном кэше) |
| 28 | 5. Slowed/SpedUp | `sc:1807026363` | `SPINE (slowed + reverb)` | `WesGhost` | 205.4s | **нет** | 0.00 | `Δdur=24.4s > 4s` (`WesGhost - SPINE`, slowed-версия длиннее на 13.5%) | **synced** | `WesGhost — SPINE` | 181.0s | +24.4s | +13.5% | 1.135 | не проверено (нет в локальном кэше) |
| 29 | 5. Slowed/SpedUp | `sc:1534314757` | `UH OH! - Sub Urban - (sped up/pitched)` | `shirospiral \| MaxDrawsVA` | 123.9s | **нет** | 0.00 | `0 candidates from LRCLIB` (двойной дефис + порядок `Title - Artist`) | **synced** | `Sub Urban — UH OH! (feat. BENEE)` | 119.0s | +4.9s | +4.1% | 1.041 | не проверено (нет в локальном кэше) |
| 30 | 5. Slowed/SpedUp | `sc:1652940906` | `fashion (walking like a rockstar) - britney manson (tiktok version) (slowed)` | `v e n u s` | 197.8s | **нет** | 0.00 | `0 candidates from LRCLIB` (подзаголовок в скобках + `(tiktok version)` + `Δdur=+50.8s`) | **synced** | `Britney Manson — FASHION` | 147.0s | +50.8s | +34.5% | 1.345 | не проверено (нет в локальном кэше) |

---

### 4. Итоговая статистика и проверка ворот (Шаг 2 — GATE)
1. **Всего треков в выборке:** `30` (100%).
2. **Текста вообще нет в `lrclib.net` даже при глубокой очистке:** `9 из 30` (**30.0%**) — треки №7 (`Sharir — Heyson`), №9, №11, №12, №13 (`монстр — норман грейсон`), №14, №15, №24, №27.
3. **Текст есть в `lrclib.net`:** `21 из 30` (**70.0%**).
4. **Найдено текущим алгоритмом (ДО):** `12 из 30` (**40.0%**, причём трек №18 `Монеточка — Монополия` нашёлся только как `plain`, хотя в LRCLIB есть `synced` с разницей `-4.6 с`).
5. **Упущено нашим текущим поиском (текст в LRCLIB есть, но базовый алгоритм вернул `null`):** `9 из 30` (**30.0%**) — треки №4, №6, №20, №23 (10-минутный микс, оправданно отклоняется по длительности), №25, №26, №28, №29, №30. Даже без учёта 10-минутного трека №23 наш поиск упустил **8 валидных треков из 30 (26.7%)**, плюс на треке №18 потерял синхронный текст (`synced` → `plain`).
6. **Решение по Воротам (Шаг 2):** `26.7%` (8 треков) / `30.0%` (9 треков) **>= 15% (5 треков)** → **Ворота пройдены, выполнение Шага 3 (подпункты а, б, в, г) разрешено и математически обосновано.**
7. **Доказательство пользы для пункта 3г (`slowed / sped up`):** на треках №28 (`SPINE (slowed + reverb)`, `ratio = 1.135`, `+24.4s`), №29 (`UH OH! (sped up/pitched)`, `ratio = 1.041`, `+4.9s`) и №30 (`fashion (slowed)`, `ratio = 1.345`, `+50.8s`) в LRCLIB есть синхронные оригиналы того же артиста, которые отсекаются стандартным допуском `±4s..±10s` и требуют пропорционального масштабирования таймкодов `track_dur / orig_dur`.

---

## Предполагаю
- Для андеграундных русскоязычных SoundCloud-треков (`норман грейсон — монстр`, `норман грейсон — руины`, `фортуна812, elox1m — порезы на руках`) и инструментальных релизов (`Heyson — Sharir`) текстов нет в публичном каталоге LRCLIB; для них единственный возможный источник — поле `description` карточки трека на SoundCloud или Genius (если артист выложил текст в описание). В локальном кэше `frontend-state.json` поле `description` у облегчённых карточек `Track` не сохраняется (`undefined`).
