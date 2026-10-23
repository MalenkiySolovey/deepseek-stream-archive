import { OVERLAY_STYLES } from './styles';
import { locateMessageAnchor } from '../adapters/deepseek/dom/message-locator';
import type { PageRecoverySummary, PageRecoveryMessageSummary } from '../adapters/deepseek/dom/types';
import {
  MESSAGE_GET_PAGE_RECOVERY_SUMMARY,
  MESSAGE_GET_PAGE_RECOVERY_CONTENT,
  type GetPageRecoverySummaryRequest,
  type GetPageRecoverySummaryResponse,
  type GetPageRecoveryContentRequest,
  type GetPageRecoveryContentResponse,
} from '../bridge/messages';
import { extractSessionIdFromUrl } from '../adapters/deepseek/context/session-id';
import { logger } from '../shared/logger';

export interface OverlayContentResult {
  text: string;
  thinking?: string;
  source?: string;
  capturedAt?: number;
  recoveryKind?: 'authoritative_recovery' | 'partial_capture';
}

export interface OverlayPortalOptions {
  mountTarget?: HTMLElement;
  fetchSummary?: (currentRouteSessionId?: string) => Promise<PageRecoverySummary | null>;
  fetchContent?: (req: {
    currentRouteSessionId: string;
    messageId: string;
    recoveryEventId?: string;
  }) => Promise<OverlayContentResult | null>;
}

// Track elements created by our extension isolated world to reject spoofed page elements
const OWNED_PORTAL_HOSTS = new WeakSet<HTMLElement>();

function getRecoveryLabel(msg: PageRecoveryMessageSummary): {
  icon: string;
  badgeLabel: string;
  cardLabel: string;
  trayPrefix: string;
  className: string;
} {
  const isPreFilter =
    msg.presentationKind === 'pre_filter_recovery' ||
    (msg.recoveryKind === 'authoritative_recovery' && !msg.presentationKind);
  if (isPreFilter) {
    return {
      icon: '🛡️ ',
      badgeLabel: 'Recovered Pre-Filter Response',
      cardLabel: '🛡️ Recovered Original (Pre-Filter Preserved)',
      trayPrefix: '[Recovered Original] ',
      className: 'filtered',
    };
  }

  const isInterruption = msg.presentationKind === 'interruption_recovery';
  if (isInterruption) {
    return {
      icon: '⚡ ',
      badgeLabel: 'Captured Before Interruption',
      cardLabel: '⚡ Captured Before Network Interruption',
      trayPrefix: '[Interruption Capture] ',
      className: 'interrupted',
    };
  }

  return {
    icon: '⚠️ ',
    badgeLabel: 'Partial Captured Response',
    cardLabel: '⚠️ Partial Captured Response',
    trayPrefix: '[Partial Capture] ',
    className: 'degraded',
  };
}

export class StreamArchiveOverlayPortal {
  private rootHost: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private container: HTMLElement | null = null;
  private activeSummary: PageRecoverySummary | null = null;
  private dismissedMessageIds = new Set<string>();
  private activeModalMessageId: string | null = null;
  private modalContentCache = new Map<string, OverlayContentResult>();
  private currentUrl = '';
  private currentSessionId: string | null = null;
  private routeEpoch = 0;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private repositionRaf: number | null = null;
  private domMutationObserver: MutationObserver | null = null;
  private bootstrapObserver: MutationObserver | null = null;
  private domContentLoadedHandler: (() => void) | null = null;
  private isDestroyed = false;
  private isMounted = false;

  private readonly fetchSummaryImpl: (currentRouteSessionId?: string) => Promise<PageRecoverySummary | null>;
  private readonly fetchContentImpl: (req: {
    currentRouteSessionId: string;
    messageId: string;
    recoveryEventId?: string;
  }) => Promise<OverlayContentResult | null>;

