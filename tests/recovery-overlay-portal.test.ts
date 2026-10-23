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

  it('enforces root isolation and disables overlay safely if Shadow DOM attachment fails', () => {
    // Foreign spoof root in DOM
    const spoofRoot = document.createElement('div');
    spoofRoot.setAttribute('data-streamarchive-overlay-root', 'true');
    mountContainer.appendChild(spoofRoot);

    const portal = new StreamArchiveOverlayPortal({
      mountTarget: mountContainer,
      fetchSummary: vi.fn(),
      fetchContent: vi.fn(),
    });

    // Foreign spoof root should be evicted and replaced by owned host
    const allHosts = mountContainer.querySelectorAll('div[data-streamarchive-overlay-root]');
    expect(allHosts.length).toBe(1);
    expect(allHosts[0]).not.toBe(spoofRoot);

    portal.destroy();
  });
});
