import { Icon } from '../components/Icon';
import { ShortcutSettings } from '../components/ShortcutSettings';
import { IconButton, type Vars } from '../components/ui';
import { t } from '../lib/i18n';
import { go } from '../state/ui';

export default function Shortcuts() {
  return (
    <div className="page max-w-[980px]">
      <header className="anim-in mb-6 mt-2">
        <div className="mb-3 flex items-center gap-2">
          <IconButton icon="arrow_back" label={t('back')} variant="tonal" size="sm" onClick={() => go({ name: 'settings' })} />
          <span className="text-sm font-semibold text-on-surface-variant">{t('settings')}</span>
        </div>
        <h1 className="display text-[clamp(32px,5.5cqw,54px)]">{t('shortcuts')}</h1>
        <p className="mt-2 text-lg text-on-surface-variant">{t('shortcutsSub')}</p>
      </header>

      <section className="card anim-in" style={{ '--i': 1 } as Vars}>
        <div className="mb-4 flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-[14px] bg-secondary-container text-on-secondary-container">
            <Icon name="keyboard" fill size={22} />
          </span>
          <div className="min-w-0">
            <h2 className="headline text-lg leading-tight">{t('shortcuts')}</h2>
            <p className="text-sm text-on-surface-variant">{t('shortcutsSub')}</p>
          </div>
        </div>
        <ShortcutSettings />
      </section>
    </div>
  );
}
