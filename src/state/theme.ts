import { Hct, argbFromHex, hexFromArgb } from '@material/material-color-utilities';
import { createStore, clamp } from '../lib/util';
import { appearance } from './appearance';
import { player, currentTrack } from './player';
import { buildScheme, getPalette, schemeHex, applyRoles, registerColorProps, setColorTransition, fallbackColor, hct, type Role } from '../lib/color';
import { applyMotion } from '../lib/motion';

export interface BgSpec {
  key: string;
  kind: 'mesh' | 'image';
  base: string;
  colors: string[];
  image?: string;
  blur: number;
  dim: string;
}

export const theme = createStore({
  bg: null as BgSpec | null,
  dark: true,
  source: 0xff8c7cff,
  roles: {} as Record<Role, string>,
});

const mq = matchMedia('(prefers-color-scheme: dark)');
let seq = 0;
let lastKey = '';

function preload(src: string) {
  return new Promise<void>((res) => {
    const i = new Image();
    i.decoding = 'async';
    i.onload = i.onerror = () => res();
    i.src = src;
    setTimeout(res, 2500);
  });
}

function meshFromSource(src: number, dark: boolean) {
  const h = Hct.fromInt(src);
  const T = dark ? Math.min(h.tone, 30) : Math.max(h.tone, 84);
  const base = hexFromArgb(Hct.from(h.hue, h.chroma, T).toInt());
  const colors = ([[18, 1.1, 14], [-26, 1, -9], [42, 0.9, 8], [0, 1.25, 20]] as const).map(([dh, k, dt]) =>
    hct(h.hue + dh, h.chroma * k, clamp(T + (dark ? dt : -dt * 0.6), 2, 98)),
  );
  return { base, colors };
}

function applyMetallicAttr() {
  const a = appearance.get();
  const r = document.documentElement;
  if (a.metallic) r.dataset.metallic = 'true';
  else delete r.dataset.metallic;
}

function applyGlass() {
  const a = appearance.get();
  const r = document.documentElement;
  r.dataset.glass = a.glass;
  r.style.setProperty('--glass-blur', `${Math.round((a.blur / 100) * 36)}px`);
  r.style.setProperty('--glass-alpha', `${a.opacity}%`);
}

function applyLang() {
  const en = appearance.get().lang === 'en';
  const r = document.documentElement;
  r.lang = en ? 'en' : 'ru';
  r.style.setProperty('--font-ui', en
    ? "'Google Sans Flex', 'Roboto Flex', system-ui, sans-serif"
    : "'Roboto Flex', 'Google Sans Flex', system-ui, sans-serif");
}

/**
 * Computes a tone-clamped neon color from the active accent ARGB so very bright accents
 * (yellow, lime) keep rich neon chromaticity without blowing out text or controls.
 */
function applyNeonUniforms(accentArgb: number, dark: boolean) {
  const a = appearance.get();
  const h = Hct.fromInt(accentArgb);
  const neonChroma = Math.max(h.chroma, 62);
  const neonTone = dark ? clamp(h.tone, 58, 74) : clamp(h.tone, 42, 58);
  const neonHex = hct(h.hue, neonChroma, neonTone);
  const active = a.metallic && a.metallicNeon;
  const k = active ? clamp(a.metallicNeonIntensity / 100, 0, 1) : 0;

  const st = document.documentElement.style;
  st.setProperty('--metal-neon', neonHex);
  st.setProperty('--metal-neon-k', k.toFixed(3));
}

