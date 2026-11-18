import { useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { IconButton, Segmented, type Vars } from '../components/ui';
import { cx, useStore } from '../lib/util';
import { t } from '../lib/i18n';
import { integrations, isValidDiscordId, lastfmLogin, lastfmLogout } from '../state/integrations';
import { go } from '../state/ui';
import { acceptAnswer, joinSession, leaveSession, listen, startHosting } from '../state/listen-together';

export function SettingsCard({ icon, title, sub, children, i }: { icon: IconName; title: string; sub?: string; children: ReactNode; i: number }) {
  return (
    <section className="card anim-in" style={{ '--i': i } as Vars}>
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[14px] bg-secondary-container text-on-secondary-container">
          <Icon name={icon} fill size={22} />
        </span>
        <div className="min-w-0">
          <h2 className="headline text-lg leading-tight">{title}</h2>
          {sub && <p className="text-sm text-on-surface-variant">{sub}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  invalid,
  type = 'text',
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  invalid?: boolean;
  type?: 'text' | 'password';
  label: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold">{label}</span>
      <input
        type={type}
        value={value}
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cx(
          'h-11 w-full rounded-2xl bg-on-surface/8 px-4 text-[15px] font-medium tabular-nums outline-0 transition-colors placeholder:text-on-surface-variant/60 focus:bg-on-surface/12',
          invalid && 'ring-2 ring-error/70',
        )}
      />
    </label>
  );
}

export default function Integrations() {
  const discordEnabled = useStore(integrations, (s) => s.discordEnabled);
  const discordClientId = useStore(integrations, (s) => s.discordClientId);
  const discordError = useStore(integrations, (s) => s.discordError);
  const idInvalid = discordClientId.trim() !== '' && !isValidDiscordId(discordClientId);

  return (
    <div className="page max-w-[980px]">
      <header className="anim-in mb-6 mt-2">
        <div className="mb-3 flex items-center gap-2">
          <IconButton icon="arrow_back" label={t('back')} variant="tonal" size="sm" onClick={() => go({ name: 'settings' })} />
          <span className="text-sm font-semibold text-on-surface-variant">{t('settings')}</span>
        </div>
        <h1 className="display text-[clamp(32px,5.5cqw,54px)]">{t('integrations')}</h1>
        <p className="mt-2 text-lg text-on-surface-variant">{t('integrationsSub')}</p>
      </header>

      <div className="grid gap-4">
        <SettingsCard icon="nightlife" title="Discord" sub={t('discordDesc')} i={1}>
          <Segmented
            value={discordEnabled ? 'on' : 'off'}
            onChange={(v) => integrations.set({ discordEnabled: v === 'on' })}
            options={[
              { value: 'on', label: t('enabled'), icon: 'check' },
              { value: 'off', label: t('disabled') },
            ]}
          />
          <div className={cx('mt-5 transition-opacity duration-300', !discordEnabled && 'pointer-events-none opacity-40')}>
            <TextInput
              label={t('discordAppId')}
              value={discordClientId}
              placeholder="1234567890123456789"
              invalid={idInvalid}
              onChange={(v) => integrations.set({ discordClientId: v.replace(/\s/g, '') })}
            />
            <p className="mt-2.5 text-xs text-on-surface-variant">{t('discordAppIdHint')}</p>
            {discordEnabled && discordError && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-error">
                <Icon name="error" size={16} />
                {discordError}
              </p>
            )}
          </div>
        </SettingsCard>

        <LastfmCard />
        <ListenTogetherCard />
      </div>
    </div>
  );
}

function CodeBox({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-stretch gap-2">
      <textarea
        readOnly
        value={code}
        aria-label={t('listenYourCode')}
        onFocus={(e) => e.currentTarget.select()}
        className="h-20 min-w-0 flex-1 resize-none rounded-2xl bg-on-surface/8 p-3 font-mono text-[11px] leading-snug outline-0"
      />
      <button
        type="button"
        data-ripple
        className="sl shrink-0 rounded-2xl bg-primary px-4 text-sm font-semibold text-on-primary"
        onClick={() => {
          void navigator.clipboard.writeText(code).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          });
        }}
      >
        {copied ? t('copied') : t('copy')}
      </button>
    </div>
  );
}

