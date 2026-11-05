import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { IconButton, Shape } from './ui';
import { PlaylistCover, Eq } from './Cover';
import { cx, useStore } from '../lib/util';
import { t, tracksLabel } from '../lib/i18n';
import { markResizing } from '../lib/motion';
import { library, loadYtMusicPlaylistArtwork } from '../state/library';
import { player } from '../state/player';
import { YTMUSIC_LIKED_ID, ytmusicPlaylistId } from '../lib/ytmusic-library';
import { SOUNDCLOUD_LIKED_ID } from '../lib/soundcloud-library';
import { appearance } from '../state/appearance';
import { go, openDialog, routeKey, ui, type Route } from '../state/ui';
import soundcloudLogo from '../assets/soundcloud.svg';
import youtubeMusicLogo from '../assets/youtube-music.svg';

function YtMusicPlaylistCover({ playlistId, title, artworkUrl }: { playlistId: string; title: string; artworkUrl?: string | null }) {
  const artCache = useStore(library, (s) => s.ytmusicPlaylistArt);
  const art = playlistId in artCache ? artCache[playlistId] : undefined;
  useLayoutEffect(() => {
    if (!(playlistId in artCache)) void loadYtMusicPlaylistArtwork(playlistId);
  }, [playlistId, artCache]);
  return <PlaylistCover p={{ id: playlistId, name: title, ids: [], created: 0, artworkUrl: art ?? artworkUrl ?? undefined }} className="h-10 w-10 rounded-[12px]" />;
}

function NavItem({ k, active, expanded, label, labelPrefix, sub, icon, art, onClick, playing, className }: {
  k: string; active: boolean; expanded: boolean; label: string; labelPrefix?: ReactNode; sub?: string; icon?: IconName; art?: ReactNode; onClick: () => void; playing?: boolean; className?: string;
}) {
  return (
    <button
      type="button"
      data-key={k}
      data-ripple
      className={cx('nav-item sl', className)}
      aria-current={active ? 'page' : undefined}
      data-tip={expanded ? undefined : label}
      data-tip-pos="right"
      onClick={onClick}
    >
      <span className="nav-ic">{art ?? (icon && <Icon name={icon} />)}</span>
      <span className="nav-label fade-x">
        <span className="nav-label-main">
          {labelPrefix && <span className="nav-label-prefix">{labelPrefix}</span>}
          <span className="truncate">{label}</span>
        </span>
        {sub && <span className="nav-sub">{sub}</span>}
      </span>
      {playing && <Eq on className="fade-x mr-4" />}
    </button>
  );
}

export function Logo() {
  const paletteStyle = useStore(appearance, (state) => state.bgMode === 'dynamic' && state.bgStyle === 'palette');
  return (
    <Shape n={8} amp={0.1} className={cx('spin-slow h-10 w-10', paletteStyle ? 'text-secondary-container' : 'text-primary')}>
      <Icon name="graphic_eq" size={22} className={paletteStyle ? 'text-on-secondary-container' : 'text-on-primary'} />
    </Shape>
  );
}

function ProviderGroupHeader({
  label,
  logo,
  icon,
  open,
  expanded,
  onToggle,
}: {
  label: string;
  logo?: string;
  icon?: IconName;
  open: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-ripple
      className="side-group sl"
      aria-expanded={open}
      data-tip={expanded ? undefined : `${label} (${open ? t('collapse') : t('expand')})`}
      data-tip-pos="right"
      onClick={onToggle}
    >
      <span className="side-group-ic">
        {logo ? <img src={logo} alt="" aria-hidden="true" /> : icon ? <Icon name={icon} size={20} /> : null}
        <span className="side-group-badge" aria-hidden="true">
          <Icon name="chevron_right" />
        </span>
      </span>
      <span className="side-group-label fade-x">{label}</span>
      <Icon name="chevron_right" className="side-group-chev fade-x" />
    </button>
  );
}

