import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from '../lib/util';
import { theme, type BgSpec } from '../state/theme';
import { appearance } from '../state/appearance';

/** After this long without input, an animated background is frozen to a still frame. */
const BG_IDLE_MS = 5 * 60_000;
const isAnimatedImage = (src: string) => src.startsWith('data:image/gif');

/**
 * Tracks whether the window is "live" (visible and used recently) and bumps `epoch` every time it
 * becomes live again.
 *
 * Why: an animated GIF background (it can be 10+ MB) re-rasterises a scaled, blurred, GPU-promoted
 * layer on every frame. Left running for hours with nobody at the keyboard, WebView2 can drop that
 * layer and the window ends up with a blank white rectangle. Idle/hidden windows therefore show a
 * still frame, and the image element is recreated on return, which also heals a layer that was lost.
 */
function useBackgroundActivity() {
  const [active, setActive] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const lastInput = useRef(Date.now());
  const wasActive = useRef(true);

  useEffect(() => {
    const evaluate = () => {
      const live = !document.hidden && Date.now() - lastInput.current < BG_IDLE_MS;
      if (live === wasActive.current) return;
      wasActive.current = live;
      setActive(live);
      if (live) setEpoch((e) => e + 1);
    };
    const touch = () => {
      lastInput.current = Date.now();
      if (!wasActive.current) evaluate();
    };
    const opts = { passive: true } as const;
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    events.forEach((name) => window.addEventListener(name, touch, opts));
    window.addEventListener('focus', touch);
    const onVisibility = () => (document.hidden ? evaluate() : touch());
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(evaluate, 15_000);
    return () => {
      events.forEach((name) => window.removeEventListener(name, touch));
      window.removeEventListener('focus', touch);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(timer);
    };
  }, []);

  return { active, epoch };
}

/** One still frame of an (animated) image as an object URL; built only while `enabled`. */
function useStillFrame(src: string, enabled: boolean): string | null {
  const [frame, setFrame] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let url: string | null = null;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const scale = Math.min(1, 1920 / Math.max(img.naturalWidth, img.naturalHeight, 1));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          if (!blob || cancelled) return;
          url = URL.createObjectURL(blob);
          setFrame(url);
        },
        'image/jpeg',
        0.92,
      );
    };
    img.src = src;
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setFrame(null);
    };
  }, [src, enabled]);
  return frame;
}

function Layer({ spec, metallic, isTop, onDone, live, epoch }: { spec: BgSpec; metallic: boolean; isTop: boolean; onDone: () => void; live: boolean; epoch: number }) {
  const [a, b, c, d] = spec.colors;
  const animated = spec.kind === 'image' && !!spec.image && isAnimatedImage(spec.image);
  const still = useStillFrame(spec.image ?? '', animated && !live);
  // Keep playing until the still frame is ready, so the switch never shows an empty background.
  const imageSrc = animated && !live && still ? still : spec.image;
  const useLiveVars = isTop && spec.key === 'mesh:color';
  const style: CSSProperties = { background: useLiveVars ? `var(--bg-base, ${spec.base})` : spec.base };
  return (
    <div className="bg-layer" style={style} onAnimationEnd={(e) => e.target === e.currentTarget && onDone()}>
      {spec.kind === 'mesh' && spec.colors.length >= 3 && (
        <div className="bg-ambient" data-metallic={metallic ? 'true' : 'false'}>
          <span className="bg-blob bg-blob-1" style={{ background: `radial-gradient(circle, ${useLiveVars ? `var(--bg-blob-1, ${a})` : a} 0%, transparent 70%)` }} />
          <span className="bg-blob bg-blob-2" style={{ background: `radial-gradient(circle, ${useLiveVars ? `var(--bg-blob-2, ${b || a})` : (b || a)} 0%, transparent 70%)` }} />
          <span className="bg-blob bg-blob-3" style={{ background: `radial-gradient(circle, ${useLiveVars ? `var(--bg-blob-3, ${c || b || a})` : (c || b || a)} 0%, transparent 70%)` }} />
          <span className="bg-blob bg-blob-4" style={{ background: `radial-gradient(circle, ${useLiveVars ? `var(--bg-blob-4, ${d || a})` : (d || a)} 0%, transparent 72%)` }} />
        </div>
      )}
      {spec.kind === 'image' && spec.image && (
        <img
          key={epoch}
          src={imageSrc}
          alt=""
          decoding="async"
          className="bg-image-drift"
          data-metallic={metallic ? 'true' : 'false'}
          style={{
            filter: metallic
              ? `blur(${Math.max(24, spec.blur)}px) saturate(0.22) contrast(1.15)`
              : spec.blur
                ? `blur(${spec.blur}px) saturate(1.35)`
                : undefined,
          }}
        />
      )}
      {/* Pre-warmed metallic + neon overlay: always mounted so switching Normal <-> Metallic never mounts/unmounts DOM nodes or flashes */}
      <div className="bg-metal-fx" data-active={metallic ? 'true' : 'false'}>
        <span className="bg-metallic-base" />
        <span className="bg-neon-glow bg-neon-glow-1" />
        <span className="bg-neon-glow bg-neon-glow-2" />
        <span className="bg-metallic-sheen" />
      </div>
      <span className="bg-vignette" />
      <div className="bg-dim" style={{ background: spec.dim }} />
    </div>
  );
}

/** Cross-fading background layer behind all glass panels. */
export function Background() {
  const bg = useStore(theme, (s) => s.bg);
  const metallic = useStore(appearance, (s) => s.metallic);
  const [layers, setLayers] = useState<BgSpec[]>(() => (bg ? [bg] : []));
  const { active, epoch } = useBackgroundActivity();
  useEffect(() => {
    if (!bg) return;
    setLayers((ls) => {
      const top = ls[ls.length - 1];
      if (top?.key === bg.key) return [...ls.slice(0, -1), bg];
      return [...ls.slice(-2), bg];
    });
  }, [bg]);
  return (
    <div className="bg-root" aria-hidden="true">
      {layers.map((l, i) => (
        <Layer key={l.key} spec={l} metallic={metallic} isTop={i === layers.length - 1} onDone={() => i === layers.length - 1 && setLayers((ls) => ls.slice(ls.indexOf(l)))} live={active} epoch={epoch} />
      ))}
    </div>
  );
}

/** SVG displacement filter that gives Liquid Glass its refraction (Chromium / Firefox). */
export function SvgDefs() {
  const r = useStore(appearance, (s) => s.refraction);
  return (
    <svg width="0" height="0" style={{ position: 'absolute', pointerEvents: 'none' }} aria-hidden="true" focusable="false">
      <filter id="lg-distort" filterUnits="objectBoundingBox" primitiveUnits="userSpaceOnUse" x="-15%" y="-15%" width="130%" height="130%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.005 0.008" numOctaves={2} seed={7} result="noise" />
        <feGaussianBlur in="noise" stdDeviation="3" result="soft" />
        <feDisplacementMap in="SourceGraphic" in2="soft" scale={Math.round(r * 0.45)} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}
