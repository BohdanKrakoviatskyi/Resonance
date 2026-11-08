import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Icon, type IconName } from './Icon';
import { Shape } from './ui';
import { cx } from '../lib/util';
import { getTrack } from '../state/library';
import type { Playlist } from '../types';

const loadedCoverUrls = new Set<string>();

export function Cover({ src, className, style, icon = 'music_note' }: { src?: string; className?: string; style?: CSSProperties; icon?: IconName }) {
  const [okSrc, setOk] = useState<string | null>(() => (src && loadedCoverUrls.has(src) ? src : null));
  const [errSrc, setErr] = useState<string | null>(null);
  return (
    <div className={cx('cover', className)} style={style}>
      <Icon name={icon} className="cover-ph" />
      {src && errSrc !== src && (
        <img
          key={src}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className={okSrc === src || loadedCoverUrls.has(src) ? 'ok' : ''}
          ref={(el) => {
            if (el?.complete && el.naturalWidth) {
              loadedCoverUrls.add(src);
              if (okSrc !== src) setOk(src);
            }
          }}
          onLoad={() => {
            loadedCoverUrls.add(src);
            setOk(src);
          }}
          onError={() => setErr(src)}
        />
      )}
    </div>
  );
}

/** Artwork that cross-fades between tracks (used for now-playing surfaces + view-transition morphs). */
export function ArtCover({ src, className, vt, onClick, label }: { src?: string; className?: string; vt?: string; onClick?: () => void; label?: string }) {
  const [layers, setLayers] = useState<{ src: string; ok: boolean }[]>(() => (src ? [{ src, ok: false }] : []));
  const timer = useRef(0);
  useEffect(() => {
    if (!src) {
      setLayers([]);
      return;
    }
    setLayers((ls) => (ls.some((l) => l.src === src) ? ls : [...ls.slice(-1), { src, ok: false }]));
  }, [src]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const loaded = (s: string) => {
    setLayers((ls) => ls.map((x) => (x.src === s ? { ...x, ok: true } : x)));
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setLayers((ls) => {
        const k = ls.findIndex((x) => x.src === s);
        return k > 0 ? ls.slice(k) : ls;
      });
    }, 650);
  };
  return (
    <div
      className={cx('cover', className)}
      style={{ viewTransitionName: vt } as CSSProperties}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      aria-label={label}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick()) : undefined}
    >
      <Icon name="music_note" className="cover-ph" size={40} />
      {layers.map((l) => (
        <img
          key={l.src}
          src={l.src}
          alt=""
          decoding="async"
          draggable={false}
          className={l.ok ? 'ok' : ''}
          ref={(el) => {
            if (el?.complete && el.naturalWidth && !l.ok) loaded(l.src);
          }}
          onLoad={() => loaded(l.src)}
        />
      ))}
    </div>
  );
}

export function PlaylistCover({ p, className, style }: { p: Playlist; className?: string; style?: CSSProperties }) {
  const covers = useMemo(() => {
    const out: string[] = [];
    for (const id of p.ids) {
      const c = getTrack(id)?.thumb;
      if (c && !out.includes(c)) out.push(c);
      if (out.length === 4) break;
    }
    return out;
  }, [p.ids]);
  if (p.artworkUrl) return <Cover src={p.artworkUrl} className={className} style={style} />;
  if (covers.length >= 4)
    return (
      <div className={cx('cover mosaic', className)} style={style}>
        {covers.map((c) => (
          <img key={c} src={c} alt="" loading="lazy" decoding="async" draggable={false} />
        ))}
      </div>
    );
  if (covers.length) return <Cover src={covers[0]} className={className} style={style} />;
  return (
    <div className={cx('cover', className)} style={{ background: 'var(--md-tertiary-container)', color: 'var(--md-on-tertiary-container)', ...style }}>
      <Icon name="queue_music" />
    </div>
  );
}

export function FavCover({ className, size }: { className?: string; size: number }) {
  return (
    <div className={cx('cover fav-cover', className)}>
      <Shape n={10} amp={0.06} className="text-on-primary" style={{ width: size * 0.62, height: size * 0.62 }}>
        <Icon name="favorite" fill size={size * 0.3} className="text-primary" />
      </Shape>
    </div>
  );
}

export function Eq({ on, className }: { on: boolean; className?: string }) {
  return (
    <span className={cx('eq', on && 'on', className)} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
