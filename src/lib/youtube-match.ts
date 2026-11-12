type FallbackTrack = { title: string; artist: string; duration: number };
type YouTubeCandidate = { title: string; artist: string; durationMs: number };

const normalize = (value: string) => value.toLocaleLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function titleTokens(value: string) {
  const core = value
    .replace(/\s*[\[(]\s*(?:feat(?:uring)?|ft)\.?\s*[^)\]]*[)\]]/gi, ' ')
    .replace(/\s*\b(?:feat(?:uring)?|ft)\.?\s+.*$/i, ' ')
    .replace(/\s*[\[(](?:official\b|lyrics?\b|audio\b|music video\b|visuali[sz]er\b|4k\b|hd\b)[^\])]*[\])]/gi, ' ')
    .replace(/\s*[-–—|]\s*(?:official\b|lyrics\b|audio\b|music video\b|visuali[sz]er\b).*$/i, ' ');
  return new Set(normalize(core).split(/\s+/).filter((token) => token.length > 1));
}

function coverage(target: Set<string>, candidate: Set<string>) {
  if (!target.size) return 0;
  let shared = 0;
  for (const token of target) if (candidate.has(token)) shared++;
  return shared / target.size;
}

function featuredArtist(value: string) {
  return value.replace(/\s*[\[(]\s*(?:feat(?:uring)?|ft)\.?\s*[^)\]]*[)\]]/gi, ' ')
    .replace(/\s*\b(?:feat(?:uring)?|ft)\.?\s+.*$/i, ' ').trim();
}

export function youtubeFallbackQueries(track: FallbackTrack) {
  const title = featuredArtist(track.title);
  const artist = featuredArtist(track.artist);
  return [...new Set([`${artist} - ${title}`.trim(), `${title} ${artist}`.trim(), title].filter(Boolean))];
}

export function findYouTubeFallbackCandidate<T extends YouTubeCandidate>(track: FallbackTrack, candidates: T[]): T | null {
  const cleanTitle = normalize(featuredArtist(track.title));
  const cleanArtist = normalize(featuredArtist(track.artist));
  const targetTitle = titleTokens(track.title);
  const targetArtist = new Set(cleanArtist.split(/\s+/).filter((token) => token.length > 1));
  const titleWords = cleanTitle.split(/\s+/).filter(Boolean);
  const isShortOrGenericTitle = titleWords.length <= 1 && cleanTitle.length <= 8;
  const minTitleScore = isShortOrGenericTitle ? 0.9 : 0.75;
  const hasKnownDuration = track.duration > 0;

  return candidates
    .map((candidate, index) => {
      const candTitleClean = normalize(candidate.title);
      const candArtistClean = normalize(candidate.artist);
      const titleScore = coverage(targetTitle, titleTokens(candidate.title));
      const rawArtistScore = coverage(targetArtist, new Set(candArtistClean.split(/\s+/).filter((token) => token.length > 1)));
      const exactArtistMatch =
        cleanArtist.length >= 2 &&
        (candArtistClean.includes(cleanArtist) ||
          cleanArtist.includes(candArtistClean) ||
          candTitleClean.includes(cleanArtist));
      const artistScore = exactArtistMatch ? Math.max(rawArtistScore, 1) : rawArtistScore;
      const artistMatched = artistScore >= 0.65 || exactArtistMatch;

      const candDurSec = candidate.durationMs > 0 ? candidate.durationMs / 1000 : 0;
      const diffSec = hasKnownDuration && candDurSec > 0 ? Math.abs(track.duration - candDurSec) : 999;
      const within10Sec = hasKnownDuration ? (candDurSec > 0 && diffSec <= 10 ? 1 : 0) : 1;
      const durationScore = hasKnownDuration && candDurSec > 0
        ? 1 - Math.min(diffSec / Math.max(track.duration, candDurSec), 1)
        : 0;
      return { candidate, index, titleScore, artistScore, artistMatched, within10Sec, durationScore };
    })
    .filter(({ titleScore, artistMatched, within10Sec }) => titleScore >= minTitleScore && artistMatched && within10Sec === 1)
    .sort((a, b) => b.titleScore - a.titleScore || b.artistScore - a.artistScore || b.durationScore - a.durationScore || a.index - b.index)[0]?.candidate ?? null;
}
