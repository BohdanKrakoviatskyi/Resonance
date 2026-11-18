type RecommendationTrack = {
  id: string;
  title: string;
  artist: string;
  duration?: number;
};

const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = (value: string) => new Set(normalize(value).split(/\s+/).filter((word) => word.length > 1));

function similarity(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / Math.max(a.size, b.size);
}

export function rankRecommendations<T extends RecommendationTrack>(
  seeds: RecommendationTrack | RecommendationTrack[],
  candidates: T[],
  queued: ReadonlySet<string> = new Set(),
  disliked: ReadonlySet<string> = new Set(),
  known: ReadonlySet<string> = new Set(),
): T[] {
  const seedList = Array.isArray(seeds) ? seeds : [seeds];
  const scores = new Map<string, number>();
  const seedIds = new Set(seedList.map((seed) => seed.id));
  const seedTitles = new Set(seedList.map((seed) => normalize(seed.title)));
  for (const seed of seedList) {
    const seedTitle = normalize(seed.title);
    const seedArtist = words(seed.artist);
    const seedTitleWords = words(seed.title);
    for (const candidate of candidates) {
      if (candidate.id === seed.id || normalize(candidate.title) === seedTitle) continue;
      const artistScore = similarity(seedArtist, words(candidate.artist));
      const titleScore = similarity(seedTitleWords, words(candidate.title));
      const durationScore = seed.duration && candidate.duration
        ? 1 - Math.min(Math.abs(seed.duration - candidate.duration) / Math.max(seed.duration, candidate.duration), 1)
        : 0;
      const score = artistScore * 0.5 + titleScore * 0.35 + durationScore * 0.15;
      scores.set(candidate.id, Math.max(scores.get(candidate.id) ?? 0, score));
    }
  }
  return candidates
    .filter((candidate) => !seedIds.has(candidate.id) && !seedTitles.has(normalize(candidate.title)) && !queued.has(candidate.id) && !disliked.has(candidate.id) && !known.has(candidate.id))
    .map((candidate, index) => ({ candidate, index, score: scores.get(candidate.id) ?? 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ candidate }) => candidate);
}
