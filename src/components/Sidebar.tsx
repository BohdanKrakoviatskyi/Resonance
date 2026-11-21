import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';
import { IconButton, Loader } from './ui';
import { PlaylistCover, Eq } from './Cover';
import { blobPath, cx, useStore } from '../lib/util';
import { t, tracksLabel, useLang } from '../lib/i18n';
import { markResizing } from '../lib/motion';
import { library, loadYtMusicPlaylistArtwork, movePlaylistSection } from '../state/library';
import { cancelPlaylistImport, importStore } from '../state/import';
import { player } from '../state/player';
import { ytmusicPlaylistId } from '../lib/ytmusic-library';
import { appearance } from '../state/appearance';
import { updater } from '../state/updater';
import { go, openDialog, routeKey, ui, type Route } from '../state/ui';
import type { Playlist, PlaylistSection } from '../types';
import rsMark from '../assets/rs-mark.png';
import soundcloudLogo from '../assets/soundcloud.svg';
import youtubeMusicLogo from '../assets/youtube-music.svg';

const YtMusicPlaylistCover = memo(function YtMusicPlaylistCover({ playlistId, title, artworkUrl }: { playlistId: string; title: string; artworkUrl?: string | null }) {
  const art = useStore(library, (s) => (playlistId in s.ytmusicPlaylistArt ? s.ytmusicPlaylistArt[playlistId] : undefined));
  useEffect(() => {
    if (art === undefined) void loadYtMusicPlaylistArtwork(playlistId);
  }, [playlistId, art]);
  const pl = useMemo(() => ({ id: playlistId, name: title, ids: [] as string[], created: 0, artworkUrl: art ?? artworkUrl ?? undefined }), [playlistId, title, art, artworkUrl]);
  return <PlaylistCover p={pl} className="h-10 w-10 rounded-[12px]" />;
});

