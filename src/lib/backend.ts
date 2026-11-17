import { invoke } from '@tauri-apps/api/core';

export const RPC_TIMEOUT_MS = 60_000;

/**
 * Calls the native (Rust) backend: SoundCloud API, account, settings, history and lyrics.
 *
 * Method names and payloads are the ones the former Go sidecar spoke over stdio, so every caller
 * is unchanged. The backend lives in the app process (`src-tauri/src/backend`), so there is no
 * child process to start, respawn or lose.
 *
 * An abort only stops waiting: the Rust side cannot be cancelled mid-request, and its answer is
 * discarded. The timeout keeps one stuck request from hanging a caller forever.
 */
export function rpc<T>(method: string, params: object = {}, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')));
    const timer = setTimeout(() => finish(() => reject(new Error('Request timed out'))), RPC_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    invoke<T>('backend_rpc', { method, params }).then(
      (value) => finish(() => resolve(value)),
      // Tauri rejects with the Err string; callers expect an Error with that message.
      (error) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
    );
  });
}