function ListenTogetherCard() {
  const role = useStore(listen, (s) => s.role);
  const status = useStore(listen, (s) => s.status);
  const myCode = useStore(listen, (s) => s.myCode);
  const error = useStore(listen, (s) => s.error);
  const [input, setInput] = useState('');
  const pasteBox = (label: string, action: () => void, cta: string) => (
    <div className="grid gap-2">
      <label className="text-sm font-semibold" htmlFor="listen-paste">{label}</label>
      <div className="flex items-stretch gap-2">
        <textarea
          id="listen-paste"
          value={input}
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          placeholder="RSN1.…"
          className="h-20 min-w-0 flex-1 resize-none rounded-2xl bg-on-surface/8 p-3 font-mono text-[11px] leading-snug outline-0 focus:bg-on-surface/12"
        />
        <button
          type="button"
          data-ripple
          disabled={!input.trim()}
          className="sl shrink-0 rounded-2xl bg-primary px-4 text-sm font-semibold text-on-primary disabled:opacity-40"
          onClick={() => (action(), setInput(''))}
        >
          {cta}
        </button>
      </div>
    </div>
  );

  return (
    <SettingsCard icon="group" title={t('listenTitle')} sub={t('listenDesc')} i={3}>
      {status === 'idle' && (
        <div className="grid gap-4">
          <button
            type="button"
            data-ripple
            className="sl justify-self-start rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-on-primary"
            onClick={() => void startHosting()}
          >
            {t('listenHost')}
          </button>
          {pasteBox(t('listenJoinLabel'), () => void joinSession(input), t('listenJoin'))}
        </div>
      )}
      {status === 'preparing' && <p className="text-sm text-on-surface-variant">{t('listenPreparing')}</p>}
      {status === 'awaitingAnswer' && (
        <div className="grid gap-4">
          <p className="text-sm text-on-surface-variant">{t('listenStep1Host')}</p>
          <CodeBox code={myCode} />
          {pasteBox(t('listenStep2Host'), () => void acceptAnswer(input), t('listenConnect'))}
        </div>
      )}
      {status === 'awaitingHost' && (
        <div className="grid gap-3">
          <p className="text-sm text-on-surface-variant">{t('listenStepGuest')}</p>
          <CodeBox code={myCode} />
        </div>
      )}
      {status === 'connected' && (
        <p className="flex items-center gap-2 text-sm font-semibold text-primary">
          <Icon name="check" size={18} />
          {role === 'host' ? t('listenConnectedHost') : t('listenConnectedGuest')}
        </p>
      )}
      {status !== 'idle' && (
        <button type="button" className="mt-4 text-sm font-semibold text-error hover:underline" onClick={leaveSession}>
          {t('listenLeave')}
        </button>
      )}
      {error && <p className="mt-3 text-xs text-error">{error}</p>}
    </SettingsCard>
  );
}

function LastfmCard() {
  const enabled = useStore(integrations, (s) => s.lastfmEnabled);
  const apiKey = useStore(integrations, (s) => s.lastfmApiKey);
  const secret = useStore(integrations, (s) => s.lastfmSecret);
  const user = useStore(integrations, (s) => s.lastfmUser);
  const queued = useStore(integrations, (s) => s.lastfmQueue.length);
  const scrobbled = useStore(integrations, (s) => s.lastfmScrobbled);
  const error = useStore(integrations, (s) => s.lastfmError);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const keysOk = /^[0-9a-f]{32}$/i.test(apiKey.trim()) && /^[0-9a-f]{32}$/i.test(secret.trim());

  const login = async () => {
    setBusy(true);
    setLoginError('');
    try {
      await lastfmLogin(username, password);
      setPassword('');
    } catch (e) {
      setLoginError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard icon="graphic_eq" title="Last.fm" sub={t('lastfmDesc')} i={2}>
      <Segmented
        value={enabled ? 'on' : 'off'}
        onChange={(v) => integrations.set({ lastfmEnabled: v === 'on' })}
        options={[
          { value: 'on', label: t('enabled'), icon: 'check' },
          { value: 'off', label: t('disabled') },
        ]}
      />
      <div className={cx('mt-5 grid gap-4 transition-opacity duration-300', !enabled && 'pointer-events-none opacity-40')}>
        {user ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-primary/18 text-primary">
              <Icon name="person" fill size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{user}</div>
              <div className="text-xs text-on-surface-variant">{t('lastfmStats', { n: scrobbled, q: queued })}</div>
            </div>
            <button
              type="button"
              data-ripple
              className="sl rounded-full bg-on-surface/8 px-4 py-2 text-sm font-semibold transition hover:bg-on-surface/14"
              onClick={() => void lastfmLogout()}
            >
              {t('lastfmLogout')}
            </button>
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextInput label="API key" value={apiKey} onChange={(v) => integrations.set({ lastfmApiKey: v.trim() })} />
              <TextInput label="Shared secret" type="password" value={secret} onChange={(v) => integrations.set({ lastfmSecret: v.trim() })} />
            </div>
            <p className="-mt-1 text-xs text-on-surface-variant">{t('lastfmKeysHint')}</p>
            <div className={cx('grid gap-3 sm:grid-cols-2', !keysOk && 'pointer-events-none opacity-40')}>
              <TextInput label={t('lastfmUsername')} value={username} onChange={setUsername} />
              <TextInput label={t('lastfmPassword')} type="password" value={password} onChange={setPassword} />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                data-ripple
                disabled={!keysOk || !username.trim() || !password || busy}
                className="sl rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-on-primary transition disabled:opacity-40"
                onClick={() => void login()}
              >
                {busy ? t('lastfmLoggingIn') : t('lastfmLogin')}
              </button>
              <span className="text-xs text-on-surface-variant">{t('lastfmPasswordHint')}</span>
            </div>
            {loginError && <p className="text-xs text-error">{loginError}</p>}
          </>
        )}
        {user && error && (
          <p className="flex items-center gap-1.5 text-xs text-error">
            <Icon name="error" size={16} />
            {error}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
