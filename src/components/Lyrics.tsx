import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { IconButton, Loader, Shape, usePresence, type Vars } from './ui';
import { clamp, cx, fmtTime, useStore } from '../lib/util';
import { t } from '../lib/i18n';
import {
  getLyrics,
  hasManualLyricsChoice,
  searchLyricsManual,
  setManualLyricsChoice,
  type LyricsData,
  type ManualLyricsChoice,
} from '../lib/api';
import {
  LYRICS_OFFSET_MAX_SEC,
  LYRICS_OFFSET_MIN_SEC,
  LYRICS_OFFSET_STEP_SEC,
  clampLyricsOffset,
  findSyncedLyricLineIndex,
  getSeekTimeForLyricLine,
  resolveEffectiveLyricsOffset,
  stripTrackNoise,
  toSeconds,
} from '../lib/lyrics-match';
import {
  computeLyricsOffsetPopoverPlacement,
  type LyricsOffsetPopoverPlacement,
} from '../lib/lyrics-offset-popover';
import { onFrame, player, seek, toggle, useSecond } from '../state/player';
import {
  clearLiveTrackLyricsOffset,
  getEffectiveTrackLyricsOffset,
  setLiveTrackLyricsOffset,
  setTrackLyricsOffset,
  ui,
} from '../state/ui';
import type { LyricLine, Track } from '../types';

type LState =
  | { status: 'loading' }
  | { status: 'none'; instrumental?: boolean; data?: LyricsData | null }
  | { status: 'synced'; lines: LyricLine[]; data: LyricsData }
  | { status: 'plain'; lines: string[]; preview?: boolean; data: LyricsData };

function toLState(d: LyricsData | null): LState {
  if (!d) return { status: 'none' };
  if (d.synced?.length) return { status: 'synced', lines: d.synced, data: d };
  if (d.plain?.length) return { status: 'plain', lines: d.plain, preview: d.preview, data: d };
  return { status: 'none', instrumental: d.instrumental, data: d };
}

function useLyrics(track: Track | null, rev: number): LState {
  const [st, setSt] = useState<{ id: string | null; rev: number; v: LState }>({ id: null, rev: 0, v: { status: 'loading' } });
  useEffect(() => {
    if (!track) return;
    if (track.lyrics) {
      const inlineData: LyricsData = {
        synced: track.lyrics,
        matchedTitle: track.title,
        matchedArtist: track.artist,
        durationDeltaSec: 0,
        sourceLabel: 'Кэш',
      };
      setSt({ id: track.id, rev, v: { status: 'synced', lines: track.lyrics, data: inlineData } });
      return;
    }
    let alive = true;
    setSt({ id: track.id, rev, v: { status: 'loading' } });
    getLyrics(track, rev > 0).then((d) => {
      if (!alive) return;
      setSt({ id: track.id, rev, v: toLState(d) });
    });
    return () => {
      alive = false;
    };
  }, [track, rev]);
  if (track?.lyrics) {
    return {
      status: 'synced',
      lines: track.lyrics,
      data: {
        synced: track.lyrics,
        matchedTitle: track.title,
        matchedArtist: track.artist,
        durationDeltaSec: 0,
        sourceLabel: 'Кэш',
      },
    };
  }
  return st.id === track?.id && st.rev === rev ? st.v : { status: 'loading' };
}

