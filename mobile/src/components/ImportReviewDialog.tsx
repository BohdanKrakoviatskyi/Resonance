import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { Button, Chip, IconButton, Loader } from './ui';
import { Cover } from './Cover';
import { SourcePill } from './TrackList';
import { cx, fmtTime, useStore } from '../lib/util';
import { t, type Key } from '../lib/i18n';
import type { ImportReviewReason } from '../lib/import-match';
import {
  applyReviewDecisions,
  cancelPlaylistImport,
  importPreview,
  importStore,
  searchManualReviewCandidates,
  selectReviewItemCandidate,
  setAllReviewItemsAccepted,
  setReviewItemAccepted,
  stopImportPreview,
  toggleImportPreview,
  type ImportReviewItem,
} from '../state/import';
import type { Track } from '../types';

const REASON_KEYS: Record<ImportReviewReason, Key> = {
  auto_matched: 'importReasonLow',
  low_confidence_match: 'importReasonLow',
  ambiguous_match: 'importReasonAmbiguous',
  duration_mismatch: 'importReasonDuration',
  no_catalog_candidates: 'importReasonNone',
  catalog_lookup_failed: 'importReasonFailed',
};

const INITIAL_BATCH = 30;
const BATCH_STEP = 40;

function ReviewCard({ item }: { item: ImportReviewItem }) {
  const preview = useStore(importPreview, (s) => s);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState(`${item.sourceArtist} ${item.sourceTitle}`.trim());
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<Track[] | null>(null);

  const selected = item.selectedTrack;
  const isCurrentPreview = Boolean(selected && preview.trackId === selected.id);
  const isPlayingPreview = isCurrentPreview && preview.playing;
  const isLoadingPreview = isCurrentPreview && preview.loading;

  const runSearch = async () => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    try {
      const results = await searchManualReviewCandidates(q);
      setSearchResults(results);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="import-review-card" data-accepted={item.accepted}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          {item.sourceArtworkUrl && <Cover src={item.sourceArtworkUrl} className="h-9 w-9 rounded-[10px]" />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{item.sourceTitle}</div>
            <div className="truncate text-xs text-on-surface-variant">
              {item.sourceArtist}
              {item.sourceDurationSec > 0 && ` · ${fmtTime(item.sourceDurationSec)}`}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="hero-chip !h-7 !px-2.5 !text-[11px]">
            {t(REASON_KEYS[item.reason])}
            {item.score > 0 ? ` · ${item.score}%` : ''}
          </span>
          <IconButton
            icon="search"
            label={t('importSearchAltBtn')}
            size="sm"
            variant={searchOpen ? 'tonal' : 'standard'}
            onClick={() => setSearchOpen((v) => !v)}
          />
        </div>
      </div>

      {selected ? (
        <div className="mt-2.5 flex items-center gap-2.5 rounded-2xl bg-[color-mix(in_oklab,var(--md-on-surface)_5%,var(--md-surface-container))] p-2">
          <button
            type="button"
            className="import-preview-btn relative shrink-0 overflow-hidden rounded-[12px]"
            data-active={isCurrentPreview}
            aria-label={isPlayingPreview ? t('importPreviewPause') : t('importPreviewPlay')}
            onClick={() => void toggleImportPreview(selected)}
          >
            <Cover src={selected.thumb ?? selected.cover} className="h-10 w-10 rounded-[12px]" />
            <span className="import-preview-play">
              {isLoadingPreview ? (
                <Loader size={18} />
              ) : (
                <Icon name={isPlayingPreview ? 'pause' : 'play_arrow'} fill size={20} />
              )}
            </span>
          </button>

          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{selected.title}</div>
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-on-surface-variant">
              <SourcePill track={selected} />
              <span className="truncate">{selected.artist}</span>
              {selected.duration > 0 && <span className="shrink-0 tabular-nums">· {fmtTime(selected.duration)}</span>}
            </div>
          </div>

          <button
            type="button"
            data-ripple
            aria-pressed={item.accepted}
            onClick={() => setReviewItemAccepted(item.index, !item.accepted)}
            className={cx(
              'sl inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-colors',
              item.accepted
                ? 'bg-primary text-on-primary'
                : 'bg-[color-mix(in_oklab,var(--md-on-surface)_10%,transparent)] text-on-surface-variant',
            )}
          >
            <Icon name={item.accepted ? 'check' : 'close'} size={16} />
            <span>{item.accepted ? t('importApplyBtn', { count: '' }).replace(/\s*\(\)$/, '') : t('importSkippedBadge')}</span>
          </button>
        </div>
      ) : (
        <div className="mt-2.5 flex items-center justify-between gap-2 rounded-2xl bg-[color-mix(in_oklab,var(--md-on-surface)_4%,transparent)] px-3 py-2 text-xs text-on-surface-variant">
          <span>{t('importNoCandidate')}</span>
          <Button variant="tonal" icon="search" className="!h-8 !px-3 !text-xs" onClick={() => setSearchOpen(true)}>
            {t('importSearchAltBtn')}
          </Button>
        </div>
      )}

      {item.candidates.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.candidates.slice(0, 4).map((cand) => (
            <Chip
              key={cand.id}
              label={`${cand.title} · ${fmtTime(cand.duration)}`}
              selected={selected?.id === cand.id}
              className="!h-7 !max-w-[210px] !truncate !px-2.5 !text-[11px]"
              onClick={() => selectReviewItemCandidate(item.index, cand)}
            />
          ))}
        </div>
      )}

      {searchOpen && (
        <div className="mt-2.5 rounded-2xl bg-[color-mix(in_oklab,var(--md-on-surface)_4%,var(--md-surface-container))] p-2.5">
          <div className="flex items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void runSearch();
                }
              }}
              placeholder={t('importSearchPlaceholder')}
              className="h-9 min-w-0 flex-1 rounded-xl bg-sc-highest px-3 text-xs outline-none focus:ring-2 focus:ring-primary"
            />
            <Button
              variant="tonal"
              icon="search"
              disabled={searching}
              className="!h-9 !px-3 !text-xs"
              onClick={() => void runSearch()}
            >
              {t('search')}
            </Button>
          </div>
          {searching ? (
            <div className="flex items-center justify-center py-3">
              <Loader size={22} />
            </div>
          ) : searchResults && searchResults.length === 0 ? (
            <p className="mt-2 text-xs text-on-surface-variant">{t('importSearchEmpty')}</p>
          ) : searchResults ? (
            <div className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto">
              {searchResults.slice(0, 8).map((cand) => (
                <button
                  key={cand.id}
                  type="button"
                  data-ripple
                  onClick={() => {
                    selectReviewItemCandidate(item.index, cand);
                    setSearchOpen(false);
                  }}
                  className="sl flex items-center gap-2 rounded-xl px-2 py-1.5 text-left text-xs hover:bg-[color-mix(in_oklab,var(--md-on-surface)_8%,transparent)]"
                >
                  <Cover src={cand.thumb ?? cand.cover} className="h-8 w-8 rounded-lg" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{cand.title}</span>
                    <span className="flex items-center gap-1 text-[11px] text-on-surface-variant">
                      <SourcePill track={cand} />
                      <span className="truncate">{cand.artist}</span>
                    </span>
                  </span>
                  {cand.duration > 0 && <span className="shrink-0 tabular-nums text-on-surface-variant">{fmtTime(cand.duration)}</span>}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function ImportReviewDialog({ onClose }: { onClose: () => void }) {
  const job = useStore(importStore, (s) => s);
  const items = job.reviewItems;
  const [visibleCount, setVisibleCount] = useState(() => Math.min(items.length, INITIAL_BATCH));

  useEffect(() => () => stopImportPreview(), []);

  useEffect(() => {
    setVisibleCount((c) => Math.max(Math.min(items.length, INITIAL_BATCH), Math.min(c, items.length)));
  }, [items.length]);

  useEffect(() => {
    if (visibleCount >= items.length) return;
    const raf = requestAnimationFrame(() => {
      setVisibleCount((c) => Math.min(items.length, c + BATCH_STEP));
    });
    return () => cancelAnimationFrame(raf);
  }, [visibleCount, items.length]);

  const approvedReviewCount = items.filter((it) => it.accepted && it.selectedTrack).length;
  const totalAddCount = job.matchedCount + approvedReviewCount;
  const slice = visibleCount < items.length ? items.slice(0, visibleCount) : items;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="headline text-2xl">{t('importReviewTitle')}</h2>
          <p className="mt-1 text-sm text-on-surface-variant">
            {job.playlistName} · {t('importReviewSummary', { matched: job.matchedCount, total: job.total, pending: items.length })}
          </p>
        </div>
        {items.length > 0 && (
          <div className="flex items-center gap-1">
            <Button variant="text" className="!h-8 !px-2.5 !text-xs" onClick={() => setAllReviewItemsAccepted(true)}>
              {t('importSelectAll')}
            </Button>
            <Button variant="text" className="!h-8 !px-2.5 !text-xs" onClick={() => setAllReviewItemsAccepted(false)}>
              {t('importDeselectAll')}
            </Button>
          </div>
        )}
      </div>

      <div className="import-review-list">
        {slice.map((item) => (
          <ReviewCard key={item.index} item={item} />
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[color-mix(in_oklab,var(--md-outline-variant)_45%,transparent)] pt-4">
        <div className="flex items-center gap-2">
          <Button variant="text" onClick={cancelPlaylistImport}>
            {t('cancel')}
          </Button>
          <Button variant="outlined" onClick={() => applyReviewDecisions(true)}>
            {t('importSkipAll')}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="text" onClick={onClose}>
            {t('closeBtn')}
          </Button>
          <Button
            icon="playlist_add_check"
            disabled={totalAddCount === 0 && !job.pendingTrackId}
            onClick={() => applyReviewDecisions(false)}
          >
            {t('importApplyBtn', { count: totalAddCount })}
          </Button>
        </div>
      </div>
    </div>
  );
}
