import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openExtensionDatabase, closeExtensionDatabase } from '../src/storage/db';
import {
  DB_NAME,
  DB_VERSION,
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
  STORE_RECOVERY_EVENTS,
  STORE_RAW_STREAMS,
  STORE_RAW_STREAM_BATCHES,
  STORE_CANONICAL_CHECKPOINTS,
} from '../src/storage/schema';

describe('Database Migration & Multi-Factory Caching (v1 -> v3 & v2 -> v3)', () => {
  let fakeFactory: IDBFactory;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
  });

  afterEach(() => {
    closeExtensionDatabase(fakeFactory);
    closeExtensionDatabase();
  });

  it('preserves existing v1 data when upgrading schema to v3', async () => {
    // 1. Manually initialize database at Version 1
    await new Promise<void>((resolve, reject) => {
      const openReq = fakeFactory.open(DB_NAME, 1);
      openReq.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        const convStore = db.createObjectStore(STORE_CONVERSATIONS, { keyPath: 'id' });
        convStore.createIndex('remoteId', 'remoteId', { unique: false });
        convStore.createIndex('updatedAt', 'updatedAt', { unique: false });

        const msgStore = db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' });
        msgStore.createIndex('conversationId', 'conversationId', { unique: false });

        const revStore = db.createObjectStore(STORE_REVISIONS, { keyPath: 'id' });
        revStore.createIndex('messageId', 'messageId', { unique: false });

        const recStore = db.createObjectStore(STORE_RECOVERY_EVENTS, { keyPath: 'id' });
        recStore.createIndex('messageId', 'messageId', { unique: false });
      };
      openReq.onsuccess = () => {
        const db = openReq.result;
        // Insert dummy records in v1 stores
        const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
        tx.objectStore(STORE_CONVERSATIONS).put({
          id: 'v1-conv-1',
          title: 'Legacy Session V1',
          createdAt: 1000,
          updatedAt: 1000,
        });
        tx.objectStore(STORE_MESSAGES).put({
          id: 'v1-msg-1',
          conversationId: 'v1-conv-1',
          role: 'user',
          status: 'finished',
          createdAt: 1001,
          updatedAt: 1001,
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      openReq.onerror = () => reject(openReq.error);
    });

    // 2. Open via openExtensionDatabase at DB_VERSION = 5
    expect(DB_VERSION).toBe(5);
    const upgradedDb = await openExtensionDatabase(fakeFactory);

    expect(upgradedDb.version).toBe(5);

    // Verify v1 stores still exist
    expect(upgradedDb.objectStoreNames.contains(STORE_CONVERSATIONS)).toBe(true);
    expect(upgradedDb.objectStoreNames.contains(STORE_MESSAGES)).toBe(true);
    expect(upgradedDb.objectStoreNames.contains(STORE_REVISIONS)).toBe(true);
    expect(upgradedDb.objectStoreNames.contains(STORE_RECOVERY_EVENTS)).toBe(true);

    // Verify v2 stores were added
    expect(upgradedDb.objectStoreNames.contains(STORE_RAW_STREAMS)).toBe(true);
    expect(upgradedDb.objectStoreNames.contains(STORE_RAW_STREAM_BATCHES)).toBe(true);

    // Verify v5 store was added
    expect(upgradedDb.objectStoreNames.contains(STORE_CANONICAL_CHECKPOINTS)).toBe(true);

    // Verify indexes on messages including new v3 compound index and v4 identityState index
    const tx = upgradedDb.transaction(
      [STORE_CONVERSATIONS, STORE_MESSAGES, STORE_RAW_STREAMS, STORE_RAW_STREAM_BATCHES],
      'readonly'
    );
    const msgStore = tx.objectStore(STORE_MESSAGES);
    expect(msgStore.indexNames.contains('conversationId_remoteId')).toBe(true);
    expect(msgStore.indexNames.contains('identityState')).toBe(true);

    // Verify indexes on raw_streams
    const streamStore = tx.objectStore(STORE_RAW_STREAMS);
    expect(streamStore.indexNames.contains('openedAt')).toBe(true);
    expect(streamStore.indexNames.contains('state')).toBe(true);
    expect(streamStore.indexNames.contains('provisionalSessionId')).toBe(true);
    expect(streamStore.indexNames.contains('updatedAt')).toBe(true);

    // Verify indexes on raw_stream_batches
    const batchStore = tx.objectStore(STORE_RAW_STREAM_BATCHES);
    expect(batchStore.indexNames.contains('streamKey')).toBe(true);
    expect(batchStore.indexNames.contains('createdAt')).toBe(true);
    expect(batchStore.indexNames.contains('batchSeq')).toBe(true);

    // Verify preserved v1 data
    const convReq = tx.objectStore(STORE_CONVERSATIONS).get('v1-conv-1');
    const msgReq = tx.objectStore(STORE_MESSAGES).get('v1-msg-1');

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => {
        expect(convReq.result).toBeDefined();
        expect(convReq.result.title).toBe('Legacy Session V1');
        expect(msgReq.result).toBeDefined();
        expect(msgReq.result.id).toBe('v1-msg-1');
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  });

  it('preserves existing v2 raw stream data and upgrades messages to v4 indexes', async () => {
    // 1. Manually initialize database at Version 2
    await new Promise<void>((resolve, reject) => {
      const openReq = fakeFactory.open(DB_NAME, 2);
      openReq.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        const convStore = db.createObjectStore(STORE_CONVERSATIONS, { keyPath: 'id' });
        convStore.createIndex('remoteId', 'remoteId', { unique: false });
        convStore.createIndex('updatedAt', 'updatedAt', { unique: false });

        const msgStore = db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' });
        msgStore.createIndex('conversationId', 'conversationId', { unique: false });
        msgStore.createIndex('remoteId', 'remoteId', { unique: false });
        msgStore.createIndex('parentId', 'parentId', { unique: false });
        msgStore.createIndex('createdAt', 'createdAt', { unique: false });

        const revStore = db.createObjectStore(STORE_REVISIONS, { keyPath: 'id' });
        revStore.createIndex('messageId', 'messageId', { unique: false });

        const recStore = db.createObjectStore(STORE_RECOVERY_EVENTS, { keyPath: 'id' });
        recStore.createIndex('messageId', 'messageId', { unique: false });

        const rawStreamsStore = db.createObjectStore(STORE_RAW_STREAMS, { keyPath: 'id' });
        rawStreamsStore.createIndex('openedAt', 'openedAt', { unique: false });
        rawStreamsStore.createIndex('state', 'state', { unique: false });

        const rawBatchesStore = db.createObjectStore(STORE_RAW_STREAM_BATCHES, { keyPath: 'id' });
        rawBatchesStore.createIndex('streamKey', 'streamKey', { unique: false });
      };
      openReq.onsuccess = () => {
        const db = openReq.result;
        const tx = db.transaction([STORE_MESSAGES, STORE_RAW_STREAMS], 'readwrite');
        tx.objectStore(STORE_MESSAGES).put({
          id: 'v2-msg-1',
          remoteId: 'remote-100',
          conversationId: 'v2-conv-1',
          role: 'assistant',
          status: 'finished',
          createdAt: 2001,
          updatedAt: 2001,
        });
        tx.objectStore(STORE_RAW_STREAMS).put({
          id: 'prod_1:stream_1',
          producerSessionId: 'prod_1',
          streamId: 'stream_1',
          state: 'completed',
          openedAt: 2000,
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      openReq.onerror = () => reject(openReq.error);
    });

    // 2. Open via openExtensionDatabase at DB_VERSION = 5
    const upgradedDb = await openExtensionDatabase(fakeFactory);
    expect(upgradedDb.version).toBe(5);

    const tx = upgradedDb.transaction([STORE_MESSAGES, STORE_RAW_STREAMS], 'readonly');
    const msgStore = tx.objectStore(STORE_MESSAGES);
    expect(msgStore.indexNames.contains('conversationId_remoteId')).toBe(true);
    expect(msgStore.indexNames.contains('identityState')).toBe(true);

    // Verify querying by compound index works
    const compoundIdx = msgStore.index('conversationId_remoteId');
    const getReq = compoundIdx.get(['v2-conv-1', 'remote-100']);

    const streamReq = tx.objectStore(STORE_RAW_STREAMS).get('prod_1:stream_1');

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => {
        expect(getReq.result).toBeDefined();
        expect(getReq.result.id).toBe('v2-msg-1');
        expect(streamReq.result).toBeDefined();
        expect(streamReq.result.state).toBe('completed');
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  });

  it('preserves existing v3 database and adds v4 identityState index and v5 checkpoints store', async () => {
    // 1. Manually initialize database at Version 3
    await new Promise<void>((resolve, reject) => {
      const openReq = fakeFactory.open(DB_NAME, 3);
      openReq.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        const convStore = db.createObjectStore(STORE_CONVERSATIONS, { keyPath: 'id' });
        convStore.createIndex('remoteId', 'remoteId', { unique: false });

        const msgStore = db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' });
        msgStore.createIndex('conversationId_remoteId', ['conversationId', 'remoteId'], { unique: false });

        const revStore = db.createObjectStore(STORE_REVISIONS, { keyPath: 'id' });
        revStore.createIndex('isLastGood', 'isLastGood', { unique: false });

        db.createObjectStore(STORE_RECOVERY_EVENTS, { keyPath: 'id' });
        db.createObjectStore(STORE_RAW_STREAMS, { keyPath: 'id' });
        db.createObjectStore(STORE_RAW_STREAM_BATCHES, { keyPath: 'id' });
      };
      openReq.onsuccess = () => {
        const db = openReq.result;
        const tx = db.transaction([STORE_MESSAGES], 'readwrite');
        tx.objectStore(STORE_MESSAGES).put({
          id: 'v3-msg-1',
          remoteId: 'remote-300',
          conversationId: 'v3-conv-1',
          identityState: 'reconciled',
          role: 'assistant',
          status: 'finished',
          createdAt: 3000,
          updatedAt: 3000,
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      openReq.onerror = () => reject(openReq.error);
    });

    // 2. Open via openExtensionDatabase at DB_VERSION = 5
    const upgradedDb = await openExtensionDatabase(fakeFactory);
    expect(upgradedDb.version).toBe(5);

    const tx = upgradedDb.transaction([STORE_MESSAGES, STORE_CANONICAL_CHECKPOINTS], 'readonly');
    const msgStore = tx.objectStore(STORE_MESSAGES);
    expect(msgStore.indexNames.contains('conversationId_remoteId')).toBe(true);
    expect(msgStore.indexNames.contains('identityState')).toBe(true);
    expect(upgradedDb.objectStoreNames.contains(STORE_CANONICAL_CHECKPOINTS)).toBe(true);

    const idReq = msgStore.index('identityState').get('reconciled');
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => {
        expect(idReq.result).toBeDefined();
        expect(idReq.result.id).toBe('v3-msg-1');
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  });

  it('caches active connection per IDBFactory instance without cross-contamination', async () => {
    const factory1 = new IDBFactory();
    const factory2 = new IDBFactory();

    const db1 = await openExtensionDatabase(factory1);
    const db1Cached = await openExtensionDatabase(factory1);
    expect(db1).toBe(db1Cached);

    const db2 = await openExtensionDatabase(factory2);
    expect(db2).not.toBe(db1);

    closeExtensionDatabase(factory1);
    closeExtensionDatabase(factory2);
  });

  it('handles db.onversionchange by closing open connections gracefully', async () => {
    const db = await openExtensionDatabase(fakeFactory);
    let closed = false;
    db.addEventListener('close', () => {
      closed = true;
    });

    // Simulate versionchange event
    if (typeof (db as any).onversionchange === 'function') {
      (db as any).onversionchange(new Event('versionchange'));
    }

    closeExtensionDatabase(fakeFactory);
  });
});
