import type { InlineHostHandle } from './types';

/**
 * Idempotent lifecycle manager for active inline recovery hosts.
 *
 * Guarantees:
 * - Exactly one inline host per remote/message ID.
 * - Clean unmounting and full restoration of host DOM styles.
 * - Route-scoped cache lifecycle.
 */
export class InlineRecoveryLedger {
  private activeHandles = new Map<string, InlineHostHandle>();

  get(id: string): InlineHostHandle | undefined {
    return this.activeHandles.get(id);
  }

  has(id: string): boolean {
    return this.activeHandles.has(id);
  }

  get size(): number {
    return this.activeHandles.size;
  }

  registerHandle(id: string, handle: InlineHostHandle): void {
    // If an existing handle is already mounted for this ID, unmount it first
    const existing = this.activeHandles.get(id);
    if (existing) {
      existing.unmount();
      this.activeHandles.delete(id);
    }
    this.activeHandles.set(id, handle);
  }

  unmount(id: string): boolean {
    const handle = this.activeHandles.get(id);
    if (!handle) return false;
    handle.unmount();
    this.activeHandles.delete(id);
    return true;
  }

  unmountAll(): void {
    for (const handle of this.activeHandles.values()) {
      try {
        handle.unmount();
      } catch {
        // Fail-open
      }
    }
    this.activeHandles.clear();
  }

  getAllHandles(): readonly InlineHostHandle[] {
    return Array.from(this.activeHandles.values());
  }
}
