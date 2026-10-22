import {
  STORE_RAW_STREAMS,
  STORE_RAW_STREAM_BATCHES,
} from '../schema';
import { openExtensionDatabase, createRawWriteTransaction } from '../db';
import type {
  RawStreamRecord,
  RawStreamBatch,
  StoredRawStreamBatch,
  RawStreamState,
  RawStreamIntegrity,
  RawJournalMetadata,
} from './types';

function isBatchPayloadIdentical(a: RawStreamBatch, b: RawStreamBatch): boolean {
  if (a.id !== b.id || a.streamKey !== b.streamKey || a.batchSeq !== b.batchSeq) return false;
  if (a.createdAt !== b.createdAt) return false;
  if (a.charCount !== b.charCount || a.chunks.length !== b.chunks.length) return false;
  for (let i = 0; i < a.chunks.length; i++) {
    const chunkA = a.chunks[i];
    const chunkB = b.chunks[i];
    if (!chunkA || !chunkB) return false;
    if (
      chunkA.streamSequence !== chunkB.streamSequence ||
      chunkA.chunkText !== chunkB.chunkText ||
      chunkA.timestamp !== chunkB.timestamp
    ) {
      return false;
    }
  }
  return true;
}

export class RawStreamRepository {
  constructor(private readonly idbFactory?: IDBFactory) {}

  private async getDb(): Promise<IDBDatabase> {
    return openExtensionDatabase(this.idbFactory);
  }

  /**
   * Open or register a new raw stream session. Idempotent if stream already exists with matching identity.
   * Rejects with 'stream_identity_conflict' if existing stream identity differs.
   */
  async openStream(params: {
    producerSessionId: string;
    streamId: string;
    transport: 'fetch' | 'xhr';
    url: string;
    method?: string;
    provisionalSessionId?: string;
    captureProfileId?: string;
    openedAt?: number;
    streamSequence?: number;
    integrity?: RawStreamIntegrity;
  }): Promise<RawStreamRecord> {
    const db = await this.getDb();
    if (params.producerSessionId.includes(':') || params.streamId.includes(':')) {
      const err: any = new Error(`Invalid stream identity: IDs must not contain ':'`);
      err.code = 'invalid_stream_identity';
      throw err;
    }
    const streamKey = `${params.producerSessionId}:${params.streamId}`;
    const openedAt = params.openedAt || Date.now();

    return new Promise((resolve, reject) => {
      const tx = createRawWriteTransaction(db, [STORE_RAW_STREAMS], 'strict');
      const store = tx.objectStore(STORE_RAW_STREAMS);
      const getReq = store.get(streamKey);

      let resultRecord: RawStreamRecord;

      getReq.onsuccess = () => {
        const existing = getReq.result as RawStreamRecord | undefined;
        if (existing) {
          const expectedMethod = params.method || 'POST';
          const existingMethod = existing.method || 'POST';

          // Verify immutable identity fields match
          const isImmutableMatch =
            existing.producerSessionId === params.producerSessionId &&
            existing.streamId === params.streamId &&
            existing.transport === params.transport &&
            existing.url === params.url &&
            existingMethod === expectedMethod &&
            (params.openedAt === undefined || existing.openedAt === params.openedAt);

          if (!isImmutableMatch) {
            const err: any = new Error(`Stream identity conflict for stream ${streamKey}`);
            err.code = 'stream_identity_conflict';
            try {
              tx.abort();
            } catch {
              // ignore
            }
            reject(err);
            return;
          }

          // Conflict checks for optional enrichment metadata:
          // If existing is absent, enrichment is allowed.
          // If both exist and differ, reject with stream_identity_conflict.
          if (
            params.provisionalSessionId !== undefined &&
            existing.provisionalSessionId !== undefined &&
            existing.provisionalSessionId !== params.provisionalSessionId
          ) {
            const err: any = new Error(
              `Stream metadata conflict for provisionalSessionId on ${streamKey}: '${existing.provisionalSessionId}' vs '${params.provisionalSessionId}'`
            );
            err.code = 'stream_identity_conflict';
            try {
              tx.abort();
            } catch {
              // ignore
            }
            reject(err);
            return;
          }

          if (
            params.captureProfileId !== undefined &&
            existing.captureProfileId !== undefined &&
            existing.captureProfileId !== params.captureProfileId
          ) {
            const err: any = new Error(
              `Stream metadata conflict for captureProfileId on ${streamKey}: '${existing.captureProfileId}' vs '${params.captureProfileId}'`
            );
            err.code = 'stream_identity_conflict';
            try {
              tx.abort();
            } catch {
              // ignore
            }
            reject(err);
            return;
          }

          resultRecord = existing;
          let needsUpdate = false;
          if (params.provisionalSessionId && !resultRecord.provisionalSessionId) {
            resultRecord.provisionalSessionId = params.provisionalSessionId;
            needsUpdate = true;
          }
          if (params.captureProfileId && !resultRecord.captureProfileId) {
            resultRecord.captureProfileId = params.captureProfileId;
            needsUpdate = true;
          }
          if (needsUpdate) {
            store.put(resultRecord);
          }
        } else {
          const isSequenceGap = params.streamSequence !== undefined && params.streamSequence !== 0;

          resultRecord = {
            id: streamKey,
            producerSessionId: params.producerSessionId,
            streamId: params.streamId,
            transport: params.transport,
            url: params.url,
            method: params.method || 'POST',
            provisionalSessionId: params.provisionalSessionId,
            captureProfileId: params.captureProfileId,
            state: isSequenceGap ? 'degraded' : 'active',
            openedAt,
            updatedAt: openedAt,
            totalChunks: 0,
            totalChars: 0,
            totalBatches: 0,
            lastPersistedBatchSeq: 0,
            lastPersistedStreamSequence: 0,
            integrity: isSequenceGap ? 'gap_detected' : params.integrity || 'intact',
            durabilityGap: isSequenceGap ? true : undefined,
          };
          store.put(resultRecord);
        }
      };

      getReq.onerror = () => reject(getReq.error || new Error('Failed to query existing stream'));
      tx.oncomplete = () => resolve(resultRecord);
      tx.onerror = () => reject(tx.error || new Error('Failed to open stream record'));
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted on open stream'));
    });
  }

