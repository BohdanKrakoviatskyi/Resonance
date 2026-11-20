/**
 * Pure shuffle-cycle planning extracted from state/player.ts so the risky paths
 * (full-playlist permutation, cycle boundaries, artist spread, freshest-first)
 * can be unit tested without a DOM or Tauri runtime.
 *
 * The contract is one exhausted pass per cycle: `buildCycle` returns every id of
 * the pool exactly once, and consecutive cycles are different permutations whose
 * head avoids the tracks played right before the boundary.
 */

export type RngState = { a: number; b: number; c: number; d: number };

/** FNV-1a over the seed string, expanded into four sfc32 words. */
export function seedState(seed: string | number): RngState {
  let h = 2166136261 >>> 0;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const words: number[] = [];
  for (let i = 0; i < 4; i++) {
    h = (h + 0x9e3779b9) | 0;
    let z = h;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z ^= z >>> 15;
    words.push(z >>> 0);
  }
  return { a: words[0], b: words[1], c: words[2], d: words[3] };
}

/** sfc32: 128-bit state, fast and statistically solid for queue ordering. */
export function sfc32(state: RngState): () => number {
  let { a, b, c, d } = state;
  return function next(): number {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * Weighted sampling without replacement (Efraimidis–Spirakis / Plackett–Luce).
 * Keys are exponential race times -ln(u)/w, so smaller means earlier; equal
 * weights yield an exactly uniform random permutation.
 */
export function weightedPermutation(ids: string[], weightOf: (id: string) => number, rnd: () => number): string[] {
  const keyed = ids.map((id) => {
    const w = Math.max(weightOf(id), 1e-9);
    const u = 1 - rnd();
    return { id, t: -Math.log(u) / w };
  });
  keyed.sort((x, y) => x.t - y.t);
  return keyed.map((entry) => entry.id);
}

/**
 * De-clusters a permutation by giving every group (artist) evenly spaced slots
 * across the whole cycle, with jitter so it never settles into a visible pattern.
 * With a single group the incoming order is preserved.
 */
export function spreadGroups(ordered: string[], groupOf: (id: string) => string, rnd: () => number): string[] {
  const n = ordered.length;
  if (n < 3) return ordered.slice();
  const groups = new Map<string, string[]>();
  for (const id of ordered) {
    const key = groupOf(id);
    const bucket = groups.get(key);
    if (bucket) bucket.push(id);
    else groups.set(key, [id]);
  }
  if (groups.size < 2) return ordered.slice();
  const slots: { pos: number; tie: number; id: string }[] = [];
  for (const items of groups.values()) {
    const step = n / items.length;
    for (let k = 0; k < items.length; k++) {
      slots.push({ pos: (k + 0.5 + (rnd() - 0.5)) * step, tie: rnd(), id: items[k] });
    }
  }
  slots.sort((x, y) => x.pos - y.pos || x.tie - y.tie);
  return slots.map((slot) => slot.id);
}

/**
 * Keeps the first track of a fresh cycle away from the tracks played just before
 * the boundary: the most common real-world "shuffle repeats itself" complaint.
 */
export function avoidRecentHead(order: string[], recent: string[]): string[] {
  const n = order.length;
  if (n < 2 || !recent.length) return order.slice();
  const result = order.slice();
  if (!recent.includes(result[0])) return result;
  for (let j = n - 1; j > 0; j--) {
    if (!recent.includes(result[j])) {
      [result[0], result[j]] = [result[j], result[0]];
      return result;
    }
  }
  const lastPlayed = recent[recent.length - 1];
  for (let j = 1; j < n; j++) {
    if (result[j] !== lastPlayed) {
      [result[0], result[j]] = [result[j], result[0]];
      return result;
    }
  }
  return result;
}

/** How strongly a candidate cycle front-loads tracks the user heard recently. */
function recencyScore(order: string[], recentOf: (id: string) => number): number {
  let score = 0;
  for (let i = 0; i < order.length; i++) score += recentOf(order[i]) / (i + 1);
  return score;
}

/**
 * Builds one full-cycle permutation of `pool`: weighted bag order, artist spread,
 * boundary guard, then the freshest of several candidates wins.
 */
export function buildCycle(opts: {
  pool: string[];
  seed: number;
  cycle: number;
  recent: string[];
  groupOf: (id: string) => string;
  weightOf?: (id: string) => number;
  candidates?: number;
}): string[] {
  const { pool, seed, cycle, recent, groupOf } = opts;
  const weightOf = opts.weightOf ?? (() => 1);
  const candidates = Math.max(1, opts.candidates ?? 5);
  if (pool.length < 2) return pool.slice();

  const rnd = sfc32(seedState(`${seed}:${cycle}`));
  const recentOf = (id: string) => {
    const rank = recent.lastIndexOf(id);
    return rank < 0 ? 0 : (rank + 1) / recent.length;
  };

  let best: string[] = [];
  let bestScore = Infinity;
  for (let k = 0; k < candidates; k++) {
    const shuffled = weightedPermutation(pool, weightOf, rnd);
    const spread = spreadGroups(shuffled, groupOf, rnd);
    const guarded = avoidRecentHead(spread, recent);
    const score = recencyScore(guarded, recentOf);
    if (score < bestScore) {
      bestScore = score;
      best = guarded;
    }
  }
  return best;
}

const BRACKETED = /[([][^)\]]*[)\]]/g;
/**
 * Bracket contents that describe a release, not the recording itself. Anything
 * else inside brackets keeps its meaning: "(Part 1)" and "(Live)" are different
 * recordings and must not collapse into one identity.
 */
const RELEASE_NOISE = /\b(?:remaster(?:ed)?|deluxe|official(?:\s+(?:video|audio|music\s+video))?|lyrics?(?:\s+video)?|hd|hq|explicit|mono|stereo|bonus\s+track|digital\s+remaster(?:ed)?|anniversary(?:\s+edition)?)\b/i;
const FEAT_SUFFIX = /\s(?:feat\.?|ft\.?|with)\s.*$/i;
const ARTIST_SPLIT = /\s*(?:,|&|;|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bx\b|\bvs\.?\b)\s*/;

function normalizeIdentityPart(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(BRACKETED, (segment) => (RELEASE_NOISE.test(segment) ? ' ' : ` ${segment.slice(1, -1)} `))
    .replace(FEAT_SUFFIX, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Identity of a recording, independent of which provider surfaced it: the same
 * song from YouTube Music, SoundCloud and a local file must collapse to one key,
 * otherwise "no repeats" is checked against ids that never match.
 */
export function trackIdentity(track: { title: string; artist: string; duration?: number }): string {
  const title = normalizeIdentityPart(track.title);
  const artist = normalizeIdentityPart(track.artist).split(' ').slice(0, 3).join(' ');
  // Twenty-second buckets: providers disagree by a second or two on the same
  // recording, while different edits of a song drift further apart than that.
  const duration = track.duration && track.duration > 0 ? Math.floor(track.duration / 20) : 0;
  return `${title}|${artist}|${duration}`;
}

/** Drops repeated recordings from a pool, keeping the first occurrence. */
export function dedupePool(ids: string[], keyOf: (id: string) => string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const key = keyOf(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/** Primary artist for spread purposes: "A feat. B" and "A & B" both group under A. */
export function primaryArtist(artist: string): string {
  return normalizeIdentityPart(artist.split(ARTIST_SPLIT)[0] ?? '');
}
