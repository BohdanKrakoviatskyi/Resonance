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

function meshFromSource(src: number, dark: boolean, exact = false) {
  const h = Hct.fromInt(src);
  if (exact) {
    // Preserve true black / near-black tone (clamping only the upper bound so dark text stays readable)
    // and force strictly zero chroma when the chosen color is achromatic (chroma < 6).
    const c = h.chroma < 6 ? 0 : h.chroma;
    const hue = c === 0 ? 0 : h.hue;
    const T = dark ? clamp(h.tone * 0.72, 0, 46) : clamp(h.tone, 76, 98);
    const base = hexFromArgb(Hct.from(hue, c, T).toInt());
    const minBlobTone = h.tone < 2 ? 0 : 4;
    const colors = ([[8, 1.04, 10], [-10, 0.96, -8], [14, 0.94, 6], [-6, 1.08, 14]] as const).map(([dh, k, dt]) =>
      hct(hue + dh, c * k, c === 0 && h.tone < 2 ? 0 : clamp(T + (dark ? dt : -dt * 0.5), minBlobTone, 96)),
    );
    return { base, colors };
  }
  const T = dark ? Math.min(h.tone, 30) : Math.max(h.tone, 84);
  const base = hexFromArgb(Hct.from(h.hue, h.chroma, T).toInt());
  const colors = ([[18, 1.1, 14], [-26, 1, -9], [42, 0.9, 8], [0, 1.25, 20]] as const).map(([dh, k, dt]) =>
    hct(h.hue + dh, h.chroma * k, clamp(T + (dark ? dt : -dt * 0.6), 2, 98)),
  );
  return { base, colors };
}

function hexToRgbTuple(hex: string): string {
  const v = argbFromHex(hex);
  return `${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}`;
}

function applyBgUniforms(spec: BgSpec, bgColorHex: string, accentHex: string) {
  const st = document.documentElement.style;
  const [a, b, c, d] = spec.colors;
  const bgHct = Hct.fromInt(argbFromHex(bgColorHex));
  const specTint =
    appearance.get().bgMode === 'color'
      ? bgHct.chroma < 6
        ? 'rgb(255 255 255 / 0.14)'
        : hct(bgHct.hue, Math.min(bgHct.chroma, 48), 72)
      : accentHex;
  st.setProperty('--bg-base', spec.base);
  st.setProperty('--bg-blob-1', a || spec.base);
  st.setProperty('--bg-blob-2', b || a || spec.base);
  st.setProperty('--bg-blob-3', c || b || a || spec.base);
  st.setProperty('--bg-blob-4', d || a || spec.base);
  st.setProperty('--bg-color', bgColorHex);
  st.setProperty('--bg-rgb', hexToRgbTuple(bgColorHex));
  st.setProperty('--glass-spec-tint', specTint);
  st.setProperty('--accent-color', accentHex);
  st.setProperty('--accent-rgb', hexToRgbTuple(accentHex));
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
  r.style.setProperty('--refract-k', (a.refraction / 100).toFixed(3));
}

function applyLang() {
  const en = appearance.get().lang === 'en';
  const r = document.documentElement;
  r.lang = en ? 'en' : 'ru';
  r.style.setProperty('--font-ui', en
    ? "'Google Sans Flex', 'Roboto Flex', system-ui, sans-serif"
    : "'Roboto Flex', 'Google Sans Flex', system-ui, sans-serif");
}

function computeNeonHex(accentArgb: number, dark: boolean): string {
  const h = Hct.fromInt(accentArgb);
  const neonChroma = Math.max(h.chroma, 62);
  const neonTone = dark ? clamp(h.tone, 58, 74) : clamp(h.tone, 42, 58);
  return hct(h.hue, neonChroma, neonTone);
}

/**
 * Computes a tone-clamped neon color from the active accent ARGB so very bright accents
 * (yellow, lime) keep rich neon chromaticity without blowing out text or controls.
 */
