import { useEffect, useState } from 'react';
import { IconButton, Menu, MenuItem } from './ui';
import { t } from '../lib/i18n';
import { useStore } from '../lib/util';
import { formatRemaining, remainingMs, SLEEP_PRESETS_MIN } from '../lib/sleep-timer-plan';
import { setSleepTimer, sleepTimer } from '../state/sleep-timer';

/** Re-renders once a second while a countdown is visible. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function SleepTimerButton() {
  const mode = useStore(sleepTimer, (s) => s.mode);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const now = useNow(mode.kind === 'at');
  const left = remainingMs(mode, now);
  const label =
    mode.kind === 'at' && left !== null
      ? t('sleepTimerLeft', { time: formatRemaining(left) })
      : mode.kind === 'endOfTrack'
        ? `${t('sleepTimer')}: ${t('sleepTimerEndOfTrack')}`
        : t('sleepTimer');
  const close = () => setAnchor(null);
  const pick = (v: Parameters<typeof setSleepTimer>[0]) => {
    setSleepTimer(v);
    close();
  };

  return (
    <>
      <IconButton
        icon="bedtime"
        label={label}
        variant="tonal"
        selected={mode.kind !== 'off' || !!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      />
      <Menu anchor={anchor} open={!!anchor} onClose={close}>
        {SLEEP_PRESETS_MIN.map((n, i) => (
          <MenuItem key={n} i={i} icon="bedtime" label={t('sleepTimerMinutes', { n })} onClick={() => pick({ minutes: n })} />
        ))}
        <MenuItem
          i={SLEEP_PRESETS_MIN.length}
          icon="music_note"
          label={t('sleepTimerEndOfTrack')}
          checked={mode.kind === 'endOfTrack'}
          onClick={() => pick('endOfTrack')}
        />
        {mode.kind !== 'off' && (
          <MenuItem i={SLEEP_PRESETS_MIN.length + 1} icon="close" label={t('sleepTimerOff')} onClick={() => pick('off')} />
        )}
      </Menu>
    </>
  );
}
