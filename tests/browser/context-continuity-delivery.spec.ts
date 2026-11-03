import { test, expect } from './extension-fixture';

test.describe('E2E Browser Compatibility: Explicit Context Delivery & Prompt Augmentation (Milestone 2D.5B)', () => {
  test('verifies strict default OFF preserves original outgoing request untouched', async ({
    page,
  }) => {
    await page.goto('https://chat.deepseek.com/a/chat/s/session-test-default-off');

    let interceptedPostData: string | null = null;
    await page.route('https://chat.deepseek.com/api/v0/chat/completion', async (route) => {
      interceptedPostData = route.request().postData();
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: 'data: {"choices":[]}\n\n',
      });
    });

    await page.evaluate(async () => {
      const payload = {
        chat_session_id: 'session-test-default-off',
        parent_message_id: 'leaf-1',
        prompt: 'User prompt with feature OFF',
        ref_file_ids: [],
        thinking_enabled: true,
        search_enabled: false,
      };

      await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    });

    expect(interceptedPostData).not.toBeNull();
    const parsed = JSON.parse(interceptedPostData!);
    // Prompt must be 100% UNTOUCHED
    expect(parsed.prompt).toBe('User prompt with feature OFF');
    expect(parsed.prompt).not.toContain('[StreamArchive Context Continuity');
  });

  test('arms next message in manual_next mode, augments prompt, disarms for next turn, and stores receipt', async ({
    page,
    loadSidepanel,
  }) => {
    const convId = 'conv-e2e-delivery-manual';
    const remoteSessionId = 'session-delivery-100';

    await page.goto(`https://chat.deepseek.com/a/chat/s/${remoteSessionId}`);
    const sidepanel = await loadSidepanel();

    // 1. Enable Context Continuity in Settings (deliveryMode defaults to manual_next)
    await sidepanel.locator('#tab-settings').click();
    await sidepanel.waitForSelector('.context-continuity-card');

    const toggleContinuity = sidepanel.locator('#toggle-context-continuity');
    await toggleContinuity.check();
    expect(await toggleContinuity.isChecked()).toBe(true);

    // 2. Seed IndexedDB with an eligible conversation and recovered assistant turn
    await sidepanel.evaluate(
      async ({ conversationId, remoteId }) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('StreamArchiveDB');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });

        const tx = db.transaction(
          ['conversations', 'messages', 'revisions', 'recovery_events'],
          'readwrite'
        );

        // Conversation
        tx.objectStore('conversations').put({
          id: conversationId,
          remoteId,
          title: 'Manual Next Delivery Test',
          createdAt: 1000,
          updatedAt: 2000,
        });

        // User turn 1
        tx.objectStore('messages').put({
          id: 'msg-u1',
          conversationId,
          remoteId: 'remote-u1',
          parentId: null,
          role: 'user',
          content: 'Explain relativity in brief',
          createdAt: 1000,
          updatedAt: 1000,
          status: 'finished',
          identityState: 'reconciled',
          projectionState: 'logical',
        });

        // Assistant turn 2 (filtered recovery)
        tx.objectStore('messages').put({
          id: 'msg-a1',
          conversationId,
          remoteId: 'remote-a1',
          parentId: 'msg-u1',
          role: 'assistant',
          createdAt: 2000,
          updatedAt: 2000,
          status: 'filtered',
          identityState: 'reconciled',
          projectionState: 'logical',
        });

        tx.objectStore('revisions').put({
          id: 'rev-a1',
          messageId: 'msg-a1',
          revisionIndex: 1,
          source: 'network',
          status: 'filtered',
          text: 'General relativity states that massive objects warp spacetime.',
          isLastGood: true,
          isFinal: true,
          capturedAt: 2000,
        });

        tx.objectStore('recovery_events').put({
          id: 'rec-1',
          conversationId,
          messageId: 'msg-a1',
          recoveredRevisionId: 'rev-a1',
          kind: 'content_filter',
          detectedAt: 2000,
        });

        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
      { conversationId: convId, remoteId: remoteSessionId }
    );

    // 3. Open conversation in Sidepanel
    await sidepanel.locator('#tab-archive').click();
    await sidepanel.waitForSelector('.conversation-card');
    const card = sidepanel.locator('.conversation-card').filter({ hasText: 'Manual Next Delivery Test' });
    await expect(card).toBeVisible({ timeout: 5000 });
    await card.click();
    await sidepanel.waitForSelector('.messages-thread');

    // 4. Click the Arm button in the Sidepanel header
    const armBtn = sidepanel.locator('#arm-continuity-btn');
    await armBtn.waitFor({ state: 'visible' });
    await armBtn.click();
    // Verify it turns into armed state
    await expect(armBtn).toHaveClass(/armed/);

    // Setup route interception on DeepSeek page
    const postDataCalls: string[] = [];
    await page.route('https://chat.deepseek.com/api/v0/chat/completion', async (route) => {
      postDataCalls.push(route.request().postData() || '');
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: 'data: {"choices":[]}\n\n',
      });
    });

    // 5. DeepSeek page performs generation request 1
    await page.evaluate(async (remoteSessionId) => {
      const payload = {
        chat_session_id: remoteSessionId,
        parent_message_id: 'remote-a1',
        prompt: 'Can you give an analogy for spacetime curvature?',
        ref_file_ids: [],
        thinking_enabled: false,
        search_enabled: false,
      };

      await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }, remoteSessionId);

    expect(postDataCalls.length).toBe(1);
    const parsedReq1 = JSON.parse(postDataCalls[0]!);

    // Prompt MUST be augmented with boundary markers and recovered text
    expect(parsedReq1.prompt).toContain('[StreamArchive Context Continuity v1 — ');
    expect(parsedReq1.prompt).toContain('General relativity states that massive objects warp spacetime.');
    expect(parsedReq1.prompt).toContain('[End StreamArchive Context Continuity]');
    expect(parsedReq1.prompt).toContain('Can you give an analogy for spacetime curvature?');

    // All other fields preserved exactly
    expect(parsedReq1.chat_session_id).toBe(remoteSessionId);
    expect(parsedReq1.parent_message_id).toBe('remote-a1');
    expect(parsedReq1.thinking_enabled).toBe(false);
    expect(parsedReq1.search_enabled).toBe(false);

    // 6. Request 2 (subsequent turn): manual_next was consumed, so prompt 2 is NOT augmented
    await page.evaluate(async (remoteSessionId) => {
      const payload = {
        chat_session_id: remoteSessionId,
        parent_message_id: 'remote-a2',
        prompt: 'Second question should NOT be augmented',
        ref_file_ids: [],
        thinking_enabled: false,
        search_enabled: false,
      };

      await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }, remoteSessionId);

    expect(postDataCalls.length).toBe(2);
    const parsedReq2 = JSON.parse(postDataCalls[1]!);
    expect(parsedReq2.prompt).toBe('Second question should NOT be augmented');
    expect(parsedReq2.prompt).not.toContain('[StreamArchive Context Continuity');

    // 7. Verify receipt recorded in IndexedDB
    await page.waitForTimeout(500);
    const receipts = await sidepanel.evaluate(async (conversationId) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('StreamArchiveDB');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const tx = db.transaction('context_continuity_receipts', 'readonly');
      const idx = tx.objectStore('context_continuity_receipts').index('conversationId');
      const req = idx.getAll(conversationId);
      return new Promise<any[]>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    }, convId);

    expect(receipts.length).toBeGreaterThanOrEqual(1);
    const receipt = receipts[0];
    expect(receipt.conversationId).toBe(convId);
    expect(receipt.remoteConversationId).toBe(remoteSessionId);
    expect(receipt.state).toBe('dispatched');
    expect(receipt.sourceMessageIds).toContain('msg-a1');
  });

  test('verifies automatic mode continuously augments without manual button click', async ({
    page,
    loadSidepanel,
  }) => {
    await page.goto('https://chat.deepseek.com/a/chat/s/session-auto-1');
    const sidepanel = await loadSidepanel();

    // Configure automatic mode in Settings
    await sidepanel.locator('#tab-settings').click();
    await sidepanel.waitForSelector('.context-continuity-card');

    const toggleContinuity = sidepanel.locator('#toggle-context-continuity');
    await toggleContinuity.check();

    // Select Automatic mode
    await sidepanel.locator('input[value="automatic"]').check();

    // Arm envelope for auto mode test
    await page.evaluate(() => {
      const envelope = {
        deliveryId: 'deliv-auto-1',
        conversationId: 'conv-auto-1',
        remoteConversationId: 'session-auto-1',
        expectedParentMessageId: 'parent-auto',
        formattedContext: 'Recovered context from earlier turn',
        sourceMessageIds: ['msg-1'],
        sourceRevisionIds: ['rev-1'],
        deliveryMode: 'automatic',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000,
      };
      window.dispatchEvent(
        new CustomEvent('streamarchive:continuity:arm', {
          detail: JSON.stringify(envelope),
        })
      );
    });

    let autoPostData: string | null = null;
    await page.route('https://chat.deepseek.com/api/v0/chat/completion', async (route) => {
      autoPostData = route.request().postData();
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: 'data: {}\n\n',
      });
    });

    await page.evaluate(async () => {
      const payload = {
        chat_session_id: 'session-auto-1',
        parent_message_id: 'parent-auto',
        prompt: 'Testing automatic injection',
      };

      await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    });

    expect(autoPostData).not.toBeNull();
    const parsed = JSON.parse(autoPostData!);
    expect(parsed.prompt).toContain('[StreamArchive Context Continuity v1 — deliv-auto-1]');
    expect(parsed.prompt).toContain('Testing automatic injection');
  });

  test('fails open and sends original request untouched on session ID mismatch or parent mismatch', async ({
    page,
  }) => {
    await page.goto('https://chat.deepseek.com/a/chat/s/session-target');

    // Arm envelope for specific session and parent
    await page.evaluate(() => {
      const envelope = {
        deliveryId: 'deliv-guard-1',
        conversationId: 'conv-guard-1',
        remoteConversationId: 'session-target',
        expectedParentMessageId: 'leaf-target',
        formattedContext: 'Guarded context',
        sourceMessageIds: ['msg-1'],
        sourceRevisionIds: ['rev-1'],
        deliveryMode: 'manual_next',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000,
      };
      window.dispatchEvent(
        new CustomEvent('streamarchive:continuity:arm', {
          detail: JSON.stringify(envelope),
        })
      );
    });

    let guardPostData: string | null = null;
    await page.route('https://chat.deepseek.com/api/v0/chat/completion', async (route) => {
      guardPostData = route.request().postData();
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: 'data: {}\n\n',
      });
    });

    // Send request targeting DIFFERENT parent (branch switch in DeepSeek)
    await page.evaluate(async () => {
      const payload = {
        chat_session_id: 'session-target',
        parent_message_id: 'different-leaf-parent',
        prompt: 'Prompt on different branch',
      };

      await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    });

    expect(guardPostData).not.toBeNull();
    const parsed = JSON.parse(guardPostData!);
    // Mismatch -> Fail open: prompt must remain completely untouched!
    expect(parsed.prompt).toBe('Prompt on different branch');
    expect(parsed.prompt).not.toContain('[StreamArchive Context Continuity');
  });
});
