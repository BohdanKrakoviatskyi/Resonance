type FallbackTrack = { title: string; artist: string; duration: number };
type YouTubeCandidate = { title: string; artist: string; durationMs: number };

const normalize = (value: string) => value.toLocaleLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const NOISE_BRACKET = /\s*[\[(]\s*(?:official(?: music)? video|official(?: audio| lyric video)?|lyrics?|audio|music video|mv|m\/v|visuali[sz]er|4k|hd|hq|explicit(?: version)?|clean(?: version)?|remaster(?:ed)?(?: \d{4})?|clip|prod\.?[^\])]*)\s*[\])]/gi;
const NOISE_DASH = /\s*[-–—|]\s*(?:official(?: music)? video|official(?: audio)?|lyrics?|audio|music video|mv|visuali[sz]er|explicit|clean|remaster(?:ed)?|hq|hd|4k|clip)\b.*$/i;
const VARIANT = /\b(?:live|acoustic|sped up|speed up|nightcore|slowed|reverb|remix|cover|karaoke|instrumental|8d)\b/g;

function titleTokens(value: string) {
  const core = value
    .replace(/\s*[\[(]\s*(?:feat(?:uring)?|ft)\.?\s*[^)\]]*[)\]]/gi, ' ')
    .replace(/\s*\b(?:feat(?:uring)?|ft)\.?\s+.*$/i, ' ')
    .replace(NOISE_BRACKET, ' ')
    .replace(NOISE_DASH, ' ');
  return new Set(normalize(core).split(' ').filter(Boolean));
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
  const artist = featuredArtist(track.artist);
  let title = featuredArtist(track.title);
  const prefix = `${artist} - `;
  if (artist && title.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) title = title.slice(prefix.length).trim();
  const queries = [artist && title ? `${artist} - ${title}` : '', artist && title ? `${title} ${artist}` : '', title];
  const genericTitle = normalize(title).split(' ').filter(Boolean).length <= 1 && normalize(title).length <= 3;
  return [...new Set(queries.filter(Boolean).filter((_q, i) => !(i === 2 && genericTitle && artist)))];
}

export function findYouTubeFallbackCandidate<T extends YouTubeCandidate>(track: FallbackTrack, candidates: T[]): T | null {
  const hasKnownDuration = track.duration > 0;
  const maxDiffSec = Math.max(10, track.duration * 0.1);
  const cleanTitle = normalize(featuredArtist(track.title));
  const cleanArtist = normalize(featuredArtist(track.artist));
  const hasArtist = cleanArtist.length >= 2;
  const targetTitle = titleTokens(track.title);
  const targetArtist = new Set(cleanArtist.split(' ').filter(Boolean));
  const requested = new Set(normalize(track.title).match(VARIANT) ?? []);
  const titleWords = cleanTitle.split(' ').filter(Boolean);
  const isShortOrGenericTitle = titleWords.length <= 1 && cleanTitle.length <= 8;
  const isDistinctiveTitle = !isShortOrGenericTitle;
  const minTitleScore = isShortOrGenericTitle ? 0.9 : 0.75;

  let best: { candidate: T; titleScore: number; artistScore: number; durationScore: number } | null = null;
  for (const candidate of candidates) {
    const candDurSec = candidate.durationMs / 1000;
    let durationScore = 0.5;
    if (hasKnownDuration && candDurSec > 0) {
      const diffSec = Math.abs(track.duration - candDurSec);
      if (diffSec > maxDiffSec) continue;
      durationScore = 1 - diffSec / maxDiffSec;
    }

    const candTitle = normalize(candidate.title);
    if (candTitle.match(VARIANT)?.some((word) => !requested.has(word))) continue;

    const titleScore = coverage(targetTitle, titleTokens(candidate.title));
    if (titleScore < minTitleScore) continue;

    const candArtist = normalize(candidate.artist).replace(/(?:\s+topic|\s*vevo)$/, '');
    const candCompact = candArtist.replace(/\s+/g, '');
    const cleanCompact = cleanArtist.replace(/\s+/g, '');
    const exactArtistMatch = hasArtist && (
      (candCompact.length >= 2 && candCompact === cleanCompact) ||
      (candArtist.length >= 2 && (` ${candArtist} `.includes(` ${cleanArtist} `) || ` ${cleanArtist} `.includes(` ${candArtist} `))) ||
      ` ${candTitle} `.includes(` ${cleanArtist} `)
    );
    const rawArtistScore = coverage(targetArtist, new Set(candArtist.split(' ').filter(Boolean)));
    const artistScore = exactArtistMatch ? 1 : rawArtistScore;
    const titleOnlyRecovery = titleScore === 1 && isDistinctiveTitle && durationScore >= 0.8 && candArtist.length >= 2;
    if (!(artistScore >= 0.65 || titleOnlyRecovery)) continue;

    if (!best || titleScore > best.titleScore || (titleScore === best.titleScore && (artistScore > best.artistScore ||
      (artistScore === best.artistScore && durationScore > best.durationScore)))) {
      best = { candidate, titleScore, artistScore, durationScore };
    }
  }
  return best?.candidate ?? null;
}
