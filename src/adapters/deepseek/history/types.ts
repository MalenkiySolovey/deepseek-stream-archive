import type { MessageRole, MessageStatus } from '../../../core/models';

export function normalizeRemoteId(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isNaN(value)) return null;
    return String(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 128) return null;
    return trimmed;
  }
  return null;
}

export interface DeepSeekRawFragment {
  id?: number | string;
  type?: string; // 'REQUEST' | 'THINK' | 'RESPONSE' | 'TOOL_SEARCH' | 'TOOL_OPEN' | 'TIP' | 'TEMPLATE_RESPONSE' | string;
  content?: string;
  stage_id?: number | null;
  elapsed_secs?: number | null;
  references?: unknown;
  [key: string]: unknown;
}

export interface DeepSeekRawChatMessage {
  message_id: number | string;
  parent_id?: number | string | null;
  role: string; // 'user' | 'assistant' | 'system'
  status?: string | null;
  has_pending_fragment?: boolean;
  incomplete_message?: boolean | null;
  thinking_enabled?: boolean;
  search_enabled?: boolean;
  search_triggered?: boolean;
  accumulated_token_usage?: number | null;
  model?: string | null;
  feedback?: unknown;
  auto_continue?: boolean;
  extra_search_providers?: unknown;
  inserted_at?: number | null;
  fragments?: DeepSeekRawFragment[];
  content?: string; // Sometimes present on user messages
  response_content?: string;
  answer?: string;
  thinking_content?: string;
  thinking?: string;
  [key: string]: unknown;
}

export interface DeepSeekRawChatSession {
  id?: number | string;
  session_id?: number | string;
  title?: string;
  model_type?: string | null;
  pinned?: boolean;
  updated_at?: number;
  current_message_id?: number | string | null;
  [key: string]: unknown;
}

export interface DeepSeekRawHistoryPayload {
  code?: number;
  msg?: string;
  data?: {
    biz_code?: number;
    biz_msg?: string;
    biz_data?: {
      chat_session?: DeepSeekRawChatSession;
      chat_messages?: DeepSeekRawChatMessage[];
    };
  };
}

export interface NormalizedHistorySession {
  sessionId: string;
  title: string;
  updatedAt: number;
  currentMessageId?: string | null;
  modelType?: string | null;
  pinned: boolean;
}

export interface NormalizedHistoryMessage {
  messageId: string;
  parentId?: string | null;
  role: MessageRole;
  status: MessageStatus;
  createdAt: number;
  text: string;
  thinking?: string;
  isFiltered: boolean;
  templateResponse?: string;
  fragmentsCount: number;
}

export interface DeepSeekParsedHistory {
  session: NormalizedHistorySession;
  messages: NormalizedHistoryMessage[];
}
