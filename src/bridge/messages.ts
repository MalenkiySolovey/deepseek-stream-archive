import type { Conversation, Message, ResponseRevision } from '../core/models';
import type { TransportEvent } from '../transport/types';
import type { DeepSeekProtocolDiagnosticsData, DeepSeekSemanticBatch } from '../adapters/deepseek/protocol/types';
import type {
  RawStreamBatch,
  RawStreamState,
  RawJournalMetadata,
  RawStreamRecord,
} from '../storage/raw-journal/types';

export const MESSAGE_SAVE_SYNTHETIC_BATCH = 'STREAMARCHIVE_SAVE_SYNTHETIC_BATCH' as const;
export const MESSAGE_GET_FOUNDATION_STATUS = 'STREAMARCHIVE_GET_FOUNDATION_STATUS' as const;
export const MESSAGE_LIST_SYNTHETIC_REVISIONS = 'STREAMARCHIVE_LIST_SYNTHETIC_REVISIONS' as const;
export const MESSAGE_TRIGGER_DIAGNOSTIC_SYNTHETIC = 'STREAMARCHIVE_TRIGGER_DIAGNOSTIC_SYNTHETIC' as const;
export const MESSAGE_FORWARD_TRANSPORT_EVENT = 'STREAMARCHIVE_FORWARD_TRANSPORT_EVENT' as const;
export const MESSAGE_FORWARD_SEMANTIC_BATCH = 'STREAMARCHIVE_FORWARD_SEMANTIC_BATCH' as const;
export const MESSAGE_NOTIFY_BRIDGE_OBSERVED = 'STREAMARCHIVE_NOTIFY_BRIDGE_OBSERVED' as const;
export const MESSAGE_RECORD_PROTOCOL_OBSERVATION = 'STREAMARCHIVE_RECORD_PROTOCOL_OBSERVATION' as const;

export const MESSAGE_PERSIST_RAW_STREAM_OPEN = 'STREAMARCHIVE_PERSIST_RAW_STREAM_OPEN' as const;
export const MESSAGE_PERSIST_RAW_BATCH = 'STREAMARCHIVE_PERSIST_RAW_BATCH' as const;
export const MESSAGE_FINALIZE_RAW_STREAM = 'STREAMARCHIVE_FINALIZE_RAW_STREAM' as const;
export const MESSAGE_GET_RAW_JOURNAL_STATUS = 'STREAMARCHIVE_GET_RAW_JOURNAL_STATUS' as const;
export const MESSAGE_FORWARD_HISTORY_OBSERVATION = 'STREAMARCHIVE_FORWARD_HISTORY_OBSERVATION' as const;
export const MESSAGE_GET_ARCHIVE_SUMMARY = 'STREAMARCHIVE_GET_ARCHIVE_SUMMARY' as const;
export const MESSAGE_PERSIST_CANONICAL_CHECKPOINT = 'STREAMARCHIVE_PERSIST_CANONICAL_CHECKPOINT' as const;
export const MESSAGE_LIST_ARCHIVE_CONVERSATIONS = 'STREAMARCHIVE_LIST_ARCHIVE_CONVERSATIONS' as const;
export const MESSAGE_GET_ARCHIVE_CONVERSATION = 'STREAMARCHIVE_GET_ARCHIVE_CONVERSATION' as const;
export const MESSAGE_GET_REVISION_CONTENT = 'STREAMARCHIVE_GET_REVISION_CONTENT' as const;

export const MESSAGE_HISTORY_INGEST_OPEN = 'STREAMARCHIVE_HISTORY_INGEST_OPEN' as const;
export const MESSAGE_HISTORY_INGEST_BATCH = 'STREAMARCHIVE_HISTORY_INGEST_BATCH' as const;
export const MESSAGE_HISTORY_INGEST_COMMIT = 'STREAMARCHIVE_HISTORY_INGEST_COMMIT' as const;
export const MESSAGE_HISTORY_INGEST_ABORT = 'STREAMARCHIVE_HISTORY_INGEST_ABORT' as const;
export const MESSAGE_GET_PAGE_RECOVERY_SUMMARY = 'STREAMARCHIVE_GET_PAGE_RECOVERY_SUMMARY' as const;
export const MESSAGE_GET_PAGE_RECOVERY_CONTENT = 'STREAMARCHIVE_GET_PAGE_RECOVERY_CONTENT' as const;


export type ObservationState = 'not_observed' | 'observed' | 'failed' | 'unsupported';

export interface TransportDiagnostics {
  fetchStreamsCount: number;
  xhrStreamsCount: number;
  activeStreamsCount: number;
  sseEventsDecodedCount: number;
  transportErrorsCount: number;
  lastObservedAt?: number;
}

export interface SaveSyntheticBatchRequest {
  type: typeof MESSAGE_SAVE_SYNTHETIC_BATCH;
  batchSeq: number;
  data: {
    conversation: Conversation;
    message: Message;
    revision: ResponseRevision;
  };
}

