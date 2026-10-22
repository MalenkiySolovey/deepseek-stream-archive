import { OVERLAY_STYLES } from './styles';
import { locateMessageAnchor } from '../adapters/deepseek/dom/message-locator';
import type { PageRecoverySummary, PageRecoveryMessageSummary } from '../adapters/deepseek/dom/types';
import {
  MESSAGE_GET_PAGE_RECOVERY_SUMMARY,
  MESSAGE_GET_REVISION_CONTENT,
  type GetPageRecoverySummaryRequest,
  type GetPageRecoverySummaryResponse,
  type GetRevisionContentRequest,
  type GetRevisionContentResponse,
} from '../bridge/messages';
import { extractSessionIdFromUrl } from '../adapters/deepseek/context/session-id';
import { logger } from '../shared/logger';

export interface OverlayPortalOptions {
  mountTarget?: HTMLElement;
  fetchSummary?: (currentRouteSessionId?: string) => Promise<PageRecoverySummary | null>;
  fetchContent?: (revisionId: string) => Promise<{ text: string; thinking?: string } | null>;
}

export class StreamArchiveOverlayPortal {
  private rootHost: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private container: HTMLElement | null = null;
  private activeSummary: PageRecoverySummary | null = null;
  private dismissedMessageIds = new Set<string>();
  private activeModalMessageId: string | null = null;
  private modalContentCache = new Map<string, { text: string; thinking?: string }>();
  private currentUrl = '';
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private repositionRaf: number | null = null;
  private isDestroyed = false;

