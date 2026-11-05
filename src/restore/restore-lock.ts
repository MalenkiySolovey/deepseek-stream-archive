/**
 * Cross-Context Mutex & Read-Write Lock Coordinator for Chrome MV3.
 *
 * Implements genuine platform-level mutual exclusion using the Web Locks API (navigator.locks):
 * 1. Mode 'exclusive':
 *    - Used by destructive operations: Replace, Merge, Crash Recovery, and Clear Archive.
 *    - Only ONE context across all tabs, workers, and sidepanels can execute exclusively.
 *    - Automatically released by the browser kernel if a renderer process, tab, or worker crashes (SIGKILL, OOM).
 * 2. Mode 'shared':
 *    - Used by regular background and tab storage writes (messages, revisions, raw streams, continuity receipts).
 *    - Multiple writes execute concurrently without contention.
 *    - Queues safely when an exclusive Restore operation is in progress, preventing silent data loss during liveDb clear.
 * 3. Fallback AsyncRwLock:
 *    - Provides identical reader-writer lock semantics for non-browser Node.js test runners where navigator.locks is absent.
 * 4. Diagnostic Lease in chrome.storage.local:
 *    - Records operator, timestamps, and active stage for cross-context inspection and UI display without acting as an unatomic mutex.
 */

export const WEB_LOCK_NAME = 'streamarchive_restore_mutex';
export const STORAGE_LOCK_KEY = '__streamarchive_restore_lock__';
export const LOCK_LEASE_MS = 60_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Determines whether code is running within a browser extension environment
 * where Web Locks API (navigator.locks) is strictly mandatory for cross-tab coordination.
 */
export function isBrowserExtensionRuntime(): boolean {
  if ((globalThis as any).__FORCE_BROWSER_LOCK_REQUIREMENT === true) {
    return true;
  }
  const isVitest = typeof process !== 'undefined' && Boolean(process.env?.VITEST);
  if (isVitest && !(globalThis as any).__ENFORCE_BROWSER_WEB_LOCKS_IN_VITEST__) {
    return false;
  }
  if (typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id)) {
    return true;
  }
  if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
    return true;
  }
  return false;
}

export interface RestoreLockLease {
  lockId: string;
  operation: string;
  mode: 'exclusive' | 'shared';
  acquiredAt: number;
  expiresAt: number;
}

export interface RestoreLockHandle {
  lockId: string;
  release: () => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-Memory Asynchronous Reader-Writer Lock for Node.js / Test Fallback
// ─────────────────────────────────────────────────────────────────────────────

interface Waiter {
  id: string;
  mode: 'exclusive' | 'shared';
  operation: string;
  grant: () => void;
  reject: (err: any) => void;
  signal?: AbortSignal;
}

class AsyncRwLock {
  private activeExclusive: string | null = null;
  private activeShared = new Set<string>();
  private queue: Waiter[] = [];

  isExclusiveLocked(): boolean {
    return this.activeExclusive !== null;
  }

  getActiveExclusive(): string | null {
    return this.activeExclusive;
  }