function applyNeonUniforms(accentArgb: number, dark: boolean) {
  const a = appearance.get();
  const neonHex = computeNeonHex(accentArgb, dark);
  const active = a.metallic && a.metallicNeon;
  const k = active ? clamp(a.metallicNeonIntensity / 100, 0, 1) : 0;

  const st = document.documentElement.style;
  st.setProperty('--metal-neon', neonHex);
  st.setProperty('--metal-neon-k', k.toFixed(3));
}

function buildMetallicRoles(accentArgb: number, bgArgb: number, baseRoles: Record<Role, string>, dark: boolean): Record<Role, string> {
  const a = appearance.get();
  const roles = { ...baseRoles };
  const h = Hct.fromInt(accentArgb);
  const bgH = Hct.fromInt(bgArgb);
  const isCustomColorBg = a.bgMode === 'color';
  const bgPureBlack = isCustomColorBg && bgH.chroma < 6 && bgH.tone < 3;
  const neonOn = a.metallic && a.metallicNeon && a.metallicNeonIntensity > 0;
  const k = neonOn ? clamp(a.metallicNeonIntensity / 100, 0, 1) : 0;
  // Subtle neon chroma infused into the brushed-metal palette (capped so metal stays metal, not flat color fill)
  const cBoost = Math.min(h.chroma, 76) * k;
  const surfHue = isCustomColorBg ? (bgH.chroma < 6 ? 0 : bgH.hue) : h.hue;
  const surfChroma = isCustomColorBg ? (bgH.chroma < 6 ? 0 : Math.min(bgH.chroma, 32) * 0.25) : cBoost;

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
    roles.surface = bgPureBlack ? '#000000' : isCustomColorBg ? baseRoles.surface : '#0b0c0f';
    roles.surfaceContainerLowest = bgPureBlack ? '#050505' : isCustomColorBg ? baseRoles.surfaceContainerLowest : '#07080a';
    roles.surfaceContainerLow = bgPureBlack
      ? '#0d0d0d'
      : isCustomColorBg
        ? baseRoles.surfaceContainerLow
        : neonOn
          ? hct(surfHue, surfChroma * 0.1, 8)
          : '#111317';
    roles.surfaceContainer = bgPureBlack
      ? '#121212'
      : isCustomColorBg
        ? baseRoles.surfaceContainer
        : neonOn
          ? hct(surfHue, surfChroma * 0.12, 11)
          : '#16181e';
    roles.surfaceContainerHigh = bgPureBlack
      ? '#1a1a1a'
      : isCustomColorBg
        ? baseRoles.surfaceContainerHigh
        : neonOn
          ? hct(surfHue, surfChroma * 0.15, 15)
          : '#1e2128';
    roles.surfaceContainerHighest = bgPureBlack
      ? '#242424'
      : isCustomColorBg
        ? baseRoles.surfaceContainerHighest
        : neonOn
          ? hct(surfHue, surfChroma * 0.18, 20)
          : '#282c35';
    roles.onSurface = '#f3f5f9';
    roles.onSurfaceVariant = bgPureBlack
      ? '#a3a3a3'
      : isCustomColorBg && bgH.chroma < 6
        ? '#a3a3a3'
        : neonOn
          ? hct(h.hue, cBoost * 0.18, 70)
          : '#9fa6b2';
    roles.outline = bgPureBlack
      ? '#5e5e5e'
      : isCustomColorBg && bgH.chroma < 6
        ? '#5e5e5e'
        : neonOn
          ? hct(h.hue, cBoost * 0.28, 44)
          : '#5c626e';
    roles.outlineVariant = bgPureBlack
      ? '#363636'
      : isCustomColorBg && bgH.chroma < 6
        ? '#363636'
        : neonOn
          ? hct(h.hue, cBoost * 0.22, 26)
          : '#343842';
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
  const a = appearance.get();
  applyRoles(roles);
  applyNeonUniforms(source, dark);
  applyBgUniforms(bg, a.bgMode === 'color' ? a.bgColor : bg.base, hexFromArgb(source));
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', roles.surface);
  theme.set({ roles, dark, source, bg });
}

