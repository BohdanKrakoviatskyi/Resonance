import { useEffect, useState } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { Segmented, type Vars } from '../components/ui';
import { pick, t, useLang } from '../lib/i18n';
import { useStore } from '../lib/util';
import { appearance } from '../state/appearance';
import { library } from '../state/library';
import { go, openDialog, snack, type Route } from '../state/ui';
import { appVersion, checkForUpdate, installUpdate, type MobileUpdate } from '../lib/update';

type SettingItem = {
  route: Route;
  icon: IconName;
  title: string;
  subtitle: string;
  badge?: string;
};

export default function Settings() {
  const lang = useLang();
  const ytAuth = useStore(library, (s) => s.ytmusicAuthorized);
  const scCount = useStore(library, (s) => s.soundcloudLiked.length + s.soundcloudPlaylists.length);
  const connectedCount = (ytAuth ? 1 : 0) + (scCount > 0 ? 1 : 0);

  const isIos = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);
  const [version, setVersion] = useState('');
  const [update, setUpdate] = useState<MobileUpdate | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    void appVersion().then(setVersion);
  }, []);

  async function runCheck() {
    setChecking(true);
    try {
      const found = await checkForUpdate();
      setUpdate(found);
      snack(found ? t('updateAvailableVer', { version: found.version }) : t('updateUpToDate'));
    } catch (e) {
      snack(t('updateFailed', { reason: e instanceof Error ? e.message : String(e) }));
    } finally {
      setChecking(false);
    }
  }

  async function runInstall() {
    if (!update) return;
    if (isIos) {
      snack(t('updateIosNote'));
      return;
    }
    setInstalling(true);
    snack(t('updateDownloading'));
    try {
      await installUpdate(update);
      snack(t('updateConfirmHint'));
    } catch (e) {
      snack(t('updateFailed', { reason: e instanceof Error ? e.message : String(e) }));
    } finally {
      setInstalling(false);
    }
  }

  const items: SettingItem[] = [
    {
      route: { name: 'appearance' },
      icon: 'palette',
      title: t('appearance'),
      subtitle: t('appearanceSub'),
    },
    {
      route: { name: 'audio' },
      icon: 'graphic_eq',
      title: t('audioSettings'),
      subtitle: t('audioSettingsSub'),
    },
    {
      route: { name: 'providers' },
      icon: 'music_note',
      title: t('providers'),
      subtitle: t('providersSub'),
      badge: connectedCount > 0 ? `${connectedCount}/2` : undefined,
    },
  ];

  return (
    <div className="flex flex-col gap-3.5 px-4 pb-10 pt-3">
      <header className="anim-in mb-1.5 mt-1">
        <h1 className="display text-[clamp(30px,8vw,42px)]">{t('settings')}</h1>
        <p className="mt-1.5 text-sm text-on-surface-variant">{t('settingsSub')}</p>
      </header>

      {items.map((item, i) => (
        <button
          key={item.route.name}
          type="button"
          data-ripple
          className="card sl anim-in flex w-full items-center gap-3.5 !p-4 text-left"
          style={{ '--i': i + 1 } as Vars}
          onClick={() => go(item.route)}
        >
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[16px] bg-secondary-container text-on-secondary-container">
            <Icon name={item.icon} fill size={24} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="headline text-[17px] leading-tight">{item.title}</span>
              {item.badge && (
                <span className="rounded-full bg-primary/18 px-2 py-0.5 text-[11px] font-bold text-primary">
                  {item.badge}
                </span>
              )}
            </div>
            <div className="mt-0.5 line-clamp-2 text-xs text-on-surface-variant">{item.subtitle}</div>
          </div>
          <Icon name="chevron_right" className="text-on-surface-variant" />
        </button>
      ))}

      <section className="card anim-in !p-4" style={{ '--i': items.length + 1 } as Vars}>
        <div className="mb-3.5 flex items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[15px] bg-secondary-container text-on-secondary-container">
            <Icon name="translate" fill size={22} />
          </span>
          <div className="min-w-0">
            <h2 className="headline text-[17px] leading-tight">{t('language')}</h2>
            <p className="text-xs text-on-surface-variant">
              {pick('Язык интерфейса приложения', 'Application interface language')}
            </p>
          </div>
        </div>
        <Segmented
          value={lang}
          onChange={(v) => appearance.set({ lang: v })}
          options={[
            { value: 'ru', label: 'Русский' },
            { value: 'en', label: 'English' },
          ]}
        />
      </section>

      <div className="anim-in mt-1 flex flex-wrap items-center justify-between gap-3 rounded-[24px] bg-sc-low/70 p-4" style={{ '--i': items.length + 2 } as Vars}>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-on-surface">{t('clearCacheApp')}</div>
          <div className="mt-0.5 text-xs text-on-surface-variant">
            {pick('Освободить место от скачанных треков и обложек', 'Free space used by cached audio streams and artwork')}
          </div>
        </div>
        <button
          type="button"
          data-ripple
          className="sl inline-flex shrink-0 items-center gap-2 rounded-full bg-sc-high px-4 py-2.5 text-xs font-bold text-on-surface ring-1 ring-outline-variant/40"
          onClick={() => openDialog({ kind: 'clear-cache' })}
        >
          <Icon name="history" fill size={18} />
          <span>{t('clearCacheBtn')}</span>
        </button>
      </div>

      <section className="anim-in mt-1 flex flex-wrap items-center justify-between gap-3 rounded-[24px] bg-sc-low/70 p-4" style={{ '--i': items.length + 3 } as Vars}>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-on-surface">
            {version ? `Resonance Mobile v${version}` : 'Resonance Mobile'}
          </div>
          <div className="mt-0.5 text-xs text-on-surface-variant">
            {update ? t('updateAvailableVer', { version: update.version }) : t('updateTitle')}
          </div>
        </div>
        <button
          type="button"
          data-ripple
          disabled={checking || installing}
          className="sl inline-flex shrink-0 items-center gap-2 rounded-full bg-sc-high px-4 py-2.5 text-xs font-bold text-on-surface ring-1 ring-outline-variant/40 disabled:opacity-60"
          onClick={() => void (update ? runInstall() : runCheck())}
        >
          <Icon name={update ? 'download' : 'refresh'} fill size={18} />
          <span>
            {installing
              ? t('updateDownloading')
              : checking
                ? t('updateChecking')
                : update
                  ? t('updateInstallAction')
                  : t('updateCheckAgainBtn')}
          </span>
        </button>
      </section>
    </div>
  );
}
