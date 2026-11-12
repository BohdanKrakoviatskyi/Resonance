import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { IconButton } from './ui';
import { PlaylistCover, Eq } from './Cover';
import { blobPath, cx, useStore } from '../lib/util';
import { t, tracksLabel } from '../lib/i18n';
import { markResizing } from '../lib/motion';
import { library, loadYtMusicPlaylistArtwork } from '../state/library';
import { player } from '../state/player';
import { ytmusicPlaylistId } from '../lib/ytmusic-library';
import { appearance } from '../state/appearance';
import { updater } from '../state/updater';
import { go, openDialog, routeKey, ui, type Route } from '../state/ui';
import rsMark from '../assets/rs-mark.png';
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

function NavItem({ k, active, expanded, label, labelPrefix, sub, icon, art, badge, onClick, playing, className }: {
  k: string; active: boolean; expanded: boolean; label: string; labelPrefix?: ReactNode; sub?: string; icon?: IconName; art?: ReactNode; badge?: boolean; onClick: () => void; playing?: boolean; className?: string;
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
      <span className="nav-ic relative">
        {art ?? (icon && <Icon name={icon} />)}
        {badge && <span className="absolute right-3.5 top-3 h-2.5 w-2.5 rounded-full bg-[#ff3b30] ring-2 ring-[var(--md-surface-container-low)]" aria-hidden="true" />}
      </span>
      <span className="nav-label fade-x">
        <span className="nav-label-main">
          {labelPrefix && <span className="nav-label-prefix">{labelPrefix}</span>}
          <span className="truncate">{label}</span>
          {badge && <span className="ml-auto h-2.5 w-2.5 shrink-0 rounded-full bg-[#ff3b30]" aria-hidden="true" />}
        </span>
        {sub && <span className="nav-sub">{sub}</span>}
      </span>
      {playing && <Eq on className="fade-x mr-4" />}
    </button>
  );
}

const LOGO_SHAPES = [
  blobPath(10, 0.025, 64),
  blobPath(5, 0.14, 64),
  blobPath(8, 0.09, 64),
  blobPath(4, 0.17, 64),
  blobPath(7, 0.11, 64),
  blobPath(12, 0.06, 64),
  blobPath(6, 0.13, 64),
  blobPath(3, 0.15, 64),
  blobPath(9, 0.08, 64),
  blobPath(11, 0.07, 64),
];
let logoMorphInjected = false;
function injectLogoMorph() {
  if (logoMorphInjected) return;
  logoMorphInjected = true;
  const s = document.createElement('style');
  s.textContent = `@keyframes rs-logo-morph{${LOGO_SHAPES.map((p, i) => `${((i / LOGO_SHAPES.length) * 100).toFixed(2)}%{d:path("${p}")}`).join('')}100%{d:path("${LOGO_SHAPES[0]}")}}`;
  document.head.appendChild(s);
}