  /**
   * Persist a batch of chunks atomically with strict tx.oncomplete ACK.
   * If stream does not exist, rejects with 'stream_not_open' (never synthesizes placeholder streams).
   * If batch already exists with identical payload, returns idempotent ACK without counter inflation.
   * If batch exists with conflicting payload, rejects with 'batch_id_conflict' and marks stream degraded.
   * Enforces strictly monotonic batchSeq: skips rejected with 'batch_sequence_gap'.
   * Forensically captures observed chunks even when chunk sequence gap is detected.
   */
  async persistBatch(
    batch: RawStreamBatch
  ): Promise<{ success: boolean; batchSeq: number; persistedAt: number }> {
    const db = await this.getDb();
    const now = Date.now();

    return new Promise((resolve, reject) => {
      let abortError: any = null;
      const tx = createRawWriteTransaction(db, [STORE_RAW_STREAMS, STORE_RAW_STREAM_BATCHES], 'strict');
      const batchStore = tx.objectStore(STORE_RAW_STREAM_BATCHES);
      const streamStore = tx.objectStore(STORE_RAW_STREAMS);

      let persistedAtResult = now;

      // 1. Verify stream exists
      const streamReq = streamStore.get(batch.streamKey);

      streamReq.onsuccess = () => {
        const stream = streamReq.result as RawStreamRecord | undefined;
        if (!stream) {
          const err: any = new Error(`Stream not open: ${batch.streamKey}`);
          err.code = 'stream_not_open';
          abortError = err;
          try {
            tx.abort();
          } catch {
            // ignore
          }
          reject(err);
          return;
        }

        // 2. Check batch existence for idempotency / conflict
        const checkReq = batchStore.get(batch.id);

        checkReq.onsuccess = () => {
          const existing = checkReq.result as StoredRawStreamBatch | undefined;
          if (existing) {
            if (isBatchPayloadIdentical(existing, batch)) {
              // Exact identical re-delivery: idempotent ACK without modifying DB or counters
              persistedAtResult = existing.persistedAt || existing.createdAt;
              return;
            }

            // Conflicting batch with identical batch ID: reject and degrade stream
            const err: any = new Error(`Batch ID conflict: batch ${batch.id} already exists with different payload`);
            err.code = 'batch_id_conflict';
            abortError = err;
            try {
              tx.abort();
            } catch {
              // ignore
            }

            // Persist stream degradation in separate transaction so abort does not roll it back
            const degTx = createRawWriteTransaction(db, [STORE_RAW_STREAMS], 'strict');
            const degStore = degTx.objectStore(STORE_RAW_STREAMS);
            const degGet = degStore.get(batch.streamKey);
            degGet.onsuccess = () => {
              const st = degGet.result as RawStreamRecord | undefined;
              if (st) {
                st.state = 'degraded';
                st.durabilityGap = true;
                st.integrity = 'corrupt';
                st.error = `Batch ID conflict detected on batch ${batch.id}`;
                degStore.put(st);
              }
            };
            degTx.oncomplete = () => reject(err);
            degTx.onerror = () => reject(err);
            degTx.onabort = () => reject(err);
            return;
          }

          // 3. New batch: verify strictly monotonic batchSeq
          const expectedBatchSeq = (stream.lastPersistedBatchSeq || 0) + 1;
          if (batch.batchSeq !== expectedBatchSeq) {
            const err: any = new Error(
              `Batch sequence gap: expected batch #${expectedBatchSeq}, got #${batch.batchSeq}`
            );
            err.code = 'batch_sequence_gap';
            abortError = err;
            try {
              tx.abort();
            } catch {
              // ignore
            }

            // Mark stream degraded in separate transaction so abort does not roll it back
            const degTx = createRawWriteTransaction(db, [STORE_RAW_STREAMS], 'strict');
            const degStore = degTx.objectStore(STORE_RAW_STREAMS);
            const degGet = degStore.get(batch.streamKey);
            degGet.onsuccess = () => {
              const st = degGet.result as RawStreamRecord | undefined;
              if (st) {
                st.state = 'degraded';
                st.durabilityGap = true;
                st.integrity = 'gap_detected';
                st.error = `Batch sequence gap detected on batch ${batch.id}: expected #${expectedBatchSeq}, got #${batch.batchSeq}`;
                degStore.put(st);
              }
            };
            degTx.oncomplete = () => reject(err);
            degTx.onerror = () => reject(err);
            degTx.onabort = () => reject(err);
            return;
          }

          // 4. Verify chunk sequences for gaps
          if (!batch.chunks || batch.chunks.length === 0) {
            const err: any = new Error(`Batch contains no chunks`);
            err.code = 'invalid_batch';
            abortError = err;
            try {
              tx.abort();
            } catch {
              // ignore
            }
            reject(err);
            return;
          }

          const firstChunk = batch.chunks[0];
          const lastChunk = batch.chunks[batch.chunks.length - 1];
          if (!firstChunk || !lastChunk) {
            const err: any = new Error(`Batch contains invalid chunks`);
            err.code = 'invalid_batch';
            abortError = err;
            try {
              tx.abort();
            } catch {
              // ignore
            }
            reject(err);
            return;
          }

          const expectedFirstChunkSeq = batch.batchSeq === 1 ? 1 : (stream.lastPersistedStreamSequence || 0) + 1;
          let chunkGapDetected = false;
          if (firstChunk.streamSequence !== expectedFirstChunkSeq) {
            chunkGapDetected = true;
          }
          for (let i = 1; i < batch.chunks.length; i++) {
            const prev = batch.chunks[i - 1];
            const curr = batch.chunks[i];
            if (prev && curr && curr.streamSequence !== prev.streamSequence + 1) {
              chunkGapDetected = true;
              break;
            }
          }

          if (chunkGapDetected) {
            stream.integrity = 'gap_detected';
            stream.durabilityGap = true;
            stream.state = 'degraded';
            if (!stream.error) {
              stream.error = `Chunk sequence gap detected in batch ${batch.id}`;
            }
          }

          // Forensic preservation: persist observed chunks even if sequence gap detected
          const storedBatch: StoredRawStreamBatch = {
            ...batch,
            persistedAt: now,
          };
          batchStore.put(storedBatch);

          stream.lastPersistedBatchSeq = batch.batchSeq;
          stream.lastPersistedStreamSequence = lastChunk.streamSequence;
          stream.lastPersistedAt = now;
          stream.updatedAt = Math.max(stream.updatedAt, batch.createdAt, now);
          stream.lastBatchAt = Math.max(stream.lastBatchAt || 0, batch.createdAt);
          stream.totalChunks += batch.chunks.length;
          stream.totalChars += batch.charCount;
          stream.totalBatches += 1;
          streamStore.put(stream);
        };

        checkReq.onerror = () => reject(checkReq.error || new Error('Failed to verify batch idempotency'));
      };

      streamReq.onerror = () => reject(streamReq.error || new Error('Failed to query stream for batch'));

      // Strict durability guarantee: ACK only on IndexedDB commit
      tx.oncomplete = () => {
        resolve({
          success: true,
          batchSeq: batch.batchSeq,
          persistedAt: persistedAtResult,
        });
      };

      tx.onerror = () => reject(tx.error || new Error('Batch transaction failed'));
      tx.onabort = () => reject(abortError || tx.error || new Error('Batch transaction aborted'));
    });
  }

