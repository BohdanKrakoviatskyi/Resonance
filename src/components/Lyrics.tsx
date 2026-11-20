import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { IconButton, Loader, Shape, usePresence, type Vars } from './ui';
import { clamp, cx, fmtTime } from '../lib/util';
import { t } from '../lib/i18n';
import {
  getLyrics,
  hasManualLyricsChoice,
  hasWhisperLyricsChoice,
  searchLyricsManual,
  setManualLyricsChoice,
  type LyricsData,
  type ManualLyricsChoice,
} from '../lib/api';
import { stripTrackNoise } from '../lib/lyrics-match';
import { parseLrcFile } from '../lib/lrc-file';
import { wordProgress } from '../lib/lyric-words';
import { LYRICS_OFFSET_STEP, nudgeLyricsOffset, setLyricsOffset, useLyricsOffset } from '../state/lyrics-offset';
import { currentTrack, onFrame, player, seek, toggle } from '../state/player';
import { cancelTranscription, cancelWhisperDownload, transcribeMoreAccurately, transcribeTrack, whisper } from '../state/whisper';
import { useStore } from '../lib/util';
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

function SyncedLyrics({
  lines,
  variant,
  activeSurface = true,
  offset = 0,
}: {
  lines: LyricLine[];
  variant: 'panel' | 'imm';
  activeSurface?: boolean;
  /** Seconds; positive = lines appear later. */
  offset?: number;
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
  const wordEls = useRef<{ i: number; els: HTMLElement[]; last: number[] }>({ i: -1, els: [], last: [] });
  const wp = useRef<number[]>([]);
  const touchY = useRef(0);
  const leadGap = variant === 'panel' && !!lines[0]?.gap;
  const firstText = leadGap ? Math.max(1, lines.findIndex((l) => !l.gap)) : 0;
  const intro = leadGap && active < firstText;

  useEffect(() => {
    if (!activeSurface) return;
    return onFrame((_visualTime, _dur, realTime) => {
      const time = realTime - offset;
      const i = findLine(lines, time + 0.12);
      if (i !== activeRef.current) {
        activeRef.current = i;
        setActive(i);
      }
      if (i >= 0 && lines[i].words) {
        // Karaoke: fill each word by its own timing.
        const el = refs.current[i];
        if (el) {
          if (wordEls.current.i !== i) wordEls.current = { i, els: Array.from(el.querySelectorAll<HTMLElement>('.lyric-word')), last: [] };
          const { els, last } = wordEls.current;
          wordProgress(lines[i].words!, time, wp.current);
          for (let k = 0; k < els.length; k++) {
            const p = wp.current[k] ?? 0;
            if (Math.abs(p - (last[k] ?? -1)) >= 0.004) {
              last[k] = p;
              els[k].style.setProperty('--wp', p.toFixed(3));
            }
          }
        }
      } else if (i >= 0) {
        const L = lines[i];
        const end = Math.min(lines[i + 1]?.t ?? L.t + 6, L.t + (L.gap ? 60 : 7));
        // Пишем каждый кадр rAF (на 120 Гц — 120 раз/с) для максимальной плавности заливки;
        // порог 0.002 только отсеивает лишние записи, когда время не сдвинулось.
        const p = clamp((time - L.t) / Math.max(0.4, end - L.t), 0, 1);
        if (i !== lpRef.current.i || Math.abs(p - lpRef.current.p) >= 0.002) {
          lpRef.current = { i, p };
          refs.current[i]?.style.setProperty('--lp', p.toFixed(4));
        }
      }
    });
  }, [lines, activeSurface, offset]);

  useLayoutEffect(() => {
    if (!activeSurface) return;
    const el = box.current!;
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
    const el = refs.current[intro ? firstText : Math.max(active, 0)];
    if (!el || !box.current) return;
    if (intro) {
      setY(el.offsetTop);
      return;
    }
    const anchor = variant === 'imm' ? 0.4 : 0.3;
    setY(el.offsetTop + el.offsetHeight / 2 - box.current.clientHeight * anchor);
  }, [active, h, variant, lines, intro, firstText, activeSurface]);

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
                seek(Math.max(0, l.t + offset));
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
              ) : l.words ? (
                <span className="lyric-text" data-words="">
                  {l.words.map((w, k) => (
                    <span key={k} className="lyric-word">
                      {w.text}
                    </span>
                  ))}
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

/** Timing shift and "load my own .lrc" controls, shown inside the lyrics search popup. */
function LyricsTools({ track, compact, onLoaded }: { track: Track; compact?: boolean; onLoaded: () => void }) {
  const offset = useLyricsOffset(track.id);
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState(false);
  const shown = `${offset > 0 ? '+' : ''}${offset.toFixed(2)} ${t('secUnit')}`;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(false);
    const rec = parseLrcFile(await file.text(), { title: track.title, artist: track.artist });
    if (!rec) {
      setError(true);
      return;
    }
    setManualLyricsChoice(track.id, {
      id: -Date.now(),
      trackName: rec.trackName,
      artistName: rec.artistName,
      albumName: rec.albumName,
      duration: track.fullDuration ?? track.duration,
      syncedLyrics: rec.syncedLyrics,
      plainLyrics: rec.plainLyrics,
    });
    setLyricsOffset(track.id, rec.offsetSec);
    onLoaded();
  };

  return (
    <div className={cx('flex flex-wrap items-center gap-2', compact ? 'mt-2 text-[11px]' : 'mt-3 text-xs')}>
      <div className="flex items-center gap-1 rounded-full bg-on-surface/8 px-1 py-0.5" title={t('lyricsOffsetHint')}>
        <IconButton icon="remove" label={t('lyricsEarlier')} size="sm" tip={false} onClick={() => nudgeLyricsOffset(track.id, -LYRICS_OFFSET_STEP)} />
        <button
          type="button"
          className={cx('min-w-[64px] text-center font-semibold tabular-nums', offset ? 'text-primary' : 'text-on-surface-variant')}
          onClick={() => setLyricsOffset(track.id, 0)}
          aria-label={t('lyricsOffsetReset')}
        >
          {shown}
        </button>
        <IconButton icon="add" label={t('lyricsLater')} size="sm" tip={false} onClick={() => nudgeLyricsOffset(track.id, LYRICS_OFFSET_STEP)} />
      </div>
      <button
        type="button"
        data-ripple
        className="sl inline-flex items-center gap-1.5 rounded-full bg-on-surface/8 px-3 py-1.5 font-semibold text-on-surface-variant transition hover:bg-on-surface/14 hover:text-on-surface"
        onClick={() => fileRef.current?.click()}
      >
        <Icon name="upload_file" size={16} />
        <span>{t('lyricsLoadFile')}</span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".lrc,.txt,text/plain"
        className="hidden"
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {error && <span className="text-error">{t('lyricsFileEmpty')}</span>}
    </div>
  );
}

function defaultManualQuery(track: Track): string {
  const cleanTitle = stripTrackNoise(track.title);
  if (/\s[-–—]\s/.test(cleanTitle)) return cleanTitle;
  return `${track.artist} - ${cleanTitle || track.title}`;
}

function WhisperLyricsActions({
  compact,
  busy,
  mediumInstalled,
  mediumSizeMb,
  onDelete,
  onRetry,
}: {
  compact: boolean;
  busy: boolean;
  mediumInstalled: boolean;
  mediumSizeMb: number;
  onDelete: () => void;
  onRetry: () => void;
}) {
  const downloading = useStore(whisper, (state) => state.downloading);
  const stage = useStore(whisper, (state) => state.stage);
  const progress = downloading?.total ? Math.min(100, Math.round((downloading.received / downloading.total) * 100)) : null;
  return (
    <div className={cx('rounded-2xl bg-primary/8 ring-1 ring-primary/15', compact ? 'mt-2 p-2' : 'mt-3 p-3')}>
      <div className="flex items-center gap-2 text-xs font-semibold text-on-surface">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-xl bg-primary/14 text-primary">
          <Icon name="auto_awesome" size={16} />
        </span>
        <span className="min-w-0 flex-1">{t('whisperGeneratedLyrics')}</span>
      </div>
      <p className={cx('text-on-surface-variant', compact ? 'mt-1 text-[10px]' : 'mt-1.5 text-[11px]')}>
        {t('whisperRetryHint')}
      </p>
      {(downloading || busy) && (
        <div className={cx('mt-2 rounded-xl bg-on-surface/6 p-2.5', compact ? 'text-[10px]' : 'text-xs')}>
          <div className="flex items-center justify-between gap-2 text-on-surface-variant">
            <span className="min-w-0 truncate">
              {downloading ? t('whisperDownloadingModel', { pct: progress ?? '…' }) : stage === 'transcribing' ? t('whisperRunning') : t('whisperPreparing')}
            </span>
            {downloading && progress !== null && <span className="shrink-0 tabular-nums">{progress}%</span>}
          </div>
          {downloading && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-on-surface/10" role="progressbar" aria-label={t('whisperDownloadProgress')} aria-valuenow={progress ?? undefined} aria-valuemin={0} aria-valuemax={100}>
              <div className={cx('h-full rounded-full bg-primary transition-[width] duration-200', progress === null && 'whisper-progress-indeterminate')} style={progress === null ? undefined : { width: `${progress}%` }} />
            </div>
          )}
          {downloading ? (
            <button type="button" className="mt-2 text-[11px] font-semibold text-on-surface-variant hover:text-on-surface" onClick={() => void cancelWhisperDownload()}>{t('cancel')}</button>
          ) : busy ? <button type="button" className="mt-2 text-[11px] font-semibold text-on-surface-variant hover:text-on-surface" onClick={cancelTranscription}>{t('cancel')}</button> : null}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-ripple
          disabled={busy}
          className="sl inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-[11px] font-semibold text-on-primary transition hover:brightness-110 disabled:opacity-55"
          onClick={onRetry}
        >
          {busy ? <Loader size={14} /> : <Icon name="auto_awesome" size={15} />}
          {busy ? (downloading?.model === 'medium' ? t('whisperDownloadingModel', { pct: progress ?? '…' }) : stage === 'transcribing' ? t('whisperRunning') : t('whisperPreparing')) : t(mediumInstalled ? 'whisperRetryBest' : 'whisperRetryBestDownload', { mb: mediumSizeMb })}
        </button>
        <button
          type="button"
          disabled={busy}
          className="sl inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[11px] font-semibold text-on-surface-variant transition hover:bg-error/10 hover:text-error disabled:opacity-45"
          onClick={onDelete}
        >
          <Icon name="delete" size={15} />
          {t('whisperDeleteGenerated')}
        </button>
      </div>
    </div>
  );
}

function WhisperRecognitionControl({ track, compact = false }: { track: Track; compact?: boolean }) {
  const busy = useStore(whisper, (state) => state.activeTrack === track.id);
  const stage = useStore(whisper, (state) => state.stage);
  const downloading = useStore(whisper, (state) => state.downloading);
  const selectedModel = useStore(whisper, (state) => state.model);
  const model = useStore(whisper, (state) => state.models.find((item) => item.id === state.model));
  const error = useStore(whisper, (state) => state.error);
  const progress = downloading?.total ? Math.min(100, Math.round((downloading.received / downloading.total) * 100)) : null;
  return (
    <div className={cx('rounded-2xl bg-on-surface/5', compact ? 'mt-2 p-2' : 'mt-3 p-3')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-xs font-semibold text-on-surface">{t('whisperTryGenerated')}</span>
        {busy ? (
          <button type="button" data-ripple className="sl inline-flex items-center gap-1.5 rounded-full bg-error/10 px-3 py-1.5 text-[11px] font-semibold text-error" onClick={downloading ? () => void cancelWhisperDownload() : cancelTranscription}>{t('cancel')}</button>
        ) : (
          <button type="button" data-ripple disabled={!!downloading} className="sl inline-flex items-center gap-1.5 rounded-full bg-primary/18 px-3 py-1.5 text-[11px] font-semibold text-primary transition hover:bg-primary/26 disabled:opacity-55" onClick={() => void transcribeTrack(track)}>
            <Icon name="auto_awesome" size={14} />{t('whisperRecognizeWithModel', { model: selectedModel })}
          </button>
        )}
      </div>
      {model && !model.installed && !busy && !downloading && <p className="mt-1 text-[10px] text-on-surface-variant">{t('whisperModelDownloadHint', { mb: model.sizeMb })}</p>}
      {(busy || downloading) && (
        <div className="mt-2 rounded-xl bg-on-surface/6 p-2.5">
          <div className="flex items-center justify-between gap-2 text-[11px] text-on-surface-variant">
            <span>{downloading ? t('whisperDownloadingModel', { pct: progress ?? '…' }) : stage === 'transcribing' ? t('whisperRunning') : t('whisperPreparing')}</span>
            {downloading && progress !== null && <span className="tabular-nums">{progress}%</span>}
          </div>
          {downloading && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-on-surface/10" role="progressbar" aria-label={t('whisperDownloadProgress')} aria-valuenow={progress ?? undefined} aria-valuemin={0} aria-valuemax={100}>
            <div className={cx('h-full rounded-full bg-primary transition-[width] duration-200', progress === null && 'whisper-progress-indeterminate')} style={progress === null ? undefined : { width: `${progress}%` }} />
          </div>}
        </div>
      )}
      {error && <p className="mt-2 text-[11px] text-error">{error}</p>}
    </div>
  );
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
  const [retrying, setRetrying] = useState(false);
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
        if (br) {
          const by = Math.max(0, br.top - (ir.top + topPx));
          const bx = Math.max(0, ir.right - 20 - br.right);
          // Возвращаем прежний объект при неизменных значениях — иначе новый объект
          // каждый кадр width-анимации панели даёт ре-рендер каждый кадр.
          setOrigin((o) => (o.by === by && o.bx === bx ? o : { by, bx }));
        }
      } else {
        setTop(0);
        const br = btnRef.current?.getBoundingClientRect();
        if (br) {
          const by = Math.max(0, br.top - ir.top);
          const bx = Math.max(0, ir.right - br.right);
          setOrigin((o) => (o.by === by && o.bx === bx ? o : { by, bx }));
        }
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
  const hasWhisperLyrics = hasWhisperLyricsChoice(track.id);
  const recognitionActive = useStore(whisper, (state) => state.activeTrack === track.id);
  const mediumModel = useStore(whisper, (state) => state.models.find((model) => model.id === 'medium'));
  const wrapPortal = (node: ReactNode) => (host ? createPortal(node, host) : node);
  const isImm = variant === 'imm';
  const removeGeneratedLyrics = () => {
    setManualLyricsChoice(track.id, null);
    onSelect();
  };
  const retryWithBetterModel = async () => {
    if (retrying || recognitionActive) return;
    setRetrying(true);
    try {
      if (await transcribeMoreAccurately(track)) {
        onSelect();
      }
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div ref={wrapRef} className=" lyrics-picker-trigger pointer-events-none absolute inset-x-2.5 bottom-2.5 top-2.5 z-20 flex flex-col items-end gap-2">
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

              {hasCustom && !hasWhisperLyrics && (
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

            <LyricsTools track={track} onLoaded={() => (setOpen(false), onSelect())} />

            <WhisperRecognitionControl track={track} />

            {hasWhisperLyrics && (
              <WhisperLyricsActions
                compact={false}
                busy={recognitionActive || retrying}
                mediumInstalled={!!mediumModel?.installed}
                mediumSizeMb={mediumModel?.sizeMb ?? 539}
                onDelete={removeGeneratedLyrics}
                onRetry={() => void retryWithBetterModel()}
              />
            )}

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
                        setManualLyricsChoice(track.id, item);
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
                {hasCustom && !hasWhisperLyrics && (
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

            <LyricsTools track={track} compact onLoaded={() => (setOpen(false), onSelect())} />

            <WhisperRecognitionControl track={track} compact />

            {hasWhisperLyrics && (
              <WhisperLyricsActions
                compact
                busy={recognitionActive || retrying}
                mediumInstalled={!!mediumModel?.installed}
                mediumSizeMb={mediumModel?.sizeMb ?? 539}
                onDelete={removeGeneratedLyrics}
                onRetry={() => void retryWithBetterModel()}
              />
            )}

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
        )
      )}
    </div>
  );
}

/** "No lyrics" helper: recognize them locally, or point to the settings to get a model. */
function RecognizeLyrics({ track }: { track: Track }) {
  const busy = useStore(whisper, (s) => s.activeTrack === track.id);
  const ready = useStore(whisper, (s) => s.models.some((m) => m.id === s.model && m.installed));
  const error = useStore(whisper, (s) => s.error);
  const dl = useStore(whisper, (s) => s.downloading);
  const stage = useStore(whisper, (s) => s.stage);
  const smallMb = useStore(whisper, (s) => s.models.find((m) => m.id === s.model)?.sizeMb ?? 190);
  if (dl && busy) {
    const pct = dl.total ? Math.min(100, Math.round((dl.received / dl.total) * 100)) : null;
    return (
      <div className="mt-2 w-full max-w-[300px] rounded-2xl bg-on-surface/6 p-3 text-left">
        <div className="flex items-center justify-between gap-2 text-sm text-on-surface-variant">
          <span>{t('whisperDownloadingModel', { pct: pct ?? '…' })}</span>
          {pct !== null && <span className="tabular-nums">{pct}%</span>}
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-on-surface/10" role="progressbar" aria-label={t('whisperDownloadProgress')} aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
          <div className={cx('h-full rounded-full bg-primary transition-[width] duration-200', pct === null && 'whisper-progress-indeterminate')} style={pct === null ? undefined : { width: `${pct}%` }} />
        </div>
        <button type="button" className="mt-2 text-xs font-semibold text-on-surface-variant hover:text-on-surface" onClick={() => void cancelWhisperDownload()}>{t('cancel')}</button>
      </div>
    );
  }
  if (!ready) {
    // One click starts the full flow: download the selected model, then immediately recognize.
    return (
      <div className="mt-1 flex flex-col items-center gap-1.5">
        <button
          type="button"
          data-ripple
          className="sl inline-flex items-center gap-2 rounded-full bg-primary/16 px-4 py-2 text-sm font-semibold text-primary transition hover:bg-primary/24"
          onClick={() => void transcribeTrack(track)}
        >
          <Icon name="auto_awesome" size={18} />
          {t('whisperGetModel', { mb: smallMb })}
        </button>
        {error && <span className="max-w-[260px] text-center text-xs text-error">{error}</span>}
      </div>
    );
  }
  if (busy) {
    return (
      <div className="mt-2 flex max-w-[300px] flex-col items-center gap-2 text-sm text-on-surface-variant">
        <span className="flex items-center gap-2"><Loader size={18} />{stage === 'transcribing' ? t('whisperRunning') : t('whisperPreparing')}</span>
        <button type="button" className="text-xs font-semibold text-on-surface-variant hover:text-on-surface" onClick={cancelTranscription}>{t('cancel')}</button>
      </div>
    );
  }
  return (
    <div className="mt-1 flex flex-col items-center gap-1.5">
      <button
        type="button"
        data-ripple
        className="sl inline-flex items-center gap-2 rounded-full bg-primary/16 px-4 py-2 text-sm font-semibold text-primary transition hover:bg-primary/24"
        onClick={() => void transcribeTrack(track)}
      >
        <Icon name="auto_awesome" size={18} />
        {t('whisperRecognize')}
      </button>
      {error && <span className="max-w-[260px] text-center text-xs text-error">{error}</span>}
    </div>
  );
}

export function Lyrics({ track, variant, active = true }: { track: Track | null; variant: 'panel' | 'imm'; active?: boolean }) {
  const [rev, setRev] = useState(0);
  const autoStartedTrack = useRef<string | null>(null);
  const st = useLyrics(track, rev);
  const offset = useLyricsOffset(track?.id ?? '');
  const completed = useStore(whisper, (s) => s.completed);
  const activeTrack = useStore(whisper, (s) => s.activeTrack);
  const auto = useStore(whisper, (s) => s.auto);
  const modelReady = useStore(whisper, (s) => s.models.some((m) => m.id === s.model && m.installed));

  // Recognition finished for this track (from any view): reload to show the stored lyrics.
  useEffect(() => {
    if (track && completed.startsWith(`${track.id}:`)) setRev((r) => r + 1);
  }, [completed, track]);

  // Start as soon as lyric lookup confirms there are no lyrics for the current track.
  const noLyrics = st.status === 'none' && !st.instrumental;
  useEffect(() => {
    if (!track || !noLyrics || !auto || !modelReady) return;
    if (activeTrack === track.id) {
      autoStartedTrack.current = track.id;
      return;
    }
    if (autoStartedTrack.current === track.id || currentTrack()?.id !== track.id) return;
    autoStartedTrack.current = track.id;
    void transcribeTrack(track);
  }, [track, noLyrics, auto, modelReady, activeTrack]);

  if (!track) return null;

  return (
    <div className="lyrics-stage relative h-full w-full">
      <ManualLyricsPicker track={track} variant={variant} onSelect={() => setRev((r) => r + 1)} />
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
          {activeTrack === track.id && !st.instrumental ? (
            <>
              <Loader size={64} />
              <span>{t('whisperRunning')}</span>
            </>
          ) : (
            <>
              <Shape n={7} amp={0.1} className="spin-slow h-20 w-20 text-secondary-container">
                <Icon name={st.instrumental ? 'piano' : 'lyrics'} size={34} className="text-on-secondary-container" />
              </Shape>
              <span>{st.instrumental ? t('instrumental') : t('noLyrics')}</span>
              {!st.instrumental && <RecognizeLyrics track={track} />}
            </>
          )}
        </div>
      ) : st.status === 'plain' ? (
        <PlainLyrics key={`${track.id}:${rev}`} lines={st.lines} preview={st.preview} variant={variant} />
      ) : (
        <SyncedLyrics key={`${track.id}:${rev}`} lines={st.lines} variant={variant} activeSurface={active} offset={offset} />
      )}
    </div>
  );
}
