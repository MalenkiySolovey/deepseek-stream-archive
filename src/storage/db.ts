import { DB_NAME, DB_VERSION, configureDatabaseSchema } from './schema';

const factoryDbMap = new WeakMap<IDBFactory, IDBDatabase>();
let defaultDatabase: IDBDatabase | null = null;
const allActiveDatabases = new Set<IDBDatabase>();

export function openExtensionDatabase(idbFactory?: IDBFactory): Promise<IDBDatabase> {
  const factory = idbFactory || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  if (!factory) {
    return Promise.reject(new Error('IndexedDB factory is not available in the current environment.'));
  }

  // Return cached instance if available and open
  if (idbFactory) {
    const cached = factoryDbMap.get(idbFactory);
    if (cached) return Promise.resolve(cached);
  } else if (defaultDatabase) {
    return Promise.resolve(defaultDatabase);
  }

  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const tx = (event.target as IDBOpenDBRequest).transaction;
      configureDatabaseSchema(db, tx);
    };

    request.onsuccess = () => {
      const db = request.result;
      allActiveDatabases.add(db);

      const cleanup = () => {
        allActiveDatabases.delete(db);
        if (idbFactory) {
          factoryDbMap.delete(idbFactory);
        } else if (defaultDatabase === db) {
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
        factoryDbMap.set(idbFactory, db);
      } else {
        defaultDatabase = db;
      }

      resolve(db);
    };

    request.onerror = () => {
      reject(request.error || new Error('Failed to open IndexedDB database.'));
    };

    request.onblocked = () => {
      reject(new Error('IndexedDB database open request was blocked by an older connection.'));
    };
  });
}

export function closeExtensionDatabase(idbFactory?: IDBFactory): void {
  if (idbFactory) {
    const db = factoryDbMap.get(idbFactory);
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
      factoryDbMap.delete(idbFactory);
      allActiveDatabases.delete(db);
    }
  } else {
    for (const db of allActiveDatabases) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    allActiveDatabases.clear();
    defaultDatabase = null;
  }
}

/**
 * Creates a readwrite transaction, preferring strict durability hint where supported.
 * Falls back to standard transaction if the environment rejects IDBTransactionOptions.
 */
export function createDurableWriteTransaction(
  db: IDBDatabase,
  storeNames: string | string[],
  durability: 'strict' | 'relaxed' | 'default' = 'strict'
): IDBTransaction {
  try {
    return (db as any).transaction(storeNames, 'readwrite', { durability });
  } catch {
    return db.transaction(storeNames, 'readwrite');
  }
}

/**
 * Backward-compatible alias for createDurableWriteTransaction.
 */
export const createRawWriteTransaction = createDurableWriteTransaction;