let previewRaf = 0;
let previewPending: { bgColor?: string; accentColor?: string } | null = null;
let previewTransitionPaused = false;
let themeDragTimer = 0;
let lastFrameTs = 0;
let lastInputLogTs = 0;

export interface ColorInputLogEntry {
  timestamp: number;
  dt: number;
  rawHex: string;
  rgb: [number, number, number];
}

export interface ThemeDragStats {
  events: number;
  frames: number;
  rerenders: number;
  saves: number;
  pointerWrites: number;
  domElementCount: number;
  varsUpdatedPerFrame: number;
  avgFrameMs: number;
  maxFrameMs: number;
  avgFrameDeltaMs: number;
  maxFrameDeltaMs: number;
  avgRecalcStyleMs: number;
  maxRecalcStyleMs: number;
  recentInputs: ColorInputLogEntry[];
}

const dragStats = {
  events: 0,
  frames: 0,
  rerenders: 0,
  saves: 0,
  pointerWrites: 0,
  domElementCount: 0,
  varsUpdatedPerFrame: 0,
  totalFrameMs: 0,
  maxFrameMs: 0,
  totalFrameDeltaMs: 0,
  maxFrameDeltaMs: 0,
  deltaSamples: 0,
  totalRecalcStyleMs: 0,
  maxRecalcStyleMs: 0,
  recentInputs: [] as ColorInputLogEntry[],
};

export function resetThemeDragStats() {
  dragStats.events = 0;
  dragStats.frames = 0;
  dragStats.rerenders = 0;
  dragStats.saves = 0;
  dragStats.pointerWrites = 0;
  dragStats.domElementCount = typeof document !== 'undefined' ? document.querySelectorAll('*').length : 0;
  dragStats.varsUpdatedPerFrame = 0;
  dragStats.totalFrameMs = 0;
  dragStats.maxFrameMs = 0;
  dragStats.totalFrameDeltaMs = 0;
  dragStats.maxFrameDeltaMs = 0;
  dragStats.deltaSamples = 0;
  dragStats.totalRecalcStyleMs = 0;
  dragStats.maxRecalcStyleMs = 0;
  dragStats.recentInputs = [];
  lastFrameTs = 0;
  lastInputLogTs = 0;
}

export function logColorPickerInput(rawHex: string) {
  const ts = performance.now();
  const dt = lastInputLogTs > 0 ? +(ts - lastInputLogTs).toFixed(2) : 0;
  lastInputLogTs = ts;
  const n = parseInt(rawHex.slice(1), 16) || 0;
  const entry: ColorInputLogEntry = {
    timestamp: +ts.toFixed(2),
    dt,
    rawHex,
    rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255],
  };
  if (dragStats.recentInputs.length >= 60) dragStats.recentInputs.shift();
  dragStats.recentInputs.push(entry);
}

export function recordThemeRerender() {
  if (previewTransitionPaused) dragStats.rerenders += 1;
}

export function recordThemePointerWrite() {
  if (previewTransitionPaused) dragStats.pointerWrites += 1;
}

