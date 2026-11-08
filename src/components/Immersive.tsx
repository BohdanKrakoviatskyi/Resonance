import { useEffect, useState } from 'react';
import { IconButton, Menu, usePresence } from './ui';
import { ArtCover } from './Cover';
import { Lyrics } from './Lyrics';
import { Controls, Seek, TimeNow, TimeTotal } from './Seek';
import { DislikeButton, LikeButton, PlaylistPicker, SourcePill } from './TrackList';
import { useStore } from '../lib/util';
import { t } from '../lib/i18n';
import { supportsVT } from '../lib/motion';
import { library } from '../state/library';
import { useCurrentTrack } from '../state/player';
import { openSearch, setImmersive, ui } from '../state/ui';

/** Fullscreen lyrics: artwork + details on the left, animated synced lyrics on the right. */
export function Immersive() {
  const open = useStore(ui, (s) => s.immersive);
  const vt = supportsVT();
  const { mounted, visible } = usePresence(open, vt ? 0 : 480);
  const track = useCurrentTrack();
  const inPlaylist = useStore(library, (s) => !!track && s.playlists.some((p) => p.ids.includes(track.id)));
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [fs, setFs] = useState(false);

  useEffect(() => {
    const f = () => setFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !document.fullscreenElement && !anchor && setImmersive(false);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, anchor]);
  useEffect(() => {
    if (open && !track) setImmersive(false);
  }, [open, track]);

  if (!(vt ? open : mounted)) return null;
  const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});

  return (
    <div className="immersive" data-visible={vt ? true : visible} role="dialog" aria-modal="true" aria-label={t('fullscreenLyrics')}>
      <div className="imm-scrim" />
      <div className="imm-top">
        <div className="flex gap-2">
          {'requestFullscreen' in document.documentElement && (
            <IconButton icon={fs ? 'fullscreen_exit' : 'fullscreen'} label={t('fullscreen')} variant="glass" onClick={toggleFs} tip="bottom" />
          )}
          <IconButton icon="close_fullscreen" label={t('exitFullscreen')} variant="glass" onClick={() => setImmersive(false)} tip="bottom" />
        </div>
      </div>
      {track && (
        <div className="imm-grid">
          <div className="imm-left">
            <ArtCover src={track.cover} vt="np-cover" className="imm-cover" />
            <div key={track.id} className="imm-meta meta-in">
              <h1 className="imm-title display">{track.title}</h1>
              <div className="mt-2 flex items-center gap-2 max-[900px]:justify-center">
                <SourcePill track={track} />
                <button
                  type="button"
                  className="truncate text-lg font-semibold text-on-surface-variant hover:text-primary"
                  onClick={() => {
                    setImmersive(false);
                    openSearch(track.artist);
                  }}
                >
                  {track.artist}
                </button>
              </div>
            </div>
            <div className="imm-actions flex items-center gap-2">
              <LikeButton id={track.id} variant="tonal" />
              <DislikeButton id={track.id} variant="tonal" />
              <IconButton
                icon={inPlaylist ? 'playlist_add_check' : 'playlist_add'}
                label={t('addToPlaylist')}
                variant="tonal"
                selected={!!anchor}
                onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
              />
            </div>
            <div>
              <Seek big />
              <div className="mt-1 flex justify-between">
                <TimeNow className="!text-left" />
                <TimeTotal className="text-right" />
              </div>
            </div>
            <Controls size="lg" />
          </div>
          <div className="imm-right">
            <Lyrics track={track} variant="imm" />
          </div>
          <Menu anchor={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
            <PlaylistPicker id={track.id} onClose={() => setAnchor(null)} />
          </Menu>
        </div>
      )}
    </div>
  );
}
