import type {
  StorageRepository,
  ArchiveSummary,
  CanonicalCheckpointData,
  HistoryReconciliationPlan,
  ReplayPromotionPlan,
  ArchiveConversationSummary,
  ArchiveConversationDetail,
  ArchiveMessageSummary,
  ArchiveRevisionMetadata,
  PaginatedArchiveConversations,
} from '../../core/contracts';
import {
  mergeCanonicalMessage,
  selectPreferredRevision,
  isRevisionPayloadIdentical,
  isRecoveryEventIdentical,
  isLogicalMessage,
} from '../../core/models';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../../core/models';
import {
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
  STORE_RECOVERY_EVENTS,
  STORE_CANONICAL_CHECKPOINTS,
  STORE_HISTORY_STAGING,
  STORE_HISTORY_STAGING_MANIFESTS,
  STORE_CONTEXT_CONTINUITY_RECEIPTS,
  type CanonicalStreamCheckpointRecord,
  type HistoryStagingBatchRecord,
  type HistoryStagingManifestRecord,
} from '../schema';
import { openExtensionDatabase, createDurableWriteTransaction } from '../db';
import {
  computeCanonicalCheckpointFingerprint,
  serializeHistoryStagingBatchForFingerprint,
} from '../../shared/crypto';
import type { ConversationExportModel } from '../../export/types';
import {
  createPortableBackupSnapshot as createSnapshotInternal,
  type PortableBackupSnapshot,
  type CreateSnapshotOptions,
} from '../../backup/snapshot';
import {
  validateAndPreflightRestore as validateAndPreflightInternal,
  executeRestore as executeRestoreInternal,
  getCurrentStoreCounts as getCurrentStoreCountsInternal,
  type RestoreMode,
  type RestorePreflight,
  type RestoreResult,
} from '../../restore';
import type { MaterializedPortableBackup } from '../../backup/reader';
import type { PortableBackupStoreCounts } from '../../backup/format';
import { buildContextContinuityPlan as buildContinuityPlanInternal } from '../../context-continuity/planner';
import { getContextContinuitySettings } from '../../context-continuity/settings';
import type {
  ContextContinuityPlan,
  ContextContinuitySettings,
  ContextContinuityLimits,
  ContextContinuityReceipt,
} from '../../context-continuity/types';

import {
  buildConversationDeletionPlan as buildConversationDeletionPlanInternal,
  deleteConversationCascade as deleteConversationCascadeInternal,
  buildRawRetentionPlan as buildRawRetentionPlanInternal,
  executeRawRetentionPlan as executeRawRetentionPlanInternal,
  clearRawEvidence as clearRawEvidenceInternal,
  clearEntireArchive as clearEntireArchiveInternal,
  getStorageObservability,
  getRetentionSettings,
  type ConversationDeletionPlan,
  type RawRetentionPlan,
  type RawRetentionMode,
  type ArchiveCleanupResult,
  type StorageMaintenanceStatus,
} from '../retention';

export class IndexedDbStorageRepository implements StorageRepository {
  constructor(private readonly idbFactory?: IDBFactory) {}

  private async getDb(): Promise<IDBDatabase> {
    return openExtensionDatabase(this.idbFactory);
  }

  private async executeWrite(
    storeName: string,
    operation: (store: IDBObjectStore) => IDBRequest
  ): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = operation(store);

