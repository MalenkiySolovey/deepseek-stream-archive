import { test, expect } from './extension-fixture';

test.describe('E2E Browser Compatibility: Context Continuity Planner & Transparent Preview (Milestone 2D.5A)', () => {
  test('verifies default OFF setting, enables continuity, and renders branch-aware preview modal', async ({
    loadSidepanel,
  }) => {
    const sidepanel = await loadSidepanel();

    // 1. Verify default OFF settings in Settings tab
    await sidepanel.locator('#tab-settings').click();
    await sidepanel.waitForSelector('.context-continuity-card');

    const toggleContinuity = sidepanel.locator('#toggle-context-continuity');
    expect(await toggleContinuity.isChecked()).toBe(false);

    // 2. Enable Context Continuity and DeepThink inclusion
    await toggleContinuity.check();
    expect(await toggleContinuity.isChecked()).toBe(true);

    const toggleThinking = sidepanel.locator('#toggle-include-thinking');
    await toggleThinking.check();
    expect(await toggleThinking.isChecked()).toBe(true);

    // Verify storage persistence
    await expect.poll(async () => {
      return await sidepanel.evaluate(async () => {
        const res = await chrome.storage.local.get('streamarchive_context_continuity_settings');
        return res['streamarchive_context_continuity_settings'];
      });
    }).toEqual({
      enabled: true,
      includeThinking: true,
      deliveryMode: 'manual_next',
    });

    // 3. Seed IndexedDB with conversation, filtered turn, sibling branch, and server-history turn
    const convId = 'conv-e2e-continuity';
    await sidepanel.evaluate(async (conversationId) => {
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
        title: 'Quantum Computing Continuity Test',
        createdAt: 1000,
        updatedAt: 5000,
      });

      // Turn 1: User message u1 (root)
      tx.objectStore('messages').put({
        id: 'msg-u1',
        conversationId,
        parentId: null,
        role: 'user',
        seq: 1,
        content: 'Explain quantum entanglement',
        createdAt: 1000,
        updatedAt: 1000,
        status: 'finished',
        projectionState: 'logical',
      });

      // Turn 2: Filtered assistant message a1 (active branch)
      tx.objectStore('messages').put({
        id: 'msg-a1',
        conversationId,
        parentId: 'msg-u1',
        role: 'assistant',
        seq: 2,
        createdAt: 2000,
        updatedAt: 2000,
        status: 'filtered',
        projectionState: 'logical',
      });

      // Revision for a1: recovered answer + thinking
      tx.objectStore('revisions').put({
        id: 'rev-a1',
        messageId: 'msg-a1',
        seq: 1,
        source: 'live_stream',
        status: 'finished',
        text: 'Quantum entanglement occurs when two particles remain connected.',
        thinking: '1. Formulate physical definition.\n2. Note Bell theorem.',
        isLastGood: true,
        createdAt: 2000,
      });

      // RecoveryEvent for a1
      tx.objectStore('recovery_events').put({
        id: 'rec-ev-1',
        conversationId,
        messageId: 'msg-a1',
        recoveredRevisionId: 'rev-a1',
        kind: 'content_filter',
        reason: 'Sensitive topic triggered filter',
        createdAt: 2000,
      });

      // Turn 2 alternate sibling: a1_sibling (not in active branch)
      tx.objectStore('messages').put({
        id: 'msg-a1-sibling',
        conversationId,
        parentId: 'msg-u1',
        role: 'assistant',
        seq: 2,
        createdAt: 2500,
        updatedAt: 2500,
        status: 'finished',
        projectionState: 'logical',
      });
      tx.objectStore('revisions').put({
        id: 'rev-a1-sib',
        messageId: 'msg-a1-sibling',
        seq: 1,
        source: 'live_stream',
        status: 'finished',
        text: 'Alternative sibling generation that was regenerated.',
        isLastGood: true,
        createdAt: 2500,
      });

      // Turn 3: User message u2 (child of a1)
      tx.objectStore('messages').put({
        id: 'msg-u2',
        conversationId,
        parentId: 'msg-a1',
        role: 'user',
        seq: 3,
        content: 'Can entanglement be used for communication?',
        createdAt: 3000,
        updatedAt: 3000,
        status: 'finished',
        projectionState: 'logical',
      });

      // Turn 4: Server-reconciled assistant message a2 (already in DeepSeek history)
      tx.objectStore('messages').put({
        id: 'msg-a2-history',
        conversationId,
        parentId: 'msg-u2',
        role: 'assistant',
        seq: 4,
        createdAt: 4000,
        updatedAt: 4000,
        status: 'finished',
        identityState: 'reconciled',
        projectionState: 'logical',
      });
      tx.objectStore('revisions').put({
        id: 'rev-a2-hist',
        messageId: 'msg-a2-history',
        seq: 1,
        source: 'history',
        status: 'finished',
        text: 'No, entanglement cannot transmit classical information faster than light.',
        createdAt: 4000,
      });

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }, convId);

    // 4. Navigate to Conversations tab and open the test conversation
    await sidepanel.locator('#tab-archive').click();
    await sidepanel.waitForSelector('.conversation-card');

    const card = sidepanel.locator('.conversation-card').filter({ hasText: 'Quantum Computing Continuity Test' });
    await expect(card).toBeVisible({ timeout: 5000 });
    await card.click();

    // 5. Verify ConversationView is displayed and preview button is visible
    const previewBtn = sidepanel.locator('#preview-continuity-btn');
    await expect(previewBtn).toBeVisible({ timeout: 5000 });
    await previewBtn.click();

    // 6. Verify Context Continuity Preview Modal is opened
    const modal = sidepanel.locator('.modal-card');
    await expect(modal).toBeVisible();

    // Check stats grid
    const eligibleCount = modal.locator('.stat-item:has(.stat-desc:has-text("Eligible"), .stat-desc:has-text("Подходящих")) .stat-number');
    await expect(eligibleCount).toHaveText('1');

    // Check payload preview content
    const previewBox = modal.locator('.preview-box');
    await expect(previewBox).toBeVisible();
    const previewContent = await previewBox.textContent();
    expect(previewContent).toContain('[StreamArchive recovered conversation context]');
    expect(previewContent).toContain('Recovery cause: content_filter');
    expect(previewContent).toContain('Recovered DeepThink:');
    expect(previewContent).toContain('1. Formulate physical definition.');
    expect(previewContent).toContain('Quantum entanglement occurs when two particles remain connected.');
    expect(previewContent).toContain('[End StreamArchive recovered conversation context]');

    // Sibling block and reconciled block must NOT be in eligible payload
    expect(previewContent).not.toContain('Alternative sibling generation');
    expect(previewContent).not.toContain('faster than light');

    // Check exclusions section
    const exclusionsDetails = modal.locator('.exclusions-details');
    await expect(exclusionsDetails).toBeVisible();
    await exclusionsDetails.locator('summary').click();

    const exclusionsList = modal.locator('.exclusions-list');
    await expect(exclusionsList).toBeVisible();
    const exclusionsText = await exclusionsList.textContent();
    // Verify excluded reasons exist in UI
    expect(exclusionsText).toContain('#msg-a1-s');
    expect(exclusionsText).toContain('#msg-a2-h');

    // 7. Test Copy Preview button
    const copyBtn = modal.locator('.copy-btn');
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();
    await expect(copyBtn).toHaveText(/Copied|Скопировано/);

    // 8. Close Modal
    const closeBtn = modal.locator('.close-btn');
    await closeBtn.click();
    await expect(modal).not.toBeVisible();
  });
});
