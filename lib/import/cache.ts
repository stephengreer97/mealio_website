/**
 * Idempotency cache for the import pipeline (MEAL-70).
 *
 * Creators paste the same link twice — from the portal, then again after a
 * browser refresh — and the poller re-reads a feed that has not changed. Both
 * the gate verdict and the finished import are cached on the normalised URL;
 * re-classifying an unchanged URL is pure waste.
 *
 * The default store is process-local, which on Vercel means per-instance and
 * lost on cold start. That is deliberate for this ticket: it removes the
 * duplicate-submit and refresh cases, which are the ones that actually happen,
 * without adding a schema change. `ImportCache` is an interface precisely so a
 * durable backing store can be dropped in when the poller (MEAL-75) makes
 * cross-instance hits worth having.
 */

import type { GateVerdict, ImportResult } from './types';

export interface ImportCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

/** Process-local cache with TTL eviction and a bounded size. */
export class MemoryImportCache implements ImportCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now,
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    // Refresh insertion order so the hot keys survive eviction.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  /** Test helper. */
  clear(): void {
    this.entries.clear();
  }
}

/** A finished import is worth an hour; a creator editing a draft re-fetches rarely. */
export const IMPORT_TTL_MS = 60 * 60 * 1000;

/** Gate verdicts are cheap to re-derive but change even less often. */
export const GATE_TTL_MS = 24 * 60 * 60 * 1000;

export const importKey = (normalizedUrl: string) => `import:v1:${normalizedUrl}`;
export const gateKey = (normalizedUrl: string) => `gate:v1:${normalizedUrl}`;

/** The process-wide default. Swap via `runImport({ cache })` in tests. */
export const defaultImportCache = new MemoryImportCache();

export type { GateVerdict, ImportResult };
