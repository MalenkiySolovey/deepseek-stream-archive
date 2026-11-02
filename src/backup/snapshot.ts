import {
  INCLUDED_BACKUP_STORES,
  EXCLUDED_BACKUP_STORES,
  PORTABLE_BACKUP_FORMAT,
  PORTABLE_BACKUP_FORMAT_VERSION,
  MAX_IN_MEMORY_PORTABLE_BACKUP_SOURCE_BYTES,
  type IncludedBackupStoreName,
  type PortableBackupManifestRecord,
  type PortableBackupStoreRecord,
  type PortableBackupFooterRecord,
  type PortableBackupStoreCounts,
} from './format';
import { DB_NAME, DB_VERSION } from '../storage/schema';

export interface PortableBackupSnapshot {
  manifest: PortableBackupManifestRecord;
  records: PortableBackupStoreRecord[];
  footer: PortableBackupFooterRecord;
  totalRecordCount: number;
  estimatedBytes: number;
}

export interface CreateSnapshotOptions {
  maxBytes?: number;
  appVersion?: string;
  now?: number;
}

/**
 * Compare two primary key values deterministically.
 */
function compareKeys(a: unknown, b: unknown): number {
  const strA = String(a ?? '');
  const strB = String(b ?? '');
  if (strA < strB) return -1;
  if (strA > strB) return 1;
  return 0;
}

/**
 * Create a point-in-time snapshot of the database across all included stores
 * within a single multi-store readonly IndexedDB transaction.
 */
export async function createPortableBackupSnapshot(
  db: IDBDatabase,
  options: CreateSnapshotOptions = {}
): Promise<PortableBackupSnapshot> {
  const maxBytes = options.maxBytes ?? MAX_IN_MEMORY_PORTABLE_BACKUP_SOURCE_BYTES;
  const now = options.now ?? Date.now();
  const appVersion = options.appVersion ?? '0.1.0';

  return new Promise<PortableBackupSnapshot>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction([...INCLUDED_BACKUP_STORES], 'readonly');
    } catch (err) {
      return reject(new Error(`Failed to open multi-store readonly transaction for backup: ${(err as Error).message}`));
    }

    const storeData: Record<IncludedBackupStoreName, Record<string, unknown>[]> = {
      conversations: [],
      messages: [],
      revisions: [],
      recovery_events: [],
      raw_streams: [],
      raw_stream_batches: [],
    };

    let pendingStores = INCLUDED_BACKUP_STORES.length;
    let hasFailed = false;

    for (const storeName of INCLUDED_BACKUP_STORES) {
      const store = tx.objectStore(storeName);
      const req = store.getAll();

      req.onsuccess = () => {
        if (hasFailed) return;
        storeData[storeName] = (req.result as Record<string, unknown>[]) || [];
        pendingStores--;
        if (pendingStores === 0) {
          finalizeSnapshot();
        }
      };

      req.onerror = () => {
        if (hasFailed) return;
        hasFailed = true;
        reject(req.error || new Error(`Failed to read store ${storeName} for backup snapshot`));
      };
    }

    tx.onerror = () => {
      if (!hasFailed) {
        hasFailed = true;
        reject(tx.error || new Error('Transaction failed during portable backup snapshot'));
      }
    };

    function finalizeSnapshot() {
      // 1. Sort records deterministically by primary key within each store
      storeData.conversations.sort((a, b) => compareKeys(a.id, b.id));
      storeData.messages.sort((a, b) => compareKeys(a.id, b.id));
      storeData.revisions.sort((a, b) => compareKeys(a.id, b.id));
      storeData.recovery_events.sort((a, b) => compareKeys(a.id, b.id));
      storeData.raw_streams.sort((a, b) => compareKeys(a.id, b.id));
      storeData.raw_stream_batches.sort((a, b) => compareKeys(a.id, b.id));

      const counts: PortableBackupStoreCounts = {
        conversations: storeData.conversations.length,
        messages: storeData.messages.length,
        revisions: storeData.revisions.length,
        recovery_events: storeData.recovery_events.length,
        raw_streams: storeData.raw_streams.length,
        raw_stream_batches: storeData.raw_stream_batches.length,
      };

      const records: PortableBackupStoreRecord[] = [];
      let estimatedBytes = 0;

      // 2. Linearize records strictly in defined store order
      for (const storeName of INCLUDED_BACKUP_STORES) {
        const items = storeData[storeName];
        for (const item of items) {
          // Rough byte accounting for safety ceiling
          const jsonFragment = JSON.stringify(item);
          estimatedBytes += jsonFragment.length + 32;

          if (estimatedBytes > maxBytes) {
            hasFailed = true;
            return reject(
              new Error(
                'This archive is too large for the current portable backup implementation. No backup file was created.'
              )
            );
          }

          records.push({
            kind: 'record',
            store: storeName,
            value: item,
          });
        }
      }

      // 3. Build manifest
      const manifest: PortableBackupManifestRecord = {
        kind: 'manifest',
        format: PORTABLE_BACKUP_FORMAT,
        formatVersion: PORTABLE_BACKUP_FORMAT_VERSION,
        createdAt: now,
        appVersion,
        sourceDatabase: DB_NAME,
        sourceDatabaseVersion: DB_VERSION,
        encoding: 'utf-8',
        compression: 'gzip',
        includedStores: [...INCLUDED_BACKUP_STORES],
        excludedStores: [...EXCLUDED_BACKUP_STORES],
        privacy: {
          containsConversationContent: true,
          containsReasoning: true,
          containsRecoveredContent: true,
          containsRawNetworkEvidence: true,
        },
      };

      // 4. Build footer
      const footer: PortableBackupFooterRecord = {
        kind: 'footer',
        complete: true,
        counts,
      };

      resolve({
        manifest,
        records,
        footer,
        totalRecordCount: records.length,
        estimatedBytes,
      });
    }
  });
}