const NavItem = memo(function NavItem({ k, active, expanded, label, labelPrefix, sub, icon, art, badge, onClick, playing, className, onPointerDown, dragging }: {
  k: string; active: boolean; expanded: boolean; label: string; labelPrefix?: ReactNode; sub?: string; icon?: IconName; art?: ReactNode; badge?: boolean; onClick: () => void; playing?: boolean; className?: string;
  onPointerDown?: (e: ReactPointerEvent<HTMLButtonElement>) => void; dragging?: boolean;
}) {
  return (
    <button
      type="button"
      data-key={k}
      data-ripple
      data-dragging={dragging ? 'true' : undefined}
      className={cx('nav-item sl', className)}
      aria-current={active ? 'page' : undefined}
      data-tip={expanded ? undefined : label}
      data-tip-pos="right"
      onPointerDown={onPointerDown}
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
});

const LOGO_SHAPE = blobPath(10, 0.025, 64);

export function Logo({ size, className }: { size?: number; className?: string } = {}) {
  const paletteStyle = useStore(appearance, (state) => state.bgMode === 'dynamic' && state.bgStyle === 'palette');
  const markColor = paletteStyle ? 'var(--md-on-secondary-container)' : 'var(--md-on-primary)';
  const markW = size ? Math.round(size * (19 / 40)) : undefined;
  const markH = size ? Math.round(size * (13 / 40)) : undefined;
  return (
    <span
      className={cx('shape', !size && 'h-10 w-10', paletteStyle ? 'text-secondary-container' : 'text-primary', className)}
      style={size ? { width: size, height: size } : undefined}
    >
      <svg viewBox="0 0 1 1" aria-hidden="true">
        <path d={LOGO_SHAPE} />
      </svg>
      <span
        aria-hidden="true"
        className={cx('block', !size && 'h-[13px] w-[19px]')}
        style={{
          width: markW,
          height: markH,
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

function ImportingNavItem({ expanded }: { expanded: boolean }) {
  const job = useStore(importStore, (s) => s);
  if (!job.active) return null;
  const awaiting = job.phase === 'awaiting_decision';
  const pct = job.total > 0 ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 0;
  const sub = awaiting
    ? t('importNeedsReviewSub', { count: job.reviewItems.length })
    : job.phase === 'matching' && job.total > 0
    ? t('importMatching', { done: job.processed, total: job.total })
    : job.phase === 'finalizing'
    ? t('importFinalizing')
    : t('importFetching');

  return (
    <div
      className="nav-item sl"
      data-ripple={awaiting ? '' : undefined}
      data-tip={expanded ? undefined : `${job.playlistName} · ${sub}`}
      data-tip-pos="right"
      role={awaiting ? 'button' : undefined}
      tabIndex={awaiting ? 0 : undefined}
      style={awaiting ? { cursor: 'pointer', background: 'color-mix(in oklab, var(--md-primary) 12%, transparent)' } : undefined}
      onClick={() => {
        if (awaiting) openDialog({ kind: 'import-review' });
      }}
      onKeyDown={(e) => {
        if (awaiting && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          openDialog({ kind: 'import-review' });
        }
      }}
    >
      <span className="nav-ic relative">
        {awaiting ? (
          <Icon name="playlist_add_check" className="text-primary" />
        ) : (
          <Loader size={24} />
        )}
      </span>
      <span className="nav-label fade-x">
        <span className="nav-label-main">
          <span className="truncate">{job.playlistName}</span>
        </span>
        <span className="nav-sub">{sub}</span>
        {job.phase === 'matching' && job.total > 0 && (
          <span className="side-import-progress" aria-hidden="true">
            <i style={{ width: `${pct}%` }} />
          </span>
        )}
      </span>
      {expanded && (
        <IconButton
          icon="close"
          label={t('cancel')}
          size="sm"
          tip={false}
          className="fade-x mr-2"
          onClick={(e) => {
            e.stopPropagation();
            cancelPlaylistImport();
          }}
        />
      )}
    </div>
  );
}

export const Sidebar = memo(function Sidebar({ mode }: { mode: 'inline' | 'drawer' }) {
  useLang();
  const expanded = useStore(ui, (s) => mode === 'drawer' || s.sidebar);
  const route = useStore(ui, (s) => s.route);
  const foldYtMusic = useStore(ui, (s) => s.foldYtMusic);
  const foldSoundCloud = useStore(ui, (s) => s.foldSoundCloud);
  const foldLocal = useStore(ui, (s) => s.foldLocal);
  const playlists = useStore(library, (s) => s.playlists);
  const importingActive = useStore(importStore, (s) => s.active);
  const soundcloudPlaylists = useStore(library, (s) => s.soundcloudPlaylists);
  const ytmusicPlaylists = useStore(library, (s) => s.ytmusicPlaylists);
  const ytmusicConnected = useStore(library, (s) => s.ytmusicAuthorized);
  const ytmusicPlaylistTracks = useStore(library, (s) => s.ytmusicPlaylistTracks);
  const soundcloudPlaylistTracks = useStore(library, (s) => s.soundcloudPlaylistTracks);
  const playing = useStore(player, (s) => s.playing);
  const curId = useStore(player, (s) => s.queue[s.index] ?? null);
  const updateAvailable = useStore(updater, (s) => s.available);
  const latestVersion = useStore(updater, (s) => s.latestVersion);
  const listRef = useRef<HTMLDivElement>(null);
  const indRef = useRef<HTMLDivElement>(null);
  const active = routeKey(route);

  const [dragState, setDragState] = useState<{
    playlist: Playlist;
    fromSection: PlaylistSection;
    x: number;
    y: number;
    overSection: PlaylistSection | null;
  } | null>(null);
  const suppressClickIdRef = useRef<string | null>(null);

  const showYtMusic = ytmusicPlaylists.length > 0 || playlists.some((p) => p.section === 'youtube') || Boolean(dragState);
  const showSoundCloud = soundcloudPlaylists.length > 0 || playlists.some((p) => p.section === 'soundcloud') || Boolean(dragState);
  const { ytCustomPlaylists, scCustomPlaylists, localCustomPlaylists } = useMemo(() => {
    const yt: Playlist[] = [];
    const sc: Playlist[] = [];
    const loc: Playlist[] = [];
    for (const p of playlists) {
      if (p.section === 'youtube') yt.push(p);
      else if (p.section === 'soundcloud') sc.push(p);
      else loc.push(p);
    }
    return { ytCustomPlaylists: yt, scCustomPlaylists: sc, localCustomPlaylists: loc };
  }, [playlists]);

  const ytLogoNode = useMemo(() => <img src={youtubeMusicLogo} alt="" aria-hidden="true" />, []);
  const scLogoNode = useMemo(() => <img src={soundcloudLogo} alt="" aria-hidden="true" />, []);

  useEffect(() => {
    if (!dragState) return;
    document.body.style.cursor = 'grabbing';
    return () => {
      document.body.style.cursor = '';
    };
  }, [Boolean(dragState)]);

  const startPlaylistDrag = useCallback((playlist: Playlist, fromSection: PlaylistSection, e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || library.get().playlists.length === 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let activeDrag = false;
    let lastOver: PlaylistSection | null = null;

    const findDropSection = (cxPos: number, cyPos: number): PlaylistSection | null => {
      const el = document.elementFromPoint(cxPos, cyPos) as HTMLElement | null;
      const zone = el?.closest<HTMLElement>('[data-drop-section]');
      const sec = zone?.dataset.dropSection as PlaylistSection | undefined;
      return sec === 'youtube' || sec === 'soundcloud' || sec === 'local' ? sec : null;
    };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!activeDrag) {
        if (Math.hypot(dx, dy) < 7) return;
        activeDrag = true;
      }
      lastOver = findDropSection(ev.clientX, ev.clientY);
      setDragState({
        playlist,
        fromSection,
        x: ev.clientX,
        y: ev.clientY,
        overSection: lastOver,
      });
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
    };

    const onUp = (ev: PointerEvent) => {
      cleanup();
      if (!activeDrag) return;
      const targetSection = findDropSection(ev.clientX, ev.clientY) ?? lastOver;
      suppressClickIdRef.current = playlist.id;
      window.setTimeout(() => {
        if (suppressClickIdRef.current === playlist.id) suppressClickIdRef.current = null;
      }, 120);
      setDragState(null);
      if (targetSection && targetSection !== fromSection) {
        movePlaylistSection(playlist.id, targetSection);
        const st = ui.get();
        if (targetSection === 'youtube' && st.foldYtMusic) ui.set({ foldYtMusic: false });
        if (targetSection === 'soundcloud' && st.foldSoundCloud) ui.set({ foldSoundCloud: false });
        if (targetSection === 'local' && st.foldLocal) ui.set({ foldLocal: false });
      }
    };

    const onCancel = () => {
      cleanup();
      setDragState(null);
    };

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
  }, []);

  const renderCustomPlaylistItem = (p: Playlist, section: PlaylistSection) => (
    <NavItem
      key={p.id}
      k={'pl:' + p.id}
      label={p.name}
      sub={tracksLabel(p.ids.length)}
      active={active === 'pl:' + p.id}
      expanded={expanded}
      dragging={dragState?.playlist.id === p.id}
      playing={playing && !!curId && p.ids.includes(curId) && active === 'pl:' + p.id}
      art={<PlaylistCover p={p} className="h-10 w-10 rounded-[12px]" />}
      onPointerDown={(e) => startPlaylistDrag(p, section, e)}
      onClick={() => {
        if (suppressClickIdRef.current === p.id) {
          suppressClickIdRef.current = null;
          return;
        }
        nav({ name: 'playlist', id: p.id });
      }}
    />
  );

  // Update the active-item pill via direct DOM transform without triggering a second React render
  // (avoids forced synchronous layout + double-render right on frame 1 of sidebar expand/collapse).
  useLayoutEffect(() => {
    const indEl = indRef.current;
    if (!indEl) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(active)}"]`);
    if (el) {
      indEl.style.transform = `translate3d(0, ${el.offsetTop}px, 0)`;
      indEl.style.height = `${el.offsetHeight}px`;
      indEl.style.opacity = '1';
    } else {
      indEl.style.opacity = '0';
    }
  }, [
    active,
    playlists,
    importingActive,
    soundcloudPlaylists.length,
    ytmusicPlaylists.length,
    ytmusicConnected,
    foldYtMusic,
    foldSoundCloud,
    foldLocal,
  ]);

  const nav = useCallback((r: Route) => go(r), []);
  const goHome = useCallback(() => go({ name: 'home' }), []);
  const goFavorites = useCallback(() => go({ name: 'favorites' }), []);
  const goSettings = useCallback(() => go({ name: 'settings' }), []);
  const openUpdates = useCallback(() => openDialog({ kind: 'update' }), []);
  const toggleExpanded = useCallback(() => {
    markResizing();
    ui.set((s) => ({ sidebar: !s.sidebar }));
  }, []);

  return (
    <nav className="panel panel-side sidebar" data-expanded={expanded} aria-label="Resonance">
      <div className="side-brand">
        {mode === 'inline' ? (
          <span className="brand-toggle">
            <IconButton icon={expanded ? 'menu_open' : 'menu'} label={expanded ? t('collapse') : t('expand')} tip="right" onClick={toggleExpanded} />
            <span className="brand-toggle-logo" aria-hidden="true">
              <Logo />
            </span>
          </span>
        ) : (
          <Logo />
        )}
        <span className="fade-x flex min-w-0 items-center gap-2.5">
          {mode === 'inline' && <Logo />}
          <span className="display text-[24px]">Resonance</span>
        </span>
      </div>
      <div ref={listRef} className="side-scroll">
        <div ref={indRef} className="side-indicator" style={{ height: 52, opacity: 0 }} />
        <NavItem k="home" icon="home" label={t('home')} active={active === 'home'} expanded={expanded} onClick={goHome} />
        <NavItem k="favorites" icon="favorite" label={t('favorites')} active={active === 'favorites'} expanded={expanded} onClick={goFavorites} />
        <div className="side-section">
          <span className="label-up fade-x">{t('playlists')}</span>
          <IconButton icon="add" label={t('newPlaylist')} size="sm" variant="tonal" tip="right" onClick={() => openDialog({ kind: 'create' })} />
        </div>
        <ImportingNavItem expanded={expanded} />
        {showYtMusic && (
          <div
            data-drop-section="youtube"
            data-drop-ready={dragState && dragState.fromSection !== 'youtube' ? 'true' : undefined}
            data-drop-active={dragState?.overSection === 'youtube' && dragState.fromSection !== 'youtube' ? 'true' : undefined}
            className="side-drop-zone flex flex-col"
          >
            <ProviderGroupHeader
              label="YouTube Music"
              logo={youtubeMusicLogo}
              open={!foldYtMusic}
              expanded={expanded}
              onToggle={() => ui.set({ foldYtMusic: !foldYtMusic })}
            />
            {!foldYtMusic && (
              <>
                {ytCustomPlaylists.map((p) => renderCustomPlaylistItem(p, 'youtube'))}
                {ytmusicPlaylists.map((p) => {
                  const plTracks = ytmusicPlaylistTracks[p.playlistId];
                  const loadedCount = plTracks?.length;
                  const count = Number(p.trackCount) > 0 ? p.trackCount : loadedCount ?? p.trackCount ?? 0;
                  const plKey = 'pl:' + ytmusicPlaylistId(p.playlistId);
                  return (
                    <NavItem
                      key={`yt:${p.playlistId}`}
                      k={plKey}
                      label={p.title}
                      labelPrefix={ytLogoNode}
                      sub={tracksLabel(count)}
                      active={active === plKey}
                      expanded={expanded}
                      playing={playing && !!curId && active === plKey && (plTracks ?? []).some((track) => track.id === curId)}
                      art={<YtMusicPlaylistCover playlistId={p.playlistId} title={p.title} artworkUrl={p.artworkUrl} />}
                      onClick={() => nav({ name: 'playlist', id: ytmusicPlaylistId(p.playlistId) })}
                    />
                  );
                })}
              </>
            )}
          </div>
        )}
        {showSoundCloud && (
          <div
            data-drop-section="soundcloud"
            data-drop-ready={dragState && dragState.fromSection !== 'soundcloud' ? 'true' : undefined}
            data-drop-active={dragState?.overSection === 'soundcloud' && dragState.fromSection !== 'soundcloud' ? 'true' : undefined}
            className="side-drop-zone flex flex-col"
          >
            <ProviderGroupHeader
              label="SoundCloud"
              logo={soundcloudLogo}
              open={!foldSoundCloud}
              expanded={expanded}
              onToggle={() => ui.set({ foldSoundCloud: !foldSoundCloud })}
            />
            {!foldSoundCloud && (
              <>
                {scCustomPlaylists.map((p) => renderCustomPlaylistItem(p, 'soundcloud'))}
                {soundcloudPlaylists.map((p) => {
                  const plKey = 'pl:scpl:' + p.id;
                  const plTracks = soundcloudPlaylistTracks[p.urn];
                  return (
                    <NavItem
                      key={`sc:${p.id}`}
                      k={plKey}
                      label={p.name}
                      labelPrefix={scLogoNode}
                      sub={tracksLabel(p.trackCount)}
                      active={active === plKey}
                      expanded={expanded}
                      playing={playing && !!curId && active === plKey && (plTracks ?? []).some((track) => track.id === curId)}
                      art={<PlaylistCover p={{ id: p.id, name: p.name, ids: [], created: 0, artworkUrl: p.artworkUrl }} className="h-10 w-10 rounded-[12px]" />}
                      onClick={() => nav({ name: 'playlist', id: `scpl:${p.id}` })}
                    />
                  );
                })}
              </>
            )}
          </div>
        )}
        {(localCustomPlaylists.length > 0 || (dragState && dragState.fromSection !== 'local')) && (
          <div
            data-drop-section="local"
            data-drop-ready={dragState && dragState.fromSection !== 'local' ? 'true' : undefined}
            data-drop-active={dragState?.overSection === 'local' && dragState.fromSection !== 'local' ? 'true' : undefined}
            className="side-drop-zone flex flex-col"
          >
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
              localCustomPlaylists.map((p) => renderCustomPlaylistItem(p, 'local'))}
          </div>
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
          onClick={openUpdates}
        />
        <NavItem
          k="settings"
          icon="settings"
          label={t('settings')}
          active={active === 'settings' || active === 'appearance' || active === 'providers' || active === 'shortcuts' || active === 'audio'}
          expanded={expanded}
          onClick={goSettings}
        />
      </div>
      {dragState &&
        createPortal(
          <div
            className="side-drag-ghost"
            style={{ transform: `translate3d(${Math.round(dragState.x + 12)}px, ${Math.round(dragState.y - 24)}px, 0)` }}
          >
            <PlaylistCover p={dragState.playlist} className="h-8 w-8 rounded-[10px]" />
            <span className="truncate">{dragState.playlist.name}</span>
          </div>,
          document.body,
        )}
    </nav>
  );
});
