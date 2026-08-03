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

import { createHash } from 'crypto';
import type { GateVerdict, ImportResult, SourceDocument } from './types';

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

import { urlIdentity } from './ssrf';

/** A finished import is worth an hour; a creator editing a draft re-fetches rarely. */
export const IMPORT_TTL_MS = 60 * 60 * 1000;

/** Gate verdicts are cheap to re-derive but change even less often. */
export const GATE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Distinguishes two documents that share a URL.
 *
 * One URL is not one document. A YouTube watch link fetched as a page is a
 * JavaScript shell with no recipe in it; the same link supplied by MEAL-74 as
 * title + description + captions is the recipe itself. Keyed on the URL alone
 * they share a cache entry, and whichever ran first decides for the other.
 *
 * Only the fields the gate and the extractor actually read, so a document that
 * differs solely in, say, its thumbnail URL still hits. Joined on a NUL, which
 * cannot occur in any of them, so no two field splits produce one digest.
 */
export function documentFingerprint(document: SourceDocument): string {
  return createHash('sha256')
    .update([document.title, document.text, document.recipeText, document.jsonLdRaw ?? ''].join('\u0000'))
    .digest('hex')
    .slice(0, 32);
}

/**
 * Two independent reasons a key is not just the URL, and both apply.
 *
 * `urlIdentity` rather than the raw string: three spellings of one link
 * (http/https, with and without `www.`) are one page, and paying for the same
 * extraction three times is the cheap half of that mistake.
 *
 * `scope` is absent for a fetched page — the URL is the whole identity, and the
 * keys stay exactly what they were before — and is a document fingerprint when
 * the caller supplied the content themselves, per the note above.
 */
const scoped = (prefix: string, url: string, scope?: string) => {
  const identity = urlIdentity(url) ?? url;
  return scope ? prefix + ':' + identity + ':' + scope : prefix + ':' + identity;
};

export const importKey = (url: string, scope?: string) => scoped('import:v1', url, scope);
export const gateKey = (url: string, scope?: string) => scoped('gate:v1', url, scope);

/** The process-wide default. Swap via `runImport({ cache })` in tests. */
export const defaultImportCache = new MemoryImportCache();

export type { GateVerdict, ImportResult };
