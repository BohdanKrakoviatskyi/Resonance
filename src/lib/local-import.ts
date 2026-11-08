import type { Track } from '../types';
import { uid } from './util';

export const AUDIO_EXTS = new Set([
  'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'webm', 'aif', 'aiff', 'wma',
]);

export function isAudioFile(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return AUDIO_EXTS.has(ext);
}

function splitArtistTitle(name: string): { artist: string; title: string } {
  const base = name.replace(/\.[^.]+$/, '').trim() || 'Без названия';
  // Common patterns: "Artist - Title" / "Artist – Title"
  const parts = base.split(/\s+[—–-]\s+/);
  if (parts.length >= 2) {
    return { artist: parts[0].trim() || 'Unknown artist', title: parts.slice(1).join(' - ').trim() || base };
  }
  return { artist: 'Unknown artist', title: base };
}

export function sortFiles(files: File[]): File[] {
  return files.slice().sort((a, b) =>
    (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  );
}

// File System Access API (Chromium) — progressive enhancement
declare global {
  interface Window {
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
  }
}

export async function pickFolderFiles(): Promise<{ files: File[]; name: string } | null> {
  if ('showDirectoryPicker' in window && window.showDirectoryPicker) {
    try {
      const handle = await window.showDirectoryPicker();
      const files: File[] = [];
      await walk(handle, '', files);
      return { files: sortFiles(files), name: handle.name || 'Локальная музыка' };
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return null;
      // fall through to input
    }
  }
  return null;
}

async function walk(dir: FileSystemDirectoryHandle, prefix: string, out: File[]) {
  const iterable = dir as unknown as { values(): AsyncIterableIterator<FileSystemHandle> };
  for await (const entry of iterable.values()) {
    if (entry.kind === 'file') {
      const f = await (entry as FileSystemFileHandle).getFile() as File & { __rel?: string };
      f.__rel = `${prefix}${entry.name}`;
      if (isAudioFile(f.name)) out.push(f);
    } else if (entry.kind === 'directory') {
      await walk(entry as FileSystemDirectoryHandle, `${prefix}${entry.name}/`, out);
    }
  }
}

export function buildTrackFromFile(file: File, folderId: string, folderName: string): Track {
  const rel = (file as File & { __rel?: string }).__rel ?? (file.webkitRelativePath || file.name);
  const parts = rel.split('/');
  const parent = parts.length > 1 ? parts[parts.length - 2] : folderName;
  const { artist, title } = splitArtistTitle(file.name);
  const id = `local:${folderId}:${rel}`;
  return {
    id,
    title,
    artist: artist === 'Unknown artist' ? parent || artist : artist,
    album: parent !== folderName ? parent : undefined,
    src: URL.createObjectURL(file),
    duration: 0,
    source: 'local',
  };
}

export function folderNameFromFiles(files: File[], fallback = 'Локальная музыка'): string {
  const first = files[0];
  if (!first) return fallback;
  const rel = first.webkitRelativePath || first.name;
  const root = rel.split('/')[0];
  return root && root !== first.name ? root : fallback;
}

export function probeDuration(src: string): Promise<number> {
  return new Promise((resolve) => {
    const a = new Audio();
    const done = () => resolve(isFinite(a.duration) ? a.duration : 0);
    a.preload = 'metadata';
    a.src = src;
    a.addEventListener('loadedmetadata', done, { once: true });
    a.addEventListener('error', () => resolve(0), { once: true });
    window.setTimeout(() => resolve(0), 4000);
  });
}

// Non-blocking duration probing with batched updates
export async function probeDurations(tracks: Track[], onUpdate: (id: string, duration: number) => void) {
  for (const tr of tracks) {
    if (tr.duration) continue;
    const d = await probeDuration(tr.src);
    if (d > 0) onUpdate(tr.id, d);
  }
}

export const newFolderId = () => uid();
