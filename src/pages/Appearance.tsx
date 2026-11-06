import { useMemo, useRef, type ReactNode } from 'react';
import { hexFromArgb } from '@material/material-color-utilities';
import { Icon, type IconName } from '../components/Icon';
import { ShortcutSettings } from '../components/ShortcutSettings';
import { Button, Segmented, Slider, type Vars } from '../components/ui';
import { cx, useStore } from '../lib/util';
import { t, type Key } from '../lib/i18n';
import { buildScheme, VARIANTS, type Role } from '../lib/color';
import { appearance, DEFAULTS, processImage, setBgImage, type Appearance as A, type GlassMode } from '../state/appearance';
import { theme } from '../state/theme';
import { snack } from '../state/ui';

const set = (p: Partial<A>) => appearance.set(p);

const BG_SWATCHES = ['#25305e', '#1e3b34', '#3d1f3c', '#40261b', '#1d2f45', '#2f2a46', '#3a3a1c', '#16181d', '#4a1d2a', '#123c46', '#5b4a2e', '#2b2d42'];
const ACCENT_SWATCHES = ['#8c7cff', '#4f8cff', '#00b8a9', '#3ddc84', '#c6e33b', '#ffc542', '#ff8a3d', '#ff5470', '#e45fd6', '#a0a8b8'];