function SyncedLyrics({ trackId, lines, variant }: { trackId: string; lines: LyricLine[]; variant: 'panel' | 'imm' }) {
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLParagraphElement | null)[]>([]);
  const activeRef = useRef(-1);
  const lastRealTimeRef = useRef(0);
  const [active, setActive] = useState(-1);
  const [y, setY] = useState(0);
  const [manual, setManual] = useState(0);
  const [isManual, setIsManual] = useState(false);
  const [h, setH] = useState(0);
  const idle = useRef(0);
  const touchY = useRef(0);
  const offsetSec = useStore(ui, (s) => resolveEffectiveLyricsOffset(s.lyricsOffsets, trackId, s.lyricsLiveDraft));
  const secondTick = useSecond();
  const leadGap = variant === 'panel' && !!lines[0]?.gap;
  const firstText = leadGap ? Math.max(1, lines.findIndex((l) => !l.gap)) : 0;
  const intro = leadGap && active < firstText;

  const syncAtRealTime = (realTime: number, currentOffset: number) => {
    lastRealTimeRef.current = realTime;
    // Negative offset (-0.25s) makes lyrics appear earlier; positive (+0.25s) delays lyrics (shows later).
    const time = realTime - currentOffset;
    const i = findSyncedLyricLineIndex(lines, realTime, currentOffset, 0.12);
    if (i !== activeRef.current) {
      activeRef.current = i;
      setActive(i);
    }
    if (i >= 0) {
      const L = lines[i];
      const end = Math.min(lines[i + 1]?.t ?? L.t + 6, L.t + (L.gap ? 60 : 7));
      refs.current[i]?.style.setProperty('--lp', String(clamp((time - L.t) / Math.max(0.4, end - L.t), 0, 1)));
    }
  };

  useEffect(
    () =>
      onFrame((_visualTime, _dur, realTime) => {
        syncAtRealTime(realTime, getEffectiveTrackLyricsOffset(trackId));
      }),
    [lines, trackId, offsetSec, secondTick],
  );

  useLayoutEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(idle.current);
    };
  }, []);

  useLayoutEffect(() => {
    const el = refs.current[intro ? firstText : Math.max(active, 0)];
    if (!el || !box.current) return;
    if (intro) {
      setY(el.offsetTop);
      return;
    }
    const anchor = variant === 'imm' ? 0.4 : 0.3;
    setY(el.offsetTop + el.offsetHeight / 2 - box.current.clientHeight * anchor);
  }, [active, h, variant, lines, intro, firstText]);

  const scrollBy = (dy: number) => {
    const H = box.current?.clientHeight ?? 0;
    const total = list.current?.offsetHeight ?? 0;
    setIsManual(true);
    setManual((m) => clamp(y + m + dy, -H * 0.3, Math.max(0, total - H * 0.5)) - y);
    clearTimeout(idle.current);
    idle.current = window.setTimeout(() => {
      setIsManual(false);
      setManual(0);
    }, 2600);
  };

  return (
    <div
      ref={box}
      className="lyrics"
      data-v={variant}
      data-manual={isManual}
      data-intro={intro}
      onWheel={(e) => scrollBy(e.deltaY)}
      onTouchStart={(e) => (touchY.current = e.touches[0].clientY)}
      onTouchMove={(e) => {
        const cy = e.touches[0].clientY;
        scrollBy(touchY.current - cy);
        touchY.current = cy;
      }}
    >
      <div ref={list} className="lyrics-lines" style={{ '--y': `${-(y + manual)}px` } as Vars}>
        {lines.map((l, i) => {
          const d = i - active;
          return (
            <p
              key={i}
              ref={(el) => {
                refs.current[i] = el;
              }}
              className="lyric"
              data-gap={l.gap && variant === 'panel' ? (i === 0 ? 'lead' : 'mid') : undefined}
              data-wait={intro && i === firstText ? true : undefined}
              data-state={i === active ? 'active' : d < 0 ? 'past' : 'future'}
              style={{ '--d': clamp(d, 0, 10), '--dist': Math.min(Math.abs(d), 5) } as Vars}
              onClick={() => {
                seek(getSeekTimeForLyricLine(l.t, offsetSec));
                if (!player.get().playing) toggle();
              }}
            >
              {l.gap && variant === 'panel' ? (
                i === 0 ? null : <span className="lyric-pulse" aria-label="♪" />
              ) : l.gap ? (
                <span className="lyric-dots" aria-label="♪">
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                <span className="lyric-text">{l.text}</span>
              )}
            </p>
          );
        })}
      </div>
    </div>
  );
}

function PlainLyrics({ lines, preview, variant }: { lines: string[]; preview?: boolean; variant: 'panel' | 'imm' }) {
  return (
    <div className="lyrics lyrics-plain" data-v={variant}>
      <div>
        {preview && (
          <div className="lyrics-note">
            <Icon name="info" size={16} />
            {t('previewNote')}
          </div>
        )}
        {lines.map((l, i) => (l ? <p key={i} className="plain-line" style={{ '--i': i } as Vars}>{l}</p> : <div key={i} className="h-5" />))}
      </div>
    </div>
  );
}