  constructor(options?: OverlayPortalOptions) {
    this.fetchSummaryImpl =
      options?.fetchSummary ||
      (async (routeId) => {
        try {
          const res = await chrome.runtime.sendMessage<
            GetPageRecoverySummaryRequest,
            GetPageRecoverySummaryResponse
          >({
            type: MESSAGE_GET_PAGE_RECOVERY_SUMMARY,
            currentRouteSessionId: routeId,
          });
          return res?.success && res.summary ? res.summary : null;
        } catch {
          return null;
        }
      });

    this.fetchContentImpl =
      options?.fetchContent ||
      (async (req) => {
        try {
          const res = await chrome.runtime.sendMessage<
            GetPageRecoveryContentRequest,
            GetPageRecoveryContentResponse
          >({
            type: MESSAGE_GET_PAGE_RECOVERY_CONTENT,
            currentRouteSessionId: req.currentRouteSessionId,
            messageId: req.messageId,
            recoveryEventId: req.recoveryEventId,
          });
          return res?.success && res.data ? res.data : null;
        } catch {
          return null;
        }
      });

    this.initPortal(options?.mountTarget);
  }

  private initPortal(customMount?: HTMLElement): void {
    if (typeof document === 'undefined') return;

    // Handle document_start execution where documentElement might not yet exist
    if (!document.documentElement && !customMount) {
      const onReady = () => {
        document.removeEventListener('DOMContentLoaded', onReady);
        this.initPortal(customMount);
      };
      document.addEventListener('DOMContentLoaded', onReady);
      return;
    }

    const mountParent = customMount || document.documentElement;
    if (!mountParent) return;

    // Invariant: Zero host-DOM mutation.
    // If the page already contains an element with data-streamarchive-overlay-root,
    // LEAVE IT COMPLETELY UNTOUCHED. Never remove(), replaceWith(), or mutate page DOM.
    // The extension creates its own element reference and tracks ownership exclusively in isolated-world memory.
    if (!this.rootHost) {
      const host = document.createElement('div');
      host.setAttribute('data-streamarchive-overlay-root', 'true');
      OWNED_PORTAL_HOSTS.add(host);
      mountParent.appendChild(host);
      this.rootHost = host;
    }

    // Attach closed ShadowRoot for full DOM and CSS isolation
    try {
      this.shadow = this.rootHost.attachShadow({ mode: 'closed' });
    } catch {
      // In testing environments where attachShadow might already be called
      this.shadow = (this.rootHost as any).shadowRoot || null;
    }

    // Security invariant: If closed Shadow DOM attachment fails, NEVER fall back to light DOM!
    if (!this.shadow) {
      logger.error('Failed to attach closed ShadowRoot for recovery overlay; disabling overlay.');
      this.destroy();
      return;
    }

    // Inject isolated stylesheet
    const styleEl = document.createElement('style');
    styleEl.textContent = OVERLAY_STYLES;
    this.shadow.appendChild(styleEl);

    // Root overlay container
    this.container = document.createElement('div');
    this.container.id = 'streamarchive-overlay-container';
    this.shadow.appendChild(this.container);

    this.isMounted = true;
    this.currentUrl = typeof window !== 'undefined' ? window.location.href : '';
    this.refreshSummary();

    // Listeners for repositioning anchored badges upon scroll or resize and immediate route detection
    if (typeof window !== 'undefined') {
      window.addEventListener('scroll', this.handleScrollOrResize, { passive: true });
      window.addEventListener('resize', this.handleScrollOrResize, { passive: true });
      window.addEventListener('popstate', this.checkNavigationImmediately);
      window.addEventListener('hashchange', this.checkNavigationImmediately);
      if (typeof (window as any).navigation !== 'undefined' && (window as any).navigation.addEventListener) {
        (window as any).navigation.addEventListener('navigate', this.checkNavigationImmediately);
      }
      this.pollInterval = setInterval(this.checkNavigationImmediately, 1000);
    }

    this.setupDomObserver();
  }

  private setupDomObserver(): void {
    if (typeof MutationObserver === 'undefined') return;

    if (typeof document !== 'undefined' && document.body) {
      this.installBodyObserver(document.body);
    } else if (typeof document !== 'undefined') {
      // document_start bootstrap: documentElement exists but body is absent
      this.domContentLoadedHandler = () => {
        if (this.domContentLoadedHandler) {
          document.removeEventListener('DOMContentLoaded', this.domContentLoadedHandler);
          this.domContentLoadedHandler = null;
        }
        if (this.bootstrapObserver) {
          this.bootstrapObserver.disconnect();
          this.bootstrapObserver = null;
        }
        if (document.body && !this.domMutationObserver && !this.isDestroyed) {
          this.installBodyObserver(document.body);
        }
      };
      document.addEventListener('DOMContentLoaded', this.domContentLoadedHandler);

      if (document.documentElement) {
        this.bootstrapObserver = new MutationObserver(() => {
          if (document.body) {
            if (this.bootstrapObserver) {
              this.bootstrapObserver.disconnect();
              this.bootstrapObserver = null;
            }
            if (this.domContentLoadedHandler) {
              document.removeEventListener('DOMContentLoaded', this.domContentLoadedHandler);
              this.domContentLoadedHandler = null;
            }
            this.installBodyObserver(document.body);
          }
        });
        this.bootstrapObserver.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      }
    }
  }