export interface SaveSyntheticBatchResponse {
  success: boolean;
  batchSeq: number;
  persistedAt: number;
  error?: string;
}

export interface GetFoundationStatusRequest {
  type: typeof MESSAGE_GET_FOUNDATION_STATUS;
}

export interface FoundationStatusResponse {
  bridgeState: ObservationState;
  backgroundAlive: boolean;
  storageOperational: boolean;
  persistedCount: number;
  lastPersistedAt?: number;
  transport: TransportDiagnostics;
  protocol?: DeepSeekProtocolDiagnosticsData;
}

export interface ListSyntheticRevisionsRequest {
  type: typeof MESSAGE_LIST_SYNTHETIC_REVISIONS;
}

export interface ListSyntheticRevisionsResponse {
  conversations: Conversation[];
  messages: Message[];
  revisions: ResponseRevision[];
}

export interface TriggerDiagnosticSyntheticRequest {
  type: typeof MESSAGE_TRIGGER_DIAGNOSTIC_SYNTHETIC;
}

export interface TriggerDiagnosticSyntheticResponse {
  success: boolean;
  message?: string;
}

export interface ForwardTransportEventRequest {
  type: typeof MESSAGE_FORWARD_TRANSPORT_EVENT;
  event: TransportEvent;
}

export interface ForwardTransportEventResponse {
  received: boolean;
}

export interface ForwardSemanticBatchRequest {
  type: typeof MESSAGE_FORWARD_SEMANTIC_BATCH;
  batch: DeepSeekSemanticBatch;
  diagnostics?: DeepSeekProtocolDiagnosticsData;
}

export interface ForwardSemanticBatchResponse {
  received: boolean;
}

export interface NotifyBridgeObservedRequest {
  type: typeof MESSAGE_NOTIFY_BRIDGE_OBSERVED;
}

export interface NotifyBridgeObservedResponse {
  ok: boolean;
}

export interface RecordProtocolObservationRequest {
  type: typeof MESSAGE_RECORD_PROTOCOL_OBSERVATION;
  kind: 'unclassified_sse' | 'protocol_warning';
  sanitizedPathname: string;
  timestamp: number;
  producerSessionId?: string;
  streamId?: string;
  warning?: string;
}

export interface RecordProtocolObservationResponse {
  received: boolean;
}

export interface PersistRawStreamOpenRequest {
  type: typeof MESSAGE_PERSIST_RAW_STREAM_OPEN;
  producerSessionId: string;
  streamId: string;
  transport: 'fetch' | 'xhr';
  url: string; // sanitized URL (origin + pathname only)
  method: string;
  provisionalSessionId?: string;
  captureProfileId?: string;
  openedAt: number;
  streamSequence?: number;
  integrity?: import('../storage/raw-journal/types').RawStreamIntegrity;
}

export interface PersistRawStreamOpenResponse {
  success: boolean;
  streamKey: string;
  openedAt?: number;
  errorCode?: import('../storage/raw-journal/types').RawJournalErrorCode;
  error?: string;
}

export interface PersistRawBatchRequest {
  type: typeof MESSAGE_PERSIST_RAW_BATCH;
  batch: RawStreamBatch;
}

export interface PersistRawBatchResponse {
  success: boolean;
  streamKey: string;
  batchSeq: number;
  persistedAt?: number;
  errorCode?: import('../storage/raw-journal/types').RawJournalErrorCode;
  error?: string;
}

export interface FinalizeRawStreamRequest {
  type: typeof MESSAGE_FINALIZE_RAW_STREAM;
  streamKey: string;
  finalState: RawStreamState;
  terminalReason?: string;
  error?: string;
  droppedChars?: number;
  durabilityGap?: boolean;
  integrity?: import('../storage/raw-journal/types').RawStreamIntegrity;
}

export interface FinalizeRawStreamResponse {
  success: boolean;
  streamKey: string;
  finalState?: RawStreamState;
  finalizedAt?: number;
  errorCode?: import('../storage/raw-journal/types').RawJournalErrorCode;
  error?: string;
}


export interface GetRawJournalStatusRequest {
  type: typeof MESSAGE_GET_RAW_JOURNAL_STATUS;
}

export interface GetRawJournalStatusResponse {
  metadata: RawJournalMetadata;
  recentStreams: RawStreamRecord[];
}

export interface ForwardHistoryObservationRequest {
  type: typeof MESSAGE_FORWARD_HISTORY_OBSERVATION;
  payload: import('./protocol').HistoryObservationPayload;
}

export interface ForwardHistoryObservationResponse {
  success: boolean;
  reconciled?: boolean;
  conversationId?: string;
  messagesCreated?: number;
  messagesUpdated?: number;
  revisionsCreated?: number;
  treeLinksResolved?: number;
  error?: string;
}

export interface GetArchiveSummaryRequest {
  type: typeof MESSAGE_GET_ARCHIVE_SUMMARY;
}

