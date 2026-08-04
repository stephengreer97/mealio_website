'use client';

import { useEffect, useRef, useState } from 'react';
import YouTubeConnectCard from './YouTubeConnectCard';
import PlatformConnectCard from './PlatformConnectCard';
import {
  CONNECTED_PLATFORMS,
  CREATOR_SELECTION_MAX,
  CREATOR_SOURCE_OPTIONS,
  creatorSourceBlockedReason,
  isCreatorSourceReady,
  normalizePlatformUrl,
  SOURCE_LABELS,
  type ConnectedPlatform,
  type PrimarySource,
} from '@/lib/creator-sources';
// Type-only: `lib/admin-sync` reaches the import pipeline and undici, and must
// never be bundled into the client. These imports are erased at compile time.
import type { CatalogEntry, CatalogResult, SyncRun, SyncRunTotals } from '@/lib/admin-sync';

/**
 * "Sync your content with Mealio" — one section, one dropdown, one body
 * (MEAL-101).
 *
 * It replaces four separate cards: a link editor and three connect cards, each
 * of which said a little about importing and none of which said what importing
 * *was*. A creator arriving at that pile had to work out that the four were one
 * feature, that only one of them would ever be used, and that connecting one did
 * something on a schedule nobody had mentioned.
 *
 * Three things this section is built around.
 *
 * **The promise is on the screen.** "New posts sync automatically and come back
 * to you as drafts" is the entire product and it appeared nowhere on the
 * creator's own page. It is the first thing here, before any control, because a
 * creator deciding whether to connect an account is deciding about *that* and
 * not about a button.
 *
 * **The first poll baselines.** Everything already published is marked seen
 * rather than imported (MEAL-75). Said plainly beside the checklist, because the
 * alternative is a creator connecting a source, watching nothing arrive, and
 * concluding it did not work — and because it is the reason the checklist exists
 * at all rather than a limitation to be quiet about.
 *
 * **Instagram and TikTok are visible, unselectable and say why.** Leaving them
 * out reads as "Mealio has not heard of Instagram"; offering them live is a dead
 * end reached *after* a decision, which is the worst order to put those two
 * things in. The reason rides on the option itself.
 *
 * Switching source keeps the OAuth grant and keeps `creator_source_items`.
 * Revoking a connection because somebody changed a dropdown is destructive and
 * surprising, and the items table exists precisely so that what has already been
 * handled is not handled again — the new source baselines on its first poll like
 * any other.
 */

export interface SyncSectionCreator {
  website_url: string | null;
  youtube_url: string | null;
  instagram_url: string | null;
  tiktok_url: string | null;
  /** Set once a website has been read and found importable. */
  feed_url?: string | null;
  primary_source?: string | null;
  import_opt_in?: boolean | null;
}

interface Props {
  creator: SyncSectionCreator;
  /** Handed the columns that changed, so the portal's own copy stays in step. */
  onSaved?: (changes: Partial<SyncSectionCreator>) => void;
}

/** How long between worker calls while a run is unfinished. */
const POLL_DELAY_MS = 750;

/**
 * Chunks one press of Import will drive. A 100-item run at two per chunk needs
 * 50, so this is headroom — its job is to stop a run that is making no progress
 * from polling forever.
 */
const MAX_CHUNKS = 120;

const token = () => (typeof window === 'undefined' ? '' : localStorage.getItem('accessToken') ?? '');

function formatDate(value: string | null): string {
  if (!value) return '';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleDateString() : '';
}

/**
 * The source to open on.
 *
 * Three cases and they genuinely differ:
 *
 *   - A source this dropdown can show is shown. Obviously.
 *   - A row an operator left on **Instagram or TikTok** opens on `none`. The
 *     dropdown cannot display a value it will not let you select, and showing
 *     `website` instead would be a straightforward lie about what is being
 *     polled.
 *   - **Nothing chosen yet** opens on `website`, not on `none`. This is the
 *     state every newly approved creator is in, and landing them on an empty
 *     prompt with a paragraph about not reading them makes "no" the default
 *     answer to a question the section exists to ask. Website is where an
 *     unaided creator can get themselves working.
 *
 * Nothing is claimed by opening there: the "Mealio is watching your Website"
 * line renders off the row, not off the dropdown, and no write happens until the
 * creator touches something.
 */
