import { useEffect, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { Button, Segmented } from './ui';
import { Cover } from './Cover';
import { ImportReviewDialog } from './ImportReviewDialog';
import { cx, useStore } from '../lib/util';
import { pick, t } from '../lib/i18n';
import { clearAppCache } from '../state/cache';
import {
  createPlaylist,
  deletePlaylist,
  getTrack,
  isLiked,
  library,
  renamePlaylist,
  toggleLike,
  togglePlaylistTrack,
} from '../state/library';
import { detectImportSource, importStore, startPlaylistImport } from '../state/import';
import { addToQueue, playNextInQueue } from '../state/player';
import { closeTrackMenu, openDialog, openSearch, snack, ui } from '../state/ui';

function ActionRow({ icon, label, onClick, danger }: { icon: IconName; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'sl flex w-full items-center gap-3.5 rounded-2xl px-4 py-3.5 text-left text-[15px] font-semibold',
        danger ? 'text-error' : 'text-on-surface',
      )}
    >
      <Icon name={icon} size={22} />
      <span>{label}</span>
    </button>
  );
}

function TrackActionSheet() {
  const trackId = useStore(ui, (s) => s.trackMenuId);
  const liked = useStore(library, () => (trackId ? isLiked(trackId) : false));
  if (!trackId) return null;
  const track = getTrack(trackId);
  if (!track) return null;

  const close = () => closeTrackMenu();

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/55" onClick={close}>
      <div
        className="rounded-t-[30px] bg-sc-high px-4 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] pt-3 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-on-surface/25" />
        <div className="mb-2 flex items-center gap-3 border-b border-outline-variant/30 px-2 pb-3">
          <Cover src={track.thumb || track.cover} className="h-12 w-12 shrink-0 rounded-xl" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-bold">{track.title}</div>
            <div className="truncate text-xs text-on-surface-variant">{track.artist}</div>
          </div>
        </div>

        <ActionRow
          icon="queue_play_next"
          label={t('playNext')}
          onClick={() => {
            close();
            void playNextInQueue(track);
          }}
        />
        <ActionRow
          icon="add_to_queue"
          label={t('addToQueue')}
          onClick={() => {
            close();
            void addToQueue(track);
          }}
        />
        <ActionRow
          icon="favorite"
          label={liked ? t('unlike') : t('like')}
          onClick={() => {
            close();
            toggleLike(track.id);
          }}
        />
        <ActionRow
          icon="playlist_add"
          label={t('addToPlaylist')}
          onClick={() => {
            close();
            openDialog({ kind: 'add-to-playlist', trackId: track.id });
          }}
        />
        <ActionRow
          icon="person"
          label={t('goToArtist')}
          onClick={() => {
            close();
            openSearch(track.artist);
          }}
        />
      </div>
    </div>
  );
}