  private installBodyObserver(body: HTMLElement): void {
    if (this.domMutationObserver || this.isDestroyed) return;
    this.domMutationObserver = new MutationObserver(() => {
      this.checkNavigationImmediately();
      this.handleScrollOrResize();
    });
    this.domMutationObserver.observe(body, {
      childList: true,
      subtree: true,
    });
  }

  private checkNavigationImmediately = (): void => {
    if (this.isDestroyed || !this.isMounted || typeof window === 'undefined') return;
    const nowUrl = window.location.href;
    if (nowUrl !== this.currentUrl) {
      const oldSession = this.currentSessionId;
      const newSession = extractSessionIdFromUrl(nowUrl) || null;
      this.currentUrl = nowUrl;
      if (oldSession !== newSession) {
        this.routeEpoch++;
        this.currentSessionId = newSession;
        this.activeSummary = null;
        this.activeModalMessageId = null;
        this.modalContentCache.clear();
        this.dismissedMessageIds.clear();
        this.render();
      }
      this.refreshSummary();
    }
  };

  getShadowRoot(): ShadowRoot | null {
    return this.shadow;
  }

  getDiagnostics(): {
    isMounted: boolean;
    isDestroyed: boolean;
    currentSessionId: string | null;
    activeSummarySessionId: string | null;
    routeEpoch: number;
    modalContentCacheSize: number;
    dismissedCount: number;
  } {
    return {
      isMounted: this.isMounted,
      isDestroyed: this.isDestroyed,
      currentSessionId: this.currentSessionId,
      activeSummarySessionId: this.activeSummary?.conversationId ?? null,
      routeEpoch: this.routeEpoch,
      modalContentCacheSize: this.modalContentCache.size,
      dismissedCount: this.dismissedMessageIds.size,
    };
  }

  private handleScrollOrResize = (): void => {
    if (this.repositionRaf !== null || this.isDestroyed || !this.isMounted) return;
    this.repositionRaf = requestAnimationFrame(() => {
      this.repositionRaf = null;
      this.render();
    });
  };

  async refreshSummary(): Promise<void> {
    if (this.isDestroyed || !this.isMounted) return;

    if (typeof window !== 'undefined') {
      this.currentUrl = window.location.href;
    }

    const currentEpoch = ++this.routeEpoch;
    const routeSessionId = extractSessionIdFromUrl(this.currentUrl) || null;
    this.currentSessionId = routeSessionId;

    // Route-race invariant: On route change, immediately clear sensitive modal content & summary
    this.activeModalMessageId = null;
    this.modalContentCache.clear();
    this.activeSummary = null;
    this.render();

    // If on homepage or route without session ID, never fetch summary or show overlay
    if (!routeSessionId) {
      return;
    }

    const summary = await this.fetchSummaryImpl(routeSessionId);
    if (this.isDestroyed) return;

    // Discard late response if route navigated away while request was in-flight
    if (this.routeEpoch !== currentEpoch || this.currentSessionId !== routeSessionId) {
      return;
    }

    this.activeSummary = summary;
    this.render();
  }