export function getThemeDragStats(): ThemeDragStats {
  return {
    events: dragStats.events,
    frames: dragStats.frames,
    rerenders: dragStats.rerenders,
    saves: dragStats.saves,
    pointerWrites: dragStats.pointerWrites,
    domElementCount: dragStats.domElementCount || (typeof document !== 'undefined' ? document.querySelectorAll('*').length : 0),
    varsUpdatedPerFrame: dragStats.varsUpdatedPerFrame,
    avgFrameMs: dragStats.frames ? +(dragStats.totalFrameMs / dragStats.frames).toFixed(3) : 0,
    maxFrameMs: +dragStats.maxFrameMs.toFixed(3),
    avgFrameDeltaMs: dragStats.deltaSamples ? +(dragStats.totalFrameDeltaMs / dragStats.deltaSamples).toFixed(3) : 0,
    maxFrameDeltaMs: +dragStats.maxFrameDeltaMs.toFixed(3),
    avgRecalcStyleMs: dragStats.frames ? +(dragStats.totalRecalcStyleMs / dragStats.frames).toFixed(3) : 0,
    maxRecalcStyleMs: +dragStats.maxRecalcStyleMs.toFixed(3),
    recentInputs: dragStats.recentInputs.slice(-16),
  };
}

/**
 * Marks `html[data-theme-dragging="true"]` and `.is-picking` during active palette/slider dragging
 * and removes it after pointer motion stops.
 */
export function markThemeDragging(holdMs = 150) {
  if (!previewTransitionPaused) {
    previewTransitionPaused = true;
    lastFrameTs = 0;
    dragStats.domElementCount = document.querySelectorAll('*').length;
    document.documentElement.dataset.themeDragging = 'true';
    document.documentElement.classList.add('is-picking');
    setColorTransition(0);
  }
  window.clearTimeout(themeDragTimer);
  if (holdMs > 0) {
    themeDragTimer = window.setTimeout(() => {
      endLiveColorPreview();
    }, holdMs);
  }
}

let windowCleanupWired = false;
function ensurePickingSafetyListeners() {
  if (windowCleanupWired || typeof window === 'undefined') return;
  windowCleanupWired = true;
  const finish = () => {
    if (previewTransitionPaused) endLiveColorPreview();
  };
  window.addEventListener('blur', finish);
  window.addEventListener('pointerup', finish, { passive: true });
  window.addEventListener('pointercancel', finish, { passive: true });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && previewTransitionPaused) endLiveColorPreview();
  });
}

/**
 * Live 60+ FPS DOM preview while dragging color picker without triggering
 * global React store updates, `localStorage` serialization, or full 38-variable style invalidations.
 * Updates ONLY the minimal 3–4 visible base variables during active drag, computed via the exact
 * same HCT `buildScheme` / `meshFromSource` math as `recompute()` so there is zero color jump on pointerup.
 */
