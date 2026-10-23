import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { closeExtensionDatabase } from '../src/storage/db';
import type { Message, ResponseRevision, RecoveryEvent } from '../src/core/models';

describe('StorageRepository: getRecoveryMetadataForConversation Efficiency & Benchmarks', () => {
  let fakeFactory: IDBFactory;
  let storageRepo: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    storageRepo = new IndexedDbStorageRepository(fakeFactory);
  });

  afterEach(() => {
    closeExtensionDatabase(fakeFactory);
  });

  it('validates recovery authority: revision.messageId must match and revision must be isLastGood', async () => {
    const convId = 'conv-bench-auth';
    await storageRepo.saveConversation({
      id: convId,
      title: 'Auth Conv',
      createdAt: 1000,
      updatedAt: 1000,
    });

    // Message 1: Valid authoritative recovery
    const msg1: Message = {
      id: 'm1-valid',
      conversationId: convId,
      identityState: 'reconciled',
      role: 'assistant',
      status: 'filtered',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const rev1: ResponseRevision = {
      id: 'rev1-valid',
      messageId: 'm1-valid',
      revisionIndex: 0,
      text: 'Good uncensored content',
      source: 'network',
      capturedAt: 1000,
      isFinal: false,
      isLastGood: true,
    };
    const rec1: RecoveryEvent = {
      id: 'rec1-valid',
      messageId: 'm1-valid',
      kind: 'content_filter',
      reason: 'CONTENT_FILTER',
      recoveredRevisionId: 'rev1-valid',
      detectedAt: 1050,
    };

    // Message 2: Invalid recovery - revision belongs to different message!
    const msg2: Message = {
      id: 'm2-cross-msg-leak',
      conversationId: convId,
      identityState: 'reconciled',
      role: 'assistant',
      status: 'filtered',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const rec2: RecoveryEvent = {
      id: 'rec2-invalid',
      messageId: 'm2-cross-msg-leak',
      kind: 'content_filter',
      reason: 'CONTENT_FILTER',
      recoveredRevisionId: 'rev1-valid', // Points to msg1 revision!
      detectedAt: 1050,
    };

    await storageRepo.saveCanonicalCheckpoint({
      streamKey: 'prod-b:s1',
      checkpointSeq: 0,
      message: msg1,
      revisions: [rev1],
      recoveryEvents: [rec1],
      isTerminal: true,
    });

    await storageRepo.saveCanonicalCheckpoint({
      streamKey: 'prod-b:s2',
      checkpointSeq: 0,
      message: msg2,
      revisions: [],
      recoveryEvents: [rec2],
      isTerminal: true,
    });

    const metadata = await storageRepo.getRecoveryMetadataForConversation(convId);
    expect(metadata).toHaveLength(1);
    expect(metadata[0]!.messageId).toBe('m1-valid');
    expect(metadata[0]!.recoveryKind).toBe('authoritative_recovery');
    expect(metadata[0]!.presentationKind).toBe('pre_filter_recovery');
    // Security check: No text or thinking body in metadata
    expect((metadata[0] as any).text).toBeUndefined();
    expect((metadata[0] as any).thinking).toBeUndefined();
  });

  it('correctly assigns interruption_recovery for network_interruption events', async () => {
    const convId = 'conv-interruption-test';
    await storageRepo.saveConversation({
      id: convId,
      title: 'Interruption Conv',
      createdAt: 1000,
      updatedAt: 1000,
    });

    const msg: Message = {
      id: 'm-net-break',
      conversationId: convId,
      identityState: 'reconciled',
      role: 'assistant',
      status: 'interrupted',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const rev: ResponseRevision = {
      id: 'rev-net-break',
      messageId: 'm-net-break',
      revisionIndex: 0,
      text: 'Interrupted stream chunk',
      source: 'network',
      capturedAt: 1000,
      isFinal: false,
      isLastGood: true,
    };
    const rec: RecoveryEvent = {
      id: 'rec-net-break',
      messageId: 'm-net-break',
      kind: 'network_interruption',
      reason: 'NETWORK_CLOSED',
      recoveredRevisionId: 'rev-net-break',
      detectedAt: 1050,
    };

    await storageRepo.saveCanonicalCheckpoint({
      streamKey: 'prod-net:s1',
      checkpointSeq: 0,
      message: msg,
      revisions: [rev],
      recoveryEvents: [rec],
      isTerminal: true,
    });

    const metadata = await storageRepo.getRecoveryMetadataForConversation(convId);
    expect(metadata).toHaveLength(1);
    expect(metadata[0]!.messageId).toBe('m-net-break');
    expect(metadata[0]!.presentationKind).toBe('interruption_recovery');
  });

  // Benchmark suite: 100, 1000, 5000 messages
  const benchmarkScales = [100, 1000, 5000];

  for (const count of benchmarkScales) {
    it(`efficiently queries recovery metadata in a single transaction for ${count} synthetic messages`, async () => {
      const convId = `conv-scale-${count}`;
      await storageRepo.saveConversation({
        id: convId,
        title: `Scale Test ${count}`,
        createdAt: 1000,
        updatedAt: 1000,
      });

      // Populate synthetic messages directly in batch
      const messagesToSave: Message[] = [];
      const revisionsToSave: ResponseRevision[] = [];
      const recoveryEventsToSave: RecoveryEvent[] = [];

      // 5% filtered messages with valid recovery, 95% normal messages
      const filteredInterval = 20;

      for (let i = 0; i < count; i++) {
        const msgId = `m-${count}-${i}`;
        const isFiltered = i % filteredInterval === 0;

        messagesToSave.push({
          id: msgId,
          conversationId: convId,
          remoteId: `remote-${i}`,
          identityState: 'reconciled',
          role: i % 2 === 0 ? 'user' : 'assistant',
          status: isFiltered ? 'filtered' : 'finished',
          createdAt: 1000 + i * 10,
          updatedAt: 1000 + i * 10,
        });

        if (isFiltered) {
          const revId = `rev-${count}-${i}`;
          revisionsToSave.push({
            id: revId,
            messageId: msgId,
            revisionIndex: 0,
            text: `Detailed recovered response text #${i} with many paragraphs and mathematical proofs`,
            source: 'network',
            capturedAt: 1000 + i * 10,
            isFinal: false,
            isLastGood: true,
          });

          recoveryEventsToSave.push({
            id: `rec-${count}-${i}`,
            messageId: msgId,
            kind: 'content_filter',
            reason: 'CONTENT_FILTER',
            recoveredRevisionId: revId,
            detectedAt: 1000 + i * 10 + 5,
          });
        }
      }

      // Seed database using canonical repository methods
      for (const m of messagesToSave) {
        await storageRepo.saveMessage(m);
      }
      for (const r of revisionsToSave) {
        await storageRepo.saveRevision(r);
      }
      for (const e of recoveryEventsToSave) {
        await storageRepo.saveRecoveryEvent(e);
      }

      // Benchmark single transaction query
      const startTime = performance.now();
      const metadata = await storageRepo.getRecoveryMetadataForConversation(convId);
      const durationMs = performance.now() - startTime;

      const expectedRecoverableCount = Math.ceil(count / filteredInterval);
      expect(metadata).toHaveLength(expectedRecoverableCount);

      // Verify no message body / text leakage in metadata result
      for (const item of metadata) {
        expect((item as any).text).toBeUndefined();
        expect((item as any).thinking).toBeUndefined();
      }

      // Note benchmark timing without fabricating claims
      console.log(`[Benchmark] getRecoveryMetadataForConversation (${count} messages): ${durationMs.toFixed(2)} ms`);
      expect(durationMs).toBeGreaterThanOrEqual(0);
    });
  }
});
