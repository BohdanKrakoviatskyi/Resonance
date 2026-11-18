import type { Track } from '../types';
import {
  coverage,
  featuredArtist,
  normalize,
  titleTokens,
  VARIANT,
  youtubeFallbackQueries,
} from './youtube-match.ts';

export type ImportReviewReason =
  | 'auto_matched'
  | 'low_confidence_match'
  | 'ambiguous_match'
  | 'duration_mismatch'
  | 'no_catalog_candidates'
  | 'catalog_lookup_failed';

export type SourceTrackInput = {
  title: string;
  artist: string;
  album?: string;
  durationMs: number;
  artworkUrl?: string;
};

export interface ScoredCandidate {
  track: Track;
  score: number;
  titleScore: number;
  artistScore: number;
  durationScore: number;
  durationDiffSec: number;
  hasExtraVariant: boolean;
}

export interface MatchTrackOutcome {
  reason: ImportReviewReason;
  score: number;
  best: Track | null;
  candidates: Track[];
}

export function scoreImportCandidate(source: SourceTrackInput, candidate: Track): ScoredCandidate {
  const sourceDurSec = Math.max(0, source.durationMs / 1000);
  const candDurSec = Math.max(0, candidate.duration || 0);
  const hasDuration = sourceDurSec > 0 && candDurSec > 0;
  const durationDiffSec = hasDuration ? Math.abs(sourceDurSec - candDurSec) : 0;
  const maxDiffSec = Math.max(12, sourceDurSec * 0.12);
  let durationScore = 0.65;
  if (hasDuration) {
    durationScore = durationDiffSec <= maxDiffSec ? 1 - durationDiffSec / maxDiffSec : Math.max(0, 0.35 - (durationDiffSec - maxDiffSec) / 120);
  }

  const targetTitle = titleTokens(source.title);
  const candTitleTokens = titleTokens(candidate.title);
  const fwdTitle = coverage(targetTitle, candTitleTokens);
  const revTitle = coverage(candTitleTokens, targetTitle);
  const titleScore = fwdTitle * 0.72 + revTitle * 0.28;

  const cleanSourceArtist = normalize(featuredArtist(source.artist));
  const cleanCandArtist = normalize(featuredArtist(candidate.artist)).replace(/(?:\s+topic|\s*vevo)$/, '');
  const candTitleNorm = normalize(candidate.title);
  const sourceArtistTokens = new Set(cleanSourceArtist.split(' ').filter(Boolean));
  const candArtistTokens = new Set(cleanCandArtist.split(' ').filter(Boolean));

  const exactArtist =
    cleanSourceArtist.length >= 2 &&
    ((cleanCandArtist.replace(/\s+/g, '') === cleanSourceArtist.replace(/\s+/g, '') && cleanCandArtist.length >= 2) ||
      (cleanCandArtist.length >= 2 &&
        (` ${cleanCandArtist} `.includes(` ${cleanSourceArtist} `) || ` ${cleanSourceArtist} `.includes(` ${cleanCandArtist} `))) ||
      ` ${candTitleNorm} `.includes(` ${cleanSourceArtist} `));

  const rawArtist = coverage(sourceArtistTokens, candArtistTokens);
  const artistScore = exactArtist ? 1 : rawArtist;

  const requestedVariants = new Set(normalize(source.title).match(VARIANT) ?? []);
  const candVariants = normalize(candidate.title).match(VARIANT) ?? [];
  const hasExtraVariant = candVariants.some((v) => !requestedVariants.has(v));

  let rawScore = (titleScore * 0.48 + artistScore * 0.37 + durationScore * 0.15) * 100;
  if (hasExtraVariant) rawScore -= 26;
  if (titleScore < 0.4) rawScore *= 0.6;
  if (artistScore < 0.25 && titleScore < 0.9) rawScore *= 0.65;

  const score = Math.max(0, Math.min(100, Math.round(rawScore)));
  return {
    track: candidate,
    score,
    titleScore,
    artistScore,
    durationScore,
    durationDiffSec,
    hasExtraVariant,
  };
}

