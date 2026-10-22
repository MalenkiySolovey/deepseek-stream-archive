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
} from '../../core/models';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../../core/models';
import {
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
  STORE_RECOVERY_EVENTS,
  STORE_CANONICAL_CHECKPOINTS,
  STORE_HISTORY_STAGING,
  type CanonicalStreamCheckpointRecord,
  type HistoryStagingBatchRecord,
} from '../schema';
import { openExtensionDatabase, createDurableWriteTransaction } from '../db';
import { computeCanonicalCheckpointFingerprintSync } from '../../shared/crypto';

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
    const fingerprint =
      data.checkpointSeq !== undefined
        ? computeCanonicalCheckpointFingerprintSync({
            streamKey: data.streamKey,
            checkpointSeq: data.checkpointSeq,
            conversationId: data.conversation?.id,
            messageId: data.message.id,
            messageStatus: data.message.status,
            messageRemoteId: data.message.remoteId,
            messageContentLength: data.message.content?.length ?? 0,
            revisionFingerprints: data.revisions.map(
              (r) => r.contentFingerprint || `${r.text}::${r.thinking || ''}`
            ),
            recoveryEventIds: (data.recoveryEvents || []).map((e) => e.id),
            isTerminal: Boolean(data.isTerminal),
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
              // Stale out-of-order checkpoint, ignore without mutating
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
              isTerminal: Boolean(data.isTerminal),
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
              isTerminal: Boolean(data.isTerminal),
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

  // ── Atomic History Reconciliation Plan Persistence ──

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

  async saveHistoryStagingBatch(batch: HistoryStagingBatchRecord): Promise<void> {
    return this.executeWrite(STORE_HISTORY_STAGING, (store) => store.put(batch));
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
      const tx = createDurableWriteTransaction(db, [STORE_HISTORY_STAGING], 'strict');
      const store = tx.objectStore(STORE_HISTORY_STAGING);
      const index = store.index('stagingId');
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

      const convStore = tx.objectStore(STORE_CONVERSATIONS);
      const msgStore = tx.objectStore(STORE_MESSAGES);
      const revStore = tx.objectStore(STORE_REVISIONS);
      const stagingStore = tx.objectStore(STORE_HISTORY_STAGING);

      // 1. Conversation upsert
      const convReq = convStore.get(plan.conversation.id);
      convReq.onerror = () => fail(convReq.error || new Error('Failed to read conversation'));
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

      // 2. Messages put
      for (const msg of plan.messagesToPut) {
        msgStore.put(msg);
      }

      // 3. Revisions put
      for (const rev of plan.revisionsToPut) {
        revStore.put(rev);
      }

      // 4. Delete all staging records for stagingId
      const stagingIndex = stagingStore.index('stagingId');
      const keyRangeFactory =
        typeof IDBKeyRange !== 'undefined'
          ? IDBKeyRange
          : (globalThis as any)?.IDBKeyRange;
      const keyRange = keyRangeFactory ? keyRangeFactory.only(stagingId) : null;
      const curReq = stagingIndex.openCursor(keyRange);
      curReq.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest).result as IDBCursorWithValue | null;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      curReq.onerror = () => fail(curReq.error || new Error('Failed to delete staging records'));
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
              messageCount: msgs.length,
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

      // Count identityState without loading message bodies
      if (msgStore.indexNames.contains('identityState')) {
        const idIndex = msgStore.index('identityState');
        const recReq = idIndex.count('reconciled');
        recReq.onsuccess = () => {
          reconciledCount = recReq.result || 0;
        };
      } else {
        const msgCursor = msgStore.openCursor();
        msgCursor.onsuccess = (e) => {
          const cursor = (e.target as IDBRequest).result as IDBCursorWithValue;
          if (cursor) {
            if (cursor.value.identityState === 'reconciled') reconciledCount++;
            cursor.continue();
          }
        };
      }

      // Count isLastGood revisions without loading giant text arrays into memory
      const revCursor = revStore.openCursor();
      revCursor.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest).result as IDBCursorWithValue;
        if (cursor) {
          if (cursor.value.isLastGood) lastGoodCount++;
          cursor.continue();
        }
      };

      tx.oncomplete = () => {
        const totalMessages = msgCountReq.result || 0;
        const provisionalCount = Math.max(0, totalMessages - reconciledCount);

        resolve({
          conversationsCount: convCountReq.result || 0,
          messagesCount: totalMessages,
          provisionalMessagesCount: provisionalCount,
          reconciledMessagesCount: reconciledCount,
          revisionsCount: revCountReq.result || 0,
          lastGoodRevisionsCount: lastGoodCount,
          recoveryEventsCount: recCountReq.result || 0,
        });
      };

      tx.onerror = () => reject(tx.error || new Error('Failed to get archive summary'));
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
}

