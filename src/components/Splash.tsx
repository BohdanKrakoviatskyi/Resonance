import { useEffect, useState, type MouseEvent } from 'react';
import { Logo } from './Sidebar';
import { t, useLang } from '../lib/i18n';
import { cx, useStore } from '../lib/util';
import {
  APP_VERSION,
  checkForUpdates,
  finishSplash,
  hasTauriRuntime,
  startInstallNewVersion,
  updater,
} from '../state/updater';

export default function Splash() {
  useLang();
  const st = useStore(updater, (s) => s);
  const [phase, setPhase] = useState<'checking' | 'updating'>('checking');
  const [progress, setProgress] = useState(0);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const closeAndShowMain = async () => {
      if (cancelled) return;
      setExiting(true);
      await new Promise((r) => window.setTimeout(r, 150));
      await finishSplash();
    };

    const run = async () => {
      if (import.meta.env.DEV && hasTauriRuntime()) {
        await new Promise((resolve) => window.setTimeout(resolve, 1800));
        if (!cancelled) await closeAndShowMain();
        return;
      }

      try {
        const res = await checkForUpdates(true);
        if (cancelled) return;

        if (!res.available) {
          await closeAndShowMain();
          return;
        }

        setPhase('updating');
        setProgress(2);
        await startInstallNewVersion((pct) => {
          if (!cancelled) setProgress(pct);
        });
        // If startInstallNewVersion returns without relaunching, fall back to opening main window.
        if (!cancelled) {
          await closeAndShowMain();
        }
      } catch {
        if (!cancelled) {
          await closeAndShowMain();
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !hasTauriRuntime()) return;
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().startDragging())
      .catch(() => {});
  };

  return (
    <div
      data-tauri-drag-region
      onMouseDown={onMouseDown}
      className={cx('splash-root', exiting && 'splash-exit')}
    >
      <div data-tauri-drag-region className="splash-card">
        <div className="splash-glow splash-glow-1" aria-hidden="true" />
        <div className="splash-glow splash-glow-2" aria-hidden="true" />

        <div className="splash-body">
          <div className="splash-logo-wrap">
            <div className="splash-logo-halo" aria-hidden="true" />
            <Logo size={92} />
          </div>

          <h1 className="display mt-6 text-[32px] text-on-surface">Resonance</h1>

          <p className="mt-2 text-[15px] font-semibold text-on-surface">
            {phase === 'updating'
              ? progress >= 100
                ? t('splashInstalling')
                : t('splashUpdating')
              : t('splashChecking')}
          </p>

          <p className="mt-1 text-[13px] text-on-surface-variant">
            {phase === 'updating' ? (
              <span className="splash-ver-pill">
                <span>{st.currentVersion}</span>
                <span className="text-primary">→</span>
                <span className="font-bold text-primary">{st.latestVersion}</span>
              </span>
            ) : (
              t('updateChecking')
            )}
          </p>
        </div>

        <div className="splash-footer">
          <div className="splash-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={phase === 'updating' ? progress : undefined}>
            {phase === 'updating' ? (
              <div
                className="splash-progress-fill"
                style={{ width: `${Math.max(4, Math.min(100, progress))}%` }}
              />
            ) : (
              <div className="splash-progress-indeterminate" />
            )}
          </div>
          <div className="mt-2.5 flex items-center justify-between text-[12px] font-semibold text-on-surface-variant">
            <span>v{APP_VERSION}</span>
            {phase === 'updating' && <span className="tabular-nums text-primary">{progress}%</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
