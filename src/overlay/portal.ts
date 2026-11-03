import { OVERLAY_STYLES } from './styles';
import { locateMessageAnchor, findInlineInsertionPoint } from '../adapters/deepseek/dom/message-locator';
import type { PageRecoverySummary, PageRecoveryMessageSummary } from '../adapters/deepseek/dom/types';
import {
  MESSAGE_GET_PAGE_RECOVERY_SUMMARY,
  MESSAGE_GET_PAGE_RECOVERY_CONTENT,
  MESSAGE_RECORD_RECOVERY_DIAGNOSTIC,
  type GetPageRecoverySummaryRequest,
  type GetPageRecoverySummaryResponse,
  type GetPageRecoveryContentRequest,
  type GetPageRecoveryContentResponse,
} from '../bridge/messages';
import { extractSessionIdFromUrl } from '../adapters/deepseek/context/session-id';
import { logger } from '../shared/logger';
import {
  type RecoveryPresentationSettings,
  type RecoveryDisplayMode,
  DEFAULT_RECOVERY_PRESENTATION_SETTINGS,
  STORAGE_KEY_RECOVERY_PRESENTATION,
  getRecoveryPresentationSettings,
  validateRecoveryPresentationSettings,
} from '../presentation/settings';
import { mountInlineRecovery, mountCleanUserTurn } from '../presentation/inline-recovery/dom';
import { InlineRecoveryLedger } from '../presentation/inline-recovery/ledger';
import { hasContinuityMarker, parseStreamArchiveAugmentedPrompt } from '../adapters/deepseek/request/marker';

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
  presentationSettings?: Partial<RecoveryPresentationSettings>;
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
  private rootObserver: MutationObserver | null = null;
  private bootstrapObserver: MutationObserver | null = null;
  private earlyDomReadyHandler: (() => void) | null = null;
  private domContentLoadedHandler: (() => void) | null = null;
  private observedBody: HTMLElement | null = null;
  private navigationNavigateHandler: ((e: any) => void) | null = null;
  private navigationCurrentEntryChangeHandler: (() => void) | null = null;
  private originalPushState: typeof history.pushState | null = null;
  private originalReplaceState: typeof history.replaceState | null = null;
  private isDestroyed = false;
  private isMounted = false;

  private presentationSettings: RecoveryPresentationSettings;
  private inlineLedger = new InlineRecoveryLedger();
  private userTurnLedger = new InlineRecoveryLedger();
  private inFlightFetches = new Set<string>();
  private storageListener: ((changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => void) | null = null;

  private readonly fetchSummaryImpl: (currentRouteSessionId?: string) => Promise<PageRecoverySummary | null>;
  private readonly fetchContentImpl: (req: {
    currentRouteSessionId: string;
    messageId: string;
    recoveryEventId?: string;
  }) => Promise<OverlayContentResult | null>;

  constructor(options?: OverlayPortalOptions) {
    this.presentationSettings = options?.presentationSettings
      ? validateRecoveryPresentationSettings(options.presentationSettings)
      : { ...DEFAULT_RECOVERY_PRESENTATION_SETTINGS };

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

    // If options did not override settings, load saved settings from chrome.storage.local
    if (!options?.presentationSettings) {
      getRecoveryPresentationSettings()
        .then((settings) => {
          if (!this.isDestroyed) {
            this.presentationSettings = settings;
            this.render();
          }
        })
        .catch(() => {
          // ignore
        });
    }

    // React immediately to settings changes in chrome.storage.local
    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      this.storageListener = (changes, areaName) => {
        if (areaName === 'local' && changes[STORAGE_KEY_RECOVERY_PRESENTATION]) {
          const updated = validateRecoveryPresentationSettings(
            changes[STORAGE_KEY_RECOVERY_PRESENTATION].newValue
          );
          this.setPresentationSettings(updated);
        }
      };
      chrome.storage.onChanged.addListener(this.storageListener);
    }

    this.initPortal(options?.mountTarget);
  }

  private initPortal(customMount?: HTMLElement): void {
    if (this.isDestroyed || typeof document === 'undefined') return;

    // Handle document_start execution where documentElement might not yet exist
    if (!document.documentElement && !customMount) {
      this.earlyDomReadyHandler = () => {
        if (this.earlyDomReadyHandler && typeof document !== 'undefined') {
          document.removeEventListener('DOMContentLoaded', this.earlyDomReadyHandler);
          this.earlyDomReadyHandler = null;
        }
        if (!this.isDestroyed) {
          this.initPortal(customMount);
        }
      };
      document.addEventListener('DOMContentLoaded', this.earlyDomReadyHandler);
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

      // Chromium Navigation API: Pre-navigation revocation via 'navigate' and post-commit via 'currententrychange'
      if (typeof (window as any).navigation !== 'undefined') {
        const nav = (window as any).navigation;
        if (typeof nav.addEventListener === 'function') {
          this.navigationNavigateHandler = (e: any) => {
            if (this.isDestroyed || !this.isMounted) return;
            const destUrl = e.destination?.url;
            if (destUrl && typeof destUrl === 'string') {
              const destSession = extractSessionIdFromUrl(destUrl) || null;
              if (destSession !== this.currentSessionId) {
                // Pre-navigation revocation: purge previous session state immediately
                this.preRevokeRouteState(destSession);
              }
            }
          };
          nav.addEventListener('navigate', this.navigationNavigateHandler);

          this.navigationCurrentEntryChangeHandler = () => {
            this.checkNavigationImmediately();
          };
          nav.addEventListener('currententrychange', this.navigationCurrentEntryChangeHandler);
        }
      }

      // Hook history.pushState and replaceState to detect SPA navigation without artificial popstate dispatch
      if (typeof history !== 'undefined') {
        this.originalPushState = history.pushState;
        this.originalReplaceState = history.replaceState;

        const portal = this;
        history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
          const urlArg = args[2];
          if (urlArg && typeof urlArg === 'string' && typeof window !== 'undefined') {
            try {
              const targetUrl = new URL(urlArg, window.location.href).href;
              const targetSession = extractSessionIdFromUrl(targetUrl) || null;
              if (targetSession !== portal.currentSessionId) {
                portal.preRevokeRouteState(targetSession);
              }
            } catch {
              // ignore invalid url
            }
          }
          const res = portal.originalPushState?.apply(this, args);
          portal.checkNavigationImmediately();
          return res;
        };

        history.replaceState = function (this: History, ...args: Parameters<History['replaceState']>) {
          const urlArg = args[2];
          if (urlArg && typeof urlArg === 'string' && typeof window !== 'undefined') {
            try {
              const targetUrl = new URL(urlArg, window.location.href).href;
              const targetSession = extractSessionIdFromUrl(targetUrl) || null;
              if (targetSession !== portal.currentSessionId) {
                portal.preRevokeRouteState(targetSession);
              }
            } catch {
              // ignore invalid url
            }
          }
          const res = portal.originalReplaceState?.apply(this, args);
          portal.checkNavigationImmediately();
          return res;
        };
      }

      this.pollInterval = setInterval(this.checkNavigationImmediately, 1000);
    }

    this.setupDomObserver();
  }

  private preRevokeRouteState(newSessionId: string | null): void {
    if (this.isDestroyed) return;
    this.routeEpoch++;
    this.currentSessionId = newSessionId;
    this.activeSummary = null;
    this.activeModalMessageId = null;
    this.modalContentCache.clear();
    this.dismissedMessageIds.clear();
    this.inFlightFetches.clear();
    this.inlineLedger.unmountAll();
    this.userTurnLedger.unmountAll();
    this.render();
  }

  private setupDomObserver(): void {
    if (typeof MutationObserver === 'undefined') return;

    if (typeof document !== 'undefined') {
      if (document.body) {
        this.installBodyObserver(document.body);
      } else {
        // document_start bootstrap: documentElement exists but body is absent
        this.domContentLoadedHandler = () => {
          if (this.domContentLoadedHandler) {
            document.removeEventListener('DOMContentLoaded', this.domContentLoadedHandler);
            this.domContentLoadedHandler = null;
          }
          if (document.body && !this.isDestroyed) {
            this.installBodyObserver(document.body);
          }
        };
        document.addEventListener('DOMContentLoaded', this.domContentLoadedHandler);
      }

      // Root-level watcher on documentElement to detect body appearance or dynamic replacement
      if (document.documentElement) {
        this.rootObserver = new MutationObserver(() => {
          if (this.isDestroyed) return;
          if (document.body && document.body !== this.observedBody) {
            this.installBodyObserver(document.body);
          }
        });
        this.rootObserver.observe(document.documentElement, { childList: true });
      }
    }
  }

  private installBodyObserver(body: HTMLElement): void {
    if (this.isDestroyed) return;
    this.observedBody = body;
    if (this.domMutationObserver) {
      this.domMutationObserver.disconnect();
      this.domMutationObserver = null;
    }
    this.domMutationObserver = new MutationObserver(() => {
      if (this.isDestroyed) return;
      if (document.body && document.body !== this.observedBody) {
        this.installBodyObserver(document.body);
        return;
      }
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
        this.inFlightFetches.clear();
        this.inlineLedger.unmountAll();
        this.userTurnLedger.unmountAll();
        this.render();
      }
      this.refreshSummary();
    }
  };

  getShadowRoot(): ShadowRoot | null {
    return this.shadow;
  }

  getPresentationSettings(): RecoveryPresentationSettings {
    return { ...this.presentationSettings };
  }

  setPresentationSettings(settings: Partial<RecoveryPresentationSettings>): void {
    const previous = this.presentationSettings;
    const updated = validateRecoveryPresentationSettings({
      ...this.presentationSettings,
      ...settings,
    });
    this.presentationSettings = updated;

    if (previous.displayMode === 'inline' && updated.displayMode === 'overlay') {
      this.inlineLedger.unmountAll();
    }
    if (previous.displayMode === 'overlay' && updated.displayMode === 'inline') {
      this.activeModalMessageId = null;
    }
    if (
      previous.displayMode === 'inline' &&
      updated.displayMode === 'inline' &&
      previous.showThinkingInline !== updated.showThinkingInline
    ) {
      this.inlineLedger.unmountAll();
    }
    this.render();
  }

  getInlineLedger(): InlineRecoveryLedger {
    return this.inlineLedger;
  }

  getDiagnostics(): {
    isMounted: boolean;
    isDestroyed: boolean;
    currentSessionId: string | null;
    activeSummarySessionId: string | null;
    routeEpoch: number;
    modalContentCacheSize: number;
    dismissedCount: number;
    displayMode: RecoveryDisplayMode;
    inlineMountedCount: number;
  } {
    return {
      isMounted: this.isMounted,
      isDestroyed: this.isDestroyed,
      currentSessionId: this.currentSessionId,
      activeSummarySessionId: this.activeSummary?.conversationId ?? null,
      routeEpoch: this.routeEpoch,
      modalContentCacheSize: this.modalContentCache.size,
      dismissedCount: this.dismissedMessageIds.size,
      displayMode: this.presentationSettings.displayMode,
      inlineMountedCount: this.inlineLedger.size,
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
    this.inFlightFetches.clear();
    this.inlineLedger.unmountAll();
    this.userTurnLedger.unmountAll();
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
      this.inlineLedger.unmountAll();
      return;
    }

    const availableMessages = this.activeSummary.messages.filter(
      (m) => !this.dismissedMessageIds.has(m.messageId)
    );

    if (availableMessages.length === 0) {
      this.inlineLedger.unmountAll();
      return;
    }

    const unanchoredMessages: PageRecoveryMessageSummary[] = [];

    if (this.presentationSettings.displayMode === 'inline') {
      const currentAvailableMessageIds = new Set(availableMessages.map((m) => m.messageId));

      // Clean up inline hosts that are no longer available (e.g. dismissed)
      for (const handle of this.inlineLedger.getAllHandles()) {
        if (!currentAvailableMessageIds.has(handle.messageId)) {
          this.inlineLedger.unmount(handle.messageId);
        }
      }

      for (const msg of availableMessages) {
        let isAnchored = false;
        if (msg.remoteId) {
          const anchor = locateMessageAnchor(msg.remoteId, document);
          if (anchor && anchor.rect.top > -200 && anchor.rect.top < window.innerHeight + 200) {
            const target = findInlineInsertionPoint(anchor);
            if (target) {
              isAnchored = true;
              const cached = this.modalContentCache.get(msg.messageId);
              if (cached) {
                const existingHandle = this.inlineLedger.get(msg.messageId);
                if (
                  existingHandle &&
                  existingHandle.hostElement.isConnected &&
                  existingHandle.containerElement === target.containerElement
                ) {
                  // Already mounted properly in the DOM
                } else {
                  const handle = mountInlineRecovery(target, msg, cached, {
                    showThinkingInline: this.presentationSettings.showThinkingInline,
                    inlinePlacement: this.presentationSettings.inlinePlacement,
                  });
                  if (handle) {
                    this.inlineLedger.registerHandle(msg.messageId, handle);
                    this.reportRecoveryDiagnostic('inline_success');
                  } else {
                    // Fallback to anchored badge if closed shadow DOM or mount failed
                    this.renderAnchoredBadge(msg, anchor.rect);
                    this.reportRecoveryDiagnostic('fallback_render');
                  }
                }
              } else {
                // Content not yet cached; trigger lazy load and display temporary anchored badge
                this.lazyLoadContent(msg);
                this.renderAnchoredBadge(msg, anchor.rect);
              }
            } else {
              // Anchor found in DOM, but no valid inline insertion target structure
              // Fallback to anchored badge
              isAnchored = true;
              this.renderAnchoredBadge(msg, anchor.rect);
              this.reportRecoveryDiagnostic('fallback_render');
            }
          } else if (anchor) {
            // Anchor exists in DOM but outside current viewport range
            isAnchored = true;
            const target = findInlineInsertionPoint(anchor);
            if (target) {
              const cached = this.modalContentCache.get(msg.messageId);
              if (cached) {
                const existingHandle = this.inlineLedger.get(msg.messageId);
                if (
                  !existingHandle ||
                  !existingHandle.hostElement.isConnected ||
                  existingHandle.containerElement !== target.containerElement
                ) {
                  const handle = mountInlineRecovery(target, msg, cached, {
                    showThinkingInline: this.presentationSettings.showThinkingInline,
                    inlinePlacement: this.presentationSettings.inlinePlacement,
                  });
                  if (handle) {
                    this.inlineLedger.registerHandle(msg.messageId, handle);
                    this.reportRecoveryDiagnostic('inline_success');
                  }
                }
              } else {
                this.lazyLoadContent(msg);
              }
            }
          }
        }

        if (!isAnchored) {
          if (this.inlineLedger.has(msg.messageId)) {
            const handle = this.inlineLedger.get(msg.messageId);
            if (!handle || !handle.hostElement.isConnected) {
              this.inlineLedger.unmount(msg.messageId);
            }
          }
          unanchoredMessages.push(msg);
          this.reportRecoveryDiagnostic('dom_mapping_error');
        }
      }
    } else {
      // Overlay mode: ensure zero inline hosts remain in host DOM
      this.inlineLedger.unmountAll();

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

    // 4. Reconcile user turns containing Context Continuity markers
    this.reconcileUserContinuityTurns();
  }

  private reconcileUserContinuityTurns(): void {
    if (this.isDestroyed || !this.isMounted || typeof document === 'undefined') return;

    const elements = document.querySelectorAll('[data-message-id]');
    const activeDeliveryIds = new Set<string>();

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i] as HTMLElement;
      const target = findInlineInsertionPoint(el);
      if (!target || !target.placeholderElement) continue;

      const rawText = target.placeholderElement.textContent || '';
      if (!hasContinuityMarker(rawText)) continue;

      const parsed = parseStreamArchiveAugmentedPrompt(rawText);
      if (!parsed.isAugmented || !parsed.deliveryId) continue;

      activeDeliveryIds.add(parsed.deliveryId);

      const existing = this.userTurnLedger.get(parsed.deliveryId);
      if (
        existing &&
        existing.hostElement.isConnected &&
        existing.containerElement === target.containerElement
      ) {
        continue;
      }

      const handle = mountCleanUserTurn(target, rawText);
      if (handle) {
        this.userTurnLedger.registerHandle(parsed.deliveryId, handle);
      }
    }

    for (const handle of this.userTurnLedger.getAllHandles()) {
      if (!activeDeliveryIds.has(handle.messageId)) {
        this.userTurnLedger.unmount(handle.messageId);
      }
    }
  }

  private reportRecoveryDiagnostic(kind: 'inline_success' | 'fallback_render' | 'dom_mapping_error'): void {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime
          .sendMessage({
            type: MESSAGE_RECORD_RECOVERY_DIAGNOSTIC,
            kind,
          })
          .catch(() => {});
      }
    } catch {
      // ignore
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
        this.inlineLedger.unmount(m.messageId);
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

  private async lazyLoadContent(msg: PageRecoveryMessageSummary): Promise<void> {
    const messageId = msg.messageId;
    if (this.modalContentCache.has(messageId) || this.inFlightFetches.has(messageId)) {
      return;
    }
    const currentEpoch = this.routeEpoch;
    const currentSession = this.currentSessionId;
    if (!currentSession) return;

    this.inFlightFetches.add(messageId);
    try {
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
    } finally {
      this.inFlightFetches.delete(messageId);
    }
  }

  private async openRecoveryModal(messageId: string): Promise<void> {
    this.activeModalMessageId = messageId;
    const msg = this.activeSummary?.messages.find((m) => m.messageId === messageId);
    if (msg) {
      await this.lazyLoadContent(msg);
    }
    this.render();
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
      this.inlineLedger.unmount(msg.messageId);
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
    if (this.storageListener && typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      chrome.storage.onChanged.removeListener(this.storageListener);
      this.storageListener = null;
    }
    this.inlineLedger.unmountAll();
    this.userTurnLedger.unmountAll();
    this.inFlightFetches.clear();
    if (this.earlyDomReadyHandler && typeof document !== 'undefined') {
      document.removeEventListener('DOMContentLoaded', this.earlyDomReadyHandler);
      this.earlyDomReadyHandler = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.repositionRaf !== null) {
      cancelAnimationFrame(this.repositionRaf);
      this.repositionRaf = null;
    }
    if (this.rootObserver) {
      this.rootObserver.disconnect();
      this.rootObserver = null;
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
    this.observedBody = null;

    if (typeof window !== 'undefined') {
      window.removeEventListener('scroll', this.handleScrollOrResize);
      window.removeEventListener('resize', this.handleScrollOrResize);
      window.removeEventListener('popstate', this.checkNavigationImmediately);
      window.removeEventListener('hashchange', this.checkNavigationImmediately);

      if (typeof (window as any).navigation !== 'undefined') {
        const nav = (window as any).navigation;
        if (this.navigationNavigateHandler && nav.removeEventListener) {
          nav.removeEventListener('navigate', this.navigationNavigateHandler);
          this.navigationNavigateHandler = null;
        }
        if (this.navigationCurrentEntryChangeHandler && nav.removeEventListener) {
          nav.removeEventListener('currententrychange', this.navigationCurrentEntryChangeHandler);
          this.navigationCurrentEntryChangeHandler = null;
        }
      }

      if (this.originalPushState && typeof history !== 'undefined') {
        history.pushState = this.originalPushState;
        this.originalPushState = null;
      }
      if (this.originalReplaceState && typeof history !== 'undefined') {
        history.replaceState = this.originalReplaceState;
        this.originalReplaceState = null;
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
