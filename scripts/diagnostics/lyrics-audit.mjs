#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  findLyricsCandidate,
  lyricsSearchQueries,
  stripTrackNoise,
  normalizeLyricsText,
  tokenOverlapScore,
  artistsMatch,
  toSeconds,
} from '../../src/lib/lyrics-match.ts';

const USER_AGENT = 'Resonance/0.4.16 (https://github.com/BohdanKrakoviatskyi/Resonance)';
const MIN_DELAY_MS = 550;
const TIMEOUT_MS = 5000;

const copyDir = path.join(os.tmpdir(), 'resonance-overnight-copy', 'C__Users_krako_AppData_Roaming_Resonance');
const httpCachePath = path.join(os.tmpdir(), 'resonance-overnight-copy', 'lrclib-http-cache.json');

let httpCache = {};
try {
  if (fs.existsSync(httpCachePath)) {
    httpCache = JSON.parse(fs.readFileSync(httpCachePath, 'utf8'));
  }
} catch {
  httpCache = {};
}

let lastRequestTime = 0;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchLrclib(url) {
  if (Object.prototype.hasOwnProperty.call(httpCache, url)) {
    return httpCache[url];
  }
  const now = Date.now();
  const wait = Math.max(0, MIN_DELAY_MS - (now - lastRequestTime));
  if (wait > 0) await sleep(wait);
  lastRequestTime = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 404) {
      httpCache[url] = { status: 404, data: null };
      fs.writeFileSync(httpCachePath, JSON.stringify(httpCache, null, 2));
      return httpCache[url];
    }
    if (!res.ok) {
      return { status: res.status, data: null, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    httpCache[url] = { status: 200, data };
    fs.writeFileSync(httpCachePath, JSON.stringify(httpCache, null, 2));
    return httpCache[url];
  } catch (err) {
    clearTimeout(timer);
    return { status: 0, data: null, error: String(err.message || err) };
  }
}

