'use client';

import { useRef, useState } from 'react';
import type { ImportRejection, ImportResult, ImportSuccess } from '@/lib/import/types';
import { hostLabel, rejectionCopy, transportRejection } from '@/lib/import/draft-form';

/**
 * "Paste a link" — the top of the publish form (MEAL-73).
 *
 * Deliberately a *secondary* control. Publish is the one action a creator came
 * to take and keeps the only Signal Red on the screen (The One Tap Rule), so
 * Import is a Card White button on a Countertop well: obviously available,
 * never competing.
 *
 * The rejection path gets as much room as the success path, and on purpose.
 * With no `ANTHROPIC_API_KEY` provisioned the pipeline rejects at `extract`
 * every time, so in practice this is the branch a creator actually meets. It
 * has to leave them exactly where they'd have been without the feature: an
 * empty form, their link already in the Recipe URL box, and a sentence saying
 * what happened.
 */

export interface ImportLinkBarProps {
  /** Called with the pipeline's 200 body. The parent fills the form from it. */
  onImported: (result: ImportSuccess, url: string) => void;
  /** Called with the 422 body — or a synthesised one when the request itself failed. */
  onRejected: (rejection: ImportRejection, url: string) => void;
  /** True once a draft is on screen; the bar then offers to start over instead of re-importing. */
  hasDraft: boolean;
  onClearDraft: () => void;
}

function withScheme(raw: string): string {
  const url = raw.trim();
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export default function ImportLinkBar({
  onImported,
  onRejected,
  hasDraft,
  onClearDraft,
}: ImportLinkBarProps) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [rejection, setRejection] = useState<ImportRejection | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const runImport = async () => {
    const target = withScheme(url);
    if (!target || busy) return;

    setBusy(true);
    setRejection(null);
    try {
      const token = localStorage.getItem('accessToken');
      const res = await fetch('/api/creator/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url: target }),
      });

      let body: unknown = null;
      try { body = await res.json(); } catch { /* handled below */ }

      const result = body as ImportResult | { error?: string } | null;

      if (res.ok && result && (result as ImportResult).status === 'ok') {
        setUrl('');
        onImported(result as ImportSuccess, target);
        return;
      }

      // 422 carries a real ImportRejection. Anything else (403, 400, 500, an
      // unparseable body) is synthesised into one so there is exactly one
      // failure shape for the creator-facing copy to render.
      const rejected: ImportRejection =
        result && (result as ImportRejection).status === 'rejected'
          ? (result as ImportRejection)
          : transportRejection(
              target,
              (result as { error?: string } | null)?.error ??
                `The import service returned an unexpected response (HTTP ${res.status}).`,
            );

      setRejection(rejected);
      onRejected(rejected, target);
    } catch {
      const rejected = transportRejection(
        target,
        'We couldn’t reach the import service. Check your connection and try again.',
      );
      setRejection(rejected);
      onRejected(rejected, target);
    } finally {
      setBusy(false);
    }
  };

  const host = hostLabel(withScheme(url) || url);
  const copy = rejection ? rejectionCopy(rejection) : null;

  return (
    <div
      className="rounded-xl p-4"
      style={{ background: '#F4F3F1', border: '1px solid #E8E6E2' }}
      data-testid="import-link-bar"
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold" style={{ color: '#18181B' }}>
          Start from a link
        </p>
        {hasDraft && (
          <button
            type="button"
            onClick={() => { onClearDraft(); setRejection(null); setUrl(''); }}
            className="text-xs font-medium underline underline-offset-2"
            style={{ color: '#52525B' }}
          >
            Clear and start over
          </button>
        )}
      </div>
      <p className="text-xs mt-1 leading-relaxed" style={{ color: '#52525B' }}>
        Paste a recipe you have already published and we&apos;ll fill this form in.
        Every field it fills is marked with where it came from, and you can change all of it.
      </p>

      <div className="flex flex-col sm:flex-row gap-2 mt-3">
        <input
          ref={inputRef}
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={url}
          disabled={busy}
          onChange={e => { setUrl(e.target.value); if (rejection) setRejection(null); }}
          onKeyDown={e => {
            // The bar sits above the publish <form>, so Enter here can never
            // submit it — but it should still do the obvious thing.
            if (e.key === 'Enter') { e.preventDefault(); void runImport(); }
          }}
          placeholder="https://yourblog.com/your-recipe"
          aria-label="Recipe link to import"
          className="flex-1 min-w-0 rounded-[10px] px-3 py-2.5 outline-none focus:ring-2 disabled:opacity-60"
          // 16px, per DESIGN.md — anything smaller makes iOS zoom the page on focus,
          // and this is the field a creator touches first on a phone.
          style={{
            background: '#FFFFFF',
            border: '1px solid #E8E6E2',
            color: '#18181B',
            fontSize: '16px',
          }}
        />
        <button
          type="button"
          onClick={() => void runImport()}
          disabled={busy || !url.trim()}
          className="rounded-xl px-5 py-2.5 text-sm font-semibold whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          style={{ background: '#FFFFFF', border: '1px solid #D1CEC8', color: '#18181B' }}
        >
          {busy ? 'Reading…' : 'Import'}
        </button>
      </div>

      {busy && (
        <div className="flex items-start gap-2.5 mt-3" role="status" aria-live="polite">
          <span
            className="mt-0.5 w-3.5 h-3.5 rounded-full border-2 animate-spin flex-shrink-0"
            style={{ borderColor: '#D1CEC8', borderTopColor: '#52525B' }}
            aria-hidden="true"
          />
          <p className="text-xs leading-relaxed" style={{ color: '#52525B' }}>
            Reading {host} — fetching the page, then pulling the recipe out of it.
            This can take up to a minute.
          </p>
        </div>
      )}

      {copy && !busy && (
        <div
          className="mt-3 rounded-xl px-3.5 py-3"
          style={{ background: '#FEF2F2', border: '1px solid #FBD5D5' }}
          role="alert"
        >
          <p className="text-xs font-semibold" style={{ color: '#B91C1C' }}>{copy.heading}</p>
          {/* `detail` is the pipeline's own creator-safe prose — rendered as written. */}
          <p className="text-xs mt-1 leading-relaxed" style={{ color: '#52525B' }}>{copy.detail}</p>
          <p className="text-xs mt-2 leading-relaxed" style={{ color: '#52525B' }}>{copy.next}</p>
        </div>
      )}
    </div>
  );
}
