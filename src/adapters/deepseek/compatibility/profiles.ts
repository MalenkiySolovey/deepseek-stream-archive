import type { DeepSeekCompatibilityProfile } from './types';

export const DEEPSEEK_WEB_REFERENCE_2026_10: DeepSeekCompatibilityProfile = {
  id: 'deepseek-web-reference-2026-10',
  name: 'DeepSeek Web Chat Stream Protocol (2026-10 Reference & Live Reconciled)',
  version: '2026-10',
  description: 'Reconciled JSON patch streaming protocol observed on live chat.deepseek.com',
  generationEndpoints: [
    '/api/v0/chat/completion',
    '/api/v0/chat/edit_message',
    '/api/v0/chat/regenerate',
    '/api/v0/chat/continue',
    '/api/v0/chat/resume_stream',
  ],
  excludedEndpoints: [
    '/api/v0/chat/history_messages',
    '/api/v0/chat/stop_stream',
  ],
  supportedPatchOperations: ['SET', 'APPEND', 'REPLACE', 'BATCH'],
  filterStatusMarkers: ['CONTENT_FILTER'],
  filterFragmentTypes: ['TEMPLATE_RESPONSE'],
  terminalStatuses: [
    'FINISHED',
    'CONTENT_FILTER',
    'CONTEXT_LENGTH_EXCEEDED',
    'INCOMPLETE',
    'TIMEOUT',
  ],
  nonTerminalStatuses: ['WIP', 'AUTO_CONTINUE'],
  knownFragmentTypes: [
    'REQUEST',
    'THINK',
    'THINKING',
    'RESPONSE',
    'TOOL_SEARCH',
    'TOOL_OPEN',
    'TIP',
    'TEMPLATE_RESPONSE',
  ],
  knownEventNames: ['message', 'ready', 'update_session', 'finish', 'title', 'close'],
};

export const DEFAULT_DEEPSEEK_PROFILE = DEEPSEEK_WEB_REFERENCE_2026_10;
