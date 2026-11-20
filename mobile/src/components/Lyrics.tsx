import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { IconButton, Loader, Shape, usePresence, type Vars } from './ui';
import { clamp, cx, fmtTime } from '../lib/util';
import { t, useLang } from '../lib/i18n';
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

function useLyrics(track: Track | null, rev: number, active = true): LState {
  const [st, setSt] = useState<{ id: string | null; rev: number; v: LState }>({
    id: null,
    rev: 0,
    v: { status: 'loading' },
  });
  const loaded = !!track && st.id === track.id && st.rev === rev && st.v.status !== 'loading';
  useEffect(() => {
    if (!track) return;
    if (track.lyrics) {
      setSt({ id: track.id, rev, v: { status: 'synced', lines: track.lyrics } });
      return;
    }
    if (!active || loaded) return;
    const ac = new AbortController();
    setSt({ id: track.id, rev, v: { status: 'loading' } });
    getLyrics(track, rev > 0, ac.signal)
      .then((d) => {
        if (ac.signal.aborted) return;
        setSt({ id: track.id, rev, v: toLState(d) });
      })
      .catch(() => {
        if (ac.signal.aborted) return;
        setSt({ id: track.id, rev, v: { status: 'none' } });
      });
    return () => {
      ac.abort();
    };
  }, [track, rev, active, loaded]);
  if (track?.lyrics) return { status: 'synced', lines: track.lyrics };
  return st.id === track?.id && st.rev === rev ? st.v : { status: 'loading' };
}

