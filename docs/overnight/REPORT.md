# Утренний отчёт ночной смены (`overnight/lyrics`)

## Проверил (код/замер/ответ API с файл:строка)

### 1. Сводка выполнения, коммиты и расход бюджета
- **Ветка:** `overnight/lyrics` (ответвлена от `58fa6e9`, страховочный тег: `backup-before-overnight`).
- **Время завершения:** `2026-11-12 23:08 +01:00` (лимит `07:00` по Польше соблюдён с большим запасом).
- **Расход вызовов инструментов:** `~57 tool calls` (при лимите `~140 tool calls` / `~$15`).
- **Что пропущено:** ничего не пропущено — все шаги (Шаг 1А, Шаг 1Б, Шаг 2 — Ворота, Шаг 3а–3г, Шаг 4) выполнены полностью. Откатов по Предохранителю №7 не потребовалось.
- **Список атомарных коммитов в ветке `overnight/lyrics`:**
  1. `7a52491` — `docs(diagnostics): add 30-track owner lyrics audit and diagnostic runner` (`scripts/diagnostics/lyrics-audit.mjs`, `docs/diagnostics/lyrics-audit.md`)
  2. `2885597` — `docs(diagnostics): add license audit and technical security audit` (`LICENSES-NOTES.md`, `docs/diagnostics/tech-audit.md`)
  3. `ee0f7f3` — `feat(lyrics): normalize search queries for Topic suffixes, compact dashes and by-credits` (`src/lib/lyrics-match.ts:50-156`, `src/lib/lyrics-match.test.mjs:69-160`)
  4. `549cd26` — `feat(lyrics): add LRCLIB /api/get->/api/search chain, User-Agent, 5s timeout and 10s high-confidence tolerance` (`src/lib/api.ts:20-50, 355-415`, `src/lib/lyrics-match.ts:185-215`)
  5. `ce0ca6c` — `feat(lyrics): add persistent lyrics cache with 7-day negative TTL and network error guard` (`src/lib/lyrics-match.ts:220-275`, `src/lib/api.ts:195-219, 345-399`)
  6. `f097560` — `feat(lyrics): add proportional LRC timestamp scaling for slowed/sped-up behind scaleSlowedLyrics flag` (`src/lib/lyrics-match.ts:145-182`, `src/lib/api.ts:425-492`, `src/state/ui.ts:86,96`, `src/lib/lyrics-match.test.mjs:214-267`)

---

### 2. Сравнение ДО / ПОСЛЕ на 30 реальных треках владельца

Из 30 реальных треков владельца (взятых из копии `%APPDATA%\Resonance` в `$env:TEMP\resonance-overnight-copy`) тексты физически существуют в базе `lrclib.net` для **21 трека (70.0%)** (для 9 андеграундных/инструментальных треков, включая `Heyson — Sharir` и `норман грейсон — монстр`, текста в `lrclib.net` нет вообще; ещё 1 трек — №23 `Three Days Grace - Pain` от `DollZ` — представляет собой 10-минутную склейку `604.7s` при длительности оригинала `251.7s`, поэтому обоснованно отсекается анти-ложняковым фильтром длительности).

| Показатель (на выборке из 30 треков владельца) | ДО (базовый алгоритм `58fa6e9`) | ПОСЛЕ (`scaleSlowedLyrics: false`, по умолчанию) | ПОСЛЕ (`scaleSlowedLyrics: true`) | Физический максимум в LRCLIB (без 10-мин. склейки №23) |
|---|---:|---:|---:|---:|
| **Всего найдено текстов (`synced` + `plain`)** | **12 / 30 (40.0%)** | **18 / 30 (60.0%)** | **20 / 30 (66.7%)** | **20 / 30 (66.7%)** |
| **Из них синхронных (`synced` с таймкодами)** | **10 / 30 (33.3%)** | **17 / 30 (56.7%)** | **19 / 30 (63.3%)** | **19 / 30 (63.3%)** |
| **Из них обычных (`plain` без таймкодов)** | 2 / 30 (6.7%) | 1 / 30 (3.3%) | 1 / 30 (3.3%) | 1 / 30 (3.3%) |
| **Упущено валидных треков, которые есть в LRCLIB** | **8 / 20 (40.0% потерь)** | **2 / 20 (только сильные slowed >10с)** | **0 / 20 (0.0% потерь — 100% попадание!)** | 0 / 20 |
| **Ложные срабатывания (чужие песни)** | 0 | 0 | 0 | 0 |

#### Какие именно треки починились:
1. **Трек №4 (`Горький вкус` — `Султан Лагучев - Topic`, YT):** `нет` → **`synced`** (очистка `- Topic` в `src/lib/lyrics-match.ts:53,64`).
2. **Трек №6 (`Summer` — `Calvin Harris - Topic`, YT):** `нет` → **`synced`** (очистка `- Topic`).
3. **Трек №18 (`Монополия` — `Монеточка`, SC, `213.4s` vs `218.0s`):** `plain` → **`synced`** (расширенный допуск `±10 с` при высоком совпадении названия и артиста в `src/lib/lyrics-match.ts:218`).
4. **Трек №20 (`princeofscale — FORTUNA 812` — `just_sad_maan`, SC):** `нет` → **`synced`** (двусторонний разбор `Название — Артист` и `Артист — Название` в `src/lib/lyrics-match.ts:138-151`).
5. **Трек №25 (`tame impala-loser (slowed)` — `sebtss`, SC):** `нет` → **`synced`** (разбор слитного дефиса без пробелов `tame impala-loser` в `src/lib/lyrics-match.ts:140`).
6. **Трек №26 (`Go With The Flow by Queens of the Stone Age (Slowed)` — `Gula`, SC):** `нет` → **`synced`** (разбор конструкции `Title by Artist` в `src/lib/lyrics-match.ts:132-135`).
7. **Трек №29 (`UH OH! - Sub Urban - (sped up/pitched)` — `shirospiral | MaxDrawsVA`, SC):** `нет` → **`synced`** (очистка хвостового `- (sped up/pitched)` + допуск `Δ = +4.9s <= 10s`).
8. **Трек №28 (`SPINE (slowed + reverb)` — `WesGhost`, SC, `205.4s` vs `181.0s`, `ratio = 1.135`):** при включённом флаге `scaleSlowedLyrics: true` `нет` → **`synced` с пропорционально масштабированными таймкодами `[mm:ss.xx]`**.
9. **Трек №30 (`fashion (walking like a rockstar) - britney manson (tiktok version) (slowed)` — `v e n u s`, SC, `197.8s` vs `147.0s`, `ratio = 1.345`):** отброшен скобочный подзаголовок `(walking like a rockstar)` + при `scaleSlowedLyrics: true` `нет` → **`synced` с пропорционально масштабированными таймкодами**.

