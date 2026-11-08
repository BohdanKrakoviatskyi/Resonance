import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { IconButton, Loader, Shape, type Vars } from './ui';
import { clamp, cx, fmtTime } from '../lib/util';
import { t } from '../lib/i18n';
import {
  getLyrics,
  hasManualLyricsChoice,
  searchLyricsManual,
  setManualLyricsChoice,
  type LyricsData,
  type ManualLyricsChoice,
} from '../lib/api';
import { stripTrackNoise } from '../lib/lyrics-match';
import { onFrame, player, seek, toggle } from '../state/player';
import type { LyricLine, Track } from '../types';

type LState =
  | { status: 'loading' }
  | { status: 'none'; instrumental?: boolean }
  | { status: 'synced'; lines: LyricLine[] }
  | { status: 'plain'; lines: string[]; preview?: boolean };

function toLState(d: LyricsData | null): LState {
  if (!d) return { status: 'none' };
  if (d.synced?.length) return { status: 'synced', lines: d.synced };
  if (d.plain?.length) return { status: 'plain', lines: d.plain, preview: d.preview };
  return { status: 'none', instrumental: d.instrumental };
}

function useLyrics(track: Track | null, rev: number): LState {
  const [st, setSt] = useState<{ id: string | null; rev: number; v: LState }>({ id: null, rev: 0, v: { status: 'loading' } });
  useEffect(() => {
    if (!track) return;
    if (track.lyrics) {
      setSt({ id: track.id, rev, v: { status: 'synced', lines: track.lyrics } });
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
  if (track?.lyrics) return { status: 'synced', lines: track.lyrics };
  return st.id === track?.id && st.rev === rev ? st.v : { status: 'loading' };
}

function findLine(lines: LyricLine[], time: number) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (lines[m].t <= time) {
      ans = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return ans;
}

function SyncedLyrics({ lines, variant }: { lines: LyricLine[]; variant: 'panel' | 'imm' }) {
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLParagraphElement | null)[]>([]);
  const activeRef = useRef(-1);
  const [active, setActive] = useState(-1);
  const [y, setY] = useState(0);
  const [manual, setManual] = useState(0);
  const [isManual, setIsManual] = useState(false);
  const [h, setH] = useState(0);
  const idle = useRef(0);
  const touchY = useRef(0);
  const leadGap = variant === 'panel' && !!lines[0]?.gap;
  const firstText = leadGap ? Math.max(1, lines.findIndex((l) => !l.gap)) : 0;
  const intro = leadGap && active < firstText;

  useEffect(
    () =>
      onFrame((_visualTime, _dur, realTime) => {
        const time = realTime;
        const i = findLine(lines, time + 0.12);
        if (i !== activeRef.current) {
          activeRef.current = i;
          setActive(i);
        }
        if (i >= 0) {
          const L = lines[i];
          const end = Math.min(lines[i + 1]?.t ?? L.t + 6, L.t + (L.gap ? 60 : 7));
          refs.current[i]?.style.setProperty('--lp', String(clamp((time - L.t) / Math.max(0.4, end - L.t), 0, 1)));
        }
      }),
    [lines],
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
                seek(l.t);
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
}: {
  track: Track;
  onSelect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(() => defaultManualQuery(track));
  const [results, setResults] = useState<ManualLyricsChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQuery(defaultManualQuery(track));
    setOpen(false);
  }, [track.id]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => inputRef.current?.focus());
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
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

  return (
    <div ref={wrapRef} className="absolute right-2.5 top-2.5 z-20">
      <button
        type="button"
        data-ripple
        title={t('wrongLyricsBtn')}
        aria-label={t('wrongLyricsBtn')}
        aria-expanded={open}
        className={cx(
          'sl inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold backdrop-blur-md transition',
          open || hasCustom
            ? 'bg-primary/22 text-primary ring-1 ring-primary/40'
            : 'bg-sc-high/70 text-on-surface-variant ring-1 ring-white/10 hover:text-on-surface',
        )}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="search" size={15} />
        <span className="max-[420px]:hidden">{t('wrongLyricsBtn')}</span>
      </button>

      {open && (
        <div className="anim-in absolute right-0 top-10 w-80 max-w-[calc(100vw-32px)] rounded-3xl bg-sc-high/95 p-3.5 shadow-2xl ring-1 ring-white/15 backdrop-blur-xl">
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <span className="text-xs font-bold">{t('lyricsSearchTitle')}</span>
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
          </div>

          <div className="flex items-center gap-2 rounded-2xl bg-sc-lowest/80 px-3 py-1.5 ring-1 ring-white/10 focus-within:ring-2 focus-within:ring-primary">
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

          <div className="mt-2 max-h-60 overflow-y-auto pr-0.5">
            {results.length === 0 && !loading ? (
              <div className="py-6 text-center text-xs text-on-surface-variant">{t('noResults')}</div>
            ) : (
              results.map((item) => {
                const durDiff = Math.abs((track.fullDuration ?? track.duration) - item.duration);
                const closeDur = item.duration > 0 && durDiff <= 4;
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-ripple
                    className="sl flex w-full items-center justify-between gap-2 rounded-2xl px-3 py-2 text-left transition hover:bg-on-surface/8"
                    onClick={() => {
                      setManualLyricsChoice(track.id, item);
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
      )}
    </div>
  );
}

export function Lyrics({ track, variant }: { track: Track | null; variant: 'panel' | 'imm' }) {
  const [rev, setRev] = useState(0);
  const st = useLyrics(track, rev);
  if (!track) return null;

  return (
    <div className="relative h-full w-full">
      <ManualLyricsPicker track={track} onSelect={() => setRev((r) => r + 1)} />
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
        <SyncedLyrics key={`${track.id}:${rev}`} lines={st.lines} variant={variant} />
      )}
    </div>
  );
}
