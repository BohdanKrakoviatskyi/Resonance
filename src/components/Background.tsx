import { useEffect, useState, type CSSProperties } from 'react';
import { useStore } from '../lib/util';
import { theme, type BgSpec } from '../state/theme';
import { appearance } from '../state/appearance';

function Layer({ spec, metallic, onDone }: { spec: BgSpec; metallic: boolean; onDone: () => void }) {
  const [a, b, c, d] = spec.colors;
  const style: CSSProperties = { background: spec.base };
  return (
    <div className="bg-layer" style={style} onAnimationEnd={(e) => e.target === e.currentTarget && onDone()}>
      {spec.kind === 'mesh' && spec.colors.length >= 3 && (
        <div className="bg-ambient" data-metallic={metallic ? 'true' : 'false'}>
          <span className="bg-blob bg-blob-1" style={{ background: `radial-gradient(circle, ${a} 0%, transparent 70%)` }} />
          <span className="bg-blob bg-blob-2" style={{ background: `radial-gradient(circle, ${b || a} 0%, transparent 70%)` }} />
          <span className="bg-blob bg-blob-3" style={{ background: `radial-gradient(circle, ${c || b || a} 0%, transparent 70%)` }} />
          <span className="bg-blob bg-blob-4" style={{ background: `radial-gradient(circle, ${d || a} 0%, transparent 72%)` }} />
        </div>
      )}
      {spec.kind === 'image' && spec.image && (
        <img
          src={spec.image}
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
        <Layer key={l.key} spec={l} metallic={metallic} onDone={() => i === layers.length - 1 && setLayers((ls) => ls.slice(ls.indexOf(l)))} />
      ))}
    </div>
  );
}

/** SVG displacement filter that gives Liquid Glass its refraction (Chromium / Firefox). */
export function SvgDefs() {
  const r = useStore(appearance, (s) => s.refraction);
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <filter id="lg-distort" x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.007 0.011" numOctaves={2} seed={7} result="noise" />
        <feGaussianBlur in="noise" stdDeviation="2.5" result="soft" />
        <feDisplacementMap in="SourceGraphic" in2="soft" scale={Math.round(r * 1.3)} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}
