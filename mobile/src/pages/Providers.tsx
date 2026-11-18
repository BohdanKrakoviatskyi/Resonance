import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button, IconButton } from '../components/ui';
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

interface ScCaptureDto {
  clientId: string;
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
      if (captured.clientId) {
        await soundCloudSetClientId(captured.clientId);
      }
      await soundCloudAuthLogin(captured.token);
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
    <div className="flex flex-col gap-4 px-4 pb-8 pt-3">
      <header className="flex items-center gap-2.5">
        <IconButton icon="arrow_back" label={t('back')} variant="tonal" size="sm" tip={false} onClick={() => go({ name: 'settings' })} />
        <h1 className="headline text-2xl font-extrabold">{t('providers')}</h1>
      </header>

      {/* YouTube Music Card */}
      <section className="rounded-3xl bg-sc-low p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="headline text-lg font-extrabold">YouTube Music</h2>
            <p className="mt-0.5 text-xs text-on-surface-variant">{t('ytDescription')}</p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-sc-high px-3 py-1 text-xs font-bold">
            <span className={`h-2 w-2 rounded-full ${ytStatus?.connected ? 'bg-primary' : 'bg-on-surface-variant'}`} />
            {ytStatus?.connected ? t('providerStatusConnected') : ytStatus ? t('providerStatusNotConnected') : t('providerStatusChecking')}
          </span>
        </div>

        {ytStatus?.account && (
          <p className="mt-2 text-xs">
            {t('providerAccount')}: <span className="font-bold">{ytStatus.account}</span>
          </p>
        )}

        <div className="mt-3.5 flex flex-wrap gap-2">
          <Button variant="filled" disabled={busyProvider !== null} onClick={() => void handleYtWebLogin()}>
            {busyProvider === 'yt' ? t('ytWaitingBtn') : t('ytLoginBtn')}
          </Button>
          {ytStatus?.connected && (
            <>
              <Button
                variant="tonal"
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
          className="mt-3 text-xs font-semibold text-primary"
        >
          {pick('Вставить Cookie вручную (резервный вход)', 'Paste Cookie header manually (fallback)')}
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

      {/* SoundCloud Card */}
      <section className="rounded-3xl bg-sc-low p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="headline text-lg font-extrabold">SoundCloud</h2>
            <p className="mt-0.5 text-xs text-on-surface-variant">{t('scDescription')}</p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-sc-high px-3 py-1 text-xs font-bold">
            <span className={`h-2 w-2 rounded-full ${scStatus?.connected ? 'bg-primary' : 'bg-on-surface-variant'}`} />
            {scStatus?.connected ? t('providerStatusConnected') : scStatus ? t('providerStatusNotConnected') : t('providerStatusChecking')}
          </span>
        </div>

        {scStatus?.account && (
          <p className="mt-2 text-xs">
            {t('providerAccount')}: <span className="font-bold">{scStatus.account}</span>
          </p>
        )}

        <div className="mt-3.5 flex flex-wrap gap-2">
          <Button variant="filled" disabled={busyProvider !== null} onClick={() => void handleScWebLogin()}>
            {busyProvider === 'sc' ? t('scWaitingBtn') : t('scLoginBtn')}
          </Button>
          {scStatus?.connected && (
            <>
              <Button
                variant="tonal"
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
          className="mt-3 text-xs font-semibold text-primary"
        >
          {pick('Ввести OAuth токен вручную', 'Enter OAuth token manually')}
        </button>

        {showScManual && (
          <div className="mt-2.5 flex flex-col gap-2">
            <input
              type="text"
              value={scTokenInput}
              onChange={(e) => setScTokenInput(e.target.value)}
              placeholder="SoundCloud OAuth token (2-xxxxxx-...)"
              className="h-11 w-full rounded-2xl bg-sc-highest px-3.5 text-xs outline-none"
            />
            <input
              type="text"
              value={scClientIdInput}
              onChange={(e) => setScClientIdInput(e.target.value)}
              placeholder={pick('Client ID (необязательно)', 'Client ID (optional)')}
              className="h-11 w-full rounded-2xl bg-sc-highest px-3.5 text-xs outline-none"
            />
            <Button variant="tonal" disabled={!scTokenInput.trim() || busyProvider !== null} onClick={() => void handleScManualSave()}>
              {t('save')}
            </Button>
          </div>
        )}

        {scMsg && <p className="mt-2.5 text-xs font-semibold text-primary">{scMsg}</p>}
        {scErr && <p className="mt-2.5 text-xs font-semibold text-error">{scErr}</p>}
      </section>
    </div>
  );
}
