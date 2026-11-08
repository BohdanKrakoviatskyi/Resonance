import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { Loader, Shape, type Vars } from './ui';
import { clamp } from '../lib/util';
import { t } from '../lib/i18n';
import { getLyrics } from '../lib/api';
import { onFrame, player, seek, toggle } from '../state/player';
import type { LyricLine, Track } from '../types';

type LState =
  | { status: 'loading' }
  | { status: 'none'; instrumental?: boolean }
  | { status: 'synced'; lines: LyricLine[] }
  | { status: 'plain'; lines: string[]; preview?: boolean };

function useLyrics(track: Track | null): LState {
  const [st, setSt] = useState<{ id: string | null; v: LState }>({ id: null, v: { status: 'loading' } });
  useEffect(() => {
    if (!track) return;
    if (track.lyrics) {
      setSt({ id: track.id, v: { status: 'synced', lines: track.lyrics } });
      return;
    }
    let alive = true;
    getLyrics(track).then((d) => {
      if (!alive) return;
      const v: LState = !d
        ? { status: 'none' }
        : d.synced?.length
          ? { status: 'synced', lines: d.synced }
          : d.plain?.length
            ? { status: 'plain', lines: d.plain, preview: d.preview }
            : { status: 'none', instrumental: d.instrumental };
      setSt({ id: track.id, v });
    });
    return () => {
      alive = false;
    };
  }, [track]);
  if (track?.lyrics) return { status: 'synced', lines: track.lyrics };
  return st.id === track?.id ? st.v : { status: 'loading' };
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

export function Lyrics({ track, variant }: { track: Track | null; variant: 'panel' | 'imm' }) {
  const st = useLyrics(track);
  if (!track) return null;
  if (st.status === 'loading')
    return variant === 'panel' ? (
      <div className="lyrics-loading" role="progressbar" aria-label={t('lyricsLoading')} aria-busy="true">
        <span />
      </div>
    ) : (
      <div className="lyrics-state">
        <Loader size={64} />
        <span>{t('lyricsLoading')}</span>
      </div>
    );
  if (st.status === 'none')
    return (
      <div className="lyrics-state">
        <Shape n={7} amp={0.1} className="spin-slow h-20 w-20 text-secondary-container">
          <Icon name={st.instrumental ? 'piano' : 'lyrics'} size={34} className="text-on-secondary-container" />
        </Shape>
        <span>{st.instrumental ? t('instrumental') : t('noLyrics')}</span>
      </div>
    );
  if (st.status === 'plain') return <PlainLyrics key={track.id} lines={st.lines} preview={st.preview} variant={variant} />;
  return <SyncedLyrics key={track.id} lines={st.lines} variant={variant} />;
}
