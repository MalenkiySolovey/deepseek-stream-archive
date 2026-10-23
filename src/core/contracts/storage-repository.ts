import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../models';
import type { HistoryStagingBatchRecord } from '../../storage/schema';

export interface ArchiveSummary {
  conversationsCount: number;
  messagesCount: number;
  provisionalMessagesCount: number;
  reconciledMessagesCount: number;
  revisionsCount: number;
  lastGoodRevisionsCount: number;
  recoveryEventsCount: number;
}

export interface CanonicalCheckpointData {
  streamKey: string;
  checkpointSeq: number;
  isTerminal?: boolean;
  isFinal?: boolean;
  conversation?: Conversation;
  message: Message;
  revisions: ResponseRevision[];
  recoveryEvents?: RecoveryEvent[];
}

export interface HistoryReconciliationPlan {
  conversation: Conversation;
  messagesToPut: Message[];
  revisionsToPut: ResponseRevision[];
  treeLinksResolved: number;
  diagnostics?: string[];
}

export interface ReplayPromotionPlan {
  conversation: Conversation;
  message: Message;
  revisions: ResponseRevision[];
  recoveryEvents: RecoveryEvent[];
}

export interface ArchiveConversationSummary {
  id: string;
  remoteId?: string;
  title: string;
  messageCount: number;
  recoveredCount: number;
  hasDegraded: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ArchiveRevisionMetadata {
  id: string;
  messageId: string;
  revisionIndex: number;
  source: import('../models').CaptureSource;
  capturedAt: number;
  isFinal: boolean;
  isLastGood: boolean;
  textLength: number;
  thinkingLength: number;
  contentFingerprint?: string;
}

export interface ArchiveMessageSummary {
  id: string;
  remoteId?: string;
  conversationId: string;
  parentId?: string;
  remoteParentId?: string;
  sourceRawStreamKey?: string;
  identityState: import('../models').MessageIdentityState;
  role: import('../models').MessageRole;
  status: import('../models').MessageStatus;
  content?: string;
  createdAt: number;
  updatedAt: number;
  revisions: ArchiveRevisionMetadata[];
  recoveryEvents: RecoveryEvent[];
  preferredRevision?: ResponseRevision;
}

export interface ArchiveConversationDetail {
  conversation: Conversation;
  messages: ArchiveMessageSummary[];
}

export interface PaginatedArchiveConversations {
  items: ArchiveConversationSummary[];
  nextCursor?: string;
  totalCount: number;
}

export interface StorageRepository {
  // Conversation operations
  saveConversation(conversation: Conversation): Promise<void>;
  getConversation(id: string): Promise<Conversation | null>;
  getConversationByRemoteId(remoteId: string): Promise<Conversation | null>;
  listConversations(): Promise<Conversation[]>;

  // Message operations
  saveMessage(message: Message): Promise<void>;
  saveMessages(messages: Message[]): Promise<void>;
  getMessage(id: string): Promise<Message | null>;
  getMessageByRemoteId(conversationId: string, remoteId: string): Promise<Message | null>;
  findMessageByRemoteId(remoteId: string): Promise<Message | null>;
  listMessagesByConversation(conversationId: string): Promise<Message[]>;

  // Revision operations
  saveRevision(revision: ResponseRevision): Promise<void>;
  saveRevisions(revisions: ResponseRevision[]): Promise<void>;
  getRevision(id: string): Promise<ResponseRevision | null>;
  listRevisionsByMessage(messageId: string): Promise<ResponseRevision[]>;
  getLastGoodRevision(messageId: string): Promise<ResponseRevision | null>;

  // Recovery event operations
  saveRecoveryEvent(event: RecoveryEvent): Promise<void>;
  getRecoveryEvent(id: string): Promise<RecoveryEvent | null>;
  listRecoveryEvents(messageId?: string): Promise<RecoveryEvent[]>;

  // Atomic checkpoint, reconciliation & replay promotion operations
  saveCanonicalCheckpoint(data: CanonicalCheckpointData): Promise<void>;
  getCanonicalCheckpoint(streamKey: string): Promise<import('../../storage/schema').CanonicalStreamCheckpointRecord | null>;
  applyHistoryReconciliationPlan(plan: HistoryReconciliationPlan): Promise<void>;
  applyReplayPromotionPlan(plan: ReplayPromotionPlan): Promise<void>;

  // History Staging operations
  saveHistoryStagingManifest(manifest: import('../../storage/schema').HistoryStagingManifestRecord): Promise<void>;
  getHistoryStagingManifest(stagingId: string): Promise<import('../../storage/schema').HistoryStagingManifestRecord | null>;
  saveHistoryStagingBatch(batch: HistoryStagingBatchRecord): Promise<void>;
  listHistoryStagingBatches(stagingId: string): Promise<HistoryStagingBatchRecord[]>;
  commitHistoryStagingPlan(stagingId: string, plan: HistoryReconciliationPlan): Promise<void>;
  clearHistoryStaging(stagingId: string): Promise<void>;
  cleanupStaleHistoryStaging(ttlMs?: number): Promise<number>;

  // Read-only Archive Browser queries
  listArchiveConversations(options?: { limit?: number; cursor?: string }): Promise<PaginatedArchiveConversations>;
  getArchiveConversation(id: string): Promise<ArchiveConversationDetail | null>;
  listArchiveMessages(conversationId: string): Promise<ArchiveMessageSummary[]>;
  getRevisionContent(id: string): Promise<{ text: string; thinking?: string } | null>;
  getRecoveryMetadataForConversation(conversationId: string): Promise<import('../../adapters/deepseek/dom/types').PageRecoveryMessageSummary[]>;

  // Diagnostic & Metrics operations
  getArchiveSummary(): Promise<ArchiveSummary>;
}

