import { type ReactNode } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { IconButton, Segmented, type Vars } from '../components/ui';
import { cx, useStore } from '../lib/util';
import { t } from '../lib/i18n';
import { integrations, isValidDiscordId } from '../state/integrations';
import { go } from '../state/ui';

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
      </div>
    </div>
  );
}
