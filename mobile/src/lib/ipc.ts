import { invoke } from '@tauri-apps/api/core';
import { RPC_TIMEOUT_MS } from './backend';

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

export function invokeAbortable<T>(
  cmd: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(abortError()));
    // Same limit as the desktop build: a hung command must not leave the UI spinning forever.
    const timer = setTimeout(() => finish(() => reject(new Error('Request timed out'))), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    invoke<T>(cmd, args).then(
      (value) => finish(() => resolve(value)),
      (err) => finish(() => reject(err)),
    );
  });
}

export type Inflight<T> = { promise: Promise<T>; controller: AbortController; refs: number };

export function shareInflight<T>(
  map: Map<string, Inflight<T>>,
  key: string,
  run: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  let shared = map.get(key);
  if (!shared) {
    const controller = new AbortController();
    const promise: Promise<T> = run(controller.signal).finally(() => {
      if (map.get(key)?.promise === promise) map.delete(key);
    });
    shared = { promise, controller, refs: 0 };
    map.set(key, shared);
  }
  shared.refs++;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortError());
      if (--shared.refs === 0) {
        shared.controller.abort();
        if (map.get(key) === shared) map.delete(key);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    shared.promise.then(
      (value) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
