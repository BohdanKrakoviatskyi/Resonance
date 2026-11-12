import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { hexFromArgb } from '@material/material-color-utilities';
import { Icon, type IconName } from '../components/Icon';
import { Button, IconButton, Segmented, Slider, type Vars } from '../components/ui';
import { clamp, cx, useStore } from '../lib/util';
import { t, type Key } from '../lib/i18n';
import { buildScheme, VARIANTS, type Role } from '../lib/color';
import { appearance, DEFAULTS, processImage, setBgImage, type Appearance as A, type GlassMode } from '../state/appearance';
import { endLiveColorPreview, markThemeDragging, previewLiveColor, recordThemeRerender, theme } from '../state/theme';
import { go, snack } from '../state/ui';

const set = (p: Partial<A>) => appearance.set(p);
const previewBgColor = (c: string) => previewLiveColor({ bgColor: c });
const commitBgColor = (c: string) => set({ bgColor: c });
const previewAccentColor = (c: string) => previewLiveColor({ accentColor: c });
const commitAccentColor = (c: string) => set({ accentColor: c });

const BG_SWATCHES = ['#25305e', '#1e3b34', '#3d1f3c', '#40261b', '#1d2f45', '#2f2a46', '#3a3a1c', '#16181d', '#4a1d2a', '#123c46', '#5b4a2e', '#2b2d42'];
const ACCENT_SWATCHES = ['#8c7cff', '#4f8cff', '#00b8a9', '#3ddc84', '#c6e33b', '#ffc542', '#ff8a3d', '#ff5470', '#e45fd6', '#a0a8b8'];