function storedSource(creator: SyncSectionCreator): PrimarySource {
  const stored = creator.primary_source;
  if (stored === 'website' || stored === 'youtube') return stored;
  if (stored === 'instagram' || stored === 'tiktok') return 'none';
  return 'website';
}

/**
 * Which platform's consent screen this page load came back from, if any.
 *
 * Every connect callback returns to `/creator?<platform>=connected|failed|…`, so
 * the parameter names the platform. Checked for all of them rather than YouTube
 * alone: a creator who has just been through TikTok's screen — including one
 * TikTok turned down — has to land on the panel that can tell them what
 * happened, and the failure case is the one where landing elsewhere is worst.
 */
function returnedFromConnect(): ConnectedPlatform | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  return CONNECTED_PLATFORMS.find(platform => params.get(platform)) ?? null;
}

export default function SyncSourceSection({ creator, onSaved }: Props) {
  /**
   * The section's own copy of the four columns a source decision reads.
   *
   * Kept here because every control in the section writes one of them and then
   * has to render the result — a website Save writes three columns at once, and
   * re-reading the whole portal to find out what it wrote would blank the screen
   * a creator is mid-way through using.
   */
  const [row, setRow] = useState(creator);
  /**
   * The dropdown's value, which is a `PrimarySource` and not a `PlatformSource`
   * — `none` is a position on it, but not a selectable one.
   *
   * Consent that cannot be withdrawn is not consent, and withdrawing it is
   * Disconnect rather than an option in this list. A dropdown position could only
   * ever clear the row; the grant behind it lives in another table and would
   * have survived, which is not what a creator who said "stop" means.
   */
  const [source, setSource] = useState<PrimarySource>(() => storedSource(creator));

  const [websiteInput, setWebsiteInput] = useState(creator.website_url ?? '');
  const [websiteBusy, setWebsiteBusy] = useState(false);
  const [websiteError, setWebsiteError] = useState('');
  const [websiteDetail, setWebsiteDetail] = useState('');

  /**
   * Per-platform, and null until that platform's connect card has told us.
   *
   * Never inferred from the link columns. The grant lives in a different table
   * and a section that guessed one from the other would offer a catalogue for an
   * account nobody had connected — and, worse, would offer it for the *wrong*
   * account after a creator changed a link.
   */
  const [connected, setConnected] = useState<Partial<Record<ConnectedPlatform, boolean>>>({});
  const noteConnection = (platform: ConnectedPlatform) => (is: boolean) =>
    setConnected(current => (current[platform] === is ? current : { ...current, [platform]: is }));

  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const [run, setRun] = useState<SyncRun | null>(null);
  const [totals, setTotals] = useState<SyncRunTotals | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);

  // A run outlives a render and the worker loop keeps calling after the section
  // has gone. Without this a response landing post-unmount writes to dead state.
  const mounted = useRef(true);
  /** True once the creator has actually chosen something on this screen. */
  const chose = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /**
   * Land on YouTube after Google sends them back.
   *
   * The row still says whatever it said before the round trip — the grant lands
   * in a different table, and the source is only chosen once we know the
   * connection worked. Opening on the stored value would drop a creator who had
   * just connected a channel back on their old source with no sign that anything
   * had happened, which is the one impression this whole section exists to
   * prevent. In an effect rather than in the initial state so the server and the
   * first client render agree.
   */
  useEffect(() => {
    const returned = returnedFromConnect();
    // Instagram is not selectable, so a stray `?instagram=` must not strand the
    // dropdown on a value it will not show.
    if (!returned || creatorSourceBlockedReason(returned)) return;
    chose.current = true;
    setSource(returned);
  }, []);

  const authed = async (path: string, body: unknown, method = 'POST') => {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify(body),
    });
    return { res, data: await res.json().catch(() => ({} as any)) };
  };

  /** Is this source in a state Mealio can actually read? */
  const ready =
    source === 'website'
      ? isCreatorSourceReady({ ...row }, 'website')
      : source === 'none'
        ? false
        : connected[source] === true;

  const syncingFromThis = row.import_opt_in === true && row.primary_source === source;

  /**
   * Puts the creator's choice on the row.
   *
   * Called when they pick a ready source, and when the source they have picked
   * *becomes* ready — connecting a channel is the answer to the question the
   * dropdown asked, so it takes effect there rather than waiting for a second
   * press nobody would know to make.
   */
  const chooseSource = async (next: PrimarySource) => {
    setSwitching(true);
    setError('');
    const { res, data } = await authed('/api/creator/me', { primarySource: next }, 'PATCH');
    if (!mounted.current) return;
    setSwitching(false);
    if (!res.ok) {
      setError(data.error || 'Could not change where Mealio syncs from.');
      return;
    }
    const changes = { primary_source: next, import_opt_in: next !== 'none' };
    setRow(current => ({ ...current, ...changes }));
    onSaved?.(changes);
  };

  /**
   * Stop syncing, and forget the connection it was reading.
   *
   * Both halves, in that order, because either one alone leaves a state nobody
   * asked for. Revoking the grant on its own leaves the row saying "sync from
   * YouTube, opted in" with nothing behind it — pollable according to the
   * column and unreadable in fact. Clearing the row on its own leaves Mealio
   * holding a live token for an account it has been told to stop reading, which
   * is not what a creator who pressed Disconnect believes they did.
   *
   * The revocation goes first and a failure stops everything. Telling somebody
   * their account is disconnected while the token is still live at the provider
   * is the one error here they would never think to check.
   */
  const disconnect = async () => {
    if (source === 'none') return;
    setSwitching(true);
    setError('');

    if (source !== 'website') {
      const res = await fetch(`/api/creator/${source}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token()}` },
      });
      if (!mounted.current) return;
      if (!res.ok) {
        setSwitching(false);
        const data = await res.json().catch(() => null);
        setError(data?.error || `We could not disconnect your ${label}. It is still connected — please try again.`);
        return;
      }
      setConnected(current => ({ ...current, [source]: false }));
    }

    // Clearing the website link is the website's equivalent of revoking a grant:
    // it is the whole of what Mealio was given, and leaving it behind would make
    // Disconnect mean something different depending on which source was chosen.
    const body = source === 'website'
      ? { primarySource: 'none', links: { website: '' } }
      : { primarySource: 'none' };
    const { res, data } = await authed('/api/creator/me', body, 'PATCH');
    if (!mounted.current) return;
    setSwitching(false);
    if (!res.ok) {
      setError(data.error || 'We stopped reading your account, but could not save the change. Please try again.');
      return;
    }

    const changes = {
      primary_source: 'none' as PrimarySource,
      import_opt_in: false,
      ...(source === 'website' ? { website_url: null, feed_url: null } : {}),
    };
    setRow(current => ({ ...current, ...changes }));
    onSaved?.(changes);

    // Back to the unanswered state, and everything the old source put on screen
    // goes with it.
    chose.current = false;
    setSource('none');
    setWebsiteInput('');
    setCatalog(null);
    setSelected([]);
    setRun(null);
    setTotals(null);
  };

  const pickSource = (next: PrimarySource) => {
    if (next === source) return;
    chose.current = true;
    setSource(next);
    // Nothing about the old source survives the switch. A checklist of somebody
    // else's blog posts sitting under a YouTube heading is the worst thing this
    // section could leave on screen.
    setCatalog(null);
    setSelected([]);
    setRun(null);
    setTotals(null);
    setError('');
    setWebsiteError('');
    setWebsiteDetail('');
  };

  /**
   * The choice takes effect as soon as it can: on selection when the source is
   * already connected, and on connection when it is not — connecting a channel
   * is the answer to the question the dropdown asked, so waiting for a second
   * press nobody would know to make is how a creator connects YouTube and then
   * finds nothing is syncing.
   *
   * Only ever after the creator has touched something. `chose` is what keeps a
   * page load from writing anything: without it a row an operator had set to
   * Instagram — which this dropdown cannot show, so it opens unanswered —
   * would have that decision silently reversed by somebody opening the portal.
   */
  useEffect(() => {
    if (switching || !chose.current) return;
    if (source === 'none') {
      if (row.primary_source !== 'none' || row.import_opt_in === true) chooseSource('none');
      return;
    }
    if (!ready) return;
    if (row.primary_source === source && row.import_opt_in === true) return;
    chooseSource(source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, source, row.primary_source, row.import_opt_in]);

  const loadCatalog = async () => {
    setLoadingCatalog(true);
    setError('');
    const { res, data } = await authed('/api/creator/sync/catalog', { source });
    if (!mounted.current) return;
    setLoadingCatalog(false);
    // A 422 still carries a catalogue — one that says why it could not be
    // listed, which is the useful half. Only a response with neither is a
    // failure of this call rather than an answer from it.
    if (!data.catalog) {
      setError((!res.ok && data.error) || 'Could not read what you have published.');
      return;
    }
    setCatalog(data.catalog as CatalogResult);
  };

  // Drawn as soon as there is something to draw. It costs a feed read and one
  // database query — no page is fetched and no model is called — so making a
  // creator press a button to find out what Mealio can see would be ceremony
  // over a free answer, and the answer is the reason the section is worth
  // scrolling to.
  useEffect(() => {
    if (ready && !catalog && !loadingCatalog) loadCatalog();
    // `feed_url` is in here so saving a *different* website re-draws the list:
    // the checklist is of one site's posts, and leaving the old one up beside a
    // new address is the wrong list under the right heading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, source, row.feed_url]);

  const saveWebsite = async () => {
    setWebsiteError('');
    setWebsiteDetail('');
    // The same validator the server uses, run here only to catch a typo before a
    // round trip that takes several seconds.
    const check = normalizePlatformUrl('website', websiteInput);
    if (!check.ok) { setWebsiteError(check.error); return; }
    if (!check.url) { setWebsiteError('Type the address of your website or blog, then press Save.'); return; }

    setWebsiteBusy(true);
    try {
      const { res, data } = await authed('/api/creator/website', { url: websiteInput });
      if (!mounted.current) return;
      if (!res.ok || data.ok !== true) {
        setWebsiteError(data.error || 'We could not check that site. Try again.');
        return;
      }
      setWebsiteInput(data.websiteUrl);
      setWebsiteDetail(data.detail ?? '');
      const changes = {
        website_url: data.websiteUrl as string,
        feed_url: data.feedUrl as string,
        primary_source: 'website',
        import_opt_in: true,
      };
      setRow(current => ({ ...current, ...changes }));
      onSaved?.(changes);
      // The catalogue is now a different site's.
      setCatalog(null);
      setSelected([]);
    } catch {
      if (mounted.current) setWebsiteError('We could not check that site. Try again.');
    } finally {
      if (mounted.current) setWebsiteBusy(false);
    }
  };

  const entries: CatalogEntry[] = catalog?.ok ? catalog.entries : [];
  const isImported = (entry: CatalogEntry) => entry.record?.status === 'imported';
  const unimported = entries.filter(entry => !isImported(entry));
  const atCap = selected.length >= CREATOR_SELECTION_MAX;

  const toggle = (itemId: string) => {
    setSelected(current => {
      if (current.includes(itemId)) return current.filter(id => id !== itemId);
      // The cap holds at the tick rather than at the button. A creator who
      // ticked 140 things and is then told to untick 40 has been made to do the
      // counting the screen was already doing.
      if (current.length >= CREATOR_SELECTION_MAX) return current;
      return [...current, itemId];
    });
  };

  /** Ticks what is not already in, up to the cap. */
  const selectAllNew = () =>
    setSelected(unimported.slice(0, CREATOR_SELECTION_MAX).map(entry => entry.itemId));

  /**
   * Drives the worker until the run stops moving.
   *
   * A chunk at a time, because a hundred imports do not fit in one function
   * call. The run lives in the database, so closing this tab delays it rather
   * than losing it — the daily sweep picks up whatever is left.
   */
  const drive = async (runId: string) => {
    for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
      const { res, data } = await authed('/api/creator/sync/worker', { runId });
      if (!mounted.current) return;
      if (!res.ok) {
        setError(data.error || 'That import stopped. It is saved — press Carry on to pick it up.');
        return;
      }
      const next = data.run as SyncRun;
      setRun(next);
      setTotals(data.totals as SyncRunTotals);
      if (next.status === 'done') return;
      if (next.status === 'running') {
        setError('This import is already running somewhere else — another tab, or Mealio finishing it off.');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, POLL_DELAY_MS));
      if (!mounted.current) return;
    }
    setError('That import is taking a while. It is saved — press Carry on to keep going.');
  };

  const startImport = async () => {
    if (busy || selected.length === 0) return;
    setBusy(true);
    setError('');
    setRun(null);
    setTotals(null);

    const { res, data } = await authed('/api/creator/sync', {
      source,
      items: entries
        .filter(entry => selected.includes(entry.itemId))
        .map(entry => ({ itemId: entry.itemId, url: entry.url, title: entry.title, publishedAt: entry.publishedAt })),
    });
    if (!mounted.current) return;
    if (!res.ok) {
      setBusy(false);
      setError(data.error || 'Could not start that import.');
      return;
    }
    const created = data.run as SyncRun;
    setRun(created);
    await drive(created.id);
    if (mounted.current) setBusy(false);
  };

  const resume = async () => {
    if (!run || busy) return;
    setBusy(true);
    setError('');
    await drive(run.id);
    if (mounted.current) setBusy(false);
  };

  // Only ever read where a source is actually selected; `none` has no place to
  // name, and the copy that would have named it says something else entirely.
  const label = source === 'none' ? '' : SOURCE_LABELS[source];

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 sm:p-6" data-testid="sync-source-section">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-0.5">Your recipes</p>
      <h2 className="text-base font-bold text-gray-900 leading-tight mb-2">Sync your content with Mealio</h2>

      {/* The promise, before any control. It is the whole of what this section
          does and it was nowhere on the creator's screen before MEAL-101. */}
      <p className="text-sm text-gray-600 leading-relaxed mb-5">
        Tell Mealio where you publish and we will keep watching it. <strong className="font-semibold text-gray-800">
        Whatever you post from then on syncs automatically and comes back to you as a draft to review</strong> — you
        read it, change anything you like, and nothing goes live under your name until you say so.
      </p>

      {/* ── The picker ──────────────────────────────────────────────────────
          One source at a time. Two places are two sets of drafts for one dish,
          and picking one is what keeps a recipe posted to a blog and a Reel from
          arriving twice. */}
      <label htmlFor="sync-source" className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
        Where you publish
      </label>
      <select
        id="sync-source"
        value={source}
        onChange={e => pickSource(e.target.value as PrimarySource)}
        disabled={switching || busy}
        className="w-full sm:max-w-xs border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-800 bg-white focus:outline-none focus:ring-2 focus:ring-red-200 focus:border-red-400 disabled:opacity-60 transition-colors"
      >
        {/* Not a choice, a starting point. `none` is the state of a row nobody
            has answered for yet — and the one Disconnect returns to — so it needs
            somewhere to sit in the control, but picking "nothing" is not how a
            creator stops: that is the Disconnect button, which also revokes the
            grant this dropdown cannot see. Disabled so it can be left but never
            selected. */}
        {source === 'none' && (
          <option value="none" disabled>
            Choose where you publish&hellip;
          </option>
        )}
        {CREATOR_SOURCE_OPTIONS.map(option => (
          <option key={option.source} value={option.source} disabled={Boolean(option.blockedReason)}>
            {option.label}
          </option>
        ))}
      </select>
      <p className="text-xs text-gray-400 mt-1.5 leading-relaxed">
        One at a time. If you post the same recipe to two places, syncing both would send it to you twice.
      </p>

      {/* Why the greyed-out two are greyed out, spelled out under the control
          rather than only on an option a creator cannot select and may never
          manage to read. */}
      <div className="mt-3 flex flex-col gap-1">
        {CREATOR_SOURCE_OPTIONS.filter(option => option.blockedReason).map(option => (
          <p key={option.source} className="text-xs text-gray-400 leading-relaxed" data-testid={`blocked-${option.source}`}>
            <span className="font-semibold text-gray-500">{SOURCE_LABELS[option.source]}:</span>{' '}
            {option.blockedReason}
          </p>
        ))}
      </div>

      {error && (
        <p className="text-sm text-red-600 mt-4 leading-relaxed" role="alert">{error}</p>
      )}

      {/* ── The body, which is whatever the dropdown says ─────────────────── */}
      <div className="mt-5 pt-5 border-t border-gray-100">
        {source === 'none' ? (
          <p className="text-sm text-gray-600 leading-relaxed" data-testid="sync-off">
            Mealio is not reading anything you publish. Pick where you publish above whenever you would like it to
            start — recipes already published on Mealio stay exactly where they are.
          </p>
        ) : source === 'website' ? (
          <>
            <label htmlFor="sync-website-url" className="block text-sm font-semibold text-gray-800 mb-1.5">
              Your website or blog
            </label>
            <p className="text-sm text-gray-600 leading-relaxed mb-3">
              Paste the address and press Save. Mealio reads a few of your recent posts to check it can actually
              pull recipes out of them — that takes a few seconds, and it is better to find out now than after
              months of nothing arriving.
            </p>
            <div className="flex flex-col sm:flex-row gap-2.5 sm:items-center">
              <input
                id="sync-website-url"
                value={websiteInput}
                onChange={e => { setWebsiteInput(e.target.value); setWebsiteError(''); setWebsiteDetail(''); }}
                placeholder="chefsarah.com"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={websiteBusy}
                className="flex-1 min-w-0 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-red-200 focus:border-red-400 disabled:opacity-60 transition-colors"
              />
              <button
                onClick={saveWebsite}
                disabled={websiteBusy}
                className="flex-shrink-0 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-semibold rounded-xl px-5 py-2.5 transition-colors"
              >
                {websiteBusy ? 'Checking your site…' : 'Save'}
              </button>
            </div>

            {websiteError && (
              <p className="text-sm text-red-600 mt-3 leading-relaxed" data-testid="website-error" role="alert">
                {websiteError}
              </p>
            )}
            {websiteDetail && (
              <p className="text-sm text-green-700 mt-3 leading-relaxed" data-testid="website-detail">
                {websiteDetail}
              </p>
            )}
          </>
        ) : source === 'youtube' ? (
          <YouTubeConnectCard embedded onConnectionChange={noteConnection('youtube')} />
        ) : (
          // Instagram is in the dropdown but disabled, so `source` can only be
          // 'tiktok' here. Keyed on the platform so switching between two
          // connect cards remounts rather than reusing one card's status for
          // the other's account.
          <PlatformConnectCard
            key={source}
            platform={source}
            embedded
            note={CREATOR_SOURCE_OPTIONS.find(option => option.source === source)?.note ?? null}
            onConnectionChange={noteConnection(source)}
          />
        )}
      </div>

      {/* ── Where it stands ─────────────────────────────────────────────────
          Said once the row actually says it, and in the present tense, because
          "we will watch this" and "we are watching this" are different claims
          and only one of them is checkable. */}
      {syncingFromThis && (
        <div className="mt-5 pt-5 border-t border-gray-100" data-testid="sync-live">
          <p className="text-sm text-gray-700 leading-relaxed">
            Mealio is watching your {label} now. New posts arrive in your review queue as drafts — nothing is
            published until you approve it.
          </p>
          {/* The off switch, and only shown once there is something to switch
              off. It says what it will do to the connection as well as to the
              syncing, because "Disconnect" alone does not tell a creator they
              will have to authorise Mealio again to undo it. */}
          <button
            type="button"
            onClick={disconnect}
            disabled={switching || busy}
            data-testid="sync-disconnect"
            className="mt-3 text-xs font-semibold text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 disabled:opacity-60 transition-colors"
          >
            {switching ? 'Disconnecting…' : `Disconnect ${label}`}
          </button>
          <p className="text-xs text-gray-400 mt-2 leading-relaxed">
            Mealio stops reading your {label} and forgets the connection. Recipes you have already published stay
            exactly where they are.
          </p>
        </div>
      )}

      {/* ── The back catalogue ──────────────────────────────────────────────
          The checklist exists because the first poll baselines: everything
          already published is marked seen, not imported. Said here, where the
          list is, because without it connecting a source reads as "nothing
          happened". */}
      {ready && (
        <div className="mt-5 pt-5 border-t border-gray-100" data-testid="catalogue">
          <h3 className="text-sm font-bold text-gray-900 mb-1.5">What you have already posted</h3>
          <p className="text-sm text-gray-600 leading-relaxed mb-4">
            Syncing starts from today: <strong className="font-semibold text-gray-800">nothing you posted before
            now is imported on its own</strong>. Tick anything from your back catalogue you would like as a draft
            too — up to {CREATOR_SELECTION_MAX} at a time.
          </p>

          {loadingCatalog && <p className="text-sm text-gray-500">Reading what you have published…</p>}

          {catalog && !catalog.ok && (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5 leading-relaxed">
              {catalog.detail}
            </p>
          )}

          {catalog?.ok && entries.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-3 mb-2.5">
                <span
                  className={`text-sm font-semibold ${atCap ? 'text-amber-700' : 'text-gray-700'}`}
                  data-testid="selection-count"
                >
                  {selected.length} of {CREATOR_SELECTION_MAX} chosen
                </span>
                <button
                  onClick={selectAllNew}
                  className="text-xs font-semibold text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 transition-colors"
                >
                  Tick the {Math.min(unimported.length, CREATOR_SELECTION_MAX)} newest
                </button>
                {selected.length > 0 && (
                  <button
                    onClick={() => setSelected([])}
                    className="text-xs font-semibold text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>

              {atCap && (
                <p className="text-xs text-amber-700 mb-2.5 leading-relaxed" data-testid="cap-reached">
                  That is the {CREATOR_SELECTION_MAX} we can do in one go. Import these, then come back for the rest.
                </p>
              )}

              <div className="border border-gray-100 rounded-xl overflow-hidden max-h-80 overflow-y-auto">
                {entries.map((entry, i) => {
                  const already = isImported(entry);
                  const checked = selected.includes(entry.itemId);
                  return (
                    <label
                      key={entry.itemId}
                      className={`flex gap-3 items-start px-3 py-2.5 cursor-pointer ${i === 0 ? '' : 'border-t border-gray-50'} ${already ? 'bg-gray-50' : 'bg-white'}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(entry.itemId)}
                        disabled={!checked && atCap}
                        aria-label={entry.title || entry.url}
                        className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-gray-300 text-red-600 focus:ring-red-500 disabled:opacity-40"
                      />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm text-gray-800 font-medium break-words">
                          {entry.title || entry.url}
                        </span>
                        <span className="block text-xs text-gray-400 truncate">
                          {formatDate(entry.publishedAt)}
                        </span>
                      </span>
                      {already && (
                        <span className="flex-shrink-0 text-[11px] font-semibold text-green-700 bg-green-50 border border-green-100 rounded-md px-2 py-0.5">
                          Already in
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center gap-3 mt-4">
                <button
                  onClick={startImport}
                  disabled={busy || selected.length === 0}
                  className="bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white text-sm font-semibold rounded-xl px-5 py-2.5 transition-colors"
                >
                  {busy
                    ? 'Importing…'
                    : selected.length === 0
                      ? 'Import posts'
                      : `Import ${selected.length} ${selected.length === 1 ? 'post' : 'posts'}`}
                </button>
                <span className="text-xs text-gray-400 leading-relaxed">
                  These arrive as drafts too. Nothing is published without you.
                </span>
              </div>
            </>
          )}

          {catalog?.ok && entries.length === 0 && (
            <p className="text-sm text-gray-500 leading-relaxed">
              We could not see anything published on your {label} yet. New posts will still sync from now on.
            </p>
          )}
        </div>
      )}

      {/* ── What the import did ─────────────────────────────────────────── */}
      {run && totals && (
        <div className="mt-5 pt-5 border-t border-gray-100" data-testid="run-summary">
          <div className="flex flex-wrap items-baseline gap-3 mb-1.5">
            <h3 className="text-sm font-bold text-gray-900">
              {run.status === 'done' ? 'Import finished' : 'Importing…'}
            </h3>
            {run.status !== 'done' && !busy && (
              <button
                onClick={resume}
                className="text-xs font-semibold text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 transition-colors"
              >
                Carry on
              </button>
            )}
          </div>
          {/* The arithmetic on screen: chose 12, got 9, and where the other
              three went. Anything less makes a correct run look broken. */}
          <p className="text-sm text-gray-600 leading-relaxed">
            Chose {totals.selected} · <strong className="font-semibold text-gray-800">{totals.drafted}</strong> waiting
            in your review queue
            {totals.rejected > 0 && <> · {totals.rejected} did not look like a recipe, so we left {totals.rejected === 1 ? 'it' : 'them'} alone</>}
            {totals.skipped > 0 && <> · {totals.skipped} already in</>}
            {totals.failed > 0 && <> · {totals.failed} we could not read</>}
            {totals.pending > 0 && <> · {totals.pending} still to go</>}
          </p>
        </div>
      )}
    </div>
  );
}
