/**
 * Recognises the SoundCloud failures that come from the session itself, not from the track.
 * The backend marks them (`SESSION_EXPIRED` / `NOT_CONNECTED` in `src-tauri/src/backend/util.rs`),
 * and they are the one kind of failure a fallback track cannot fix: the app has no working session
 * until the account is connected again.
 */
const SESSION_EXPIRED_MARKER = 'soundcloud_session_expired';
const NOT_CONNECTED = 'сначала подключите аккаунт SoundCloud';

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : '';
}

export function isSoundCloudAuthError(error: unknown): boolean {
  const message = messageOf(error);
  return message.includes(SESSION_EXPIRED_MARKER) || message.includes(NOT_CONNECTED);
}
