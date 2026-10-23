'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { ImportRejection, ImportSuccess } from '@/lib/import/types';
import { hostLabel } from '@/lib/import/draft-form';
import { PASTED_TEXT_MAX, PASTED_TEXT_MIN } from '@/lib/import/limits';

/**
 * "Import a recipe" at the top of Add Meal: paste a link or paste the recipe
 * text, and the form below fills in. Nothing is saved here; the user still
 * picks a store and presses Create Meal.
 *
 * Talks to `POST /api/meals/import`. Every answer that is not a draft gets a
 * sentence and, where there is one, a next step: the creator's own version, an
 * import-again for a link they already have, the paste box for a site that
 * blocked us, the pricing page for a free user who has used their import.
 */

export type MealImportSuccess = ImportSuccess & { freeImportsLeft: number | null };

type Prompt =
  | { kind: 'creator-match'; meal: { id: string; name: string; creatorName: string | null } }
  | { kind: 'duplicate'; meal: { id: string; name: string } }
  | { kind: 'upgrade'; message: string }
  | { kind: 'error'; message: string; suggestPaste?: boolean };

export interface MealImportPanelProps {
  accessToken: string;
  onImported: (result: MealImportSuccess) => void;
}

const field: React.CSSProperties = { border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' };

function withScheme(raw: string): string {
  const url = raw.trim();
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export default function MealImportPanel({ accessToken, onImported }: MealImportPanelProps) {
  const [mode, setMode] = useState<'link' | 'text'>('link');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // The modal can close while a request is in flight; its answer must not fill
  // a form that is gone. Only the newest request may write.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const tooLong = text.length > PASTED_TEXT_MAX;
  const canImport = !busy && (mode === 'link' ? Boolean(url.trim()) : text.trim().length >= PASTED_TEXT_MIN && !tooLong);

  const run = async (extra: { ignoreCreatorMatch?: boolean; ignoreDuplicate?: boolean } = {}) => {
    if (busy) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setPrompt(null);
    setDone(null);
    const link = withScheme(url);
    try {
      const res = await fetch('/api/meals/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(mode === 'link' ? { url: link, ...extra } : { text: text.trim() }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (controller.signal.aborted) return;

      if (res.ok && data.status === 'ok') {
        const result = data as MealImportSuccess;
        onImported(result);
        const from = mode === 'link' ? `from ${hostLabel(result.url || link)}` : 'from your text';
        setDone(
          `Filled in ${from}. Check the form, pick a store, and press Create Meal.` +
            (result.freeImportsLeft === 0 ? ' That was your free import.' : ''),
        );
        return;
      }
      if (data.status === 'creator-match') { setPrompt({ kind: 'creator-match', meal: data.meal }); return; }
      if (data.status === 'duplicate') { setPrompt({ kind: 'duplicate', meal: data.meal }); return; }
      if (data.status === 'upgrade-required') { setPrompt({ kind: 'upgrade', message: data.error }); return; }
      if (data.status === 'rejected') {
        const rejection = data as ImportRejection & { suggestPaste?: boolean };
        setPrompt({ kind: 'error', message: rejection.detail, suggestPaste: rejection.suggestPaste });
        return;
      }
      setPrompt({ kind: 'error', message: data.error || 'That import did not work. Try again in a moment.' });
    } catch (err) {
      if (controller.signal.aborted) return;
      setPrompt({ kind: 'error', message: err instanceof Error ? err.message : 'That import did not work. Try again in a moment.' });
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const tab = (value: 'link' | 'text', label: string) => (
    <button
      type="button"
      onClick={() => { setMode(value); setPrompt(null); setDone(null); }}
      aria-pressed={mode === value}
      className="text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
      style={mode === value
        ? { background: 'var(--surface-raised)', color: 'var(--text-1)', boxShadow: 'var(--shadow-sm)' }
        : { background: 'none', color: 'var(--text-3)' }}
    >
      {label}
    </button>
  );

  return (
    <div className="rounded-xl p-3 space-y-2.5" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }} data-testid="meal-import">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-ml-t2">Import a recipe</span>
        <div className="flex gap-1 rounded-lg p-0.5" style={{ background: 'var(--border)' }}>
          {tab('link', 'Paste a link')}
          {tab('text', 'Paste text')}
        </div>
      </div>

      {mode === 'link' ? (
        <input
          type="url"
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && canImport) { e.preventDefault(); void run(); } }}
          placeholder="https://… a recipe page"
          aria-label="Recipe link"
          className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
          style={field}
        />
      ) : (
        <div>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            rows={5}
            placeholder="Paste the recipe: the ingredients and the method."
            aria-label="Recipe text"
            className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none resize-y"
            style={field}
          />
          <p className="text-[11px] mt-0.5" style={{ color: tooLong ? 'var(--brand)' : 'var(--text-3)' }} data-testid="meal-import-count">
            {text.length.toLocaleString('en-US')} / {PASTED_TEXT_MAX.toLocaleString('en-US')} characters
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={() => void run()}
        disabled={!canImport}
        className="w-full rounded-lg px-3 py-2 text-sm font-semibold transition-opacity disabled:opacity-50"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', color: 'var(--text-1)' }}
      >
        {busy ? 'Reading the recipe… about 10 seconds' : 'Import'}
      </button>

      {done && <p className="text-xs" style={{ color: 'var(--success, #16A34A)' }} data-testid="meal-import-done">{done}</p>}

      {prompt?.kind === 'creator-match' && (
        <div className="text-xs space-y-2" data-testid="meal-import-creator-match">
          <p className="text-ml-t2">
            {prompt.meal.creatorName ? `This is ${prompt.meal.creatorName}’s recipe on Mealio.` : 'This recipe is on Mealio.'}{' '}
            Saving their version supports them.
          </p>
          <div className="flex gap-2 flex-wrap">
            <Link href={`/meal/p/${prompt.meal.id}`} className="font-semibold px-3 py-1.5 rounded-lg text-white" style={{ background: 'var(--brand)' }}>
              {prompt.meal.creatorName ? `See ${prompt.meal.creatorName}’s version` : 'See it on Mealio'}
            </Link>
            <button type="button" onClick={() => void run({ ignoreCreatorMatch: true })} className="font-semibold px-3 py-1.5 rounded-lg text-ml-t2" style={{ border: '1px solid var(--border)' }}>
              Import my own copy
            </button>
          </div>
        </div>
      )}

      {prompt?.kind === 'duplicate' && (
        <div className="text-xs space-y-2" data-testid="meal-import-duplicate">
          <p className="text-ml-t2">You already have “{prompt.meal.name}” from this link.</p>
          <button type="button" onClick={() => void run({ ignoreCreatorMatch: true, ignoreDuplicate: true })} className="font-semibold px-3 py-1.5 rounded-lg text-ml-t2" style={{ border: '1px solid var(--border)' }}>
            Import it again
          </button>
        </div>
      )}

      {prompt?.kind === 'upgrade' && (
        <div className="text-xs space-y-2" data-testid="meal-import-upgrade">
          <p className="text-ml-t2">{prompt.message}</p>
          <Link href="/pricing" className="inline-block font-semibold px-3 py-1.5 rounded-lg text-white" style={{ background: 'var(--brand)' }}>
            See Full Access
          </Link>
        </div>
      )}

      {prompt?.kind === 'error' && (
        <div className="text-xs space-y-2" data-testid="meal-import-error">
          <p style={{ color: 'var(--brand)' }}>{prompt.message}</p>
          {prompt.suggestPaste && (
            <button type="button" onClick={() => { setMode('text'); setPrompt(null); }} className="font-semibold px-3 py-1.5 rounded-lg text-ml-t2" style={{ border: '1px solid var(--border)' }}>
              Paste the recipe text instead
            </button>
          )}
          {!prompt.suggestPaste && <p className="text-ml-t3">You can still fill the form in yourself.</p>}
        </div>
      )}
    </div>
  );
}