function Card({ icon, title, sub, children, i }: { icon: IconName; title: string; sub?: string; children: ReactNode; i: number }) {
  return (
    <section className="card anim-in" style={{ '--i': i } as Vars}>
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-[14px] bg-secondary-container text-on-secondary-container">
          <Icon name={icon} fill size={22} />
        </span>
        <div className="min-w-0">
          <h2 className="headline text-lg leading-tight">{title}</h2>
          {sub && <p className="text-sm text-on-surface-variant">{sub}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Row({ label, value, children }: { label: string; value?: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <div className="mb-1 flex justify-between text-sm font-semibold">
        <span>{label}</span>
        {value && <span className="tabular-nums text-on-surface-variant">{value}</span>}
      </div>
      {children}
    </div>
  );
}

function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const clean = hex.replace('#', '').trim();
  const n = parseInt(clean.length === 3 ? clean.replace(/(.)/g, '$1$1') : clean, 16);
  if (Number.isNaN(n)) return { h: 250, s: 0.65, v: 0.9 };
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  if (max !== min) {
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h *= 60;
  }
  return { h, s, v };
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const hn = ((h % 360) + 360) % 360;
  const sn = clamp(s, 0, 1);
  const vn = clamp(v, 0, 1);
  const c = vn * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = vn - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hn < 60) [r, g, b] = [c, x, 0];
  else if (hn < 120) [r, g, b] = [x, c, 0];
  else if (hn < 180) [r, g, b] = [0, c, x];
  else if (hn < 240) [r, g, b] = [0, x, c];
  else if (hn < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const h2 = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${h2(r)}${h2(g)}${h2(b)}`;
}

const Swatches = memo(function Swatches({
  colors,
  value,
  onChange,
  onLivePreview,
  label,
}: {
  colors: string[];
  value: string;
  onChange: (c: string) => void;
  onLivePreview?: (c: string) => void;
  label: string;
}) {
  recordThemeRerender();
  const [open, setOpen] = useState(false);
  const isPickingRef = useRef<'sv' | 'hue' | null>(null);
  const hsvRef = useRef<{ h: number; s: number; v: number }>(hexToHsv(value));
  const pickedHexRef = useRef<string>(value);
  const swatchRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const svAreaRef = useRef<HTMLDivElement>(null);
  const svThumbRef = useRef<HTMLSpanElement>(null);
  const hueTrackRef = useRef<HTMLDivElement>(null);
  const hueThumbRef = useRef<HTMLSpanElement>(null);
  const previewChipRef = useRef<HTMLSpanElement>(null);
  const hexInputRef = useRef<HTMLInputElement>(null);
  const rInputRef = useRef<HTMLInputElement>(null);
  const gInputRef = useRef<HTMLInputElement>(null);
  const bInputRef = useRef<HTMLInputElement>(null);
  const presetSet = useMemo(() => new Set(colors.map((c) => c.toLowerCase())), [colors]);

  const syncDomFromHsv = useCallback((hexOverride?: string) => {
    const { h, s, v } = hsvRef.current;
    const [r, g, b] = hsvToRgb(h, s, v);
    const hex = hexOverride || rgbToHex(r, g, b);
    pickedHexRef.current = hex;
    if (svAreaRef.current) {
      svAreaRef.current.style.backgroundColor = `hsl(${h.toFixed(1)} 100% 50%)`;
    }
    if (svThumbRef.current) {
      svThumbRef.current.style.left = `${(s * 100).toFixed(2)}%`;
      svThumbRef.current.style.top = `${((1 - v) * 100).toFixed(2)}%`;
      svThumbRef.current.style.backgroundColor = hex;
    }
    if (hueThumbRef.current) {
      hueThumbRef.current.style.left = `${((h / 360) * 100).toFixed(2)}%`;
      hueThumbRef.current.style.backgroundColor = `hsl(${h.toFixed(1)} 100% 50%)`;
    }
    if (previewChipRef.current) {
      previewChipRef.current.style.backgroundColor = hex;
    }
    if (hexInputRef.current && document.activeElement !== hexInputRef.current) {
      hexInputRef.current.value = hex.toUpperCase();
    }
    if (rInputRef.current && document.activeElement !== rInputRef.current) rInputRef.current.value = String(r);
    if (gInputRef.current && document.activeElement !== gInputRef.current) gInputRef.current.value = String(g);
    if (bInputRef.current && document.activeElement !== bInputRef.current) bInputRef.current.value = String(b);
    return hex;
  }, []);

  useEffect(() => {
    if (isPickingRef.current) return;
    const nextHsv = hexToHsv(value);
    // Preserve hue if new color is achromatic (s === 0 or v === 0)
    if (nextHsv.s > 0.001 && nextHsv.v > 0.001) hsvRef.current.h = nextHsv.h;
    hsvRef.current.s = nextHsv.s;
    hsvRef.current.v = nextHsv.v;
    pickedHexRef.current = value;
    const hex = value.toLowerCase();
    const isCustom = !presetSet.has(hex);
    if (swatchRef.current) {
      swatchRef.current.style.background = isCustom
        ? value
        : 'conic-gradient(from 0deg, #ff5470, #ffc542, #3ddc84, #4f8cff, #e45fd6, #ff5470)';
      if (isCustom) swatchRef.current.dataset.on = '';
      else delete swatchRef.current.dataset.on;
    }
    if (open) syncDomFromHsv(value);
  }, [value, presetSet, open, syncDomFromHsv]);

  const finishPick = useCallback(
    (commit = true) => {
      const wasPicking = isPickingRef.current !== null;
      isPickingRef.current = null;
      if (commit && (wasPicking || pickedHexRef.current.toLowerCase() !== value.toLowerCase())) {
        onChange(pickedHexRef.current);
      }
      endLiveColorPreview();
    },
    [onChange, value],
  );

  useEffect(() => {
    if (!open) return;
    syncDomFromHsv(pickedHexRef.current);
    const onDownOutside = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target) || swatchRef.current?.contains(target)) return;
      finishPick(true);
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        finishPick(true);
        setOpen(false);
      }
    };
    const onWinBlur = () => finishPick(true);
    window.addEventListener('pointerdown', onDownOutside, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onWinBlur);
    return () => {
      window.removeEventListener('pointerdown', onDownOutside, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onWinBlur);
    };
  }, [open, finishPick, syncDomFromHsv]);

  useEffect(
    () => () => {
      if (isPickingRef.current) {
        isPickingRef.current = null;
        onChange(pickedHexRef.current);
      }
      endLiveColorPreview();
    },
    [onChange],
  );

  const applyLiveHsv = useCallback(() => {
    const hex = syncDomFromHsv();
    if (swatchRef.current) {
      swatchRef.current.style.background = hex;
      swatchRef.current.dataset.on = '';
    }
    onLivePreview?.(hex);
  }, [onLivePreview, syncDomFromHsv]);

  const updateSvFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const el = svAreaRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      // Pure float HSV state — never round-tripped through HEX/RGB during drag!
      hsvRef.current.s = clamp((clientX - rect.left) / rect.width, 0, 1);
      hsvRef.current.v = clamp(1 - (clientY - rect.top) / rect.height, 0, 1);
      applyLiveHsv();
    },
    [applyLiveHsv],
  );

  const updateHueFromPointer = useCallback(
    (clientX: number) => {
      const el = hueTrackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      hsvRef.current.h = clamp(((clientX - rect.left) / rect.width) * 360, 0, 360);
      applyLiveHsv();
    },
    [applyLiveHsv],
  );

  const applyManualHex = (raw: string) => {
    const m = raw.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(m)) return;
    const hex = `#${m.toLowerCase()}`;
    const next = hexToHsv(hex);
    if (next.s > 0.001 && next.v > 0.001) hsvRef.current.h = next.h;
    hsvRef.current.s = next.s;
    hsvRef.current.v = next.v;
    syncDomFromHsv(hex);
    if (swatchRef.current) {
      swatchRef.current.style.background = hex;
      swatchRef.current.dataset.on = '';
    }
    onChange(hex);
    endLiveColorPreview();
  };

  const applyManualRgb = () => {
    const r = clamp( parseInt(rInputRef.current?.value || '0', 10) || 0, 0, 255);
    const g = clamp( parseInt(gInputRef.current?.value || '0', 10) || 0, 0, 255);
    const b = clamp( parseInt(bInputRef.current?.value || '0', 10) || 0, 0, 255);
    const hex = rgbToHex(r, g, b);
    const next = hexToHsv(hex);
    if (next.s > 0.001 && next.v > 0.001) hsvRef.current.h = next.h;
    hsvRef.current.s = next.s;
    hsvRef.current.v = next.v;
    syncDomFromHsv(hex);
    if (swatchRef.current) {
      swatchRef.current.style.background = hex;
      swatchRef.current.dataset.on = '';
    }
    onChange(hex);
    endLiveColorPreview();
  };

  const activeHex = value.toLowerCase();
  const custom = !presetSet.has(activeHex);
  return (
    <div className="relative flex flex-wrap gap-2.5">
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          className="swatch"
          style={{ background: c }}
          data-on={activeHex === c ? '' : undefined}
          aria-label={c}
          onClick={() => {
            isPickingRef.current = null;
            pickedHexRef.current = c;
            setOpen(false);
            endLiveColorPreview();
            onChange(c);
          }}
        >
          {activeHex === c && <Icon name="check" className="pop" />}
        </button>
      ))}
      <button
        ref={swatchRef}
        type="button"
        className="swatch cursor-pointer"
        data-on={custom ? '' : undefined}
        data-tip={label}
        aria-label={label}
        aria-expanded={open}
        style={{ background: custom ? value : 'conic-gradient(from 0deg, #ff5470, #ffc542, #3ddc84, #4f8cff, #e45fd6, #ff5470)' }}
        onClick={() => {
          if (open) {
            finishPick(true);
            setOpen(false);
          } else {
            setOpen(true);
          }
        }}
      >
        <Icon name="colorize" />
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={label}
          className="z-50 mt-1 w-[268px] rounded-[22px] border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-high)] p-3.5 shadow-2xl"
        >
          {/* 2D Saturation / Value plane (pure float HSV pointer capture) */}
          <div
            ref={svAreaRef}
            className="relative h-[148px] w-full cursor-crosshair touch-none select-none overflow-hidden rounded-[14px]"
            style={{
              backgroundColor: `hsl(${hsvRef.current.h.toFixed(1)} 100% 50%)`,
              backgroundImage:
                'linear-gradient(to top, #000 0%, transparent 100%), linear-gradient(to right, #fff 0%, transparent 100%)',
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              isPickingRef.current = 'sv';
              e.currentTarget.setPointerCapture(e.pointerId);
              updateSvFromPointer(e.clientX, e.clientY);
            }}
            onPointerMove={(e) => {
              if (isPickingRef.current !== 'sv') return;
              updateSvFromPointer(e.clientX, e.clientY);
            }}
            onPointerUp={(e) => {
              if (isPickingRef.current !== 'sv') return;
              if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId);
              }
              finishPick(true);
            }}
            onPointerCancel={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId);
              }
              finishPick(true);
            }}
          >
            <span
              ref={svThumbRef}
              className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_1px_4px_rgba(0,0,0,0.65)]"
            />
          </div>

          {/* Hue slider + live color preview chip */}
          <div className="mt-3 flex items-center gap-2.5">
            <span
              ref={previewChipRef}
              className="h-7 w-7 shrink-0 rounded-full border border-white/20 shadow-inner"
            />
            <div
              ref={hueTrackRef}
              className="relative h-3.5 flex-1 cursor-pointer touch-none select-none rounded-full"
              style={{
                background:
                  'linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)',
              }}
              onPointerDown={(e) => {
                e.preventDefault();
                isPickingRef.current = 'hue';
                e.currentTarget.setPointerCapture(e.pointerId);
                updateHueFromPointer(e.clientX);
              }}
              onPointerMove={(e) => {
                if (isPickingRef.current !== 'hue') return;
                updateHueFromPointer(e.clientX);
              }}
              onPointerUp={(e) => {
                if (isPickingRef.current !== 'hue') return;
                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                }
                finishPick(true);
              }}
              onPointerCancel={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                }
                finishPick(true);
              }}
            >
              <span
                ref={hueThumbRef}
                className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_1px_4px_rgba(0,0,0,0.65)]"
              />
            </div>
          </div>

          {/* HEX + R, G, B inputs */}
          <div className="mt-3 grid grid-cols-[1.35fr_1fr_1fr_1fr] gap-1.5 text-[11px] font-semibold">
            <label className="flex flex-col gap-0.5 text-on-surface-variant">
              <span>HEX</span>
              <input
                ref={hexInputRef}
                type="text"
                maxLength={7}
                defaultValue={value.toUpperCase()}
                onChange={(e) => applyManualHex(e.target.value)}
                onBlur={(e) => applyManualHex(e.target.value)}
                className="rounded-lg bg-[var(--md-surface-container-lowest)] px-2 py-1 font-mono text-xs text-on-surface outline-none ring-1 ring-white/10 focus:ring-[var(--md-primary)]"
              />
            </label>
            <label className="flex flex-col gap-0.5 text-on-surface-variant">
              <span>R</span>
              <input
                ref={rInputRef}
                type="number"
                min={0}
                max={255}
                onChange={applyManualRgb}
                className="rounded-lg bg-[var(--md-surface-container-lowest)] px-1.5 py-1 font-mono text-xs text-on-surface outline-none ring-1 ring-white/10 focus:ring-[var(--md-primary)]"
              />
            </label>
            <label className="flex flex-col gap-0.5 text-on-surface-variant">
              <span>G</span>
              <input
                ref={gInputRef}
                type="number"
                min={0}
                max={255}
                onChange={applyManualRgb}
                className="rounded-lg bg-[var(--md-surface-container-lowest)] px-1.5 py-1 font-mono text-xs text-on-surface outline-none ring-1 ring-white/10 focus:ring-[var(--md-primary)]"
              />
            </label>
            <label className="flex flex-col gap-0.5 text-on-surface-variant">
              <span>B</span>
              <input
                ref={bInputRef}
                type="number"
                min={0}
                max={255}
                onChange={applyManualRgb}
                className="rounded-lg bg-[var(--md-surface-container-lowest)] px-1.5 py-1 font-mono text-xs text-on-surface outline-none ring-1 ring-white/10 focus:ring-[var(--md-primary)]"
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
});

