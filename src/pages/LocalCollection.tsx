import { Button, EmptyState, IconButton } from '../components/ui';
import { PlaylistCover } from '../components/Cover';
import { TrackList } from '../components/TrackList';
import { useStore } from '../lib/util';
import { durLabel, t, tracksLabel } from '../lib/i18n';
import { getTrack, library } from '../state/library';
import { player, playQueue, shufflePlay, toggle } from '../state/player';
import { go } from '../state/ui';
import { importFolder } from '../state/local';
import { isAudioFile } from '../lib/local-import';
import { useMemo } from 'react';

export default function LocalCollection({ id }: { id: string }) {
  const folder = useStore(library, (s) => s.localFolders.find((f) => f.id === id));
  const cache = useStore(library, (s) => s.cache);
  const ids = useMemo(
    () => (folder ? folder.trackIds.filter((tid) => !!getTrack(tid)) : []),
    [folder, cache],
  );
  const playingHere = useStore(player, (s) => s.playing && ids.includes(s.queue[s.index]));
  const dropRef = useDropTarget<HTMLDivElement>();
  if (!folder) {
    return (
      <div className="page">
        <EmptyState icon="folder_off" title={t('notFound')} action={<Button icon="home" onClick={() => go({ name: 'home' })}>{t('home')}</Button>} />
      </div>
    );
  }
  const tracks = ids.map((tid) => getTrack(tid)!).filter(Boolean);
  const total = tracks.reduce((a, x) => a + (x.duration ?? 0), 0);
  return (
    <div className="page" ref={dropRef}>
      <header className="anim-in mb-8 mt-2 flex flex-col items-center gap-6 text-center @2xl:flex-row @2xl:items-end @2xl:text-left">
        <PlaylistCover p={{ id: folder.id, name: folder.name, ids: folder.trackIds, created: folder.created }} className="h-[220px] w-[220px] rounded-[36px] shadow-2xl" />
        <div className="min-w-0 flex-1">
          <div className="label-up">{t('localMusic')}</div>
          <h1 className="display my-2 break-words text-[clamp(34px,6.5cqw,72px)]">{folder.name}</h1>
          <div className="font-medium text-on-surface-variant">
            {tracksLabel(ids.length)}
            {total > 0 && ` · ${durLabel(total)}`}
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2 @2xl:justify-start">
            <Button size="lg" icon={playingHere ? 'pause' : 'play_arrow'} disabled={!ids.length} onClick={() => (playingHere ? toggle() : playQueue(ids, 0, false))}>
              {playingHere ? t('pause') : t('play')}
            </Button>
            <Button size="lg" variant="tonal" icon="shuffle" disabled={!ids.length} onClick={() => shufflePlay(ids)}>
              {t('shuffle')}
            </Button>
            <IconButton icon="delete" label={t('removeFolder')} size="lg" onClick={() => void import('../state/local').then((m) => m.removeFolder(folder.id))} />
          </div>
        </div>
      </header>
      {ids.length ? (
        <TrackList ids={ids} />
      ) : (
        <EmptyState
          icon="folder_open"
          title={t('localEmpty')}
          text={t('localEmptyText')}
          action={<Button icon="folder_open" onClick={() => void (async () => { const { pickFolderFiles } = await import('../lib/local-import'); const r = await pickFolderFiles(); if (r) await importFolder(r.files); })()}>{t('chooseFolder')}</Button>}
        />
      )}
    </div>
  );
}

// Drag & drop helper
export function useDropTarget<T extends HTMLElement>() {
  return (el: T | null) => {
    if (!el) return;
    el.ondragover = (e) => { e.preventDefault(); };
    el.ondrop = (e) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => isAudioFile(f.name));
      if (files.length) void importFolder(files);
    };
  };
}
