export type KnownDeepSeekPatchOp = 'SET' | 'APPEND' | 'REPLACE' | 'BATCH';
export type DeepSeekPatchOp = KnownDeepSeekPatchOp | string;

export interface DeepSeekRawPatch {
  p?: string;
  o?: DeepSeekPatchOp;
  v?: unknown;
}

export interface DeepSeekFragment {
  id?: number | string;
  type: string;
  content: string;
  style?: string;
  [key: string]: unknown;
}

export type ProjectionSource = 'fragments' | 'top_level' | 'none';

export interface DeepSeekProjectedContent {
  answer: string;
  thinking: string;
  source: ProjectionSource;
}

export interface DeepSeekLastGoodState {
  messageId?: string;
  sessionId?: string;
  answer: string;
  thinking: string;
  fragments?: DeepSeekFragment[];
  capturedAt: number;
  reason: 'CONTENT_FILTER' | 'TEMPLATE_RESPONSE' | string;
  projectionSource: ProjectionSource;
}

export type DeepSeekSemanticEventType =
  | 'stream_start'
  | 'message_id_identified'
  | 'answer_delta'
  | 'thinking_delta'
  | 'answer_replace'
  | 'thinking_replace'
  | 'filter_triggered'
  | 'stream_finished'
  | 'stream_transport_ended'
  | 'stream_interrupted'
  | 'stream_degraded'
  | 'stream_error';

export type TerminalReason =
  | 'completed'
  | 'filtered'
  | 'truncated_context_limit'
  | 'incomplete'
  | 'timeout'
  | 'transport_abort'
  | 'transport_error'
  | 'transport_ended'
  | 'closed_without_resolved_status'
  | 'degraded';

export interface DeepSeekSemanticEvent {
  type: DeepSeekSemanticEventType;
  streamId: string;
  sequence: number;
  timestamp: number;
  messageId?: string;
  sessionId?: string;
  delta?: string;
  fullText?: string;
  lastGood?: DeepSeekLastGoodState;
  status?: string;
  reason?: string;
  terminalReason?: TerminalReason;
  hasPendingFragment?: boolean;
  incompleteMessage?: boolean;
  error?: string;
  projectionSource?: ProjectionSource;
}

export interface DeepSeekSemanticBatch {
  streamId: string;
  producerSessionId: string;
  events: DeepSeekSemanticEvent[];
}

export type StreamTerminalContext =
  | { kind: 'transport_complete' }
  | { kind: 'transport_abort'; reason?: string }
  | { kind: 'transport_error'; error?: string }
  | { kind: 'degraded'; reason?: string };

export type ProtocolCompatibilityState =
  | 'not_observed'
  | 'automated_verified'
  | 'live_observed'
  | 'degraded'
  | 'incompatible';

export type ProtocolWarningCode =
  | 'unknown_operation'
  | 'malformed_json'
  | 'invalid_path'
  | 'path_too_deep'
  | 'batch_too_large'
  | 'batch_too_deep'
  | 'array_index_too_large'
  | 'invalid_negative_index'
  | 'invalid_patch_shape'
  | 'unknown_fragment_type'
  | 'unknown_sse_event_name'
  | 'stream_sequence_gap'
  | 'duplicate_open'
  | 'orphan_stream_event'
  | 'event_after_terminal'
  | 'unclassified_sse_endpoint';

export type PatchApplyStatus = 'applied' | 'ignored_control' | 'rejected';

export interface PatchApplyResult {
  status: PatchApplyStatus;
  mutated: boolean;
  reason?: string;
}

export interface DeepSeekProtocolDiagnosticsData {
  activeProfileId: string;
  compatibilityState: ProtocolCompatibilityState;
  projectionSource: ProjectionSource;
  parsedFramesCount: number;
  operationsCount: {
    set: number;
    append: number;
    replace: number;
    batch: number;
    other: number;
  };
  activeMessageId?: string;
  activeSessionId?: string;
  currentAnswerLength: number;
  currentThinkingLength: number;
  filterEventsCount: number;
  lastFilterEvent?: {
    reason: string;
    timestamp: number;
    messageId?: string;
  };
  lastTerminalReason?: TerminalReason;
  lastProtocolStatus?: string;
  quasiStatus?: string;
  hasPendingFragment?: boolean;
  incompleteMessage?: boolean;
  finishControlObserved: boolean;
  closeControlObserved: boolean;
  sequenceGapsCount: number;
  orphanEventsCount: number;
  duplicateOpensCount: number;
  eventsAfterTerminalCount: number;
  protocolWarningsCount: number;
  unknownSseEndpoints: string[];
  unknownSseEventNames: string[];
  recentWarnings: string[];
}

