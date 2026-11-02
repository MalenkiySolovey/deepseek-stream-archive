export interface SanitizedRequestInfo {
  method: string;
  origin: string;
  pathname: string;
  resourceType: string;
}

export class NetworkAudit {
  private readonly unexpectedRequests: SanitizedRequestInfo[] = [];

  recordViolation(rawUrl: string, method: string, resourceType: string): SanitizedRequestInfo {
    let origin = 'unknown';
    let pathname = rawUrl;
    try {
      const parsed = new URL(rawUrl);
      origin = parsed.origin;
      pathname = parsed.pathname;
    } catch {
      // url was not a valid standard URL
    }

    const sanitized: SanitizedRequestInfo = {
      method: method || 'UNKNOWN',
      origin,
      pathname,
      resourceType: resourceType || 'unknown',
    };

    this.unexpectedRequests.push(sanitized);
    return sanitized;
  }

  getViolations(): readonly SanitizedRequestInfo[] {
    return this.unexpectedRequests;
  }

  get count(): number {
    return this.unexpectedRequests.length;
  }

  clear(): void {
    this.unexpectedRequests.length = 0;
  }

  assertClean(): void {
    if (this.unexpectedRequests.length > 0) {
      const summary = this.unexpectedRequests
        .map((r) => `${r.method} ${r.origin}${r.pathname} (${r.resourceType})`)
        .join(', ');
      throw new Error(
        `[NetworkAudit Violation] Expected ZERO unhandled network requests, but observed ${this.unexpectedRequests.length}: [${summary}]`
      );
    }
  }
}
