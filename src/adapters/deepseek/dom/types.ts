/**
 * Types and interfaces for DeepSeek DOM capability probe and message location.
 * Read-only analysis without mutating or interacting with DeepSeek's DOM or React state.
 */

export type DomCapabilityState =
  | 'unsupported'
  | 'assistant_nodes_detected'
  | 'strong_identity_available'
  | 'weak_only'
  | 'degraded';

export type DomIdentityAuthority =
  | 'verified_message_id_attribute'
  | 'verified_profile_specific_attribute'
  | 'none';

export interface DeepSeekDomProbeResult {
  chatContainerFound: boolean;
  messageNodesCount: number;
  identifiedMessageRemoteIds: string[];
  observedSelectors: {
    containerSelector?: string;
    messageSelector?: string;
  };
  domCapabilityState: DomCapabilityState;
  identityAuthority: DomIdentityAuthority;
}

export interface LocatedMessageAnchor {
  remoteId: string;
  element: HTMLElement;
  rect: DOMRect;
  authority: DomIdentityAuthority;
}

export type PageRecoveryPresentationKind =
  | 'pre_filter_recovery'
  | 'interruption_recovery'
  | 'partial_capture';

export interface PageRecoveryMessageSummary {
  messageId: string;
  remoteId?: string;
  role: string;
  status: string;
  hasLastGood: boolean;
  recoveryKind: 'authoritative_recovery' | 'partial_capture' | PageRecoveryPresentationKind;
  presentationKind?: PageRecoveryPresentationKind;
  capturedAt: number;
  recoveredRevisionId: string;
  recoveryEventId?: string;
}

export interface PageRecoverySummary {
  conversationId: string;
  remoteSessionId?: string;
  recoverableCount: number;
  messages: PageRecoveryMessageSummary[];
}
