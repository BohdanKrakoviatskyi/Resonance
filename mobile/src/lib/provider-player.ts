export type ProviderPlaybackState = { playing: boolean; loading: boolean; position: number; duration: number; ended?: boolean };
type Controls = { play: () => void; pause: () => void; seek: (seconds: number) => void; setVolume: (volume: number) => void; destroy: () => void };
type Command = keyof Omit<Controls, 'destroy'>;
type Pending = { playback?: 'play' | 'pause'; seek?: number; volume?: number };

let controls: Controls | undefined;
let pending: Pending = {};
let lastState: ProviderPlaybackState | undefined;
const listeners = new Set<(state: ProviderPlaybackState) => void>();

function isolate(fn: () => void) {
  try {
    fn();
  } catch (error) {
    console.error('[provider-player]', error);
  }
}

function run(command: Command, value: number | undefined) {
  if (!controls) return;
  if (command === 'seek') isolate(() => controls?.seek(value ?? 0));
  else if (command === 'setVolume') isolate(() => controls?.setVolume(value ?? 0));
  else isolate(() => controls?.[command]());
}

function sameState(a: ProviderPlaybackState, b: ProviderPlaybackState) {
  return a.playing === b.playing && a.loading === b.loading && a.position === b.position && a.duration === b.duration && !!a.ended === !!b.ended;
}

export function registerProviderControls(next: Controls) {
  const previous = controls;
  controls = next;
  isolate(() => previous?.destroy());
  const { playback, seek, volume } = pending;
  pending = {};
  if (seek !== undefined) run('seek', seek);
  if (volume !== undefined) run('setVolume', volume);
  if (playback) run(playback, undefined);
  return () => {
    if (controls !== next) return;
    controls = undefined;
    lastState = undefined;
    isolate(() => next.destroy());
  };
}

export function providerCommand(command: Command, value?: number) {
  if (controls) return run(command, value);
  if (command === 'seek') pending.seek = value ?? 0;
  else if (command === 'setVolume') pending.volume = value ?? 0;
  else pending.playback = command;
}

export function publishProviderState(state: ProviderPlaybackState) {
  if (lastState && sameState(lastState, state)) return;
  lastState = state;
  listeners.forEach((listener) => isolate(() => listener(state)));
}

export function getProviderState() {
  return lastState;
}

export function onProviderState(listener: (state: ProviderPlaybackState) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
