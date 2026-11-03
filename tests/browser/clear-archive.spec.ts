import { test, expect } from './extension-fixture';

test.describe('E2E Browser Compatibility: Clear Entire Archive & Safe Deletion', () => {
  test('clears all 9 IndexedDB stores with explicit confirmation checkbox and preserves user settings', async ({
    loadSidepanel,
  }) => {
    const sidepanel = await loadSidepanel();

    // 1. Seed database with conversation, message, revision, raw stream, and staging record
    await sidepanel.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('StreamArchiveDB');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      const tx = db.transaction(
        [
          'conversations',
          'messages',
          'revisions',
          'recovery_events',
          'raw_streams',
          'raw_stream_batches',
          'canonical_checkpoints',
          'history_staging',
          'history_staging_manifests',
        ],
        'readwrite'
      );

      tx.objectStore('conversations').put({ id: 'conv-clear', title: 'Clear Test', createdAt: 100, updatedAt: 100 });
      tx.objectStore('messages').put({
        id: 'msg-clear',
        conversationId: 'conv-clear',
        role: 'user',
        status: 'finished',
        identityState: 'reconciled',
        createdAt: 100,
        updatedAt: 100,
      });
      tx.objectStore('revisions').put({
        id: 'rev-clear',
        messageId: 'msg-clear',
        revisionIndex: 0,
        text: 'hello',
        source: 'network',
        capturedAt: 100,
        isFinal: true,
        isLastGood: false,
      });
      tx.objectStore('raw_streams').put({
        id: 'p:s',
        producerSessionId: 'p',
        streamId: 's',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/chat/completion',
        method: 'POST',
        state: 'completed',
        openedAt: 100,
        updatedAt: 100,
        totalChunks: 1,
        totalChars: 5,
        totalBatches: 1,
      });
      tx.objectStore('raw_stream_batches').put({
        id: 'p:s:1',
        streamKey: 'p:s',
        batchSeq: 1,
        chunks: [],
        createdAt: 100,
        charCount: 0,
      });
      tx.objectStore('canonical_checkpoints').put({
        streamKey: 'p:s',
        lastCommittedCheckpointSeq: 1,
        isTerminal: true,
        updatedAt: 100,
      });

      await new Promise<void>((res) => {
        tx.oncomplete = () => res();
      });
    });

    // 2. Open Settings Tab
    const settingsTabBtn = sidepanel.locator('button.tab-btn').filter({ hasText: /Settings|Настройки/i });
    await expect(settingsTabBtn).toBeVisible({ timeout: 5000 });
    await settingsTabBtn.click();

    // 3. Click "Delete All Local Archive Data" button
    const clearAllBtn = sidepanel.locator('#clear-all-archive-btn');
    await expect(clearAllBtn).toBeVisible({ timeout: 5000 });
    await clearAllBtn.click();

    // 4. Verify Clear Archive Modal appears
    const clearModal = sidepanel.locator('#clear-archive-modal');
    await expect(clearModal).toBeVisible({ timeout: 5000 });

    // 5. Verify confirm button is disabled before checking checkbox
    const confirmBtn = sidepanel.locator('#confirm-clear-archive-btn');
    await expect(confirmBtn).toBeDisabled();

    // 6. Check confirmation checkbox
    const confirmCheckbox = sidepanel.locator('#confirm-clear-archive-checkbox');
    await confirmCheckbox.check();
    await expect(confirmBtn).toBeEnabled();

    // 7. Click Confirm Delete Everything
    await confirmBtn.click();

    // Verify feedback banner appears
    await expect(clearModal.locator('.modal-feedback-banner')).toBeVisible({ timeout: 5000 });

    // 8. Verify all 9 IndexedDB stores are 0
    const allCounts = await sidepanel.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('StreamArchiveDB');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      const stores = [
        'conversations',
        'messages',
        'revisions',
        'recovery_events',
        'raw_streams',
        'raw_stream_batches',
        'canonical_checkpoints',
        'history_staging',
        'history_staging_manifests',
      ];
      const tx = db.transaction(stores, 'readonly');
      const counts: Record<string, number> = {};

      for (const st of stores) {
        counts[st] = await new Promise<number>((res) => {
          tx.objectStore(st).count().onsuccess = (e) => res((e.target as any).result);
        });
      }
      return counts;
    });

    expect(allCounts.conversations).toBe(0);
    expect(allCounts.messages).toBe(0);
    expect(allCounts.revisions).toBe(0);
    expect(allCounts.recovery_events).toBe(0);
    expect(allCounts.raw_streams).toBe(0);
    expect(allCounts.raw_stream_batches).toBe(0);
    expect(allCounts.canonical_checkpoints).toBe(0);
    expect(allCounts.history_staging).toBe(0);
    expect(allCounts.history_staging_manifests).toBe(0);

    // 9. Close modal and check Archive Tab shows empty state
    await sidepanel.locator('#clear-archive-modal .modal-close').click();
    const archiveTabBtn = sidepanel.locator('button.tab-btn').filter({ hasText: /Archive|Архив/i });
    await archiveTabBtn.click();

    await expect(sidepanel.locator('.empty-state')).toBeVisible({ timeout: 5000 });
  });
});