function findLine(lines: LyricLine[], time: number) {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (lines[m].t <= time) {
      ans = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return ans;
}

function SyncedLyrics({
  lines,
  activeSurface = true,
}: {
  lines: LyricLine[];
  activeSurface?: boolean;
}) {
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
  const lpRef = useRef({ i: -1, p: -1 });
  const touchY = useRef(0);

  useEffect(() => {
    if (!activeSurface) return;
    return onFrame((_visualTime, _dur, realTime) => {
      const time = realTime;
      const i = findLine(lines, time + 0.12);
      if (i !== activeRef.current) {
        activeRef.current = i;
        setActive(i);
      }
      if (i >= 0) {
        const L = lines[i];
        const end = Math.min(lines[i + 1]?.t ?? L.t + 6, L.t + (L.gap ? 60 : 7));
        const p = clamp((time - L.t) / Math.max(0.4, end - L.t), 0, 1);
        if (i !== lpRef.current.i || Math.abs(p - lpRef.current.p) >= 0.002) {
          lpRef.current = { i, p };
          refs.current[i]?.style.setProperty('--lp', p.toFixed(4));
        }
      }
    });
  }, [lines, activeSurface]);

  useLayoutEffect(() => {
    if (!activeSurface || !box.current) return;
    const el = box.current;
    setH(el.clientHeight);
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(idle.current);
    };
  }, [activeSurface]);

  useLayoutEffect(() => {
    if (!activeSurface) return;
    const el = refs.current[Math.max(active, 0)];
    if (!el || !box.current) return;
    const anchor = 0.36;
    setY(el.offsetTop + el.offsetHeight / 2 - box.current.clientHeight * anchor);
  }, [active, h, lines, activeSurface]);

  const scrollBy = (dy: number) => {
    const H = box.current?.clientHeight ?? 0;
    const total = list.current?.offsetHeight ?? 0;
    setIsManual(true);
    setManual((m) => clamp(y + m + dy, -H * 0.3, Math.max(0, total - H * 0.45)) - y);
    clearTimeout(idle.current);
    idle.current = window.setTimeout(() => {
      setIsManual(false);
      setManual(0);
    }, 2600);
  };

  return (
    <div
      ref={box}
      className="lyrics px-5"
      data-v="imm"
      data-manual={isManual}
      onWheel={(e) => scrollBy(e.deltaY)}
      onTouchStart={(e) => {
        touchY.current = e.touches[0].clientY;
      }}
      onTouchMove={(e) => {
        const cy = e.touches[0].clientY;
        scrollBy(touchY.current - cy);
        touchY.current = cy;
      }}
    >
      <div
        ref={list}
        className="lyrics-lines !px-1"
        style={{ '--y': `${-(y + manual)}px`, '--lfs': 'clamp(24px, 6.4vw, 34px)', '--lgap': '18px' } as Vars}
      >
        {lines.map((l, i) => {
          const d = i - active;
          return (
            <p
              key={i}
              ref={(el) => {
                refs.current[i] = el;
              }}
              className="lyric"
              data-state={i === active ? 'active' : d < 0 ? 'past' : 'future'}
              style={{ '--d': clamp(d, 0, 10), '--dist': Math.min(Math.abs(d), 5) } as Vars}
              onClick={() => {
                setIsManual(false);
                setManual(0);
                void seek(l.t);
                if (!player.get().playing) toggle();
              }}
            >
              {l.gap ? (
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

function PlainLyrics({ lines, preview }: { lines: string[]; preview?: boolean }) {
  return (
    <div className="lyrics lyrics-plain px-5" data-v="imm">
      <div style={{ '--lfs': 'clamp(19px, 5vw, 25px)' } as Vars}>
        {preview && (
          <div className="lyrics-note">
            <Icon name="info" size={16} />
            {t('previewNote')}
          </div>
        )}
        {lines.map((l, i) =>
          l ? (
            <p key={i} className="plain-line" style={{ '--i': i } as Vars}>
              {l}
            </p>
          ) : (
            <div key={i} className="h-5" />
          ),
        )}
      </div>
    </div>
  );
}

function defaultManualQuery(track: Track): string {
  const cleanTitle = stripTrackNoise(track.title);
  if (/\s[-–—]\s/.test(cleanTitle)) return cleanTitle;
  return `${track.artist} - ${cleanTitle || track.title}`;
}

const SEARCH_SETTLE_MS = 340;

function ManualLyricsPicker({
  track,
  open,
  onOpenChange,
  onSelect,
}: {
  track: Track;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: () => void;
}) {
  const { mounted, visible } = usePresence(open, 300);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [settled, setSettled] = useState(false);
  const [query, setQuery] = useState(() => defaultManualQuery(track));
  const [results, setResults] = useState<ManualLyricsChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQuery(defaultManualQuery(track));
    onOpenChange(false);
  }, [track.id]);

  useLayoutEffect(() => {
    setHost((wrapRef.current?.closest('.lyrics-stage') as HTMLElement | null) ?? null);
  }, []);

  useEffect(() => {
    if (!host || !visible) return;
    host.dataset.lyricsSearch = 'open';
    return () => {
      delete host.dataset.lyricsSearch;
    };
  }, [host, visible]);

  useEffect(() => {
    if (!open) {
      setSettled(false);
      return;
    }
    const tm = window.setTimeout(() => {
      setSettled(true);
      inputRef.current?.focus();
    }, SEARCH_SETTLE_MS);
    return () => window.clearTimeout(tm);
  }, [open]);

  useEffect(() => {
    if (!settled) return;
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
  }, [settled, query]);

  const hasCustom = hasManualLyricsChoice(track.id);
  const wrapPortal = (node: ReactNode) => (host ? createPortal(node, host) : node);

  return (
    <div
      ref={wrapRef}
      className="lyrics-picker-trigger pointer-events-none absolute inset-x-4 bottom-2 top-1 z-20 flex flex-col items-end"
    >
      <IconButton
        icon="search"
        label={t('search')}
        variant="glass"
        size="sm"
        tip={false}
        selected={hasCustom}
        aria-expanded={open}
        className={open ? 'pointer-events-none' : 'pointer-events-auto'}
        onClick={() => onOpenChange(!open)}
      />

      {mounted &&
        wrapPortal(
          <div
            className="lyrics-pop pointer-events-auto absolute inset-x-3 inset-y-1 z-30 flex min-h-0 flex-col overflow-hidden rounded-[28px] bg-sc-high/92 p-4 shadow-2xl ring-1 ring-white/12"
            data-open={visible}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <IconButton icon="arrow_back" label={t('back')} variant="glass" size="sm" tip={false} onClick={() => onOpenChange(false)} />
                <div className="min-w-0">
                  <h2 className="headline truncate text-base leading-tight">{t('lyricsSearchTitle')}</h2>
                  <p className="truncate text-[11px] text-on-surface-variant">
                    {track.artist} — {track.title}
                  </p>
                </div>
              </div>

              {hasCustom && (
                <button
                  type="button"
                  data-ripple
                  className="sl inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/18 px-3 py-1.5 text-[11px] font-bold text-primary"
                  onClick={() => {
                    setManualLyricsChoice(track.id, null);
                    onOpenChange(false);
                    onSelect();
                  }}
                >
                  <Icon name="refresh" size={15} />
                  <span>{t('lyricsResetManual')}</span>
                </button>
              )}
            </div>

            <div className="mt-3 flex h-11 shrink-0 items-center gap-2.5 rounded-2xl bg-on-surface/10 px-3.5">
              <Icon name="search" size={19} className="text-primary" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('lyricsSearchPlaceholder')}
                className="h-full min-w-0 flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-on-surface-variant/60"
              />
              {loading && <Loader size={18} />}
              {query && <IconButton icon="close" label={t('cancel')} size="sm" tip={false} onClick={() => setQuery('')} />}
            </div>

            <div className="mt-2.5 min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5">
              {results.length === 0 && !loading ? (
                <div className="flex h-36 flex-col items-center justify-center gap-2 text-center text-xs text-on-surface-variant">
                  <Icon name="search_off" size={28} className="opacity-60" />
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
                      className="lyrics-pop-item sl flex w-full items-center justify-between gap-2.5 rounded-2xl px-3 py-2.5 text-left transition active:bg-on-surface/10"
                      style={{ '--i': Math.min(i, 12) } as Vars}
                      onClick={() => {
                        setManualLyricsChoice(track.id, item);
                        onOpenChange(false);
                        onSelect();
                      }}
                    >
                      <span
                        className={cx(
                          'grid h-9 w-9 shrink-0 place-items-center rounded-xl',
                          item.syncedLyrics ? 'bg-primary/18 text-primary' : 'bg-on-surface/8 text-on-surface-variant',
                        )}
                      >
                        <Icon name={item.syncedLyrics ? 'lyrics' : 'music_note'} fill={!!item.syncedLyrics} size={18} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-on-surface">{item.trackName}</div>
                        <div className="truncate text-xs text-on-surface-variant">
                          {item.artistName}
                          {item.albumName ? ` · ${item.albumName}` : ''}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {item.syncedLyrics && (
                          <span className="rounded-full bg-primary/18 px-2 py-0.5 text-[10px] font-bold text-primary">
                            {t('lyricsSyncedBadge')}
                          </span>
                        )}
                        {item.duration > 0 && (
                          <span
                            className={cx(
                              'rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums',
                              closeDur ? 'bg-primary/18 font-bold text-primary' : 'bg-on-surface/8 text-on-surface-variant',
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
          </div>,
        )}
    </div>
  );
}

export function Lyrics({ track, active = true }: { track: Track | null; active?: boolean }) {
  useLang();
  const [rev, setRev] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const st = useLyrics(track, rev, active);
  if (!track) return null;

  return (
    <div className="lyrics-stage relative h-full min-h-0 w-full flex-1">
      <ManualLyricsPicker
        track={track}
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onSelect={() => setRev((r) => r + 1)}
      />
      {st.status === 'loading' ? (
        <div className="lyrics-state">
          <Loader size={56} />
          <span>{t('lyricsLoading')}</span>
        </div>
      ) : st.status === 'none' ? (
        <div className="lyrics-state">
          <Shape n={7} amp={0.1} className="spin-slow h-20 w-20 text-secondary-container">
            <Icon name={st.instrumental ? 'piano' : 'lyrics'} size={34} className="text-on-secondary-container" />
          </Shape>
          <span>{st.instrumental ? t('instrumental') : t('noLyrics')}</span>
        </div>
      ) : st.status === 'plain' ? (
        <PlainLyrics key={`${track.id}:${rev}`} lines={st.lines} preview={st.preview} />
      ) : (
        <SyncedLyrics key={`${track.id}:${rev}`} lines={st.lines} activeSurface={active && !searchOpen} />
      )}
    </div>
  );
}