export function classifyMatchCandidates(source: SourceTrackInput, rawCandidates: Track[], lookupFailed: boolean): MatchTrackOutcome {
  const seen = new Set<string>();
  const unique: Track[] = [];
  for (const c of rawCandidates) {
    if (!c?.id || seen.has(c.id)) continue;
    seen.add(c.id);
    unique.push(c);
  }

  if (unique.length === 0) {
    return {
      reason: lookupFailed ? 'catalog_lookup_failed' : 'no_catalog_candidates',
      score: 0,
      best: null,
      candidates: [],
    };
  }

  const scored = unique
    .map((c) => scoreImportCandidate(source, c))
    .sort((a, b) => b.score - a.score || b.titleScore - a.titleScore || b.artistScore - a.artistScore);

  const top = scored[0];
  const second = scored[1];
  const candidates = scored.slice(0, 6).map((s) => s.track);

  if (top.score < 32) {
    return {
      reason: 'no_catalog_candidates',
      score: top.score,
      best: top.track,
      candidates,
    };
  }

  const sourceDurSec = source.durationMs / 1000;
  const maxAllowedDiff = Math.max(18, sourceDurSec * 0.16);
  const durationMismatch = sourceDurSec > 0 && top.track.duration > 0 && top.durationDiffSec > maxAllowedDiff;

  if (durationMismatch && top.titleScore >= 0.72 && top.artistScore >= 0.6) {
    return {
      reason: 'duration_mismatch',
      score: top.score,
      best: top.track,
      candidates,
    };
  }

  if (second && top.score - second.score <= 5 && top.score < 88 && top.score >= 55) {
    return {
      reason: 'ambiguous_match',
      score: top.score,
      best: top.track,
      candidates,
    };
  }

  if (top.score >= 76 && !top.hasExtraVariant && !durationMismatch && top.titleScore >= 0.68 && top.artistScore >= 0.5) {
    return {
      reason: 'auto_matched',
      score: top.score,
      best: top.track,
      candidates,
    };
  }

  return {
    reason: 'low_confidence_match',
    score: top.score,
    best: top.track,
    candidates,
  };
}

export async function matchExternalTrack(
  source: SourceTrackInput,
  options: {
    searchYouTube: (query: string, signal?: AbortSignal) => Promise<Track[]>;
    searchSoundCloud?: (query: string, signal?: AbortSignal) => Promise<Track[]>;
    signal?: AbortSignal;
  },
): Promise<MatchTrackOutcome> {
  const seed = {
    title: source.title,
    artist: source.artist,
    duration: source.durationMs > 0 ? source.durationMs / 1000 : 0,
  };
  const queries = youtubeFallbackQueries(seed);
  if (queries.length === 0) {
    return { reason: 'no_catalog_candidates', score: 0, best: null, candidates: [] };
  }

  const collected: Track[] = [];
  let anySucceeded = false;

  const runRound = async (query: string) => {
    const tasks: Promise<Track[]>[] = [options.searchYouTube(query, options.signal)];
    if (options.searchSoundCloud) {
      tasks.push(options.searchSoundCloud(query, options.signal));
    }
    const settled = await Promise.allSettled(tasks);
    for (const res of settled) {
      if (res.status === 'fulfilled') {
        anySucceeded = true;
        collected.push(...res.value);
      } else if (options.signal?.aborted) {
        throw res.reason;
      }
    }
  };

  await runRound(queries[0]);
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const firstPass = classifyMatchCandidates(source, collected, !anySucceeded);
  if (firstPass.reason === 'auto_matched' || queries.length === 1) {
    return firstPass;
  }

  await runRound(queries[1]);
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  return classifyMatchCandidates(source, collected, !anySucceeded);
}