  private render(): void {
    if (!this.container || this.isDestroyed || !this.isMounted) return;

    // Clear existing overlay nodes cleanly without innerHTML
    while (this.container.firstChild) {
      this.container.removeChild(this.container.firstChild);
    }

    if (!this.activeSummary || this.activeSummary.messages.length === 0) {
      return;
    }

    const availableMessages = this.activeSummary.messages.filter(
      (m) => !this.dismissedMessageIds.has(m.messageId)
    );

    if (availableMessages.length === 0) return;

    const unanchoredMessages: PageRecoveryMessageSummary[] = [];

    // 1. Attempt strong anchored mapping for each message
    for (const msg of availableMessages) {
      let isAnchored = false;
      if (msg.remoteId) {
        const anchor = locateMessageAnchor(msg.remoteId, document);
        if (anchor && anchor.rect.top > -200 && anchor.rect.top < window.innerHeight + 200) {
          isAnchored = true;
          this.renderAnchoredBadge(msg, anchor.rect);
        }
      }
      if (!isAnchored) {
        unanchoredMessages.push(msg);
      }
    }

    // 2. Fallback: render Floating Recovery Tray for unanchored/virtualized messages
    if (unanchoredMessages.length > 0) {
      this.renderFloatingTray(unanchoredMessages);
    }

    // 3. Render Modal if an active message is opened
    if (this.activeModalMessageId) {
      const activeMsg = availableMessages.find((m) => m.messageId === this.activeModalMessageId);
      if (activeMsg) {
        this.renderRecoveryModal(activeMsg);
      } else {
        this.activeModalMessageId = null;
      }
    }
  }