  acquire(mode: 'exclusive' | 'shared', operation: string, signal?: AbortSignal): Promise<() => void> {
    const id = `${mode}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    return new Promise<() => void>((resolve, reject) => {
      if (signal?.aborted) {
        return reject(signal.reason || new Error('Lock acquisition aborted before acquire'));
      }

      const grant = () => {
        if (mode === 'exclusive') {
          this.activeExclusive = id;
        } else {
          this.activeShared.add(id);
        }
        resolve(() => this.release(id, mode));
      };

      // Check if can be granted immediately (FIFO fairness: queue must be empty for shared)
      if (mode === 'shared') {
        if (this.activeExclusive === null && this.queue.length === 0) {
          grant();
          return;
        }
      } else {
        if (this.activeExclusive === null && this.activeShared.size === 0) {
          grant();
          return;
        }
      }

      // Must queue
      const waiter: Waiter = { id, mode, operation, grant, reject, signal };

      const onAbort = () => {
        const idx = this.queue.indexOf(waiter);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
        }
        reject(signal?.reason || new Error(`[RestoreLock] Lock acquisition timed out for operation "${operation}"`));
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.queue.push(waiter);
    });
  }

  private release(id: string, mode: 'exclusive' | 'shared'): void {
    if (mode === 'exclusive') {
      if (this.activeExclusive === id) {
        this.activeExclusive = null;
      }
    } else {
      this.activeShared.delete(id);
    }
    this.pumpQueue();
  }

  private pumpQueue(): void {
    if (this.activeExclusive !== null) {
      return; // Still exclusively locked
    }

    if (this.queue.length === 0) {
      return;
    }

    const next = this.queue[0];
    if (!next) return;

    if (next.mode === 'exclusive') {
      if (this.activeShared.size === 0) {
        this.queue.shift();
        next.grant();
      }
      return;
    }

    // Next is shared: grant it and all subsequent consecutive shared waiters
    while (this.queue.length > 0 && this.queue[0]?.mode === 'shared') {
      const sharedWaiter = this.queue.shift()!;
      sharedWaiter.grant();
    }
  }
}

const fallbackLock = new AsyncRwLock();

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic chrome.storage.local Lease Tracking
// ─────────────────────────────────────────────────────────────────────────────

async function setStorageLease(lease: RestoreLockLease | null): Promise<void> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      if (lease) {
        await chrome.storage.local.set({ [STORAGE_LOCK_KEY]: lease });
      } else {
        await chrome.storage.local.remove(STORAGE_LOCK_KEY);
      }
    }
  } catch {
    // Non-blocking diagnostic tracking
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Web Lock Execution API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executes a critical operation inside an exclusive Web Lock across all Chrome MV3 contexts.
 * All other exclusive restore operations and regular shared storage writes will safely wait.
 */
export async function withExclusiveRestoreLock<T>(
  operation: 'replace' | 'merge' | 'recovery' | 'clear' | string,
  fn: () => Promise<T>,
  timeoutMs: number = 30_000
): Promise<T> {
  const lockId = `exclusive-${operation}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const hasWebLocks = typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';

  if (!hasWebLocks && isBrowserExtensionRuntime()) {
    throw new Error(
      `[RestoreLock] Web Locks API (navigator.locks) is required in browser runtime for exclusive operation "${operation}". ` +
      `Refusing fallback to process-local lock to avoid cross-context data corruption.`
    );
  }

  let timer: any = null;
  const controller = new AbortController();
  if (timeoutMs > 0 && typeof setTimeout !== 'undefined') {
    timer = setTimeout(() => {
      controller.abort(
        new Error(`[RestoreLock] Timed out waiting for exclusive restore lock for operation "${operation}" after ${timeoutMs}ms`)
      );
    }, timeoutMs);
  }

  let heartbeatInterval: any = null;
  const startHeartbeat = () => {
    heartbeatInterval = setInterval(async () => {
      await setStorageLease({
        lockId,
        operation,
        mode: 'exclusive',
        acquiredAt: Date.now(),
        expiresAt: Date.now() + LOCK_LEASE_MS,
      });
    }, HEARTBEAT_INTERVAL_MS);
  };

  const stopHeartbeat = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  };

