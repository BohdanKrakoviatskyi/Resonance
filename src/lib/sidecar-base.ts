import { Command, type Child } from '@tauri-apps/plugin-shell';

type RpcResponse<T> = { id: number; result?: T; error?: string };
type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void };

export const RPC_TIMEOUT_MS = 60_000;

export function createSidecarClient(opts: {
  binary: string;
  stderrPrefix?: string;
  stoppedMessage: string;
  startErrorMessage?: string;
  sendErrorMessage?: string;
  suppressStderr?: boolean;
}) {
  let child: Promise<Child> | undefined;
  let nextId = 0;
  let buffer = '';
  const pending = new Map<number, Pending>();

  function failPending(message: string) {
    pending.forEach(({ reject }) => reject(new Error(message)));
    pending.clear();
  }

  function handleLine(line: string) {
    if (!line.trim()) return;
    try {
      const response = JSON.parse(line) as RpcResponse<unknown>;
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      if (response.error) request.reject(new Error(response.error));
      else request.resolve(response.result);
    } catch {
      // Ignore malformed output; sidecar diagnostics belong on stderr.
    }
  }

  function start() {
    const command = Command.sidecar(opts.binary);
    command.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
      // Prevent unbounded growth if the sidecar stops sending newlines.
      if (buffer.length > 50_000_000) {
        failPending('Local API output too large');
        buffer = '';
      }
    });
    if (opts.suppressStderr) command.stderr.on('data', () => {});
    else if (opts.stderrPrefix) command.stderr.on('data', (line) => console.error(opts.stderrPrefix as string, line));
    else command.stderr.on('data', (line) => console.error(line));
    command.on('error', (error) =>
      failPending(opts.suppressStderr ? opts.stoppedMessage : String(error)),
    );
    command.on('close', () => {
      failPending(opts.stoppedMessage);
      buffer = '';
      child = undefined;
    });
    return command.spawn();
  }

  return async function rpc<T>(method: string, params: object = {}, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const starting = child ?? (child = start());
    let process: Child;
    try {
      process = await starting;
    } catch (error) {
      if (child === starting) child = undefined;
      if (opts.startErrorMessage) throw new Error(opts.startErrorMessage);
      throw error;
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (timer !== undefined) clearTimeout(timer);
        pending.delete(id);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        if (pending.delete(id)) {
          signal?.removeEventListener('abort', onAbort);
          reject(new Error('Request timed out'));
        }
      }, RPC_TIMEOUT_MS);
      pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value as T); },
        reject: (error) => { cleanup(); reject(error); },
      });
      process.write(`${JSON.stringify({ id, method, params })}\n`).catch((error: Error) => {
        if (timer !== undefined) clearTimeout(timer);
        pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        if (opts.sendErrorMessage) reject(new Error(opts.sendErrorMessage));
        else reject(error);
      });
    });
  };
}
