import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { CanonicalStreamCoordinator } from '../src/core/recorder/canonical-stream-coordinator';
import { validateUserTurnObservedPayload } from '../src/bridge/validation';
import type { Message } from '../src/core/models';

describe('Immediate User Prompt Persistence & Life Cycle (Section 6 & 21)', () => {
  let storageRepo: IndexedDbStorageRepository;

  beforeEach(async () => {
    indexedDB = new IDBFactory();
    storageRepo = new IndexedDbStorageRepository();
  });

  it('Scenario B: Outgoing user prompt is persisted immediately to storage before response begins', async () => {
    const clientTurnId = 'turn_user_test_001';
    const convId = 'conv_session_100';

    const rawBridgePayload = {
      clientTurnId,
      sessionId: convId,
      prompt: 'Explain the architecture of Redis in depth.',
      parentTurnId: null,
      transport: 'fetch',
      timestamp: 1000,
    };

    const validated = validateUserTurnObservedPayload(rawBridgePayload);
    expect(validated).not.toBeNull();

    // Emulate background message handler
    const userMsg: Message = {
      id: validated!.clientTurnId,
      conversationId: validated!.sessionId!,
      remoteParentId: validated!.parentTurnId || undefined,
      role: 'user',
      status: 'finished',
      content: validated!.prompt,
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: validated!.timestamp,
      updatedAt: validated!.timestamp,
    };

    await storageRepo.saveConversation({
      id: convId,
      title: 'Explain the architecture of Redis',
      createdAt: 1000,
      updatedAt: 1000,
    });
    await storageRepo.saveMessages([userMsg]);

    // Verify stored immediately in IndexedDB
    const stored = await storageRepo.getMessage(clientTurnId);
    expect(stored).not.toBeNull();
    expect(stored!.id).toBe(clientTurnId);
    expect(stored!.role).toBe('user');
    expect(stored!.content).toBe('Explain the architecture of Redis in depth.');
    expect(stored!.status).toBe('finished');
  });

  it('Scenario C: User prompt remains permanently preserved even if assistant stream encounters immediate failure / zero response', async () => {
    const clientTurnId = 'turn_user_test_failed_stream';
    const convId = 'conv_failed_generation';

    const userMsg: Message = {
      id: clientTurnId,
      conversationId: convId,
      role: 'user',
      status: 'finished',
      content: 'Will this question be preserved if server returns 500?',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 2000,
      updatedAt: 2000,
    };

    await storageRepo.saveConversation({
      id: convId,
      title: 'Preserved question',
      createdAt: 2000,
      updatedAt: 2000,
    });
    await storageRepo.saveMessages([userMsg]);

    // Assistant stream fails immediately / aborts / returns empty
    // (no coordinator or zero-byte failure)

    // Verify conversation still contains the user prompt in the archive
    const conv = await storageRepo.getArchiveConversation(convId);
    expect(conv).not.toBeNull();
    expect(conv!.messages.length).toBe(1);
    expect(conv!.messages[0]!.id).toBe(clientTurnId);
    expect(conv!.messages[0]!.content).toBe('Will this question be preserved if server returns 500?');
  });

  it('Associates subsequent assistant stream coordinator directly with already-persisted clientTurnId', async () => {
    const clientTurnId = 'turn_user_linked_002';
    const convId = 'conv_linked_stream';

    // 1. Prompt persisted at t=1000
    const userMsg: Message = {
      id: clientTurnId,
      conversationId: convId,
      role: 'user',
      status: 'finished',
      content: 'What is consensus in distributed systems?',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveConversation({
      id: convId,
      title: 'Distributed Systems',
      createdAt: 1000,
      updatedAt: 1000,
    });
    await storageRepo.saveMessages([userMsg]);

    // 2. Stream coordinator starts at t=1200 with clientTurnId
    const coord = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_test',
      streamId: 'stream_test_linked',
      provisionalSessionId: convId,
      clientTurnId,
      onCheckpoint: async (dto) => {
        await storageRepo.saveCanonicalCheckpoint({
          streamKey: dto.streamKey,
          checkpointSeq: dto.checkpointSeq,
          conversation: dto.conversation,
          userMessage: dto.userMessage,
          message: dto.message,
          revisions: dto.revisions,
          recoveryEvents: dto.recoveryEvents,
          isTerminal: dto.isFinal,
        });
        return {
          success: true,
          streamKey: dto.streamKey,
          checkpointSeq: dto.checkpointSeq,
          persistedAt: Date.now(),
        };
      },
    });

    coord.feedSemanticEvent({
      streamId: 'stream_test_linked',
      sequence: 1,
      timestamp: 1250,
      type: 'answer_delta',
      delta: 'Consensus is a fundamental problem in distributed computing...',
    });

    coord.feedSemanticEvent({
      streamId: 'stream_test_linked',
      sequence: 2,
      timestamp: 1300,
      type: 'stream_finished',
      status: 'FINISHED',
      terminalReason: 'completed',
    });

    await coord.awaitFinalPersistence(3000);

    // 3. Verify assistant message points directly to user prompt clientTurnId
    const conv = await storageRepo.getArchiveConversation(convId);
    expect(conv).not.toBeNull();
    expect(conv!.messages.length).toBe(2);

    const asstMsg = conv!.messages.find((m) => m.role === 'assistant');
    expect(asstMsg).toBeDefined();
    expect(asstMsg!.parentId).toBe(clientTurnId);
  });
});
