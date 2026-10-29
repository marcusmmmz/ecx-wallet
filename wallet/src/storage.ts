// Storage for hosts without extension APIs: memory for the session, IndexedDB for persistence.
import type { KeyValueStore } from "./vault";

/** Copies values like persistent storage does, so a caller cannot change a stored key by reference. */
export function createMemoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    async set(key, value) {
      values.set(key, structuredClone(value));
    },
    async remove(key) {
      values.delete(key);
    },
    keys: async () => [...values.keys()],
  };
}

/**
 * One database for a host's persistent wallet data. Opened lazily so importing wallet logic also
 * works in Node; writes resolve only once committed, not when their request first succeeds.
 */
export function createIndexedDBStore(name: string): KeyValueStore {
  const STORE = "values";
  let opening: Promise<IDBDatabase> | undefined;

  function database(): Promise<IDBDatabase> {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opening = undefined;
        };
        resolve(db);
      };
    }).catch((error) => {
      opening = undefined;
      throw error;
    });
    return opening;
  }

  async function run<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = operation(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? request.error ?? new Error("Storage transaction aborted."));
      transaction.onerror = () => reject(transaction.error ?? request.error);
    });
  }

  return {
    get: <T>(key: string) => run<T | undefined>("readonly", (store) => store.get(key)),
    async set(key, value) {
      await run("readwrite", (store) => store.put(value, key));
    },
    async remove(key) {
      await run("readwrite", (store) => store.delete(key));
    },
    keys: async () => (await run("readonly", (store) => store.getAllKeys())).map((key) => String(key)),
  };
}
