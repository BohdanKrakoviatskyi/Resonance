const DB = 'resonance-local';
const STORE = 'files';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = run(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const idbPutFile = (id: string, file: Blob) => tx('readwrite', (s) => s.put(file, id));
export const idbGetFile = (id: string) => tx<Blob | undefined>('readonly', (s) => s.get(id));
export const idbDeleteFile = (id: string) => tx<undefined>('readwrite', (s) => s.delete(id));

export function idbGetAll(): Promise<[string, Blob][]> {
  return open().then(
    (db) =>
      new Promise<[string, Blob][]>((resolve, reject) => {
        const out: [string, Blob][] = [];
        const c = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
        c.onsuccess = () => {
          const cursor = c.result;
          if (cursor) {
            out.push([String(cursor.key), cursor.value as Blob]);
            cursor.continue();
          } else resolve(out);
        };
        c.onerror = () => reject(c.error);
      }),
  );
}

export const idbClearFiles = (ids: string[]) =>
  open().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
        for (const id of ids) store.delete(id);
        store.transaction.oncomplete = () => resolve();
        store.transaction.onerror = () => reject(store.transaction.error);
      }),
  );
