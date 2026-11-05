/**
 * Cascade Deletion Engine for Conversations.
 *
 * Implements safe, atomic cascading deletion across:
 * - conversations
 * - messages
 * - revisions
 * - recovery_events
 * - raw_streams (scoped to target conversation)
 * - raw_stream_batches (scoped to deleted raw streams)
 *
 * Rollback Guarantee:
 * Entire deletion runs in ONE readwrite transaction.
 * If any error occurs or target was modified since preview, tx.abort() is called.
 */

import {
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
  STORE_RECOVERY_EVENTS,
  STORE_RAW_STREAMS,
  STORE_RAW_STREAM_BATCHES,
  STORE_CONTEXT_CONTINUITY_RECEIPTS,
} from '../schema';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../../core/models';
import type { RawStreamRecord } from '../raw-journal/types';
import type { ConversationDeletionPlan } from './types';
import { createDurableWriteTransaction } from '../db';

function makeKeyRange(key: IDBValidKey): IDBKeyRange | IDBValidKey {
  return typeof IDBKeyRange !== 'undefined' ? IDBKeyRange.only(key) : key;
}

const CASCADE_STORES = [
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
  STORE_RECOVERY_EVENTS,
  STORE_RAW_STREAMS,
  STORE_RAW_STREAM_BATCHES,
  STORE_CONTEXT_CONTINUITY_RECEIPTS,
] as const;

/**
 * Builds a deletion plan for preview before execution.
 * Validates active stream boundaries and captures the conversation's updatedAt timestamp.
 */
export async function buildConversationDeletionPlan(
  db: IDBDatabase,
  conversationId: string,
  activeStreamKeys: Set<string>
): Promise<ConversationDeletionPlan> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(CASCADE_STORES as unknown as string[], 'readonly');
    } catch (err) {
      return reject(new Error(`Failed to open preview transaction: ${(err as Error).message}`));
    }

    const convStore = tx.objectStore(STORE_CONVERSATIONS);
    const msgStore = tx.objectStore(STORE_MESSAGES);
    const revStore = tx.objectStore(STORE_REVISIONS);
    const recStore = tx.objectStore(STORE_RECOVERY_EVENTS);
    const rawStreamsStore = tx.objectStore(STORE_RAW_STREAMS);
    const rawBatchesStore = tx.objectStore(STORE_RAW_STREAM_BATCHES);

    const convReq = convStore.get(conversationId);

    convReq.onerror = () => reject(new Error(convReq.error?.message || 'Failed to read conversation'));
    convReq.onsuccess = () => {
      const conv = convReq.result as Conversation | undefined;
      if (!conv) {
        return reject(new Error('conversation_not_found'));
      }

      // Read messages for this conversation
      const msgIndex = msgStore.index('conversationId');
      const msgReq = msgIndex.getAll(makeKeyRange(conversationId));

      msgReq.onerror = () => reject(new Error(msgReq.error?.message || 'Failed to read messages'));
      msgReq.onsuccess = () => {
        const messages = (msgReq.result || []) as Message[];

        // Check if any message is currently tied to an active stream
        const candidateStreamKeys = new Set<string>();
        for (const msg of messages) {
          if (msg.sourceRawStreamKey) {
            if (activeStreamKeys.has(msg.sourceRawStreamKey)) {
              return reject(new Error('active_stream_in_progress'));
            }
            candidateStreamKeys.add(msg.sourceRawStreamKey);
          }
        }

        // Also check raw streams with provisionalSessionId matching remoteId
        if (conv.remoteId) {
          const provIndex = rawStreamsStore.index('provisionalSessionId');
          const provReq = provIndex.getAll(makeKeyRange(conv.remoteId));
          provReq.onsuccess = () => {
            const matchedStreams = (provReq.result || []) as RawStreamRecord[];
            for (const s of matchedStreams) {
              if (activeStreamKeys.has(s.id) || s.state === 'active') {
                return reject(new Error('active_stream_in_progress'));
              }
              candidateStreamKeys.add(s.id);
            }
            proceedWithCounts(messages, conv, candidateStreamKeys);
          };
          provReq.onerror = () => proceedWithCounts(messages, conv, candidateStreamKeys);
        } else {
          proceedWithCounts(messages, conv, candidateStreamKeys);
        }

        function proceedWithCounts(
          msgs: Message[],
          conversation: Conversation,
          streamKeys: Set<string>
        ) {
          let pendingOps = msgs.length * 2 + streamKeys.size;
          if (pendingOps === 0) {
            return resolve({
              conversationId: conversation.id,
              title: conversation.title || 'Untitled',
              updatedAt: conversation.updatedAt,
              messageCount: msgs.length,
              revisionCount: 0,
              recoveryEventCount: 0,
              rawStreamCount: 0,
              rawBatchCount: 0,
              rawStreamKeys: [],
            });
          }

          let revisionCount = 0;
          let recoveryEventCount = 0;
          let rawBatchCount = 0;

          const checkDone = () => {
            pendingOps--;
            if (pendingOps <= 0) {
              resolve({
                conversationId: conversation.id,
                title: conversation.title || 'Untitled',
                updatedAt: conversation.updatedAt,
                messageCount: msgs.length,
                revisionCount,
                recoveryEventCount,
                rawStreamCount: streamKeys.size,
                rawBatchCount,
                rawStreamKeys: Array.from(streamKeys),
              });
            }
          };

          const revIndex = revStore.index('messageId');
          const recIndex = recStore.index('messageId');
          const batchIndex = rawBatchesStore.index('streamKey');

          for (const m of msgs) {
            const revCountReq = revIndex.count(makeKeyRange(m.id));
            revCountReq.onsuccess = () => {
              revisionCount += revCountReq.result;
              checkDone();
            };
            revCountReq.onerror = () => checkDone();

            const recCountReq = recIndex.count(makeKeyRange(m.id));
            recCountReq.onsuccess = () => {
              recoveryEventCount += recCountReq.result;
              checkDone();
            };
            recCountReq.onerror = () => checkDone();
          }

          for (const sKey of streamKeys) {
            const batchCountReq = batchIndex.count(makeKeyRange(sKey));
            batchCountReq.onsuccess = () => {
              rawBatchCount += batchCountReq.result;
              checkDone();
            };
            batchCountReq.onerror = () => checkDone();
          }
        }
      };
    };
  });
}

