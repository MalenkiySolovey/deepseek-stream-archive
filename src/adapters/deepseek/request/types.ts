/**
 * Request Compatibility Types for DeepSeek Context Continuity Delivery.
 *
 * Defines the outgoing request payload structures, delivery envelope,
 * and augmentation decision results.
 */

export interface DeepSeekGenerationRequestBody {
  chat_session_id?: string;
  parent_message_id?: string | null;
  prompt?: string;
  ref_file_ids?: string[];
  thinking_enabled?: boolean;
  search_enabled?: boolean;
  preempt?: boolean;
  model_type?: string;
  [key: string]: unknown;
}

export interface ContextDeliveryEnvelope {
  deliveryId: string;
  conversationId: string;
  remoteConversationId: string;
  expectedParentMessageId: string | null;
  formattedContext: string;
  sourceMessageIds: string[];
  sourceRevisionIds: string[];
  deliveryMode: 'automatic' | 'manual_next';
  createdAt: number;
  expiresAt: number;
}

export type AugmentationSkipReason =
  | 'not_candidate_endpoint'
  | 'envelope_missing'
  | 'envelope_expired'
  | 'session_id_mismatch'
  | 'parent_message_id_mismatch'
  | 'empty_or_missing_prompt'
  | 'already_augmented'
  | 'unsupported_body_type'
  | 'malformed_json'
  | 'unknown_error';

export type AugmentationResult =
  | {
      augmented: true;
      deliveryId: string;
      originalPrompt: string;
      augmentedPrompt: string;
      augmentedBody: string;
      envelope: ContextDeliveryEnvelope;
    }
  | {
      augmented: false;
      originalBody: unknown;
      reason: AugmentationSkipReason;
      error?: string;
    };
