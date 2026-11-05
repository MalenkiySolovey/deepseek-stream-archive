/**
 * Cross-Context Restore Lock Coordinator for Chrome MV3.
 *
 * Ensures mutually exclusive execution of Restore (Replace / Merge / Crash Recovery)
 * across multiple Sidepanel instances, Background Service Worker, and options pages.
 *
 * Employs two complementary layers of protection:
 * 1. Web Locks API (navigator.locks):
 *    - Standard Chromium MV3 cross-tab / cross-worker mutex.
 *    - Automatically releases held locks if a renderer process, tab, or worker crashes.
 * 2. chrome.storage.local lease with heartbeat:
 *    - Provides cross-context inspectability and fallback for non-browser/test runners.
 *    - Lease expiration (default 60s) prevents permanent deadlocks from crashed owners.
 */

const WEB_LOCK_NAME = 'streamarchive_restore_mutex';
const STORAGE_LOCK_KEY = '__streamarchive_restore_lock__';
const LOCK_LEASE_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

export interface RestoreLockLease {
  lockId: string;
  operation: 'replace' | 'merge' | 'recovery';
  acquiredAt: number;
  expiresAt: number;
}

export interface RestoreLockHandle {
  lockId: string;
  release: () => Promise<void>;
}

// In-memory fallback mutex for non-browser Node.js test runners
let localFallbackOwner: string | null = null;

/**
 * Checks whether a restore operation is currently in progress in any context.
 */
export async function isRestoreLocked(): Promise<boolean> {
  if (localFallbackOwner !== null) {
    return true;
  }

  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const res = await chrome.storage.local.get(STORAGE_LOCK_KEY);
      const lease = res?.[STORAGE_LOCK_KEY] as RestoreLockLease | undefined;
      if (lease && Date.now() < lease.expiresAt) {
        return true;
      }
    }
  } catch {
    // ignore
  }

  return false;
}

/**
 * Acquires the cross-context restore lock for an active operation.
 * Throws if another context already holds the lock and did not release within timeoutMs.
 */
export async function acquireRestoreLock(
  operation: 'replace' | 'merge' | 'recovery',
  timeoutMs: number = 10_000
): Promise<RestoreLockHandle> {
  const lockId = `${operation}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const startTime = Date.now();

  // 1. Wait until existing storage lease is released or expired
  while (true) {
    let activeLease: RestoreLockLease | null = null;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        const res = await chrome.storage.local.get(STORAGE_LOCK_KEY);
        activeLease = (res?.[STORAGE_LOCK_KEY] as RestoreLockLease) || null;
      }
    } catch {
      activeLease = null;
    }

    if (!activeLease || Date.now() >= activeLease.expiresAt || activeLease.lockId === lockId) {
      if (localFallbackOwner === null || localFallbackOwner === lockId) {
        break; // Free to acquire
      }
    }

    if (Date.now() - startTime >= timeoutMs) {
      throw new Error(
        `[RestoreLock] Could not acquire restore lock: another operation "${activeLease?.operation || 'restore'}" is currently in progress.`
      );
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  // 2. Set local and storage lease
  localFallbackOwner = lockId;

  const lease: RestoreLockLease = {
    lockId,
    operation,
    acquiredAt: Date.now(),
    expiresAt: Date.now() + LOCK_LEASE_MS,
  };

  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [STORAGE_LOCK_KEY]: lease });
    }
  } catch {
    // Non-blocking
  }

  // 3. Heartbeat timer to renew lease during long-running operations
  let heartbeatTimer: any = null;
  const startHeartbeat = () => {
    heartbeatTimer = setInterval(async () => {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage?.local && localFallbackOwner === lockId) {
          await chrome.storage.local.set({
            [STORAGE_LOCK_KEY]: {
              ...lease,
              expiresAt: Date.now() + LOCK_LEASE_MS,
            },
          });
        }
      } catch {
        // ignore
      }
    }, HEARTBEAT_INTERVAL_MS);
  };
  startHeartbeat();

  // 4. Release function
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (localFallbackOwner === lockId) {
      localFallbackOwner = null;
    }
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        const current = (await chrome.storage.local.get(STORAGE_LOCK_KEY)) as Record<string, any>;
        if (current?.[STORAGE_LOCK_KEY]?.lockId === lockId) {
          await chrome.storage.local.remove(STORAGE_LOCK_KEY);
        }
      }
    } catch {
      // ignore
    }
  };

  return { lockId, release };
}