export function previewLiveColor(patch: { bgColor?: string; accentColor?: string }) {
  ensurePickingSafetyListeners();
  dragStats.events += 1;
  if (patch.bgColor) logColorPickerInput(patch.bgColor);
  if (patch.accentColor) logColorPickerInput(patch.accentColor);
  previewPending = { ...previewPending, ...patch };
  // Hold picking state without auto-expiring mid-drag (safety listeners + explicit commit clear it)
  markThemeDragging(0);
  if (previewRaf) return;
  previewRaf = requestAnimationFrame((now) => {
    const t0 = performance.now();
    if (lastFrameTs > 0) {
      const frameDeltaMs = now - lastFrameTs;
      dragStats.deltaSamples += 1;
      dragStats.totalFrameDeltaMs += frameDeltaMs;
      if (frameDeltaMs > dragStats.maxFrameDeltaMs) dragStats.maxFrameDeltaMs = frameDeltaMs;
    }
    lastFrameTs = now;
    previewRaf = 0;
    const p = previewPending;
    previewPending = null;
    if (!p) return;
    const a = { ...appearance.get(), ...p };
    const dark = a.theme === 'system' ? mq.matches : a.theme === 'dark';
    const st = document.documentElement.style;
    let varsSet = 0;

    const accentArgb = a.accentMode === 'custom' ? argbFromHex(a.accentColor) : theme.get().source;
    const bgArgb = a.bgMode === 'color' ? argbFromHex(a.bgColor) : accentArgb;
    const scheme = buildScheme(accentArgb, bgArgb, dark, a.metallic ? 'mono' : a.variant);
    const baseRoles = schemeHex(scheme);
    const roles = a.metallic ? buildMetallicRoles(accentArgb, bgArgb, baseRoles, dark) : baseRoles;

    if (p.bgColor !== undefined && a.bgMode === 'color') {
      const m = meshFromSource(bgArgb, dark, true);
      // Minimal 4 visible background variables during active drag — exact match with recompute()
      st.setProperty('--bg-base', m.base);
      st.setProperty('--md-surface', roles.surface);
      st.setProperty('--md-surface-container-low', roles.surfaceContainerLow);
      st.setProperty('--md-surface-container-lowest', roles.surfaceContainerLowest);
      varsSet += 4;
    }

    if (p.accentColor !== undefined && a.accentMode === 'custom') {
      // Minimal visible accent variables during active drag — exact match with recompute()
      st.setProperty('--md-primary', roles.primary);
      st.setProperty('--md-primary-container', roles.primaryContainer);
      st.setProperty('--md-secondary-container', roles.secondaryContainer);
      varsSet += 3;
      if (a.metallic && a.metallicNeon) {
        st.setProperty('--metal-neon', computeNeonHex(accentArgb, dark));
        varsSet += 1;
      }
    }

    const tBeforeStyle = performance.now();
    const probeEl = document.querySelector('.app-shell') || document.body;
    if (probeEl) void getComputedStyle(probeEl).color;
    const recalcMs = performance.now() - tBeforeStyle;

    const workMs = performance.now() - t0;
    dragStats.varsUpdatedPerFrame = varsSet;
    dragStats.frames += 1;
    dragStats.totalFrameMs += workMs;
    if (workMs > dragStats.maxFrameMs) dragStats.maxFrameMs = workMs;
    dragStats.totalRecalcStyleMs += recalcMs;
    if (recalcMs > dragStats.maxRecalcStyleMs) dragStats.maxRecalcStyleMs = recalcMs;
  });
}

export function endLiveColorPreview() {
  window.clearTimeout(themeDragTimer);
  themeDragTimer = 0;
  if (previewRaf) {
    cancelAnimationFrame(previewRaf);
    previewRaf = 0;
  }
  previewPending = null;
  if (!previewTransitionPaused) return;
  previewTransitionPaused = false;
  delete document.documentElement.dataset.themeDragging;
  document.documentElement.classList.remove('is-picking');
  const motion = appearance.get().motion;
  requestAnimationFrame(() => setColorTransition(motion === 'reduced' ? 0 : 750));
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

  const needCover = !!tr && (a.accentMode === 'dynamic' || a.bgMode === 'dynamic');
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
  const roles = a.metallic ? buildMetallicRoles(accent, bgSrc, baseRoles, dark) : baseRoles;

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
    const m = meshFromSource(bgSrc, dark, a.bgMode === 'color');
    bg = { key: a.bgMode === 'color' ? 'mesh:color' : 'mesh:' + m.base, kind: 'mesh', ...m, blur: 0, dim: 'transparent' };
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
  const m0 = meshFromSource(bg0, dark0, a0.bgMode === 'color');
  const baseRoles0 = schemeHex(buildScheme(src0, bg0, dark0, a0.metallic ? 'mono' : a0.variant));
  const roles0 = a0.metallic ? buildMetallicRoles(src0, bg0, baseRoles0, dark0) : baseRoles0;
  commit(roles0, dark0, src0, { key: a0.bgMode === 'color' ? 'mesh:color' : 'boot', kind: 'mesh', ...m0, blur: 0, dim: 'transparent' });
  recompute();
  requestAnimationFrame(() => requestAnimationFrame(() => setColorTransition(a0.motion === 'reduced' ? 0 : 750)));

  let prev = a0;
  appearance.subscribe(() => {
    const a = appearance.get();
    if (a.glass !== prev.glass || a.blur !== prev.blur || a.opacity !== prev.opacity || a.refraction !== prev.refraction) applyGlass();
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