      req.onerror = () => reject(req.error || new Error(`Write request failed on store ${storeName}`));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error(`Write transaction failed on store ${storeName}`));
      tx.onabort = () => reject(tx.error || new Error(`Write transaction aborted on store ${storeName}`));
    });
  }

  // ── Conversation Operations ──

  async saveConversation(conversation: Conversation): Promise<void> {
    return this.executeWrite(STORE_CONVERSATIONS, (store) => store.put(conversation));
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONVERSATIONS, 'readonly');
      const store = tx.objectStore(STORE_CONVERSATIONS);
      const req = store.get(id);
      req.onsuccess = () => resolve((req.result as Conversation) || null);
      req.onerror = () => reject(req.error || new Error('Failed to get conversation'));
    });
  }

  async getConversationByRemoteId(remoteId: string): Promise<Conversation | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONVERSATIONS, 'readonly');
      const store = tx.objectStore(STORE_CONVERSATIONS);
      const index = store.index('remoteId');
      const req = index.get(remoteId);
      req.onsuccess = () => resolve((req.result as Conversation) || null);
      req.onerror = () => reject(req.error || new Error('Failed to get conversation by remoteId'));
    });
  }

  async listConversations(): Promise<Conversation[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONVERSATIONS, 'readonly');
      const store = tx.objectStore(STORE_CONVERSATIONS);
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result as Conversation[]) || []);
      req.onerror = () => reject(req.error || new Error('Failed to list conversations'));
    });
  }

  // ── Message Operations ──

  async saveMessage(message: Message): Promise<void> {
    return this.executeWrite(STORE_MESSAGES, (store) => store.put(message));
  }

  async saveMessages(messages: Message[]): Promise<void> {
    if (messages.length === 0) return;
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readwrite');
      const store = tx.objectStore(STORE_MESSAGES);
      for (const msg of messages) {
        store.put(msg);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Failed to save batch of messages'));
      tx.onabort = () => reject(tx.error || new Error('Save messages transaction aborted'));
    });
  }

  async getMessage(id: string): Promise<Message | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readonly');
      const store = tx.objectStore(STORE_MESSAGES);
      const req = store.get(id);
      req.onsuccess = () => resolve((req.result as Message) || null);
      req.onerror = () => reject(req.error || new Error('Failed to get message'));
    });
  }

  async getMessageByRemoteId(conversationId: string, remoteId: string): Promise<Message | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readonly');
      const store = tx.objectStore(STORE_MESSAGES);
      if (store.indexNames.contains('conversationId_remoteId')) {
        const index = store.index('conversationId_remoteId');
        const req = index.get([conversationId, remoteId]);
        req.onsuccess = () => resolve((req.result as Message) || null);
        req.onerror = () => reject(req.error || new Error('Failed to get message by conversationId and remoteId'));
      } else {
        const index = store.index('remoteId');
        const req = index.getAll(remoteId);
        req.onsuccess = () => {
          const list = (req.result as Message[]) || [];
          const matched = list.find((m) => m.conversationId === conversationId);
          resolve(matched || null);
        };
        req.onerror = () => reject(req.error || new Error('Failed to get message by remoteId fallback'));
      }
    });
  }

  async findMessageByRemoteId(remoteId: string): Promise<Message | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readonly');
      const store = tx.objectStore(STORE_MESSAGES);
      const index = store.index('remoteId');
      const req = index.get(remoteId);
      req.onsuccess = () => resolve((req.result as Message) || null);
      req.onerror = () => reject(req.error || new Error('Failed to find message by remoteId'));
    });
  }

  async listMessagesByConversation(conversationId: string): Promise<Message[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readonly');
      const store = tx.objectStore(STORE_MESSAGES);
      const index = store.index('conversationId');
      const req = index.getAll(conversationId);
      req.onsuccess = () => resolve((req.result as Message[]) || []);
      req.onerror = () => reject(req.error || new Error('Failed to list messages by conversation'));
    });
  }

  // ── Revision Operations ──

  async saveRevision(revision: ResponseRevision): Promise<void> {
    return this.executeWrite(STORE_REVISIONS, (store) => store.put(revision));
  }

  async saveRevisions(revisions: ResponseRevision[]): Promise<void> {
    if (revisions.length === 0) return;
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_REVISIONS, 'readwrite');
      const store = tx.objectStore(STORE_REVISIONS);
      for (const rev of revisions) {
        store.put(rev);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Failed to save batch of revisions'));
      tx.onabort = () => reject(tx.error || new Error('Save revisions transaction aborted'));
    });
  }

  async getRevision(id: string): Promise<ResponseRevision | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_REVISIONS, 'readonly');
      const store = tx.objectStore(STORE_REVISIONS);
      const req = store.get(id);
      req.onsuccess = () => resolve((req.result as ResponseRevision) || null);
      req.onerror = () => reject(req.error || new Error('Failed to get revision'));
    });
  }

  async listRevisionsByMessage(messageId: string): Promise<ResponseRevision[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_REVISIONS, 'readonly');
      const store = tx.objectStore(STORE_REVISIONS);
      const index = store.index('messageId');
      const req = index.getAll(messageId);
      req.onsuccess = () => {
        const results = (req.result as ResponseRevision[]) || [];
        results.sort((a, b) => a.revisionIndex - b.revisionIndex);
        resolve(results);
      };
      req.onerror = () => reject(req.error || new Error('Failed to list revisions by message'));
    });
  }

  async getLastGoodRevision(messageId: string): Promise<ResponseRevision | null> {
    const revisions = await this.listRevisionsByMessage(messageId);
    const lastGood = revisions.filter((r) => r.isLastGood).at(-1);
    return lastGood || null;
  }

  // ── Recovery Event Operations ──

  async saveRecoveryEvent(event: RecoveryEvent): Promise<void> {
    return this.executeWrite(STORE_RECOVERY_EVENTS, (store) => store.put(event));
  }

  async getRecoveryEvent(id: string): Promise<RecoveryEvent | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_RECOVERY_EVENTS, 'readonly');
      const store = tx.objectStore(STORE_RECOVERY_EVENTS);
      const req = store.get(id);
      req.onsuccess = () => resolve((req.result as RecoveryEvent) || null);
      req.onerror = () => reject(req.error || new Error('Failed to get recovery event'));
    });
  }

  async listRecoveryEvents(messageId?: string): Promise<RecoveryEvent[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_RECOVERY_EVENTS, 'readonly');
      const store = tx.objectStore(STORE_RECOVERY_EVENTS);
      if (messageId) {
        const index = store.index('messageId');
        const req = index.getAll(messageId);
        req.onsuccess = () => resolve((req.result as RecoveryEvent[]) || []);
        req.onerror = () => reject(req.error || new Error('Failed to list recovery events'));
      } else {
        const req = store.getAll();
        req.onsuccess = () => resolve((req.result as RecoveryEvent[]) || []);
        req.onerror = () => reject(req.error || new Error('Failed to list recovery events'));
      }
    });
  }

  // ── Atomic Canonical Checkpoint Persistence ──

  async saveCanonicalCheckpoint(data: CanonicalCheckpointData): Promise<void> {
    const isTerm = Boolean(data.isTerminal ?? data.isFinal);
    const fingerprint =
      data.checkpointSeq !== undefined
        ? await computeCanonicalCheckpointFingerprint({
            streamKey: data.streamKey,
            checkpointSeq: data.checkpointSeq,
            isTerminal: isTerm,
            conversation: data.conversation,
            userMessage: data.userMessage,
            message: data.message,
            revisions: data.revisions,
            recoveryEvents: data.recoveryEvents,
          })
        : undefined;

    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const stores = [
        STORE_CONVERSATIONS,
        STORE_MESSAGES,
        STORE_REVISIONS,
        STORE_RECOVERY_EVENTS,
        STORE_CANONICAL_CHECKPOINTS,
      ];
      const tx = createDurableWriteTransaction(db, stores, 'strict');

      let aborted = false;
      const fail = (err: Error) => {
        if (aborted) return;
        aborted = true;
        try {
          tx.abort();
        } catch {
          // ignore
        }
        reject(err);
      };

      tx.onerror = () => {
        if (!aborted) reject(tx.error || new Error('Save canonical checkpoint transaction failed'));
      };
      tx.onabort = () => {
        if (!aborted) reject(tx.error || new Error('Save canonical checkpoint transaction aborted'));
      };
      tx.oncomplete = () => {
        if (!aborted) resolve();
      };

      const convStore = tx.objectStore(STORE_CONVERSATIONS);
      const msgStore = tx.objectStore(STORE_MESSAGES);
      const revStore = tx.objectStore(STORE_REVISIONS);
      const recStore = tx.objectStore(STORE_RECOVERY_EVENTS);
      const cpStore = tx.objectStore(STORE_CANONICAL_CHECKPOINTS);

      const executePayloadWrites = () => {
        // Conversation upsert/merge
        const conv = data.conversation;
        if (conv) {
          const convReq = convStore.get(conv.id);
          convReq.onerror = () => fail(convReq.error || new Error('Failed to read conversation for merge'));
          convReq.onsuccess = () => {
            const existingConv = convReq.result as Conversation | undefined;
            if (existingConv) {
              convStore.put({
                ...conv,
                title: conv.title || existingConv.title,
                createdAt: existingConv.createdAt,
                updatedAt: Math.max(existingConv.updatedAt, conv.updatedAt),
              });
            } else {
              convStore.put(conv);
            }
          };
        }

        // User message merge (if provided with generation request)
        if (data.userMessage) {
          const umsgReq = msgStore.get(data.userMessage.id);
          umsgReq.onerror = () => fail(umsgReq.error || new Error('Failed to read user message for merge'));
          umsgReq.onsuccess = () => {
            const existingUMsg = umsgReq.result as Message | undefined;
            const mergedU = mergeCanonicalMessage(existingUMsg, data.userMessage!, 'live');
            msgStore.put(mergedU);
          };
        }

        // Message merge
        const msgReq = msgStore.get(data.message.id);
        msgReq.onerror = () => fail(msgReq.error || new Error('Failed to read message for merge'));
        msgReq.onsuccess = () => {
          const existingMsg = msgReq.result as Message | undefined;
          const merged = mergeCanonicalMessage(existingMsg, data.message, 'live');
          msgStore.put(merged);
        };

        // Immutable revisions validation and write
        for (const rev of data.revisions) {
          const revReq = revStore.get(rev.id);
          revReq.onerror = () => fail(revReq.error || new Error(`Failed to check existing revision ${rev.id}`));
          revReq.onsuccess = () => {
            const existingRev = revReq.result as ResponseRevision | undefined;
            if (existingRev) {
              if (!isRevisionPayloadIdentical(existingRev, rev)) {
                fail(new Error(`revision_conflict: cannot mutate existing revision ${rev.id}`));
                return;
              }
            } else {
              revStore.put(rev);
            }
          };
        }

        // Immutable recovery events validation and write
        if (data.recoveryEvents) {
          for (const rec of data.recoveryEvents) {
            const recReq = recStore.get(rec.id);
            recReq.onerror = () => fail(recReq.error || new Error(`Failed to check existing recovery event ${rec.id}`));
            recReq.onsuccess = () => {
              const existingRec = recReq.result as RecoveryEvent | undefined;
              if (existingRec) {
                if (!isRecoveryEventIdentical(existingRec, rec)) {
                  fail(new Error(`recovery_event_conflict: cannot mutate existing recovery event ${rec.id}`));
                  return;
                }
              } else {
                recStore.put(rec);
              }
            };
          }
        }
      };

      // Ledger check if streamKey is provided
      if (data.streamKey && data.checkpointSeq !== undefined) {
        const cpReq = cpStore.get(data.streamKey);
        cpReq.onerror = () => fail(cpReq.error || new Error('Failed to read checkpoint record'));
        cpReq.onsuccess = () => {
          const record = cpReq.result as CanonicalStreamCheckpointRecord | undefined;
          const seq = data.checkpointSeq;

          if (record) {
            // Terminal checkpoint locking
            if (record.isTerminal && seq > record.lastCommittedCheckpointSeq) {
              fail(
                new Error(
                  `terminal_checkpoint_locked: stream ${data.streamKey} is terminal, cannot commit seq ${seq}`
                )
              );
              return;
            }

            if (seq === record.lastCommittedCheckpointSeq) {
              // Idempotent re-ACK: verify payload fingerprint
              if (record.lastFingerprint && fingerprint && record.lastFingerprint !== fingerprint) {
                fail(
                  new Error(
                    `checkpoint_conflict: sequence ${seq} already committed with different payload fingerprint`
                  )
                );
                return;
              }
              // Idempotent re-ACK: already committed up to this sequence.
              // We do not re-apply duplicate data or mutate state.
              return;
            }

            if (seq < record.lastCommittedCheckpointSeq) {
              fail(
                new Error(
                  `stale_checkpoint: stream ${data.streamKey} received seq ${seq} below lastCommitted ${record.lastCommittedCheckpointSeq}`
                )
              );
              return;
            }

            if (seq > record.lastCommittedCheckpointSeq + 1) {
              fail(new Error(`checkpoint_sequence_gap: expected ${record.lastCommittedCheckpointSeq + 1}, got ${seq}`));
              return;
            }

            // seq === record.lastCommittedCheckpointSeq + 1
            cpStore.put({
              streamKey: data.streamKey,
              lastCommittedCheckpointSeq: seq,
              lastFingerprint: fingerprint,
              isTerminal: isTerm,
              updatedAt: Date.now(),
            });
          } else {
            if (seq !== 0) {
              fail(new Error(`checkpoint_sequence_gap: expected sequence 0 for new stream, got ${seq}`));
              return;
            }
            cpStore.put({
              streamKey: data.streamKey,
              lastCommittedCheckpointSeq: 0,
              lastFingerprint: fingerprint,
              isTerminal: isTerm,
              updatedAt: Date.now(),
            });
          }

          executePayloadWrites();
        };
      } else {
        executePayloadWrites();
      }
    });
  }

  async getCanonicalCheckpoint(
    streamKey: string
  ): Promise<CanonicalStreamCheckpointRecord | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CANONICAL_CHECKPOINTS, 'readonly');
      const store = tx.objectStore(STORE_CANONICAL_CHECKPOINTS);
      const req = store.get(streamKey);
      req.onsuccess = () => resolve((req.result as CanonicalStreamCheckpointRecord) || null);
      req.onerror = () => reject(req.error || new Error('Failed to get canonical checkpoint'));
    });
  }

  // ── Atomic History Reconciliation Plan Persistence ──

  private applyReconciliationPlanToStores(
    plan: HistoryReconciliationPlan,
    convStore: IDBObjectStore,
    msgStore: IDBObjectStore,
    revStore: IDBObjectStore,
    fail: (err: Error) => void
  ): void {
  const convReq = convStore.get(plan.conversation.id);
  convReq.onerror = () => fail(convReq.error || new Error('Failed to read conversation for reconciliation'));
  convReq.onsuccess = () => {
    const existingConv = convReq.result as Conversation | undefined;
    if (existingConv) {
      convStore.put({
        ...plan.conversation,
        title: plan.conversation.title || existingConv.title,
        createdAt: existingConv.createdAt,
        updatedAt: Math.max(existingConv.updatedAt, plan.conversation.updatedAt),
      });
    } else {
      convStore.put(plan.conversation);
    }
  };

  for (const incomingMsg of plan.messagesToPut) {
    const msgReq = msgStore.get(incomingMsg.id);
    msgReq.onerror = () => fail(msgReq.error || new Error(`Failed to read message ${incomingMsg.id} for reconciliation`));
    msgReq.onsuccess = () => {
      const existingMsg = msgReq.result as Message | undefined;
      const merged = mergeCanonicalMessage(existingMsg, incomingMsg, 'history');
      msgStore.put(merged);
    };
  }

  for (const rev of plan.revisionsToPut) {
    const revReq = revStore.get(rev.id);
    revReq.onerror = () => fail(revReq.error || new Error(`Failed to check existing revision ${rev.id}`));
    revReq.onsuccess = () => {
      const existingRev = revReq.result as ResponseRevision | undefined;
      if (existingRev) {
        if (!isRevisionPayloadIdentical(existingRev, rev)) {
          fail(new Error(`revision_conflict: cannot mutate existing revision ${rev.id}`));
          return;
        }
      } else {
        revStore.put(rev);
      }
    };
  }
}

  async applyHistoryReconciliationPlan(plan: HistoryReconciliationPlan): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const stores = [STORE_CONVERSATIONS, STORE_MESSAGES, STORE_REVISIONS];
      const tx = createDurableWriteTransaction(db, stores, 'strict');

      let aborted = false;
      const fail = (err: Error) => {
        if (aborted) return;
        aborted = true;
        try {
          tx.abort();
        } catch {
          // ignore
        }
        reject(err);
      };

      tx.onerror = () => {
        if (!aborted) reject(tx.error || new Error('Apply history reconciliation plan transaction failed'));
      };
      tx.onabort = () => {
        if (!aborted) reject(tx.error || new Error('Apply history reconciliation plan transaction aborted'));
      };
      tx.oncomplete = () => {
        if (!aborted) resolve();
      };

      const convStore = tx.objectStore(STORE_CONVERSATIONS);
      const msgStore = tx.objectStore(STORE_MESSAGES);
      const revStore = tx.objectStore(STORE_REVISIONS);

      this.applyReconciliationPlanToStores(plan, convStore, msgStore, revStore, fail);
    });
  }

  // ── Atomic Replay Promotion Plan Persistence ──

  async applyReplayPromotionPlan(plan: ReplayPromotionPlan): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const stores = [
        STORE_CONVERSATIONS,
        STORE_MESSAGES,
        STORE_REVISIONS,
        STORE_RECOVERY_EVENTS,
      ];
      const tx = createDurableWriteTransaction(db, stores, 'strict');

      let aborted = false;
      const fail = (err: Error) => {
        if (aborted) return;
        aborted = true;
        try {
          tx.abort();
        } catch {
          // ignore
        }
        reject(err);
      };

      tx.onerror = () => {
        if (!aborted) reject(tx.error || new Error('Apply replay promotion plan transaction failed'));
      };
      tx.onabort = () => {
        if (!aborted) reject(tx.error || new Error('Apply replay promotion plan transaction aborted'));
      };
      tx.oncomplete = () => {
        if (!aborted) resolve();
      };

      const convStore = tx.objectStore(STORE_CONVERSATIONS);
      const msgStore = tx.objectStore(STORE_MESSAGES);
      const revStore = tx.objectStore(STORE_REVISIONS);
      const recStore = tx.objectStore(STORE_RECOVERY_EVENTS);

      const convReq = convStore.get(plan.conversation.id);
      convReq.onerror = () => fail(convReq.error || new Error('Failed to read conversation for replay promotion'));
      convReq.onsuccess = () => {
        const existingConv = convReq.result as Conversation | undefined;
        if (existingConv) {
          convStore.put({
            ...plan.conversation,
            title: plan.conversation.title || existingConv.title,
            createdAt: existingConv.createdAt,
            updatedAt: Math.max(existingConv.updatedAt, plan.conversation.updatedAt),
          });
        } else {
          convStore.put(plan.conversation);
        }
      };

      const msgReq = msgStore.get(plan.message.id);
      msgReq.onerror = () => fail(msgReq.error || new Error(`Failed to read message ${plan.message.id} for replay promotion`));
      msgReq.onsuccess = () => {
        const existingMsg = msgReq.result as Message | undefined;
        const merged = mergeCanonicalMessage(existingMsg, plan.message, 'replay');
        msgStore.put(merged);
      };

      for (const rev of plan.revisions) {
        const revReq = revStore.get(rev.id);
        revReq.onerror = () => fail(revReq.error || new Error(`Failed to check existing revision ${rev.id}`));
        revReq.onsuccess = () => {
          const existingRev = revReq.result as ResponseRevision | undefined;
          if (existingRev) {
            if (!isRevisionPayloadIdentical(existingRev, rev)) {
              fail(new Error(`revision_conflict: cannot mutate existing revision ${rev.id}`));
              return;
            }
          } else {
            revStore.put(rev);
          }
        };
      }

      if (plan.recoveryEvents) {
        for (const rec of plan.recoveryEvents) {
          const recReq = recStore.get(rec.id);
          recReq.onerror = () => fail(recReq.error || new Error(`Failed to check existing recovery event ${rec.id}`));
          recReq.onsuccess = () => {
            const existingRec = recReq.result as RecoveryEvent | undefined;
            if (existingRec) {
              if (!isRecoveryEventIdentical(existingRec, rec)) {
                fail(new Error(`recovery_event_conflict: cannot mutate existing recovery event ${rec.id}`));
                return;
              }
            } else {
              recStore.put(rec);
            }
          };
        }
      }
    });
  }

  // ── History Staging Operations ──

  async saveHistoryStagingManifest(manifest: HistoryStagingManifestRecord): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = createDurableWriteTransaction(db, [STORE_HISTORY_STAGING_MANIFESTS], 'strict');
      const store = tx.objectStore(STORE_HISTORY_STAGING_MANIFESTS);
      const req = store.get(manifest.stagingId);
      req.onerror = () => reject(req.error || new Error('Failed to check staging manifest'));
      req.onsuccess = () => {
        const existing = req.result as HistoryStagingManifestRecord | undefined;
        if (existing) {
          if (
            existing.sessionId === manifest.sessionId &&
            existing.expectedBatchCount === manifest.expectedBatchCount &&
            existing.expectedMessageCount === manifest.expectedMessageCount
          ) {
            // Idempotent success
            return;
          }
          reject(
            new Error(
              `history_staging_conflict: manifest ${manifest.stagingId} exists with different configuration`
            )
          );
          return;
        }
        const recordToSave: HistoryStagingManifestRecord = {
          ...manifest,
          receivedBatchCount: manifest.receivedBatchCount ?? 0,
        };
        store.put(recordToSave);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Save history staging manifest tx failed'));
      tx.onabort = () => reject(tx.error || new Error('Save history staging manifest tx aborted'));
    });
  }

  async getHistoryStagingManifest(stagingId: string): Promise<HistoryStagingManifestRecord | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_HISTORY_STAGING_MANIFESTS, 'readonly');
      const store = tx.objectStore(STORE_HISTORY_STAGING_MANIFESTS);
      const req = store.get(stagingId);
      req.onsuccess = () => resolve((req.result as HistoryStagingManifestRecord) || null);
      req.onerror = () => reject(req.error || new Error('Failed to get staging manifest'));
    });
  }

  async saveHistoryStagingBatch(batch: HistoryStagingBatchRecord): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = createDurableWriteTransaction(
        db,
        [STORE_HISTORY_STAGING, STORE_HISTORY_STAGING_MANIFESTS],
        'strict'
      );
      let aborted = false;
      const fail = (err: Error) => {
        if (aborted) return;
        aborted = true;
        try {
          tx.abort();
        } catch {
          // ignore
        }
        reject(err);
      };

      tx.onerror = () => {
        if (!aborted) reject(tx.error || new Error('Save staging batch tx failed'));
      };
      tx.onabort = () => {
        if (!aborted) reject(tx.error || new Error('Save staging batch tx aborted'));
      };
      tx.oncomplete = () => {
        if (!aborted) resolve();
      };

      const manifestStore = tx.objectStore(STORE_HISTORY_STAGING_MANIFESTS);
      const stagingStore = tx.objectStore(STORE_HISTORY_STAGING);

      const mReq = manifestStore.get(batch.stagingId);
      mReq.onerror = () => fail(mReq.error || new Error('Failed to read manifest for batch'));
      mReq.onsuccess = () => {
        const manifest = mReq.result as HistoryStagingManifestRecord | undefined;
        if (!manifest) {
          fail(new Error(`history_staging_missing: manifest not found for stagingId ${batch.stagingId}`));
          return;
        }
        if (manifest.state !== 'open') {
          fail(new Error(`history_staging_not_open: manifest in state ${manifest.state}`));
          return;
        }
        if (batch.batchIndex < 0 || batch.batchIndex >= manifest.expectedBatchCount) {
          fail(
            new Error(
              `history_batch_bounds: invalid batchIndex ${batch.batchIndex} (expected 0..${manifest.expectedBatchCount - 1})`
            )
          );
          return;
        }
        if (batch.session && batch.session.sessionId !== manifest.sessionId) {
          fail(
            new Error(
              `history_session_mismatch: batch session ${batch.session.sessionId} does not match manifest ${manifest.sessionId}`
            )
          );
          return;
        }

        const bReq = stagingStore.get(batch.id);
        bReq.onerror = () => fail(bReq.error || new Error('Failed to check existing batch'));
        bReq.onsuccess = () => {
          const existing = bReq.result as HistoryStagingBatchRecord | undefined;
          if (existing) {
            const isIdentical =
              serializeHistoryStagingBatchForFingerprint(existing) ===
              serializeHistoryStagingBatchForFingerprint(batch);
            if (!isIdentical) {
              fail(new Error(`history_batch_conflict: duplicate batch ${batch.id} with different payload`));
              return;
            }
            // Idempotent re-ACK
            return;
          }

          stagingStore.put(batch);
          manifest.receivedBatchCount++;
          manifest.updatedAt = Date.now();
          manifestStore.put(manifest);
        };
      };
    });
  }

  async listHistoryStagingBatches(stagingId: string): Promise<HistoryStagingBatchRecord[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_HISTORY_STAGING, 'readonly');
      const store = tx.objectStore(STORE_HISTORY_STAGING);
      const index = store.index('stagingId');
      const req = index.getAll(stagingId);
      req.onsuccess = () => {
        const records = (req.result as HistoryStagingBatchRecord[]) || [];
        records.sort((a, b) => a.batchIndex - b.batchIndex);
        resolve(records);
      };
      req.onerror = () => reject(req.error || new Error('Failed to list history staging batches'));
    });
  }

  async clearHistoryStaging(stagingId: string): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = createDurableWriteTransaction(
        db,
        [STORE_HISTORY_STAGING, STORE_HISTORY_STAGING_MANIFESTS],
        'strict'
      );
      const manifestStore = tx.objectStore(STORE_HISTORY_STAGING_MANIFESTS);
      const stagingStore = tx.objectStore(STORE_HISTORY_STAGING);

      manifestStore.delete(stagingId);

      const index = stagingStore.index('stagingId');
      const keyRangeFactory =
        typeof IDBKeyRange !== 'undefined'
          ? IDBKeyRange
          : (globalThis as any)?.IDBKeyRange;
      const keyRange = keyRangeFactory ? keyRangeFactory.only(stagingId) : null;
      const req = index.openCursor(keyRange);
      req.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest).result as IDBCursorWithValue | null;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      req.onerror = () => reject(req.error || new Error('Failed to clear history staging cursor'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Clear history staging transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('Clear history staging transaction aborted'));
    });
  }

  async cleanupStaleHistoryStaging(ttlMs = 24 * 60 * 60 * 1000): Promise<number> {
    const db = await this.getDb();
    const cutoff = Date.now() - ttlMs;
    return new Promise((resolve, reject) => {
      const tx = createDurableWriteTransaction(
        db,
        [STORE_HISTORY_STAGING, STORE_HISTORY_STAGING_MANIFESTS],
        'strict'
      );
      const manifestStore = tx.objectStore(STORE_HISTORY_STAGING_MANIFESTS);
      const stagingStore = tx.objectStore(STORE_HISTORY_STAGING);

      let cleaned = 0;
      const curReq = manifestStore.openCursor();
      curReq.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest).result as IDBCursorWithValue | null;
        if (cursor) {
          const record = cursor.value as HistoryStagingManifestRecord;
          if (record.createdAt < cutoff || record.state === 'aborted' || record.state === 'completed') {
            const stagingId = record.stagingId;
            cursor.delete();
            cleaned++;

            const bIndex = stagingStore.index('stagingId');
            const keyRangeFactory =
              typeof IDBKeyRange !== 'undefined'
                ? IDBKeyRange
                : (globalThis as any)?.IDBKeyRange;
            const bReq = bIndex.openCursor(keyRangeFactory ? keyRangeFactory.only(stagingId) : null);
            bReq.onsuccess = (be) => {
              const bCursor = (be.target as IDBRequest).result as IDBCursorWithValue | null;
              if (bCursor) {
                bCursor.delete();
                bCursor.continue();
              }
            };
          }
          cursor.continue();
        }
      };

      tx.oncomplete = () => resolve(cleaned);
      tx.onerror = () => reject(tx.error || new Error('Cleanup stale staging transaction failed'));
    });
  }

  async commitHistoryStagingPlan(
    stagingId: string,
    plan: HistoryReconciliationPlan
  ): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const stores = [
        STORE_CONVERSATIONS,
        STORE_MESSAGES,
        STORE_REVISIONS,
        STORE_HISTORY_STAGING,
        STORE_HISTORY_STAGING_MANIFESTS,
      ];
      const tx = createDurableWriteTransaction(db, stores, 'strict');

      let aborted = false;
      const fail = (err: Error) => {
        if (aborted) return;
        aborted = true;
        try {
          tx.abort();
        } catch {
          // ignore
        }
        reject(err);
      };

      tx.onerror = () => {
        if (!aborted) reject(tx.error || new Error('Commit history staging plan transaction failed'));
      };
      tx.onabort = () => {
        if (!aborted) reject(tx.error || new Error('Commit history staging plan transaction aborted'));
      };
      tx.oncomplete = () => {
        if (!aborted) resolve();
      };

      const manifestStore = tx.objectStore(STORE_HISTORY_STAGING_MANIFESTS);
      const stagingStore = tx.objectStore(STORE_HISTORY_STAGING);
      const convStore = tx.objectStore(STORE_CONVERSATIONS);
      const msgStore = tx.objectStore(STORE_MESSAGES);
      const revStore = tx.objectStore(STORE_REVISIONS);

      const mReq = manifestStore.get(stagingId);
      mReq.onerror = () => fail(mReq.error || new Error('Failed to read staging manifest on commit'));
      mReq.onsuccess = () => {
        const manifest = mReq.result as HistoryStagingManifestRecord | undefined;
        if (!manifest) {
          fail(new Error(`history_staging_missing: manifest not found for ${stagingId}`));
          return;
        }
        if (manifest.state !== 'open') {
          fail(new Error(`history_staging_not_open: staging state is ${manifest.state}`));
          return;
        }
        const planSessionId = plan.conversation.remoteId || plan.conversation.id;
        if (planSessionId !== manifest.sessionId) {
          fail(
            new Error(
              `history_plan_session_mismatch: plan session ${planSessionId} does not match manifest ${manifest.sessionId}`
            )
          );
          return;
        }
        if (manifest.receivedBatchCount !== manifest.expectedBatchCount) {
          fail(
            new Error(
              `history_staging_incomplete: received ${manifest.receivedBatchCount} of ${manifest.expectedBatchCount} batches`
            )
          );
          return;
        }

        const stagingIndex = stagingStore.index('stagingId');
        const keyRangeFactory =
          typeof IDBKeyRange !== 'undefined'
            ? IDBKeyRange
            : (globalThis as any)?.IDBKeyRange;
        const keyRange = keyRangeFactory ? keyRangeFactory.only(stagingId) : null;
        const allReq = stagingIndex.getAll(keyRange);
        allReq.onerror = () => fail(allReq.error || new Error('Failed to load batches for commit verification'));
        allReq.onsuccess = () => {
          const batches = (allReq.result as HistoryStagingBatchRecord[]) || [];
          if (batches.length !== manifest.expectedBatchCount) {
            fail(
              new Error(
                `history_staging_incomplete: expected ${manifest.expectedBatchCount} batches, found ${batches.length}`
              )
            );
            return;
          }

          const indices = new Set(batches.map((b) => b.batchIndex));
          for (let i = 0; i < manifest.expectedBatchCount; i++) {
            if (!indices.has(i)) {
              fail(new Error(`history_staging_incomplete: missing batch index ${i}`));
              return;
            }
          }

          const totalMessages = batches.reduce((acc, b) => acc + b.messages.length, 0);
          if (totalMessages !== manifest.expectedMessageCount) {
            fail(
              new Error(
                `history_staging_incomplete: expected ${manifest.expectedMessageCount} messages, found ${totalMessages}`
              )
            );
            return;
          }

          // Apply reconciliation with full canonical invariants!
          this.applyReconciliationPlanToStores(plan, convStore, msgStore, revStore, fail);

          // Atomically delete manifest and all staging batches
          manifestStore.delete(stagingId);

          const curReq = stagingIndex.openCursor(keyRange);
          curReq.onsuccess = (e) => {
            const cursor = (e.target as IDBRequest).result as IDBCursorWithValue | null;
            if (cursor) {
              cursor.delete();
              cursor.continue();
            }
          };
          curReq.onerror = () => fail(curReq.error || new Error('Failed to delete staging records'));
        };
      };
    });
  }

  // ── Read-only Archive Browser Queries ──

  async listArchiveConversations(options?: {
    limit?: number;
    cursor?: string;
  }): Promise<PaginatedArchiveConversations> {
    const db = await this.getDb();
    const limit = Math.max(1, Math.min(options?.limit ?? 20, 100));

    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readonly');
      const convStore = tx.objectStore(STORE_CONVERSATIONS);
      const msgStore = tx.objectStore(STORE_MESSAGES);

      let totalCount = 0;
      const totalCountReq = convStore.count();
      totalCountReq.onsuccess = () => {
        totalCount = totalCountReq.result || 0;
      };

      const conversations: Conversation[] = [];
      let cursorTimestampBound: number | null = options?.cursor ? Number(options.cursor) : null;
      if (cursorTimestampBound !== null && isNaN(cursorTimestampBound)) {
        cursorTimestampBound = null;
      }

      const index = convStore.index('updatedAt');
      const keyRangeFactory =
        typeof IDBKeyRange !== 'undefined'
          ? IDBKeyRange
          : (globalThis as any)?.IDBKeyRange;

      const keyRange =
        cursorTimestampBound !== null && keyRangeFactory
          ? keyRangeFactory.upperBound(cursorTimestampBound, true)
          : null;

      const cursorReq = index.openCursor(keyRange, 'prev');
      let reachedLimit = false;
      let nextCursor: string | undefined = undefined;

      cursorReq.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest).result as IDBCursorWithValue | null;
        if (!cursor) {
          finishAggregation();
          return;
        }

        // Environment fallback if keyRange was null
        if (cursorTimestampBound !== null && cursor.value.updatedAt >= cursorTimestampBound) {
          cursor.continue();
          return;
        }

        if (conversations.length < limit) {
          conversations.push(cursor.value as Conversation);
          cursor.continue();
        } else {
          // One extra item detected; last item's timestamp serves as upper bound for next page
          reachedLimit = true;
          nextCursor = String(conversations[conversations.length - 1]!.updatedAt);
          finishAggregation();
        }
      };

      cursorReq.onerror = () => reject(cursorReq.error || new Error('Failed to list archive conversations'));

      const finishAggregation = () => {
        if (conversations.length === 0) {
          resolve({
            items: [],
            totalCount,
            nextCursor: undefined,
          });
          return;
        }

        const msgIndex = msgStore.index('conversationId');
        const items: ArchiveConversationSummary[] = [];
        let pending = conversations.length;

        for (const conv of conversations) {
          const req = msgIndex.getAll(conv.id);
          req.onerror = () => reject(req.error || new Error(`Failed to get messages for conversation ${conv.id}`));
          req.onsuccess = () => {
            const msgs = (req.result as Message[]) || [];
            let hasDegraded = false;
            let recoveredCount = 0;

            for (const m of msgs) {
              if (
                m.status === 'filtered' ||
                m.status === 'degraded' ||
                m.status === 'interrupted' ||
                m.status === 'incomplete'
              ) {
                hasDegraded = true;
              }
              if (m.status === 'filtered') {
                recoveredCount++;
              }
            }

            items.push({
              id: conv.id,
              remoteId: conv.remoteId,
              title: conv.title,
              messageCount: msgs.filter((m) => isLogicalMessage(m)).length,
              recoveredCount,
              hasDegraded,
              createdAt: conv.createdAt,
              updatedAt: conv.updatedAt,
            });

            pending--;
            if (pending === 0) {
              // Preserve original descending sort order by updatedAt
              items.sort((a, b) => b.updatedAt - a.updatedAt);
              resolve({
                items,
                totalCount,
                nextCursor,
              });
            }
          };
        }
      };

      tx.onerror = () => reject(tx.error || new Error('Transaction failed in listArchiveConversations'));
    });
  }

  async getArchiveConversation(id: string): Promise<ArchiveConversationDetail | null> {
    const conversation = await this.getConversation(id);
    if (!conversation) {
      return null;
    }
    const messages = await this.listArchiveMessages(id);
    return {
      conversation,
      messages,
    };
  }

  async listArchiveMessages(conversationId: string): Promise<ArchiveMessageSummary[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(
        [STORE_MESSAGES, STORE_REVISIONS, STORE_RECOVERY_EVENTS],
        'readonly'
      );
      const msgStore = tx.objectStore(STORE_MESSAGES);
      const revStore = tx.objectStore(STORE_REVISIONS);
      const recStore = tx.objectStore(STORE_RECOVERY_EVENTS);

      const msgIndex = msgStore.index('conversationId');
      const msgReq = msgIndex.getAll(conversationId);

      msgReq.onerror = () => reject(msgReq.error || new Error('Failed to query messages'));
      msgReq.onsuccess = () => {
        const messages = (msgReq.result as Message[]) || [];
        if (messages.length === 0) {
          resolve([]);
          return;
        }

        const revIndex = revStore.index('messageId');
        const recIndex = recStore.index('messageId');

        const summaries: ArchiveMessageSummary[] = [];
        let pending = messages.length;

        for (const msg of messages) {
          const revReq = revIndex.getAll(msg.id);
          const recReq = recIndex.getAll(msg.id);

          let revsLoaded: ResponseRevision[] | null = null;
          let recsLoaded: RecoveryEvent[] | null = null;

          const checkDone = () => {
            if (revsLoaded !== null && recsLoaded !== null) {
              revsLoaded.sort((a, b) => a.revisionIndex - b.revisionIndex);
              recsLoaded.sort((a, b) => a.detectedAt - b.detectedAt);

              const revMetadata: ArchiveRevisionMetadata[] = revsLoaded.map((r) => ({
                id: r.id,
                messageId: r.messageId,
                revisionIndex: r.revisionIndex,
                source: r.source,
                capturedAt: r.capturedAt,
                isFinal: r.isFinal,
                isLastGood: r.isLastGood,
                textLength: r.text.length,
                thinkingLength: r.thinking?.length ?? 0,
                contentFingerprint: r.contentFingerprint,
              }));

              const preferred = selectPreferredRevision(msg, revsLoaded);

              summaries.push({
                id: msg.id,
                remoteId: msg.remoteId,
                conversationId: msg.conversationId,
                parentId: msg.parentId,
                remoteParentId: msg.remoteParentId,
                sourceRawStreamKey: msg.sourceRawStreamKey,
                identityState: msg.identityState,
                projectionState: msg.projectionState,
                role: msg.role,
                status: msg.status,
                content: msg.content,
                createdAt: msg.createdAt,
                updatedAt: msg.updatedAt,
                revisions: revMetadata,
                recoveryEvents: recsLoaded,
                preferredRevision: preferred || undefined,
              });

              pending--;
              if (pending === 0) {
                // Stable ordering: createdAt asc, then id
                summaries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
                resolve(summaries);
              }
            }
          };

          revReq.onerror = () => reject(revReq.error || new Error(`Failed to load revisions for ${msg.id}`));
          revReq.onsuccess = () => {
            revsLoaded = (revReq.result as ResponseRevision[]) || [];
            checkDone();
          };

          recReq.onerror = () => reject(recReq.error || new Error(`Failed to load recovery events for ${msg.id}`));
          recReq.onsuccess = () => {
            recsLoaded = (recReq.result as RecoveryEvent[]) || [];
            checkDone();
          };
        }
      };

      tx.onerror = () => reject(tx.error || new Error('Transaction failed in listArchiveMessages'));
    });
  }

  async getRevisionContent(id: string): Promise<{ text: string; thinking?: string } | null> {
    const revision = await this.getRevision(id);
    if (!revision) {
      return null;
    }
    return {
      text: revision.text,
      thinking: revision.thinking,
    };
  }

  async getRecoveryMetadataForConversation(
    conversationId: string
  ): Promise<import('../../adapters/deepseek/dom/types').PageRecoveryMessageSummary[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(
        [STORE_MESSAGES, STORE_RECOVERY_EVENTS, STORE_REVISIONS],
        'readonly'
      );
      const msgStore = tx.objectStore(STORE_MESSAGES);
      const recStore = tx.objectStore(STORE_RECOVERY_EVENTS);
      const revStore = tx.objectStore(STORE_REVISIONS);

      const msgIndex = msgStore.index('conversationId');
      const msgReq = msgIndex.getAll(conversationId);

      msgReq.onerror = () => reject(msgReq.error || new Error('Failed to query messages for recovery metadata'));
      msgReq.onsuccess = () => {
        const messages = (msgReq.result as Message[]) || [];
        if (messages.length === 0) {
          resolve([]);
          return;
        }

        const results: import('../../adapters/deepseek/dom/types').PageRecoveryMessageSummary[] = [];
        let pendingChecks = messages.length;

        const checkDone = () => {
          pendingChecks--;
          if (pendingChecks === 0) {
            resolve(results);
          }
        };

        const recIndex = recStore.index('messageId');

        for (const m of messages) {
          const recReq = recIndex.getAll(m.id);
          recReq.onerror = () => checkDone();
          recReq.onsuccess = () => {
            const events = (recReq.result as RecoveryEvent[]) || [];
            const authEvent = events.find((e) => e.recoveredRevisionId && e.messageId === m.id);

            if (authEvent && authEvent.recoveredRevisionId) {
              const revReq = revStore.get(authEvent.recoveredRevisionId);
              revReq.onerror = () => checkDone();
              revReq.onsuccess = () => {
                const rev = revReq.result as ResponseRevision | undefined;
                const hasDirectContent =
                  rev && (rev.text.trim().length > 0 || (rev.thinking && rev.thinking.trim().length > 0));

                let effectiveRemoteId = m.remoteId;
                if (!effectiveRemoteId) {
                  // Read-time healing: if m is missing remoteId, check if another assistant message
                  // under the same confirmed parent received the remoteId from server history
                  const peer = messages.find(
                    (p) =>
                      p.id !== m.id &&
                      p.role === 'assistant' &&
                      Boolean(p.remoteId) &&
                      ((p.parentId && m.parentId && p.parentId === m.parentId) ||
                        (p.remoteParentId && m.remoteParentId && p.remoteParentId === m.remoteParentId))
                  );
                  if (peer?.remoteId) {
                    effectiveRemoteId = peer.remoteId;
                  }
                }

                if (rev && rev.isLastGood && rev.messageId === m.id && hasDirectContent) {
                  const presKind =
                    authEvent.kind === 'network_interruption'
                      ? 'interruption_recovery'
                      : 'pre_filter_recovery';
                  results.push({
                    messageId: m.id,
                    remoteId: effectiveRemoteId,
                    role: m.role,
                    status: m.status,
                    hasLastGood: true,
                    recoveryKind: 'authoritative_recovery',
                    presentationKind: presKind,
                    capturedAt: rev.capturedAt,
                    recoveredRevisionId: rev.id,
                    recoveryEventId: authEvent.id,
                  });
                  checkDone();
                  return;
                }

                // Read-time legacy repair: RecoveryEvent pointed to empty revision
                // Query all revisions for m.id to find latest meaningful network revision
                const revIndex = revStore.index('messageId');
                const allRevsReq = revIndex.getAll(m.id);
                allRevsReq.onerror = () => checkDone();
                allRevsReq.onsuccess = () => {
                  const allRevs = (allRevsReq.result as ResponseRevision[]) || [];
                  const repairedRev = [...allRevs].reverse().find(
                    (r) =>
                      r.source === 'network' &&
                      (r.text.trim().length > 0 || (r.thinking && r.thinking.trim().length > 0))
                  );
                  if (repairedRev) {
                    const presKind =
                      authEvent.kind === 'network_interruption'
                        ? 'interruption_recovery'
                        : 'pre_filter_recovery';
                    results.push({
                      messageId: m.id,
                      remoteId: effectiveRemoteId,
                      role: m.role,
                      status: m.status,
                      hasLastGood: true,
                      recoveryKind: 'authoritative_recovery',
                      presentationKind: presKind,
                      capturedAt: repairedRev.capturedAt,
                      recoveredRevisionId: repairedRev.id,
                      recoveryEventId: authEvent.id,
                    });
                  }
                  checkDone();
                };
              };
              return;
            }

            // Fallback for interrupted / degraded messages
            const isInterrupted =
              m.status === 'filtered' ||
              m.status === 'degraded' ||
              m.status === 'interrupted' ||
              m.status === 'incomplete';

            if (isInterrupted) {
              const revIndex = revStore.index('messageId');
              const revReq = revIndex.getAll(m.id);
              revReq.onerror = () => checkDone();
              revReq.onsuccess = () => {
                const revs = (revReq.result as ResponseRevision[]) || [];
                const latestNetwork = [...revs]
                  .reverse()
                  .find(
                    (r) =>
                      r.source === 'network' &&
                      (r.text.length > 0 || (r.thinking && r.thinking.length > 0))
                  );
                if (latestNetwork) {
                  results.push({
                    messageId: m.id,
                    remoteId: m.remoteId,
                    role: m.role,
                    status: m.status,
                    hasLastGood: Boolean(latestNetwork.isLastGood),
                    recoveryKind: 'partial_capture',
                    presentationKind: 'partial_capture',
                    capturedAt: latestNetwork.capturedAt,
                    recoveredRevisionId: latestNetwork.id,
                  });
                }
                checkDone();
              };
              return;
            }

            checkDone();
          };
        }
      };

      tx.onerror = () => reject(tx.error || new Error('Recovery metadata transaction failed'));
    });
  }

  // ── Diagnostic & Summary Metrics ──

  async getArchiveSummary(): Promise<ArchiveSummary> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(
        [STORE_CONVERSATIONS, STORE_MESSAGES, STORE_REVISIONS, STORE_RECOVERY_EVENTS],
        'readonly'
      );

      const convCountReq = tx.objectStore(STORE_CONVERSATIONS).count();
      const msgStore = tx.objectStore(STORE_MESSAGES);
      const msgCountReq = msgStore.count();
      const revStore = tx.objectStore(STORE_REVISIONS);
      const revCountReq = revStore.count();
      const recCountReq = tx.objectStore(STORE_RECOVERY_EVENTS).count();

      let reconciledCount = 0;
      let lastGoodCount = 0;
      let userMessagesCount = 0;
      let assistantMessagesCount = 0;
      let idConflictsCount = 0;
      let recoveriesWithTextCount = 0;
      let recoveriesWithThinkingOnlyCount = 0;

      const seenRemoteIds = new Set<string>();
      const knownIds = new Set<string>();
      const parentPointers: Array<{ parentId?: string; remoteParentId?: string; role: string }> = [];
      const userBranchesByParent = new Map<string, number>();
      const assistantBranchesByParent = new Map<string, number>();

      const msgCursor = msgStore.openCursor();
      msgCursor.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest).result as IDBCursorWithValue;
        if (cursor) {
          const val = cursor.value;
          if (val.identityState === 'reconciled') {
            reconciledCount++;
          }
          if (val.role === 'user') {
            userMessagesCount++;
            const k = `${val.conversationId || ''}:${val.parentId || val.remoteParentId || '__root__'}`;
            userBranchesByParent.set(k, (userBranchesByParent.get(k) || 0) + 1);
          } else {
            assistantMessagesCount++;
            const k = `${val.conversationId || ''}:${val.parentId || val.remoteParentId || '__orphan__'}`;
            assistantBranchesByParent.set(k, (assistantBranchesByParent.get(k) || 0) + 1);
          }

          if (val.id) knownIds.add(val.id);
          if (val.remoteId) {
            knownIds.add(val.remoteId);
            const scopedKey = `${val.conversationId || 'default'}::${val.remoteId}`;
            if (seenRemoteIds.has(scopedKey)) {
              idConflictsCount++;
            } else {
              seenRemoteIds.add(scopedKey);
            }
          }

          parentPointers.push({
            parentId: val.parentId,
            remoteParentId: val.remoteParentId,
            role: val.role || 'assistant',
          });

          cursor.continue();
        }
      };

      // Count isLastGood revisions and recovery content types without loading giant text arrays into memory
      const revCursor = revStore.openCursor();
      revCursor.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest).result as IDBCursorWithValue;
        if (cursor) {
          const rev = cursor.value;
          if (rev.isLastGood) {
            lastGoodCount++;
            const hasText = !!(rev.text && rev.text.trim().length > 0);
            const hasThinking = !!(rev.thinking && rev.thinking.trim().length > 0);
            if (hasText) {
              recoveriesWithTextCount++;
            } else if (hasThinking) {
              recoveriesWithThinkingOnlyCount++;
            }
          }
          cursor.continue();
        }
      };

      let unmatchedCapturesCount = 0;
      let attemptOnlyCount = 0;

      if (msgStore.indexNames.contains('projectionState')) {
        const projIndex = msgStore.index('projectionState');
        const unmatchReq = projIndex.count('unmatched_capture');
        unmatchReq.onsuccess = () => {
          unmatchedCapturesCount = unmatchReq.result || 0;
        };
        const attemptReq = projIndex.count('attempt_only');
        attemptReq.onsuccess = () => {
          attemptOnlyCount = attemptReq.result || 0;
        };
      }

      tx.oncomplete = () => {
        const totalMessages = msgCountReq.result || 0;
        const provisionalCount = Math.max(0, totalMessages - reconciledCount);

        let userPromptVariantsCount = 0;
        for (const count of userBranchesByParent.values()) {
          if (count > 1) userPromptVariantsCount += (count - 1);
        }

        let assistantVariantsCount = 0;
        for (const count of assistantBranchesByParent.values()) {
          if (count > 1) assistantVariantsCount += (count - 1);
        }

        let unconfirmedParentMessagesCount = 0;
        for (const ptr of parentPointers) {
          if (ptr.parentId || ptr.remoteParentId) {
            const parentFound =
              (ptr.parentId && knownIds.has(ptr.parentId)) ||
              (ptr.remoteParentId && knownIds.has(ptr.remoteParentId));
            if (!parentFound) {
              unconfirmedParentMessagesCount++;
            }
          } else if (ptr.role === 'assistant') {
            unconfirmedParentMessagesCount++;
          }
        }

        resolve({
          conversationsCount: convCountReq.result || 0,
          messagesCount: totalMessages,
          provisionalMessagesCount: provisionalCount,
          reconciledMessagesCount: reconciledCount,
          revisionsCount: revCountReq.result || 0,
          lastGoodRevisionsCount: lastGoodCount,
          recoveryEventsCount: recCountReq.result || 0,
          unmatchedCapturesCount,
          attemptOnlyCount,
          userMessagesCount,
          assistantMessagesCount,
          userPromptVariantsCount,
          assistantVariantsCount,
          unconfirmedParentMessagesCount,
          idConflictsCount,
          recoveriesWithTextCount,
          recoveriesWithThinkingOnlyCount,
        });
      };

      tx.onerror = () => reject(tx.error || new Error('Failed to get archive summary'));
    });
  }

  /**
   * Idempotently repairs legacy message projections across the database.
   * Strips phantom tree branch links from empty failed transport attempts and
   * classifies meaningful partial captures without modifying raw journal evidence.
   */
  async repairCanonicalProjection(): Promise<{
    scannedCount: number;
    repairedCount: number;
    attemptOnlyCount: number;
    unmatchedCapturesCount: number;
  }> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(
        [STORE_MESSAGES, STORE_REVISIONS, STORE_RECOVERY_EVENTS],
        'readwrite'
      );
      const msgStore = tx.objectStore(STORE_MESSAGES);
      const revStore = tx.objectStore(STORE_REVISIONS);
      const recStore = tx.objectStore(STORE_RECOVERY_EVENTS);
      const revIndex = revStore.index('messageId');
      const recIndex = recStore.index('messageId');

      const allMessagesReq = msgStore.getAll();
      allMessagesReq.onerror = () => reject(allMessagesReq.error || new Error('Failed to load messages for repair'));

      allMessagesReq.onsuccess = () => {
        const messages = (allMessagesReq.result as Message[]) || [];
        if (messages.length === 0) {
          resolve({ scannedCount: 0, repairedCount: 0, attemptOnlyCount: 0, unmatchedCapturesCount: 0 });
          return;
        }

        let scannedCount = 0;
        let repairedCount = 0;
        let attemptOnlyCount = 0;
        let unmatchedCapturesCount = 0;
        let pending = messages.length;

        const checkDone = () => {
          pending--;
          if (pending === 0) {
            resolve({
              scannedCount,
              repairedCount,
              attemptOnlyCount,
              unmatchedCapturesCount,
            });
          }
        };

        for (const msg of messages) {
          scannedCount++;

          if (msg.identityState === 'reconciled') {
            if (msg.projectionState !== 'logical') {
              msg.projectionState = 'logical';
              msgStore.put(msg);
              repairedCount++;
            }
            checkDone();
            continue;
          }

          if (msg.role === 'user' || msg.role === 'system') {
            if (msg.projectionState !== 'logical') {
              msg.projectionState = 'logical';
              msgStore.put(msg);
              repairedCount++;
            }
            checkDone();
            continue;
          }

          // For assistant messages:
          const revReq = revIndex.getAll(msg.id);
          const recReq = recIndex.getAll(msg.id);

          let revsLoaded: ResponseRevision[] | null = null;
          let recsLoaded: RecoveryEvent[] | null = null;

          const evaluateAssistant = () => {
            if (revsLoaded !== null && recsLoaded !== null) {
              const hasContent =
                (msg.content && msg.content.trim().length > 0) ||
                revsLoaded.some((r) => r.text.length > 0 || (r.thinking && r.thinking.length > 0)) ||
                recsLoaded.length > 0;

              let targetState: import('../../core/models').MessageProjectionState;
              if (hasContent) {
                targetState = msg.remoteId ? 'provisional_logical' : 'unmatched_capture';
              } else {
                targetState = 'attempt_only';
              }

              let modified = false;
              if (msg.projectionState !== targetState) {
                msg.projectionState = targetState;
                modified = true;
              }

              // Invariant: Non-logical assistant attempts must NEVER branch under parent
              if ((targetState === 'attempt_only' || targetState === 'unmatched_capture') && msg.parentId !== undefined) {
                msg.parentId = undefined;
                modified = true;
              }

              if (targetState === 'attempt_only') attemptOnlyCount++;
              if (targetState === 'unmatched_capture') unmatchedCapturesCount++;

              if (modified) {
                msgStore.put(msg);
                repairedCount++;
              }

              checkDone();
            }
          };

          revReq.onsuccess = () => {
            revsLoaded = (revReq.result as ResponseRevision[]) || [];
            evaluateAssistant();
          };
          revReq.onerror = () => reject(revReq.error || new Error('Failed to query revisions during repair'));

          recReq.onsuccess = () => {
            recsLoaded = (recReq.result as RecoveryEvent[]) || [];
            evaluateAssistant();
          };
          recReq.onerror = () => reject(recReq.error || new Error('Failed to query recovery events during repair'));
        }
      };

      tx.onerror = () => reject(tx.error || new Error('Transaction failed during repairCanonicalProjection'));
    });
  }

  // ── Atomic Synthetic Batch Persistence (ACK pipeline support) ──

  async saveSyntheticBatch(data: {
    conversation: Conversation;
    message: Message;
    revision: ResponseRevision;
  }): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(
        [STORE_CONVERSATIONS, STORE_MESSAGES, STORE_REVISIONS],
        'readwrite'
      );

      const convStore = tx.objectStore(STORE_CONVERSATIONS);
      const msgStore = tx.objectStore(STORE_MESSAGES);
      const revStore = tx.objectStore(STORE_REVISIONS);

      convStore.put(data.conversation);
      msgStore.put(data.message);
      revStore.put(data.revision);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Batch transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('Batch transaction aborted'));
    });
  }

  // ── Export & Portable Backup Methods ──

  async getConversationExportModel(
    conversationId: string,
    options?: { includeRevisions?: boolean }
  ): Promise<ConversationExportModel | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(
        [STORE_CONVERSATIONS, STORE_MESSAGES, STORE_REVISIONS, STORE_RECOVERY_EVENTS],
        'readonly'
      );
      const convStore = tx.objectStore(STORE_CONVERSATIONS);
      const msgStore = tx.objectStore(STORE_MESSAGES);
      const revStore = tx.objectStore(STORE_REVISIONS);
      const recStore = tx.objectStore(STORE_RECOVERY_EVENTS);

      const convReq = convStore.get(conversationId);
      convReq.onerror = () => reject(convReq.error || new Error('Failed to get conversation'));
      convReq.onsuccess = () => {
        const conversation = convReq.result as Conversation | undefined;
        if (!conversation) {
          resolve(null);
          return;
        }

        const msgIndex = msgStore.index('conversationId');
        const msgReq = msgIndex.getAll(conversationId);
        msgReq.onerror = () => reject(msgReq.error || new Error('Failed to list messages'));
        msgReq.onsuccess = () => {
          const messages = (msgReq.result as Message[]) || [];
          messages.sort((a, b) => a.createdAt - b.createdAt);

          if (messages.length === 0) {
            resolve({ conversation, messages: [] });
            return;
          }

          const revIndex = revStore.index('messageId');
          const recIndex = recStore.index('messageId');
          const includeRevs = options?.includeRevisions ?? true;

          const messageDetails: ConversationExportModel['messages'] = [];
          let pending = messages.length;

          for (const msg of messages) {
            const recReq = recIndex.getAll(msg.id);
            recReq.onerror = () => checkMsgDone();
            recReq.onsuccess = () => {
              const recoveryEvents = (recReq.result as RecoveryEvent[]) || [];

              const revReq = revIndex.getAll(msg.id);
              revReq.onerror = () => checkMsgDone();
              revReq.onsuccess = () => {
                const revs = (revReq.result as ResponseRevision[]) || [];
                revs.sort((a, b) => a.revisionIndex - b.revisionIndex);

                if (!includeRevs) {
                  // Fast path: Only retain preferred revision and lastGood revision
                  // rather than loading hundreds or thousands of intermediate streaming snapshots
                  const preferred = selectPreferredRevision(msg, revs);
                  const lastGood = revs.find((r) => r.isLastGood);
                  const boundedRevisions: ResponseRevision[] = [];
                  if (preferred) boundedRevisions.push(preferred);
                  if (lastGood && lastGood.id !== preferred?.id) boundedRevisions.push(lastGood);

                  messageDetails.push({
                    message: msg,
                    revisions: boundedRevisions,
                    recoveryEvents,
                  });
                } else {
                  messageDetails.push({
                    message: msg,
                    revisions: revs,
                    recoveryEvents,
                  });
                }
                checkMsgDone();
              };
            };

            function checkMsgDone() {
              pending--;
              if (pending === 0) {
                // Ensure messageDetails are strictly in original chronological order
                messageDetails.sort((a, b) => a.message.createdAt - b.message.createdAt);
                resolve({
                  conversation: conversation!,
                  messages: messageDetails,
                });
              }
            }
          }
        };
      };
    });
  }

  async createPortableBackupSnapshot(options?: CreateSnapshotOptions): Promise<PortableBackupSnapshot> {
    const db = await this.getDb();
    return createSnapshotInternal(db, options);
  }

  // ── Restore & Safe Merge Methods ──

  async validateAndPreflightRestore(
    input: ArrayBuffer | Uint8Array | Blob | ReadableStream<Uint8Array>,
    activeStreamsCount: number,
    mode?: RestoreMode
  ): Promise<{ preflight: RestorePreflight; backup?: MaterializedPortableBackup }> {
    const db = await this.getDb();
    return validateAndPreflightInternal(db, input, activeStreamsCount, mode);
  }

  async executeRestore(
    backup: MaterializedPortableBackup,
    mode: RestoreMode,
    activeStreamsCount: number
  ): Promise<RestoreResult> {
    const db = await this.getDb();
    return executeRestoreInternal(db, backup, mode, activeStreamsCount);
  }

  async getCurrentStoreCounts(): Promise<PortableBackupStoreCounts> {
    const db = await this.getDb();
    return getCurrentStoreCountsInternal(db);
  }

  // ── Retention, Cleanup & Safe Deletion Methods ──

  async buildConversationDeletionPlan(conversationId: string, activeStreamKeys: Set<string>): Promise<ConversationDeletionPlan> {
    const db = await this.getDb();
    return buildConversationDeletionPlanInternal(db, conversationId, activeStreamKeys);
  }

  async deleteConversationCascade(plan: ConversationDeletionPlan, activeStreamKeys: Set<string>): Promise<void> {
    const db = await this.getDb();
    return deleteConversationCascadeInternal(db, plan, activeStreamKeys);
  }

  async buildRawRetentionPlan(mode: RawRetentionMode, activeStreamKeys: Set<string>, now?: number): Promise<RawRetentionPlan> {
    const db = await this.getDb();
    return buildRawRetentionPlanInternal(db, mode, activeStreamKeys, now);
  }

  async executeRawRetentionPlan(plan: RawRetentionPlan, activeStreamKeys: Set<string>): Promise<ArchiveCleanupResult> {
    const db = await this.getDb();
    return executeRawRetentionPlanInternal(db, plan, activeStreamKeys);
  }

  async clearRawEvidence(activeStreamCount: number): Promise<ArchiveCleanupResult> {
    const db = await this.getDb();
    return clearRawEvidenceInternal(db, activeStreamCount);
  }

  async clearEntireArchive(activeStreamCount: number): Promise<{ success: boolean; durationMs: number }> {
    const db = await this.getDb();
    return clearEntireArchiveInternal(db, activeStreamCount);
  }

  async getStorageMaintenanceStatus(): Promise<StorageMaintenanceStatus> {
    const db = await this.getDb();
    const counts = await this.getCurrentStoreCounts();
    const observability = await getStorageObservability();
    const settings = await getRetentionSettings();

    let totalRawCharacters = 0;
    try {
      const tx = db.transaction(['raw_streams'], 'readonly');
      const req = tx.objectStore('raw_streams').getAll();
      const streams = await new Promise<any[]>((resolve) => {
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
      for (const s of streams) {
        totalRawCharacters += s.totalChars || 0;
      }
    } catch {
      // ignore
    }

    return {
      storageEstimate: {
        usageBytes: observability.usageBytes,
        quotaBytes: observability.quotaBytes,
        percentage: observability.percentage,
      },
      persistenceStatus: observability.persistenceStatus,
      counts,
      totalCanonicalMessages: counts.messages,
      totalRawCharacters,
      rawRetention: settings.rawRetention,
      lastAutomaticCleanupAt: settings.lastAutomaticCleanupAt,
    };
  }

  // ── Context Continuity Planner & Delivery Receipts ──

  async buildContextContinuityPlan(
    conversationId: string,
    options?: {
      leafMessageId?: string;
      branchSelections?: Record<string, number>;
      settings?: ContextContinuitySettings;
      limits?: Partial<ContextContinuityLimits>;
      alreadyBridgedIds?: Set<string>;
    }
  ): Promise<ContextContinuityPlan | null> {
    const conversation = await this.getConversation(conversationId);
    if (!conversation) return null;

    const settings = options?.settings ?? (await getContextContinuitySettings());
    const alreadyBridgedIds =
      options?.alreadyBridgedIds ?? (await this.getBridgedMessageIdsForConversation(conversationId));
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(
        [STORE_MESSAGES, STORE_REVISIONS, STORE_RECOVERY_EVENTS],
        'readonly'
      );
      const msgStore = tx.objectStore(STORE_MESSAGES);
      const revStore = tx.objectStore(STORE_REVISIONS);
      const recStore = tx.objectStore(STORE_RECOVERY_EVENTS);

      const msgIndex = msgStore.index('conversationId');
      const msgReq = msgIndex.getAll(conversationId);

      msgReq.onerror = () => reject(msgReq.error || new Error('Failed to query messages for context continuity plan'));
      msgReq.onsuccess = () => {
        const messages = (msgReq.result as Message[]) || [];
        if (messages.length === 0) {
          const plan = buildContinuityPlanInternal({
            conversationId,
            messages: [],
            revisionsMap: new Map(),
            settings,
            limits: options?.limits,
            alreadyBridgedIds,
          });
          resolve(plan);
          return;
        }

        const revisionsMap = new Map<string, ResponseRevision[]>();
        const recoveryEventsMap = new Map<string, RecoveryEvent[]>();
        let pending = messages.length;

        const checkDone = () => {
          pending--;
          if (pending === 0) {
            const plan = buildContinuityPlanInternal({
              conversationId,
              messages,
              revisionsMap,
              recoveryEventsMap,
              branchOptions: {
                leafMessageId: options?.leafMessageId,
                branchSelections: options?.branchSelections,
              },
              settings,
              limits: options?.limits,
              alreadyBridgedIds,
            });
            resolve(plan);
          }
        };

        const revIndex = revStore.index('messageId');
        const recIndex = recStore.index('messageId');

        for (const msg of messages) {
          const revReq = revIndex.getAll(msg.id);
          revReq.onerror = () => checkDone();
          revReq.onsuccess = () => {
            revisionsMap.set(msg.id, (revReq.result as ResponseRevision[]) || []);

            const recReq = recIndex.getAll(msg.id);
            recReq.onerror = () => checkDone();
            recReq.onsuccess = () => {
              recoveryEventsMap.set(msg.id, (recReq.result as RecoveryEvent[]) || []);
              checkDone();
            };
          };
        }
      };
    });
  }

  async recordContinuityReceipt(receipt: ContextContinuityReceipt): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONTEXT_CONTINUITY_RECEIPTS, 'readwrite');
      const store = tx.objectStore(STORE_CONTEXT_CONTINUITY_RECEIPTS);
      const req = store.put(receipt);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error('Failed to record continuity receipt'));
    });
  }

  async updateContinuityReceipt(id: string, updates: Partial<ContextContinuityReceipt>): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONTEXT_CONTINUITY_RECEIPTS, 'readwrite');
      const store = tx.objectStore(STORE_CONTEXT_CONTINUITY_RECEIPTS);
      const getReq = store.get(id);
      getReq.onerror = () => reject(getReq.error || new Error(`Failed to find continuity receipt ${id}`));
      getReq.onsuccess = () => {
        const existing = getReq.result as ContextContinuityReceipt | undefined;
        if (!existing) {
          return reject(new Error(`Continuity receipt ${id} not found`));
        }
        const merged: ContextContinuityReceipt = {
          ...existing,
          ...updates,
          updatedAt: Date.now(),
        };
        const putReq = store.put(merged);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error || new Error(`Failed to update continuity receipt ${id}`));
      };
    });
  }

  async getContinuityReceipt(id: string): Promise<ContextContinuityReceipt | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONTEXT_CONTINUITY_RECEIPTS, 'readonly');
      const store = tx.objectStore(STORE_CONTEXT_CONTINUITY_RECEIPTS);
      const req = store.get(id);
      req.onsuccess = () => resolve((req.result as ContextContinuityReceipt) || null);
      req.onerror = () => reject(req.error || new Error(`Failed to get continuity receipt ${id}`));
    });
  }

  async getContinuityReceiptsForConversation(conversationId: string): Promise<ContextContinuityReceipt[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONTEXT_CONTINUITY_RECEIPTS, 'readonly');
      const store = tx.objectStore(STORE_CONTEXT_CONTINUITY_RECEIPTS);
      const index = store.index('conversationId');
      const req = index.getAll(conversationId);
      req.onsuccess = () => {
        const list = (req.result as ContextContinuityReceipt[]) || [];
        list.sort((a, b) => a.createdAt - b.createdAt);
        resolve(list);
      };
      req.onerror = () => reject(req.error || new Error(`Failed to list continuity receipts for conversation ${conversationId}`));
    });
  }

  async getBridgedMessageIdsForConversation(conversationId: string): Promise<Set<string>> {
    const receipts = await this.getContinuityReceiptsForConversation(conversationId);
    const bridgedIds = new Set<string>();
    for (const r of receipts) {
      if (r.state === 'bridged' && Array.isArray(r.sourceMessageIds)) {
        for (const msgId of r.sourceMessageIds) {
          bridgedIds.add(msgId);
        }
      }
    }
    return bridgedIds;
  }
}
