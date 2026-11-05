import { DB_NAME, DB_VERSION, configureDatabaseSchema, STORE_CANONICAL_CHECKPOINTS } from './schema';
import { recordStorageMutation, touchDurableMutationEpoch } from './mutation-tracker';

const factoryDbMap = new WeakMap<IDBFactory, Map<string, IDBDatabase>>();
let defaultDatabase: IDBDatabase | null = null;
const allActiveDatabases = new Set<IDBDatabase>();

export function openExtensionDatabase(idbFactory?: IDBFactory, dbName: string = DB_NAME): Promise<IDBDatabase> {
  const factory = idbFactory || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  if (!factory) {
    return Promise.reject(new Error('IndexedDB factory is not available in the current environment.'));
  }

  // Return cached instance if available and open
  if (idbFactory) {
    const map = factoryDbMap.get(idbFactory);
    const cached = map?.get(dbName);
    if (cached) {
      if ((cached as any)._closed) {
        map?.delete(dbName);
        allActiveDatabases.delete(cached);
      } else {
        try {
          // Probe if database connection is active
          const probeStore = cached.objectStoreNames[0];
          if (probeStore) {
            const probeTx = cached.transaction([probeStore], 'readonly');
            probeTx.abort();
          }
          return Promise.resolve(cached);
        } catch {
          map?.delete(dbName);
          allActiveDatabases.delete(cached);
        }
      }
    }
  } else if (dbName === DB_NAME && defaultDatabase) {
    if ((defaultDatabase as any)._closed) {
      defaultDatabase = null;
    } else {
      try {
        const probeStore = defaultDatabase.objectStoreNames[0];
        if (probeStore) {
          const probeTx = defaultDatabase.transaction([probeStore], 'readonly');
          probeTx.abort();
        }
        return Promise.resolve(defaultDatabase);
      } catch {
        defaultDatabase = null;
      }
    }
  }

  return new Promise((resolve, reject) => {
    const request = factory.open(dbName, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const tx = (event.target as IDBOpenDBRequest).transaction;
      configureDatabaseSchema(db, tx);
    };

    request.onsuccess = () => {
      const db = request.result;
      (db as any).__idbFactory = factory;
      allActiveDatabases.add(db);

      const cleanup = () => {
        allActiveDatabases.delete(db);
        if (idbFactory) {
          const map = factoryDbMap.get(idbFactory);
          map?.delete(dbName);
        } else if (defaultDatabase === db && dbName === DB_NAME) {
          defaultDatabase = null;
        }
      };

      db.onclose = cleanup;
      db.onversionchange = () => {
        try {
          db.close();
        } catch {
          // ignore
        }
        cleanup();
      };

      if (idbFactory) {
        let map = factoryDbMap.get(idbFactory);
        if (!map) {
          map = new Map();
          factoryDbMap.set(idbFactory, map);
        }
        map.set(dbName, db);
      } else if (dbName === DB_NAME) {
        defaultDatabase = db;
      }

      resolve(db);
    };

    request.onerror = () => {
      reject(request.error || new Error(`Failed to open IndexedDB database "${dbName}".`));
    };

    request.onblocked = () => {
      reject(new Error(`IndexedDB database "${dbName}" open request was blocked by an older connection.`));
    };
  });
}

export function closeExtensionDatabase(idbFactory?: IDBFactory, dbName?: string): void {
  if (idbFactory) {
    const map = factoryDbMap.get(idbFactory);
    if (map) {
      if (dbName) {
        const db = map.get(dbName);
        if (db) {
          try {
            db.close();
          } catch {
            // ignore
          }
          map.delete(dbName);
          allActiveDatabases.delete(db);
        }
      } else {
        for (const db of map.values()) {
          try {
            db.close();
          } catch {
            // ignore
          }
          allActiveDatabases.delete(db);
        }
        map.clear();
      }
    }
  } else {
    const toRemove: IDBDatabase[] = [];
    for (const db of allActiveDatabases) {
      if (!dbName || db.name === dbName) {
        try {
          db.close();
        } catch {
          // ignore
        }
        toRemove.push(db);
      }
    }
    for (const db of toRemove) {
      allActiveDatabases.delete(db);
      if (defaultDatabase === db) {
        defaultDatabase = null;
      }
    }
  }
}

/**
 * Completely deletes an IndexedDB database (e.g. for cleaning up staging databases).
 * Fails closed if deletion is blocked or encounters error, ensuring no corrupt/stale DB is used.
 */
export async function deleteExtensionDatabase(idbFactory?: IDBFactory, dbName: string = DB_NAME): Promise<void> {
  const factory = idbFactory || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  if (!factory) {
    return Promise.reject(new Error('IndexedDB factory is not available in the current environment.'));
  }

  // Ensure connections to this database are closed first
  closeExtensionDatabase(idbFactory, dbName);

  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(dbName);
    let settled = false;
    let blockedTimeout: any = null;

    request.onsuccess = () => {
      if (settled) return;
      settled = true;
      if (blockedTimeout) clearTimeout(blockedTimeout);
      resolve();
    };

    request.onerror = () => {
      if (settled) return;
      settled = true;
      if (blockedTimeout) clearTimeout(blockedTimeout);
      reject(request.error || new Error(`Failed to delete IndexedDB database "${dbName}".`));
    };

    request.onblocked = () => {
      // onblocked indicates active unclosed connections are preventing deletion.
      // Attempt closing known active connections and wait with timeout rather than falsely resolving.
      closeExtensionDatabase(idbFactory, dbName);
      if (!blockedTimeout) {
        blockedTimeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error(`Timed out waiting for IndexedDB database "${dbName}" to unblock for deletion.`));
          }
        }, 8000);
      }
    };
  });
}

/**
 * Creates a readwrite transaction, preferring strict durability hint where supported.
 * Automatically enlists `STORE_CANONICAL_CHECKPOINTS` to record durable mutation epoch.
 * Falls back to standard transaction if the environment rejects IDBTransactionOptions.
 */
export function createDurableWriteTransaction(
  db: IDBDatabase,
  storeNames: string | string[],
  durability: 'strict' | 'relaxed' | 'default' = 'strict'
): IDBTransaction {
  const stores = Array.isArray(storeNames) ? [...storeNames] : [storeNames];

  // Enlist canonical checkpoints store if present for durable mutation epoch tracking
  if (
    db.objectStoreNames.contains(STORE_CANONICAL_CHECKPOINTS) &&
    !stores.includes(STORE_CANONICAL_CHECKPOINTS)
  ) {
    stores.push(STORE_CANONICAL_CHECKPOINTS);
  }

  let tx: IDBTransaction;
  try {
    tx = (db as any).transaction(stores, 'readwrite', { durability });
  } catch {
    tx = db.transaction(stores, 'readwrite');
  }

  touchDurableMutationEpoch(tx);

  try {
    if (typeof tx.addEventListener === 'function') {
      tx.addEventListener('complete', () => {
        recordStorageMutation();
      });
    }
  } catch {
    // ignore
  }

  return tx;
}

/**
 * Backward-compatible alias for createDurableWriteTransaction.
 */
export const createRawWriteTransaction = createDurableWriteTransaction;
