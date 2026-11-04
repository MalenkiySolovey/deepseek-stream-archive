<script lang="ts">
  import { onMount } from 'svelte';
  import {
    MESSAGE_GET_ARCHIVE_CONVERSATION,
    MESSAGE_GET_REVISION_CONTENT,
    MESSAGE_GET_CONVERSATION_EXPORT,
    MESSAGE_PREVIEW_CONVERSATION_DELETE,
    MESSAGE_DELETE_CONVERSATION,
    MESSAGE_BUILD_CONTEXT_CONTINUITY_PLAN,
    MESSAGE_ARM_CONTINUITY_DELIVERY,
    MESSAGE_REVOKE_CONTINUITY_DELIVERY,
    type GetArchiveConversationRequest,

    type GetArchiveConversationResponse,
    type GetRevisionContentRequest,
    type GetRevisionContentResponse,
    type GetConversationExportRequest,
    type GetConversationExportResponse,
    type PreviewConversationDeleteRequest,
    type PreviewConversationDeleteResponse,
    type DeleteConversationRequest,
    type DeleteConversationResponse,
  } from '../../../src/bridge/messages';
  import type { ConversationDeletionPlan } from '../../../src/storage/retention';
  import type {
    ArchiveConversationDetail,
    ArchiveMessageSummary,
    ArchiveRevisionMetadata,
  } from '../../../src/core/contracts';
  import {
    isLogicalMessage,
    isUnmatchedCapture,
    type ResponseRevision,
  } from '../../../src/core/models';
  import {
    buildConversationTree,
    type ConversationTreeResult,
    type ConversationTreeNode,
    type ArchiveViewSelection,
  } from '../../../src/core/conversation-tree';
  import SafeMarkdown from './SafeMarkdown.svelte';
  import ContextContinuityPreviewModal from './ContextContinuityPreviewModal.svelte';
  import { getContextContinuitySettings } from '../../../src/context-continuity/settings';
  import type { ContextContinuityPlan, ContextContinuitySettings } from '../../../src/context-continuity/types';
  import { translations, type SupportedLocale } from './i18n';

  import {
    buildConversationMarkdown,
    buildConversationJson,
    sanitizeExportFilename,
    formatDateUtc,
    type ConversationExportOptions,
  } from '../../../src/export';
  import { saveLocalFile } from '../../../src/backup/save-file';

  interface Props {
    conversationId: string;
    locale: SupportedLocale;
    onBack: () => void;
  }

  let { conversationId, locale, onBack } = $props<Props>();

  let t = $derived(translations[locale]);
  let detail = $state<ArchiveConversationDetail | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Active revision override per message (if user clicked a timeline revision)
  let activeRevisions = $state<Record<string, { text: string; thinking?: string; id: string }>>({});
  // Revisions history drawer toggle per message
  let expandedRevisionDrawers = $state<Record<string, boolean>>({});
  // Copied feedback per message
  let copiedId = $state<string | null>(null);

  // Branch index per parent grouping
  let branchSelections = $state<Record<string, number>>({});
  let viewSelection = $state<ArchiveViewSelection | null>(null);

  // Export Popover/Dialog State
  let showExportModal = $state(false);
  let exportFormat = $state<'markdown' | 'json'>('markdown');
  let exportBranches = $state<'all' | 'active'>('all');
  let exportIncludeReasoning = $state(true);
  let exportIncludeRevisions = $state(false);
  let exportIncludeRecovery = $state(true);
  let isExporting = $state(false);
  let exportStatusMessage = $state<string | null>(null);

  async function performExport() {
    if (!detail) return;
    isExporting = true;
    exportStatusMessage = null;
    try {
      const res = await new Promise<GetConversationExportResponse>((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          const req: GetConversationExportRequest = {
            type: MESSAGE_GET_CONVERSATION_EXPORT,
            conversationId: detail!.conversation.id,
          };
          chrome.runtime.sendMessage(req, (r) => {
            resolve(r || { success: false, error: 'No response from background worker' });
          });
        } else {
          resolve({ success: false, error: 'Extension runtime unavailable' });
        }
      });

      if (!res.success || !res.exportModel) {
        exportStatusMessage = `${t.exportError}: ${res.error || 'Failed to retrieve conversation export model'}`;
        isExporting = false;
        return;
      }

      const options: ConversationExportOptions = {
        format: exportFormat,
        branches: exportBranches,
        includeReasoning: exportIncludeReasoning,
        includeRevisions: exportIncludeRevisions,
        includeRecovery: exportIncludeRecovery,
        branchSelections,
      };

      let content: string;
      let mimeType: string;
      let ext: string;

      if (exportFormat === 'markdown') {
        content = buildConversationMarkdown(res.exportModel, options);
        mimeType = 'text/markdown;charset=utf-8';
        ext = 'md';
      } else {
        content = buildConversationJson(res.exportModel, options);
        mimeType = 'application/json;charset=utf-8';
        ext = 'json';
      }

      const dateStr = formatDateUtc(detail.conversation.updatedAt || Date.now());
      const filename = sanitizeExportFilename(detail.conversation.title, dateStr, ext, detail.conversation.id);

      const saveResult = await saveLocalFile({
        suggestedName: filename,
        mimeType,
        data: content,
        description: exportFormat === 'markdown' ? 'Markdown Document' : 'JSON Document',
        extension: ext,
      });

      if (saveResult.success) {
        showExportModal = false;
      } else if (saveResult.canceled) {
        // User closed the file dialog - return to idle cleanly
      } else {
        exportStatusMessage = `${t.exportError}: ${saveResult.error || 'Save failed'}`;
      }
    } catch (err) {
      exportStatusMessage = `${t.exportError}: ${(err as Error).message}`;
    } finally {
      isExporting = false;
    }
  }

  // Deletion State & Handlers
  let showDeleteModal = $state(false);
  let deletePlan = $state<ConversationDeletionPlan | null>(null);
  let isDeleting = $state(false);
  let deleteError = $state<string | null>(null);

  async function handleOpenDeleteModal() {
    if (!detail) return;
    deleteError = null;
    isDeleting = false;
    try {
      const res = await new Promise<PreviewConversationDeleteResponse>((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          const req: PreviewConversationDeleteRequest = {
            type: MESSAGE_PREVIEW_CONVERSATION_DELETE,
            conversationId: detail!.conversation.id,
          };
          chrome.runtime.sendMessage(req, (r) => {
            resolve(r || { success: false, error: 'No response from background worker' });
          });
        } else {
          resolve({ success: false, error: 'Extension runtime unavailable' });
        }
      });
      if (res && res.success && res.plan) {
        deletePlan = res.plan;
        showDeleteModal = true;
      } else {
        deleteError = res?.error || 'Failed to preview conversation deletion';
        showDeleteModal = true;
      }
    } catch (err) {
      deleteError = (err as Error).message;
      showDeleteModal = true;
    }
  }

  async function handleConfirmDelete() {
    if (!deletePlan) return;
    isDeleting = true;
    deleteError = null;
    try {
      const res = await new Promise<DeleteConversationResponse>((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          const req: DeleteConversationRequest = {
            type: MESSAGE_DELETE_CONVERSATION,
            plan: deletePlan!,
          };
          chrome.runtime.sendMessage(req, (r) => {
            resolve(r || { success: false, error: 'No response from background worker' });
          });
        } else {
          resolve({ success: false, error: 'Extension runtime unavailable' });
        }
      });

      if (res && res.success) {
        showDeleteModal = false;
        onBack();
      } else {
        if (res?.error === 'delete_target_changed_since_preview') {
          deleteError = t.deleteTargetChangedError;
        } else if (res?.error === 'active_stream_in_progress') {
          deleteError = t.deleteActiveStreamError;
        } else {
          deleteError = res?.error || 'Failed to delete conversation';
        }
      }
    } catch (err) {
      deleteError = (err as Error).message;
    } finally {
      isDeleting = false;
    }
  }

  async function handleCreateSafetyBackupBeforeDelete() {
    exportFormat = 'json';
    exportBranches = 'all';
    exportIncludeReasoning = true;
    exportIncludeRevisions = true;
    exportIncludeRecovery = true;
    await performExport();
  }

  // Context Continuity Preview & Delivery State
  let showContinuityModal = $state(false);
  let continuityPlan = $state<ContextContinuityPlan | null>(null);
  let isBuildingContinuityPlan = $state(false);
  let continuityError = $state<string | null>(null);
  let continuitySettings = $state<ContextContinuitySettings | null>(null);
  let isArmed = $state(false);

  function getActiveLeafId(): string | undefined {
    const list = visibleMessages();
    return list[list.length - 1]?.id;
  }

  async function refreshContinuityPlan() {
    if (!detail || !continuitySettings?.enabled) return;
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        const res = await new Promise<any>((resolve) => {
          chrome.runtime.sendMessage(
            {
              type: MESSAGE_BUILD_CONTEXT_CONTINUITY_PLAN,
              conversationId: detail!.conversation.id,
              branchSelections,
            },
            (r) => resolve(r || { success: false })
          );
        });
        if (res && res.success && res.plan) {
          continuityPlan = res.plan;
          if (continuitySettings.deliveryMode === 'automatic' && res.plan.eligibleBlockCount > 0 && !isArmed) {
            handleArmToggle(true);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  async function handleArmToggle(forceArm = false) {
    if (!detail) return;
    if (isArmed && !forceArm) {
      isArmed = false;
      try {
        chrome.runtime.sendMessage({ type: MESSAGE_REVOKE_CONTINUITY_DELIVERY }).catch(() => {});
      } catch {
        // ignore
      }
    } else {
      try {
        const activeLeafId = getActiveLeafId();
        const res = await new Promise<any>((resolve) => {
          chrome.runtime.sendMessage(
            {
              type: MESSAGE_ARM_CONTINUITY_DELIVERY,
              conversationId: detail!.conversation.id,
              leafMessageId: activeLeafId,
              branchSelections,
            },
            (r) => resolve(r || { success: false })
          );
        });

        if (res && res.success && res.envelope) {
          isArmed = true;
          try {
            const tabs = await chrome.tabs.query({ url: '*://chat.deepseek.com/*' });
            for (const tab of tabs || []) {
              if (tab.id) {
                chrome.tabs.sendMessage(tab.id, {
                  type: 'STREAMARCHIVE_DISPATCH_ARM_TO_MAIN',
                  envelope: res.envelope,
                }).catch(() => {});
              }
            }
          } catch {
            // ignore
          }
        }
      } catch (err) {
        console.warn('Failed to arm continuity delivery', err);
      }
    }
  }

  async function checkContinuitySettings() {
    try {
      continuitySettings = await getContextContinuitySettings();
      if (detail && continuitySettings?.enabled) {
        refreshContinuityPlan();
      }
    } catch {
      continuitySettings = null;
    }
  }

  async function handleOpenContinuityPreview() {
    if (!detail) return;
    showContinuityModal = true;
    isBuildingContinuityPlan = true;
    continuityError = null;
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        const res = await new Promise<any>((resolve) => {
          chrome.runtime.sendMessage(
            {
              type: MESSAGE_BUILD_CONTEXT_CONTINUITY_PLAN,
              conversationId: detail!.conversation.id,
              branchSelections,
            },
            (r) => resolve(r || { success: false, error: 'No response from background' })
          );
        });
        if (res && res.success && res.plan) {
          continuityPlan = res.plan;
        } else {
          continuityError = res?.error || 'Failed to build continuity plan';
        }
      } else {
        continuityError = 'Extension runtime unavailable';
      }
    } catch (err) {
      continuityError = (err as Error).message;
    } finally {
      isBuildingContinuityPlan = false;
    }
  }

  onMount(() => {
    loadConversation();
    checkContinuitySettings();
  });


  async function loadConversation() {
    loading = true;
    error = null;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local && conversationId) {
        try {
          const stored = await chrome.storage.local.get([
            `archive_view_selection_${conversationId}`,
            `branch_selections_${conversationId}`,
          ]);
          const savedView = stored[`archive_view_selection_${conversationId}`];
          if (savedView && typeof savedView === 'object') {
            viewSelection = savedView as ArchiveViewSelection;
          }
          const savedBranch = stored[`branch_selections_${conversationId}`];
          if (savedBranch && typeof savedBranch === 'object') {
            branchSelections = { ...savedBranch };
          }
        } catch {
          // ignore
        }
      }

      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        const req: GetArchiveConversationRequest = {
          type: MESSAGE_GET_ARCHIVE_CONVERSATION,
          conversationId,
        };
        const res = await chrome.runtime.sendMessage<
          GetArchiveConversationRequest,
          GetArchiveConversationResponse
        >(req);
        if (res && res.success && res.data) {
          detail = res.data;
          refreshContinuityPlan();
        } else {
          error = res?.error || 'Failed to load conversation details';
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  // Branching grouping: group siblings by parentId/remoteParentId
  interface SiblingGroup {
    parentKey: string;
    messages: ArchiveMessageSummary[];
  }

  let logicalMessages = $derived<ArchiveMessageSummary[]>(() => {
    if (!detail) return [];
    return detail.messages.filter((m) => isLogicalMessage(m));
  });

  let unmatchedCaptures = $derived<ArchiveMessageSummary[]>(() => {
    if (!detail) return [];
    return detail.messages.filter((m) => isUnmatchedCapture(m));
  });

  let conversationTree = $derived<ConversationTreeResult<ArchiveMessageSummary>>(() => {
    const msgs = logicalMessages();
    return buildConversationTree(msgs, {
      conversation: detail?.conversation,
      viewSelection,
      branchSelections,
      preferLatestByDefault: false,
    });
  });

  let visibleMessages = $derived<ArchiveMessageSummary[]>(() => {
    return conversationTree().activePath;
  });

  let unlinkedMessages = $derived<ArchiveMessageSummary[]>(() => {
    return conversationTree().unlinkedMessages;
  });

  function getSiblingInfo(msg: ArchiveMessageSummary) {
    const tree = conversationTree();
    const node = tree.getNode(msg.id);
    if (!node) {
      return { count: 1, current: 1, key: '', isUserBranch: false, isAssistantVariant: false };
    }
    const isUser = msg.role === 'user';
    if (isUser && node.userBranchCount > 1) {
      const key = node.parent ? node.parent.message.id : '__root__';
      return {
        count: node.userBranchCount,
        current: node.userBranchIndex + 1,
        key,
        isUserBranch: true,
        isAssistantVariant: false,
      };
    }
    if (!isUser && node.assistantVariantCount > 1) {
      const key = node.parent ? node.parent.message.id : '';
      return {
        count: node.assistantVariantCount,
        current: node.assistantVariantIndex + 1,
        key,
        isUserBranch: false,
        isAssistantVariant: true,
      };
    }
    return { count: 1, current: 1, key: '', isUserBranch: false, isAssistantVariant: false };
  }

  async function switchBranch(key: string, delta: number, total: number) {
    const tree = conversationTree();
    let siblings: ConversationTreeNode<ArchiveMessageSummary>[] = [];
    if (key === '__root__') {
      siblings = tree.roots;
    } else {
      const parentNode = tree.getNode(key);
      if (parentNode) {
        siblings = parentNode.children;
      }
    }
    if (siblings.length <= 1) return;

    // Find current index of active node among siblings
    let currentIndex = 0;
    const currentSelectedId = viewSelection?.selectedChildByParent?.[key];
    if (currentSelectedId) {
      const foundIdx = siblings.findIndex((s) => s.message.id === currentSelectedId);
      if (foundIdx >= 0) currentIndex = foundIdx;
    } else {
      const activeIdx = siblings.findIndex((s) => tree.activeMessageIds.has(s.message.id));
      if (activeIdx >= 0) currentIndex = activeIdx;
    }

    const nextIndex = (currentIndex + delta + siblings.length) % siblings.length;
    const nextNode = siblings[nextIndex]!;
    const nextSelectedId = nextNode.message.id;

    const updatedSelection: ArchiveViewSelection = {
      conversationId,
      selectedChildByParent: {
        ...(viewSelection?.selectedChildByParent || {}),
        [key]: nextSelectedId,
      },
      selectedRootId: key === '__root__' ? nextSelectedId : viewSelection?.selectedRootId,
      updatedAt: Date.now(),
    };

    viewSelection = updatedSelection;
    branchSelections[key] = nextIndex;

    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local && conversationId) {
        await chrome.storage.local.set({
          [`archive_view_selection_${conversationId}`]: updatedSelection,
          [`branch_selections_${conversationId}`]: { ...branchSelections },
        });
      }
    } catch {
      // ignore
    }
  }

  async function goToObservedSession() {
    const tree = conversationTree();
    if (!tree.observedLeafId || tree.observedPath.length === 0) return;

    const newSelectedChildByParent: Record<string, string> = {
      ...(viewSelection?.selectedChildByParent || {}),
    };
    let rootId: string | undefined = undefined;

    for (let i = 0; i < tree.observedPath.length; i++) {
      const msg = tree.observedPath[i]!;
      const parentKey = msg.parentId || '__root__';
      newSelectedChildByParent[parentKey] = msg.id;
      if (i === 0) {
        rootId = msg.id;
        newSelectedChildByParent['__root__'] = msg.id;
      }
    }

    const updatedSelection: ArchiveViewSelection = {
      conversationId,
      selectedChildByParent: newSelectedChildByParent,
      selectedRootId: rootId,
      updatedAt: Date.now(),
    };

    viewSelection = updatedSelection;

    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local && conversationId) {
        await chrome.storage.local.set({
          [`archive_view_selection_${conversationId}`]: updatedSelection,
        });
      }
    } catch {
      // ignore
    }
  }

  function getActiveContent(msg: ArchiveMessageSummary): { text: string; thinking?: string } {
    if (activeRevisions[msg.id]) {
      return activeRevisions[msg.id]!;
    }
    if (msg.preferredRevision) {
      return {
        text: msg.preferredRevision.text,
        thinking: msg.preferredRevision.thinking,
      };
    }
    return {
      text: msg.content || '',
      thinking: undefined,
    };
  }

  async function selectRevision(msgId: string, revMeta: ArchiveRevisionMetadata) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        const req: GetRevisionContentRequest = {
          type: MESSAGE_GET_REVISION_CONTENT,
          revisionId: revMeta.id,
        };
        const res = await chrome.runtime.sendMessage<
          GetRevisionContentRequest,
          GetRevisionContentResponse
        >(req);
        if (res && res.success && res.data) {
          activeRevisions[msgId] = {
            id: revMeta.id,
            text: res.data.text,
            thinking: res.data.thinking,
          };
        }
      }
    } catch {
      // ignore
    }
  }

  function toggleRevisionsDrawer(msgId: string) {
    expandedRevisionDrawers[msgId] = !expandedRevisionDrawers[msgId];
  }

  async function copyToClipboard(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      copiedId = id;
      setTimeout(() => {
        if (copiedId === id) {
          copiedId = null;
        }
      }, 2000);
    } catch {
      // ignore
    }
  }

  function formatDate(ts: number): string {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.toLocaleDateString(locale)} ${d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  }
