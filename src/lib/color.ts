import {
  argbFromRgb,
  hexFromArgb,
  Hct,
  TonalPalette,
  DynamicScheme,
  QuantizerCelebi,
  Score,
  SchemeTonalSpot,
  SchemeVibrant,
  SchemeExpressive,
  SchemeFidelity,
  SchemeRainbow,
  SchemeFruitSalad,
  SchemeMonochrome,
  SchemeNeutral,
} from '@material/material-color-utilities';
import { hash } from './util';

export type Variant = 'tonal' | 'vibrant' | 'expressive' | 'fidelity' | 'rainbow' | 'fruit' | 'mono' | 'neutral';
export const VARIANTS: Variant[] = ['vibrant', 'tonal', 'expressive', 'fidelity', 'rainbow', 'fruit', 'neutral', 'mono'];

const CTORS = {
  tonal: SchemeTonalSpot,
  vibrant: SchemeVibrant,
  expressive: SchemeExpressive,
  fidelity: SchemeFidelity,
  rainbow: SchemeRainbow,
  fruit: SchemeFruitSalad,
  mono: SchemeMonochrome,
  neutral: SchemeNeutral,
} as const;

export interface Palette {
  accent: number;
  dominant: number;
  colors: number[];
}

/** Accent palettes come from `accent`, neutral (surface) palettes from `bg` — so background & accent are independent. */
export function buildScheme(accent: number, bg: number, dark: boolean, v: Variant): DynamicScheme {
  const src = Hct.fromInt(accent);
  const base = new CTORS[v](src, dark, 0, '2025');
  if (v === 'mono') return base;
  const b = Hct.fromInt(bg);
  const c = b.chroma < 6 ? b.chroma : Math.min(Math.max(b.chroma * 0.42, 6), 22);
  return new DynamicScheme({
    sourceColorHct: src,
    variant: base.variant,
    contrastLevel: 0,
    isDark: dark,
    specVersion: base.specVersion,
    primaryPalette: base.primaryPalette,
    secondaryPalette: base.secondaryPalette,
    tertiaryPalette: base.tertiaryPalette,
    errorPalette: base.errorPalette,
    neutralPalette: TonalPalette.fromHueAndChroma(b.hue, c),
    neutralVariantPalette: TonalPalette.fromHueAndChroma(b.hue, c + 4),
  });
}

export const ROLES = [
  'primary', 'onPrimary', 'primaryContainer', 'onPrimaryContainer',
  'secondary', 'onSecondary', 'secondaryContainer', 'onSecondaryContainer',
  'tertiary', 'onTertiary', 'tertiaryContainer', 'onTertiaryContainer',
  'error', 'onError',
  'surface', 'surfaceContainerLowest', 'surfaceContainerLow', 'surfaceContainer', 'surfaceContainerHigh', 'surfaceContainerHighest',
  'onSurface', 'onSurfaceVariant', 'outline', 'outlineVariant',
  'inverseSurface', 'inverseOnSurface', 'inversePrimary',
] as const;
export type Role = (typeof ROLES)[number];
const kebab = (s: string) => '--md-' + s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());

export function schemeHex(s: DynamicScheme): Record<Role, string> {
  const out = {} as Record<Role, string>;
  const src = s as unknown as Record<Role, number>;
  for (const r of ROLES) out[r] = hexFromArgb(src[r]);
  return out;
}

export function applyRoles(roles: Record<Role, string>) {
  const st = document.documentElement.style;
  for (const r of ROLES) st.setProperty(kebab(r), roles[r]);
}

/** Registered <color> properties let every themed surface interpolate smoothly when the palette changes. */
export function registerColorProps() {
  if (!('registerProperty' in CSS)) return;
  for (const r of ROLES) {
    try {
      CSS.registerProperty({ name: kebab(r), syntax: '<color>', inherits: true, initialValue: '#000000' });
    } catch {
      /* already registered */
    }
  }
}
export function setColorTransition(ms: number) {
  document.documentElement.style.transition = ms ? ROLES.map((r) => `${kebab(r)} ${ms}ms cubic-bezier(.2,0,0,1)`).join(',') : '';
}

const cache = new Map<string, Promise<Palette | null>>();

export function clearPaletteCache() {
  cache.clear();
}

export function getPalette(url: string, key = url): Promise<Palette | null> {
  if (!url) return Promise.resolve(null);
  let p = cache.get(key);
  if (!p) {
    p = extract(url).catch(() => null);
    cache.set(key, p);
  }
  return p;
}

async function extract(url: string): Promise<Palette> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  const S = 56;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, S, S);
  const d = ctx.getImageData(0, 0, S, S).data;
  const px: number[] = [];
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 250) px.push(argbFromRgb(d[i], d[i + 1], d[i + 2]));
  const q = QuantizerCelebi.quantize(px, 48);
  const ranked = Score.score(q, { desired: 4, fallbackColorARGB: 0xff7c6cf0, filter: true });
  const byPop = [...q.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  const distinct: number[] = [];
  for (const c of byPop) {
    const h = Hct.fromInt(c);
    if (distinct.every((x) => {
      const o = Hct.fromInt(x);
      const dh = Math.abs(o.hue - h.hue);
      return Math.min(dh, 360 - dh) > 18 || Math.abs(o.tone - h.tone) > 22;
    })) distinct.push(c);
    if (distinct.length >= 5) break;
  }
  return { accent: ranked[0], dominant: byPop[0] ?? ranked[0], colors: distinct.length ? distinct : [ranked[0]] };
}

export const fallbackColor = (id: string) => Hct.from(hash(id) % 360, 44, 52).toInt();
export const hct = (hue: number, chroma: number, tone: number) => hexFromArgb(Hct.from(((hue % 360) + 360) % 360, Math.max(0, chroma), Math.min(100, Math.max(0, tone))).toInt());