function loadOwnerSampleTracks() {
  const fstate = JSON.parse(fs.readFileSync(path.join(copyDir, 'frontend-state.json'), 'utf8'));
  const entries = fstate.entries || fstate;
  const lib = typeof entries['lyra.lib.v1'] === 'string' ? JSON.parse(entries['lyra.lib.v1']) : entries['lyra.lib.v1'];
  const disc = JSON.parse(fs.readFileSync(path.join(copyDir, 'youtube-discover.json'), 'utf8'));

  const scLiked = lib.soundcloudLiked || [];
  const ytLiked = lib.ytmusicLiked || [];
  const ytPlaylists = Object.values(lib.ytmusicPlaylistTracks || {}).flat();
  const discItems = (disc.rows || []).flatMap((r) =>
    (r.items || r.tracks || []).map((it) => ({
      id: `yt:${it.id || it.videoId || it.nativeId}`,
      source: 'youtube',
      title: it.title,
      artist: it.artist || it.subtitle || it.channel || 'Unknown',
      duration: toSeconds(it.duration || it.durationMs),
      description: it.description,
      _origin: `youtube-discover:${r.title}`,
    })),
  );

  const byId = new Map();
  for (const t of [...ytLiked, ...ytPlaylists, ...scLiked, ...discItems]) {
    if (t && t.id && !byId.has(t.id)) byId.set(t.id, t);
  }

  const pick = (id) => {
    const t = byId.get(id);
    if (!t) throw new Error(`Missing expected track id ${id}`);
    return t;
  };

  // Group 1: Популярные треки YouTube Music (6)
  const group1 = [
    { ...pick('yt:yq5uy4tMOW8'), group: '1. Популярные YT Music' }, // Kill Dyll - POISON. (feat. Pranav.Wav)
    { ...pick('yt:YkY4X_OaF6o'), group: '1. Популярные YT Music' }, // I Got Love (feat. Рем Дигга) - Miyagi & Andy Panda - Topic
    { ...pick('yt:ljUtuoFt-8c'), group: '1. Популярные YT Music' }, // Smells Like Teen Spirit - Nirvana - Topic
    { ...pick('yt:Wa29AenQ0Pg'), group: '1. Популярные YT Music' }, // Горький вкус - Султан Лагучев - Topic
    { ...pick('yt:rJ0D1GbDq1Q'), group: '1. Популярные YT Music' }, // Let Me Love You - DJ Snake - Topic
    { ...pick('yt:KSgKKSny0Qo'), group: '1. Популярные YT Music' }, // Summer - Calvin Harris - Topic
  ];

  // Group 2: Нишевые/редкие треки YouTube Music (6, включая Sharir - Heyson)
  const group2 = [
    { ...pick('yt:Jo0BrxWv_ZY'), group: '2. Нишевые YT Music' }, // Sharir - Heyson
    { ...pick('yt:xM8_mp6WHvM'), group: '2. Нишевые YT Music' }, // JOHAN X Goddamn - Slowmotion
    { ...pick('yt:uVHy_yYTmQ8'), group: '2. Нишевые YT Music' }, // Инсомния - god.damn
    { ...pick('yt:Z9e87ShPWkg'), group: '2. Нишевые YT Music' }, // Инферно 2.0 - JOHAN
    { ...pick('yt:HY1maTNlhro'), group: '2. Нишевые YT Music' }, // JOHAN x Goddamn - Марианская впадина
    { ...pick('yt:sf268FLvIFo'), group: '2. Нишевые YT Music' }, // Step Back - MOBA
  ];

  // Group 3: Русскоязычный SoundCloud (6, включая монстр - норман грейсон)
  const group3 = [
    { ...pick('sc:2244975557'), group: '3. Русский SoundCloud' }, // монстр - норман грейсон
    { ...pick('sc:2378331938'), group: '3. Русский SoundCloud' }, // руины - норман грейсон
    { ...pick('sc:2181168775'), group: '3. Русский SoundCloud' }, // BATO - Miura - Русская Рэп-Сцена
    { ...pick('sc:1329114463'), group: '3. Русский SoundCloud' }, // права - ooes
    { ...pick('sc:1736194716'), group: '3. Русский SoundCloud' }, // ЧСВ - Lida
    { ...pick('sc:1828902918'), group: '3. Русский SoundCloud' }, // Монополия - Монеточка
  ];

  // Group 4: Англоязычный SoundCloud (6)
  const group4 = [
    { ...pick('sc:1671739464'), group: '4. Англ. SoundCloud' }, // trytofriend (prod. cloudly006) - FORTUNA 812
    { ...pick('sc:1809057783'), group: '4. Англ. SoundCloud' }, // princeofscale — FORTUNA 812 - just_sad_maan
    { ...pick('sc:2054341756'), group: '4. Англ. SoundCloud' }, // COCAINE NOSE - playboicarti
    { ...pick('sc:1621195320'), group: '4. Англ. SoundCloud' }, // stephanie - nafeesisboujee
    { ...pick('sc:1079294878'), group: '4. Англ. SoundCloud' }, // Three Days Grace - Pain - DollZ
    { ...pick('sc:2404993503'), group: '4. Англ. SoundCloud' }, // Queen St - XIII
  ];

  // Group 5: Версии slowed / reverb / sped up / remix (6)
  const group5 = [
    { ...pick('sc:2374954142'), group: '5. Slowed/SpedUp/Remix' }, // tame impala-loser (slowed) - sebtss
    { ...pick('sc:1087041055'), group: '5. Slowed/SpedUp/Remix' }, // Go With The Flow by Queens of the Stone Age (Slowed) - Gula
    { ...pick('sc:2188476955'), group: '5. Slowed/SpedUp/Remix' }, // фортуна812,elox1m - порезы на руках (slowed & reverb) - kyzuk
    { ...pick('sc:1807026363'), group: '5. Slowed/SpedUp/Remix' }, // SPINE (slowed + reverb) - WesGhost
    { ...pick('sc:1534314757'), group: '5. Slowed/SpedUp/Remix' }, // UH OH! - Sub Urban - (sped up/pitched) - shirospiral | MaxDrawsVA
    { ...pick('sc:1652940906'), group: '5. Slowed/SpedUp/Remix' }, // fashion (walking like a rockstar) - britney manson (tiktok version) (slowed) - v e n u s
  ];

  return [...group1, ...group2, ...group3, ...group4, ...group5];
}