</script>

<div class="conversation-view">
  <div class="view-header">
    <button class="back-btn" type="button" onclick={onBack}>
      ← {t.backToList}
    </button>
    <div class="header-titles">
      <h2 class="convo-title">{detail?.conversation.title || t.conversationDetail}</h2>
      <div class="convo-meta">
        <span class="meta-item">ID: {detail?.conversation.id.slice(0, 16)}</span>
        {#if detail?.conversation.remoteId}
          <span class="meta-item remote">Remote: {detail.conversation.remoteId}</span>
        {/if}
        <span class="meta-item">{logicalMessages().length} {t.messagesCount}</span>
      </div>
    </div>
    {#if detail}
      <div class="header-actions">
        {#if continuitySettings?.enabled}
          {#if continuityPlan && continuityPlan.eligibleBlockCount > 0 && continuitySettings.deliveryMode === 'manual_next'}
            <button
              class="continuity-arm-btn"
              class:armed={isArmed}
              id="arm-continuity-btn"
              type="button"
              onclick={() => handleArmToggle(false)}
              title={isArmed ? t.revokeContinuityBtn : t.armContinuityNextBtn}
            >
              {isArmed ? '✅ ' + t.armedContinuityStatus : '⚡ ' + t.armContinuityNextBtn}
            </button>
          {/if}
          <button
            class="continuity-header-btn"
            id="preview-continuity-btn"
            type="button"
            onclick={handleOpenContinuityPreview}
            title={t.previewContextContinuity}
          >
            🔄 {t.previewContextContinuity}
          </button>
        {/if}
        <button
          class="export-header-btn"
          type="button"
          onclick={() => { showExportModal = true; exportStatusMessage = null; }}
          title={t.exportConversation}
        >
          📤 {t.exportBtn}
        </button>

        <button
          class="delete-header-btn"
          id="delete-conversation-btn"
          type="button"
          onclick={handleOpenDeleteModal}
          title={t.deleteConversation}
        >
          🗑️ {t.deleteBtn}
        </button>
      </div>
    {/if}
  </div>

  {#if loading}
    <div class="loading-state">
      <div class="spinner"></div>
      <span>{t.loading}</span>
    </div>
  {:else if error}
    <div class="error-banner">
      <strong>Error:</strong> {error}
    </div>
  {:else if !detail || detail.messages.length === 0}
    <div class="empty-state">
      <p>{t.noMessages}</p>
    </div>
  {:else}
    <div class="messages-thread">
      {#if !conversationTree().isArchiveViewingObservedPath && conversationTree().observedLeafId}
        <div class="observed-path-banner">
          <div class="observed-path-info">
            <span class="observed-path-icon">🧭</span>
            <span class="observed-path-text">{t.observedPathNotification}</span>
          </div>
          <button
            class="observed-path-btn"
            type="button"
            onclick={goToObservedSession}
          >
            {t.goToObservedSession}
          </button>
        </div>
      {/if}

      {#each visibleMessages() as msg (msg.id)}
        {@const branchInfo = getSiblingInfo(msg)}
        {@const activeData = getActiveContent(msg)}
        {@const isAssistant = msg.role === 'assistant'}
        {@const isFiltered = msg.status === 'filtered' || (msg.recoveryEvents && msg.recoveryEvents.length > 0) || Boolean(msg.preferredRevision?.isLastGood)}
        {@const displayStatus = isFiltered ? 'filtered' : msg.status}
        {@const lastGoodRev = (isFiltered && msg.preferredRevision) ? msg.preferredRevision : (msg.preferredRevision?.isLastGood ? msg.preferredRevision : undefined)}

        <div class="message-card" class:assistant={isAssistant} class:user={!isAssistant}>
          <div class="message-header">
            <div class="role-wrapper">
              <span class="role-badge" class:asst={isAssistant} class:usr={!isAssistant}>
                {isAssistant ? t.roleAssistant : t.roleUser}
              </span>
              {#if !isAssistant && msg.contextContinuityDeliveryId}
                <span class="continuity-attached-badge" title="Delivery ID: {msg.contextContinuityDeliveryId}">
                  {t.continuityAttachedBadge}
                </span>
              {/if}
              {#if isAssistant}
                <span class="status-pill status-{displayStatus}">
                  {displayStatus}
                </span>
                <span class="identity-pill" class:reconciled={msg.identityState === 'reconciled'}>
                  {msg.identityState === 'reconciled' ? t.reconciled : t.provisional}
                </span>
              {/if}
            </div>

            <div class="header-actions">
              {#if branchInfo.count > 1}
                <div class="branch-controls">
                  <span class="branch-label">
                    {branchInfo.isAssistantVariant ? t.responseXofY : t.promptXofY} {branchInfo.current} {t.of} {branchInfo.count}
                  </span>
                  <button
                    class="branch-nav-btn"
                    type="button"
                    title={branchInfo.isAssistantVariant ? t.prevResponse : t.prevPrompt}
                    onclick={() => switchBranch(branchInfo.key, -1, branchInfo.count)}
                  >
                    ‹
                  </button>
                  <button
                    class="branch-nav-btn"
                    type="button"
                    title={branchInfo.isAssistantVariant ? t.nextResponse : t.nextPrompt}
                    onclick={() => switchBranch(branchInfo.key, 1, branchInfo.count)}
                  >
                    ›
                  </button>
                </div>
              {/if}

              <button
                class="copy-btn"
                type="button"
                onclick={() => copyToClipboard(activeData.text, msg.id)}
              >
                {copiedId === msg.id ? t.copiedText : t.copyText}
              </button>
            </div>
          </div>

          {#if msg.remoteParentId && !msg.parentId}
            <div class="unresolved-parent-notice">
              ⚠️ {t.unresolvedParent} ({msg.remoteParentId})
            </div>
          {/if}

          <!-- Recovery Preview Card for Filtered / Censored Messages -->
          {#if isAssistant && lastGoodRev && (lastGoodRev.text.trim().length > 0 || (lastGoodRev.thinking && lastGoodRev.thinking.trim().length > 0))}
            <div class="recovery-preview-card">
              <div class="recovery-card-header">
                <span class="recovery-icon">🛡️</span>
                <div class="recovery-card-text">
                  <div class="recovery-card-title">{t.recoveryCardTitle}</div>
                  <div class="recovery-card-desc">{t.recoveryCardDesc}</div>
                </div>
                <button
                  class="copy-recovery-btn"
                  type="button"
                  onclick={() => copyToClipboard(lastGoodRev.text || lastGoodRev.thinking || '', `rec_${msg.id}`)}
                >
                  {copiedId === `rec_${msg.id}` ? t.copiedText : t.copyPreservedText}
                </button>
              </div>

              <div class="recovered-text-box">
                {#if lastGoodRev.text && lastGoodRev.text.trim().length > 0}
                  <div class="recovered-text-label">{t.lastGoodBadge} ({lastGoodRev.text.length} chars):</div>
                  <SafeMarkdown content={lastGoodRev.text} />
                {/if}
                {#if lastGoodRev.thinking && lastGoodRev.thinking.trim().length > 0}
                  <div class="recovered-text-label" style="margin-top: 8px;">💭 {t.thinkingTitle} ({lastGoodRev.thinking.length} {t.thinkingChars}):</div>
                  <SafeMarkdown content={lastGoodRev.thinking} />
                {/if}
              </div>
            </div>
          {/if}

          <!-- Thinking block -->
          {#if isAssistant && activeData.thinking}
            <details class="thinking-details">
              <summary class="thinking-summary">
                💭 {t.thinkingTitle} ({activeData.thinking.length} {t.thinkingChars})
              </summary>
              <div class="thinking-content">
                <SafeMarkdown content={activeData.thinking} />
              </div>
            </details>
          {/if}

          <!-- Response text -->
          <div class="message-content">
            <SafeMarkdown content={activeData.text} />
          </div>

          <!-- Revision history drawer for assistant -->
          {#if isAssistant && msg.revisions.length > 0}
            <div class="revisions-section">
              <button
                class="toggle-revisions-btn"
                type="button"
                onclick={() => toggleRevisionsDrawer(msg.id)}
              >
                <span>{t.revisionsTitle} ({msg.revisions.length})</span>
                <span class="drawer-arrow">{expandedRevisionDrawers[msg.id] ? '▲' : '▼'}</span>
              </button>

              {#if expandedRevisionDrawers[msg.id]}
                <div class="revisions-list">
                  {#each msg.revisions as revMeta}
                    {@const isActive = (activeRevisions[msg.id]?.id || msg.preferredRevision?.id) === revMeta.id}
                    <div class="revision-item" class:active={isActive}>
                      <div class="rev-left">
                        <span class="rev-idx">#{revMeta.revisionIndex}</span>
                        <span class="rev-source source-{revMeta.source}">{revMeta.source}</span>
                        {#if revMeta.isLastGood}
                          <span class="rev-badge last-good">{t.lastGoodBadge}</span>
                        {/if}
                        {#if revMeta.isFinal}
                          <span class="rev-badge final">{t.finalBadge}</span>
                        {/if}
                        <span class="rev-time">{formatDate(revMeta.capturedAt)}</span>
                        <span class="rev-len">{revMeta.textLength} chars</span>
                      </div>
                      <div class="rev-right">
                        {#if isActive}
                          <span class="active-tag">✓ {t.activeRevision}</span>
                        {:else}
                          <button
                            class="view-rev-btn"
                            type="button"
                            onclick={() => selectRevision(msg.id, revMeta)}
                          >
                            {t.viewRevision}
                          </button>
                        {/if}
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
      {#if unlinkedMessages().length > 0}
        <div class="unlinked-turns-section">
          <div class="unlinked-turns-header">
            <span class="unlinked-icon">⚠️</span>
            <div class="unlinked-header-text">
              <span class="unlinked-title">{t.unlinkedTurnsTitle} ({unlinkedMessages().length})</span>
              <span class="unlinked-desc">{t.unlinkedTurnsDesc}</span>
            </div>
          </div>
          <div class="unlinked-turns-list">
            {#each unlinkedMessages() as um (um.id)}
              {@const umData = getActiveContent(um)}
              {@const detail = conversationTree().unlinkedDetails?.find((d) => d.message.id === um.id)}
              <div class="unlinked-turn-card">
                <div class="unmatched-card-meta">
                  <span class="role-badge" class:asst={um.role === 'assistant'} class:usr={um.role === 'user'}>
                    {um.role === 'assistant' ? t.roleAssistant : t.roleUser}
                  </span>
                  <span class="unmatched-pill">{um.status}</span>
                  {#if detail?.reason}
                    <span class="unmatched-pill unlinked-reason">{detail.reason}</span>
                  {/if}
                  <span class="unmatched-key">ID: {um.id}</span>
                  {#if um.remoteId}
                    <span class="unmatched-key">Remote: {um.remoteId}</span>
                  {/if}
                  {#if um.parentId}
                    <span class="unmatched-key">Parent: {um.parentId}</span>
                  {/if}
                  {#if um.remoteParentId}
                    <span class="unmatched-key">RemoteParent: {um.remoteParentId}</span>
                  {/if}
                  {#if um.sourceRawStreamKey}
                    <span class="unmatched-key">Stream: {um.sourceRawStreamKey}</span>
                  {/if}
                  <button
                    class="copy-btn mini"
                    type="button"
                    onclick={() => copyToClipboard(umData.text || um.content || '', um.id)}
                  >
                    {copiedId === um.id ? t.copiedText : t.copyText}
                  </button>
                </div>
                <div class="unmatched-content">
                  <SafeMarkdown content={umData.text || um.content || ''} />
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}
      {#if unmatchedCaptures().length > 0}
        <div class="unmatched-captures-section">
          <div class="unmatched-captures-header">
            <span class="unmatched-icon">📡</span>
            <div class="unmatched-header-text">
              <span class="unmatched-title">{t.unmatchedCapturesTitle} ({unmatchedCaptures().length})</span>
              <span class="unmatched-desc">{t.unmatchedCapturesDesc}</span>
            </div>
          </div>
          <div class="unmatched-captures-list">
            {#each unmatchedCaptures() as um (um.id)}
              {@const umData = getActiveContent(um)}
              <div class="unmatched-capture-card">
                <div class="unmatched-card-meta">
                  <span class="unmatched-pill">{um.status}</span>
                  {#if um.sourceRawStreamKey}
                    <span class="unmatched-key">Stream: {um.sourceRawStreamKey}</span>
                  {/if}
                  <span class="unmatched-time">{formatDate(um.createdAt)}</span>
                  <button
                    class="copy-btn mini"
                    type="button"
                    onclick={() => copyToClipboard(umData.text, um.id)}
                  >
                    {copiedId === um.id ? t.copiedText : t.copyText}
                  </button>
                </div>
                {#if umData.thinking}
                  <details class="thinking-details mini">
                    <summary class="thinking-summary">
                      💭 {t.thinkingTitle} ({umData.thinking.length} {t.thinkingChars})
                    </summary>
                    <div class="thinking-content">
                      <SafeMarkdown content={umData.thinking} />
                    </div>
                  </details>
                {/if}
                <div class="unmatched-content">
                  <SafeMarkdown content={umData.text} />
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}

  {#if showExportModal}
    <div
      class="modal-backdrop"
      role="presentation"
      onclick={() => (showExportModal = false)}
      onkeydown={(e) => { if (e.key === 'Escape') showExportModal = false; }}
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={t.exportConversation}
        tabindex="-1"
        onclick={(e) => e.stopPropagation()}
      >
        <div class="modal-header">
          <h3 class="modal-title">📤 {t.exportConversation}</h3>
          <button class="modal-close" type="button" onclick={() => (showExportModal = false)}>✕</button>
        </div>

        <div class="modal-body">
          <div class="export-option-group">
            <span class="option-group-title">{t.exportFormat}</span>
            <div class="radio-row">
              <label class="radio-label">
                <input type="radio" bind:group={exportFormat} value="markdown" />
                <span>{t.exportFormatMarkdown}</span>
              </label>
              <label class="radio-label">
                <input type="radio" bind:group={exportFormat} value="json" />
                <span>{t.exportFormatJson}</span>
              </label>
            </div>
          </div>

          <div class="export-option-group">
            <span class="option-group-title">{t.exportBranches}</span>
            <div class="radio-row">
              <label class="radio-label">
                <input type="radio" bind:group={exportBranches} value="all" />
                <span>{t.exportAllBranches}</span>
              </label>
              <label class="radio-label">
                <input type="radio" bind:group={exportBranches} value="active" />
                <span>{t.exportActiveBranch}</span>
              </label>
            </div>
          </div>

          <div class="export-option-group checkboxes">
            <label class="checkbox-label">
              <input type="checkbox" bind:checked={exportIncludeReasoning} />
              <span>{t.exportIncludeReasoning}</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" bind:checked={exportIncludeRecovery} />
              <span>{t.exportIncludeRecovery}</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" bind:checked={exportIncludeRevisions} />
              <span>{t.exportIncludeRevisions}</span>
            </label>
          </div>

          {#if exportStatusMessage}
            <div class="export-status-banner">
              {exportStatusMessage}
            </div>
          {/if}
        </div>

        <div class="modal-footer">
          <button
            class="modal-btn secondary"
            type="button"
            disabled={isExporting}
            onclick={() => (showExportModal = false)}
          >
            {t.exportCancel}
          </button>
          <button
            class="modal-btn primary"
            type="button"
            disabled={isExporting}
            onclick={performExport}
          >
            {isExporting ? '...' : t.exportConfirm}
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if showDeleteModal && deletePlan}
    <div
      class="modal-backdrop"
      role="presentation"
      onclick={() => (showDeleteModal = false)}
      onkeydown={(e) => { if (e.key === 'Escape') showDeleteModal = false; }}
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="modal-card"
        id="delete-conversation-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t.deleteModalTitle}
        tabindex="-1"
        onclick={(e) => e.stopPropagation()}
      >
        <div class="modal-header">
          <h3 class="modal-title">🗑️ {t.deleteModalTitle}</h3>
          <button class="modal-close" type="button" onclick={() => (showDeleteModal = false)}>✕</button>
        </div>

        <div class="modal-body">
          <div class="delete-warning-banner">
            <span class="warning-icon">⚠️</span>
            <p>{t.deleteWarningNotice}</p>
          </div>

          <div class="delete-plan-summary">
            <h4 class="convo-name">{deletePlan.title}</h4>
            <div class="delete-counts-grid">
              <div class="count-pill">
                <span class="count-val">{deletePlan.messageCount}</span>
                <span class="count-lbl">{t.deleteSummaryMsgs}</span>
              </div>
              <div class="count-pill">
                <span class="count-val">{deletePlan.revisionCount}</span>
                <span class="count-lbl">{t.deleteSummaryRevs}</span>
              </div>
              <div class="count-pill">
                <span class="count-val">{deletePlan.recoveryEventCount}</span>
                <span class="count-lbl">{t.deleteSummaryEvents}</span>
              </div>
              <div class="count-pill">
                <span class="count-val">{deletePlan.rawStreamCount}</span>
                <span class="count-lbl">{t.deleteSummaryStreams}</span>
              </div>
              <div class="count-pill">
                <span class="count-val">{deletePlan.rawBatchCount}</span>
                <span class="count-lbl">{t.deleteSummaryBatches}</span>
              </div>
            </div>
          </div>

          <div class="safety-backup-action" style="margin-top: 1rem;">
            <button
              class="modal-btn secondary"
              type="button"
              onclick={handleCreateSafetyBackupBeforeDelete}
              disabled={isDeleting}
            >
              💾 {t.deleteSafetyBackupBtn}
            </button>
          </div>

          {#if deleteError}
            <div class="delete-error-banner" style="margin-top: 0.75rem; color: #f87171; font-size: 0.82rem; background: rgba(239, 68, 68, 0.1); padding: 0.5rem; border-radius: 4px;">
              ⚠️ {deleteError}
            </div>
          {/if}
        </div>

        <div class="modal-footer">
          <button
            class="modal-btn secondary"
            type="button"
            onclick={() => (showDeleteModal = false)}
            disabled={isDeleting}
          >
            {t.deleteCancelBtn}
          </button>
          <button
            class="modal-btn danger"
            id="confirm-delete-btn"
            type="button"
            disabled={isDeleting}
            onclick={handleConfirmDelete}
            style="background: #dc2626; color: white;"
          >
            {isDeleting ? t.deleteInProgress : t.deleteConfirmBtn}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <ContextContinuityPreviewModal
    isOpen={showContinuityModal}
    plan={continuityPlan}
    isLoading={isBuildingContinuityPlan}
    error={continuityError}
    locale={locale}
    onClose={() => { showContinuityModal = false; }}
  />
</div>


<style>
  .conversation-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow-y: auto;
  }

  .view-header {
    padding: 0.75rem 1rem;
    background: #090d16;
    border-bottom: 1px solid #1e293b;
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .header-actions {
    position: absolute;
    right: 1rem;
    top: 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .continuity-arm-btn {
    padding: 0.3rem 0.65rem;
    border-radius: 4px;
    background: #0284c7;
    border: 1px solid #38bdf8;
    color: #ffffff;
    font-size: 0.75rem;
    font-weight: 600;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    transition: background 0.15s, border-color 0.15s;
  }

  .continuity-arm-btn:hover {
    background: #0369a1;
    border-color: #7dd3fc;
  }

  .continuity-arm-btn.armed {
    background: #059669;
    border-color: #34d399;
    color: #ecfdf5;
  }

  .continuity-arm-btn.armed:hover {
    background: #047857;
  }

  .continuity-attached-badge {
    display: inline-flex;
    align-items: center;
    font-size: 0.7rem;
    font-weight: 500;
    color: #38bdf8;
    background: rgba(14, 165, 233, 0.12);
    border: 1px solid rgba(56, 189, 248, 0.3);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    margin-left: 0.4rem;
  }

  .continuity-header-btn {
    padding: 0.3rem 0.65rem;
    border-radius: 4px;
    background: rgba(168, 85, 247, 0.12);
    border: 1px solid rgba(168, 85, 247, 0.3);
    color: #c084fc;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    transition: background 0.15s, border-color 0.15s;
  }

  .continuity-header-btn:hover {
    background: rgba(168, 85, 247, 0.22);
    border-color: rgba(168, 85, 247, 0.5);
    color: #e9d5ff;
  }

  .export-header-btn {

    padding: 0.3rem 0.65rem;
    border-radius: 4px;
    background: #1e293b;
    border: 1px solid #334155;
    color: #e2e8f0;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    transition: background 0.15s, border-color 0.15s;
  }

  .export-header-btn:hover {
    background: #334155;
    border-color: #475569;
  }

  .delete-header-btn {
    padding: 0.3rem 0.65rem;
    border-radius: 4px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: #f87171;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    transition: background 0.15s, border-color 0.15s;
  }

  .delete-header-btn:hover {
    background: rgba(239, 68, 68, 0.2);
    border-color: #ef4444;
  }

  .delete-warning-banner {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 6px;
    padding: 0.75rem;
    margin-bottom: 1rem;
    color: #fca5a5;
    font-size: 0.82rem;
    line-height: 1.4;
  }

  .delete-plan-summary {
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 6px;
    padding: 0.75rem;
  }

  .convo-name {
    margin: 0 0 0.5rem 0;
    font-size: 0.88rem;
    color: #e2e8f0;
    font-weight: 600;
  }

  .delete-counts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
    gap: 0.5rem;
  }

  .count-pill {
    background: #1e293b;
    border-radius: 4px;
    padding: 0.4rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .count-val {
    font-size: 0.95rem;
    font-weight: 700;
    color: #38bdf8;
  }

  .count-lbl {
    font-size: 0.7rem;
    color: #94a3b8;
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.75);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 1rem;
    backdrop-filter: blur(2px);
  }

  .modal-card {
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 8px;
    width: 100%;
    max-width: 380px;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .modal-header {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #1e293b;
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: #090d16;
  }

  .modal-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: #f8fafc;
    margin: 0;
  }

  .modal-close {
    background: transparent;
    border: none;
    color: #94a3b8;
    font-size: 1rem;
    cursor: pointer;
    padding: 0.2rem;
  }

  .modal-close:hover {
    color: #f8fafc;
  }

  .modal-body {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  .export-option-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .option-group-title {
    font-size: 0.6875rem;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .radio-row {
    display: flex;
    gap: 1rem;
    font-size: 0.8125rem;
    color: #e2e8f0;
  }

  .radio-label,
  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
    font-size: 0.8125rem;
    color: #e2e8f0;
  }

  .export-option-group.checkboxes {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid #1e293b;
  }

  .export-status-banner {
    font-size: 0.75rem;
    color: #f87171;
    background: #450a0a;
    border: 1px solid #7f1d1d;
    border-radius: 4px;
    padding: 0.5rem;
  }

  .modal-footer {
    padding: 0.75rem 1rem;
    border-top: 1px solid #1e293b;
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    background: #090d16;
  }

  .modal-btn {
    padding: 0.4rem 0.875rem;
    border-radius: 4px;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
  }

  .modal-btn.secondary {
    background: #1e293b;
    color: #cbd5e1;
    border-color: #334155;
  }

  .modal-btn.secondary:hover {
    background: #334155;
  }

  .modal-btn.primary {
    background: #0284c7;
    color: white;
  }

  .modal-btn.primary:hover {
    background: #0369a1;
  }

  .modal-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .back-btn {
    background: transparent;
    border: none;
    color: #38bdf8;
    font-size: 0.8125rem;
    padding: 0;
    margin-bottom: 0.5rem;
    cursor: pointer;
    display: flex;
    align-items: center;
  }

  .back-btn:hover {
    text-decoration: underline;
  }

  .convo-title {
    margin: 0 0 0.25rem 0;
    font-size: 1rem;
    font-weight: 600;
    color: #f8fafc;
  }

  .convo-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    font-size: 0.75rem;
    color: #94a3b8;
  }

  .meta-item.remote {
    color: #a78bfa;
  }

  .loading-state,
  .empty-state {
    padding: 3rem 1rem;
    text-align: center;
    color: #94a3b8;
  }

  .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid #1e293b;
    border-top-color: #38bdf8;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin: 0 auto 0.75rem auto;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .error-banner {
    margin: 1rem;
    padding: 0.75rem 1rem;
    background: #450a0a;
    border: 1px solid #7f1d1d;
    border-radius: 0.375rem;
    color: #fca5a5;
    font-size: 0.8125rem;
  }

  .messages-thread {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .message-card {
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 0.5rem;
    padding: 0.875rem 1rem;
  }

  .message-card.user {
    background: #121c2f;
    border-color: #1e3a5f;
  }

  .message-card.assistant {
    background: #0d1527;
    border-color: #1e293b;
  }

  .message-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
    font-size: 0.75rem;
  }

  .role-wrapper {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .role-badge {
    padding: 0.15rem 0.5rem;
    border-radius: 0.25rem;
    font-weight: 600;
  }

  .role-badge.asst {
    background: #1e293b;
    color: #38bdf8;
  }

  .role-badge.usr {
    background: #1e3a8a;
    color: #93c5fd;
  }

  .status-pill {
    padding: 0.1rem 0.4rem;
    border-radius: 0.25rem;
    font-size: 0.6875rem;
    text-transform: lowercase;
  }

  .status-pill.status-finished {
    background: #064e3b;
    color: #6ee7b7;
  }

  .status-pill.status-streaming {
    background: #713f12;
    color: #fde047;
  }

  .status-pill.status-filtered {
    background: #7f1d1d;
    color: #fca5a5;
  }

  .status-pill.status-degraded,
  .status-pill.status-interrupted {
    background: #4c1d95;
    color: #c4b5fd;
  }

  .identity-pill {
    padding: 0.1rem 0.4rem;
    border-radius: 0.25rem;
    font-size: 0.6875rem;
    background: #1e293b;
    color: #94a3b8;
  }

  .identity-pill.reconciled {
    background: #14532d;
    color: #86efac;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .branch-controls {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    background: #1e293b;
    padding: 0.1rem 0.35rem;
    border-radius: 0.25rem;
  }

  .branch-label {
    font-size: 0.6875rem;
    color: #cbd5e1;
  }

  .branch-nav-btn {
    background: transparent;
    border: none;
    color: #38bdf8;
    font-size: 0.875rem;
    font-weight: bold;
    cursor: pointer;
    padding: 0 0.25rem;
    line-height: 1;
  }

  .branch-nav-btn:hover {
    color: #7dd3fc;
  }

  .copy-btn {
    background: transparent;
    border: 1px solid #334155;
    border-radius: 0.25rem;
    color: #94a3b8;
    font-size: 0.6875rem;
    padding: 0.15rem 0.45rem;
    cursor: pointer;
    transition: all 0.15s;
  }

  .copy-btn:hover {
    background: #1e293b;
    color: #f8fafc;
  }

  .unresolved-parent-notice {
    margin-bottom: 0.75rem;
    font-size: 0.75rem;
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.1);
    padding: 0.35rem 0.6rem;
    border-radius: 0.25rem;
  }

  /* Recovery Preview Card */
  .recovery-preview-card {
    margin: 0.75rem 0;
    padding: 0.75rem;
    background: rgba(16, 185, 129, 0.08);
    border: 1px solid #059669;
    border-radius: 0.375rem;
  }

  .recovery-card-header {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .recovery-icon {
    font-size: 1.125rem;
    line-height: 1;
  }

  .recovery-card-text {
    flex: 1;
  }

  .recovery-card-title {
    font-weight: 600;
    color: #34d399;
    font-size: 0.8125rem;
  }

  .recovery-card-desc {
    color: #a7f3d0;
    font-size: 0.75rem;
    margin-top: 0.15rem;
  }

  .copy-recovery-btn {
    background: #065f46;
    border: 1px solid #10b981;
    border-radius: 0.25rem;
    color: #ecfdf5;
    font-size: 0.7rem;
    padding: 0.25rem 0.6rem;
    cursor: pointer;
    font-weight: 500;
    white-space: nowrap;
  }

  .copy-recovery-btn:hover {
    background: #047857;
  }

  .recovered-text-box {
    margin-top: 0.5rem;
    padding: 0.5rem;
    background: #064e3b;
    border-radius: 0.25rem;
    font-size: 0.8125rem;
  }

  .recovered-text-label {
    font-size: 0.6875rem;
    color: #a7f3d0;
    margin-bottom: 0.35rem;
    font-weight: 600;
  }

  /* Thinking Box */
  .thinking-details {
    margin: 0.75rem 0;
    border: 1px solid #312e81;
    border-radius: 0.375rem;
    background: rgba(49, 46, 129, 0.2);
    overflow: hidden;
  }

  .thinking-summary {
    padding: 0.35rem 0.65rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: #a5b4fc;
    cursor: pointer;
    user-select: none;
    outline: none;
  }

  .thinking-summary:hover {
    background: rgba(49, 46, 129, 0.4);
  }

  .thinking-content {
    padding: 0.5rem 0.75rem;
    border-top: 1px solid #312e81;
    font-size: 0.8125rem;
    color: #c7d2fe;
    font-style: italic;
  }

  /* Revisions Section */
  .revisions-section {
    margin-top: 0.75rem;
    padding-top: 0.5rem;
    border-top: 1px dashed #1e293b;
  }

  .toggle-revisions-btn {
    background: transparent;
    border: none;
    color: #64748b;
    font-size: 0.6875rem;
    padding: 0;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .toggle-revisions-btn:hover {
    color: #94a3b8;
  }

  .drawer-arrow {
    font-size: 0.6rem;
  }

  .revisions-list {
    margin-top: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .revision-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.35rem 0.5rem;
    background: #090d16;
    border: 1px solid #1e293b;
    border-radius: 0.25rem;
    font-size: 0.6875rem;
  }

  .revision-item.active {
    border-color: #0284c7;
    background: #0c1a2e;
  }

  .rev-left {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .rev-idx {
    font-weight: 600;
    color: #f8fafc;
  }

  .rev-source {
    padding: 0.05rem 0.3rem;
    border-radius: 0.2rem;
    font-size: 0.625rem;
  }

  .rev-source.source-network {
    background: #0284c7;
    color: #e0f2fe;
  }

  .rev-source.source-history {
    background: #7c3aed;
    color: #ede9fe;
  }

  .rev-source.source-replay {
    background: #d97706;
    color: #fef3c7;
  }

  .rev-badge {
    padding: 0.05rem 0.3rem;
    border-radius: 0.2rem;
    font-size: 0.625rem;
  }

  .rev-badge.last-good {
    background: #059669;
    color: #ecfdf5;
  }

  .rev-badge.final {
    background: #334155;
    color: #cbd5e1;
  }

  .rev-time,
  .rev-len {
    color: #64748b;
  }

  .active-tag {
    color: #38bdf8;
    font-weight: 600;
  }

  .view-rev-btn {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 0.2rem;
    color: #cbd5e1;
    font-size: 0.625rem;
    padding: 0.1rem 0.4rem;
    cursor: pointer;
  }

  .view-rev-btn:hover {
    background: #334155;
    color: #f8fafc;
  }

  .unmatched-captures-section {
    margin-top: 1rem;
    padding: 0.875rem 1rem;
    background: #0f172a;
    border: 1px dashed #334155;
    border-radius: 0.5rem;
  }

  .unmatched-captures-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .unmatched-icon {
    font-size: 1.125rem;
  }

  .unmatched-header-text {
    display: flex;
    flex-direction: column;
  }

  .unmatched-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: #cbd5e1;
  }

  .unmatched-desc {
    font-size: 0.6875rem;
    color: #64748b;
  }

  .unmatched-captures-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .unmatched-capture-card {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 0.375rem;
    padding: 0.625rem 0.75rem;
  }

  .unmatched-card-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    font-size: 0.6875rem;
    color: #94a3b8;
    margin-bottom: 0.5rem;
  }

  .unmatched-pill {
    padding: 0.1rem 0.35rem;
    border-radius: 0.2rem;
    background: #475569;
    color: #f1f5f9;
    font-size: 0.625rem;
  }

  .unmatched-pill.unlinked-reason {
    background: #b45309;
    color: #fef3c7;
    font-weight: 500;
  }

  .unmatched-key {
    color: #a78bfa;
    font-family: monospace;
    font-size: 0.625rem;
  }

  .copy-btn.mini {
    padding: 0.1rem 0.4rem;
    font-size: 0.625rem;
    margin-left: auto;
  }

  .thinking-details.mini {
    margin-bottom: 0.5rem;
  }

  .unlinked-turns-section {
    margin-top: 1rem;
    padding: 0.875rem 1rem;
    background: #171717;
    border: 1px dashed #b45309;
    border-radius: 0.5rem;
  }

  .unlinked-turns-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .unlinked-icon {
    font-size: 1.125rem;
  }

  .unlinked-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: #fde68a;
  }

  .unlinked-desc {
    font-size: 0.6875rem;
    color: #94a3b8;
  }

  .unlinked-turns-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .unlinked-turn-card {
    background: #1e1e1e;
    border: 1px solid #3f3f46;
    border-radius: 0.375rem;
    padding: 0.75rem;
  }

  .observed-path-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.6rem 0.85rem;
    background: rgba(30, 58, 138, 0.35);
    border: 1px solid rgba(59, 130, 246, 0.45);
    border-radius: 0.375rem;
    margin-bottom: 0.75rem;
    font-size: 0.8125rem;
  }

  .observed-path-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: #93c5fd;
  }

  .observed-path-icon {
    font-size: 1rem;
  }

  .observed-path-text {
    line-height: 1.4;
  }

  .observed-path-btn {
    background: #2563eb;
    color: #ffffff;
    border: 1px solid #3b82f6;
    border-radius: 0.25rem;
    padding: 0.25rem 0.65rem;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s;
  }

  .observed-path-btn:hover {
    background: #1d4ed8;
  }
</style>
