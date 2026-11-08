import { useEffect, useRef } from 'react';
import { Icon } from './Icon';
import { IconButton } from './ui';
import { ArtCover } from './Cover';
import { Controls, Seek, TimeNow, TimeTotal, Volume } from './Seek';
import { LikeButton, SourcePill } from './TrackList';
import { useMedia, useStore, XL } from '../lib/util';
import { t } from '../lib/i18n';
import { markResizing } from '../lib/motion';
import { onFrame, useCurrentTrack } from '../state/player';
import { openSearch, setImmersive, ui } from '../state/ui';

/** Which surface owns the shared "np-cover" view-transition name (must be unique). */
export function useVtSource(): 'panel' | 'mini' | null {
  const immersive = useStore(ui, (s) => s.immersive);
  const panel = useStore(ui, (s) => s.panel);
  const xl = useMedia(XL);
  if (immersive) return null;
  return xl && panel ? 'panel' : 'mini';
}

function MiniLine() {
  const bar = useRef<HTMLElement>(null);
  useEffect(() => onFrame((ct, d) => bar.current && (bar.current.style.transform = `scaleX(${d ? ct / d : 0})`)), []);
  return (
    <div className="mini-line" aria-hidden="true">
      <i ref={bar} />
    </div>
  );
}

export function MiniPlayer() {
  const track = useCurrentTrack();
  const vt = useVtSource();
  const xl = useMedia(XL);
  const panel = useStore(ui, (s) => s.panel);
  const panelOpen = xl && panel;
  const togglePanel = () => {
    if (xl) {
      markResizing();
      ui.set({ panel: !panel });
    } else ui.set({ npDrawer: true });
  };
  return (
    <div className="mini panel" data-empty={!track}>
      <MiniLine />
      <div className="mini-grid">
        <div className="mini-left">
          <button
            type="button"
            className="mini-cover-btn"
            onClick={() => track && setImmersive(true)}
            aria-label={t('fullscreenLyrics')}
            data-tip={track ? t('fullscreenLyrics') : undefined}
          >
            <ArtCover src={track?.thumb ?? track?.cover} vt={vt === 'mini' && track ? 'np-cover' : undefined} className="mini-cover" />
            {track && (
              <span className="mini-cover-ov">
                <Icon name="open_in_full" />
              </span>
            )}
          </button>
          <div key={track?.id ?? 'none'} className="meta-in min-w-0">
            <div className="truncate text-[15px] font-bold">{track?.title ?? t('nothingPlaying')}</div>
            {track ? (
              <div className="flex min-w-0 items-center gap-1.5">
                <SourcePill track={track} />
                <button type="button" className="truncate text-left text-[13px] text-on-surface-variant hover:text-primary hover:underline" onClick={() => openSearch(track.artist)}>
                  {track.artist}
                </button>
              </div>
            ) : (
              <div className="truncate text-[13px] text-on-surface-variant">{t('pickSomething')}</div>
            )}
          </div>
          {track && <LikeButton id={track.id} size="sm" className="hide-xs" />}
        </div>
        <div className="mini-center">
          <Controls />
          <div className="seek-row">
            <TimeNow />
            <Seek />
            <TimeTotal />
          </div>
        </div>
        <div className="mini-right">
          <IconButton icon="lyrics" label={t('fullscreenLyrics')} onClick={() => setImmersive(true)} disabled={!track} className="hide-md" />
          <IconButton
            icon={panelOpen ? 'right_panel_close' : 'right_panel_open'}
            label={panelOpen ? t('hidePanel') : t('showPanel')}
            toggle
            selected={panelOpen}
            onClick={togglePanel}
            className="hide-xs"
          />
          <Volume className="hide-xs" />
        </div>
      </div>
    </div>
  );
}