function defaultManualQuery(track: Track): string {
  const cleanTitle = stripTrackNoise(track.title);
  if (/\s[-–—]\s/.test(cleanTitle)) return cleanTitle;
  return `${track.artist} - ${cleanTitle || track.title}`;
}

function ManualLyricsPicker({
  track,
  onSelect,
  variant,
}: {
  track: Track;
  onSelect: () => void;
  variant: 'panel' | 'imm';
}) {
  const [open, setOpen] = useState(false);
  const { mounted, visible } = usePresence(open, 520);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [top, setTop] = useState(0);
  const [origin, setOrigin] = useState({ by: 0, bx: 0 });
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState(() => defaultManualQuery(track));
  const [results, setResults] = useState<ManualLyricsChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQuery(defaultManualQuery(track));
    setOpen(false);
  }, [track.id]);

  // In the right panel the search covers everything below the cover art;
  // in fullscreen (imm) it morphs across the lyrics stage while blurring out the background lyrics.
  useLayoutEffect(() => {
    const inner =
      variant === 'panel'
        ? (wrapRef.current?.closest('.np-inner') as HTMLElement | null)
        : (wrapRef.current?.closest('.lyrics-stage') as HTMLElement | null);
    setHost(inner);
    if (!inner || !open) return;
    const measure = () => {
      const ir = inner.getBoundingClientRect();
      if (variant === 'panel') {
        const cover = inner.querySelector('.np-cover');
        const topPx = cover ? cover.getBoundingClientRect().bottom - ir.top + 12 : 20;
        setTop(topPx);
        const br = btnRef.current?.getBoundingClientRect();
        if (br) setOrigin({ by: Math.max(0, br.top - (ir.top + topPx)), bx: Math.max(0, ir.right - 20 - br.right) });
      } else {
        setTop(0);
        const br = btnRef.current?.getBoundingClientRect();
        if (br) setOrigin({ by: Math.max(0, br.top - ir.top), bx: Math.max(0, ir.right - br.right) });
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [variant, track.id, open]);

  // Lets the rest of the panel step back while the search is expanded.
  useEffect(() => {
    if (!host || !visible) return;
    host.dataset.lyricsSearch = 'open';
    return () => {
      delete host.dataset.lyricsSearch;
    };
  }, [host, visible]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => inputRef.current?.focus());
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!wrapRef.current?.contains(target) && !popRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    const tm = window.setTimeout(() => {
      searchLyricsManual(q, ac.signal)
        .then((items) => {
          if (!ac.signal.aborted) setResults(items);
        })
        .catch(() => {
          if (!ac.signal.aborted) setResults([]);
        })
        .finally(() => {
          if (!ac.signal.aborted) setLoading(false);
        });
    }, 280);
    return () => {
      window.clearTimeout(tm);
      ac.abort();
    };
  }, [open, query]);

  const hasCustom = hasManualLyricsChoice(track.id);
  const wrapPortal = (node: ReactNode) => (host ? createPortal(node, host) : node);
  const isImm = variant === 'imm';

  return (
    <div ref={wrapRef} className="lyrics-picker-trigger relative inline-flex items-center">
      <button
        ref={btnRef}
        type="button"
        data-ripple
        title={t('wrongLyricsBtn')}
        aria-label={t('wrongLyricsBtn')}
        aria-expanded={open}
        className={cx(
          'sl pointer-events-auto shrink-0 rounded-full backdrop-blur-md transition duration-200',
          isImm
            ? 'inline-flex h-10 items-center gap-2 px-3.5 text-xs font-semibold'
            : 'inline-grid h-8 w-8 place-items-center',
          open && isImm && 'pointer-events-none scale-75 opacity-0',
          open || hasCustom
            ? isImm
              ? 'bg-primary/20 text-primary'
              : 'bg-primary/22 text-primary ring-1 ring-primary/40'
            : isImm
              ? 'bg-on-surface/8 text-on-surface-variant hover:bg-on-surface/14 hover:text-on-surface'
              : 'bg-sc-high/70 text-on-surface-variant ring-1 ring-white/10 hover:text-on-surface',
        )}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon key={open ? 'close' : 'search'} name={open ? 'close' : 'search'} size={isImm ? 17 : 16} className="pop" />
        {isImm && <span>{t('wrongLyricsBtn')}</span>}
      </button>

      {mounted && wrapPortal(
        isImm ? (
          <div
            ref={popRef}
            className="lyrics-pop lyrics-pop-fill imm-lyrics-card pointer-events-auto absolute inset-0 z-30 flex min-h-0 flex-col"
            style={{ '--by': `${origin.by}px`, '--bx': `${origin.bx}px` } as Vars}
            data-open={visible}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <IconButton icon="arrow_back" label={t('back')} variant="glass" tip={false} onClick={() => setOpen(false)} />
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-primary/20 text-primary">
                  <Icon name="lyrics" fill size={22} />
                </span>
                <div className="min-w-0">
                  <h2 className="headline truncate text-xl leading-tight">{t('lyricsSearchTitle')}</h2>
                  <p className="truncate text-xs text-on-surface-variant">
                    {track.artist} — {track.title}
                  </p>
                </div>
              </div>

              {hasCustom && (
                <button
                  type="button"
                  data-ripple
                  className="sl inline-flex items-center gap-1.5 rounded-full bg-primary/18 px-3.5 py-2 text-xs font-semibold text-primary transition hover:bg-primary/26"
                  onClick={() => {
                    setManualLyricsChoice(track.id, null);
                    setOpen(false);
                    onSelect();
                  }}
                >
                  <Icon name="refresh" size={16} />
                  <span>{t('lyricsResetManual')}</span>
                </button>
              )}
            </div>

            <div className="mt-4 flex h-12 shrink-0 items-center gap-3 rounded-2xl bg-on-surface/8 px-4 transition-colors focus-within:bg-on-surface/14">
              <Icon name="search" size={20} className="text-primary" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('lyricsSearchPlaceholder')}
                className="h-full min-w-0 flex-1 bg-transparent text-[15px] font-medium outline-0 placeholder:text-on-surface-variant/60"
              />
              {loading && <Loader size={20} />}
              {query && (
                <IconButton icon="close" label={t('cancel')} size="sm" tip={false} onClick={() => setQuery('')} />
              )}
            </div>

            <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
              {results.length === 0 && !loading ? (
                <div className="flex h-44 flex-col items-center justify-center gap-2 text-center text-sm text-on-surface-variant">
                  <Icon name="search_off" size={32} className="opacity-60" />
                  <span>{t('noResults')}</span>
                </div>
              ) : (
                results.map((item, i) => {
                  const durDiff = Math.abs((track.fullDuration ?? track.duration) - item.duration);
                  const closeDur = item.duration > 0 && durDiff <= 4;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-ripple
                      className="lyrics-pop-item sl group flex w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left transition hover:bg-on-surface/8"
                      style={{ '--i': Math.min(i, 12) } as Vars}
                      onClick={() => {
                        setManualLyricsChoice(track.id, item, toSeconds(track.fullDuration ?? track.duration));
                        setOpen(false);
                        onSelect();
                      }}
                    >
                      <span
                        className={cx(
                          'grid h-10 w-10 shrink-0 place-items-center rounded-xl transition-colors',
                          item.syncedLyrics
                            ? 'bg-primary/16 text-primary group-hover:bg-primary group-hover:text-on-primary'
                            : 'bg-on-surface/8 text-on-surface-variant group-hover:bg-on-surface/14 group-hover:text-on-surface',
                        )}
                      >
                        <Icon name={item.syncedLyrics ? 'lyrics' : 'music_note'} fill={!!item.syncedLyrics} size={20} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[15px] font-semibold text-on-surface">{item.trackName}</div>
                        <div className="mt-0.5 truncate text-xs text-on-surface-variant">
                          {item.artistName}
                          {item.albumName ? ` · ${item.albumName}` : ''}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {item.syncedLyrics && (
                          <span className="rounded-full bg-primary/18 px-2.5 py-1 text-[11px] font-bold text-primary">
                            {t('lyricsSyncedBadge')}
                          </span>
                        )}
                        {item.duration > 0 && (
                          <span
                            className={cx(
                              'rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums',
                              closeDur
                                ? 'bg-primary/18 font-bold text-primary'
                                : 'bg-on-surface/8 text-on-surface-variant',
                            )}
                          >
                            {fmtTime(item.duration)}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        ) : (
          <div
            ref={popRef}
            className={cx(
              'lyrics-pop pointer-events-auto flex min-h-0 flex-col',
              host
                ? 'lyrics-pop-fill absolute inset-x-5 bottom-[18px] z-30'
                : 'max-h-[min(420px,100%)] w-full rounded-3xl bg-sc-high/95 p-3.5 shadow-2xl ring-1 ring-white/15 backdrop-blur-xl',
            )}
            style={host ? ({ top, '--by': `${origin.by}px`, '--bx': `${origin.bx}px` } as Vars) : undefined}
            data-open={visible}
          >
            <div className="mb-2 flex items-center gap-1">
              <IconButton icon="arrow_back" label={t('back')} size="sm" tip={false} onClick={() => setOpen(false)} />
              <span className="min-w-0 flex-1 truncate text-xs font-bold">{t('lyricsSearchTitle')}</span>
              <span className="flex items-center gap-1">
                {hasCustom && (
                  <button
                    type="button"
                    className="text-[11px] font-semibold text-primary hover:underline"
                    onClick={() => {
                      setManualLyricsChoice(track.id, null);
                      setOpen(false);
                      onSelect();
                    }}
                  >
                    {t('lyricsResetManual')}
                  </button>
                )}
              </span>
            </div>

            <div className="flex items-center gap-2 rounded-2xl bg-on-surface/8 px-3 py-1.5 transition-colors focus-within:bg-on-surface/12">
              <Icon name="search" size={17} className="text-on-surface-variant" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('lyricsSearchPlaceholder')}
                className="h-7 flex-1 min-w-0 bg-transparent text-xs outline-0"
              />
              {loading && <Loader size={16} />}
              {query && (
                <IconButton icon="close" label={t('cancel')} size="sm" tip={false} onClick={() => setQuery('')} />
              )}
            </div>

            <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-0.5">
              {results.length === 0 && !loading ? (
                <div className="py-6 text-center text-xs text-on-surface-variant">{t('noResults')}</div>
              ) : (
                results.map((item, i) => {
                  const durDiff = Math.abs((track.fullDuration ?? track.duration) - item.duration);
                  const closeDur = item.duration > 0 && durDiff <= 4;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-ripple
                      className="lyrics-pop-item sl flex w-full items-center justify-between gap-2 rounded-2xl px-3 py-2 text-left transition hover:bg-on-surface/8"
                      style={{ '--i': Math.min(i, 12) } as Vars}
                      onClick={() => {
                        setManualLyricsChoice(track.id, item, toSeconds(track.fullDuration ?? track.duration));
                        setOpen(false);
                        onSelect();
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-semibold text-on-surface">{item.trackName}</div>
                        <div className="truncate text-[11px] text-on-surface-variant">{item.artistName}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {item.syncedLyrics && (
                          <span className="rounded-md bg-primary/20 px-1.5 py-0.5 text-[10px] font-bold text-primary">
                            {t('lyricsSyncedBadge')}
                          </span>
                        )}
                        {item.duration > 0 && (
                          <span className={cx('text-[11px] tabular-nums', closeDur ? 'font-bold text-primary' : 'text-on-surface-variant')}>
                            {fmtTime(item.duration)}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )
      )}
    </div>
  );
}

/** Clock with left/right arrows — "shift the lyrics in time". Inline SVG keeps it crisp at 16–18 px. */
function LyricsOffsetGlyph({ size }: { size: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <circle cx="12" cy="12" r="5.2" />
      <path d="M12 9.3V12l1.9 1.2" />
      <path d="M5.4 12H2.2" />
      <path d="M4.2 10.8 2.2 12l2 1.2" />
      <path d="M18.6 12h3.2" />
      <path d="M19.8 10.8 21.8 12l-2 1.2" />
    </svg>
  );
}

function formatLyricsOffsetValue(offsetSec: number, unit: string): string {
  const snapped = clampLyricsOffset(offsetSec);
  if (Math.abs(snapped) < 0.01) return `0.00 ${unit}`;
  const sign = snapped > 0 ? '+' : '−';
  return `${sign}${Math.abs(snapped).toFixed(2)} ${unit}`;
}

function LyricsOffsetPopover({
  track,
  data,
  syncType,
  variant,
}: {
  track: Track;
  data: LyricsData | null;
  syncType: 'Synced' | 'Plain' | 'None';
  variant: 'panel' | 'imm';
}) {
  const [open, setOpen] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [placement, setPlacement] = useState<LyricsOffsetPopoverPlacement | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const isSynced = syncType === 'Synced';
  const isImm = variant === 'imm';
  const secUnit = t('secShort');

  const savedOffsetSec = useStore(ui, (s) => {
    const v = s.lyricsOffsets?.[track.id];
    return typeof v === 'number' && Number.isFinite(v) ? clampLyricsOffset(v) : 0;
  });
  const liveOffsetSec = useStore(ui, (s) =>
    resolveEffectiveLyricsOffset(s.lyricsOffsets, track.id, s.lyricsLiveDraft),
  );
  const hasSavedOffset = Math.abs(savedOffsetSec) >= 0.01;
  const hasUnsavedDiff = Math.abs(liveOffsetSec - savedOffsetSec) >= 0.01;

  // The lyrics panel is clipped (`overflow: hidden` + backdrop blur), so the popover
  // lives in a portal on document.body and is positioned from viewport coordinates.
  const updatePlacement = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const anchorRect = btn.getBoundingClientRect();
    const host = (btn.closest('.lyrics-stage') as HTMLElement | null)?.getBoundingClientRect() ?? null;
    const next = computeLyricsOffsetPopoverPlacement({
      anchor: {
        left: anchorRect.left,
        top: anchorRect.top,
        right: anchorRect.right,
        bottom: anchorRect.bottom,
      },
      container: host ? { left: host.left, right: host.right } : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      popoverHeight: popRef.current?.offsetHeight ?? 0,
    });
    setPlacement((prev) =>
      prev &&
      prev.left === next.left &&
      prev.top === next.top &&
      prev.width === next.width &&
      prev.maxHeight === next.maxHeight
        ? prev
        : next,
    );
  }, []);

  // Discard any unsaved live draft when switching tracks and close the popover.
  useEffect(() => {
    setOpen(false);
    setJustSaved(false);
    clearLiveTrackLyricsOffset();
  }, [track.id]);

  // If lyrics become non-synced, close popover.
  useEffect(() => {
    if (!isSynced && open) setOpen(false);
  }, [isSynced, open]);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    updatePlacement();
  }, [open, updatePlacement, isImm]);

  // Re-measure once the popover has a height (first paint uses height 0).
  useLayoutEffect(() => {
    if (open) updatePlacement();
  });

  useEffect(() => {
    if (!open) return;
    const onReflow = () => updatePlacement();
    window.addEventListener('resize', onReflow);
    document.addEventListener('scroll', onReflow, true);
    const ro = new ResizeObserver(onReflow);
    const host = btnRef.current?.closest('.lyrics-stage');
    if (host) ro.observe(host);
    if (popRef.current) ro.observe(popRef.current);
    return () => {
      window.removeEventListener('resize', onReflow);
      document.removeEventListener('scroll', onReflow, true);
      ro.disconnect();
    };
  }, [open, updatePlacement]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!wrapRef.current?.contains(target) && !popRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const src = data?.sourceLabel ?? 'LRCLIB';
  const artist = data?.matchedArtist || track.artist;
  const title = data?.matchedTitle || track.title;
  const playingSec = toSeconds(track.fullDuration ?? track.duration);
  const delta =
    typeof data?.durationDeltaSec === 'number'
      ? data.durationDeltaSec
      : playingSec > 0 && data?.matchedDurationSec
        ? Number((playingSec - data.matchedDurationSec).toFixed(1))
        : 0;
  const deltaSign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
  const deltaStr = `${deltaSign}${Math.abs(delta).toFixed(1)} ${secUnit}`;
  const sourceLine = `${src} · ${syncType === 'Synced' ? 'SYNCED' : 'PLAIN'} · ${artist} — ${title} · ${t('lyricsDurationDelta', { delta: deltaStr })}`;

  const handleSliderChange = (nextVal: number) => {
    setJustSaved(false);
    setLiveTrackLyricsOffset(track.id, nextVal);
  };

  const handleReset = () => {
    setJustSaved(false);
    setLiveTrackLyricsOffset(track.id, 0);
  };

  const handleSave = () => {
    setTrackLyricsOffset(track.id, liveOffsetSec);
    setJustSaved(true);
    window.setTimeout(() => setJustSaved(false), 1400);
  };

  return (
    <div ref={wrapRef} className="relative inline-flex items-center">
      <button
        ref={btnRef}
        type="button"
        data-ripple={isSynced || undefined}
        disabled={!isSynced}
        title={isSynced ? t('lyricsOffsetBtn') : t('lyricsOffsetNoSync')}
        aria-label={isSynced ? t('lyricsOffsetBtn') : t('lyricsOffsetNoSync')}
        aria-expanded={open}
        onClick={() => {
          if (!isSynced) return;
          setOpen((v) => !v);
        }}
        className={cx(
          'sl relative shrink-0 inline-grid place-items-center rounded-full backdrop-blur-md transition duration-200',
          isImm ? 'h-10 w-10' : 'h-8 w-8',
          !isSynced
            ? 'cursor-not-allowed bg-sc-high/35 text-on-surface-variant/35 ring-1 ring-white/5 opacity-60'
            : open || hasSavedOffset || hasUnsavedDiff
              ? isImm
                ? 'bg-primary/20 text-primary ring-1 ring-primary/40'
                : 'bg-primary/22 text-primary ring-1 ring-primary/40'
              : isImm
                ? 'bg-on-surface/8 text-on-surface-variant hover:bg-on-surface/14 hover:text-on-surface'
                : 'bg-sc-high/70 text-on-surface-variant ring-1 ring-white/10 hover:text-on-surface',
        )}
      >
        <LyricsOffsetGlyph size={isImm ? 18 : 16} />
        {isSynced && hasSavedOffset && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-primary ring-2 ring-surface"
          />
        )}
      </button>

      {open &&
        isSynced &&
        placement &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label={t('lyricsOffsetBtn')}
            style={{
              position: 'fixed',
              left: placement.left,
              top: placement.top,
              width: placement.width,
              maxHeight: placement.maxHeight,
            }}
            className="z-[70] overflow-y-auto overscroll-contain rounded-2xl bg-sc-high/95 p-3 text-xs text-on-surface shadow-2xl ring-1 ring-white/15 backdrop-blur-xl"
          >
            {/* 1) Source and sync type summary line + possible offset warning badge */}
            <div className="mb-3 flex flex-wrap items-start gap-1.5 border-b border-white/10 pb-2.5 text-[11px] leading-snug text-on-surface-variant">
              <span className="line-clamp-2 min-w-0 flex-1 break-words" title={sourceLine}>
                <strong className="font-semibold text-primary">{src}</strong>
                {' · '}
                <span className="font-bold uppercase tracking-wider text-on-surface">
                  {syncType === 'Synced' ? 'SYNCED' : 'PLAIN'}
                </span>
                {' · '}
                <span className="text-on-surface">{artist} — {title}</span>
                {' · '}
                <span className="tabular-nums opacity-85">{t('lyricsDurationDelta', { delta: deltaStr })}</span>
              </span>
              {data?.possibleOffsetWarning && (
                <span className="shrink-0 rounded-full bg-[#ff9f0a]/20 px-2 py-0.5 text-[10px] font-bold text-[#ffb340]">
                  {t('lyricsOffsetWarn')}
                </span>
              )}
            </div>

            {/* 2) Slider -10..+10 s with step 0.25 s, center 0, value on the right, labels Earlier / Later */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={LYRICS_OFFSET_MIN_SEC}
                  max={LYRICS_OFFSET_MAX_SEC}
                  step={LYRICS_OFFSET_STEP_SEC}
                  value={liveOffsetSec}
                  aria-label={t('lyricsOffsetBtn')}
                  onChange={(e) => handleSliderChange(Number(e.target.value))}
                  className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-lg bg-on-surface/15 accent-primary focus:outline-none"
                />
                <span
                  className={cx(
                    'w-14 shrink-0 text-right font-mono text-xs font-bold tabular-nums',
                    Math.abs(liveOffsetSec) >= 0.01 ? 'text-primary' : 'text-on-surface-variant',
                  )}
                >
                  {formatLyricsOffsetValue(liveOffsetSec, secUnit)}
                </span>
              </div>

              <div className="flex items-center justify-between gap-1 px-0.5 text-[10px] font-medium text-on-surface-variant">
                <span className="truncate">← {t('lyricsOffsetEarlier')} (−)</span>
                <span className="shrink-0 tabular-nums opacity-70">0</span>
                <span className="truncate text-right">(+) {t('lyricsOffsetLater')} →</span>
              </div>
            </div>

            {/* 3) Two action buttons: Reset and Save */}
            <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                data-ripple
                disabled={Math.abs(liveOffsetSec) < 0.01}
                onClick={handleReset}
                className={cx(
                  'sl rounded-xl px-3 py-1.5 text-xs font-semibold transition',
                  Math.abs(liveOffsetSec) >= 0.01
                    ? 'bg-on-surface/10 text-on-surface hover:bg-on-surface/16'
                    : 'cursor-default bg-on-surface/5 text-on-surface-variant/40',
                )}
              >
                {t('lyricsOffsetReset')}
              </button>
              <button
                type="button"
                data-ripple
                onClick={handleSave}
                className={cx(
                  'sl inline-flex items-center gap-1 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition',
                  justSaved
                    ? 'bg-primary text-on-primary'
                    : 'bg-primary/22 text-primary ring-1 ring-primary/40 hover:bg-primary/30',
                )}
              >
                {justSaved && <Icon name="check" size={14} />}
                <span>{justSaved ? t('lyricsOffsetSaved') : t('lyricsOffsetSave')}</span>
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

export function Lyrics({ track, variant }: { track: Track | null; variant: 'panel' | 'imm' }) {
  const [rev, setRev] = useState(0);
  const st = useLyrics(track, rev);
  if (!track) return null;

  const syncType: 'Synced' | 'Plain' | 'None' =
    st.status === 'synced' ? 'Synced' : st.status === 'plain' ? 'Plain' : 'None';
  const lyricsData = st.status === 'synced' || st.status === 'plain' ? st.data : st.status === 'none' ? (st.data ?? null) : null;

  return (
    <div className="lyrics-stage relative flex h-full w-full min-h-0 flex-col">
      <div
        className={cx(
          'lyrics-header flex shrink-0 items-center justify-end gap-1.5',
          variant === 'imm' ? 'px-2 pb-1.5 pt-1' : 'px-2.5 pb-1 pt-2',
        )}
      >
        <LyricsOffsetPopover
          track={track}
          data={lyricsData}
          syncType={syncType}
          variant={variant}
        />
        <ManualLyricsPicker track={track} variant={variant} onSelect={() => setRev((r) => r + 1)} />
      </div>
      <div className="relative min-h-0 flex-1">
        {st.status === 'loading' ? (
          variant === 'panel' ? (
            <div className="lyrics-loading" role="progressbar" aria-label={t('lyricsLoading')} aria-busy="true">
              <span />
            </div>
          ) : (
            <div className="lyrics-state">
              <Loader size={64} />
              <span>{t('lyricsLoading')}</span>
            </div>
          )
        ) : st.status === 'none' ? (
          <div className="lyrics-state">
            <Shape n={7} amp={0.1} className="spin-slow h-20 w-20 text-secondary-container">
              <Icon name={st.instrumental ? 'piano' : 'lyrics'} size={34} className="text-on-secondary-container" />
            </Shape>
            <span>{st.instrumental ? t('instrumental') : t('noLyrics')}</span>
          </div>
        ) : st.status === 'plain' ? (
          <PlainLyrics key={`${track.id}:${rev}`} lines={st.lines} preview={st.preview} variant={variant} />
        ) : (
          <SyncedLyrics key={`${track.id}:${rev}`} trackId={track.id} lines={st.lines} variant={variant} />
        )}
      </div>
    </div>
  );
}