  try {
    if (hasWebLocks) {
      return await navigator.locks.request(
        WEB_LOCK_NAME,
        { mode: 'exclusive', signal: controller.signal },
        async () => {
          if (timer) clearTimeout(timer);
          await setStorageLease({
            lockId,
            operation,
            mode: 'exclusive',
            acquiredAt: Date.now(),
            expiresAt: Date.now() + LOCK_LEASE_MS,
          });
          startHeartbeat();
          try {
            return await fn();
          } finally {
            stopHeartbeat();
            await setStorageLease(null);
          }
        }
      );
    } else {
      // Fallback for non-browser runner
      const release = await fallbackLock.acquire('exclusive', operation, controller.signal);
      if (timer) clearTimeout(timer);
      await setStorageLease({
        lockId,
        operation,
        mode: 'exclusive',
        acquiredAt: Date.now(),
        expiresAt: Date.now() + LOCK_LEASE_MS,
      });
      startHeartbeat();
      try {
        return await fn();
      } finally {
        stopHeartbeat();
        await setStorageLease(null);
        release();
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    stopHeartbeat();
  }
}

/**
 * Executes a storage write operation inside a shared Web Lock.
 * Runs concurrently with other shared storage writes, but automatically pauses
 * if a destructive restore operation (Replace/Merge/Recovery) holds the exclusive lock.
 */
export async function withSharedStorageLock<T>(
  operation: string,
  fn: () => Promise<T>,
  timeoutMs: number = 180_000
): Promise<T> {
  const hasWebLocks = typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';

  if (!hasWebLocks && isBrowserExtensionRuntime()) {
    throw new Error(
      `[RestoreLock] Web Locks API (navigator.locks) is required in browser runtime for shared operation "${operation}". ` +
      `Refusing fallback to process-local lock to avoid cross-context data corruption.`
    );
  }

  let timer: any = null;
  const controller = new AbortController();
  const startTime = Date.now();
  const allowExtension = timeoutMs >= 10_000;
  const maxWaitMs = Math.max(timeoutMs, 300_000);

  const scheduleWatchdog = () => {
    const checkInterval = allowExtension ? Math.min(timeoutMs, 10_000) : timeoutMs;
    timer = setTimeout(async () => {
      const elapsed = Date.now() - startTime;
      if (allowExtension && elapsed < maxWaitMs) {
        try {
          const activeExclusive = await isRestoreLocked();
          if (activeExclusive) {
            // Long restore is still active and holding the lock: safely extend wait
            scheduleWatchdog();
            return;
          }
        } catch {
          // non-blocking
        }
      }
      controller.abort(
        new Error(`[RestoreLock] Timed out waiting for shared storage lock for operation "${operation}" after ${elapsed}ms`)
      );
    }, checkInterval);
  };

  if (timeoutMs > 0 && typeof setTimeout !== 'undefined') {
    scheduleWatchdog();
  }

  try {
    if (hasWebLocks) {
      return await navigator.locks.request(
        WEB_LOCK_NAME,
        { mode: 'shared', signal: controller.signal },
        async () => {
          if (timer) clearTimeout(timer);
          return await fn();
        }
      );
    } else {
      const release = await fallbackLock.acquire('shared', operation, controller.signal);
      if (timer) clearTimeout(timer);
      try {
        return await fn();
      } finally {
        release();
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Inspects whether an exclusive Restore operation is currently active.
 */
export async function isRestoreLocked(): Promise<boolean> {
  if (fallbackLock.isExclusiveLocked()) {
    return true;
  }

  if (typeof navigator !== 'undefined' && typeof navigator.locks?.query === 'function') {
    try {
      const snapshot = await navigator.locks.query();
      const hasExclusive = snapshot.held?.some((l) => l.name === WEB_LOCK_NAME && l.mode === 'exclusive');
      if (hasExclusive) return true;
    } catch {
      // ignore
    }
  }

  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const res = await chrome.storage.local.get(STORAGE_LOCK_KEY);
      const lease = res?.[STORAGE_LOCK_KEY] as RestoreLockLease | undefined;
      if (lease && lease.mode === 'exclusive' && Date.now() < lease.expiresAt) {
        return true;
      }
    }
  } catch {
    // ignore
  }

  return false;
}

/**
 * Legacy cooperative lock acquisition handle for backward compatibility.
 */
export async function acquireRestoreLock(
  operation: 'replace' | 'merge' | 'recovery' | string,
  timeoutMs: number = 10_000
): Promise<RestoreLockHandle> {
  let releaseDeferred: (() => void) | null = null;
  const lockAcquiredPromise = new Promise<void>((resolve, reject) => {
    withExclusiveRestoreLock(
      operation,
      () =>
        new Promise<void>((rel) => {
          releaseDeferred = rel;
          resolve();
        }),
      timeoutMs
    ).catch(reject);
  });

  await lockAcquiredPromise;
  const lockId = `handle-${operation}-${Date.now()}`;

  return {
    lockId,
    release: async () => {
      if (releaseDeferred) {
        releaseDeferred();
        releaseDeferred = null;
      }
    },
  };
}