function GlassOption({ kind, on }: { kind: GlassMode; on: boolean }) {
  const selectGlass = () => {
    if (kind === 'liquid') {
      const cur = appearance.get();
      set({
        glass: 'liquid',
        ...(cur.refraction <= 0 ? { refraction: DEFAULTS.refraction } : {}),
      });
    } else {
      set({ glass: kind });
    }
  };
  return (
    <button type="button" data-ripple className="glass-opt sl" data-on={on ? '' : undefined} onClick={selectGlass} aria-pressed={on}>
      <div className="glass-scene">
        <span className="orb" style={{ width: 70, height: 70, left: '8%', top: '-10%', background: 'var(--md-primary)' }} />
        <span className="orb" style={{ width: 56, height: 56, right: '10%', bottom: '-14%', background: 'var(--md-tertiary)' }} />
        <span className="orb" style={{ width: 30, height: 30, right: '34%', top: '12%', background: 'var(--md-secondary)' }} />
        <div className={cx('glass-sample', `demo-${kind}`)}>
          <Icon name="music_note" fill className="text-on-surface" />
        </div>
      </div>
      <div className="px-1">
        <div className="flex items-center gap-1.5 font-bold">
          {t(kind)}
          {on && <Icon name="check" size={18} className="pop text-primary" />}
        </div>
        <div className="text-xs text-on-surface-variant">{t(`${kind}Desc` as Key)}</div>
      </div>
    </button>
  );
}