// Baseline simulation: exact logic of current src/lib/api.ts + src/lib/lyrics-match.ts BEFORE changes
// We keep a snapshot of the baseline logic here so that in Step 4 we can compare BEFORE vs AFTER side-by-side.
function baselineStripTrackNoise(value) {
  return value
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/#\S+/g, ' ')
    .replace(/\+\S+/g, ' ')
    .replace(/\s*[[(](?:official\b|lyrics?\b|audio\b|music video\b|visuali[sz]er\b|4k\b|hd\b|mv\b|prod\b|slowed\b|reverb\b|sped\s*up\b|speed\s*up\b|nightcore\b|alt\s*ver\b|tgk?\b|vk\b|by\b|feat\b|ft\b)[^\])]*[\])]/gi, ' ')
    .replace(/\s*[[(][^\])]*(?:prod\.?|slowed|reverb|speed\s*up|sped\s*up|nightcore|alt\s*ver|tgk?:|vk:)[^\])]*[\])]/gi, ' ')
    .replace(/\b(?:prod\.?|tgk?:?|vk:?)\s*[\p{L}\p{N}_.@/-]+/giu, ' ')
    .replace(/\b(?:ft|feat|featuring)\.?\s+[\p{L}\p{N}&,'’. -]+/giu, ' ')
    .replace(/\s*(?:[-–—|])\s*(?:official\b|lyrics?\b|audio\b|music video\b|visuali[sz]er\b|slowed\b|sped\s*up\b|speed\s*up\b|reverb\b|nightcore\b|alt\s*ver\b).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const baselineFirstArtist = (value) =>
  value.split(/,|&| feat\.? | ft\.? | featuring | x | и /i)[0].trim();

function baselineQueries(track) {
  const cleanedTitle = baselineStripTrackNoise(track.title);
  const uploader = baselineFirstArtist(baselineStripTrackNoise(track.artist));
  const queries = [];
  const add = (nextTitle, nextArtist) => {
    const clean = { title: baselineStripTrackNoise(nextTitle), artist: baselineFirstArtist(baselineStripTrackNoise(nextArtist)) };
    if (
      clean.title &&
      clean.artist &&
      !queries.some(
        (q) =>
          normalizeLyricsText(q.title) === normalizeLyricsText(clean.title) &&
          normalizeLyricsText(q.artist) === normalizeLyricsText(clean.artist),
      )
    ) {
      queries.push(clean);
    }
  };
  const parts = cleanedTitle.match(/^(.+?)\s+[–—-]\s+(.+)$/);
  if (parts) {
    const left = parts[1].trim();
    const right = parts[2].trim();
    if (normalizeLyricsText(right) === normalizeLyricsText(uploader)) {
      add(left, right);
    } else {
      add(right, left);
      if (uploader && normalizeLyricsText(left) !== normalizeLyricsText(uploader)) {
        add(right, uploader);
      }
    }
  }
  add(cleanedTitle, uploader);
  if (cleanedTitle !== track.title.trim()) add(track.title, uploader);
  return queries;
}

function baselineFindCandidate(candidates, query, rawDuration, tolerance = 4) {
  const wantSec = toSeconds(rawDuration);
  const queryTitleNorm = normalizeLyricsText(baselineStripTrackNoise(query.title));
  if (!queryTitleNorm) return { match: null, reason: 'empty query title' };
  const FILLER = new Set(['a','an','and','are','as','at','be','but','by','for','from','i','if','in','is','it','me','my','of','on','or','the','to','up','we','you','your']);
  const words = new Set(
    baselineStripTrackNoise(query.title)
      .toLocaleLowerCase()
      .replace(/ё/g, 'е')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t && !FILLER.has(t)),
  );
  const wordCount = words.size;

  const scored = [];
  const rejectReasons = [];

  for (const candidate of candidates) {
    if (!candidate.syncedLyrics && !candidate.plainLyrics && !candidate.instrumental) continue;
    const candTitle = candidate.trackName ?? '';
    const candArtist = candidate.artistName ?? '';
    const candSec = toSeconds(candidate.duration);

    const a = new Set(baselineStripTrackNoise(query.title).toLocaleLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    const b = new Set(baselineStripTrackNoise(candTitle).toLocaleLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    let titleSim = 0;
    if (a.size && b.size) {
      let fwd = 0, rev = 0;
      for (const t of a) if (b.has(t)) fwd++;
      for (const t of b) if (a.has(t)) rev++;
      const base = (fwd / a.size) * 0.7 + (rev / b.size) * 0.3;
      const surplus = Math.max(0, b.size - a.size);
      const pen = Math.min(0.45, (surplus / b.size) * 0.45);
      titleSim = base * (1 - pen);
    }

    const exactTitle = normalizeLyricsText(baselineStripTrackNoise(candTitle)) === queryTitleNorm;
    if (!exactTitle && titleSim < 0.75) {
      rejectReasons.push(`title mismatch (${candTitle})`);
      continue;
    }

    const qa = normalizeLyricsText(baselineFirstArtist(query.artist));
    const ca = normalizeLyricsText(baselineFirstArtist(candArtist));
    let artistOk = false;
    if (qa && ca) {
      if (qa === ca) artistOk = true;
      else {
        const sa = new Set(baselineStripTrackNoise(query.artist).toLocaleLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter(Boolean));
        const sb = new Set(baselineStripTrackNoise(candArtist).toLocaleLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter(Boolean));
        if (sa.size && sb.size) {
          let fwd = 0, rev = 0;
          for (const t of sa) if (sb.has(t)) fwd++;
          for (const t of sb) if (sa.has(t)) rev++;
          const base = (fwd / sa.size) * 0.7 + (rev / sb.size) * 0.3;
          const surplus = Math.max(0, sb.size - sa.size);
          const pen = Math.min(0.45, (surplus / sb.size) * 0.45);
          artistOk = base * (1 - pen) >= 0.65;
        }
      }
    }

    const deltaSec = wantSec > 0 && candSec > 0 ? Math.abs(wantSec - candSec) : 0;
    if (wantSec > 0 && candSec > 0 && deltaSec > tolerance) {
      rejectReasons.push(`Δdur=${deltaSec.toFixed(1)}s > ${tolerance}s (${candArtist} - ${candTitle})`);
      continue;
    }

    if (!artistOk) {
      if (wordCount < 3 || !exactTitle || wantSec <= 0 || candSec <= 0 || deltaSec > 1.5) {
        rejectReasons.push(`artist mismatch (${query.artist} vs ${candArtist})`);
        continue;
      }
    }

    const durBonus = wantSec > 0 && candSec > 0 ? Math.max(0, 1 - deltaSec / Math.max(tolerance, 1)) : 0.5;
    const syncBonus = candidate.syncedLyrics ? 0.15 : 0;
    const score = (exactTitle ? 1 : titleSim) * 0.55 + (artistOk ? 0.35 : 0) + durBonus * 0.1 + syncBonus;
    scored.push({ candidate, score });
  }

  scored.sort((a, b) => b.score - a.score);
  if (scored[0]) return { match: scored[0].candidate, score: scored[0].score, reason: 'ok' };
  return { match: null, score: 0, reason: rejectReasons[0] || '0 candidates from LRCLIB' };
}

// Deep clean query generator for checking what LRCLIB actually has
function buildDeepCleanProbes(track) {
  let rawTitle = track.title
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\.mp3$|\.wav$/i, '')
    .trim();
  let rawArtist = track.artist
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .trim();

  // Strip noise brackets/tags
  const cleanNoise = (s) =>
    s
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/#\S+/g, ' ')
      .replace(/\+\S+/g, ' ')
      .replace(/\s*[[(][^\])]*(?:official|lyric|audio|video|visuali[sz]er|4k|hd|mv|prod|slowed|reverb|sped|speed|nightcore|pitched|tiktok|version|boosted|mix|remix|edit|now on all plats|премьера|клип)[^\])]*[\])]/gi, ' ')
      .replace(/\b(?:prod\.?)\s*[\p{L}\p{N}_.@/-]+/giu, ' ')
      .replace(/\b(?:ft|feat|featuring)\.?\s+[^-–—|()[\]]+/giu, ' ')
      .replace(/\b(?:slowed|reverb|sped\s*up|speed\s*up|nightcore|bass\s*boosted)\b.*$/gi, ' ')
      .replace(/[♥𒉭🔥💔]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const stripParentheticalSubtitle = (s) => s.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();

  const probes = [];
  const pushProbe = (t, a) => {
    const ct = cleanNoise(t).replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim();
    const ca = cleanNoise(a).replace(/\s*-\s*Topic$/i, '').replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim();
    if (ct && ca && !probes.some((p) => p.title.toLowerCase() === ct.toLowerCase() && p.artist.toLowerCase() === ca.toLowerCase())) {
      probes.push({ title: ct, artist: ca });
    }
    const ctShort = stripParentheticalSubtitle(ct);
    if (ctShort && ctShort !== ct && ca && !probes.some((p) => p.title.toLowerCase() === ctShort.toLowerCase() && p.artist.toLowerCase() === ca.toLowerCase())) {
      probes.push({ title: ctShort, artist: ca });
    }
  };

  // Check "Title by Artist" pattern (e.g., "Go With The Flow by Queens of the Stone Age (Slowed)")
  const byMatch = cleanNoise(rawTitle).match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch) {
    pushProbe(byMatch[1], byMatch[2]);
  }

  // Check dash separator (including tight dash like "tame impala-loser" or "Треточие- романтик" or "UH OH! - Sub Urban - (sped up)")
  const cleanedFullTitle = cleanNoise(rawTitle);
  const dashParts = cleanedFullTitle.split(/\s*[-–—]\s*/).filter(Boolean);
  if (dashParts.length >= 2) {
    // Try Artist - Title and Title - Artist
    pushProbe(dashParts[1], dashParts[0]);
    pushProbe(dashParts[0], dashParts[1]);
    // Also first artist if comma/x/& in dashParts[0]
    const firstLeft = dashParts[0].split(/,|&|\bx\b/i)[0].trim();
    if (firstLeft && firstLeft !== dashParts[0]) {
      pushProbe(dashParts[1], firstLeft);
    }
  }

  pushProbe(rawTitle, rawArtist);
  const firstRawArtist = rawArtist.split(/,|&|\bx\b/i)[0].trim();
  if (firstRawArtist && firstRawArtist !== rawArtist) {
    pushProbe(rawTitle, firstRawArtist);
  }

  return probes;
}