  private renderAnchoredBadge(
    msg: PageRecoveryMessageSummary,
    rect: DOMRect
  ): void {
    const info = getRecoveryLabel(msg);
    const badge = document.createElement('div');
    badge.className = `streamarchive-anchored-badge ${info.className}`;
    badge.style.top = `${Math.max(10, rect.top - 32)}px`;
    badge.style.left = `${Math.max(10, rect.left + 12)}px`;

    const icon = document.createTextNode(info.icon);
    const text = document.createTextNode(info.badgeLabel);
    badge.appendChild(icon);
    badge.appendChild(text);

    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openRecoveryModal(msg.messageId);
    });

    this.container?.appendChild(badge);
  }

  private renderFloatingTray(messages: PageRecoveryMessageSummary[]): void {
    const tray = document.createElement('div');
    tray.className = 'streamarchive-floating-tray';

    // Tray Header
    const header = document.createElement('div');
    header.className = 'streamarchive-tray-header';

    const title = document.createElement('div');
    title.className = 'streamarchive-tray-title';
    title.appendChild(document.createTextNode('🛡️ StreamArchive'));
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'streamarchive-tray-close';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Dismiss recovery tray';
    closeBtn.addEventListener('click', () => {
      for (const m of messages) {
        this.dismissedMessageIds.add(m.messageId);
      }
      this.render();
    });
    header.appendChild(closeBtn);
    tray.appendChild(header);

    // List unanchored items (zero snippet/body text preview)
    for (const msg of messages) {
      const info = getRecoveryLabel(msg);
      const item = document.createElement('div');
      item.className = 'streamarchive-tray-item';

      const desc = document.createElement('div');
      desc.className = 'streamarchive-item-desc';
      const timeStr = msg.capturedAt ? new Date(msg.capturedAt).toLocaleTimeString() : '';
      desc.textContent = `${info.trayPrefix}Captured ${timeStr ? `at ${timeStr}` : 'before filter'}`;
      item.appendChild(desc);

      item.addEventListener('click', () => {
        this.openRecoveryModal(msg.messageId);
      });

      tray.appendChild(item);
    }

    this.container?.appendChild(tray);
  }

  private async openRecoveryModal(messageId: string): Promise<void> {
    const currentEpoch = this.routeEpoch;
    const currentSession = this.currentSessionId;
    this.activeModalMessageId = messageId;
    this.render();

    // Lazy load content on demand via dedicated endpoint if not cached
    if (!this.modalContentCache.has(messageId)) {
      const msg = this.activeSummary?.messages.find((m) => m.messageId === messageId);
      if (msg && currentSession) {
        const content = await this.fetchContentImpl({
          currentRouteSessionId: currentSession,
          messageId: msg.messageId,
          recoveryEventId: msg.recoveryEventId,
        });
        if (content && !this.isDestroyed) {
          // Route-race invariant: Discard modal response if route navigated while fetching
          if (this.routeEpoch === currentEpoch && this.currentSessionId === currentSession) {
            this.modalContentCache.set(messageId, content);
            this.render();
          }
        }
      }
    }
  }

  private renderRecoveryModal(msg: PageRecoveryMessageSummary): void {
    const info = getRecoveryLabel(msg);
    const backdrop = document.createElement('div');
    backdrop.className = 'streamarchive-recovery-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        this.activeModalMessageId = null;
        this.render();
      }
    });

    const card = document.createElement('div');
    card.className = 'streamarchive-recovery-card';

    // Header
    const header = document.createElement('div');
    header.className = 'streamarchive-card-header';

    const statusBadge = document.createElement('span');
    statusBadge.className = `streamarchive-card-status-badge ${info.className}`;
    statusBadge.textContent = info.cardLabel;
    header.appendChild(statusBadge);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'streamarchive-tray-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => {
      this.activeModalMessageId = null;
      this.render();
    });
    header.appendChild(closeBtn);
    card.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'streamarchive-card-body';

    const cached = this.modalContentCache.get(msg.messageId);

    if (!cached) {
      const loading = document.createElement('div');
      loading.textContent = 'Loading recovered content from local storage...';
      loading.style.color = '#8b949e';
      body.appendChild(loading);
    } else {
      // Thinking trace collapsed by default if present
      if (cached.thinking && cached.thinking.trim().length > 0) {
        const details = document.createElement('details');
        details.className = 'streamarchive-thinking-details';

        const summary = document.createElement('summary');
        summary.className = 'streamarchive-thinking-summary';
        summary.textContent = 'Thought Process (Recovered)';
        details.appendChild(summary);

        const thinkingPre = document.createElement('pre');
        thinkingPre.className = 'streamarchive-thinking-content';
        thinkingPre.textContent = cached.thinking;
        details.appendChild(thinkingPre);

        body.appendChild(details);
      }

      // Safe response text (pure DOM element construction, zero innerHTML)
      const textDiv = document.createElement('div');
      textDiv.className = 'streamarchive-text-content';
      textDiv.textContent = cached.text || '(Empty response)';
      body.appendChild(textDiv);
    }

    // Actions Footer
    const footer = document.createElement('div');
    footer.className = 'streamarchive-card-footer';

    if (cached) {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'streamarchive-action-btn primary';
      copyBtn.textContent = 'Copy Recovered Answer';
      copyBtn.addEventListener('click', async () => {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard) {
            await navigator.clipboard.writeText(cached.text);
            copyBtn.textContent = 'Copied!';
            setTimeout(() => {
              copyBtn.textContent = 'Copy Recovered Answer';
            }, 2000);
          }
        } catch {
          copyBtn.textContent = 'Failed to copy';
        }
      });
      footer.appendChild(copyBtn);
    }

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'streamarchive-action-btn secondary';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', () => {
      this.dismissedMessageIds.add(msg.messageId);
      this.activeModalMessageId = null;
      this.render();
    });
    footer.appendChild(dismissBtn);

    card.appendChild(body);
    card.appendChild(footer);
    backdrop.appendChild(card);
    this.container?.appendChild(backdrop);
  }

  destroy(): void {
    this.isDestroyed = true;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.repositionRaf !== null) {
      cancelAnimationFrame(this.repositionRaf);
      this.repositionRaf = null;
    }
    if (this.bootstrapObserver) {
      this.bootstrapObserver.disconnect();
      this.bootstrapObserver = null;
    }
    if (this.domContentLoadedHandler && typeof document !== 'undefined') {
      document.removeEventListener('DOMContentLoaded', this.domContentLoadedHandler);
      this.domContentLoadedHandler = null;
    }
    if (this.domMutationObserver) {
      this.domMutationObserver.disconnect();
      this.domMutationObserver = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('scroll', this.handleScrollOrResize);
      window.removeEventListener('resize', this.handleScrollOrResize);
      window.removeEventListener('popstate', this.checkNavigationImmediately);
      window.removeEventListener('hashchange', this.checkNavigationImmediately);
      if (typeof (window as any).navigation !== 'undefined' && (window as any).navigation.removeEventListener) {
        (window as any).navigation.removeEventListener('navigate', this.checkNavigationImmediately);
      }
    }
    if (this.rootHost && OWNED_PORTAL_HOSTS.has(this.rootHost)) {
      try {
        this.rootHost.remove();
      } catch {
        // ignore
      }
      OWNED_PORTAL_HOSTS.delete(this.rootHost);
      this.rootHost = null;
    }
    this.shadow = null;
    this.container = null;
    this.activeSummary = null;
    this.modalContentCache.clear();
  }
}
