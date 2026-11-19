/** Local playback commands are disabled for guests except while applying host sync. */
export function createPlaybackAccess() {
  let locked = false;
  let remoteDepth = 0;
  const lockListeners = new Set<(locked: boolean) => void>();

  return {
    setLocked(value: boolean) {
      if (locked === value) return;
      locked = value;
      for (const listener of lockListeners) listener(value);
    },
    subscribeLock(listener: (locked: boolean) => void) {
      lockListeners.add(listener);
      return () => lockListeners.delete(listener);
    },
    isLocked() {
      return locked;
    },
    canControl() {
      return !locked || remoteDepth > 0;
    },
    withRemote<T>(action: () => T): T {
      remoteDepth += 1;
      try {
        return action();
      } finally {
        remoteDepth -= 1;
      }
    },
  };
}

export const playbackAccess = createPlaybackAccess();
