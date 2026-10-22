export const DB_NAME = 'StreamArchiveDB' as const;
export const DB_VERSION = 6 as const;

export const STORE_CONVERSATIONS = 'conversations' as const;
export const STORE_MESSAGES = 'messages' as const;
export const STORE_REVISIONS = 'revisions' as const;
export const STORE_RECOVERY_EVENTS = 'recovery_events' as const;
export const STORE_RAW_STREAMS = 'raw_streams' as const;
export const STORE_RAW_STREAM_BATCHES = 'raw_stream_batches' as const;
export const STORE_CANONICAL_CHECKPOINTS = 'canonical_checkpoints' as const;
export const STORE_HISTORY_STAGING = 'history_staging' as const;

export interface CanonicalStreamCheckpointRecord {
  streamKey: string;
  lastCommittedCheckpointSeq: number;
  lastFingerprint?: string;
  isTerminal: boolean;
  updatedAt: number;
}

export interface HistoryStagingBatchRecord {
  id: string; // `${stagingId}:${batchIndex}`
  stagingId: string;
  batchIndex: number;
  session?: import('../adapters/deepseek/history/types').NormalizedHistorySession;
  messages: import('../adapters/deepseek/history/types').NormalizedHistoryMessage[];
  createdAt: number;
}

export function configureDatabaseSchema(db: IDBDatabase, tx?: IDBTransaction | null): void {
  // Store: conversations (v1)
  if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
    const convStore = db.createObjectStore(STORE_CONVERSATIONS, { keyPath: 'id' });
    convStore.createIndex('remoteId', 'remoteId', { unique: false });
    convStore.createIndex('updatedAt', 'updatedAt', { unique: false });
  }

  // Store: messages (v1, v3 adds compound index [conversationId, remoteId], v4 adds identityState index)
  if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
    const msgStore = db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' });
    msgStore.createIndex('conversationId', 'conversationId', { unique: false });
    msgStore.createIndex('remoteId', 'remoteId', { unique: false });
    msgStore.createIndex('parentId', 'parentId', { unique: false });
    msgStore.createIndex('createdAt', 'createdAt', { unique: false });
    msgStore.createIndex('conversationId_remoteId', ['conversationId', 'remoteId'], { unique: false });
    msgStore.createIndex('identityState', 'identityState', { unique: false });
  } else if (tx) {
    const msgStore = tx.objectStore(STORE_MESSAGES);
    if (!msgStore.indexNames.contains('conversationId_remoteId')) {
      msgStore.createIndex('conversationId_remoteId', ['conversationId', 'remoteId'], { unique: false });
    }
    if (!msgStore.indexNames.contains('identityState')) {
      msgStore.createIndex('identityState', 'identityState', { unique: false });
    }
  }

  // Store: revisions (v1)
  if (!db.objectStoreNames.contains(STORE_REVISIONS)) {
    const revStore = db.createObjectStore(STORE_REVISIONS, { keyPath: 'id' });
    revStore.createIndex('messageId', 'messageId', { unique: false });
    revStore.createIndex('capturedAt', 'capturedAt', { unique: false });
    revStore.createIndex('isLastGood', 'isLastGood', { unique: false });
  }

  // Store: recovery_events (v1)
  if (!db.objectStoreNames.contains(STORE_RECOVERY_EVENTS)) {
    const recStore = db.createObjectStore(STORE_RECOVERY_EVENTS, { keyPath: 'id' });
    recStore.createIndex('messageId', 'messageId', { unique: false });
    recStore.createIndex('detectedAt', 'detectedAt', { unique: false });
  }

  // Store: raw_streams (v2)
  if (!db.objectStoreNames.contains(STORE_RAW_STREAMS)) {
    const rawStreamsStore = db.createObjectStore(STORE_RAW_STREAMS, { keyPath: 'id' });
    rawStreamsStore.createIndex('openedAt', 'openedAt', { unique: false });
    rawStreamsStore.createIndex('state', 'state', { unique: false });
    rawStreamsStore.createIndex('provisionalSessionId', 'provisionalSessionId', { unique: false });
    rawStreamsStore.createIndex('updatedAt', 'updatedAt', { unique: false });
  }

  // Store: raw_stream_batches (v2)
  if (!db.objectStoreNames.contains(STORE_RAW_STREAM_BATCHES)) {
    const rawBatchesStore = db.createObjectStore(STORE_RAW_STREAM_BATCHES, { keyPath: 'id' });
    rawBatchesStore.createIndex('streamKey', 'streamKey', { unique: false });
    rawBatchesStore.createIndex('createdAt', 'createdAt', { unique: false });
    rawBatchesStore.createIndex('batchSeq', 'batchSeq', { unique: false });
  }

  // Store: canonical_checkpoints (v5)
  if (!db.objectStoreNames.contains(STORE_CANONICAL_CHECKPOINTS)) {
    const cpStore = db.createObjectStore(STORE_CANONICAL_CHECKPOINTS, { keyPath: 'streamKey' });
    cpStore.createIndex('updatedAt', 'updatedAt', { unique: false });
  }

  // Store: history_staging (v6)
  if (!db.objectStoreNames.contains(STORE_HISTORY_STAGING)) {
    const stagingStore = db.createObjectStore(STORE_HISTORY_STAGING, { keyPath: 'id' });
    stagingStore.createIndex('stagingId', 'stagingId', { unique: false });
    stagingStore.createIndex('createdAt', 'createdAt', { unique: false });
  }
}
