/**
 * Types and interfaces for DeepSeek DOM capability probe and message location.
 * Read-only analysis without mutating or interacting with DeepSeek's DOM or React state.
 */

export interface DeepSeekDomProbeResult {
  chatContainerFound: boolean;
  messageNodesCount: number;
  identifiedMessageRemoteIds: string[];
  observedSelectors: {
    containerSelector?: string;
    messageSelector?: string;
  };
}

export interface LocatedMessageAnchor {
  remoteId: string;
  element: HTMLElement;
  rect: DOMRect;
}

export interface PageRecoveryMessageSummary {
  messageId: string;
  remoteId?: string;
  role: string;
  status: string;
  hasLastGood: boolean;
  snippet: string;
  capturedAt: number;
  recoveredRevisionId: string;
}

export interface PageRecoverySummary {
  conversationId: string;
  remoteSessionId?: string;
  recoverableCount: number;
  messages: PageRecoveryMessageSummary[];
}
