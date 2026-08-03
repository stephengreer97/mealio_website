'use client';

import { useState } from 'react';
import { normalizePlatformUrl, PLATFORM_SOURCES, SOURCE_LABELS, type PlatformSource } from '@/lib/creator-sources';

/**
 * The four places a creator publishes, editable by the creator (MEAL-94).
 *
 * They are collected on the application form and copied onto the row at
 * approval, and until this card there was no way to change them afterwards. A
 * creator who joined without a YouTube channel and started one six months later
 * could not tell us — which silently blocked connecting it, the append setting
 * (MEAL-78), a source switch, and back-catalog import. Their only route was
 * asking an operator to edit the row by hand, which is the manual step MEAL-81
 * argued against for feed URLs.
 *
 * Validated with `normalizePlatformUrl` — the application form's own function,
 * called here only to catch a typo before the round trip. The server calls the
 * same one and it is the one that decides.
 *
 * Adding a link tells us a place exists and nothing more: which source Mealio
 * polls, and whether it polls at all, stay an operator decision (MEAL-81), so
 * nothing on this card can turn importing on. Touching the link that *is* being
 * polled — changing it or clearing it, one rule for both — can turn it off: the
 * server pauses the import pending review and says so, and this card stops
 * claiming otherwise the moment it hears that back.
 */

const PLACEHOLDERS: Record<PlatformSource, string> = {
  website: 'chefsarah.com',
  youtube: 'youtube.com/@chefsarah',
  instagram: 'instagram.com/chefsarah',
  tiktok: 'tiktok.com/@chefsarah',
};

export interface CreatorLinks {
  website_url: string | null;
  youtube_url: string | null;
  instagram_url: string | null;
  tiktok_url: string | null;
  primary_source?: string | null;
  import_opt_in?: boolean | null;
}

interface Props {
  creator: CreatorLinks;
  /** Handed the saved links so the portal's own copy stays in step. */
  onSaved: (links: Record<PlatformSource, string | null>) => void;
}

const COLUMN: Record<PlatformSource, keyof CreatorLinks> = {
  website: 'website_url',
  youtube: 'youtube_url',
  instagram: 'instagram_url',
  tiktok: 'tiktok_url',
};

function initialValues(creator: CreatorLinks): Record<PlatformSource, string> {
  return {
    website: (creator[COLUMN.website] as string | null) ?? '',
    youtube: (creator[COLUMN.youtube] as string | null) ?? '',
    instagram: (creator[COLUMN.instagram] as string | null) ?? '',
    tiktok: (creator[COLUMN.tiktok] as string | null) ?? '',
  };
}

export default function PlatformLinksCard({ creator, onSaved }: Props) {
  const [values, setValues] = useState(() => initialValues(creator));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [notices, setNotices] = useState<string[]>([]);
  /**
   * Set from the save that paused the import, because `creator` is the portal's
   * copy of a row the server has just changed. Without it the banner below would
   * go on saying "Mealio is importing your recipes" directly above a notice
   * saying we have stopped — until something reloaded the page.
   */
  const [paused, setPaused] = useState(false);

  /**
   * The source Mealio actually polls, when it is polling at all.
   *
   * Said before they try to edit it rather than only when the save is refused:
   * "this is where your recipes come from" is why changing that link pauses the
   * import and why removing it is refused outright, and a creator who reads it
   * first is never surprised by either.
   */
  const polled =
    !paused && creator.import_opt_in === true && creator.primary_source && creator.primary_source !== 'none'
      ? (creator.primary_source as PlatformSource)
      : null;

  const save = async () => {
    setError('');
    setSaved(false);
    setNotices([]);
    // Same rules the route enforces, from the same function, run here so a typo
    // costs a keystroke instead of a round trip.
    for (const source of PLATFORM_SOURCES) {
      const result = normalizePlatformUrl(source, values[source]);
      if (!result.ok) { setError(`${SOURCE_LABELS[source]}: ${result.error}`); return; }
    }

    setSaving(true);
    try {
      const token = typeof window === 'undefined' ? '' : localStorage.getItem('accessToken') ?? '';
      const res = await fetch('/api/creator/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ links: values }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Could not save those links.');
        return;
      }
      // Normalised server-side, so what is shown from here on is what is stored
      // — a creator who typed `chefsarah.com` sees the link we will actually
      // fetch rather than the shorthand they typed.
      const stored = {} as Record<PlatformSource, string | null>;
      for (const source of PLATFORM_SOURCES) {
        const result = normalizePlatformUrl(source, values[source]);
        stored[source] = result.ok ? result.url : null;
      }
      setValues({
        website: stored.website ?? '', youtube: stored.youtube ?? '',
        instagram: stored.instagram ?? '', tiktok: stored.tiktok ?? '',
      });
      setNotices(Array.isArray(data.notices) ? data.notices : []);
      if (data.importPaused === true) setPaused(true);
      setSaved(true);
      onSaved(stored);
    } catch {
      setError('Could not save those links.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-0.5">Where you publish</p>
      <h2 className="text-base font-bold text-gray-900 leading-tight mb-2">Your links</h2>
      <p className="text-sm text-gray-600 leading-relaxed mb-4">
        Add or change these any time. Started a channel since you applied? Add it here and Mealio can help fill in
        your meals from what you already post. Adding a link never starts anything on its own.
      </p>

      <div className="flex flex-col gap-2.5 mb-4">
        {PLATFORM_SOURCES.map(source => (
          <div key={source} className="flex items-center gap-3">
            <label htmlFor={`creator-link-${source}`} className="text-sm text-gray-500 w-20 flex-shrink-0">
              {SOURCE_LABELS[source]}
            </label>
            <input
              id={`creator-link-${source}`}
              value={values[source]}
              onChange={e => { setValues(prev => ({ ...prev, [source]: e.target.value })); setSaved(false); }}
              placeholder={PLACEHOLDERS[source]}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={saving}
              className="flex-1 min-w-0 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-red-200 focus:border-red-400 disabled:opacity-60 transition-colors"
            />
          </div>
        ))}
      </div>

      {polled && (
        <p className="text-xs text-gray-500 mb-4">
          Mealio is importing your recipes from your {SOURCE_LABELS[polled]}. Moved, renamed or finished with it?
          Change or clear it here and we&rsquo;ll pause the import &mdash; it&rsquo;s the one we publish from under
          your name, so it gets a look before anything starts again.
        </p>
      )}

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {notices.map(notice => (
        <p key={notice} className="text-sm text-gray-600 mb-3 leading-relaxed">{notice}</p>
      ))}

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-semibold rounded-xl px-5 py-2.5 transition-colors"
        >
          {saving ? 'Saving…' : 'Save links'}
        </button>
        {saved && <span className="text-sm text-green-700">Saved</span>}
      </div>
    </div>
  );
}