function buildMetallicRoles(accentArgb: number, baseRoles: Record<Role, string>, dark: boolean): Record<Role, string> {
  const a = appearance.get();
  const roles = { ...baseRoles };
  const h = Hct.fromInt(accentArgb);
  const neonOn = a.metallicNeon && a.metallicNeonIntensity > 0;
  const k = neonOn ? clamp(a.metallicNeonIntensity / 100, 0, 1) : 0;
  // Subtle neon chroma infused into the brushed-metal palette (capped so metal stays metal, not flat color fill)
  const cBoost = Math.min(h.chroma, 76) * k;

  if (dark) {
    roles.primary = neonOn ? hct(h.hue, cBoost * 0.42, 92 - k * 6) : '#f2f4f8';
    roles.onPrimary = neonOn ? hct(h.hue, cBoost * 0.35, 11) : '#111317';
    roles.primaryContainer = neonOn ? hct(h.hue, cBoost * 0.48, 22 + k * 6) : '#2d3139';
    roles.onPrimaryContainer = neonOn ? hct(h.hue, cBoost * 0.45, 92) : '#eef1f6';
    roles.secondary = neonOn ? hct(h.hue, cBoost * 0.32, 80) : '#c8cdd6';
    roles.onSecondary = '#181a1f';
    roles.secondaryContainer = neonOn ? hct(h.hue, cBoost * 0.36, 19 + k * 4) : '#262930';
    roles.onSecondaryContainer = neonOn ? hct(h.hue, cBoost * 0.38, 90) : '#e4e7ee';
    roles.tertiary = neonOn ? hct(h.hue + 24, cBoost * 0.45, 84) : '#dfe3ec';
    roles.onTertiary = '#16181d';
    roles.tertiaryContainer = neonOn ? hct(h.hue + 24, cBoost * 0.4, 24) : '#323640';
    roles.onTertiaryContainer = '#f0f2f7';
    roles.surface = '#0b0c0f';
    roles.surfaceContainerLowest = '#07080a';
    roles.surfaceContainerLow = neonOn ? hct(h.hue, cBoost * 0.1, 8) : '#111317';
    roles.surfaceContainer = neonOn ? hct(h.hue, cBoost * 0.12, 11) : '#16181e';
    roles.surfaceContainerHigh = neonOn ? hct(h.hue, cBoost * 0.15, 15) : '#1e2128';
    roles.surfaceContainerHighest = neonOn ? hct(h.hue, cBoost * 0.18, 20) : '#282c35';
    roles.onSurface = '#f3f5f9';
    roles.onSurfaceVariant = neonOn ? hct(h.hue, cBoost * 0.18, 70) : '#9fa6b2';
    roles.outline = neonOn ? hct(h.hue, cBoost * 0.28, 44) : '#5c626e';
    roles.outlineVariant = neonOn ? hct(h.hue, cBoost * 0.22, 26) : '#343842';
  } else {
    roles.primary = neonOn ? hct(h.hue, cBoost * 0.5, 24) : '#1e2229';
    roles.onPrimary = '#f7f9fc';
    roles.primaryContainer = neonOn ? hct(h.hue, cBoost * 0.35, 86) : '#d8dde6';
    roles.onPrimaryContainer = '#14171c';
    roles.secondaryContainer = neonOn ? hct(h.hue, cBoost * 0.28, 89) : '#e2e6ee';
    roles.onSecondaryContainer = '#1d2026';
  }
  return roles;
}

