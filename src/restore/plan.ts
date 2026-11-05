/**
 * Restore Plan Builder for Replace and Safe Merge operations.
 */

import {
  INCLUDED_BACKUP_STORES,
  type IncludedBackupStoreName,
  type PortableBackupStoreCounts,
} from '../backup/format';
import type { MaterializedPortableBackup } from '../backup/reader';
import { isRecordSemanticallyIdentical } from '../backup/record-validation';
import type { RestorePlan, RestoreConflict, RestoreMode } from './types';
import type { Conversation, Message } from '../core/models';

/**
 * Reads a single record by primary key inside a transaction.
 */
function getRecordFromStore(store: IDBObjectStore, key: string): Promise<unknown | null> {
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error || new Error(`Failed to read record ${key}`));
  });
}

/**
 * Reads all records or indices needed for semantic collision checks.
 */
function getAllFromStore(store: IDBObjectStore): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error || new Error('Failed to getAll records'));
  });
}

/**
 * Builds an actionable RestorePlan for the specified mode.
 * Evaluates primary key equality and DeepSeek remote identity uniqueness.
 */
export async function buildRestorePlan(
  db: IDBDatabase,
  backup: MaterializedPortableBackup,
  mode: RestoreMode
): Promise<RestorePlan> {
  if (mode === 'merge' && (backup as any)._lightweight) {
    throw new Error('Cannot build merge plan from lightweight inspection backup. Full records or staging database are required.');
  }

  if (mode === 'replace') {
    return {
      mode: 'replace',
      valid: true,
      toInsert: {
        conversations: [...backup.records.conversations],
        messages: [...backup.records.messages],
        revisions: [...backup.records.revisions],
        recovery_events: [...backup.records.recovery_events],
        raw_streams: [...backup.records.raw_streams],
        raw_stream_batches: [...backup.records.raw_stream_batches],
      },
      toSkip: {
        conversations: 0,
        messages: 0,
        revisions: 0,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      },
      conflicts: [],
    };
  }

  // Mode: merge
  const conflicts: RestoreConflict[] = [];
  const toSkip: PortableBackupStoreCounts = {
    conversations: 0,
    messages: 0,
    revisions: 0,
    recovery_events: 0,
    raw_streams: 0,
    raw_stream_batches: 0,
  };

  const toInsert: RestorePlan['toInsert'] = {
    conversations: [],
    messages: [],
    revisions: [],
    recovery_events: [],
    raw_streams: [],
    raw_stream_batches: [],
  };

  const tx = db.transaction(INCLUDED_BACKUP_STORES as unknown as string[], 'readonly');

  // Check 1: Semantic Remote Identity Collisions for Conversations
  const convStore = tx.objectStore('conversations');
  const existingConvs = (await getAllFromStore(convStore)) as Conversation[];
  const existingConvRemoteMap = new Map<string, Conversation>();
  const existingConvIdMap = new Map<string, Conversation>();

  for (const c of existingConvs) {
    existingConvIdMap.set(c.id, c);
    if (c.remoteId) {
      existingConvRemoteMap.set(c.remoteId, c);
    }
  }

  for (const incomingConv of backup.records.conversations) {
    if (incomingConv.remoteId) {
      const matchByRemote = existingConvRemoteMap.get(incomingConv.remoteId);
      if (matchByRemote && matchByRemote.id !== incomingConv.id) {
        conflicts.push({
          code: 'semantic_identity_collision',
          store: 'conversations',
          id: incomingConv.id,
          message: `Conversation remoteId "${incomingConv.remoteId}" already exists locally under ID "${matchByRemote.id}". Incoming ID "${incomingConv.id}" conflicts with local identity.`,
        });
      }
    }

    const localRecord = existingConvIdMap.get(incomingConv.id);
    if (!localRecord) {
      toInsert.conversations.push(incomingConv);
    } else {
      if (isRecordSemanticallyIdentical('conversations', localRecord, incomingConv)) {
        toSkip.conversations++;
      } else {
        conflicts.push({
          code: 'primary_key_conflict',
          store: 'conversations',
          id: incomingConv.id,
          message: `Conversation ID "${incomingConv.id}" already exists locally with differing content.`,
        });
      }
    }
  }

  // Check 2: Semantic Remote Identity Collisions for Messages
  const msgStore = tx.objectStore('messages');
  const existingMsgs = (await getAllFromStore(msgStore)) as Message[];
  const existingMsgIdMap = new Map<string, Message>();
  const existingMsgRemoteMap = new Map<string, Message>(); // key: `${conversationId}:${remoteId}`

  for (const m of existingMsgs) {
    existingMsgIdMap.set(m.id, m);
    if (m.remoteId) {
      existingMsgRemoteMap.set(`${m.conversationId}:${m.remoteId}`, m);
    }
  }

  for (const incomingMsg of backup.records.messages) {
    if (incomingMsg.remoteId) {
      const key = `${incomingMsg.conversationId}:${incomingMsg.remoteId}`;
      const matchByRemote = existingMsgRemoteMap.get(key);
      if (matchByRemote && matchByRemote.id !== incomingMsg.id) {
        conflicts.push({
          code: 'semantic_identity_collision',
          store: 'messages',
          id: incomingMsg.id,
          message: `Message remoteId "${incomingMsg.remoteId}" in conversation "${incomingMsg.conversationId}" already exists locally under ID "${matchByRemote.id}". Incoming ID "${incomingMsg.id}" conflicts with local identity.`,
        });
      }
    }

    const localRecord = existingMsgIdMap.get(incomingMsg.id);
    if (!localRecord) {
      toInsert.messages.push(incomingMsg);
    } else {
      if (isRecordSemanticallyIdentical('messages', localRecord, incomingMsg)) {
        toSkip.messages++;
      } else {
        conflicts.push({
          code: 'primary_key_conflict',
          store: 'messages',
          id: incomingMsg.id,
          message: `Message ID "${incomingMsg.id}" already exists locally with differing content.`,
        });
      }
    }
  }

  // Check 3: Revisions
  const revStore = tx.objectStore('revisions');
  const existingRevs = (await getAllFromStore(revStore)) as Array<{ id: string }>;
  const existingRevMap = new Map<string, any>();
  for (const r of existingRevs) existingRevMap.set(r.id, r);

  for (const incomingRev of backup.records.revisions) {
    const localRecord = existingRevMap.get(incomingRev.id);
    if (!localRecord) {
      toInsert.revisions.push(incomingRev);
    } else {
      if (isRecordSemanticallyIdentical('revisions', localRecord, incomingRev)) {
        toSkip.revisions++;
      } else {
        conflicts.push({
          code: 'primary_key_conflict',
          store: 'revisions',
          id: incomingRev.id,
          message: `Revision ID "${incomingRev.id}" already exists locally with differing content.`,
        });
      }
    }
  }

  // Check 4: Recovery Events
  const recStore = tx.objectStore('recovery_events');
  const existingRecs = (await getAllFromStore(recStore)) as Array<{ id: string }>;
  const existingRecMap = new Map<string, any>();
  for (const r of existingRecs) existingRecMap.set(r.id, r);

  for (const incomingRec of backup.records.recovery_events) {
    const localRecord = existingRecMap.get(incomingRec.id);
    if (!localRecord) {
      toInsert.recovery_events.push(incomingRec);
    } else {
      if (isRecordSemanticallyIdentical('recovery_events', localRecord, incomingRec)) {
        toSkip.recovery_events++;
      } else {
        conflicts.push({
          code: 'primary_key_conflict',
          store: 'recovery_events',
          id: incomingRec.id,
          message: `RecoveryEvent ID "${incomingRec.id}" already exists locally with differing content.`,
        });
      }
    }
  }

  // Check 5: Raw Streams
  const streamStore = tx.objectStore('raw_streams');
  const existingStreams = (await getAllFromStore(streamStore)) as Array<{ id: string }>;
  const existingStreamMap = new Map<string, any>();
  for (const s of existingStreams) existingStreamMap.set(s.id, s);

  for (const incomingStream of backup.records.raw_streams) {
    const localRecord = existingStreamMap.get(incomingStream.id);
    if (!localRecord) {
      toInsert.raw_streams.push(incomingStream);
    } else {
      if (isRecordSemanticallyIdentical('raw_streams', localRecord, incomingStream)) {
        toSkip.raw_streams++;
      } else {
        conflicts.push({
          code: 'primary_key_conflict',
          store: 'raw_streams',
          id: incomingStream.id,
          message: `RawStream ID "${incomingStream.id}" already exists locally with differing content.`,
        });
      }
    }
  }

  // Check 6: Raw Stream Batches
  const batchStore = tx.objectStore('raw_stream_batches');
  const existingBatches = (await getAllFromStore(batchStore)) as Array<{ id: string }>;
  const existingBatchMap = new Map<string, any>();
  for (const b of existingBatches) existingBatchMap.set(b.id, b);

  for (const incomingBatch of backup.records.raw_stream_batches) {
    const localRecord = existingBatchMap.get(incomingBatch.id);
    if (!localRecord) {
      toInsert.raw_stream_batches.push(incomingBatch);
    } else {
      if (isRecordSemanticallyIdentical('raw_stream_batches', localRecord, incomingBatch)) {
        toSkip.raw_stream_batches++;
      } else {
        conflicts.push({
          code: 'primary_key_conflict',
          store: 'raw_stream_batches',
          id: incomingBatch.id,
          message: `RawStreamBatch ID "${incomingBatch.id}" already exists locally with differing content.`,
        });
      }
    }
  }

  const valid = conflicts.length === 0;

  return {
    mode: 'merge',
    valid,
    toInsert,
    toSkip,
    conflicts,
  };
}
