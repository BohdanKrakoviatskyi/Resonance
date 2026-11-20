import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Icon } from '../components/Icon';
import { Button, IconButton, type Vars } from '../components/ui';
import { pick, t, useLang } from '../lib/i18n';
import {
  soundCloudAuthLogin,
  soundCloudAuthLogout,
  soundCloudAuthRefresh,
  soundCloudAuthStatus,
  soundCloudSetClientId,
  ytMusicAuthLogout,
  ytMusicAuthSave,
  ytMusicAuthStatus,
  type YtMusicAuthStatus,
} from '../lib/providers-api';
import {
  clearSoundCloudLibrary,
  clearYtMusicLibrary,
  loadSoundCloudLibrary,
  loadYtMusicLibrary,
} from '../state/library';
import { go } from '../state/ui';
import soundcloudLogo from '../assets/soundcloud.svg';
import youtubeMusicLogo from '../assets/youtube-music.svg';

interface ScCaptureDto {
  clientId?: string;
  token: string;
  datadome?: string;
}

function errStr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') return err.message;
  return 'Request failed';
}

export default function Providers() {
  useLang();
  const [ytStatus, setYtStatus] = useState<{ connected: boolean; account?: string } | null>(null);
  const [scStatus, setScStatus] = useState<{ connected: boolean; account?: string } | null>(null);
  const [busyProvider, setBusyProvider] = useState<'yt' | 'sc' | null>(null);
  const [ytMsg, setYtMsg] = useState('');
  const [ytErr, setYtErr] = useState('');
  const [scMsg, setScMsg] = useState('');
  const [scErr, setScErr] = useState('');

  const [showYtManual, setShowYtManual] = useState(false);
  const [ytCookieInput, setYtCookieInput] = useState('');
  const [showScManual, setShowScManual] = useState(false);
  const [scTokenInput, setScTokenInput] = useState('');
  const [scClientIdInput, setScClientIdInput] = useState('');

  const refreshStatuses = async () => {
    try {
      const yt = await ytMusicAuthStatus();
      setYtStatus({ connected: yt.authorized, account: yt.profile?.name || yt.profile?.handle });
    } catch {
      setYtStatus({ connected: false });
    }
    try {
      const sc = await soundCloudAuthStatus();
      setScStatus({ connected: sc.authorized, account: sc.profile?.fullName || sc.profile?.username });
    } catch {
      setScStatus({ connected: false });
    }
  };

  useEffect(() => {
    void refreshStatuses();
  }, []);

  const handleYtWebLogin = async () => {
    setBusyProvider('yt');
    setYtErr('');
    setYtMsg(t('ytSignInWindowMsg'));
    try {
      await invoke<YtMusicAuthStatus>('start_ytmusic_login');
      await loadYtMusicLibrary(true);
      await refreshStatuses();
      setYtMsg(t('ytConnectedMsg'));
    } catch (e) {
      setYtErr(errStr(e));
      setYtMsg('');
    } finally {
      setBusyProvider(null);
    }
  };

  const handleYtManualSave = async () => {
    if (!ytCookieInput.trim()) return;
    setBusyProvider('yt');
    setYtErr('');
    setYtMsg('');
    try {
      const raw = ytCookieInput.trim().replace(/^cookie:\s*/i, '');
      await ytMusicAuthSave({ Cookie: raw, 'X-Goog-AuthUser': '0' });
      await loadYtMusicLibrary(true);
      await refreshStatuses();
      setYtCookieInput('');
      setShowYtManual(false);
      setYtMsg(t('ytConnectedMsg'));
    } catch (e) {
      setYtErr(errStr(e));
    } finally {
      setBusyProvider(null);
    }
  };

  const handleScWebLogin = async () => {
    setBusyProvider('sc');
    setScErr('');
    setScMsg(t('scSignInWindowMsg'));
    try {
      const captured = await invoke<ScCaptureDto>('start_soundcloud_login');
      if (captured.clientId && captured.clientId.trim().length >= 8) {
        await soundCloudSetClientId(captured.clientId.trim()).catch(() => {});
      }
      if (captured.datadome) {
        try {
          localStorage.setItem('resonance.sc.datadome', captured.datadome);
        } catch {
          /* ignore */
        }
      }
      try {
        await soundCloudAuthLogin(captured.token);
      } catch (loginErr) {
        // If an expired pre-existing WebView cookie was captured, clear it so the user gets a clean sign-in
        await invoke('mobile_clear_auth_cookies', { provider: 'soundcloud' }).catch(() => {});
        throw loginErr;
      }
      await loadSoundCloudLibrary(true);
      await refreshStatuses();
      setScMsg(t('scConnectedMsg'));
    } catch (e) {
      setScErr(errStr(e));
      setScMsg('');
    } finally {
      setBusyProvider(null);
    }
  };

  const handleScManualSave = async () => {
    if (!scTokenInput.trim()) return;
    setBusyProvider('sc');
    setScErr('');
    setScMsg('');
    try {
      if (scClientIdInput.trim()) {
        await soundCloudSetClientId(scClientIdInput.trim());
      }
      const cleanTok = scTokenInput.trim().replace(/^(?:OAuth|Bearer)\s+/i, '');
      await soundCloudAuthLogin(cleanTok);
      await loadSoundCloudLibrary(true);
      await refreshStatuses();
      setScTokenInput('');
      setShowScManual(false);
      setScMsg(t('scConnectedMsg'));
    } catch (e) {
      setScErr(errStr(e));
    } finally {
      setBusyProvider(null);
    }
  };

  return (
    <div className="flex flex-col gap-3.5 px-4 pb-10 pt-3">
      <header className="anim-in mb-1">
        <div className="mb-2 flex items-center gap-2">
          <IconButton icon="arrow_back" label={t('back')} variant="tonal" size="sm" tip={false} onClick={() => go({ name: 'settings' })} />
          <span className="text-xs font-semibold text-on-surface-variant">{t('settings')}</span>
        </div>
        <h1 className="display text-[clamp(28px,7.5vw,40px)]">{t('providers')}</h1>
        <p className="mt-1 text-sm text-on-surface-variant">{t('providersSub')}</p>
      </header>

      {/* SoundCloud Card */}
      <section className="card anim-in !p-4" style={{ '--i': 1 } as Vars}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[15px] bg-sc-high">
              <img src={soundcloudLogo} alt="" className="h-6 w-6 object-contain" />
            </span>
            <div>
              <h2 className="headline text-lg font-extrabold">SoundCloud</h2>
              <p className="mt-0.5 text-xs text-on-surface-variant">{t('scDescription')}</p>
            </div>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-sc-high px-3 py-1 text-xs font-bold">
            <span className={`h-2 w-2 rounded-full ${scStatus?.connected ? 'bg-primary' : 'bg-on-surface-variant'}`} />
            {scStatus?.connected ? t('providerStatusConnected') : scStatus ? t('providerStatusNotConnected') : t('providerStatusChecking')}
          </span>
        </div>

        {scStatus?.account && (
          <p className="mt-2.5 rounded-xl bg-sc-low/60 px-3 py-2 text-xs">
            {t('providerAccount')}: <span className="font-bold text-on-surface">{scStatus.account}</span>
          </p>
        )}

        <div className="mt-3.5 flex flex-wrap gap-2">
          <Button variant="filled" icon="login" disabled={busyProvider !== null} onClick={() => void handleScWebLogin()}>
            {busyProvider === 'sc' ? t('scWaitingBtn') : t('scLoginBtn')}
          </Button>
          {scStatus?.connected && (
            <>
              <Button
                variant="tonal"
                icon="refresh"
                disabled={busyProvider !== null}
                onClick={async () => {
                  setBusyProvider('sc');
                  try {
                    await soundCloudAuthRefresh();
                    await loadSoundCloudLibrary(true);
                    setScMsg(t('scRefreshedMsg'));
                  } catch (e) {
                    setScErr(errStr(e));
                  } finally {
                    setBusyProvider(null);
                  }
                }}
              >
                {t('providerRefresh')}
              </Button>
              <Button
                variant="outlined"
                disabled={busyProvider !== null}
                onClick={async () => {
                  setBusyProvider('sc');
                  try {
                    await soundCloudAuthLogout();
                    await invoke('mobile_clear_auth_cookies', { provider: 'soundcloud' }).catch(() => {});
                    clearSoundCloudLibrary();
                    await refreshStatuses();
                    setScMsg(t('providerDisconnectedMsg'));
                  } finally {
                    setBusyProvider(null);
                  }
                }}
              >
                {t('providerDisconnect')}
              </Button>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowScManual((v) => !v)}
          className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary"
        >
          <Icon name="expand_more" size={16} className={showScManual ? 'rotate-180' : ''} />
          <span>{pick('Вставить OAuth токен вручную (резервный вход)', 'Paste OAuth token manually (fallback)')}</span>
        </button>

        {showScManual && (
          <div className="mt-2.5 flex flex-col gap-2">
            <input
              type="text"
              value={scTokenInput}
              onChange={(e) => setScTokenInput(e.target.value)}
              placeholder="2-301948-... (oauth_token)"
              className="w-full rounded-2xl bg-sc-highest p-3 text-xs outline-none"
            />
            <input
              type="text"
              value={scClientIdInput}
              onChange={(e) => setScClientIdInput(e.target.value)}
              placeholder="client_id (необязательно / optional)"
              className="w-full rounded-2xl bg-sc-highest p-3 text-xs outline-none"
            />
            <Button variant="tonal" disabled={!scTokenInput.trim() || busyProvider !== null} onClick={() => void handleScManualSave()}>
              {t('save')}
            </Button>
          </div>
        )}

        {scMsg && <p className="mt-2.5 text-xs font-semibold text-primary">{scMsg}</p>}
        {scErr && <p className="mt-2.5 text-xs font-semibold text-error">{scErr}</p>}
      </section>

      {/* YouTube Music Card */}
      <section className="card anim-in !p-4" style={{ '--i': 2 } as Vars}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[15px] bg-sc-high">
              <img src={youtubeMusicLogo} alt="" className="h-6 w-6 object-contain" />
            </span>
            <div>
              <h2 className="headline text-lg font-extrabold">YouTube Music</h2>
              <p className="mt-0.5 text-xs text-on-surface-variant">{t('ytDescription')}</p>
            </div>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-sc-high px-3 py-1 text-xs font-bold">
            <span className={`h-2 w-2 rounded-full ${ytStatus?.connected ? 'bg-primary' : 'bg-on-surface-variant'}`} />
            {ytStatus?.connected ? t('providerStatusConnected') : ytStatus ? t('providerStatusNotConnected') : t('providerStatusChecking')}
          </span>
        </div>

        {ytStatus?.account && (
          <p className="mt-2.5 rounded-xl bg-sc-low/60 px-3 py-2 text-xs">
            {t('providerAccount')}: <span className="font-bold text-on-surface">{ytStatus.account}</span>
          </p>
        )}

        <div className="mt-3.5 flex flex-wrap gap-2">
          <Button variant="filled" icon="login" disabled={busyProvider !== null} onClick={() => void handleYtWebLogin()}>
            {busyProvider === 'yt' ? t('ytWaitingBtn') : t('ytLoginBtn')}
          </Button>
          {ytStatus?.connected && (
            <>
              <Button
                variant="tonal"
                icon="refresh"
                disabled={busyProvider !== null}
                onClick={async () => {
                  setBusyProvider('yt');
                  try {
                    await loadYtMusicLibrary(true);
                    setYtMsg(t('ytRefreshedMsg'));
                  } catch (e) {
                    setYtErr(errStr(e));
                  } finally {
                    setBusyProvider(null);
                  }
                }}
              >
                {t('providerRefresh')}
              </Button>
              <Button
                variant="outlined"
                disabled={busyProvider !== null}
                onClick={async () => {
                  setBusyProvider('yt');
                  try {
                    await ytMusicAuthLogout();
                    await invoke('mobile_clear_auth_cookies', { provider: 'ytmusic' }).catch(() => {});
                    clearYtMusicLibrary();
                    await refreshStatuses();
                    setYtMsg(t('providerDisconnectedMsg'));
                  } finally {
                    setBusyProvider(null);
                  }
                }}
              >
                {t('providerDisconnect')}
              </Button>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowYtManual((v) => !v)}
          className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary"
        >
          <Icon name="expand_more" size={16} className={showYtManual ? 'rotate-180' : ''} />
          <span>{pick('Вставить Cookie вручную (резервный вход)', 'Paste Cookie header manually (fallback)')}</span>
        </button>

        {showYtManual && (
          <div className="mt-2.5 flex flex-col gap-2">
            <textarea
              rows={3}
              value={ytCookieInput}
              onChange={(e) => setYtCookieInput(e.target.value)}
              placeholder="__Secure-3PAPISID=...; SAPISID=...;"
              className="w-full rounded-2xl bg-sc-highest p-3 text-xs outline-none"
            />
            <Button variant="tonal" disabled={!ytCookieInput.trim() || busyProvider !== null} onClick={() => void handleYtManualSave()}>
              {t('save')}
            </Button>
          </div>
        )}

        {ytMsg && <p className="mt-2.5 text-xs font-semibold text-primary">{ytMsg}</p>}
        {ytErr && <p className="mt-2.5 text-xs font-semibold text-error">{ytErr}</p>}
      </section>
    </div>
  );
}