function Card({ icon, title, sub, children, i }: { icon: IconName; title: string; sub?: string; children: ReactNode; i: number }) {
  return (
    <section className="card anim-in" style={{ '--i': i } as Vars}>
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-[14px] bg-secondary-container text-on-secondary-container">
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

function Row({ label, value, children }: { label: string; value?: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <div className="mb-1 flex justify-between text-sm font-semibold">
        <span>{label}</span>
        {value && <span className="tabular-nums text-on-surface-variant">{value}</span>}
      </div>
      {children}
    </div>
  );
}

function Swatches({ colors, value, onChange, label }: { colors: string[]; value: string; onChange: (c: string) => void; label: string }) {
  const custom = !colors.includes(value.toLowerCase());
  return (
    <div className="flex flex-wrap gap-2.5">
      {colors.map((c) => (
        <button key={c} type="button" className="swatch" style={{ background: c }} data-on={value.toLowerCase() === c ? '' : undefined} aria-label={c} onClick={() => onChange(c)}>
          {value.toLowerCase() === c && <Icon name="check" className="pop" />}
        </button>
      ))}
      <label
        className="swatch cursor-pointer"
        data-on={custom ? '' : undefined}
        data-tip={label}
        style={{ background: custom ? value : 'conic-gradient(from 0deg, #ff5470, #ffc542, #3ddc84, #4f8cff, #e45fd6, #ff5470)' }}
      >
        <Icon name="colorize" />
        <input type="color" className="sr-only" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} />
      </label>
    </div>
  );
}

function GlassOption({ kind, on }: { kind: GlassMode; on: boolean }) {
  return (
    <button type="button" data-ripple className="glass-opt sl" data-on={on ? '' : undefined} onClick={() => set({ glass: kind })} aria-pressed={on}>
      <div className="glass-scene">
        <span className="orb" style={{ width: 70, height: 70, left: '8%', top: '-10%', background: 'var(--md-primary)' }} />
        <span className="orb" style={{ width: 56, height: 56, right: '10%', bottom: '-14%', background: 'var(--md-tertiary)' }} />
        <span className="orb" style={{ width: 30, height: 30, right: '34%', top: '12%', background: 'var(--md-secondary)' }} />
        <div className={cx('glass-sample', `demo-${kind}`)}>
          <Icon name="music_note" fill className="text-on-surface" />
        </div>
      </div>
      <div className="px-1">
        <div className="flex items-center gap-1.5 font-bold">
          {t(kind)}
          {on && <Icon name="check" size={18} className="pop text-primary" />}
        </div>
        <div className="text-xs text-on-surface-variant">{t(`${kind}Desc` as Key)}</div>
      </div>
    </button>
  );
}

const SHOW: Role[] = ['primary', 'primaryContainer', 'secondary', 'secondaryContainer', 'tertiary', 'tertiaryContainer', 'surfaceContainerHigh', 'onSurface'];

export default function Appearance() {
  const a = useStore(appearance, (s) => s);
  const source = useStore(theme, (s) => s.source);
  const dark = useStore(theme, (s) => s.dark);
  const roles = useStore(theme, (s) => s.roles);
  const file = useRef<HTMLInputElement>(null);

  const previews = useMemo(
    () =>
      VARIANTS.map((v) => {
        const s = buildScheme(source, source, dark, v);
        return { v, c: [s.primary, s.secondary, s.tertiary].map(hexFromArgb) };
      }),
    [source, dark],
  );

  const onFile = async (f?: File) => {
    if (!f) return;
    try {
      const data = await processImage(f);
      if (!(await setBgImage(data))) snack(t('photoError'));
    } catch (error) {
      snack(error instanceof Error && error.message === 'photoTooLarge' ? t('photoTooLarge') : t('photoError'));
    }
  };

  return (
    <div className="page max-w-[980px]">
      <header className="anim-in mb-6 mt-2">
        <h1 className="display text-[clamp(32px,5.5cqw,54px)]">{t('appearance')}</h1>
        <p className="mt-2 text-lg text-on-surface-variant">{t('appearanceSub')}</p>
      </header>

      <div className="grid gap-4">
        <Card icon="blur_on" title={t('glass')} i={1}>
          <div className="grid grid-cols-1 gap-3 @lg:grid-cols-3">
            {(['liquid', 'frosted', 'off'] as const).map((g) => (
              <GlassOption key={g} kind={g} on={a.glass === g} />
            ))}
          </div>
          <div className={cx('grid gap-x-6 @2xl:grid-cols-2', a.glass === 'off' && 'pointer-events-none opacity-40')} style={{ transition: 'opacity .3s' }}>
            <Row label={t('blur')} value={`${a.blur}%`}>
              <Slider value={a.blur} min={0} max={100} step={1} onChange={(v) => set({ blur: v })} label={t('blur')} disabled={a.glass === 'off'} />
            </Row>
            <Row label={t('tint')} value={`${a.opacity}%`}>
              <Slider value={a.opacity} min={0} max={90} step={1} onChange={(v) => set({ opacity: v })} label={t('tint')} disabled={a.glass === 'off'} />
            </Row>
            {a.glass === 'liquid' && (
              <Row label={t('refraction')} value={`${a.refraction}%`}>
                <Slider value={a.refraction} min={0} max={100} step={1} onChange={(v) => set({ refraction: v })} label={t('refraction')} />
              </Row>
            )}
          </div>
        </Card>

        <Card icon="wallpaper" title={t('background')} sub={a.bgMode === 'dynamic' ? t('dynamicHint') : undefined} i={2}>
          <Segmented
            value={a.bgMode}
            onChange={(v) => (v === 'image' && !a.bgImage ? file.current?.click() : set({ bgMode: v }))}
            options={[
              { value: 'dynamic', label: t('fromCover'), icon: 'auto_awesome' },
              { value: 'color', label: t('color'), icon: 'format_paint' },
              { value: 'image', label: t('photo'), icon: 'image' },
            ]}
          />
          <input
            ref={file}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <div key={a.bgMode} className="anim-in mt-4">
            {a.bgMode === 'dynamic' && (
              <Segmented
                size="sm"
                className="max-w-sm"
                value={a.bgStyle}
                onChange={(v) => set({ bgStyle: v })}
                options={[
                  { value: 'palette', label: t('bgPalette'), icon: 'water_drop' },
                  { value: 'artwork', label: t('bgArtwork'), icon: 'layers' },
                ]}
              />
            )}
            {a.bgMode === 'color' && <Swatches colors={BG_SWATCHES} value={a.bgColor} onChange={(c) => set({ bgColor: c })} label={t('customColor')} />}
            {a.bgMode === 'image' && (
              <div className="flex flex-wrap items-center gap-4">
                {a.bgImage && <img src={a.bgImage} alt="" className="h-24 w-40 rounded-[20px] object-cover shadow-lg" />}
                <div className="flex flex-wrap gap-2">
                  <Button variant="tonal" icon="upload" onClick={() => file.current?.click()}>
                    {a.bgImage ? t('changePhoto') : t('uploadPhoto')}
                  </Button>
                  {a.bgImage && (
                    <Button variant="outlined" icon="delete" onClick={() => { void setBgImage(null); }}>
                      {t('removePhoto')}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
          {(a.bgMode === 'image' || (a.bgMode === 'dynamic' && a.bgStyle === 'artwork')) && (
            <div className="grid gap-x-6 @2xl:grid-cols-2">
              <Row label={t('dim')} value={`${a.bgDim}%`}>
                <Slider value={a.bgDim} min={0} max={85} step={1} onChange={(v) => set({ bgDim: v })} label={t('dim')} />
              </Row>
              <Row label={t('bgBlur')} value={`${a.bgBlur}px`}>
                <Slider value={a.bgBlur} min={0} max={60} step={1} onChange={(v) => set({ bgBlur: v })} label={t('bgBlur')} />
              </Row>
            </div>
          )}
        </Card>

        <Card icon="palette" title={t('accent')} sub={a.accentMode === 'dynamic' ? t('dynamicHint') : undefined} i={3}>
          <Segmented
            value={a.accentMode}
            onChange={(v) => set({ accentMode: v })}
            options={[
              { value: 'dynamic', label: t('fromCover'), icon: 'auto_awesome' },
              { value: 'custom', label: t('custom'), icon: 'colorize' },
            ]}
          />
          {a.accentMode === 'custom' && (
            <div className="anim-in mt-4">
              <Swatches colors={ACCENT_SWATCHES} value={a.accentColor} onChange={(c) => set({ accentColor: c })} label={t('customColor')} />
            </div>
          )}
          <div className="mt-5 text-sm font-semibold">{t('currentScheme')}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {SHOW.map((r) => (
              <span key={r} className="h-9 min-w-9 flex-1 rounded-[12px] shadow-inner" style={{ background: roles[r], transition: 'background-color .7s' }} title={r} />
            ))}
          </div>
        </Card>

        <Card icon="auto_awesome" title={t('colorStyle')} i={4}>
          <div className="grid grid-cols-2 gap-2 @lg:grid-cols-4">
            {previews.map(({ v, c }) => (
              <button
                key={v}
                type="button"
                data-ripple
                className={cx('chip sl !h-auto justify-start !rounded-[18px] !px-3 !py-3', a.variant === v && '!rounded-[26px]')}
                data-on={a.variant === v ? '' : undefined}
                onClick={() => set({ variant: v })}
              >
                <span className="flex -space-x-1.5">
                  {c.map((x, k) => (
                    <span key={k} className="h-6 w-6 rounded-full ring-2 ring-[var(--md-surface-container-high)]" style={{ background: x }} />
                  ))}
                </span>
                <span className="truncate">{t(v as Key)}</span>
              </button>
            ))}
          </div>
        </Card>

        <div className="grid gap-4 @3xl:grid-cols-2">
          <Card icon="contrast" title={t('theme')} i={5}>
            <Segmented
              value={a.theme}
              onChange={(v) => set({ theme: v })}
              options={[
                { value: 'dark', label: t('dark'), icon: 'dark_mode' },
                { value: 'light', label: t('light'), icon: 'light_mode' },
                { value: 'system', label: t('system'), icon: 'brightness_auto' },
              ]}
            />
          </Card>
          <Card icon="animation" title={t('motion')} i={6}>
            <Segmented
              value={a.motion}
              onChange={(v) => set({ motion: v })}
              options={[
                { value: 'expressive', label: t('motionExpressive') },
                { value: 'standard', label: t('motionStandard') },
                { value: 'reduced', label: t('motionReduced') },
              ]}
            />
          </Card>
          <Card icon="translate" title={t('language')} i={7}>
            <Segmented
              value={a.lang}
              onChange={(v) => set({ lang: v })}
              options={[
                { value: 'ru', label: 'Русский' },
                { value: 'en', label: 'English' },
              ]}
            />
          </Card>
          <Card icon="keyboard" title={t('shortcuts')} i={8}>
            <ShortcutSettings />
          </Card>
        </div>

        <div className="anim-in flex justify-center py-4" style={{ '--i': 9 } as Vars}>
          <Button
            variant="outlined"
            icon="refresh"
            onClick={() => {
              void setBgImage(null);
              set({ ...DEFAULTS, lang: a.lang });
            }}
          >
            {t('reset')}
          </Button>
        </div>
      </div>
    </div>
  );
}
