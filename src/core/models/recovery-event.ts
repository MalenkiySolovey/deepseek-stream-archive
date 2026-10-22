export type RecoveryKind =
  | 'content_filter'
  | 'template_response'
  | 'network_interruption'
  | 'dom_replacement'
  | 'synthetic';

export interface RecoveryEvent {
  id: string;
  messageId: string;
  kind: RecoveryKind;
  detectedAt: number;
  recoveredRevisionId: string;
  reason?: string;
}
