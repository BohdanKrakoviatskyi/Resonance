import { createStore, persist } from '../lib/util';
import type { Variant } from '../lib/color';
import type { MotionMode } from '../lib/motion';

export type GlassMode = 'liquid' | 'frosted' | 'off';
export type BgMode = 'dynamic' | 'color' | 'image';

export interface Appearance {
  theme: 'dark' | 'light' | 'system';
  glass: GlassMode;
  blur: number; // 0..100
  opacity: number; // tint density 0..100
  refraction: number; // 0..100
  bgMode: BgMode;
  bgStyle: 'palette' | 'artwork';
  bgColor: string;
  bgImage: string | null;
  bgDim: number;
  bgBlur: number;
  accentMode: 'dynamic' | 'custom';
  accentColor: string;
  variant: Variant;
  motion: MotionMode;
  lang: 'ru' | 'en';
}

export const DEFAULTS: Appearance = {
  theme: 'dark',
  glass: 'liquid',
  blur: 45,
  opacity: 34,
  refraction: 45,
  bgMode: 'dynamic',
  bgStyle: 'palette',
  bgColor: '#25305e',
  bgImage: null,
  bgDim: 30,
  bgBlur: 0,
  accentMode: 'dynamic',
  accentColor: '#8c7cff',
  variant: 'vibrant',
  motion: 'expressive',
  lang: (navigator.language || 'ru').toLowerCase().startsWith('ru') ? 'ru' : 'en',
};

export const appearance = createStore<Appearance>({ ...DEFAULTS });
persist('lyra.app.v1', appearance, ({ bgImage: _omit, ...rest }) => rest);

const IMG_KEY = 'lyra.bgimg.v1';
const DB_NAME = 'lyra.media.v1';
const STORE_NAME = 'bg';

function openBgDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveBgToDb(data: string | null): Promise<void> {
  const db = await openBgDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    if (data) store.put(data, IMG_KEY);
    else store.delete(IMG_KEY);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function loadBgFromDb(): Promise<string | null> {
  const db = await openBgDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(IMG_KEY);
    req.onsuccess = () => {
      db.close();
      resolve(typeof req.result === 'string' ? req.result : null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

try {
  const img = localStorage.getItem(IMG_KEY);
  if (img) appearance.set({ bgImage: img });
} catch {
  /* ignore */
}

void loadBgFromDb()
  .then((img) => {
    if (img && !appearance.get().bgImage) {
      appearance.set({ bgImage: img });
    }
  })
  .catch(() => {});

/** Returns false if the image couldn't be persisted (it still applies for this session). */
export function setBgImage(data: string | null): boolean {
  try {
    if (data && data.length < 3_500_000) localStorage.setItem(IMG_KEY, data);
    else localStorage.removeItem(IMG_KEY);
  } catch {
    try {
      localStorage.removeItem(IMG_KEY);
    } catch {
      /* ignore */
    }
  }
  void saveBgToDb(data).catch(() => {});
  appearance.set({ bgImage: data, bgMode: data ? 'image' : appearance.get().bgMode === 'image' ? 'dynamic' : appearance.get().bgMode });
  return true;
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Failed to read file')));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/** Preserves animated images (GIF/WebP/APNG) directly; downscales static photos to keep storage + memory light. */
export async function processImage(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  const isAnimatedFormat =
    file.type === 'image/gif' ||
    file.type === 'image/webp' ||
    file.type === 'image/apng' ||
    name.endsWith('.gif') ||
    name.endsWith('.webp') ||
    name.endsWith('.apng');
  if (isAnimatedFormat) {
    return readAsDataUrl(file);
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, 1920 / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.naturalWidth * k);
    cv.height = Math.round(img.naturalHeight * k);
    cv.getContext('2d')!.drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', 0.84);
  } finally {
    URL.revokeObjectURL(url);
  }
}