  /**
   * Finalize a stream session with terminal state. Idempotent if matching metadata already finalized.
   * Rejects with 'finalize_conflict' if stream already finalized with conflicting metadata.
   * If stream does not exist, rejects with 'stream_not_open' (never synthesizes stub stream records).
   */
  async finalizeStream(
    streamKey: string,
    finalState: RawStreamState,
    terminalReason?: string,
    error?: string,
    droppedChars?: number,
    durabilityGap?: boolean,
    integrity?: RawStreamIntegrity
  ): Promise<{ success: boolean; finalizedAt: number; finalState: RawStreamState }> {
    const db = await this.getDb();
    const now = Date.now();

    return new Promise((resolve, reject) => {
      let abortError: any = null;
      const tx = createRawWriteTransaction(db, [STORE_RAW_STREAMS], 'strict');
      const store = tx.objectStore(STORE_RAW_STREAMS);
      const req = store.get(streamKey);

      let returnFinalizedAt = now;
      let returnFinalState = finalState;

      req.onsuccess = () => {
        const stream = req.result as RawStreamRecord | undefined;
        if (!stream) {
          const err: any = new Error(`Stream not open for finalization: ${streamKey}`);
          err.code = 'stream_not_open';
          abortError = err;
          try {
            tx.abort();
          } catch {
            // ignore
          }
          reject(err);
          return;
        }

        // Check if stream is already finalized
        if (stream.finalizedAt !== undefined) {
          const isIdentical =
            stream.state === finalState &&
            (stream.terminalReason || undefined) === (terminalReason || undefined) &&
            (stream.error || undefined) === (error || undefined) &&
            (stream.droppedChars || 0) === (droppedChars || 0) &&
            (stream.durabilityGap || false) === (durabilityGap || false) &&
            (integrity === undefined || (stream.integrity || 'intact') === integrity);

          if (isIdentical) {
            // Idempotent re-delivery: return original committed state & timestamp without mutating DB
            returnFinalizedAt = stream.finalizedAt;
            returnFinalState = stream.state;
            return;
          }

          // Conflicting terminal metadata on already-finalized stream
          const err: any = new Error(
            `Finalize conflict for stream ${streamKey}: already finalized with conflicting metadata`
          );
          err.code = 'finalize_conflict';
          abortError = err;
          try {
            tx.abort();
          } catch {
            // ignore
          }
          reject(err);
          return;
        }

        // Finalize for the first time
        stream.state = finalState;
        stream.finalizedAt = now;
        stream.updatedAt = now;
        if (terminalReason !== undefined) stream.terminalReason = terminalReason;
        if (error !== undefined) stream.error = error;
        if (droppedChars !== undefined && droppedChars >= 0) {
          stream.droppedChars = droppedChars; // ABSOLUTE TOTAL, NOT ADDITIVE!
        }
        if (durabilityGap !== undefined) {
          stream.durabilityGap = stream.durabilityGap || durabilityGap;
        }
        if (integrity !== undefined) {
          stream.integrity = integrity;
        } else if (durabilityGap || finalState === 'degraded') {
          if (stream.integrity !== 'corrupt') {
            stream.integrity = 'gap_detected';
          }
        }
        returnFinalizedAt = now;
        returnFinalState = stream.state;
        store.put(stream);
      };

      req.onerror = () => reject(req.error || new Error('Failed to get stream for finalization'));
      tx.oncomplete = () => {
        resolve({
          success: true,
          finalizedAt: returnFinalizedAt,
          finalState: returnFinalState,
        });
      };
      tx.onerror = () => reject(tx.error || new Error('Finalization transaction failed'));
      tx.onabort = () => reject(abortError || tx.error || new Error('Finalization transaction aborted'));
    });
  }

