import type { MessageRole, MessageStatus } from '../../../core/models';
import {
  normalizeRemoteId,
  type DeepSeekParsedHistory,
  type DeepSeekRawChatMessage,
  type DeepSeekRawFragment,
  type NormalizedHistoryMessage,
  type NormalizedHistorySession,
} from './types';

const MAX_PAYLOAD_STRING_LENGTH = 25 * 1024 * 1024; // 25 MB
const MAX_MESSAGES_COUNT = 5000;

export interface HistoryParseContext {
  expectedSessionId?: string;
  observedAt?: number;
}

export class DeepSeekHistoryParser {
  /**
   * Safely parses a raw DeepSeek history response payload into normalized session and messages.
   * Returns null if payload is invalid, corrupted, or does not conform to the expected schema.
   */
  static parse(raw: unknown, context?: HistoryParseContext): DeepSeekParsedHistory | null {
    if (!raw) return null;

    let parsed: any;
    if (typeof raw === 'string') {
      if (raw.length > MAX_PAYLOAD_STRING_LENGTH) {
        return null;
      }
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
    } else if (typeof raw === 'object') {
      parsed = raw;
    } else {
      return null;
    }

    if (!parsed || typeof parsed !== 'object') return null;

    // Check optional biz error codes
    if (parsed.code !== undefined && parsed.code !== 0) return null;
    if (parsed.data?.biz_code !== undefined && parsed.data.biz_code !== 0) return null;

    // Extract biz_data from standard wrapper data.biz_data, direct data, or root
    const bizData = parsed.data?.biz_data || parsed.biz_data || parsed.data || parsed;
    if (!bizData || typeof bizData !== 'object') return null;

    // 1. Session extraction
    const rawSession = bizData.chat_session || bizData.session;
    const rawSessionId =
      rawSession?.id !== undefined
        ? normalizeRemoteId(rawSession.id)
        : rawSession?.session_id !== undefined
          ? normalizeRemoteId(rawSession.session_id)
          : bizData.session_id !== undefined
            ? normalizeRemoteId(bizData.session_id)
            : null;

    const expectedSessionId = context?.expectedSessionId
      ? normalizeRemoteId(context.expectedSessionId)
      : null;

    // Identity check: If both present and they mismatch, reject
    if (rawSessionId && expectedSessionId && rawSessionId !== expectedSessionId) {
      return null;
    }

    const sessionId = rawSessionId || expectedSessionId;
    if (!sessionId) {
      return null;
    }

    const sessionTitle =
      typeof rawSession?.title === 'string' && rawSession.title.trim().length > 0
        ? rawSession.title.trim()
        : sessionId.slice(0, 8);

    const rawUpdatedAt =
      typeof rawSession?.updated_at === 'number'
        ? rawSession.updated_at
        : typeof rawSession?.updatedAt === 'number'
          ? rawSession.updatedAt
          : typeof context?.observedAt === 'number'
            ? context.observedAt
            : Date.now();

    // DeepSeek timestamps in API are often in seconds if < 1e11
    const updatedAt = rawUpdatedAt > 1e11 ? rawUpdatedAt : Math.round(rawUpdatedAt * 1000);

    const currentMessageId =
      rawSession?.current_message_id !== undefined && rawSession.current_message_id !== null
        ? normalizeRemoteId(rawSession.current_message_id)
        : null;

    const session: NormalizedHistorySession = {
      sessionId,
      title: sessionTitle,
      updatedAt,
      currentMessageId,
      modelType: typeof rawSession?.model_type === 'string' ? rawSession.model_type : null,
      pinned: Boolean(rawSession?.pinned),
    };

    // 2. Messages extraction
    const rawMessages: unknown[] = Array.isArray(bizData.chat_messages)
      ? bizData.chat_messages
      : Array.isArray(bizData.messages)
        ? bizData.messages
        : [];

    if (rawMessages.length > MAX_MESSAGES_COUNT) {
      return null;
    }

    const seenMessages = new Map<string, NormalizedHistoryMessage>();
    const messages: NormalizedHistoryMessage[] = [];

    for (const item of rawMessages) {
      if (!item || typeof item !== 'object') continue;
      const m = item as DeepSeekRawChatMessage;

      const messageId = normalizeRemoteId(m.message_id);
      if (!messageId) {
        continue;
      }

      const parentId =
        m.parent_id !== undefined && m.parent_id !== null
          ? normalizeRemoteId(m.parent_id)
          : null;

      // Role normalization
      let role: MessageRole = 'unknown';
      if (typeof m.role === 'string') {
        const lower = m.role.toLowerCase();
        if (lower === 'user') role = 'user';
        else if (lower === 'assistant') role = 'assistant';
        else if (lower === 'system') role = 'system';
      }

      // Status normalization: Assistant without explicit terminal status defaults to 'unknown' (NEVER 'finished')
      let status: MessageStatus = role === 'assistant' ? 'unknown' : 'finished';
      let isFiltered = false;
      if (typeof m.status === 'string') {
        const upper = m.status.toUpperCase();
        if (upper === 'CONTENT_FILTER') {
          status = 'filtered';
          isFiltered = true;
        } else if (upper === 'STREAMING') {
          status = 'streaming';
        } else if (upper === 'INCOMPLETE') {
          status = 'incomplete';
        } else if (upper === 'TIMEOUT') {
          status = 'timeout';
        } else if (upper === 'CONTEXT_LENGTH_EXCEEDED') {
          status = 'context_length_exceeded';
        } else if (upper === 'FINISHED') {
          status = 'finished';
        }
      }

      // Timestamp normalization
      let createdAt = typeof context?.observedAt === 'number' ? context.observedAt : Date.now();
      if (typeof m.inserted_at === 'number') {
        createdAt = m.inserted_at > 1e11 ? m.inserted_at : Math.round(m.inserted_at * 1000);
      }

      // Fragments parsing & dual shape
      const textParts: string[] = [];
      const thinkParts: string[] = [];
      let templateResponse: string | undefined = undefined;
      const fragments = Array.isArray(m.fragments) ? m.fragments : [];

      for (const frag of fragments) {
        if (!frag || typeof frag !== 'object') continue;
        const f = frag as DeepSeekRawFragment;
        const type = typeof f.type === 'string' ? f.type.toUpperCase() : '';
        const content = typeof f.content === 'string' ? f.content : '';

        if (role === 'assistant') {
          if (type === 'RESPONSE') {
            textParts.push(content);
          } else if (type === 'THINK') {
            thinkParts.push(content);
          } else if (type === 'TEMPLATE_RESPONSE') {
            isFiltered = true;
            status = 'filtered';
            templateResponse = content;
          }
          // Invariant: REQUEST is NEVER added to assistant response text
        } else if (role === 'user') {
          if (type === 'REQUEST' || type === 'RESPONSE') {
            textParts.push(content);
          }
        } else {
          // system or unknown
          if (type === 'RESPONSE' || type === 'REQUEST') {
            textParts.push(content);
          }
        }
      }

      // Fallbacks if fragments did not populate text
      if (textParts.length === 0) {
        if (role === 'assistant') {
          if (typeof m.response_content === 'string' && m.response_content.length > 0) {
            textParts.push(m.response_content);
          } else if (typeof m.answer === 'string' && m.answer.length > 0) {
            textParts.push(m.answer);
          } else if (typeof m.content === 'string' && m.content.length > 0) {
            textParts.push(m.content);
          }
        } else {
          if (typeof m.content === 'string') {
            textParts.push(m.content);
          }
        }
      }

      if (thinkParts.length === 0 && role === 'assistant') {
        if (typeof m.thinking_content === 'string') {
          thinkParts.push(m.thinking_content);
        } else if (typeof m.thinking === 'string') {
          thinkParts.push(m.thinking);
        }
      }

      const text = textParts.join('');
      const thinking = thinkParts.length > 0 ? thinkParts.join('\n') : undefined;

      const normalizedMsg: NormalizedHistoryMessage = {
        messageId,
        parentId,
        role,
        status,
        createdAt,
        text,
        thinking,
        isFiltered,
        templateResponse,
        fragmentsCount: fragments.length,
      };

      const existing = seenMessages.get(messageId);
      if (existing) {
        // Duplicate remote ID check: identical is safely deduplicated; conflicting rejects payload
        const isIdentical =
          existing.role === normalizedMsg.role &&
          existing.parentId === normalizedMsg.parentId &&
          existing.status === normalizedMsg.status &&
          existing.text === normalizedMsg.text &&
          existing.thinking === normalizedMsg.thinking;

        if (isIdentical) {
          continue;
        } else {
          return null;
        }
      }

      seenMessages.set(messageId, normalizedMsg);
      messages.push(normalizedMsg);
    }

    return { session, messages };
  }
}