const SHOW: Role[] = ['primary', 'primaryContainer', 'secondary', 'secondaryContainer', 'tertiary', 'tertiaryContainer', 'surfaceContainerHigh', 'onSurface'];

export default function Appearance() {
  const a = useStore(appearance, (s) => s);
  const source = useStore(theme, (s) => s.source);
  const dark = useStore(theme, (s) => s.dark);
  const roles = useStore(theme, (s) => s.roles);
  const file = useRef<HTMLInputElement>(null);

  const previews = useMemo(
    () =>
      VARIANTS.map((v) => {
        const s = buildScheme(source, source, dark, v);
        return { v, c: [s.primary, s.secondary, s.tertiary].map(hexFromArgb) };
      }),
    [source, dark],
  );

  const onFile = async (f?: File) => {
    if (!f) return;
    try {
      const data = await processImage(f);
      if (!(await setBgImage(data))) snack(t('photoError'));
    } catch (error) {
      snack(error instanceof Error && error.message === 'photoTooLarge' ? t('photoTooLarge') : t('photoError'));
    }
  };

  return (
    <div className="page max-w-[980px]">
      <header className="anim-in mb-6 mt-2">
        <div className="mb-3 flex items-center gap-2">
          <IconButton icon="arrow_back" label={t('back')} variant="tonal" size="sm" onClick={() => go({ name: 'settings' })} />
          <span className="text-sm font-semibold text-on-surface-variant">{t('settings')}</span>
        </div>
        <h1 className="display text-[clamp(32px,5.5cqw,54px)]">{t('appearance')}</h1>
        <p className="mt-2 text-lg text-on-surface-variant">{t('appearanceSub')}</p>
      </header>

      <div className="grid gap-4">
        <Card icon="blur_on" title={t('glass')} i={1}>
          <div className="grid grid-cols-1 gap-3 @lg:grid-cols-3">
            {(['liquid', 'frosted', 'off'] as const).map((g) => (
              <GlassOption key={g} kind={g} on={a.glass === g} />
            ))}
          </div>
          <div className={cx('grid gap-x-6 @2xl:grid-cols-2', a.glass === 'off' && 'pointer-events-none opacity-40')} style={{ transition: 'opacity .3s' }}>
            <Row label={t('blur')} value={`${a.blur}%`}>
              <Slider value={a.blur} min={0} max={100} step={1} onChange={(v) => { markThemeDragging(); set({ blur: v }); }} label={t('blur')} disabled={a.glass === 'off'} />
            </Row>
            <Row label={t('tint')} value={`${a.opacity}%`}>
              <Slider value={a.opacity} min={0} max={90} step={1} onChange={(v) => { markThemeDragging(); set({ opacity: v }); }} label={t('tint')} disabled={a.glass === 'off'} />
            </Row>
            {a.glass === 'liquid' && (
              <Row label={t('refraction')} value={`${a.refraction}%`}>
                <Slider value={a.refraction} min={0} max={100} step={1} onChange={(v) => { markThemeDragging(); set({ refraction: v }); }} label={t('refraction')} />
              </Row>
            )}
          </div>
        </Card>

        <Card icon="wallpaper" title={t('background')} sub={a.bgMode === 'dynamic' ? t('dynamicHint') : undefined} i={2}>
          <Segmented
            value={a.bgMode}
            onChange={(v) => (v === 'image' && !a.bgImage ? file.current?.click() : set({ bgMode: v }))}
            options={[
              { value: 'dynamic', label: t('fromCover'), icon: 'auto_awesome' },
              { value: 'color', label: t('color'), icon: 'format_paint' },
              { value: 'image', label: t('photo'), icon: 'image' },
            ]}
          />
          <input
            ref={file}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <div key={a.bgMode} className="anim-in mt-4">
            {a.bgMode === 'dynamic' && (
              <Segmented
                size="sm"
                className="max-w-sm"
                value={a.bgStyle}
                onChange={(v) => set({ bgStyle: v })}
                options={[
                  { value: 'palette', label: t('bgPalette'), icon: 'water_drop' },
                  { value: 'artwork', label: t('bgArtwork'), icon: 'layers' },
                ]}
              />
            )}
            {a.bgMode === 'color' && (
              <Swatches
                colors={BG_SWATCHES}
                value={a.bgColor}
                onLivePreview={previewBgColor}
                onChange={commitBgColor}
                label={t('customColor')}
              />
            )}
            {a.bgMode === 'image' && (
              <div className="flex flex-wrap items-center gap-4">
                {a.bgImage && <img src={a.bgImage} alt="" className="h-24 w-40 rounded-[20px] object-cover shadow-lg" />}
                <div className="flex flex-wrap gap-2">
                  <Button variant="tonal" icon="upload" onClick={() => file.current?.click()}>
                    {a.bgImage ? t('changePhoto') : t('uploadPhoto')}
                  </Button>
                  {a.bgImage && (
                    <Button variant="outlined" icon="delete" onClick={() => { void setBgImage(null); }}>
                      {t('removePhoto')}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
          {(a.bgMode === 'image' || (a.bgMode === 'dynamic' && a.bgStyle === 'artwork')) && (
            <div className="grid gap-x-6 @2xl:grid-cols-2">
              <Row label={t('dim')} value={`${a.bgDim}%`}>
                <Slider value={a.bgDim} min={0} max={85} step={1} onChange={(v) => { markThemeDragging(); set({ bgDim: v }); }} label={t('dim')} />
              </Row>
              <Row label={t('bgBlur')} value={`${a.bgBlur}px`}>
                <Slider value={a.bgBlur} min={0} max={60} step={1} onChange={(v) => { markThemeDragging(); set({ bgBlur: v }); }} label={t('bgBlur')} />
              </Row>
            </div>
          )}
        </Card>

        <Card icon="palette" title={t('accent')} sub={a.accentMode === 'dynamic' ? t('dynamicHint') : undefined} i={3}>
          <Segmented
            value={a.accentMode}
            onChange={(v) => set({ accentMode: v })}
            options={[
              { value: 'dynamic', label: t('fromCover'), icon: 'auto_awesome' },
              { value: 'custom', label: t('custom'), icon: 'colorize' },
            ]}
          />
          {a.accentMode === 'custom' && (
            <div className="anim-in mt-4">
              <Swatches
                colors={ACCENT_SWATCHES}
                value={a.accentColor}
                onLivePreview={previewAccentColor}
                onChange={commitAccentColor}
                label={t('customColor')}
              />
            </div>
          )}
          <div className="mt-5 text-sm font-semibold">{t('currentScheme')}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {SHOW.map((r) => (
              <span
                key={r}
                className="h-9 min-w-9 flex-1 rounded-[12px] shadow-inner"
                style={{ background: `var(--md-${r.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}, ${roles[r]})`, transition: 'background-color .7s' }}
                title={r}
              />
            ))}
          </div>
        </Card>

        <Card
          icon="auto_awesome"
          title={t('colorStyle')}
          sub={a.metallic ? t('colorStyleMetallicHint') : undefined}
          i={4}
        >
          <div
            aria-disabled={a.metallic}
            className={cx(
              'grid grid-cols-2 gap-2.5 transition-opacity duration-300 @xl:grid-cols-4',
              a.metallic && 'pointer-events-none opacity-45 select-none',
            )}
          >
            {previews.map(({ v, c }) => (
              <button
                key={v}
                type="button"
                disabled={a.metallic}
                data-ripple
                className={cx(
                  'chip sl !h-auto min-w-0 justify-start !gap-2.5 !rounded-[18px] !px-2.5 !py-2.5',
                  !a.metallic && a.variant === v && '!rounded-[26px]',
                )}
                data-on={!a.metallic && a.variant === v ? '' : undefined}
                onClick={() => {
                  if (a.metallic) return;
                  set({ variant: v });
                }}
              >
                <span className="flex shrink-0 -space-x-2">
                  {c.map((x, k) => (
                    <span key={k} className="h-5 w-5 rounded-full ring-2 ring-[var(--md-surface-container-high)]" style={{ background: x }} />
                  ))}
                </span>
                <span className="min-w-0 truncate text-[13px] font-semibold">{t(v as Key)}</span>
              </button>
            ))}
          </div>
        </Card>

        <Card icon="layers" title={t('metallicMode')} sub={t('metallicModeDesc')} i={5}>
          <Segmented
            value={a.metallic ? 'on' : 'off'}
            onChange={(v) => set({ metallic: v === 'on' })}
            options={[
              { value: 'on', label: t('enabled'), icon: 'auto_awesome' },
              { value: 'off', label: t('disabled') },
            ]}
          />
          <div
            aria-disabled={!a.metallic}
            className={cx(
              'mt-4 rounded-2xl bg-sc-low/60 p-4 transition-opacity duration-300',
              !a.metallic && 'pointer-events-none opacity-45',
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm font-semibold">{t('neonAccent')}</span>
              <Segmented
                size="sm"
                className="w-48"
                value={a.metallic && a.metallicNeon ? 'on' : 'off'}
                onChange={(v) => {
                  if (!a.metallic) return;
                  set({ metallicNeon: v === 'on' });
                }}
                options={[
                  { value: 'on', label: t('enabled'), icon: 'bolt' },
                  { value: 'off', label: t('disabled') },
                ]}
              />
            </div>
            <div className={cx('transition-opacity duration-300', (!a.metallic || !a.metallicNeon) && 'pointer-events-none opacity-45')}>
              <Row label={t('neonIntensity')} value={`${a.metallicNeonIntensity}%`}>
                <Slider
                  value={a.metallicNeonIntensity}
                  min={10}
                  max={85}
                  step={1}
                  onChange={(v) => {
                    if (!a.metallic || !a.metallicNeon) return;
                    markThemeDragging();
                    set({ metallicNeonIntensity: v });
                  }}
                  label={t('neonIntensity')}
                  disabled={!a.metallic || !a.metallicNeon}
                />
              </Row>
            </div>
          </div>
        </Card>

        <div className="grid gap-4 @3xl:grid-cols-2">
          <Card icon="contrast" title={t('theme')} i={6}>
            <Segmented
              value={a.theme}
              onChange={(v) => set({ theme: v })}
              options={[
                { value: 'dark', label: t('dark'), icon: 'dark_mode' },
                { value: 'light', label: t('light'), icon: 'light_mode' },
                { value: 'system', label: t('system'), icon: 'brightness_auto' },
              ]}
            />
          </Card>
          <Card icon="animation" title={t('motion')} i={7}>
            <Segmented
              value={a.motion}
              onChange={(v) => set({ motion: v })}
              options={[
                { value: 'expressive', label: t('motionExpressive') },
                { value: 'standard', label: t('motionStandard') },
                { value: 'reduced', label: t('motionReduced') },
              ]}
            />
          </Card>
        </div>

        <div className="anim-in flex justify-center py-4" style={{ '--i': 8 } as Vars}>
          <Button
            variant="outlined"
            icon="refresh"
            onClick={() => {
              void setBgImage(null);
              set({ ...DEFAULTS, lang: a.lang });
            }}
          >
            {t('reset')}
          </Button>
        </div>
      </div>
    </div>
  );
}