function CreateOrImportDialog({
  trackId,
  initialTab = 'scratch',
  onClose,
}: {
  trackId?: string;
  initialTab?: 'scratch' | 'import';
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'scratch' | 'import'>(initialTab);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'playlist' | 'sc_likes'>('playlist');
  const [linkInput, setLinkInput] = useState('');
  const [customName, setCustomName] = useState('');
  const [err, setErr] = useState('');
  const importing = useStore(importStore, (s) => s.active);

  const detected = detectImportSource(linkInput, mode);

  const submitScratch = () => {
    const trimmed = name.trim() || t('newPlaylist');
    createPlaylist(trimmed, trackId);
    onClose();
  };

  const submitImport = async () => {
    setErr('');
    if (!linkInput.trim()) {
      setErr(mode === 'sc_likes' ? t('importEnterUserFirst') : t('importPasteLinkFirst'));
      return;
    }
    try {
      onClose();
      await startPlaylistImport({
        input: linkInput.trim(),
        mode,
        customName: customName.trim() || undefined,
        pendingTrackId: trackId,
      });
    } catch (e) {
      snack(e instanceof Error ? e.message : t('importFailed'));
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-[420px] rounded-[28px] bg-sc-high p-5 text-on-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="headline mb-3 text-xl">{t('newPlaylist')}</h2>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'scratch', label: t('importTabScratch') },
            { value: 'import', label: t('importTabImport') },
          ]}
        />

        {tab === 'scratch' ? (
          <div className="mt-4 flex flex-col gap-3">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('playlistName')}
              className="h-12 w-full rounded-2xl bg-sc-highest px-4 text-base outline-none"
              autoFocus
            />
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="text" onClick={onClose}>
                {t('cancel')}
              </Button>
              <Button variant="filled" onClick={submitScratch}>
                {t('create')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            <Segmented
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'playlist', label: t('importModePlaylist') },
                { value: 'sc_likes', label: t('importModeScLikes') },
              ]}
            />
            <input
              type="text"
              value={linkInput}
              onChange={(e) => {
                setLinkInput(e.target.value);
                setErr('');
              }}
              placeholder={mode === 'sc_likes' ? t('importScUserLabel') : t('importLinkLabel')}
              className="h-12 w-full rounded-2xl bg-sc-highest px-4 text-sm outline-none"
            />
            {detected && (
              <div className="text-xs font-semibold text-primary">
                {pick('Источник', 'Detected')}: {detected.label}
              </div>
            )}
            <input
              type="text"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder={t('importCustomNameLabel')}
              className="h-12 w-full rounded-2xl bg-sc-highest px-4 text-sm outline-none"
            />
            <p className="text-xs text-on-surface-variant">
              {mode === 'sc_likes' ? t('importScLikesHint') : t('importSourcesHint')}
            </p>
            {err && <p className="text-xs font-semibold text-error">{err}</p>}
            <div className="mt-1 flex justify-end gap-2">
              <Button variant="text" onClick={onClose}>
                {t('cancel')}
              </Button>
              <Button variant="filled" disabled={importing} onClick={() => void submitImport()}>
                {t('importStartBtn')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AddToPlaylistDialog({ trackId, onClose }: { trackId: string; onClose: () => void }) {
  const playlists = useStore(library, (s) => s.playlists);
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/55" onClick={onClose}>
      <div
        className="max-h-[75dvh] overflow-y-auto rounded-t-[30px] bg-sc-high px-4 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] pt-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between px-2">
          <h2 className="headline text-lg">{t('addToPlaylist')}</h2>
          <Button
            variant="tonal"
            icon="add"
            onClick={() => openDialog({ kind: 'create', trackId, initialTab: 'scratch' })}
          >
            {t('create')}
          </Button>
        </div>
        {playlists.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-on-surface-variant">{t('playlistEmptyText')}</p>
        ) : (
          <div className="flex flex-col gap-1">
            {playlists.map((pl) => {
              const has = pl.ids.includes(trackId);
              return (
                <button
                  key={pl.id}
                  type="button"
                  onClick={() => {
                    togglePlaylistTrack(pl.id, trackId);
                    onClose();
                  }}
                  className="sl flex items-center justify-between rounded-2xl px-4 py-3 text-left"
                >
                  <span className="font-semibold">{pl.name}</span>
                  {has && <Icon name="check" className="text-primary" />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function SnackToast() {
  const s = useStore(ui, (st) => st.snack);
  useEffect(() => {
    if (!s) return;
    const tm = window.setTimeout(() => {
      if (ui.get().snack?.id === s.id) ui.set({ snack: null });
    }, 3600);
    return () => window.clearTimeout(tm);
  }, [s]);

  if (!s) return null;
  return (
    <div className="pointer-events-auto fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom,0px)+142px)] z-50 mx-auto flex max-w-md items-center justify-between gap-2 rounded-2xl bg-inverse-surface px-4 py-3 text-sm font-semibold text-inverse-on-surface shadow-xl">
      <span className="truncate">{s.text}</span>
      {s.action && (
        <button
          type="button"
          onClick={() => {
            s.action?.run();
            ui.set({ snack: null });
          }}
          className="shrink-0 font-extrabold text-inverse-primary"
        >
          {s.action.label}
        </button>
      )}
    </div>
  );
}

export function MobileOverlays() {
  const dialog = useStore(ui, (s) => s.dialog);
  const playlists = useStore(library, (s) => s.playlists);
  const [renameText, setRenameText] = useState('');
  const [clearing, setClearing] = useState(false);

  const closeDialog = () => ui.set({ dialog: null });

  useEffect(() => {
    if (dialog?.kind === 'rename') {
      const pl = playlists.find((p) => p.id === dialog.id);
      setRenameText(pl?.name ?? '');
    }
  }, [dialog, playlists]);

  return (
    <>
      <TrackActionSheet />
      <SnackToast />

      {dialog?.kind === 'create' && (
        <CreateOrImportDialog trackId={dialog.trackId} initialTab={dialog.initialTab} onClose={closeDialog} />
      )}

      {dialog?.kind === 'add-to-playlist' && <AddToPlaylistDialog trackId={dialog.trackId} onClose={closeDialog} />}

      {dialog?.kind === 'import-review' && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-3" onClick={closeDialog}>
          <div
            className="flex max-h-[88dvh] w-full max-w-xl flex-col rounded-[28px] bg-sc-high p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <ImportReviewDialog onClose={closeDialog} />
          </div>
        </div>
      )}

      {dialog?.kind === 'rename' && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={closeDialog}>
          <div
            className="w-full max-w-sm rounded-[28px] bg-sc-high p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="headline mb-3 text-xl">{t('rename')}</h2>
            <input
              type="text"
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              className="h-12 w-full rounded-2xl bg-sc-highest px-4 text-base outline-none"
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="text" onClick={closeDialog}>
                {t('cancel')}
              </Button>
              <Button
                variant="filled"
                onClick={() => {
                  if (renameText.trim()) renamePlaylist(dialog.id, renameText.trim());
                  closeDialog();
                }}
              >
                {t('save')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {dialog?.kind === 'delete' && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={closeDialog}>
          <div
            className="w-full max-w-sm rounded-[28px] bg-sc-high p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="headline mb-2 text-xl">{t('deletePlaylistQ')}</h2>
            <p className="text-sm text-on-surface-variant">
              {t('deletePlaylistText', {
                name: playlists.find((p) => p.id === dialog.id)?.name ?? '',
              })}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="text" onClick={closeDialog}>
                {t('cancel')}
              </Button>
              <Button
                variant="filled"
                onClick={() => {
                  deletePlaylist(dialog.id);
                  closeDialog();
                }}
              >
                {t('delete')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {dialog?.kind === 'clear-cache' && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={closeDialog}>
          <div
            className="w-full max-w-sm rounded-[28px] bg-sc-high p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="headline mb-2 text-xl">{t('clearCacheTitle')}</h2>
            <p className="text-sm text-on-surface-variant">{t('clearCacheText')}</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="text" disabled={clearing} onClick={closeDialog}>
                {t('cancel')}
              </Button>
              <Button
                variant="filled"
                disabled={clearing}
                onClick={async () => {
                  setClearing(true);
                  try {
                    const res = await clearAppCache();
                    const mb = (res.audioBytesFreed / (1024 * 1024)).toFixed(1);
                    snack(`${t('clearCacheDone')} (${mb} MB)`);
                    closeDialog();
                  } catch (e) {
                    snack(t('clearCacheError', { reason: e instanceof Error ? e.message : String(e) }));
                  } finally {
                    setClearing(false);
                  }
                }}
              >
                {t('clearCacheBtn')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
