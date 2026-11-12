import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LYRICS_NEGATIVE_CACHE_TTL_MS,
  findLyricsCandidate,
  lyricsSearchQueries,
  matchesGeniusCandidate,
  resolvePersistentLyricsCacheEntry,
  toSeconds,
  writePersistentLyricsCacheEntry,
} from './lyrics-match.ts';

test('uses the song title and artist from an official video title', () => {
  const queries = lyricsSearchQueries({
    title: 'Ravyn Lenae - Love Me Not (Official Music Video)',
    artist: 'Ravyn Lenae',
    source: 'youtube',
  });

  assert.deepEqual(queries[0], { title: 'Love Me Not', artist: 'Ravyn Lenae' });
});

test('uses artist credit from a lyric upload or SoundCloud reupload instead of its channel name', () => {
  const queries = lyricsSearchQueries({
    title: 'kyNZai – не убивая тебя (prod. someone) #rap',
    artist: 'eclipse media',
    source: 'soundcloud',
  });

  assert.deepEqual(queries[0], { title: 'не убивая тебя', artist: 'kyNZai' });
});

test('normalizes duration in ms, seconds, and m:ss strings to seconds', () => {
  assert.equal(toSeconds(113000), 113);
  assert.equal(toSeconds(113), 113);
  assert.equal(toSeconds('1:53'), 113);
});

test('matches YouTube lyrics when the music video differs in duration slightly', () => {
  const candidate = findLyricsCandidate([{
    trackName: 'Love Me Not', artistName: 'Ravyn Lenae', duration: 215, syncedLyrics: '[00:00.00] lyric',
  }], { title: 'Love Me Not', artist: 'Ravyn Lenae' }, 219, 30);

  assert.equal(candidate?.trackName, 'Love Me Not');
});

test('rejects short 1-word title with mismatched artist even when duration is identical', () => {
  const candidate = findLyricsCandidate([
    {
      trackName: 'Стратосферный самолёт',
      artistName: 'Детский хор',
      duration: 113,
      syncedLyrics: '[00:00.00] wrong song',
    },
    {
      trackName: 'самолёт',
      artistName: 'Чужой Автор',
      duration: 113,
      syncedLyrics: '[00:00.00] also wrong song',
    },
  ], { title: 'самолёт', artist: 'zer0cks' }, 113, 4);

  assert.equal(candidate, null);
});

test('requires strict artist and title match for Genius candidates without duration', () => {
  assert.equal(
    matchesGeniusCandidate({ title: 'самолёт', artist: 'zer0cks' }, { title: 'Стратосферный самолёт', artist: 'Другой' }),
    false,
  );
  assert.equal(
    matchesGeniusCandidate({ title: 'самолёт', artist: 'zer0cks' }, { title: 'самолёт', artist: 'zer0cks' }),
    true,
  );
});