  async getStream(streamKey: string): Promise<RawStreamRecord | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_RAW_STREAMS, 'readonly');
      const store = tx.objectStore(STORE_RAW_STREAMS);
      const req = store.get(streamKey);
      req.onsuccess = () => resolve((req.result as RawStreamRecord) || null);
      req.onerror = () => reject(req.error || new Error('Failed to get stream record'));
    });
  }

  /**
   * List streams in reverse chronological order using cursor on 'openedAt' index.
   * Does NOT load all records into memory or call sort().
   */
  async listStreams(limit = 100): Promise<RawStreamRecord[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_RAW_STREAMS, 'readonly');
      const store = tx.objectStore(STORE_RAW_STREAMS);
      const index = store.index('openedAt');
      const req = index.openCursor(null, 'prev');
      const results: RawStreamRecord[] = [];

      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value as RawStreamRecord);
          cursor.continue();
        } else {
          resolve(results);
        }
      };

      req.onerror = () => reject(req.error || new Error('Failed to list streams'));
    });
  }

  async listBatchesForStream(streamKey: string): Promise<StoredRawStreamBatch[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_RAW_STREAM_BATCHES, 'readonly');
      const store = tx.objectStore(STORE_RAW_STREAM_BATCHES);
      const index = store.index('streamKey');
      const req = index.getAll(streamKey);

      req.onsuccess = () => {
        const batches = (req.result as StoredRawStreamBatch[]) || [];
        batches.sort((a, b) => a.batchSeq - b.batchSeq);
        resolve(batches);
      };

      req.onerror = () => reject(req.error || new Error('Failed to list batches for stream'));
    });
  }

  /**
   * Scales safely: aggregates stream counts and totals exclusively from STORE_RAW_STREAMS metadata.
   * NEVER calls STORE_RAW_STREAM_BATCHES.getAll(), protecting SW memory from large batch payloads.
   * Includes storage quota estimates and persistence grant status.
   */
  async getJournalMetadata(): Promise<RawJournalMetadata> {
    const db = await this.getDb();
    const storageEstimates = await this.queryStorageEstimates();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_RAW_STREAMS, 'readonly');
      const store = tx.objectStore(STORE_RAW_STREAMS);
      const req = store.getAll();

      req.onsuccess = () => {
        const streams = (req.result as RawStreamRecord[]) || [];
        const streamCount = streams.length;
        let activeStreamCount = 0;
        let totalBatchesCount = 0;
        let totalCharsCount = 0;
        let lastPersistedAt: number | undefined = undefined;

        for (const s of streams) {
          if (s.state === 'active') activeStreamCount++;
          totalBatchesCount += s.totalBatches || 0;
          totalCharsCount += s.totalChars || 0;
          if (s.lastPersistedAt && (!lastPersistedAt || s.lastPersistedAt > lastPersistedAt)) {
            lastPersistedAt = s.lastPersistedAt;
          }
        }

        resolve({
          streamCount,
          activeStreamCount,
          totalBatchesCount,
          totalCharsCount,
          lastPersistedAt,
          estimatedUsage: storageEstimates.usage,
          estimatedQuota: storageEstimates.quota,
          storagePersistence: storageEstimates.persistence,
        });
      };

      req.onerror = () => reject(req.error || new Error('Failed to query journal metadata'));
    });
  }

  private async queryStorageEstimates(): Promise<{
    usage?: number;
    quota?: number;
    persistence: 'granted' | 'not_granted' | 'unsupported' | 'unknown';
  }> {
    let usage: number | undefined;
    let quota: number | undefined;
    let persistence: 'granted' | 'not_granted' | 'unsupported' | 'unknown' = 'unknown';

    if (typeof navigator !== 'undefined' && navigator.storage) {
      if (typeof navigator.storage.estimate === 'function') {
        try {
          const est = await navigator.storage.estimate();
          usage = est.usage;
          quota = est.quota;
        } catch {
          // ignore
        }
      }

      if (typeof navigator.storage.persisted === 'function') {
        try {
          const isPersisted = await navigator.storage.persisted();
          persistence = isPersisted ? 'granted' : 'not_granted';
        } catch {
          persistence = 'unknown';
        }
      } else {
        persistence = 'unsupported';
      }
    } else {
      persistence = 'unsupported';
    }

    return { usage, quota, persistence };
  }
}