export function Logo() {
  injectLogoMorph();
  const paletteStyle = useStore(appearance, (state) => state.bgMode === 'dynamic' && state.bgStyle === 'palette');
  const markColor = paletteStyle ? 'var(--md-on-secondary-container)' : 'var(--md-on-primary)';
  return (
    <span className={cx('shape spin-slow h-10 w-10', paletteStyle ? 'text-secondary-container' : 'text-primary')}>
      <svg viewBox="0 0 1 1" aria-hidden="true">
        <path d={LOGO_SHAPES[0]} style={{ animation: 'rs-logo-morph 18s var(--ease-emph) infinite' }} />
      </svg>
      <span
        aria-hidden="true"
        className="block h-[13px] w-[19px]"
        style={{
          backgroundColor: markColor,
          WebkitMaskImage: `url(${rsMark})`,
          maskImage: `url(${rsMark})`,
          WebkitMaskSize: 'contain',
          maskSize: 'contain',
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center',
          maskPosition: 'center',
        }}
      />
    </span>
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
  const ytmusicPlaylists = useStore(library, (s) => s.ytmusicPlaylists);
  const ytmusicConnected = useStore(library, (s) => s.ytmusicAuthorized);
  const playing = useStore(player, (s) => s.playing);
  const curId = useStore(player, (s) => s.queue[s.index] ?? null);
  const updateAvailable = useStore(updater, (s) => s.available);
  const latestVersion = useStore(updater, (s) => s.latestVersion);
  const listRef = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState<{ y: number; h: number } | null>(null);
  const active = routeKey(route);
  const showYtMusic = ytmusicPlaylists.length > 0;
  const showSoundCloud = soundcloudPlaylists.length > 0;

  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(active)}"]`);
    setInd(el ? { y: el.offsetTop, h: el.offsetHeight } : null);
  }, [
    active,
    playlists.length,
    soundcloudPlaylists.length,
    ytmusicPlaylists.length,
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
        <NavItem k="favorites" icon="favorite" label={t('favorites')} active={active === 'favorites'} expanded={expanded} onClick={() => nav({ name: 'favorites' })} />
        <div className="side-section">
          <span className="label-up fade-x">{t('playlists')}</span>
          <IconButton icon="add" label={t('newPlaylist')} size="sm" variant="tonal" tip="right" onClick={() => openDialog({ kind: 'create' })} />
        </div>
        {showYtMusic && (
          <>
            <ProviderGroupHeader
              label="YouTube Music"
              logo={youtubeMusicLogo}
              open={!foldYtMusic}
              expanded={expanded}
              onToggle={() => ui.set({ foldYtMusic: !foldYtMusic })}
            />
            {!foldYtMusic &&
              ytmusicPlaylists.map((p) => {
                const loadedCount = library.get().ytmusicPlaylistTracks[p.playlistId]?.length;
                const count = Number(p.trackCount) > 0 ? p.trackCount : loadedCount ?? p.trackCount ?? 0;
                return (
                  <NavItem
                    key={`yt:${p.playlistId}`}
                    k={'pl:' + ytmusicPlaylistId(p.playlistId)}
                    label={p.title}
                    labelPrefix={<img src={youtubeMusicLogo} alt="" aria-hidden="true" />}
                    sub={tracksLabel(count)}
                    active={active === 'pl:' + ytmusicPlaylistId(p.playlistId)}
                    expanded={expanded}
                    playing={playing && !!curId && (library.get().ytmusicPlaylistTracks[p.playlistId] ?? []).some((track) => track.id === curId) && active === 'pl:' + ytmusicPlaylistId(p.playlistId)}
                    art={<YtMusicPlaylistCover playlistId={p.playlistId} title={p.title} artworkUrl={p.artworkUrl} />}
                    onClick={() => nav({ name: 'playlist', id: ytmusicPlaylistId(p.playlistId) })}
                  />
                );
              })}
          </>
        )}
        {showSoundCloud && (
          <>
            <ProviderGroupHeader
              label="SoundCloud"
              logo={soundcloudLogo}
              open={!foldSoundCloud}
              expanded={expanded}
              onToggle={() => ui.set({ foldSoundCloud: !foldSoundCloud })}
            />
            {!foldSoundCloud &&
              soundcloudPlaylists.map((p) => (
                <NavItem
                  key={`sc:${p.id}`}
                  k={'pl:scpl:' + p.id}
                  label={p.name}
                  labelPrefix={<img src={soundcloudLogo} alt="" aria-hidden="true" />}
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
        {playlists.length > 0 && (
          <>
            {(showYtMusic || showSoundCloud) && (
              <ProviderGroupHeader
                label={t('playlists')}
                icon="queue_music"
                open={!foldLocal}
                expanded={expanded}
                onToggle={() => ui.set({ foldLocal: !foldLocal })}
              />
            )}
            {(!foldLocal || (!showYtMusic && !showSoundCloud)) &&
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
        <NavItem
          k="updates"
          icon="download"
          label={t('updates')}
          sub={updateAvailable ? `v${latestVersion}` : undefined}
          badge={updateAvailable}
          active={false}
          expanded={expanded}
          onClick={() => openDialog({ kind: 'update' })}
        />
        <NavItem
          k="settings"
          icon="settings"
          label={t('settings')}
          active={active === 'settings' || active === 'appearance' || active === 'providers' || active === 'shortcuts' || active === 'audio'}
          expanded={expanded}
          onClick={() => nav({ name: 'settings' })}
        />
      </div>
    </nav>
  );
}