export interface GetArchiveSummaryResponse {
  summary: import('../core/contracts').ArchiveSummary;
  historyObservationsCount: number;
  lastHistoryObservedAt?: number;
}

export interface PersistCanonicalCheckpointRequest {
  type: typeof MESSAGE_PERSIST_CANONICAL_CHECKPOINT;
  checkpoint: import('../core/contracts').CanonicalCheckpointData;
}

export interface PersistCanonicalCheckpointResponse {
  success: boolean;
  streamKey: string;
  checkpointSeq: number;
  persistedAt?: number;
  error?: string;
}

export interface ListArchiveConversationsRequest {
  type: typeof MESSAGE_LIST_ARCHIVE_CONVERSATIONS;
  options?: {
    limit?: number;
    cursor?: string;
  };
}

export interface ListArchiveConversationsResponse {
  success: boolean;
  data?: import('../core/contracts').PaginatedArchiveConversations;
  error?: string;
}

export interface GetArchiveConversationRequest {
  type: typeof MESSAGE_GET_ARCHIVE_CONVERSATION;
  conversationId: string;
}

export interface GetArchiveConversationResponse {
  success: boolean;
  data?: import('../core/contracts').ArchiveConversationDetail | null;
  error?: string;
}

export interface GetRevisionContentRequest {
  type: typeof MESSAGE_GET_REVISION_CONTENT;
  revisionId: string;
}

export interface GetRevisionContentResponse {
  success: boolean;
  data?: { text: string; thinking?: string } | null;
  error?: string;
}

export interface HistoryIngestOpenRequest {
  type: typeof MESSAGE_HISTORY_INGEST_OPEN;
  stagingId: string;
  sessionId: string;
  totalBatches: number;
  totalMessages: number;
  timestamp: number;
}

export interface HistoryIngestOpenResponse {
  success: boolean;
  stagingId: string;
  error?: string;
}

export interface HistoryIngestBatchRequest {
  type: typeof MESSAGE_HISTORY_INGEST_BATCH;
  stagingId: string;
  batchIndex: number;
  session?: import('../adapters/deepseek/history/types').NormalizedHistorySession;
  messages: import('../adapters/deepseek/history/types').NormalizedHistoryMessage[];
}

export interface HistoryIngestBatchResponse {
  success: boolean;
  stagingId: string;
  batchIndex: number;
  error?: string;
}

export interface HistoryIngestCommitRequest {
  type: typeof MESSAGE_HISTORY_INGEST_COMMIT;
  stagingId: string;
}

export interface HistoryIngestCommitResponse {
  success: boolean;
  stagingId: string;
  conversationId?: string;
  messagesCreated?: number;
  messagesUpdated?: number;
  revisionsCreated?: number;
  treeLinksResolved?: number;
  error?: string;
}

export interface HistoryIngestAbortRequest {
  type: typeof MESSAGE_HISTORY_INGEST_ABORT;
  stagingId: string;
  reason?: string;
}

export interface HistoryIngestAbortResponse {
  success: boolean;
  stagingId: string;
  error?: string;
}

export interface GetPageRecoverySummaryRequest {
  type: typeof MESSAGE_GET_PAGE_RECOVERY_SUMMARY;
  currentRouteSessionId?: string;
}

export interface GetPageRecoverySummaryResponse {
  success: boolean;
  summary: import('../adapters/deepseek/dom/types').PageRecoverySummary | null;
  error?: string;
}

export interface GetPageRecoveryContentRequest {
  type: typeof MESSAGE_GET_PAGE_RECOVERY_CONTENT;
  currentRouteSessionId: string;
  messageId: string;
  recoveryEventId?: string;
}

export interface GetPageRecoveryContentResponse {
  success: boolean;
  data?: {
    text: string;
    thinking?: string;
    source: string;
    capturedAt: number;
    recoveryKind: 'authoritative_recovery' | 'partial_capture';
  } | null;
  error?: string;
}

export type ExtensionInternalMessage =
  | SaveSyntheticBatchRequest
  | GetFoundationStatusRequest
  | ListSyntheticRevisionsRequest
  | TriggerDiagnosticSyntheticRequest
  | ForwardTransportEventRequest
  | ForwardSemanticBatchRequest
  | NotifyBridgeObservedRequest
  | RecordProtocolObservationRequest
  | PersistRawStreamOpenRequest
  | PersistRawBatchRequest
  | FinalizeRawStreamRequest
  | GetRawJournalStatusRequest
  | ForwardHistoryObservationRequest
  | GetArchiveSummaryRequest
  | PersistCanonicalCheckpointRequest
  | ListArchiveConversationsRequest
  | GetArchiveConversationRequest
  | GetRevisionContentRequest
  | HistoryIngestOpenRequest
  | HistoryIngestBatchRequest
  | HistoryIngestCommitRequest
  | HistoryIngestAbortRequest
  | GetPageRecoverySummaryRequest
  | GetPageRecoveryContentRequest;


