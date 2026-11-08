import { useEffect } from 'react';
import { Icon } from './Icon';
import { t } from '../lib/i18n';
import { useStore } from '../lib/util';
import {
  SHORTCUTS,
  displayShortcut,
  isValidShortcut,
  shortcuts,
  shortcutForEvent,
} from '../state/shortcuts';
import { restoreDefaultShortcut, updateShortcut } from '../state/shortcut-runtime';

function errorText(error: string | null) {
  if (error === 'duplicate') return t('shortcutDuplicate');
  if (error === 'storage') return t('shortcutStorageError');
  if (error) return t('shortcutRegisterError');
  return null;
}

export function ShortcutSettings() {
  const state = useStore(shortcuts, (value) => value);

  useEffect(() => {
    const id = state.recording;
    if (!id) return;

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (event.key === 'Escape') {
        shortcuts.set({ recording: null, error: null });
        return;
      }
      const shortcut = shortcutForEvent(event);
      if (!shortcut || !isValidShortcut(shortcut)) return;

      void updateShortcut(id, shortcut).then((saved) => {
        shortcuts.set({ recording: null });
        if (saved) shortcuts.set({ error: null });
      });
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [state.recording]);

  return (
    <div className="grid gap-0">
      {SHORTCUTS.map(({ id, label }) => {
        const recording = state.recording === id;
        const keys = displayShortcut(state.bindings[id]);
        return (
          <div key={id} className="flex min-h-9 items-center justify-between gap-3 py-0.5">
            <div className="min-w-0 text-sm text-on-surface">{t(label)}</div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                className="flex min-w-24 items-center justify-center gap-1 rounded-xl border border-outline-variant/50 px-2.5 py-1.5 text-xs transition hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary"
                aria-label={recording ? t('shortcutListening') : `${t(label)}: ${keys.join('+')}`}
                aria-pressed={recording}
                onClick={() => shortcuts.set({ recording: recording ? null : id, error: null })}
              >
                {recording ? (
                  <span className="animate-pulse">{t('shortcutListening')}</span>
                ) : (
                  keys.map((key) => <kbd key={key} className="kbd">{key}</kbd>)
                )}
              </button>
              <button
                type="button"
                className="grid h-8 w-8 place-items-center rounded-full text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface disabled:opacity-35"
                aria-label={t('shortcutReset')}
                title={t('shortcutReset')}
                disabled={state.bindings[id] === SHORTCUTS.find((item) => item.id === id)?.defaultBinding}
                onClick={() => void restoreDefaultShortcut(id)}
              >
                <Icon name="refresh" size={17} />
              </button>
            </div>
          </div>
        );
      })}
      {state.error && <div className="pt-1 text-xs text-error" role="status" aria-live="polite">{errorText(state.error)}</div>}
    </div>
  );
}
