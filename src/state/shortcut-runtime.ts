import { isTauri } from '@tauri-apps/api/core';
import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { currentTrack, next, prev, seekBy, toggle, toggleMute } from './player';
import { toggleLike } from './library';
import { adjustTrackLyricsOffset, openSearch, setImmersive, ui } from './ui';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUTS,
  normalizeShortcut,
  shortcutForEvent,
  shortcuts,
  type ShortcutId,
} from './shortcuts';

let globalRegistered: string | null = null;
let runtimeStarted = false;
let registrationQueue = Promise.resolve();

export function dispatchShortcut(id: ShortcutId) {
  switch (id) {
    case 'playPause':
      toggle();
      break;
    case 'seekBack':
      seekBy(-5);
      break;
    case 'seekForward':
      seekBy(5);
      break;
    case 'previous':
      prev();
      break;
    case 'next':
      next();
      break;
    case 'like': {
      const track = currentTrack();
      if (track) toggleLike(track.id);
      break;
    }
    case 'lyrics':
      if (currentTrack()) setImmersive(!ui.get().immersive);
      break;
    case 'search':
      setImmersive(false);
      openSearch(ui.get().searchQ);
      break;
    case 'mute':
      toggleMute();
      break;
    case 'lyricsOffsetBack': {
      const track = currentTrack();
      if (track) adjustTrackLyricsOffset(track.id, -0.5);
      break;
    }
    case 'lyricsOffsetForward': {
      const track = currentTrack();
      if (track) adjustTrackLyricsOffset(track.id, 0.5);
      break;
    }
  }
}

function registerGlobal(binding: string): Promise<void> {
  return register(toNativeShortcut(binding), (event) => {
    if (event.state === 'Pressed' && shortcuts.get().recording === null) dispatchShortcut('mute');
  });
}

export function initializeShortcutRuntime() {
  if (runtimeStarted) return;
  runtimeStarted = true;
  if (!isTauri()) return;

  const binding = shortcuts.get().bindings.mute;
  registrationQueue = registrationQueue.catch(() => undefined).then(async () => {
    try {
      await registerGlobal(binding);
      globalRegistered = binding;
      shortcuts.set({ error: null });
    } catch {
      // If Windows blocks a single-key global hook or another app holds it, fall back to window-level handling without blocking UI.
      globalRegistered = null;
    }
  });
}

export function updateShortcut(id: ShortcutId, binding: string): Promise<boolean> {
  const nextBinding = normalizeShortcut(binding);
  const bindings = shortcuts.get().bindings;
  const duplicate = SHORTCUTS.find(
    (shortcut) => shortcut.id !== id && normalizeShortcut(bindings[shortcut.id]) === nextBinding,
  );
  if (duplicate) {
    shortcuts.set({ error: 'duplicate' });
    return Promise.resolve(false);
  }

  if (id !== 'mute' || !isTauri()) {
    shortcuts.set({ bindings: { ...bindings, [id]: nextBinding }, error: null });
    return Promise.resolve(true);
  }

  registrationQueue = registrationQueue.catch(() => undefined).then(async () => {
    const previous = globalRegistered;
    if (previous && previous !== nextBinding) {
      await unregister(toNativeShortcut(previous)).catch(() => undefined);
      globalRegistered = null;
    }

    shortcuts.set({ bindings: { ...shortcuts.get().bindings, mute: nextBinding }, error: null });

    if (globalRegistered !== nextBinding) {
      try {
        await registerGlobal(nextBinding);
        globalRegistered = nextBinding;
      } catch {
        // Still allow the binding to work inside the window on Windows even if OS-wide hook was rejected.
        globalRegistered = null;
      }
    }
  });

  return registrationQueue.then(() => true, () => false);
}

export function restoreDefaultShortcut(id: ShortcutId): Promise<boolean> {
  return updateShortcut(id, DEFAULT_SHORTCUTS[id]);
}

export function handleWindowShortcut(event: KeyboardEvent) {
  if (shortcuts.get().recording) return;
  const target = event.target;
  if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;

  const normalizedEvent = shortcutForEvent(event);
  if (!normalizedEvent) return;
  const action = SHORTCUTS.find(({ id, scope }) => {
    if (normalizeShortcut(shortcuts.get().bindings[id]) !== normalizedEvent) return false;
    if (scope === 'window') return true;
    // Also handle 'mute' at window level when global registration isn't active on Windows.
    return id === 'mute' && !globalRegistered;
  });
  if (!action) return;

  if (action.id === 'playPause' && target instanceof HTMLElement && target.closest('button, [role=slider]')) return;
  event.preventDefault();
  dispatchShortcut(action.id);
}

const NATIVE_KEY_MAP: Record<string, string> = {
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '-': 'Minus',
  '=': 'Equal',
};

function toNativeShortcut(binding: string): string {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  return normalizeShortcut(binding).split('+').map((part) => {
    if (part === 'Ctrl') return 'Control';
    if (part === 'Meta') return isMac ? 'CommandOrControl' : 'Super';
    return NATIVE_KEY_MAP[part] ?? part;
  }).join('+');
}