  private readonly fetchSummaryImpl: (currentRouteSessionId?: string) => Promise<PageRecoverySummary | null>;
  private readonly fetchContentImpl: (revisionId: string) => Promise<{ text: string; thinking?: string } | null>;

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
      (async (revisionId) => {
        try {
          const res = await chrome.runtime.sendMessage<
            GetRevisionContentRequest,
            GetRevisionContentResponse
          >({
            type: MESSAGE_GET_REVISION_CONTENT,
            revisionId,
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

    const mountParent = customMount || document.documentElement;
    if (!mountParent) return;

    // Check if host already exists
    let existingHost = mountParent.querySelector<HTMLElement>(
      'div[data-streamarchive-overlay-root]'
    );
    if (!existingHost) {
      existingHost = document.createElement('div');
      existingHost.setAttribute('data-streamarchive-overlay-root', 'true');
      mountParent.appendChild(existingHost);
    }
    this.rootHost = existingHost;

    // Attach closed ShadowRoot for full style isolation
    try {
      this.shadow = this.rootHost.attachShadow({ mode: 'closed' });
    } catch {
      // In testing environments where attachShadow might already be called
      this.shadow = (this.rootHost as any).shadowRoot || (this.rootHost as any);
    }

    // Inject stylesheet
    const styleEl = document.createElement('style');
    styleEl.textContent = OVERLAY_STYLES;
    if (this.shadow) {
      this.shadow.appendChild(styleEl);
    }

    // Root overlay container
    this.container = document.createElement('div');
    this.container.id = 'streamarchive-overlay-container';
    if (this.shadow) {
      this.shadow.appendChild(this.container);
    }

    // Initial check
    this.currentUrl = typeof window !== 'undefined' ? window.location.href : '';
    this.refreshSummary();

    // Setup scroll / resize listeners for repositioning anchored badges
    if (typeof window !== 'undefined') {
      window.addEventListener('scroll', this.handleScrollOrResize, { passive: true });
      window.addEventListener('resize', this.handleScrollOrResize, { passive: true });

      // Passive URL observer to detect client-side route changes
      this.pollInterval = setInterval(() => {
        if (this.isDestroyed) return;
        const nowUrl = window.location.href;
        if (nowUrl !== this.currentUrl) {
          this.currentUrl = nowUrl;
          this.refreshSummary();
        }
      }, 1000);
    }
  }

  private handleScrollOrResize = (): void => {
    if (this.repositionRaf !== null || this.isDestroyed) return;
    this.repositionRaf = requestAnimationFrame(() => {
      this.repositionRaf = null;
      this.render();
    });
  };

  async refreshSummary(): Promise<void> {
    if (this.isDestroyed) return;
    const routeSessionId = extractSessionIdFromUrl(this.currentUrl) || undefined;
    const summary = await this.fetchSummaryImpl(routeSessionId);
    if (this.isDestroyed) return;
    this.activeSummary = summary;
    this.render();
  }

  private render(): void {
    if (!this.container || this.isDestroyed) return;

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

    // 2. Fallback: render Floating Recovery Tray for unanchored messages
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
    const badge = document.createElement('div');
    badge.className = `streamarchive-anchored-badge ${msg.status === 'filtered' ? 'filtered' : 'degraded'}`;
    badge.style.top = `${Math.max(10, rect.top - 32)}px`;
    badge.style.left = `${Math.max(10, rect.left + 12)}px`;

    const icon = document.createTextNode(msg.status === 'filtered' ? '🛡️ ' : '⚠️ ');
    const text = document.createTextNode(
      msg.status === 'filtered' ? 'Recovered Pre-Filter Response' : 'Recovered Degraded Response'
    );
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

    // List unanchored items
    for (const msg of messages) {
      const item = document.createElement('div');
      item.className = 'streamarchive-tray-item';

      const desc = document.createElement('div');
      desc.className = 'streamarchive-item-desc';
      const label = msg.status === 'filtered' ? '[Filtered] ' : '[Degraded] ';
      desc.textContent = `${label}${msg.snippet || 'Click to view recovered content'}`;
      item.appendChild(desc);

      item.addEventListener('click', () => {
        this.openRecoveryModal(msg.messageId);
      });

      tray.appendChild(item);
    }

    this.container?.appendChild(tray);
  }

  private async openRecoveryModal(messageId: string): Promise<void> {
    this.activeModalMessageId = messageId;
    this.render();

    // Lazy load content if not cached
    if (!this.modalContentCache.has(messageId)) {
      const msg = this.activeSummary?.messages.find((m) => m.messageId === messageId);
      if (msg?.recoveredRevisionId) {
        const content = await this.fetchContentImpl(msg.recoveredRevisionId);
        if (content && !this.isDestroyed) {
          this.modalContentCache.set(messageId, content);
          this.render();
        }
      }
    }
  }

  private renderRecoveryModal(msg: PageRecoveryMessageSummary): void {
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
    statusBadge.className = `streamarchive-card-status-badge ${msg.status === 'filtered' ? 'filtered' : 'degraded'}`;
    statusBadge.textContent =
      msg.status === 'filtered' ? '🛡️ Filtered (Pre-Filter Preserved)' : '⚠️ Interrupted / Degraded';
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
      // Thinking details if present
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

      // Safe Response Text (zero innerHTML, pre-wrap textContent)
      const textDiv = document.createElement('div');
      textDiv.className = 'streamarchive-text-content';
      textDiv.textContent = cached.text || '(Empty response)';
      body.appendChild(textDiv);
    }

    card.appendChild(body);

    // Footer
    const footer = document.createElement('div');
    footer.className = 'streamarchive-card-footer';

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'streamarchive-btn streamarchive-btn-dismiss';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', () => {
      this.dismissedMessageIds.add(msg.messageId);
      this.activeModalMessageId = null;
      this.render();
    });
    footer.appendChild(dismissBtn);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'streamarchive-btn streamarchive-btn-copy';
    copyBtn.textContent = '📋 Copy Text';
    copyBtn.addEventListener('click', async () => {
      const textToCopy = cached?.text || '';
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          await navigator.clipboard.writeText(textToCopy);
          copyBtn.textContent = '✓ Copied!';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.textContent = '📋 Copy Text';
            copyBtn.classList.remove('copied');
          }, 2000);
        }
      } catch {
        // fail-open
      }
    });
    footer.appendChild(copyBtn);

    card.appendChild(footer);
    backdrop.appendChild(card);
    this.container?.appendChild(backdrop);
  }

  getShadowRoot(): ShadowRoot | null {
    return this.shadow;
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
    if (typeof window !== 'undefined') {
      window.removeEventListener('scroll', this.handleScrollOrResize);
      window.removeEventListener('resize', this.handleScrollOrResize);
    }
    if (this.rootHost && this.rootHost.parentNode) {
      this.rootHost.parentNode.removeChild(this.rootHost);
    }
    this.rootHost = null;
    this.shadow = null;
    this.container = null;
  }
}