function commit(roles: Record<Role, string>, dark: boolean, source: number, bg: BgSpec) {
  applyRoles(roles);
  applyNeonUniforms(source, dark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', roles.surface);
  theme.set({ roles, dark, source, bg });
}

async function recompute() {
  const a = appearance.get();
  const tr = currentTrack();
  const dark = a.theme === 'system' ? mq.matches : a.theme === 'dark';
  const imgKey = a.bgImage ? a.bgImage.length + a.bgImage.slice(-32) : '';
  const key = [
    dark,
    a.variant,
    a.metallic,
    a.metallicNeon,
    a.metallicNeonIntensity,
    a.accentMode,
    a.accentColor,
    a.bgMode,
    a.bgStyle,
    a.bgColor,
    imgKey,
    a.bgDim,
    a.bgBlur,
    tr?.id ?? '',
  ].join('|');
  if (key === lastKey) return;
  lastKey = key;
  const my = ++seq;

  const needCover = !!tr && (a.accentMode === 'dynamic' || a.bgMode === 'dynamic' || a.metallic);
  const [pal, imgPal] = await Promise.all([
    needCover && tr ? getPalette(tr.thumb || tr.cover || '', tr.id) : null,
    a.bgMode === 'image' && a.bgImage ? getPalette(a.bgImage, 'bg:' + imgKey) : null,
  ]);
  const artwork = a.bgMode === 'dynamic' && a.bgStyle === 'artwork' && tr?.cover ? tr.cover : null;
  if (artwork) await preload(artwork);
  if (my !== seq) return;

  const custom = argbFromHex(a.accentColor);
  const accent = a.accentMode === 'dynamic' ? pal?.accent ?? (tr ? fallbackColor(tr.id) : custom) : custom;
  const bgSrc =
    a.bgMode === 'dynamic' ? pal?.dominant ?? accent
    : a.bgMode === 'color' ? argbFromHex(a.bgColor)
    : imgPal?.dominant ?? argbFromHex(a.bgColor);

  const baseRoles = schemeHex(buildScheme(accent, bgSrc, dark, a.metallic ? 'mono' : a.variant));
  const roles = a.metallic ? buildMetallicRoles(accent, baseRoles, dark) : baseRoles;

  const dim = `rgb(${dark ? '0 0 0' : '255 255 255'} / ${a.bgDim / 100})`;
  // Notice: `bg.key` intentionally does NOT include `a.metallic`, so toggling Metallic mode
  // never unmounts/recreates the background DOM layer or restarts `@keyframes fade`!
  let bg: BgSpec;
  if (a.bgMode === 'image' && a.bgImage) {
    bg = { key: 'img' + imgKey, kind: 'image', image: a.bgImage, base: roles.surface, colors: [], blur: a.bgBlur, dim };
  } else if (artwork) {
    bg = { key: 'art' + artwork, kind: 'image', image: artwork, base: roles.surface, colors: [], blur: 56 + a.bgBlur, dim };
  } else if (a.bgMode === 'dynamic' && pal) {
    const d = Hct.fromInt(pal.dominant);
    const base = hct(d.hue, Math.min(d.chroma, 30), dark ? 10 : 94);
    const colors = pal.colors.slice(0, 4).map((c, i) => {
      const h = Hct.fromInt(c);
      return hct(h.hue, Math.min(h.chroma * 1.15, 72), dark ? clamp(h.tone, 26, 46) - i * 3 : clamp(h.tone, 70, 88));
    });
    while (colors.length < 4) colors.push(colors[colors.length - 1]);
    bg = { key: 'mesh:' + (tr?.id ?? base), kind: 'mesh', base, colors, blur: 0, dim: 'transparent' };
  } else {
    const m = meshFromSource(bgSrc, dark);
    bg = { key: 'mesh:' + m.base, kind: 'mesh', ...m, blur: 0, dim: 'transparent' };
  }
  commit(roles, dark, accent, bg);
}

export function initTheme() {
  registerColorProps();
  applyGlass();
  applyLang();
  applyMetallicAttr();
  const a0 = appearance.get();
  applyMotion(a0.motion);

  // Synchronous first paint with a provisional scheme, then refine asynchronously.
  const dark0 = a0.theme === 'system' ? mq.matches : a0.theme === 'dark';
  const src0 = argbFromHex(a0.accentColor);
  const bg0 = a0.bgMode === 'color' ? argbFromHex(a0.bgColor) : src0;
  const m0 = meshFromSource(bg0, dark0);
  const baseRoles0 = schemeHex(buildScheme(src0, bg0, dark0, a0.metallic ? 'mono' : a0.variant));
  const roles0 = a0.metallic ? buildMetallicRoles(src0, baseRoles0, dark0) : baseRoles0;
  commit(roles0, dark0, src0, { key: 'boot', kind: 'mesh', ...m0, blur: 0, dim: 'transparent' });
  recompute();
  requestAnimationFrame(() => requestAnimationFrame(() => setColorTransition(a0.motion === 'reduced' ? 0 : 750)));

  let prev = a0;
  appearance.subscribe(() => {
    const a = appearance.get();
    if (a.glass !== prev.glass || a.blur !== prev.blur || a.opacity !== prev.opacity) applyGlass();
    if (a.metallic !== prev.metallic) applyMetallicAttr();
    if (a.motion !== prev.motion) {
      applyMotion(a.motion);
      setColorTransition(a.motion === 'reduced' ? 0 : 750);
    }
    if (a.lang !== prev.lang) applyLang();
    prev = a;
    recompute();
  });
  let prevId = currentTrack()?.id;
  player.subscribe(() => {
    const id = currentTrack()?.id;
    if (id !== prevId) {
      prevId = id;
      recompute();
    }
  });
  mq.addEventListener('change', () => recompute());
}
