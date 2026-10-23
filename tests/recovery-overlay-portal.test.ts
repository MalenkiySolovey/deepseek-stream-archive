// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamArchiveOverlayPortal } from '../src/overlay/portal';
import type { PageRecoverySummary } from '../src/adapters/deepseek/dom/types';

describe('StreamArchive In-Page Recovery Overlay Portal (Shadow DOM)', () => {
  let mountContainer: HTMLElement;
  let deepseekContainer: HTMLElement;

  beforeEach(() => {
    window.history.pushState({}, '', '/a/chat/s/sess-test-1');

    mountContainer = document.createElement('div');
    mountContainer.id = 'test-mount-root';
    document.body.appendChild(mountContainer);

    deepseekContainer = document.createElement('main');
    deepseekContainer.id = 'deepseek-page-content';
    document.body.appendChild(deepseekContainer);
  });

  afterEach(() => {
    if (mountContainer.parentNode) {
      mountContainer.parentNode.removeChild(mountContainer);
    }
    if (deepseekContainer.parentNode) {
      deepseekContainer.parentNode.removeChild(deepseekContainer);
    }
  });

  it('mounts Shadow DOM portal at top-level root without mutating DeepSeek page DOM', async () => {
    const mockSummary: PageRecoverySummary = {
      conversationId: 'conv-test-1',
      recoverableCount: 0,
      messages: [],
    };

    const fetchSummary = vi.fn().mockResolvedValue(mockSummary);
    const fetchContent = vi.fn().mockResolvedValue(null);

    const portal = new StreamArchiveOverlayPortal({
      mountTarget: mountContainer,
      fetchSummary,
      fetchContent,
    });

    const host = mountContainer.querySelector('div[data-streamarchive-overlay-root]');
    expect(host).not.toBeNull();
    expect(fetchSummary).toHaveBeenCalledWith('sess-test-1');

    // Verify DeepSeek page container was untouched
    expect(deepseekContainer.children.length).toBe(0);

    portal.destroy();
    expect(mountContainer.querySelector('div[data-streamarchive-overlay-root]')).toBeNull();
  });

  it('renders anchored badge for strong identity match and falls back to floating tray for unanchored', async () => {
    window.history.pushState({}, '', '/a/chat/s/sess-test-2');

    // 1. Create DeepSeek DOM message node for strong match
    const domMsg = document.createElement('div');
    domMsg.setAttribute('data-message-id', 'remote-msg-strong');
    domMsg.textContent = 'Original Canned Response in DeepSeek DOM';
    deepseekContainer.appendChild(domMsg);

    const initialDomMsgHtml = domMsg.outerHTML;

    // Mock summary with 1 anchored and 1 unanchored message
    const mockSummary: PageRecoverySummary = {
      conversationId: 'conv-test-2',
      recoverableCount: 2,
      messages: [
        {
          messageId: 'm-strong',
          remoteId: 'remote-msg-strong',
          role: 'assistant',
          status: 'filtered',
          hasLastGood: true,
          recoveryKind: 'authoritative_recovery',
          capturedAt: 1000,
          recoveredRevisionId: 'rev-strong',
          recoveryEventId: 'ev-strong',
        },
        {
          messageId: 'm-weak',
          role: 'assistant',
          status: 'filtered',
          hasLastGood: true,
          recoveryKind: 'authoritative_recovery',
          capturedAt: 1050,
          recoveredRevisionId: 'rev-weak',
          recoveryEventId: 'ev-weak',
        },
      ],
    };

    const fetchSummary = vi.fn().mockResolvedValue(mockSummary);
    const fetchContent = vi.fn().mockResolvedValue({
      text: 'Full uncensored theorem proof text restored from StreamArchive.',
      thinking: 'Complete reasoning chain recovered.',
    });

    const portal = new StreamArchiveOverlayPortal({
      mountTarget: mountContainer,
      fetchSummary,
      fetchContent,
    });

    await portal.refreshSummary();

    const host = mountContainer.querySelector('div[data-streamarchive-overlay-root]') as HTMLElement;
    expect(host).not.toBeNull();

    // Shadow DOM inspection
    const shadow = portal.getShadowRoot()!;
    expect(shadow).toBeDefined();

    // 1. Anchored badge must be present
    const anchoredBadge = shadow.querySelector('.streamarchive-anchored-badge') as HTMLElement;
    expect(anchoredBadge).not.toBeNull();
    expect(anchoredBadge.textContent).toContain('Recovered Pre-Filter Response');

    // 2. Floating tray must be present for unanchored message without sensitive text snippet
    const floatingTray = shadow.querySelector('.streamarchive-floating-tray') as HTMLElement;
    expect(floatingTray).not.toBeNull();
    expect(floatingTray.textContent).toContain('[Recovered Original]');
    expect(floatingTray.textContent).not.toContain('theorem proof'); // Zero snippet leak

    // 3. Invariant: DeepSeek DOM node was NEVER modified
    expect(domMsg.outerHTML).toBe(initialDomMsgHtml);

    // 4. Lazy loading check: fetchContent was NOT called yet
    expect(fetchContent).not.toHaveBeenCalled();

    // 5. User clicks anchored badge -> triggers lazy content fetch and opens modal
    anchoredBadge.click();

    // Allow async fetchContent resolution
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchContent).toHaveBeenCalledWith({
      currentRouteSessionId: 'sess-test-2',
      messageId: 'm-strong',
      recoveryEventId: 'ev-strong',
    });

    // Modal must be open inside Shadow DOM
    const card = shadow.querySelector('.streamarchive-recovery-card') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('Full uncensored theorem proof text');
    expect(card.textContent).toContain('Complete reasoning chain recovered.');

    // 6. Test Dismiss button
    const buttons = Array.from(card.querySelectorAll('button'));
    const dismissBtn = buttons.find((b) => b.textContent?.includes('Dismiss'));
    expect(dismissBtn).toBeDefined();
    dismissBtn!.click();

    // Modal closed and anchored badge removed for dismissed message
    expect(shadow.querySelector('.streamarchive-recovery-card')).toBeNull();
    expect(shadow.querySelector('.streamarchive-anchored-badge')).toBeNull();

    portal.destroy();
  });

  it('enforces privacy boundary: zero fetch on homepage and immediate route isolation on navigation', async () => {
    // 1. On homepage, no fetchSummary is performed
    window.history.pushState({}, '', '/');
    const fetchSummary = vi.fn().mockResolvedValue(null);
    const fetchContent = vi.fn().mockResolvedValue(null);

    const portal = new StreamArchiveOverlayPortal({
      mountTarget: mountContainer,
      fetchSummary,
      fetchContent,
    });

    await portal.refreshSummary();
    expect(fetchSummary).not.toHaveBeenCalled();

    // 2. Navigate to Session A -> summary is fetched
    window.history.pushState({}, '', '/a/chat/s/session-A');
    fetchSummary.mockResolvedValueOnce({
      conversationId: 'session-A',
      recoverableCount: 1,
      messages: [
        {
          messageId: 'msg-A',
          remoteId: 'remote-A',
          role: 'assistant',
          status: 'filtered',
          hasLastGood: true,
          recoveryKind: 'authoritative_recovery',
          capturedAt: 2000,
          recoveredRevisionId: 'rev-A',
        },
      ],
    });

    await portal.refreshSummary();
    expect(fetchSummary).toHaveBeenCalledWith('session-A');

    // 3. Navigate away to Session B -> immediately clears Session A state
    window.history.pushState({}, '', '/a/chat/s/session-B');
    fetchSummary.mockResolvedValueOnce({
      conversationId: 'session-B',
      recoverableCount: 0,
      messages: [],
    });

    await portal.refreshSummary();
    expect(fetchSummary).toHaveBeenCalledWith('session-B');

    portal.destroy();
  });

  it('enforces root isolation and leaves page-owned spoof root completely untouched', () => {
    // Foreign spoof root in DOM
    const spoofRoot = document.createElement('div');
    spoofRoot.setAttribute('data-streamarchive-overlay-root', 'true');
    spoofRoot.textContent = 'page-owned spoof element';
    mountContainer.appendChild(spoofRoot);
    const initialSpoofHtml = spoofRoot.outerHTML;

    const portal = new StreamArchiveOverlayPortal({
      mountTarget: mountContainer,
      fetchSummary: vi.fn(),
      fetchContent: vi.fn(),
    });

    // Foreign spoof root should NOT be mutated or removed; owned host coexists
    const allHosts = mountContainer.querySelectorAll('div[data-streamarchive-overlay-root]');
    expect(allHosts.length).toBe(2);
    expect(spoofRoot.outerHTML).toBe(initialSpoofHtml);

    portal.destroy();

    // After destroy, only the owned host is removed; foreign spoof root remains intact
    const remainingHosts = mountContainer.querySelectorAll('div[data-streamarchive-overlay-root]');
    expect(remainingHosts.length).toBe(1);
    expect(remainingHosts[0]).toBe(spoofRoot);
    expect(spoofRoot.outerHTML).toBe(initialSpoofHtml);
  });

  it('disables overlay safely if Shadow DOM attachment fails', () => {
    const attachSpy = vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementationOnce(() => {
      throw new Error('Shadow DOM attachment disabled or failed');
    });

    const portal = new StreamArchiveOverlayPortal({
      mountTarget: mountContainer,
      fetchSummary: vi.fn(),
      fetchContent: vi.fn(),
    });

    // Verify host was cleaned up and no shadow root is attached
    expect(mountContainer.querySelector('div[data-streamarchive-overlay-root]')).toBeNull();
    portal.destroy();
    attachSpy.mockRestore();
  });

  describe('Route-race isolation & Privacy boundary', () => {
    it('immediately revokes Session A modal and summary when navigating to Session B before B resolves', async () => {
      window.history.pushState({}, '', '/a/chat/s/session-A');

      let resolveSummaryB: ((val: PageRecoverySummary) => void) | null = null;
      const summaryBPromise = new Promise<PageRecoverySummary>((resolve) => {
        resolveSummaryB = resolve;
      });

      const summaryA: PageRecoverySummary = {
        conversationId: 'session-A',
        recoverableCount: 1,
        messages: [
          {
            messageId: 'msg-A',
            role: 'assistant',
            status: 'filtered',
            hasLastGood: true,
            recoveryKind: 'authoritative_recovery',
            capturedAt: 1000,
            recoveredRevisionId: 'rev-A',
            recoveryEventId: 'ev-A',
          },
        ],
      };

      const fetchSummary = vi.fn().mockImplementation((sessionId: string) => {
        if (sessionId === 'session-A') return Promise.resolve(summaryA);
        if (sessionId === 'session-B') return summaryBPromise;
        return Promise.resolve(null);
      });

      const fetchContent = vi.fn().mockResolvedValue({
        text: 'Sensitive Secret Answer A',
        thinking: 'Secret thinking A',
        recoveredRevisionId: 'rev-A',
        recoveryEventId: 'ev-A',
        capturedAt: 1000,
        isLastGood: true,
      });

      const portal = new StreamArchiveOverlayPortal({
        mountTarget: mountContainer,
        fetchSummary,
        fetchContent,
      });

      // Wait for session A summary to load
      await vi.waitFor(() => {
        expect(portal.getDiagnostics().activeSummarySessionId).toBe('session-A');
      });

      // Open modal in session A (unanchored message renders in floating tray)
      const shadowRoot = portal.getShadowRoot()!;
      const inspectBtn = (shadowRoot.querySelector('.streamarchive-tray-item') ||
        shadowRoot.querySelector('.streamarchive-anchored-badge')) as HTMLElement;
      expect(inspectBtn).not.toBeNull();
      inspectBtn.click();

      // Wait for modal content to render
      await vi.waitFor(() => {
        const modal = shadowRoot.querySelector('.streamarchive-recovery-backdrop');
        expect(modal).not.toBeNull();
        expect(modal!.textContent).toContain('Sensitive Secret Answer A');
      });

      // Now navigate to session B
      window.history.pushState({}, '', '/a/chat/s/session-B');
      // Trigger popstate/route check
      window.dispatchEvent(new PopStateEvent('popstate'));

      // Invariant: Modal and Session A content MUST immediately disappear before Session B resolves!
      const modalAfterNav = shadowRoot.querySelector('.streamarchive-recovery-backdrop');
      expect(modalAfterNav).toBeNull();
      expect(portal.getDiagnostics().activeSummarySessionId).toBeNull();

      // Now resolve Session B
      resolveSummaryB!({
        conversationId: 'session-B',
        recoverableCount: 0,
        messages: [],
      });

      await vi.waitFor(() => {
        expect(portal.getDiagnostics().activeSummarySessionId).toBe('session-B');
      });

      // Confirm no trace of Session A content
      expect(shadowRoot.innerHTML).not.toContain('Sensitive Secret Answer A');

      portal.destroy();
    });

    it('discards out-of-order slow summary from Session A when fast Session B already resolved', async () => {
      window.history.pushState({}, '', '/a/chat/s/session-slow-A');

      let resolveSlowA: ((val: PageRecoverySummary) => void) | null = null;
      const slowAPromise = new Promise<PageRecoverySummary>((resolve) => {
        resolveSlowA = resolve;
      });

      const fetchSummary = vi.fn().mockImplementation((sessionId: string) => {
        if (sessionId === 'session-slow-A') return slowAPromise;
        if (sessionId === 'session-fast-B') {
          return Promise.resolve({
            conversationId: 'session-fast-B',
            recoverableCount: 1,
            messages: [
              {
                messageId: 'msg-B',
                role: 'assistant',
                status: 'filtered',
                hasLastGood: true,
                recoveryKind: 'authoritative_recovery',
                capturedAt: 2000,
                recoveredRevisionId: 'rev-B',
                recoveryEventId: 'ev-B',
              },
            ],
          });
        }
        return Promise.resolve(null);
      });

      const portal = new StreamArchiveOverlayPortal({
        mountTarget: mountContainer,
        fetchSummary,
        fetchContent: vi.fn(),
      });

      // Navigate to B while A is still pending
      window.history.pushState({}, '', '/a/chat/s/session-fast-B');
      window.dispatchEvent(new PopStateEvent('popstate'));

      // Wait for B to resolve
      await vi.waitFor(() => {
        expect(portal.getDiagnostics().activeSummarySessionId).toBe('session-fast-B');
      });

      // Now slow A resolves late
      resolveSlowA!({
        conversationId: 'session-slow-A',
        recoverableCount: 5,
        messages: [],
      });

      await new Promise((r) => setTimeout(r, 20));

      // B must remain active; slow A was discarded
      expect(portal.getDiagnostics().activeSummarySessionId).toBe('session-fast-B');

      portal.destroy();
    });

    it('scopes message dismissal to current conversation and does not suppress unrelated messages in session B', async () => {
      window.history.pushState({}, '', '/a/chat/s/session-dismiss-A');

      const summaryA: PageRecoverySummary = {
        conversationId: 'session-dismiss-A',
        recoverableCount: 1,
        messages: [
          {
            messageId: 'shared-id-123',
            role: 'assistant',
            status: 'filtered',
            hasLastGood: true,
            recoveryKind: 'authoritative_recovery',
            capturedAt: 1000,
            recoveredRevisionId: 'rev-A',
            recoveryEventId: 'ev-A',
          },
        ],
      };

      const summaryB: PageRecoverySummary = {
        conversationId: 'session-dismiss-B',
        recoverableCount: 1,
        messages: [
          {
            messageId: 'shared-id-123',
            role: 'assistant',
            status: 'filtered',
            hasLastGood: true,
            recoveryKind: 'authoritative_recovery',
            capturedAt: 2000,
            recoveredRevisionId: 'rev-B',
            recoveryEventId: 'ev-B',
          },
        ],
      };

      const fetchSummary = vi.fn().mockImplementation((sessionId: string) => {
        if (sessionId === 'session-dismiss-A') return Promise.resolve(summaryA);
        if (sessionId === 'session-dismiss-B') return Promise.resolve(summaryB);
        return Promise.resolve(null);
      });

      const portal = new StreamArchiveOverlayPortal({
        mountTarget: mountContainer,
        fetchSummary,
        fetchContent: vi.fn(),
      });

      await vi.waitFor(() => {
        expect(portal.getDiagnostics().activeSummarySessionId).toBe('session-dismiss-A');
      });

      // Dismiss the message in A via tray close
      const shadowRoot = portal.getShadowRoot()!;
      const dismissBtn = shadowRoot.querySelector('.streamarchive-tray-close') as HTMLElement;
      expect(dismissBtn).not.toBeNull();
      dismissBtn.click();

      // Badge/tray in A is dismissed
      expect(shadowRoot.querySelector('.streamarchive-floating-tray')).toBeNull();

      // Navigate to B
      window.history.pushState({}, '', '/a/chat/s/session-dismiss-B');
      window.dispatchEvent(new PopStateEvent('popstate'));

      await vi.waitFor(() => {
        expect(portal.getDiagnostics().activeSummarySessionId).toBe('session-dismiss-B');
      });

      // Invariant: Dismissal was conversation-scoped; tray in B must be visible!
      expect(shadowRoot.querySelector('.streamarchive-floating-tray')).not.toBeNull();

      portal.destroy();
    });
  });

  describe('document_start body bootstrap lifecycle', () => {
    it('defers body observer installation until document.body exists', () => {
      // Simulate document_start where document.body is not yet present
      const originalBody = document.body;
      const fakeDocElement = document.createElement('html');
      const fakeHead = document.createElement('head');
      fakeDocElement.appendChild(fakeHead);

      // Mount into docElement without body
      const portal = new StreamArchiveOverlayPortal({
        mountTarget: fakeDocElement,
        fetchSummary: vi.fn(),
        fetchContent: vi.fn(),
      });

      expect(portal.getDiagnostics().isMounted).toBe(true);

      // Now simulate body being appended later by HTML parser
      const lateBody = document.createElement('body');
      fakeDocElement.appendChild(lateBody);

      portal.destroy();
      expect(fakeDocElement.querySelector('div[data-streamarchive-overlay-root]')).toBeNull();
    });
  });
});
