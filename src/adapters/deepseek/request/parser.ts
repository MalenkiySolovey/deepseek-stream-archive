/**
 * Request Parser & Predicate for DeepSeek Generation Endpoints.
 *
 * Implements strict, safe inspection of outgoing requests.
 * Fail-open invariant: Any unsupported body or format returns null.
 */

import type { DeepSeekGenerationRequestBody } from './types';

export const USER_GENERATION_ENDPOINTS = [
  '/api/v0/chat/completion',
  '/api/v0/chat/edit_message',
] as const;

/**
 * Normalizes URL path to match candidate generation endpoints.
 */
export function normalizeEndpointPath(rawUrl: string): string {
  try {
    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
      const parsed = new URL(rawUrl);
      return parsed.pathname;
    }
    const questionIndex = rawUrl.indexOf('?');
    const hashIndex = rawUrl.indexOf('#');
    let path = rawUrl;
    if (questionIndex !== -1) {
      path = path.slice(0, questionIndex);
    }
    if (hashIndex !== -1) {
      path = path.slice(0, hashIndex);
    }
    return path;
  } catch {
    return rawUrl;
  }
}

/**
 * Tests whether a request targets an eligible DeepSeek generation endpoint
 * that accepts user-authored prompts.
 *
 * Note: Endpoints like regenerate, continue, or resume_stream are explicitly excluded.
 */
export function isDeepSeekUserGenerationEndpoint(url: string, method = 'POST'): boolean {
  if (method.toUpperCase() !== 'POST') {
    return false;
  }

  const path = normalizeEndpointPath(url);
  return USER_GENERATION_ENDPOINTS.some((ep) => path.endsWith(ep) || path === ep);
}

/**
 * Safely parses the outgoing JSON request body for DeepSeek generation endpoints.
 *
 * Fail-open: Returns null for non-string, FormData, Blob, Stream, or invalid JSON.
 */
export function parseDeepSeekRequestBody(rawBody: unknown): DeepSeekGenerationRequestBody | null {
  if (typeof rawBody !== 'string') {
    return null;
  }

  const trimmed = rawBody.trim();
  if (trimmed.length === 0 || (!trimmed.startsWith('{') && !trimmed.endsWith('}'))) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as DeepSeekGenerationRequestBody;
  } catch {
    return null;
  }
}