/**
 * Executes cascading deletion of a conversation in ONE atomic readwrite transaction.
 *
 * Guarantees:
 * 1. Checks if any stream is active (aborts if true).
 * 2. Checks stale barrier (verifies conversation.updatedAt matches plan.updatedAt).
 * 3. Deletes conversation, messages, revisions, recovery events, raw streams, raw batches.
 * 4. Rolls back completely on error.
 */
export async function deleteConversationCascade(
  db: IDBDatabase,
  plan: ConversationDeletionPlan,
  activeStreamKeys: Set<string>
): Promise<void> {
  // Check active streams barrier
  for (const sKey of plan.rawStreamKeys) {
    if (activeStreamKeys.has(sKey)) {
      throw new Error('active_stream_in_progress');
    }
  }

  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = createDurableWriteTransaction(db, CASCADE_STORES as unknown as string[], 'strict');
    } catch (err) {
      return reject(new Error(`Failed to open deletion transaction: ${(err as Error).message}`));
    }

    let settled = false;

    tx.onabort = () => {
      if (!settled) {
        settled = true;
        reject(new Error(`Deletion transaction aborted: ${tx.error?.message || 'Transaction aborted'}`));
      }
    };

    tx.onerror = () => {
      if (!settled) {
        settled = true;
        reject(new Error(`Deletion transaction failed: ${tx.error?.message || 'Unknown transaction error'}`));
      }
    };

    tx.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const failTransaction = (err: Error) => {
      if (!settled) {
        settled = true;
        try {
          tx.abort();
        } catch {
          // ignore
        }
        reject(err);
      }
    };

    try {
      const convStore = tx.objectStore(STORE_CONVERSATIONS);
      const msgStore = tx.objectStore(STORE_MESSAGES);
      const revStore = tx.objectStore(STORE_REVISIONS);
      const recStore = tx.objectStore(STORE_RECOVERY_EVENTS);
      const rawStreamsStore = tx.objectStore(STORE_RAW_STREAMS);
      const rawBatchesStore = tx.objectStore(STORE_RAW_STREAM_BATCHES);

      // 1. Stale Guard: Check conversation exists and updatedAt matches preview
      const convGetReq = convStore.get(plan.conversationId);
      convGetReq.onerror = () => failTransaction(new Error(convGetReq.error?.message || 'Failed to verify conversation'));
      convGetReq.onsuccess = () => {
        const conv = convGetReq.result as Conversation | undefined;
        if (!conv) {
          return failTransaction(new Error('conversation_not_found'));
        }
        if (conv.updatedAt !== plan.updatedAt) {
          return failTransaction(new Error('delete_target_changed_since_preview'));
        }

        // Delete conversation record
        convStore.delete(plan.conversationId);

        // 2. Cascade delete messages and their revisions/recovery_events
        const msgIndex = msgStore.index('conversationId');
        const msgCursorReq = msgIndex.openCursor(makeKeyRange(plan.conversationId));

        msgCursorReq.onerror = () => failTransaction(new Error(msgCursorReq.error?.message || 'Failed to scan messages'));
        msgCursorReq.onsuccess = () => {
          const cursor = msgCursorReq.result;
          if (cursor) {
            const msg = cursor.value as Message;
            const messageId = msg.id;

            // Delete revisions for this message
            const revIndex = revStore.index('messageId');
            const revCursorReq = revIndex.openCursor(makeKeyRange(messageId));
            revCursorReq.onsuccess = () => {
              const rCursor = revCursorReq.result;
              if (rCursor) {
                rCursor.delete();
                rCursor.continue();
              }
            };

            // Delete recovery events for this message
            const recIndex = recStore.index('messageId');
            const recCursorReq = recIndex.openCursor(makeKeyRange(messageId));
            recCursorReq.onsuccess = () => {
              const rcCursor = recCursorReq.result;
              if (rcCursor) {
                rcCursor.delete();
                rcCursor.continue();
              }
            };

            // Delete message record
            cursor.delete();
            cursor.continue();
          }
        };

        // 3. Cascade delete raw streams and their batches
        for (const sKey of plan.rawStreamKeys) {
          rawStreamsStore.delete(sKey);

          const batchIndex = rawBatchesStore.index('streamKey');
          const batchCursorReq = batchIndex.openCursor(makeKeyRange(sKey));
          batchCursorReq.onsuccess = () => {
            const bCursor = batchCursorReq.result;
            if (bCursor) {
              bCursor.delete();
              bCursor.continue();
            }
          };
        }

        // 4. Cascade delete context continuity receipts for this conversation
        if (tx.objectStoreNames.contains(STORE_CONTEXT_CONTINUITY_RECEIPTS)) {
          const receiptStore = tx.objectStore(STORE_CONTEXT_CONTINUITY_RECEIPTS);
          const rIndex = receiptStore.index('conversationId');
          const rCursorReq = rIndex.openCursor(makeKeyRange(plan.conversationId));
          rCursorReq.onsuccess = () => {
            const rCursor = rCursorReq.result;
            if (rCursor) {
              rCursor.delete();
              rCursor.continue();
            }
          };
        }
      };
    } catch (err) {
      failTransaction(err as Error);
    }
  });
}
