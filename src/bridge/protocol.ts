export const BRIDGE_SOURCE_TAG = 'deepseek-streamarchive' as const;
export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const STREAMARCHIVE_BRIDGE_EVENT = 'streamarchive:bridge-event' as const;

export type BridgeEventType =
  | 'bridge.ready'
  | 'stream.chunk'
  | 'stream.complete'
  | 'stream.abort'
  | 'transport.event'
  | 'synthetic.test'
  | 'history.observation'
  | 'history.open'
  | 'history.chunk'
  | 'history.complete'
  | 'history.abort';

export interface StreamArchiveBridgeEnvelope<T = unknown> {
  source: typeof BRIDGE_SOURCE_TAG;
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  eventId: string;
  type: BridgeEventType;
  timestamp: number;
  payload: T;
}

export interface SyntheticTestPayload {
  testId: string;
  conversationTitle: string;
  promptText: string;
  responseText: string;
  source: 'synthetic';
}

export interface HistoryObservationPayload {
  url: string;
  sessionId: string;
  status: number;
  body: string;
  timestamp: number;
}

export interface HistoryStreamOpenPayload {
  historyId: string;
  url: string;
  sessionId: string;
  status: number;
  timestamp: number;
  totalChars?: number;
}

export interface HistoryStreamChunkPayload {
  historyId: string;
  chunkIndex: number;
  chunkText: string;
}

export interface HistoryStreamCompletePayload {
  historyId: string;
  totalChars: number;
  timestamp: number;
}

export interface HistoryStreamAbortPayload {
  historyId: string;
  reason?: string;
}
