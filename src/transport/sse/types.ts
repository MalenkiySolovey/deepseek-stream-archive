/**
 * Generic Server-Sent Events (SSE) data contract according to W3C / WHATWG specification.
 * `data` remains an opaque string at this layer (no JSON parsing).
 */
export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}
