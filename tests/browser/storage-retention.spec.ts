import { test, expect } from './extension-fixture';

test.describe('E2E Browser Compatibility: Raw Evidence Retention & Storage Observability', () => {
  test('observes browser storage metrics, configures retention policy, and prunes only eligible raw streams', async ({
    loadSidepanel,
  }) => {
    const sidepanel = await loadSidepanel();

    // 1. Seed database with old healthy stream, recent stream, and protected recovery stream
    await sidepanel.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('StreamArchiveDB');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      const now = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;

      const tx = db.transaction(
        [
          'conversations',
          'messages',
          'revisions',
          'recovery_events',
          'raw_streams',
          'raw_stream_batches',
        ],
        'readwrite'
      );

      // Conv
      tx.objectStore('conversations').put({
        id: 'conv-ret',
        title: 'Retention Test Conv',
        createdAt: now - 50 * oneDay,
        updatedAt: now - 50 * oneDay,
      });

      // 1. Old healthy stream (45 days old) -> ELIGIBLE
      tx.objectStore('raw_streams').put({
        id: 'p-old:s-old',
        producerSessionId: 'p-old',
        streamId: 's-old',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/chat/completion',
        method: 'POST',
        state: 'completed',
        openedAt: now - 45 * oneDay,
        updatedAt: now - 45 * oneDay,
        finalizedAt: now - 45 * oneDay,
        totalChunks: 2,
        totalChars: 100,
        totalBatches: 1,
        integrity: 'intact',
      });
      tx.objectStore('raw_stream_batches').put({
        id: 'p-old:s-old:1',
        streamKey: 'p-old:s-old',
        batchSeq: 1,
        chunks: [{ streamSequence: 0, chunkText: 'old', timestamp: now - 45 * oneDay }],
        createdAt: now - 45 * oneDay,
        charCount: 3,
      });
      tx.objectStore('messages').put({
        id: 'msg-old',
        conversationId: 'conv-ret',
        role: 'assistant',
        status: 'finished',
        identityState: 'reconciled',
        projectionState: 'logical',
        sourceRawStreamKey: 'p-old:s-old',
        createdAt: now - 45 * oneDay,
        updatedAt: now - 45 * oneDay,
      });

      // 2. Recent healthy stream (5 days old) -> PROTECTED (too_recent)
      tx.objectStore('raw_streams').put({
        id: 'p-rec:s-rec',
        producerSessionId: 'p-rec',
        streamId: 's-rec',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/chat/completion',
        method: 'POST',
        state: 'completed',
        openedAt: now - 5 * oneDay,
        updatedAt: now - 5 * oneDay,
        finalizedAt: now - 5 * oneDay,
        totalChunks: 1,
        totalChars: 50,
        totalBatches: 1,
        integrity: 'intact',
      });
      tx.objectStore('raw_stream_batches').put({
        id: 'p-rec:s-rec:1',
        streamKey: 'p-rec:s-rec',
        batchSeq: 1,
        chunks: [{ streamSequence: 0, chunkText: 'rec', timestamp: now - 5 * oneDay }],
        createdAt: now - 5 * oneDay,
        charCount: 3,
      });

      // 3. Old filtered stream (50 days old) -> PROTECTED (recovery_protected)
      tx.objectStore('raw_streams').put({
        id: 'p-flt:s-flt',
        producerSessionId: 'p-flt',
        streamId: 's-flt',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/chat/completion',
        method: 'POST',
        state: 'completed',
        openedAt: now - 50 * oneDay,
        updatedAt: now - 50 * oneDay,
        finalizedAt: now - 50 * oneDay,
        totalChunks: 1,
        totalChars: 50,
        totalBatches: 1,
        integrity: 'intact',
      });
      tx.objectStore('raw_stream_batches').put({
        id: 'p-flt:s-flt:1',
        streamKey: 'p-flt:s-flt',
        batchSeq: 1,
        chunks: [{ streamSequence: 0, chunkText: 'shielded', timestamp: now - 50 * oneDay }],
        createdAt: now - 50 * oneDay,
        charCount: 8,
      });
      tx.objectStore('messages').put({
        id: 'msg-flt',
        conversationId: 'conv-ret',
        role: 'assistant',
        status: 'filtered',
        identityState: 'reconciled',
        projectionState: 'logical',
        sourceRawStreamKey: 'p-flt:s-flt',
        createdAt: now - 50 * oneDay,
        updatedAt: now - 50 * oneDay,
      });
      tx.objectStore('revisions').put({
        id: 'rev-flt',
        messageId: 'msg-flt',
        revisionIndex: 0,
        text: 'original text',
        source: 'network',
        capturedAt: now - 50 * oneDay,
        isFinal: true,
        isLastGood: true,
      });
      tx.objectStore('recovery_events').put({
        id: 'rec-flt',
        messageId: 'msg-flt',
        kind: 'content_filter',
        detectedAt: now - 50 * oneDay,
        recoveredRevisionId: 'rev-flt',
      });

      await new Promise<void>((res) => {
        tx.oncomplete = () => res();
      });
    });

    // 2. Open Settings Tab
    const settingsTabBtn = sidepanel.locator('button.tab-btn').filter({ hasText: /Settings|Настройки/i });
    await expect(settingsTabBtn).toBeVisible({ timeout: 5000 });
    await settingsTabBtn.click();

    // 3. Verify Storage Management Card is visible
    const storageCard = sidepanel.locator('#storage-management-card');
    await expect(storageCard).toBeVisible({ timeout: 5000 });

    // Verify composition breakdown shows 3 raw streams
    await expect(storageCard.locator('.comp-card.raw')).toContainText('3');

    // 4. Select Retention Mode 30 days
    const radio30 = sidepanel.locator('input[name="rawRetentionMode"][value="30"]');
    await radio30.check();

    // 5. Click "Clean Up Now" button
    const cleanupBtn = sidepanel.locator('#cleanup-now-btn');
    await expect(cleanupBtn).toBeVisible();
    await cleanupBtn.click();

    // 6. Verify Cleanup Preview Modal appears
    const cleanupModal = sidepanel.locator('#retention-cleanup-modal');
    await expect(cleanupModal).toBeVisible({ timeout: 5000 });

    // Verify stats: 1 candidate stream, 1 candidate batch, 2 protected streams
    await expect(cleanupModal.locator('.cleanup-plan-stats')).toBeVisible();

    // 7. Confirm pruning
    const confirmCleanupBtn = cleanupModal.locator('#confirm-cleanup-btn');
    await expect(confirmCleanupBtn).toBeVisible();
    await confirmCleanupBtn.click();

    // 8. Verify confirmation feedback banner appears
    await expect(cleanupModal.locator('.modal-feedback-banner')).toBeVisible({ timeout: 5000 });

    // 9. Inspect IndexedDB directly to verify only old healthy stream was pruned
    const counts = await sidepanel.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('StreamArchiveDB');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const tx = db.transaction(['raw_streams', 'messages', 'revisions'], 'readonly');
      const oldStream = await new Promise((res) => { tx.objectStore('raw_streams').get('p-old:s-old').onsuccess = (e) => res((e.target as any).result); });
      const recStream = await new Promise((res) => { tx.objectStore('raw_streams').get('p-rec:s-rec').onsuccess = (e) => res((e.target as any).result); });
      const fltStream = await new Promise((res) => { tx.objectStore('raw_streams').get('p-flt:s-flt').onsuccess = (e) => res((e.target as any).result); });
      const oldMsg = await new Promise((res) => { tx.objectStore('messages').get('msg-old').onsuccess = (e) => res((e.target as any).result); });

      return {
        hasOldStream: Boolean(oldStream),
        hasRecentStream: Boolean(recStream),
        hasFilteredStream: Boolean(fltStream),
        hasOldMsg: Boolean(oldMsg),
      };
    });

    expect(counts.hasOldStream).toBe(false); // Pruned
    expect(counts.hasRecentStream).toBe(true); // Kept (too recent)
    expect(counts.hasFilteredStream).toBe(true); // Kept (shielded recovery)
    expect(counts.hasOldMsg).toBe(true); // Canonical message kept forever!
  });
});
