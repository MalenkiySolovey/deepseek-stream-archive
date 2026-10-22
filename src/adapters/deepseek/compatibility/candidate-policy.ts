import type { RequestCandidateMetadata } from '../../../transport/types';
import type { DeepSeekCompatibilityProfile } from './types';
import { DEFAULT_DEEPSEEK_PROFILE } from './profiles';

export const GENERATION_ENDPOINTS = DEFAULT_DEEPSEEK_PROFILE.generationEndpoints;

/**
 * Normalizes a raw URL to extract its clean pathname without query strings,
 * hash fragments, redundant slashes, or trailing slashes (except root).
 */
export function normalizePathname(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const clean = rawUrl.trim();
    if (!clean) return '';
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(clean);
    let pathname: string;
    if (hasScheme) {
      pathname = new URL(clean).pathname;
    } else {
      const noHash = clean.split('#')[0] || '';
      const noQuery = noHash.split('?')[0] || '';
      pathname = noQuery.startsWith('/') ? noQuery : '/' + noQuery;
    }
    const collapsed = pathname.replace(/\/+/g, '/').replace(/\/+$/, '');
    return collapsed.length > 0 ? collapsed : '/';
  } catch {
    const noHash = String(rawUrl).split('#')[0] || '';
    const noQuery = noHash.split('?')[0] || '';
    const collapsed = ('/' + noQuery).replace(/\/+/g, '/').replace(/\/+$/, '');
    return collapsed.length > 0 ? collapsed : '/';
  }
}

/**
 * Checks whether a given request URL corresponds to a known DeepSeek chat generation endpoint.
 * Uses exact normalized pathname matching against the profile's generation endpoints and
 * strictly rejects known excluded endpoints (e.g. history_messages, stop_stream).
 */
export function isDeepSeekGenerationEndpoint(
  rawUrl: string,
  profile: DeepSeekCompatibilityProfile = DEFAULT_DEEPSEEK_PROFILE
): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const clean = rawUrl.trim();
  if (!clean || clean.length > 1024) return false;

  // Strict Host Validation: if an origin/host is present, it MUST be https://chat.deepseek.com with default/empty port
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(clean)) {
    try {
      const parsed = new URL(clean);
      if (parsed.protocol !== 'https:') {
        return false;
      }
      if (parsed.hostname.toLowerCase() !== 'chat.deepseek.com') {
        return false;
      }
      if (parsed.port !== '' && parsed.port !== '443') {
        return false;
      }
    } catch {
      return false;
    }
  } else if (clean.startsWith('//')) {
    try {
      const parsed = new URL('https:' + clean);
      if (parsed.hostname.toLowerCase() !== 'chat.deepseek.com') {
        return false;
      }
      if (parsed.port !== '' && parsed.port !== '443') {
        return false;
      }
    } catch {
      return false;
    }
  }

  const normalized = normalizePathname(clean);

  // Reject explicitly excluded endpoints
  for (const excluded of profile.excludedEndpoints) {
    if (normalized === normalizePathname(excluded)) {
      return false;
    }
  }

  // Exact match against declared generation endpoints
  return profile.generationEndpoints.some((endpoint) => {
    return normalized === normalizePathname(endpoint);
  });
}

/**
 * Creates a predicate to match incoming HTTP requests against known DeepSeek
 * generation endpoints.
 *
 * NOTE: This predicate evaluates ONLY endpoint identity. Generic Content-Type
 * checking (e.g. text/event-stream) is handled by the transport layer independently,
 * ensuring known generation endpoints with alternative Content-Types (e.g. application/octet-stream)
 * are cleanly captured.
 */
export function createDeepSeekCandidatePredicate(
  profile: DeepSeekCompatibilityProfile = DEFAULT_DEEPSEEK_PROFILE
): (metadata: RequestCandidateMetadata) => boolean {
  return (meta: RequestCandidateMetadata): boolean => {
    return isDeepSeekGenerationEndpoint(meta.url, profile);
  };
}