test('normalizes queries across 18 real owner tracks from YouTube Music and SoundCloud', () => {
  const cases = [
    {
      track: { title: 'POISON. (feat. Pranav.Wav)', artist: 'Kill Dyll', source: 'youtube' },
      expectPair: { title: 'POISON.', artist: 'Kill Dyll' },
    },
    {
      track: { title: 'I Got Love (feat. Рем Дигга)', artist: 'Miyagi & Andy Panda - Topic', source: 'youtube' },
      expectPair: { title: 'I Got Love', artist: 'Miyagi' },
    },
    {
      track: { title: 'Smells Like Teen Spirit', artist: 'Nirvana - Topic', source: 'youtube' },
      expectPair: { title: 'Smells Like Teen Spirit', artist: 'Nirvana' },
    },
    {
      track: { title: 'Горький вкус', artist: ' Султан Лагучев - Topic', source: 'youtube' },
      expectPair: { title: 'Горький вкус', artist: 'Султан Лагучев' },
    },
    {
      track: { title: 'Let Me Love You', artist: 'DJ Snake - Topic', source: 'youtube' },
      expectPair: { title: 'Let Me Love You', artist: 'DJ Snake' },
    },
    {
      track: { title: 'Summer', artist: 'Calvin Harris - Topic', source: 'youtube' },
      expectPair: { title: 'Summer', artist: 'Calvin Harris' },
    },
    {
      track: { title: 'Sharir', artist: 'Heyson', source: 'youtube' },
      expectPair: { title: 'Sharir', artist: 'Heyson' },
    },
    {
      track: { title: 'JOHAN X Goddamn - Slowmotion', artist: 'JOHAN X Goddamn', source: 'youtube' },
      expectPair: { title: 'Slowmotion', artist: 'JOHAN' },
    },
    {
      track: { title: 'монстр', artist: 'норман грейсон', source: 'soundcloud' },
      expectPair: { title: 'монстр', artist: 'норман грейсон' },
    },
    {
      track: { title: 'BATO - Miura', artist: 'Русская Рэп-Сцена', source: 'soundcloud' },
      expectPair: { title: 'Miura', artist: 'BATO' },
    },
    {
      track: { title: 'trytofriend (prod. cloudly006)', artist: 'FORTUNA 812', source: 'soundcloud' },
      expectPair: { title: 'trytofriend', artist: 'FORTUNA 812' },
    },
    {
      track: { title: 'princeofscale — FORTUNA 812', artist: 'just_sad_maan', source: 'soundcloud' },
      expectPair: { title: 'princeofscale', artist: 'FORTUNA 812' },
    },
    {
      track: { title: 'Three Days Grace - Pain', artist: 'DollZ', source: 'soundcloud' },
      expectPair: { title: 'Pain', artist: 'Three Days Grace' },
    },
    {
      track: { title: 'tame impala-loser (slowed)', artist: 'sebtss', source: 'soundcloud' },
      expectPair: { title: 'loser', artist: 'tame impala' },
    },
    {
      track: { title: 'Go With The Flow by Queens of the Stone Age (Slowed)', artist: 'Gula', source: 'soundcloud' },
      expectPair: { title: 'Go With The Flow', artist: 'Queens of the Stone Age' },
    },
    {
      track: { title: 'SPINE (slowed + reverb)', artist: 'WesGhost', source: 'soundcloud' },
      expectPair: { title: 'SPINE', artist: 'WesGhost' },
    },
    {
      track: { title: 'UH OH! - Sub Urban - (sped up/pitched)', artist: 'shirospiral | MaxDrawsVA', source: 'soundcloud' },
      expectPair: { title: 'UH OH!', artist: 'Sub Urban' },
    },
    {
      track: { title: 'fashion (walking like a rockstar) - britney manson (tiktok version) (slowed)', artist: 'v e n u s', source: 'soundcloud' },
      expectPair: { title: 'fashion', artist: 'britney manson' },
    },
  ];

  for (const { track, expectPair } of cases) {
    const queries = lyricsSearchQueries(track);
    assert.ok(
      queries.some(
        (q) =>
          q.title.toLowerCase() === expectPair.title.toLowerCase() &&
          q.artist.toLowerCase() === expectPair.artist.toLowerCase(),
      ),
      `Expected query ${JSON.stringify(expectPair)} in ${JSON.stringify(queries)} for track ${track.title}`,
    );
  }
});

test('extends duration tolerance up to ±10s when both artist and title match with high confidence', () => {
  const candidates = [
    {
      trackName: 'Монополия',
      artistName: 'Монеточка',
      duration: 218.0,
      syncedLyrics: '[00:10.00] synced version',
      plainLyrics: 'synced version',
    },
    {
      trackName: 'Монополия',
      artistName: 'Монеточка',
      duration: 214.0,
      plainLyrics: 'plain version only',
    },
  ];
  // Track duration on SoundCloud is 213.4s (delta = 4.6s > 4s base tolerance, but within ±10s for high-confidence match)
  const best = findLyricsCandidate(candidates, { title: 'Монополия', artist: 'Монеточка' }, 213.4, 4);
  assert.ok(best);
  assert.equal(best.syncedLyrics, '[00:10.00] synced version');

  // Rejects candidate when delta > 10s even if artist and title match (e.g. 10-minute loop vs 4-minute original)
  const tooFar = findLyricsCandidate(
    [{ trackName: 'Pain', artistName: 'Three Days Grace', duration: 251.7, syncedLyrics: '[00:05.00] pain' }],
    { title: 'Pain', artist: 'Three Days Grace' },
    604.7,
    4,
  );
  assert.equal(tooFar, null);
});

test('caches negative not_found results for 7 days, ignores network errors, and respects manual override', () => {
  const t0 = 1_700_000_000_000;
  let cache = {};

  // 1. Network / 5xx / timeout errors MUST NOT be written to persistent cache
  cache = writePersistentLyricsCacheEntry(cache, 'sc:2244975557', { status: 'network_error' }, t0);
  assert.deepEqual(resolvePersistentLyricsCacheEntry(cache, 'sc:2244975557', t0), { hit: false, data: null });

  // 2. Confirmed 404 / empty results ARE cached as null for 7 days
  cache = writePersistentLyricsCacheEntry(cache, 'sc:2244975557', { status: 'not_found' }, t0);
  assert.deepEqual(resolvePersistentLyricsCacheEntry(cache, 'sc:2244975557', t0 + 1000), { hit: true, data: null });

  // 3. Manual override / forceRefresh bypasses negative cache immediately
  assert.deepEqual(resolvePersistentLyricsCacheEntry(cache, 'sc:2244975557', t0 + 1000, true), { hit: false, data: null });

  // 4. After 7 days TTL expires, negative cache entry is no longer a hit
  assert.deepEqual(
    resolvePersistentLyricsCacheEntry(cache, 'sc:2244975557', t0 + LYRICS_NEGATIVE_CACHE_TTL_MS + 1),
    { hit: false, data: null },
  );
});