export function Sidebar({ mode }: { mode: 'inline' | 'drawer' }) {
  const expanded = useStore(ui, (s) => mode === 'drawer' || s.sidebar);
  const route = useStore(ui, (s) => s.route);
  const foldYtMusic = useStore(ui, (s) => s.foldYtMusic);
  const foldSoundCloud = useStore(ui, (s) => s.foldSoundCloud);
  const foldLocal = useStore(ui, (s) => s.foldLocal);
  const playlists = useStore(library, (s) => s.playlists);
  const soundcloudPlaylists = useStore(library, (s) => s.soundcloudPlaylists);
  const soundcloudLiked = useStore(library, (s) => s.soundcloudLiked);
  const ytmusicPlaylists = useStore(library, (s) => s.ytmusicPlaylists);
  const ytmusicLiked = useStore(library, (s) => s.ytmusicLiked);
  const ytmusicConnected = useStore(library, (s) => s.ytmusicAuthorized);
  const playing = useStore(player, (s) => s.playing);
  const curId = useStore(player, (s) => s.queue[s.index] ?? null);
  const listRef = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState<{ y: number; h: number } | null>(null);
  const active = routeKey(route);
  const showSoundCloud = soundcloudLiked.length > 0 || soundcloudPlaylists.length > 0;

  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(active)}"]`);
    setInd(el ? { y: el.offsetTop, h: el.offsetHeight } : null);
  }, [
    active,
    playlists.length,
    soundcloudPlaylists.length,
    soundcloudLiked.length,
    ytmusicPlaylists.length,
    ytmusicLiked.length,
    ytmusicConnected,
    expanded,
    foldYtMusic,
    foldSoundCloud,
    foldLocal,
  ]);

  const nav = (r: Route) => go(r);
  const toggleExpanded = () => {
    markResizing();
    ui.set({ sidebar: !expanded });
  };

  return (
    <nav className="panel panel-side sidebar" data-expanded={expanded} aria-label="Resonance">
      <div className="side-brand">
        {mode === 'inline' ? (
          <IconButton icon={expanded ? 'menu_open' : 'menu'} label={expanded ? t('collapse') : t('expand')} tip="right" onClick={toggleExpanded} />
        ) : (
          <Logo />
        )}
        <span className="fade-x flex min-w-0 items-center gap-2.5">
          {mode === 'inline' && <Logo />}
          <span className="display text-[24px]">Resonance</span>
        </span>
      </div>
      <div ref={listRef} className="side-scroll">
        <div className="side-indicator" style={{ transform: `translateY(${ind?.y ?? 0}px)`, height: ind?.h ?? 52, opacity: ind ? 1 : 0 }} />
        <NavItem k="home" icon="home" label={t('home')} active={active === 'home'} expanded={expanded} onClick={() => nav({ name: 'home' })} />
        <NavItem k="search" icon="search" label={t('search')} active={active === 'search'} expanded={expanded} onClick={() => nav({ name: 'search', q: '' })} />
        <NavItem k="favorites" icon="favorite" label={t('favorites')} active={active === 'favorites'} expanded={expanded} onClick={() => nav({ name: 'favorites' })} />
        <div className="side-section">
          <span className="label-up fade-x">{t('playlists')}</span>
          <IconButton icon="add" label={t('newPlaylist')} size="sm" variant="tonal" tip="right" onClick={() => openDialog({ kind: 'create' })} />
        </div>
        {ytmusicConnected && (
          <>
            <ProviderGroupHeader
              label="YouTube Music"
              logo={soundcloudLogo}
              open={!foldYtMusic}
              expanded={expanded}
              onToggle={() => ui.set({ foldYtMusic: !foldYtMusic })}
            />
            {!foldYtMusic && (
              <>
                <NavItem
                  k={'pl:' + YTMUSIC_LIKED_ID}
                  icon="favorite"
                  label={t('ytmusicLiked')}
                  labelPrefix={<img src={soundcloudLogo} alt="" aria-hidden="true" />}
                  sub={tracksLabel(ytmusicLiked.length)}
                  active={active === 'pl:' + YTMUSIC_LIKED_ID}
                  expanded={expanded}
                  playing={playing && !!curId && ytmusicLiked.some((track) => track.id === curId) && active === 'pl:' + YTMUSIC_LIKED_ID}
                  onClick={() => nav({ name: 'playlist', id: YTMUSIC_LIKED_ID })}
                />
                {ytmusicPlaylists.map((p) => (
                  <NavItem
                    key={`yt:${p.playlistId}`}
                    k={'pl:' + ytmusicPlaylistId(p.playlistId)}
                    label={p.title}
                    labelPrefix={<img src={soundcloudLogo} alt="" aria-hidden="true" />}
                    sub={tracksLabel(p.trackCount)}
                    active={active === 'pl:' + ytmusicPlaylistId(p.playlistId)}
                    expanded={expanded}
                    playing={playing && !!curId && (library.get().ytmusicPlaylistTracks[p.playlistId] ?? []).some((track) => track.id === curId) && active === 'pl:' + ytmusicPlaylistId(p.playlistId)}
                    art={<YtMusicPlaylistCover playlistId={p.playlistId} title={p.title} artworkUrl={p.artworkUrl} />}
                    onClick={() => nav({ name: 'playlist', id: ytmusicPlaylistId(p.playlistId) })}
                  />
                ))}
              </>
            )}
          </>
        )}
        {showSoundCloud && (
          <>
            <ProviderGroupHeader
              label="SoundCloud"
              logo={youtubeMusicLogo}
              open={!foldSoundCloud}
              expanded={expanded}
              onToggle={() => ui.set({ foldSoundCloud: !foldSoundCloud })}
            />
            {!foldSoundCloud && (
              <>
                <NavItem
                  k={'pl:' + SOUNDCLOUD_LIKED_ID}
                  icon="favorite"
                  label={t('soundcloudLiked')}
                  labelPrefix={<img src={youtubeMusicLogo} alt="" aria-hidden="true" />}
                  sub={tracksLabel(soundcloudLiked.length)}
                  active={active === 'pl:' + SOUNDCLOUD_LIKED_ID}
                  expanded={expanded}
                  playing={false}
                  onClick={() => nav({ name: 'playlist', id: SOUNDCLOUD_LIKED_ID })}
                />
                {soundcloudPlaylists.map((p) => (
                  <NavItem
                    key={`sc:${p.id}`}
                    k={'pl:scpl:' + p.id}
                    label={p.name}
                    labelPrefix={<img src={youtubeMusicLogo} alt="" aria-hidden="true" />}
                    sub={tracksLabel(p.trackCount)}
                    active={active === 'pl:scpl:' + p.id}
                    expanded={expanded}
                    playing={playing && !!curId && (library.get().soundcloudPlaylistTracks[p.urn] ?? []).some((track) => track.id === curId) && active === 'pl:scpl:' + p.id}
                    art={<PlaylistCover p={{ id: p.id, name: p.name, ids: [], created: 0, artworkUrl: p.artworkUrl }} className="h-10 w-10 rounded-[12px]" />}
                    onClick={() => nav({ name: 'playlist', id: `scpl:${p.id}` })}
                  />
                ))}
              </>
            )}
          </>
        )}
        {playlists.length > 0 && (
          <>
            {(ytmusicConnected || showSoundCloud) && (
              <ProviderGroupHeader
                label={t('playlists')}
                icon="queue_music"
                open={!foldLocal}
                expanded={expanded}
                onToggle={() => ui.set({ foldLocal: !foldLocal })}
              />
            )}
            {(!foldLocal || (!ytmusicConnected && !showSoundCloud)) &&
              playlists.map((p) => (
                <NavItem
                  key={p.id}
                  k={'pl:' + p.id}
                  label={p.name}
                  sub={tracksLabel(p.ids.length)}
                  active={active === 'pl:' + p.id}
                  expanded={expanded}
                  playing={playing && !!curId && p.ids.includes(curId) && active === 'pl:' + p.id}
                  art={<PlaylistCover p={p} className="h-10 w-10 rounded-[12px]" />}
                  onClick={() => nav({ name: 'playlist', id: p.id })}
                />
              ))}
          </>
        )}
      </div>
      <div className="side-bottom">
        <NavItem k="providers" icon="music_note" label={t('providers')} active={active === 'providers'} expanded={expanded} onClick={() => nav({ name: 'providers' })} />
        <NavItem k="appearance" icon="palette" label={t('appearance')} active={active === 'appearance'} expanded={expanded} onClick={() => nav({ name: 'appearance' })} />
      </div>
    </nav>
  );
}
