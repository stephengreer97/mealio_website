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
  type PlatformSource,
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
 *
 * But it is said out loud. Mealio reads one place, so a switch is also a
 * stopping, and that half is otherwise invisible: the old account stays
 * connected and nothing on the screen would mention it again. A creator who
 * moved to TikTok and kept posting recipes to YouTube would find out months
 * later, from the absence of drafts.
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

/** The card shell every section of this feature sits on. */
const CARD = 'bg-white rounded-2xl shadow-sm border border-gray-100 p-5 sm:p-6';

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
  // Anything the dropdown can offer, it can also open on. TikTok was in the
  // line below while it was blocked, which meant a creator syncing from TikTok
  // opened their portal on an empty prompt with no sign of the source they had
  // chosen — and, because the catalogue keys off the selection, no checklist.
  if (stored === 'website' || stored === 'youtube' || stored === 'tiktok') return stored;
  if (stored === 'instagram') return 'none';
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

  /**
   * The source they were being synced from before this switch, if any.
   *
   * Mealio reads one place. Switching is therefore also a *stopping*, and that
   * half is invisible: the old account stays connected, so nothing on screen
   * changes to say posts from it will no longer arrive. A creator who moves to
   * TikTok and keeps posting recipes to YouTube would find out months later,
   * from the absence of drafts.
   */
  const [left, setLeft] = useState<PlatformSource | null>(null);

  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  /** A further window on its way in, which is a different thing from the first. */
  const [loadingMore, setLoadingMore] = useState(false);
  /** The bottom of the list, watched so scrolling into it asks for more. */
  const sentinel = useRef<HTMLDivElement | null>(null);
  /**
   * A window that failed, so the scroll stops asking.
   *
   * Without it a creator resting at the bottom of the list fires one failed
   * request per intersection, forever.
   */
  const [moreFailed, setMoreFailed] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const [run, setRun] = useState<SyncRun | null>(null);
  const [totals, setTotals] = useState<SyncRunTotals | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  /**
   * Separate from `switching`, which every source write sets.
   *
   * Sharing one flag put "Disconnecting…" on the button during an ordinary page
   * load — the section writes the creator's choice as it settles — so a creator
   * refreshing their portal watched it announce it was disconnecting them.
   */
  const [disconnecting, setDisconnecting] = useState(false);

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

    // Consumed, not just read. The parameter is a one-time message about a round
    // trip that has finished, but it sits in the address bar afterwards — so
    // every later refresh replayed it: `chose` was set, the source switched back
    // to whichever platform was last connected, and the effect below then
    // *wrote* it. A creator who connected TikTok, later chose their website, and
    // reloaded the page had that choice silently reversed.
    //
    // Stripped a turn late, on purpose. The connect card reads the same
    // parameter for its own "connected" and "did not connect" messages, and it
    // mounts in the render this effect is about to cause — clearing the URL here
    // and now would swallow the sentence explaining a failed connection, which
    // is the one a creator most needs. A timer runs after that commit.
    //
    // `replaceState`, and the hash is kept, so the portal stays on the tab the
    // callback sent them to.
    if (returned && typeof window !== 'undefined') {
      setTimeout(() => {
        const url = new URL(window.location.href);
        for (const platform of CONNECTED_PLATFORMS) url.searchParams.delete(platform);
        url.searchParams.delete('reason');
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      }, 0);
    }

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
    setDisconnecting(true);
    setError('');

    if (source !== 'website') {
      const res = await fetch(`/api/creator/${source}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token()}` },
      });
      if (!mounted.current) return;
      if (!res.ok) {
        setDisconnecting(false);
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
    setDisconnecting(false);
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
    // Not a switch, so nothing to warn about giving up — the sync-off copy below
    // already says Mealio is reading nothing.
    setLeft(null);
    setWebsiteInput('');
    setCatalog(null);
    setSelected([]);
    setRun(null);
    setTotals(null);
  };

  const pickSource = (next: PrimarySource) => {
    if (next === source) return;
    chose.current = true;
    // What they are leaving, captured before the write lands — a moment later
    // the row says the new source and the old one is unrecoverable from state.
    //
    // Only when it was actually being synced. Correcting an answer nobody had
    // acted on yet is not a switch and does not deserve a warning; a creator who
    // gets one for changing their mind mid-decision learns to ignore the next.
    if (row.import_opt_in === true && row.primary_source !== 'none' && row.primary_source !== next) {
      setLeft(row.primary_source as PlatformSource);
    }
    setSource(next);
    // Nothing about the old source survives the switch. A checklist of somebody
    // else's blog posts sitting under a YouTube heading is the worst thing this
    // section could leave on screen.
    setCatalog(null);
    setSelected([]);
    setRun(null);
    setTotals(null);
    setMoreFailed(false);
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

  /**
   * One window of the creator's back catalogue.
   *
   * With a cursor it appends; without one it replaces. TikTok answers twenty at
   * a time, so reading a hundred meant five round trips before anything could be
   * drawn — the list now shows the first twenty immediately and fetches the rest
   * as the creator scrolls into them.
   */
  /** Where the next window starts, or null when the list is complete. */
  const nextPageToken = catalog?.ok ? catalog.nextPageToken ?? null : null;

  /**
   * Ask for the next window when the creator scrolls into the end of the list.
   *
   * An observer rather than a scroll handler: the list lives in its own
   * scrolling box, and the sentinel is inside it, so "have they reached the
   * bottom" is a question about intersection rather than about arithmetic on two
   * elements' offsets.
   */
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !nextPageToken || loadingMore || moreFailed) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadCatalog(nextPageToken);
    });
    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextPageToken, loadingMore, moreFailed]);

  const loadCatalog = async (cursor: string | null = null) => {
    if (cursor === null) setLoadingCatalog(true); else setLoadingMore(true);
    setError('');
    const { res, data } = await authed('/api/creator/sync/catalog', {
      source,
      ...(cursor === null ? {} : { pageToken: cursor }),
    });
    if (!mounted.current) return;
    if (cursor === null) setLoadingCatalog(false); else setLoadingMore(false);
    // A 422 still carries a catalogue — one that says why it could not be
    // listed, which is the useful half. Only a response with neither is a
    // failure of this call rather than an answer from it.
    if (!data.catalog) {
      setError((!res.ok && data.error) || 'Could not read what you have published.');
      // A window that failed must stop the scroll asking for it again, or a
      // creator sitting at the bottom of the list generates one failed request
      // per frame.
      if (cursor !== null) setMoreFailed(true);
      return;
    }
    const next = data.catalog as CatalogResult;
    setCatalog(current => {
      if (cursor === null || !current?.ok || !next.ok) return next;
      // Appended, and de-duplicated on the way in: a creator who posts while
      // scrolling shifts TikTok's window, and the same video arriving twice
      // would render twice and be importable twice.
      const seen = new Set(current.entries.map(entry => entry.itemId));
      const fresh = next.entries.filter(e => !seen.has(e.itemId));
      // A window that adds nothing is the end of the list, whatever the source
      // says. Blog feeds that do not implement `?paged=` answer every page with
      // their first one, and without this the list would offer "more" forever
      // and never grow by a single post.
      if (fresh.length === 0) return { ...current, nextPageToken: null };
      return { ...next, entries: [...current.entries, ...fresh] };
    });
  };

  // Drawn as soon as there is something to draw. It costs a feed read and one
  // database query — no page is fetched and no model is called — so making a
  // creator press a button to find out what Mealio can see would be ceremony
  // over a free answer, and the answer is the reason the section is worth
  // scrolling to.
  useEffect(() => {
    // `ready` for a platform waits on the connect card's own round trip, so the
    // catalogue used to start only after it came back — two requests end to end
    // for a creator who is just reopening their portal. When the row already
    // says this is the source being synced, a grant existed a moment ago, and
    // the catalogue call is the slow one: TikTok pages twenty at a time, so it
    // is up to five round trips to TikTok on its own. Starting it alongside the
    // status read rather than behind it is the whole of the difference.
    //
    // Nothing is claimed by being wrong: a grant revoked at the provider comes
    // back as a not-connected catalogue, which is what the panel would have
    // shown anyway.
    const believedConnected = source !== 'none'
      && row.primary_source === source
      && row.import_opt_in === true;
    if ((ready || believedConnected) && !catalog && !loadingCatalog) loadCatalog();
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
  /**
   * The gate read this post and said it was not a recipe.
   *
   * Permanent, unlike a fetch that failed: `recordItem` writes `rejected` only
   * for the gate's own answer, and everything that went wrong on our side is
   * `failed` and worth another go. So this is not a post to offer again — the
   * answer would be the same, and it would cost a model call to get it.
   */
  const isRejected = (entry: CatalogEntry) => entry.record?.status === 'rejected';
  /** Neither already in, nor known to be something we cannot use. */
  const importable = (entry: CatalogEntry) => !isImported(entry) && !isRejected(entry);
  const unimported = entries.filter(importable);
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
      if (next.status === 'done') {
        // Everything on the page that the run just made wrong.
        //
        // The catalogue is the visible one: an imported post keeps its old
        // "not imported" look until something re-reads it, so a creator presses
        // Import, sees the summary say it worked, and sees the list still
        // saying it did not. The queue is the same staleness one tab across —
        // it is a sibling component with its own fetch, and it last read before
        // any of this existed.
        void loadCatalog();
        window.dispatchEvent(new CustomEvent('mealio:drafts-imported'));
        return;
      }
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
    <>
    <div className={CARD} data-testid="sync-source-section">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-0.5">Your recipes</p>
      <h2 className="text-base font-bold text-gray-900 leading-tight mb-2">Sync your content with Mealio</h2>

      {/* The promise, before any control. It is the whole of what this section
          does and it was nowhere on the creator's screen before MEAL-101. */}
      <p className="text-sm text-gray-600 leading-relaxed mb-5">
        Tell Mealio where you publish and we will keep watching it. <strong className="font-semibold text-gray-800">
        Whatever you post from then on syncs automatically and comes back to you as a draft to review</strong>.
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
      {error && (
        <p className="text-sm text-red-600 mt-4 leading-relaxed" role="alert">{error}</p>
      )}

      {/* ── What switching costs ────────────────────────────────────────────
          Mealio reads one place, so choosing a new source is also giving up the
          old one — and that half happens silently: the old account stays
          connected, and nothing else on this screen would ever mention it
          again. Said at the moment of the switch, which is the only moment a
          creator is in a position to change their mind. */}
      {left && left !== source && (
        <p
          className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5 mt-4 leading-relaxed"
          data-testid="switch-warning"
        >
          Mealio now syncs from {source === 'none' ? 'nowhere' : SOURCE_LABELS[source]} only.{' '}
          <strong className="font-semibold">Anything new you post to {SOURCE_LABELS[left]} will not be
          imported.</strong> Your {SOURCE_LABELS[left]} account stays connected, and recipes already published on
          Mealio stay exactly where they are.
        </p>
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
              pull recipes out of them. This can take up to 30 seconds.
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
      {/* Shown when there is a connection, which is not the same as when the row
          says it is syncing. A grant that exists but is not being polled — the
          moment between connecting and the write landing — still has to be
          revocable, and the connect card no longer offers its own button. */}
      {(syncingFromThis || ready) && (
        <div className="mt-5 pt-5 border-t border-gray-100" data-testid="sync-live">
          {/* The off switch, and only shown once there is something to switch
              off. It says what it will do to the connection as well as to the
              syncing, because "Disconnect" alone does not tell a creator they
              will have to authorise Mealio again to undo it. */}
          <button
            type="button"
            onClick={disconnect}
            disabled={switching || disconnecting || busy}
            data-testid="sync-disconnect"
            className="mt-3 text-xs font-semibold text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 disabled:opacity-60 transition-colors"
          >
            {disconnecting ? 'Disconnecting…' : `Disconnect ${label}`}
          </button>
          <p className="text-xs text-gray-400 mt-2 leading-relaxed">
            Mealio stops reading your {label} and forgets the connection. Recipes you have already published stay
            exactly where they are.
          </p>
        </div>
      )}

    </div>

      {/* ── The back catalogue, on a card of its own ────────────────────────
          A different decision from "where do you publish", and one that only
          exists once an account is connected — so it gets its own card rather
          than a rule across the middle of the first one. The checklist is here
          at all because the first poll baselines: everything already published
          is marked seen, not imported, and without saying so connecting a
          source reads as nothing having happened. */}
      {ready && (
        <div className={CARD} data-testid="catalogue">
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
                  const rejected = isRejected(entry);
                  // Nothing to decide about either one, so there is no tick to
                  // offer. A box that can be ticked and then silently does
                  // nothing is worse than no box: the creator counts it into
                  // their selection and the run reports a number they did not
                  // expect.
                  const settled = already || rejected;
                  const checked = selected.includes(entry.itemId);
                  return (
                    <label
                      key={entry.itemId}
                      className={`flex gap-3 items-start px-3 py-2.5 ${settled ? 'cursor-default' : 'cursor-pointer'} ${i === 0 ? '' : 'border-t border-gray-50'} ${settled ? 'bg-gray-50' : 'bg-white'}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(entry.itemId)}
                        disabled={settled || (!checked && atCap)}
                        aria-label={entry.title || entry.url}
                        className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-gray-300 text-red-600 focus:ring-red-500 disabled:opacity-40"
                      />
                      <span className="flex-1 min-w-0">
                        {/* Two lines, then an ellipsis. TikTok has no titles —
                            `tiktokVideoTitle` falls back to the first line of
                            the description — so a chatty caption filled the row
                            and pushed the rest of the list off the screen. */}
                        <span className="block text-sm text-gray-800 font-medium break-words line-clamp-2">
                          {entry.title || entry.url}
                        </span>
                        <span className="block text-xs text-gray-400 truncate">
                          {formatDate(entry.publishedAt)}
                        </span>
                      </span>
                      {already && (
                        <span className="flex-shrink-0 text-[11px] font-semibold text-green-700 bg-green-50 border border-green-100 rounded-md px-2 py-0.5">
                          Already Imported
                        </span>
                      )}
                      {/* Not a failure to apologise for and not a promise to try
                          again. The post is fine; it just is not a recipe we can
                          turn into a shopping list. */}
                      {rejected && (
                        <span
                          className="flex-shrink-0 text-[11px] font-semibold text-gray-500 bg-gray-100 border border-gray-200 rounded-md px-2 py-0.5"
                          title={entry.record?.detail ?? undefined}
                          data-testid="not-a-recipe"
                        >
                          No recipe found
                        </span>
                      )}
                    </label>
                  );
                })}

                {/* The bottom of the list, which is also the request for more of
                    it. Inside the scrolling box rather than after it, because
                    the box is what scrolls — a sentinel outside would be on
                    screen from the start and fetch every page at once. */}
                {nextPageToken && !moreFailed && (
                  <div ref={sentinel} className="px-3 py-3 text-xs text-gray-400" data-testid="catalogue-more">
                    {loadingMore ? 'Reading more…' : 'Scroll for more'}
                  </div>
                )}
                {moreFailed && (
                  <div className="px-3 py-3 text-xs text-gray-500">
                    We could not read any more of your posts.{' '}
                    <button
                      type="button"
                      onClick={() => { setMoreFailed(false); void loadCatalog(nextPageToken); }}
                      className="font-semibold text-gray-700 underline"
                    >
                      Try again
                    </button>
                  </div>
                )}
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
        <div className={`${CARD} mt-4`} data-testid="run-summary">
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
            {totals.skipped > 0 && <> · {totals.skipped} already imported</>}
            {totals.failed > 0 && <> · {totals.failed} we could not read</>}
            {totals.pending > 0 && <> · {totals.pending} still to go</>}
          </p>

          {/* ── The queue itself ──────────────────────────────────────────
              An import of forty posts takes minutes, and until now the only
              thing on screen was a button that said "Importing…". A creator
              could not tell a run that was working from one that had hung, and
              the summary above only became true at the end.

              Every row's state comes off the run, which the worker returns in
              full on each chunk — so this is what actually happened to each
              post, not an animation standing in for it. */}
          <ul className="mt-3 border border-gray-100 rounded-xl overflow-hidden max-h-72 overflow-y-auto" data-testid="run-queue">
            {run.items.map((item, i) => {
              // The first still-waiting row, while the run is live. The worker
              // takes them in order, so this is the one being read right now.
              const working = run.status !== 'done' && item.status === 'pending'
                && run.items.findIndex(other => other.status === 'pending') === i;
              return (
                <li
                  key={item.itemId}
                  className={`flex gap-2.5 items-start px-3 py-2 text-sm ${i === 0 ? '' : 'border-t border-gray-50'} ${working ? 'bg-amber-50' : 'bg-white'}`}
                  data-testid={`run-item-${item.status}`}
                >
                  <span className="flex-shrink-0 mt-0.5 w-4 h-4 flex items-center justify-center" aria-hidden>
                    {working ? (
                      <svg className="animate-spin w-4 h-4 text-amber-600" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-90" fill="currentColor" d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2z" />
                      </svg>
                    ) : item.status === 'drafted' ? (
                      <span className="text-green-600 font-bold">&#10003;</span>
                    ) : item.status === 'failed' ? (
                      <span className="text-amber-600 font-bold">!</span>
                    ) : item.status === 'pending' ? (
                      <span className="text-gray-300">&#9679;</span>
                    ) : (
                      <span className="text-gray-400">&#8212;</span>
                    )}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-gray-800">
                      {item.mealName || item.title || item.url}
                    </span>
                    {/* The sentence, where there is one. A row that says only
                        "rejected" sends a creator to ask us why. */}
                    <span className="block text-xs text-gray-500 leading-relaxed">
                      {working
                        ? 'Reading this one\u2026'
                        : item.status === 'drafted'
                          ? item.needALook
                            ? `In your review queue \u00b7 ${item.needALook} ${item.needALook === 1 ? 'field needs' : 'fields need'} a look`
                            : 'In your review queue'
                          : item.status === 'pending'
                            ? 'Waiting'
                            : item.detail || (item.status === 'skipped' ? 'Already Imported' : 'We could not read this one')}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}
