export type TransportKind = 'fetch' | 'xhr';

export type TransportEventType = 'open' | 'chunk' | 'complete' | 'abort' | 'error';

export interface TransportMetadata {
  method: string;
  url: string; // Sanitized: origin + pathname only
  status?: number;
  statusText?: string;
  contentType?: string;
}

export interface RequestCandidateMetadata {
  url: string;
  method: string;
  contentType?: string;
}

export interface TransportEvent {
  producerSessionId: string;
  streamId: string;
  sequence: number; // Monotonically increasing per producer session
  streamSequence: number; // Monotonically increasing per individual stream
  timestamp: number;
  transport: TransportKind;
  type: TransportEventType;
  metadata?: TransportMetadata;
  chunkText?: string;
  reason?: string;
}

/**
 * Sanitizes a URL string to include only origin and pathname, stripping
 * sensitive query parameters, userinfo, and hash fragments.
 */
export function sanitizeUrl(rawUrl: string, fallbackBase = 'http://localhost'): string {
  try {
    const base = typeof location !== 'undefined' && location.origin && location.origin !== 'null'
      ? location.origin
      : fallbackBase;
    const parsed = new URL(rawUrl, base);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    // If URL parsing fails, strip query and hash via string operations
    const noHash = rawUrl.split('#')[0] ?? '';
    const noQuery = noHash.split('?')[0] ?? '';
    return noQuery;
  }
}

