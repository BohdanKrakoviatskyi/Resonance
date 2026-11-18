import { Icon, type IconName } from '../components/Icon';
import { pick, t, useLang } from '../lib/i18n';
import { useStore } from '../lib/util';
import { library } from '../state/library';
import { go, openDialog } from '../state/ui';

function SettingsTile({
  icon,
  title,
  sub,
  badge,
  onClick,
}: {
  icon: IconName;
  title: string;
  sub: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="sl flex w-full items-center gap-3.5 rounded-3xl bg-sc-low p-4 text-left"
    >
      <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-primary-container text-on-primary-container">
        <Icon name={icon} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-base font-extrabold">{title}</div>
        <div className="mt-0.5 line-clamp-2 text-xs text-on-surface-variant">{sub}</div>
      </div>
      {badge && (
        <span className="shrink-0 rounded-full bg-sc-highest px-2.5 py-1 text-[11px] font-bold text-primary">
          {badge}
        </span>
      )}
      <Icon name="chevron_right" className="text-on-surface-variant" />
    </button>
  );
}

export default function Settings() {
  useLang();
  const ytAuth = useStore(library, (s) => s.ytmusicAuthorized);
  const scCount = useStore(library, (s) => s.soundcloudLiked.length + s.soundcloudPlaylists.length);
  const connectedCount = (ytAuth ? 1 : 0) + (scCount > 0 ? 1 : 0);

  return (
    <div className="flex flex-col gap-3.5 px-4 pb-8 pt-3">
      <header className="mb-1">
        <h1 className="display text-3xl">{t('settings')}</h1>
        <p className="mt-1 text-sm text-on-surface-variant">{t('settingsSub')}</p>
      </header>

      <SettingsTile
        icon="cloud_done"
        title={t('providers')}
        sub={t('providersSub')}
        badge={connectedCount > 0 ? `${connectedCount}/2` : undefined}
        onClick={() => go({ name: 'providers' })}
      />

      <SettingsTile
        icon="equalizer"
        title={t('audioSettings')}
        sub={pick('5-полосный эквалайзер и лимит кэша музыки', '5-band equalizer and audio cache limit')}
        onClick={() => go({ name: 'audio' })}
      />

      <SettingsTile
        icon="palette"
        title={t('appearance')}
        sub={t('appearanceSub')}
        onClick={() => go({ name: 'appearance' })}
      />

      <SettingsTile
        icon="delete"
        title={t('clearCacheApp')}
        sub={pick('Удалить скачанные аудиофайлы и кэш обложек', 'Free space used by cached audio streams and artwork')}
        onClick={() => openDialog({ kind: 'clear-cache' })}
      />

      <div className="mt-3 rounded-3xl bg-sc-low p-4 text-center text-xs text-on-surface-variant">
        <div className="font-bold text-on-surface">Resonance Mobile v0.1.0</div>
        <div className="mt-0.5">Native Media3 ExoPlayer · Rust InnerTube &amp; QuickJS</div>
      </div>
    </div>
  );
}
