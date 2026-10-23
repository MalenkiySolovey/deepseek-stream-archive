import type { DeepSeekDomProbeResult, DomCapabilityState, DomIdentityAuthority } from './types';
import { normalizeRemoteId } from '../history/types';

const CANDIDATE_CONTAINER_SELECTORS = [
  'main',
  '[data-testid="chat-container"]',
  '.chat-scrollable-container',
  'div[class*="chat-"]',
  '#root main',
];

const CANDIDATE_MESSAGE_SELECTORS = [
  '[data-message-id]',
  '[data-testid="chat-message"]',
  'div[class*="message-"]',
  'div[class*="ds-message"]',
  '.chat-message',
];

/**
 * Pure, passive, read-only DOM probe to identify DeepSeek chat layout capabilities.
 * Guarantees zero DOM mutation, zero React fiber access, and fail-open behavior.
 */
export function probeDeepSeekDom(
  root: Document | Element = typeof document !== 'undefined' ? document : (null as any)
): DeepSeekDomProbeResult {
  if (!root || typeof (root as any).querySelector !== 'function') {
    return {
      chatContainerFound: false,
      messageNodesCount: 0,
      identifiedMessageRemoteIds: [],
      observedSelectors: {},
      domCapabilityState: 'unsupported',
      identityAuthority: 'none',
    };
  }

  let matchedContainerSelector: string | undefined = undefined;
  for (const selector of CANDIDATE_CONTAINER_SELECTORS) {
    try {
      const el = root.querySelector(selector);
      if (el) {
        matchedContainerSelector = selector;
        break;
      }
    } catch {
      // Ignore invalid selector in hostile host environments
    }
  }

  let matchedMessageSelector: string | undefined = undefined;
  const identifiedIds = new Set<string>();
  let totalMessageNodes = 0;
  let hasVerifiedMessageIdAttr = false;

  for (const selector of CANDIDATE_MESSAGE_SELECTORS) {
    try {
      const nodes = root.querySelectorAll(selector);
      if (nodes && nodes.length > 0) {
        matchedMessageSelector = selector;
        totalMessageNodes = nodes.length;

        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i] as HTMLElement;
          // Only authoritative data-message-id provides strong identity
          const rawId = node.getAttribute('data-message-id');
          if (rawId) {
            const normalized = normalizeRemoteId(rawId);
            if (normalized) {
              identifiedIds.add(normalized);
              hasVerifiedMessageIdAttr = true;
            }
          }
        }

        if (identifiedIds.size > 0) {
          break;
        }
      }
    } catch {
      // Fail-open
    }
  }

  let domCapabilityState: DomCapabilityState = 'unsupported';
  let identityAuthority: DomIdentityAuthority = 'none';

  if (hasVerifiedMessageIdAttr && identifiedIds.size > 0) {
    domCapabilityState = 'strong_identity_available';
    identityAuthority = 'verified_message_id_attribute';
  } else if (totalMessageNodes > 0) {
    domCapabilityState = 'assistant_nodes_detected';
    identityAuthority = 'none';
  } else if (matchedContainerSelector) {
    domCapabilityState = 'weak_only';
    identityAuthority = 'none';
  }

  return {
    chatContainerFound: Boolean(matchedContainerSelector),
    messageNodesCount: totalMessageNodes,
    identifiedMessageRemoteIds: Array.from(identifiedIds),
    observedSelectors: {
      containerSelector: matchedContainerSelector,
      messageSelector: matchedMessageSelector,
    },
    domCapabilityState,
    identityAuthority,
  };
}
