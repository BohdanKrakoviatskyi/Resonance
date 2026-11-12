import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { Button, IconButton, Loader, usePresence } from './ui';
import { cx, useStore } from '../lib/util';
import { t } from '../lib/i18n';
import { createPlaylist, deletePlaylist, library, renamePlaylist } from '../state/library';
import { checkForUpdates, runAppUninstall, startInstallNewVersion, updater } from '../state/updater';
import { clearAppCache } from '../state/cache';
import { go, openDialog, snack, ui, type Dialog, type Snack } from '../state/ui';

export function Drawer({ open, onClose, side, children }: { open: boolean; onClose: () => void; side: 'left' | 'right'; children: ReactNode }) {
  const { mounted, visible } = usePresence(open, 450);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!mounted) return null;
  return createPortal(
    <div className="drawer-root" data-open={visible} data-side={side}>
      <div className="scrim" onClick={onClose} />
      <div className="drawer">{children}</div>
    </div>,
    document.body,
  );
}

const closeDialog = () => ui.set({ dialog: null });

function NameDialog({ d }: { d: Extract<Dialog, { kind: 'create' | 'rename' }> }) {
  const existing = useStore(library, (s) => (d.kind === 'rename' ? s.playlists.find((p) => p.id === d.id)?.name ?? '' : ''));
  const [name, setName] = useState(existing);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const tm = setTimeout(() => input.current?.select(), 60);
    return () => clearTimeout(tm);
  }, []);
  const submit = () => {
    if (d.kind === 'rename') renamePlaylist(d.id, name);
    else {
      const id = createPlaylist(name || t('newPlaylist'), d.trackId);
      if (!d.trackId) go({ name: 'playlist', id });
    }
    closeDialog();
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h2 className="headline mb-5 text-2xl">{d.kind === 'rename' ? t('rename') : t('newPlaylist')}</h2>
      <label className="field">
        <input ref={input} value={name} onChange={(e) => setName(e.target.value)} placeholder=" " maxLength={60} autoFocus />
        <span>{t('playlistName')}</span>
      </label>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="text" onClick={closeDialog}>
          {t('cancel')}
        </Button>
        <Button type="submit" icon={d.kind === 'rename' ? 'check' : 'add'}>
          {d.kind === 'rename' ? t('save') : t('create')}
        </Button>
      </div>
    </form>
  );
}

function DeleteDialog({ id }: { id: string }) {
  const name = useStore(library, (s) => s.playlists.find((p) => p.id === id)?.name ?? '');
  return (
    <div>
      <h2 className="headline mb-3 text-2xl">{t('deletePlaylistQ')}</h2>
      <p className="text-on-surface-variant">{t('deletePlaylistText', { name })}</p>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="text" onClick={closeDialog}>
          {t('cancel')}
        </Button>
        <Button
          icon="delete"
          className="!bg-error !text-[var(--md-on-error)]"
          onClick={() => {
            deletePlaylist(id);
            closeDialog();
          }}
        >
          {t('delete')}
        </Button>
      </div>
    </div>
  );
}

function UpdateDialog() {
  const st = useStore(updater, (s) => s);
  const [installing, setInstalling] = useState(false);
  const busy = installing || st.installing;

  useEffect(() => {
    void checkForUpdates();
  }, []);

  const onInstall = async () => {
    setInstalling(true);
    try {
      await startInstallNewVersion();
    } catch {
      /* error state is captured in updater store */
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div>
      <h2 className="headline mb-3 text-2xl">{st.available ? t('updateAvailable') : t('updates')}</h2>
      {st.checking ? (
        <div className="my-6 flex items-center gap-3 text-on-surface-variant">
          <Loader size={28} />
          <span>{t('updateChecking')}</span>
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          <div className="flex justify-between rounded-2xl bg-sc-low px-4 py-2.5">
            <span className="text-on-surface-variant">{t('updateCurrentVer')}</span>
            <span className="font-semibold">v{st.currentVersion}</span>
          </div>
          <div className="flex justify-between rounded-2xl bg-sc-low px-4 py-2.5">
            <span className="text-on-surface-variant">{t('updateLatestVer')}</span>
            <span className={cx('font-semibold', st.available && 'text-primary')}>v{st.latestVersion}</span>
          </div>
          {busy && (
            <div className="pt-2">
              <div className="mb-1.5 flex items-center justify-between text-xs font-semibold text-on-surface-variant">
                <span>{st.progress >= 100 ? t('splashInstalling') : t('splashUpdating')}</span>
                <span className="tabular-nums text-primary">{st.progress}%</span>
              </div>
              <div className="splash-progress-track">
                <div
                  className="splash-progress-fill"
                  style={{ width: `${Math.max(4, Math.min(100, st.progress))}%` }}
                />
              </div>
            </div>
          )}
          {!st.available && !st.error && !busy && (
            <p className="pt-2 text-on-surface-variant">{t('updateUpToDate')}</p>
          )}
          {st.error && (
            <p className="pt-2 text-error">{st.error}</p>
          )}
        </div>
      )}
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="text" disabled={busy} onClick={closeDialog}>
          {t('closeBtn')}
        </Button>
        {st.available ? (
          <Button icon="download" disabled={busy || st.checking} onClick={() => void onInstall()}>
            {t('updateInstallBtn')}
          </Button>
        ) : (
          <Button variant="tonal" icon="refresh" disabled={busy || st.checking} onClick={() => void checkForUpdates(true)}>
            {t('updateCheckAgainBtn')}
          </Button>
        )}
      </div>
    </div>
  );
}

function UpdateUninstallDialog() {
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <h2 className="headline mb-3 text-2xl">{t('updateStartedTitle')}</h2>
      <p className="text-sm leading-relaxed text-on-surface-variant">{t('updateStartedText')}</p>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="text" onClick={closeDialog}>
          {t('closeBtn')}
        </Button>
        <Button
          icon="delete"
          disabled={busy}
          className="!bg-error !text-[#fff]"
          onClick={() => {
            setBusy(true);
            void runAppUninstall().finally(() => setBusy(false));
          }}
        >
          {t('uninstallBtn')}
        </Button>
      </div>
    </div>
  );
}