// --- Sidecar Go algorithm exact port (from api/lyrics.go) for Step 1B comparison ---
const GO_VERSION_WORDS = [
  'slowed', 'sped up', 'speed up', 'reverb', 'bass boosted', 'remix', 'edit', 'flip',
  'mashup', 'slow version', 'rework', 're-work', 'bootleg', 'vip', 'nightcore', '8d',
  'reversed', 'acapella', 'capella', 'spedup', 'slowedit', 'alt ver', 'alt version',
];

function goStripLyricsNoise(value) {
  let v = String(value || '');
  v = v.replace(/\[[^\]]*\]/g, ' ');
  v = v.replace(/\([^)]*\)/g, ' ');
  v = v.replace(/#\S+/g, ' ');
  v = v.replace(/\+\S+/g, ' ');
  v = v.replace(/https?:\/\/\S+/gi, ' ');
  v = v.replace(/\b(?:prod|tgk|tg|vk|inst|sc|by)\.?\s*[:.]?\s*[\p{L}\p{N}_.@/-]+/giu, ' ');
  v = v.replace(/\b(?:ft|feat|featuring|with)\.?\s+[\p{L}\p{N}&,'’. -]+/giu, ' ');
  return v.trim().replace(/\s+/g, ' ').replace(/^[ .\-_–—]+|[ .\-_–—]+$/g, '');
}

function goStripLyricsVersionMarkers(value) {
  let v = String(value || '');
  for (const marker of GO_VERSION_WORDS) {
    const clean = marker.replace(/\.+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${clean}\\b`, 'gi');
    v = v.replace(re, ' ');
  }
  return v.trim().replace(/\s+/g, ' ').replace(/^[ .\-_–—]+|[ .\-_–—]+$/g, '');
}

function goNormalizePunctuation(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(' ');
}

function goHasVersionMarker(value) {
  const norm = ` ${goNormalizePunctuation(value)} `;
  for (const w of GO_VERSION_WORDS) {
    const m = ` ${goNormalizePunctuation(w)} `;
    if (norm.includes(m)) return true;
  }
  return false;
}

function goTokenSet(value) {
  return new Set(
    String(value || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
}

function goTokenOverlap(want, have) {
  const a = goTokenSet(goStripLyricsNoise(want));
  const b = goTokenSet(goStripLyricsNoise(have));
  if (!a.size || !b.size) return 0;
  let fwd = 0;
  let rev = 0;
  for (const t of a) if (b.has(t)) fwd++;
  for (const t of b) if (a.has(t)) rev++;
  const base = (fwd / a.size) * 0.7 + (rev / b.size) * 0.3;
  const surplus = Math.max(0, b.size - a.size);
  const penalty = Math.min(0.45, (surplus / b.size) * 0.45);
  return base * (1 - penalty);
}

function goTitleSpecificity(value) {
  const filler = new Set(['a','an','and','are','as','at','be','but','by','can','do','for','from','i','if','in','is','it','me','my','of','on','or','the','to','up','we','what','when','where','who','you','your']);
  let count = 0;
  for (const t of goTokenSet(value)) {
    if (!filler.has(t)) count++;
  }
  return count;
}

function goDurationScore(want, have) {
  if (want <= 0 || have <= 0) return 0.6;
  const delta = Math.abs(want - have);
  if (delta <= 2) return 1;
  if (delta <= 5) return 0.8;
  if (delta <= 12) return 0.5;
  if (delta / (want + have) > 0.35) return 0;
  return 0.2;
}

function goScoreLRCLibRecord(query, candidate, requireDuration) {
  const titleScore = goTokenOverlap(query.title, candidate.trackName || '');
  if (titleScore < 0.72) return null;
  const artistScore = goTokenOverlap(query.artist, candidate.artistName || '');
  const specificity = goTitleSpecificity(query.title);
  const candDur = Number(candidate.duration || 0);
  const deltaSec = Math.abs(query.duration - candDur);

  if (requireDuration && query.duration > 0 && candDur > 0) {
    if (deltaSec > 4) return null;
  }
  const durationScore = goDurationScore(query.duration, Math.round(candDur));
  if (durationScore === 0 && requireDuration) return null;

  if (artistScore < 0.5) {
    if (specificity < 3 || titleScore < 0.98 || query.duration <= 0 || candDur <= 0 || deltaSec > 1.5) {
      return null;
    }
  }
  let rank = titleScore * 0.62 + artistScore * 0.33 + durationScore * 0.05;
  if (candidate.syncedLyrics) rank += 0.04;
  return { rank, titleScore, artistScore, durationScore, deltaSec };
}

function goTitleVariants(value) {
  const parts = String(value || '').split(/\s+[-–—]\s+/);
  const out = [];
  const pushUnique = (s) => {
    const t = String(s || '').trim();
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  pushUnique(value);
  for (const p of parts) pushUnique(goStripLyricsNoise(p));
  return out.slice(0, 4);
}

function goArtistHints(track, title) {
  const out = [];
  const pushUnique = (s) => {
    const t = String(s || '').trim();
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  pushUnique(track.artist);
  for (const p of String(title || '').split(/\s+[-–—]\s+/)) {
    pushUnique(goStripLyricsNoise(p));
  }
  return out;
}

async function simulateGoSidecarLyrics(track, durSec) {
  const duration = durSec > 0 ? Math.round(durSec) : 0;
  const base = goStripLyricsNoise(track.title);
  let titles = goTitleVariants(goStripLyricsVersionMarkers(base));
  if (!titles.length) titles = goTitleVariants(base);
  const artists = goArtistHints(track, base);
  const queries = [];
  let limitReached = false;
  for (const title of titles) {
    for (const artist of artists) {
      if (goTokenOverlap(title, artist) >= 0.75) continue;
      if (queries.length >= 7) {
        limitReached = true;
        break;
      }
      queries.push({ title, artist, duration });
    }
    if (limitReached) break;
  }
  if (queries.length < 8 && titles.length > 0) {
    queries.push({ title: titles[0], artist: '', duration });
  }

  let best = null;
  const seen = new Set();
  const requireDur = durSec > 0 && !goHasVersionMarker(track.title);
  for (const q of queries) {
    const key = `${q.title.toLowerCase()}\0${q.artist.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const params = new URLSearchParams({ track_name: q.title, artist_name: q.artist });
    const res = await fetchLrclib(`https://lrclib.net/api/search?${params}`);
    const candidates = Array.isArray(res.data) ? res.data : [];
    for (const cand of candidates) {
      if (!cand || cand.instrumental || (!cand.syncedLyrics && !cand.plainLyrics)) continue;
      const score = goScoreLRCLibRecord(q, cand, requireDur);
      if (!score) continue;
      if (!best || score.rank > best.score.rank) {
        best = { record: cand, score, queryUsed: q };
      }
    }
    if (best && best.score.rank >= 0.93) break;
  }
  if (!best) return null;
  const recDur = Number(best.record.duration || 0);
  const deltaMs = Math.abs(durSec * 1000 - recDur * 1000);
  const ratio = recDur > 0 ? durSec / recDur : 1;
  const wouldForceScale = Boolean(best.record.syncedLyrics && deltaMs > 2000 && ratio >= 0.5 && ratio <= 1.8);
  return {
    record: best.record,
    score: best.score,
    queryUsed: best.queryUsed,
    wouldForceScale,
    scaleRatio: Number(ratio.toFixed(3)),
  };
}

// Strict Frontend matcher simulation (without the 3-word foreign artist loophole, ±4s base / 4..10s exact artist+title with warning)
function strictFrontendFindCandidate(candidates, query, rawDuration) {
  const wantSec = toSeconds(rawDuration);
  const queryTitleNorm = normalizeLyricsText(stripTrackNoise(query.title));
  const queryArtistNorm = normalizeLyricsText(stripTrackNoise(query.artist));
  if (!queryTitleNorm || !queryArtistNorm) return null;

  const scored = [];
  for (const candidate of candidates) {
    if (!candidate || (!candidate.syncedLyrics && !candidate.plainLyrics && !candidate.instrumental)) continue;
    const candTitle = candidate.trackName ?? '';
    const candArtist = candidate.artistName ?? '';
    const candSec = toSeconds(candidate.duration);

    const titleSim = tokenOverlapScore(query.title, candTitle);
    const exactTitle = normalizeLyricsText(stripTrackNoise(candTitle)) === queryTitleNorm;
    if (!exactTitle && titleSim < 0.75) continue;

    // STRICT RULE: Artist MUST match! No 3-word loophole.
    const artistOk = artistsMatch(query.artist, candArtist);
    if (!artistOk) continue;

    const highConfidenceMatch =
      (exactTitle || titleSim >= 0.9) &&
      (normalizeLyricsText(stripTrackNoise(candArtist)) === queryArtistNorm ||
        tokenOverlapScore(query.artist, candArtist) >= 0.85);

    const deltaSec = wantSec > 0 && candSec > 0 ? Math.abs(wantSec - candSec) : 0;
    const maxTolerance = highConfidenceMatch ? 10 : 4;
    if (wantSec > 0 && candSec > 0 && deltaSec > maxTolerance) continue;

    const possibleOffsetWarning = Boolean(candidate.syncedLyrics && wantSec > 0 && candSec > 0 && deltaSec > 4);
    const durBonus = wantSec > 0 && candSec > 0 ? Math.max(0, 1 - deltaSec / maxTolerance) : 0.5;
    const syncBonus = candidate.syncedLyrics ? 0.15 : 0;
    const score = (exactTitle ? 1 : titleSim) * 0.55 + 0.35 + durBonus * 0.1 + syncBonus;
    scored.push({ candidate, score, deltaSec, possibleOffsetWarning });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

async function runAudit() {
  const tracks = loadOwnerSampleTracks();
  console.log(`Loaded ${tracks.length} owner tracks for audit.`);

  const rows = [];
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const durSec = toSeconds(t.fullDuration ?? t.duration);
    const bTolerance = t.source === 'youtube' ? 8 : 4;
    const bQueries = baselineQueries(t);

    // 1. Run baseline algorithm
    let bMatch = null;
    let bScore = 0;
    let bReason = 'no queries';
    for (const q of bQueries) {
      const params = new URLSearchParams({ track_name: q.title, artist_name: q.artist });
      const res = await fetchLrclib(`https://lrclib.net/api/search?${params}`);
      const list = Array.isArray(res.data) ? res.data : [];
      const evalRes = baselineFindCandidate(list, q, durSec, bTolerance);
      if (evalRes.match) {
        bMatch = evalRes.match;
        bScore = evalRes.score;
        bReason = 'ok';
        break;
      } else if (bReason === 'no queries' || bReason === '0 candidates from LRCLIB') {
        bReason = evalRes.reason;
      }
    }

    // 2. Run Current Updated Algorithm (imported from src/lib/lyrics-match.ts) + Strict Frontend Simulation
    const curQueries = lyricsSearchQueries(t);
    let curMatchOff = null;
    let curMatchOn = null;
    let strictMatch = null;
    for (const q of curQueries) {
      const getParams = new URLSearchParams({
        track_name: q.title,
        artist_name: q.artist,
        duration: String(Math.round(durSec)),
      });
      const getRes = await fetchLrclib(`https://lrclib.net/api/get?${getParams}`);
      let candidates = [];
      if (getRes.data && typeof getRes.data === 'object' && !Array.isArray(getRes.data)) {
        candidates.push(getRes.data);
      }
      const searchParams = new URLSearchParams({ track_name: q.title, artist_name: q.artist });
      const searchRes = await fetchLrclib(`https://lrclib.net/api/search?${searchParams}`);
      if (Array.isArray(searchRes.data)) {
        candidates.push(...searchRes.data);
      }
      if (!curMatchOff) {
        curMatchOff = findLyricsCandidate(candidates, q, durSec, bTolerance, {
          scaleSlowedLyrics: false,
          rawTitle: t.title,
          rawArtist: t.artist,
        });
      }
      if (!curMatchOn) {
        curMatchOn = findLyricsCandidate(candidates, q, durSec, bTolerance, {
          scaleSlowedLyrics: true,
          rawTitle: t.title,
          rawArtist: t.artist,
        });
      }
      if (!strictMatch) {
        strictMatch = strictFrontendFindCandidate(candidates, q, durSec);
      }
      if (curMatchOff && curMatchOn && strictMatch) break;
    }

    // 2b. Simulate Go sidecar path (api/lyrics.go)
    const sidecarRes = await simulateGoSidecarLyrics(t, durSec);

    // 3. Probe LRCLIB with deep-cleaned queries to see if lyrics exist in LRCLIB at all
    const probes = buildDeepCleanProbes(t);
    let bestLrc = null;
    let bestLrcProbe = null;
    for (const p of probes) {
      const getParams = new URLSearchParams({
        track_name: p.title,
        artist_name: p.artist,
        duration: String(Math.round(durSec)),
      });
      const gRes = await fetchLrclib(`https://lrclib.net/api/get?${getParams}`);
      const sParams = new URLSearchParams({ track_name: p.title, artist_name: p.artist });
      const sRes = await fetchLrclib(`https://lrclib.net/api/search?${sParams}`);
      const qRes = await fetchLrclib(`https://lrclib.net/api/search?${new URLSearchParams({ q: `${p.artist} ${p.title}` })}`);

      const pool = [];
      if (gRes.data && typeof gRes.data === 'object' && !Array.isArray(gRes.data)) pool.push(gRes.data);
      if (Array.isArray(sRes.data)) pool.push(...sRes.data);
      if (Array.isArray(qRes.data)) pool.push(...qRes.data);

      for (const cand of pool) {
        if (!cand || (!cand.syncedLyrics && !cand.plainLyrics)) continue;
        const tNormQ = normalizeLyricsText(p.title);
        const tNormC = normalizeLyricsText(cand.trackName || '');
        const aNormQ = normalizeLyricsText(p.artist.split(/,|&/)[0]);
        const aNormC = normalizeLyricsText((cand.artistName || '').split(/,|&/)[0]);
        const titleOk = tNormQ && tNormC && (tNormQ === tNormC || tokenOverlapScore(p.title, cand.trackName || '') >= 0.72);
        const artistOk = aNormQ && aNormC && (aNormQ === aNormC || aNormC.includes(aNormQ) || aNormQ.includes(aNormC));
        if (titleOk && artistOk) {
          const cDur = toSeconds(cand.duration);
          const dSec = durSec > 0 && cDur > 0 ? Math.abs(durSec - cDur) : 999;
          const isSynced = Boolean(cand.syncedLyrics);
          if (
            !bestLrc ||
            (isSynced && !bestLrc.syncedLyrics) ||
            (isSynced === Boolean(bestLrc.syncedLyrics) && dSec < Math.abs(durSec - toSeconds(bestLrc.duration)))
          ) {
            bestLrc = cand;
            bestLrcProbe = p;
          }
        }
      }
      if (bestLrc && bestLrc.syncedLyrics && Math.abs(durSec - toSeconds(bestLrc.duration)) <= 4) break;
    }

    const candDur = bestLrc ? toSeconds(bestLrc.duration) : 0;
    const deltaS = bestLrc && durSec > 0 && candDur > 0 ? durSec - candDur : null;
    const deltaPct = deltaS !== null && candDur > 0 ? (deltaS / candDur) * 100 : null;
    const ratio = bestLrc && durSec > 0 && candDur > 0 ? durSec / candDur : null;

    rows.push({
      idx: i + 1,
      group: t.group,
      id: t.id,
      source: t.source,
      title: t.title,
      artist: t.artist,
      durationSec: Number(durSec.toFixed(1)),
      hasDesc: typeof t.description === 'string' ? (t.description.length > 0 ? 'есть' : 'пусто') : 'не проверено (нет в локальном кэше)',
      baselineFound: Boolean(bMatch),
      baselineType: bMatch ? (bMatch.syncedLyrics ? 'synced' : 'plain') : 'none',
      baselineScore: bMatch ? Number(bScore.toFixed(2)) : 0,
      baselineReason: bMatch ? `OK (${bMatch.artistName} - ${bMatch.trackName})` : bReason,
      currentFound: Boolean(curMatchOff),
      currentType: curMatchOff ? (curMatchOff.syncedLyrics ? 'synced' : 'plain') : 'none',
      currentScaledFound: Boolean(curMatchOn),
      currentScaledType: curMatchOn ? (curMatchOn.syncedLyrics ? 'synced' : 'plain') : 'none',
      sidecarFound: Boolean(sidecarRes),
      sidecarType: sidecarRes ? (sidecarRes.record.syncedLyrics ? 'synced' : 'plain') : 'none',
      sidecarTrack: sidecarRes ? `${sidecarRes.record.artistName} — ${sidecarRes.record.trackName}` : '—',
      sidecarDur: sidecarRes ? Number(toSeconds(sidecarRes.record.duration).toFixed(1)) : null,
      sidecarForceScale: sidecarRes ? sidecarRes.wouldForceScale : false,
      sidecarScaleRatio: sidecarRes ? sidecarRes.scaleRatio : null,
      strictFound: Boolean(strictMatch),
      strictType: strictMatch ? (strictMatch.candidate.syncedLyrics ? 'synced' : 'plain') : 'none',
      strictTrack: strictMatch ? `${strictMatch.candidate.artistName} — ${strictMatch.candidate.trackName}` : '—',
      strictDeltaS: strictMatch ? Number(strictMatch.deltaSec.toFixed(1)) : null,
      strictOffsetWarn: strictMatch ? strictMatch.possibleOffsetWarning : false,
      lrclibExists: Boolean(bestLrc),
      lrclibType: bestLrc ? (bestLrc.syncedLyrics ? 'synced' : 'plain') : 'none',
      lrclibTrack: bestLrc ? `${bestLrc.artistName} — ${bestLrc.trackName}` : '—',
      lrclibDur: candDur ? Number(candDur.toFixed(1)) : null,
      deltaS: deltaS !== null ? Number(deltaS.toFixed(1)) : null,
      deltaPct: deltaPct !== null ? Number(deltaPct.toFixed(1)) : null,
      ratio: ratio !== null ? Number(ratio.toFixed(3)) : null,
      probeUsed: bestLrcProbe ? `${bestLrcProbe.artist} — ${bestLrcProbe.title}` : '—',
    });
    process.stdout.write(`.`);
  }
  console.log('\nDone.');
  const outPath = path.join(os.tmpdir(), 'resonance-overnight-copy', 'audit-results.json');
  fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));
  console.log(`Saved results to ${outPath}`);
}

runAudit().catch((e) => {
  console.error(e);
  process.exit(1);
});