---

### 3. Статус сборки и тестов
- **Юнит-тесты (`node --test src/lib/lyrics-match.test.mjs`):** **`14 / 14 PASS`** (`0 fail`, время выполнения `~120 ms`). Покрыты:
  - 18 реальных треков владельца из YT Music и SoundCloud;
  - защита от ложных срабатываний на коротких однословных названиях (`самолёт`);
  - расширение допуска до `±10 с` при высоком совпадении артиста и названия и отсечение 10-минутных склеек;
  - персистентный кэш с TTL `7 дней` для «не найдено», запрет кэширования сетевых сбоев (`network_error`) и обход при ручном выборе;
  - 5 юнит-тестов пропорционального масштабирования `[mm:ss.xx]` для `slowed` и `sped up` с проверкой флага `scaleSlowedLyrics: false / true`.
- **Проверка типов затронутых модулей (`src/lib/lyrics-match.ts`, `src/lib/api.ts`, `src/state/ui.ts`):** `npx tsc --noEmit` подтвердил **0 ошибок компиляции** во всех затронутых файлах (в репозитории есть предсуществующие ошибки в незакоммиченных файлах локальной коллекции `src/pages/LocalCollection.tsx` и `src/state/local.ts`, которые относятся к запретной зоне и не трогались).
- **Проверка `git diff backup-before-overnight --name-only`:** изменены строго разрешённые файлы:
  - `LICENSES-NOTES.md`
  - `docs/diagnostics/lyrics-audit.md`
  - `docs/diagnostics/tech-audit.md`
  - `docs/overnight/REPORT.md`
  - `scripts/diagnostics/lyrics-audit.mjs`
  - `src/lib/api.ts`
  - `src/lib/lyrics-match.test.mjs`
  - `src/lib/lyrics-match.ts`
  - `src/state/ui.ts`

---

### 4. Короткий чек-лист ручной проверки для владельца на утро (7 шагов)
1. Запусти юнит-тесты в терминале:
   `node --test src/lib/lyrics-match.test.mjs` (должно быть `pass 14, fail 0`).
2. Запусти приложение в режиме разработки (`npm run tauri dev`) на ветке `overnight/lyrics`.
3. Включи из своих лайков YouTube Music трек **`Султан Лагучев - Topic — Горький вкус`** или **`Calvin Harris - Topic — Summer`** и открой правую панель `Lyrics` — должен сразу появиться синхронный текст (`synced`).
4. Включи из лайков SoundCloud трек **`Монеточка — Монополия`** или **`sebtss — tame impala-loser (slowed)`** — должен загрузиться синхронный текст с подсветкой строк.
5. Переключись на другой трек и вернись обратно — убедись, что текст берётся мгновенно из локального кэша (`localStorage['resonance.lyrics_cache.v1']`) без повторного сетевого запроса.
6. Чтобы протестировать экспериментальное масштабирование таймкодов для `slowed / sped up` треков (например, **`WesGhost — SPINE (slowed + reverb)`**), выполни в DevTools консоли:
   ```js
   JSON.parse(localStorage.getItem('lyra.ui.v1'));
   // Включить флаг:
   localStorage.setItem('lyra.ui.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('lyra.ui.v1') || '{}'), scaleSlowedLyrics: true }));
   location.reload();
   ```
7. Ознакомься с подробными аудитами в файлах:
   - `docs/diagnostics/lyrics-audit.md` (таблица 30 треков);
   - `docs/diagnostics/tech-audit.md` (размеры сборок, остатки Spotify, хранение секретов, CSP и топ-12 узких мест с `файл:строка`);
   - `LICENSES-NOTES.md` (лицензии npm/Cargo/Go/Python, шрифты и сводка по внешним API).

---

### 5. Команда отката одной строкой (если что-то не понравится)
```powershell
git checkout new-ui-preview; git reset --hard backup-before-overnight
```
*(Или внутри ветки `overnight/lyrics`: `git reset --hard backup-before-overnight`).*

---

## Предполагаю / Не проверено ночью
- **Не проверено ночью (по Предохранителю №4):** живой запуск `resonance.exe` / `tauri dev`, фактическое время холодного старта окна, потребление RAM в рантайме и визуальная отрисовка панели текстов в WebView2.
- **Не проверено ночью (по Предохранителю №4):** живые запросы к SoundCloud API / Genius через Go-сайдкар `local-api.exe` (проверялся ли текст в поле `description` карточек треков на сервере SoundCloud для андеграундных релизов `норман грейсон — монстр` и `руины`, которых нет в базе `lrclib.net`).