function UninstallDialog() {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <h2 className="headline mb-3 text-2xl">{t('uninstallTitle')}</h2>
      <p className="text-sm leading-relaxed text-on-surface-variant">{t('uninstallText')}</p>
      <button
        type="button"
        data-ripple
        className="sl mt-4 flex w-full items-center gap-3 rounded-2xl bg-sc-low px-4 py-3 text-left text-sm font-semibold"
        onClick={() => setConfirmed((v) => !v)}
      >
        <span className={cx('check', confirmed && 'on')}>
          <Icon name="check" />
        </span>
        <span className="flex-1">{t('uninstallConfirmCheck')}</span>
      </button>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="text" onClick={closeDialog}>
          {t('cancel')}
        </Button>
        <Button
          icon="delete"
          disabled={!confirmed || busy}
          className="!bg-error !text-[#fff]"
          onClick={() => {
            setBusy(true);
            void runAppUninstall().finally(() => setBusy(false));
          }}
        >
          {t('uninstallBtn')}
        </Button>
      </div>
    </div>
  );
}

function ClearCacheDialog() {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div>
      <h2 className="headline mb-3 text-2xl">{t('clearCacheTitle')}</h2>
      <p className="text-sm leading-relaxed text-on-surface-variant">{t('clearCacheText')}</p>
      <button
        type="button"
        data-ripple
        className="sl mt-4 flex w-full items-center gap-3 rounded-2xl bg-sc-low px-4 py-3 text-left text-sm font-semibold"
        onClick={() => setConfirmed((v) => !v)}
      >
        <span className={cx('check', confirmed && 'on')}>
          <Icon name="check" />
        </span>
        <span className="flex-1">{t('clearCacheConfirmCheck')}</span>
      </button>
      {error && <p className="mt-3 text-sm text-error">{error}</p>}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="text" onClick={closeDialog}>
          {t('cancel')}
        </Button>
        <Button
          icon="history"
          disabled={!confirmed || busy}
          className="!bg-[color-mix(in_oklab,var(--md-on-surface)_12%,var(--md-surface-container-highest))] !text-[var(--md-on-surface)]"
          onClick={() => {
            setBusy(true);
            setError('');
            void clearAppCache()
              .then(() => {
                closeDialog();
                snack(t('clearCacheDone'));
              })
              .catch((e) => setError(t('clearCacheError', { reason: e instanceof Error ? e.message : String(e) })))
              .finally(() => setBusy(false));
          }}
        >
          {t('clearCacheBtn')}
        </Button>
      </div>
    </div>
  );
}

function DialogHost() {
  const d = useStore(ui, (s) => s.dialog);
  const [last, setLast] = useState<Dialog | null>(d);
  if (d && d !== last) setLast(d);
  const { mounted, visible } = usePresence(!!d, 320);
  useEffect(() => {
    if (!d) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && closeDialog();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [d]);
  if (!mounted || !last) return null;
  return createPortal(
    <div className="dialog-root" data-open={visible}>
      <div className="scrim" onClick={closeDialog} />
      <div className="dialog" role="dialog" aria-modal="true">
        {last.kind === 'delete' ? (
          <DeleteDialog id={last.id} />
        ) : last.kind === 'update' ? (
          <UpdateDialog />
        ) : last.kind === 'update-uninstall' ? (
          <UpdateUninstallDialog />
        ) : last.kind === 'uninstall' ? (
          <UninstallDialog />
        ) : last.kind === 'clear-cache' ? (
          <ClearCacheDialog />
        ) : (
          <NameDialog key={JSON.stringify(last)} d={last} />
        )}
      </div>
    </div>,
    document.body,
  );
}

function SnackHost() {
  const s = useStore(ui, (x) => x.snack);
  const [last, setLast] = useState<Snack | null>(s);
  if (s && s !== last) setLast(s);
  const { mounted, visible } = usePresence(!!s, 320);
  useEffect(() => {
    if (!s) return;
    const tm = setTimeout(() => ui.set({ snack: null }), s.action ? 5000 : 3200);
    return () => clearTimeout(tm);
  }, [s]);
  if (!mounted || !last) return null;
  return createPortal(
    <div className="snackbar" data-open={visible} role="status">
      <span key={last.id} className="meta-in min-w-0 flex-1 py-2">
        {last.text}
      </span>
      {last.action && (
        <button
          type="button"
          data-ripple
          className="snack-action sl"
          onClick={() => {
            const run = last.action?.run;
            ui.set({ snack: null });
            run?.();
          }}
        >
          {last.action.label}
        </button>
      )}
      <IconButton icon="close" label={t('exitFullscreen')} size="sm" tip={false} onClick={() => ui.set({ snack: null })} />
    </div>,
    document.body,
  );
}

export function Overlays() {
  return (
    <>
      <DialogHost />
      <SnackHost />
    </>
  );
}
