/**
 * Request Augmenter for DeepSeek Context Continuity Delivery.
 *
 * Prepends formatted context continuity disclosures to the user's prompt
 * while strictly preserving all other body fields, headers, and metadata.
 *
 * Core Invariants:
 * 1. Fail-Open: If anything cannot be proven safe, original request is returned unchanged.
 * 2. Strict User-Authored Prompt Gate: Only non-empty prompt requests are augmented.
 * 3. Double-Injection Prevention: Already marked prompts are never re-augmented.
 * 4. Identity & Parent Verification: Remote conversation and parent message IDs must match.
 */

import type {
  ContextDeliveryEnvelope,
  AugmentationResult,
} from './types';
import { isDeepSeekUserGenerationEndpoint, parseDeepSeekRequestBody } from './parser';
import { formatContinuityPrompt, hasContinuityMarker } from './marker';

export interface AugmentRequestOptions {
  url: string;
  method?: string;
  body: unknown;
  envelope: ContextDeliveryEnvelope | null;
  now?: number;
}

/**
 * Evaluates whether an outgoing DeepSeek request is eligible for Context Continuity
 * augmentation and produces the mutated JSON body if all invariants hold.
 */
export function augmentDeepSeekRequest(options: AugmentRequestOptions): AugmentationResult {
  const { url, method = 'POST', body, envelope, now = Date.now() } = options;

  try {
    // 1. Endpoint predicate: Only user-authored generation endpoints
    if (!isDeepSeekUserGenerationEndpoint(url, method)) {
      return {
        augmented: false,
        originalBody: body,
        reason: 'not_candidate_endpoint',
      };
    }

    // 2. Envelope presence
    if (!envelope) {
      return {
        augmented: false,
        originalBody: body,
        reason: 'envelope_missing',
      };
    }

    // 3. Envelope expiry
    if (envelope.expiresAt && now > envelope.expiresAt) {
      return {
        augmented: false,
        originalBody: body,
        reason: 'envelope_expired',
      };
    }

    // 4. Body type validation (strictly JSON string)
    if (typeof body !== 'string') {
      return {
        augmented: false,
        originalBody: body,
        reason: 'unsupported_body_type',
      };
    }

    // 5. JSON Parse
    const parsed = parseDeepSeekRequestBody(body);
    if (!parsed) {
      return {
        augmented: false,
        originalBody: body,
        reason: 'malformed_json',
      };
    }

    // 6. User-authored prompt gate: Must be non-empty string
    if (typeof parsed.prompt !== 'string' || parsed.prompt.trim().length === 0) {
      return {
        augmented: false,
        originalBody: body,
        reason: 'empty_or_missing_prompt',
      };
    }

    // 7. Double-injection & Retry idempotency check
    if (hasContinuityMarker(parsed.prompt)) {
      return {
        augmented: false,
        originalBody: body,
        reason: 'already_augmented',
      };
    }

    // 8. Session ID alignment check
    if (
      parsed.chat_session_id &&
      envelope.remoteConversationId &&
      parsed.chat_session_id !== envelope.remoteConversationId
    ) {
      return {
        augmented: false,
        originalBody: body,
        reason: 'session_id_mismatch',
      };
    }

    // 9. Parent message alignment check
    if (
      envelope.expectedParentMessageId !== null &&
      parsed.parent_message_id !== undefined &&
      parsed.parent_message_id !== envelope.expectedParentMessageId
    ) {
      return {
        augmented: false,
        originalBody: body,
        reason: 'parent_message_id_mismatch',
      };
    }

    // 10. Format augmented prompt
    const originalPrompt = parsed.prompt;
    const augmentedPrompt = formatContinuityPrompt(
      envelope.formattedContext,
      originalPrompt,
      envelope.deliveryId
    );

    // 11. Clone parsed payload and replace ONLY the prompt field
    const augmentedPayload = {
      ...parsed,
      prompt: augmentedPrompt,
    };
    const augmentedBody = JSON.stringify(augmentedPayload);

    return {
      augmented: true,
      deliveryId: envelope.deliveryId,
      originalPrompt,
      augmentedPrompt,
      augmentedBody,
      envelope,
    };
  } catch (err) {
    // Fail-open invariant: Never disrupt DeepSeek if unexpected error occurs
    return {
      augmented: false,
      originalBody: body,
      reason: 'unknown_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
