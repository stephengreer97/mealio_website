'use client';

import { useEffect, useRef, useState } from 'react';
import { PLATFORM_SOURCES, SOURCE_COLUMNS, SOURCE_LABELS, type PlatformSource } from '@/lib/creator-sources';
import { formatSelectionCost } from '@/lib/import/cost';
// Type-only: `lib/admin-sync` reaches the import pipeline and undici, and must
// never be bundled into the client. These imports are erased at compile time.
import type { CatalogEntry, CatalogResult, SyncItem, SyncRun, SyncRunTotals } from '@/lib/admin-sync';

/**
 * Admin manual sync (MEAL-90) — one link, or a reviewed checklist.
 *
 * The screen is built around two refusals. There is no "sync everything" button:
 * a run is a selection an operator made item by item, or one link they pasted.
 * And the checklist is drawn from listing metadata alone — opening it fetches no
 * page and calls no model, so an operator can look at a 200-post archive without
 * spending anything to find out what is in it.
 *
 * The cost line above the Sync button is the real guard rail. A confirmation
 * dialog gets clicked through; "137 selected · about $9.16" gets read. YouTube
 * now has a second budget beside the dollar one — the Data API's 10,000 units a
 * day, shared across every creator — so the quota total sits in the card header
 * where every page load and every append adds to it (MEAL-79).
 *
 * A run **queues drafts for review** (MEAL-91). It used to publish, and the
 * language on this screen said so; a finished run now hands over to the Review
 * tab, and every "Published" here would be a lie about where the recipe is.
 *
 * ── One card, four steps ────────────────────────────────────────────────────
 * This used to be seven cards that appeared one after another as an operator
 * worked, so the further you got the more of the screen was scrollback. It is
 * now a single card that changes: four numbered steps, of which the one being
 * worked on is open and the settled ones collapse to a summary you click back
 * into. Nothing is a wizard — every step header stays reachable, so the creator
 * can be changed mid-run without starting over — and step 4 never collapses,
 * because the cost of what is about to be spent must not be a step you scrolled
 * past. The run and the append offer follow the steps in the same card.
 *
 * The append section is the write half of MEAL-79: published meals that came
 * from one of this creator's videos, offered for the Mealio link to be appended
 * to that video's description. It is loaded on demand and it shows a refusal
 * sentence rather than a list when consent is off — the offer must not appear at
 * all when the answer would be no.
 */

export interface SyncPanelCreator {
  id: string;
  display_name: string;
  primary_source: string;
  website_url: string | null;
  youtube_url: string | null;
  instagram_url: string | null;
  tiktok_url: string | null;
  feed_url: string | null;
  /**
   * OAuth grants this creator has (MEAL-74). A connected channel is listable
   * with no link on the row at all, so the source picker below has to consider
   * both — the channel id comes from the grant, not from anything typed.
   */
  connections?: Array<{ platform: string; brokenReason: string | null }>;
}

export interface AdminSyncPanelProps {
  creators: SyncPanelCreator[];
}

/**
 * Is there anything to list for this source?
 *
 * A stored link, or an OAuth grant. The second half matters because
 * `youtube_url` is optional on the application form, so a creator who connected
 * their channel properly could otherwise find YouTube greyed out.
 */
function listableSource(creator: SyncPanelCreator | null | undefined, source: PlatformSource): boolean {
  if (!creator) return false;
  if (creator[SOURCE_COLUMNS[source] as keyof SyncPanelCreator]) return true;
  return (creator.connections ?? []).some(connection => connection.platform === source);
}

/** One published meal that came from a video, as `GET /api/admin/sync/append` lists it. */
interface AppendableMeal {
  draftId: string;
  mealId: string;
  mealName: string;
  videoId: string;
  videoUrl: string;
  mealUrl: string;
  approvedAt: string | null;
}

const ITEM_STYLES: Record<SyncItem['status'], { fg: string; bg: string; label: string }> = {
  pending:  { fg: '#6b7280', bg: '#f3f4f6', label: 'Waiting' },
  drafted:  { fg: '#1a7a3a', bg: '#e6f9ed', label: 'For review' },
  rejected: { fg: '#b45309', bg: '#fff8e1', label: 'Not a recipe' },
  failed:   { fg: '#c40029', bg: '#fff0f0', label: 'Failed' },
  skipped:  { fg: '#374151', bg: '#f3f4f6', label: 'Already in' },
};

/** How long between worker calls while a run is unfinished. */
const POLL_DELAY_MS = 750;

/**
 * Chunks one press of Sync will drive. A 500-item run at two per chunk needs
 * 250, so this is headroom rather than a limit — its job is to stop a run that
 * is making no progress from polling forever.
 */
const MAX_CHUNKS = 400;

const card: React.CSSProperties = {
  background: 'white',
  borderRadius: '12px',
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
  padding: '22px 24px',
};

const primaryButton = (busy: boolean): React.CSSProperties => ({
  padding: '8px 16px',
  background: busy ? '#aaa' : '#dd0031',
  color: 'white',
  border: 'none',
  borderRadius: '8px',
  fontSize: '13px',
  fontWeight: 600,
  cursor: busy ? 'wait' : 'pointer',
});

const secondaryButton: React.CSSProperties = {
  padding: '5px 12px',
  background: 'white',
  color: '#374151',
  border: '1px solid #e0e0e0',
  borderRadius: '6px',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
};

/** The divider every step and every section below them hangs from. */
const sectionRow: React.CSSProperties = {
  borderTop: '1px solid #f0f0f0',
  paddingTop: '16px',
  marginTop: '16px',
};

const stepTitle: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: 700,
  color: '#222',
  whiteSpace: 'nowrap',
};

const stepSummary: React.CSSProperties = {
  fontSize: '12px',
  color: '#6b7280',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const hint: React.CSSProperties = { fontSize: '11px', color: '#aaa', lineHeight: 1.6 };

/** The step number, ticked once the step has an answer. */
function stepBadge(done: boolean, open: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    flexShrink: 0,
    borderRadius: '99px',
    fontSize: '11px',
    fontWeight: 700,
    background: open ? '#dd0031' : done ? '#e6f9ed' : '#f3f4f6',
    color: open ? 'white' : done ? '#1a7a3a' : '#9ca3af',
  };
}

/**
 * One step of the sequence.
 *
 * The header is always on screen — that is what makes a settled answer
 * reviewable and, more to the point, changeable at any moment. Only the body
 * comes and goes. A step with no body (the mode switch, in link mode) renders
 * its header as plain text rather than a dead button.
 */
function Step({
  index, title, summary, done, open, onToggle, aside, children,
}: {
  index: number;
  title: string;
  summary?: string;
  done: boolean;
  open: boolean;
  onToggle: () => void;
  /** Controls that stay reachable whether the step is open or not. */
  aside?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const head = (
    <>
      <span style={stepBadge(done, open)} aria-hidden="true">{done && !open ? '✓' : index}</span>
      <span style={stepTitle}>{title}</span>
      {summary && <span style={stepSummary}>{summary}</span>}
    </>
  );

  return (
    <div style={sectionRow}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        {children ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            style={{
              display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: '1 1 240px',
              background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer',
            }}
          >
            {head}
            {/* Next to the summary rather than out at the right margin, where it
                would sit against whatever `aside` the step carries and read as a
                label for that instead. */}
            <span style={{ fontSize: '11px', color: '#9ca3af', flexShrink: 0 }}>
              {open ? 'Hide' : done ? 'Change' : 'Open'}
            </span>
          </button>
        ) : (
          <span style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: '1 1 auto' }}>
            {head}
          </span>
        )}
        {aside}
      </div>
      {open && children && <div style={{ marginTop: '14px' }}>{children}</div>}
    </div>
  );
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleDateString() : '—';
}

export default function AdminSyncPanel({ creators }: AdminSyncPanelProps) {
  const [creatorId, setCreatorId] = useState('');
  const [mode, setMode] = useState<'link' | 'catalog'>('link');
  const [source, setSource] = useState<PlatformSource>('website');
  const [linkUrl, setLinkUrl] = useState('');
  const [error, setError] = useState('');

  /**
   * The step an operator has clicked back into, or `null` for "wherever the
   * work has got to". Anything that moves the work forward clears it, so
   * re-opening step 1 to check a name does not strand the screen there.
   */
  const [openStep, setOpenStep] = useState<number | null>(null);

  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  /**
   * YouTube quota this screen has spent since it was opened.
   *
   * Everything that spends adds to it — every listing page **and every append**,
   * which is the expensive half at 51 units against a listing page's 1 or 2. It
   * used to count listings only and reset on every creator or catalog change,
   * which made "N units spent of 10,000/day" a figure for the current listing
   * presented against a daily budget: ten appends could spend 510 units without
   * moving it. A guard rail that cannot see the expensive half is not one.
   */
  const [quotaUnits, setQuotaUnits] = useState(0);

  // ── The append half (MEAL-79) ──────────────────────────────────────────────
  const [appendable, setAppendable] = useState<AppendableMeal[] | null>(null);
  /** True when there are approved video imports older than the list's own ceiling. */
  const [appendTruncated, setAppendTruncated] = useState(false);
  /** The refusal sentence, shown *instead of* the list. Never beside it. */
  const [appendRefusal, setAppendRefusal] = useState('');
  const [appendBusy, setAppendBusy] = useState('');
  const [appendResults, setAppendResults] = useState<Record<string, string>>({});
  /** The append offer is an aside, not step 5, so it starts folded away. */
  const [appendOpen, setAppendOpen] = useState(false);

  const [run, setRun] = useState<SyncRun | null>(null);
  const [totals, setTotals] = useState<SyncRunTotals | null>(null);
  const [busy, setBusy] = useState(false);

  // A run outlives a render, and the worker loop keeps calling after the panel
  // has gone. Without this a response landing post-unmount writes to dead state.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const creator = creators.find(c => c.id === creatorId) ?? null;
  const token = () => localStorage.getItem('accessToken');

  const authedPost = async (path: string, body: unknown) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };

  const chooseCreator = (id: string) => {
    setCreatorId(id);
    setCatalog(null);
    setSelected([]);
    // The quota total deliberately survives a creator change. The budget is one
    // budget, shared by every creator we read or write for, so what this screen
    // has spent on the last three creators is exactly what is relevant before
    // spending on a fourth.
    setRun(null);
    setTotals(null);
    setError('');
    // Nothing about the previous creator survives into the append section. A
    // stale list of somebody else's videos beside an Append button is the worst
    // possible thing for this screen to leave on it.
    setAppendable(null);
    setAppendRefusal('');
    setAppendResults({});
    setAppendTruncated(false);
    setAppendOpen(false);
    // Picking a creator is the answer step 1 was waiting for, so hand the screen
    // back to whatever comes next rather than leaving it parked here.
    setOpenStep(null);
    const chosen = creators.find(c => c.id === id);
    // Default to whatever source they are already set up on; the operator can
    // still pick another of their links.
    const primary = chosen?.primary_source;
    setSource(primary && primary !== 'none' ? (primary as PlatformSource) : 'website');
  };

  const chooseMode = (value: 'link' | 'catalog') => {
    setMode(value);
    setError('');
    setOpenStep(null);
  };

  const loadCatalog = async () => {
    if (!creatorId) return;
    setLoadingCatalog(true);
    setError('');
    setCatalog(null);
    setSelected([]);
    const { res, data } = await authedPost('/api/admin/sync/catalog', { creatorId, source });
    if (!mountedRef.current) return;
    setLoadingCatalog(false);
    if (!res.ok && !data.catalog) {
      setError(data.error || 'Could not read the catalog.');
      return;
    }
    const next = data.catalog as CatalogResult;
    setCatalog(next);
    // A failed listing can still have spent — `playlistItems.list` refusing
    // after `channels.list` succeeded costs a unit either way.
    setQuotaUnits(spent => spent + (next.quotaUnits ?? 0));
    // A listing is the answer step 2 was waiting for; move on to the checklist.
    setOpenStep(null);
  };

  /**
   * The next window of a paged catalogue (YouTube, MEAL-79).
   *
   * A press, not a page load. Walking a 300-video channel is 7 quota units out
   * of a budget shared by every creator — 12 if every press lands on an instance
   * that has to re-read the uploads playlist id — and nobody agreed to spend it
   * by opening a tab, so each press buys 50 more and says what it cost.
   *
   * Entries are appended rather than replaced, and the selection is left alone:
   * an operator who ticked six videos on page one and then asked for page two
   * has not changed their mind about the six.
   */
  const loadMore = async () => {
    if (!creatorId || !catalog?.ok || !catalog.nextPageToken || loadingCatalog) return;
    setLoadingCatalog(true);
    setError('');
    const { res, data } = await authedPost('/api/admin/sync/catalog', {
      creatorId,
      source,
      pageToken: catalog.nextPageToken,
    });
    if (!mountedRef.current) return;
    setLoadingCatalog(false);
    const next = data.catalog as CatalogResult | undefined;
    setQuotaUnits(spent => spent + (next?.quotaUnits ?? 0));
    if (!res.ok || !next?.ok) {
      setError((next && !next.ok ? next.detail : data.error) || 'Could not read the next page.');
      return;
    }
    setCatalog(current =>
      current?.ok ? { ...next, entries: [...current.entries, ...next.entries] } : next,
    );
  };

  /**
   * Loads the meals whose link could be written back to a video.
   *
   * On demand, because the gate is server-side and the honest answer for most
   * creators is a refusal — asking for it on every creator selection would spend
   * a request to be told no. A refusal replaces the list rather than sitting
   * beside it: a screen showing videos next to an Append button has already
   * implied we may write to them.
   */
  const loadAppendable = async () => {
    if (!creatorId) return;
    setAppendOpen(true);
    setAppendBusy('list');
    setAppendRefusal('');
    setAppendable(null);
    setAppendTruncated(false);
    setAppendResults({});
    const res = await fetch(`/api/admin/sync/append?creatorId=${encodeURIComponent(creatorId)}`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!mountedRef.current) return;
    setAppendBusy('');
    if (!res.ok) {
      setAppendRefusal(data.error || 'Could not read this creator’s appendable meals.');
      return;
    }
    setAppendable((data.meals ?? []) as AppendableMeal[]);
    setAppendTruncated(data.truncated === true);
  };

  const appendOne = async (meal: AppendableMeal) => {
    if (appendBusy) return;
    setAppendBusy(meal.draftId);
    const { res, data } = await authedPost('/api/admin/sync/append', { creatorId, draftId: meal.draftId });
    if (!mountedRef.current) return;
    setAppendBusy('');
    // 51 units for a write, 1 for a second press that finds the link already
    // there, and whatever a refusal spent before it refused. The route reports
    // all three, and this is the only counter on the screen.
    setQuotaUnits(spent => spent + (data.quotaUnits ?? 0));
    setAppendResults(prev => ({
      ...prev,
      [meal.draftId]: res.ok ? data.detail : data.error || 'That write failed.',
    }));
  };

  const entries: CatalogEntry[] = catalog?.ok ? catalog.entries : [];
  const isImported = (entry: CatalogEntry) => entry.record?.status === 'imported';
  const unimported = entries.filter(entry => !isImported(entry));

  const toggle = (itemId: string) => {
    setSelected(prev => (prev.includes(itemId) ? prev.filter(id => id !== itemId) : [...prev, itemId]));
  };

  /**
   * Select-all ticks only what is not already in. Ticking the whole catalog of a
   * blog half of which is imported is the expensive mistake this screen exists to
   * keep more than one click away — an already-imported row can still be ticked
   * by hand, and the run skips it rather than publishing it twice.
   */
  const selectAllNew = () => setSelected(unimported.map(entry => entry.itemId));

  /**
   * Drives the worker until the run stops moving.
   *
   * A chunk at a time, because 200 items do not fit in one function call. The
   * run itself lives in the database, so closing this tab delays it rather than
   * losing it — the daily cron picks up whatever is left.
   */
  const drive = async (runId: string) => {
    for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
      const { res, data } = await authedPost('/api/admin/sync/worker', { runId });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setError(data.error || 'The sync worker failed. The run is saved — press Resume to carry on.');
        return;
      }
      const next = data.run as SyncRun;
      setRun(next);
      setTotals(data.totals as SyncRunTotals);
      if (next.status === 'done') return;
      // `running` comes back only when the lease was refused, which means
      // somebody else — another tab, or the cron — is already working this run.
      // Two drivers on one run is not harmful, it is just wasted requests.
      if (next.status === 'running') {
        setError('This run is already being worked on somewhere else. Press Resume to pick it up if that stalls.');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, POLL_DELAY_MS));
      if (!mountedRef.current) return;
    }
    setError('Stopped after a lot of chunks without finishing. The run is saved — press Resume to carry on.');
  };

  const start = async () => {
    if (!creatorId || busy) return;
    setBusy(true);
    setError('');
    setRun(null);
    setTotals(null);
    // Pressing Sync is the answer to step 4. Hand the screen to the run rather
    // than leaving it parked on whichever step was last clicked open.
    setOpenStep(null);

    const body = mode === 'link'
      ? { creatorId, mode: 'link', url: linkUrl.trim() }
      : {
          creatorId,
          mode: 'catalog',
          source,
          items: entries
            .filter(entry => selected.includes(entry.itemId))
            .map(entry => ({ itemId: entry.itemId, url: entry.url, title: entry.title, publishedAt: entry.publishedAt })),
        };

    const { res, data } = await authedPost('/api/admin/sync', body);
    if (!mountedRef.current) return;
    if (!res.ok) {
      setBusy(false);
      setError(data.error || 'Could not start the sync.');
      return;
    }
    const created = data.run as SyncRun;
    setRun(created);
    await drive(created.id);
    if (mountedRef.current) setBusy(false);
  };

  const resume = async () => {
    if (!run || busy) return;
    setBusy(true);
    setError('');
    await drive(run.id);
    if (mountedRef.current) setBusy(false);
  };

  const retryItem = async (itemId: string) => {
    if (!run || busy) return;
    setBusy(true);
    setError('');
    const res = await fetch('/api/admin/sync', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ runId: run.id, itemId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!mountedRef.current) return;
    if (!res.ok) {
      setBusy(false);
      setError(data.error || 'Could not retry that item.');
      return;
    }
    setRun(data.run as SyncRun);
    await drive(run.id);
    if (mountedRef.current) setBusy(false);
  };

  const canStart = mode === 'link' ? Boolean(creatorId && linkUrl.trim()) : Boolean(creatorId && selected.length > 0);

  /**
   * Where the work has got to.
   *
   * It stops at 3 on purpose. Step 4 is always on screen, so there is nothing to
   * advance *to*, and a first tick on the checklist folding the checklist away
   * would be the trap this rework exists to avoid.
   *
   * Once a run has reported, nothing is open: the answer to step 4 is what the
   * screen is about, and a 200-row checklist sitting on top of it is the pile
   * again. Every header is still one click from being a form.
   */
  const naturalStep = !creatorId ? 1 : mode === 'catalog' && !catalog ? 2 : run ? 0 : 3;
  const currentStep = openStep ?? naturalStep;
  const toggleStep = (n: number) => setOpenStep(current => (current === n ? null : n));

  const sourceLabel = SOURCE_LABELS[source];
  const stepTwoSummary = mode === 'link'
    ? undefined
    : catalog?.ok
      ? `${sourceLabel} · ${entries.length} listed`
      : catalog
        ? `${sourceLabel} · could not be listed`
        : `${sourceLabel} · not listed yet`;
  const stepThreeSummary = mode === 'link'
    ? linkUrl.trim() || 'Nothing pasted yet'
    : `${selected.length} of ${entries.length} selected`;

  return (
    <div style={card} data-testid="admin-sync-panel">

      {/* ── The card's own header: what this screen does, and the one number
             that is true of the whole screen rather than of a step. ────────── */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#222' }}>Manual sync</h2>
        {/* The other budget. A dollar cost buys extractions; this buys listings
            and description writes, and it is shared and daily. It lives up here
            because listings and appends both spend it — under the checklist it
            vanished the moment a listing failed, having already been charged. */}
        {quotaUnits > 0 && (
          <span style={{ ...hint, marginLeft: 'auto' }} data-testid="quota-spent">
            {quotaUnits} YouTube quota {quotaUnits === 1 ? 'unit' : 'units'} spent on this screen, of 10,000/day
          </span>
        )}
      </div>
      <p style={{ margin: '6px 0 0', fontSize: '12px', color: '#6b7280', lineHeight: 1.6 }}>
        Imports run on behalf of the creator you pick and land in <strong>Review</strong> as drafts — nothing
        goes live until somebody opens the meal card there and approves it. Listing a catalog is free; running a
        selection is not.
      </p>

      {/* ── 1 · Creator ──────────────────────────────────────────────────────
             Reachable at every point, including mid-run: changing who a run is
             for must never mean starting the screen again. */}
      <Step
        index={1}
        title="Creator"
        summary={creator?.display_name ?? 'Nobody chosen yet'}
        done={Boolean(creatorId)}
        open={currentStep === 1}
        onToggle={() => toggleStep(1)}
      >
        <select
          value={creatorId}
          onChange={e => chooseCreator(e.target.value)}
          aria-label="Creator"
          style={{ padding: '7px 12px', border: '1px solid #ddd', borderRadius: '8px', fontSize: '14px', background: 'white', cursor: 'pointer', width: '100%', maxWidth: '320px' }}
        >
          <option value="">Choose a creator…</option>
          {creators.map(c => (
            <option key={c.id} value={c.id}>{c.display_name}</option>
          ))}
        </select>
      </Step>

      {/* ── 2 · Where from ───────────────────────────────────────────────────
             The two radios are the aside rather than the body, so the fork
             between one link and a catalogue is switchable without first
             re-opening the step it belongs to. */}
      <Step
        index={2}
        title="Where from"
        summary={stepTwoSummary}
        done={mode === 'link' || Boolean(catalog?.ok)}
        open={currentStep === 2}
        onToggle={() => toggleStep(2)}
        aside={
          <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
            {(['link', 'catalog'] as const).map(value => (
              <label key={value} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#333', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="sync-mode"
                  checked={mode === value}
                  onChange={() => chooseMode(value)}
                  style={{ accentColor: '#dd0031' }}
                />
                {value === 'link' ? 'One link' : 'Pick from their catalog'}
              </label>
            ))}
          </div>
        }
      >
        {mode === 'catalog' ? (
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              value={source}
              onChange={e => { setSource(e.target.value as PlatformSource); setCatalog(null); setSelected([]); }}
              aria-label="Source"
              style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: '8px', fontSize: '13px', background: 'white', cursor: 'pointer' }}
            >
              {PLATFORM_SOURCES.map(s => (
                <option key={s} value={s} disabled={!listableSource(creator, s)}>
                  {SOURCE_LABELS[s]}
                </option>
              ))}
            </select>
            <button
              onClick={loadCatalog}
              disabled={!creatorId || loadingCatalog}
              style={{ ...secondaryButton, cursor: loadingCatalog ? 'wait' : 'pointer' }}
            >
              {loadingCatalog ? 'Reading feed…' : catalog ? 'Reload catalog' : 'List what they publish'}
            </button>
            <span style={hint}>
              Reads the feed only — no pages are fetched and no model is called.
            </span>
          </div>
        ) : undefined}
      </Step>

      {/* ── 3 · The link, or the checklist ───────────────────────────────────
             The working step. It stays open once reached, because this is where
             an operator spends their time. */}
      <Step
        index={3}
        title={mode === 'link' ? 'The link' : 'Choose what to import'}
        summary={stepThreeSummary}
        done={mode === 'link' ? Boolean(linkUrl.trim()) : selected.length > 0}
        open={currentStep === 3}
        onToggle={() => toggleStep(3)}
        aside={mode === 'catalog' && catalog?.ok && currentStep === 3 ? (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={selectAllNew} style={secondaryButton}>
              Select all not yet imported ({unimported.length})
            </button>
            <button onClick={() => setSelected([])} style={secondaryButton}>Clear selection</button>
          </div>
        ) : undefined}
      >
        {mode === 'link' ? (
          <div>
            <input
              type="url"
              value={linkUrl}
              onChange={e => setLinkUrl(e.target.value)}
              placeholder="https://theirblog.com/the-recipe"
              aria-label="Recipe link"
              style={{ width: '100%', maxWidth: '520px', padding: '9px 12px', border: '1px solid #ddd', borderRadius: '8px', fontSize: '14px' }}
            />
            <p style={{ margin: '6px 0 0', fontSize: '12px', color: '#888' }}>
              {formatSelectionCost(1)} · the gate still runs, so a page that is not a recipe is dropped.
            </p>
          </div>
        ) : (
          <div>
            {/* A listing that refused says why, in place of the checklist. */}
            {catalog && !catalog.ok && (
              <p style={{ margin: 0, fontSize: '13px', color: '#92400e', background: '#fff8e1', border: '1px solid #fde68a', borderRadius: '8px', padding: '10px 12px', lineHeight: 1.6 }}>
                {catalog.detail}
              </p>
            )}

            {!catalog && (
              <p style={{ margin: 0, fontSize: '12px', color: '#888', lineHeight: 1.6 }}>
                Nothing listed yet. Open <strong>Where from</strong> above and press
                {' '}<em>List what they publish</em> — reading the feed costs nothing.
              </p>
            )}

            {catalog?.ok && (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
                  <h3 style={{ margin: 0, fontSize: '13px', fontWeight: 700, color: '#222' }}>
                    {catalog.entries.length} item{catalog.entries.length === 1 ? '' : 's'} published
                  </h3>
                  {catalog.feed && (
                    <a href={catalog.feed.url} target="_blank" rel="noopener noreferrer nofollow" style={{ fontSize: '11px', color: '#2563eb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                      {catalog.feed.url}
                    </a>
                  )}
                  {catalog.entries.length === 0 && catalog.nextPageToken && (
                    <span style={{ fontSize: '11px', color: '#b45309' }} data-testid="empty-page">
                      Every upload on this page is private or unreadable. There is more behind it.
                    </span>
                  )}
                  {catalog.truncated && !catalog.nextPageToken && (
                    <span style={{ fontSize: '11px', color: '#b45309' }}>
                      Showing the most recent {catalog.entries.length}; sync those, then reload for more.
                    </span>
                  )}
                </div>

                <div style={{ maxHeight: '340px', overflowY: 'auto', border: '1px solid #f0f0f0', borderRadius: '8px' }}>
                  {catalog.entries.map((entry, i) => (
                    <label
                      key={entry.itemId}
                      style={{
                        display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '8px 12px',
                        borderTop: i === 0 ? 'none' : '1px solid #f7f7f7', cursor: 'pointer',
                        background: isImported(entry) ? '#fafafa' : 'white',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(entry.itemId)}
                        onChange={() => toggle(entry.itemId)}
                        aria-label={entry.title || entry.url}
                        style={{ accentColor: '#dd0031', marginTop: '3px' }}
                      />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: '13px', color: '#222', fontWeight: 500 }}>{entry.title || entry.url}</span>
                        <span style={{ display: 'block', fontSize: '11px', color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {formatDate(entry.publishedAt)} · {entry.url}
                        </span>
                      </span>
                      {entry.record && (
                        <span style={{
                          fontSize: '11px', fontWeight: 700, borderRadius: '99px', padding: '2px 8px', flexShrink: 0,
                          background: entry.record.status === 'imported' ? '#e6f9ed' : '#f3f4f6',
                          color: entry.record.status === 'imported' ? '#1a7a3a' : '#6b7280',
                        }}>
                          {entry.record.status === 'imported' ? 'Already imported' : entry.record.status}
                        </span>
                      )}
                    </label>
                  ))}
                </div>

                {/* One press, one page, one unit. A back catalogue is walked
                    because somebody asked for it, never because a screen was
                    opened. */}
                {catalog.nextPageToken && (
                  <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <button onClick={loadMore} disabled={loadingCatalog} style={{ ...secondaryButton, cursor: loadingCatalog ? 'wait' : 'pointer' }}>
                      {loadingCatalog ? 'Reading…' : 'Load 50 more'}
                    </button>
                    <span style={hint}>
                      There is more back catalogue than this. Each page costs 1–2 quota units and your selection is kept.
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </Step>

      {/* ── 4 · Run ──────────────────────────────────────────────────────────
             Never collapses. The cost of what is about to be spent is not
             something an operator should have to expand a step to see. */}
      <div style={sectionRow}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span style={stepBadge(false, true)} aria-hidden="true">4</span>
          <span style={stepTitle}>Run it</span>
        </div>

        {error && (
          <div style={{ margin: '12px 0 0', background: '#fff0f0', border: '1px solid #ffcccc', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: '#c40029', lineHeight: 1.6 }}>
            {error}
          </div>
        )}

        <div style={{
          marginTop: '12px', display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap',
          background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: '10px', padding: '14px 16px',
        }}>
          {mode === 'catalog' && (
            <span
              style={{ fontSize: '15px', fontWeight: 700, color: selected.length > 0 ? '#222' : '#aaa' }}
              data-testid="cost-estimate"
            >
              {formatSelectionCost(selected.length)}
            </span>
          )}
          <button
            onClick={start}
            disabled={!canStart || busy}
            // Beside the cost when there is one to sit beside; a lone
            // right-aligned button in link mode would just look stranded.
            style={{ ...primaryButton(busy), marginLeft: mode === 'catalog' ? 'auto' : undefined, opacity: canStart ? 1 : 0.4 }}
          >
            {busy ? 'Syncing…' : mode === 'link' ? 'Sync this link' : 'Sync selection'}
          </button>
        </div>

        {/* No notify checkbox here any more. A run tells the creator nothing
            because a run publishes nothing; the email is offered on Approve,
            which is the first point at which there is something true to say. */}
        <p style={{ margin: '10px 0 0', fontSize: '12px', color: '#888', lineHeight: 1.6 }}>
          {creator?.display_name ?? 'The creator'} is emailed when you approve a draft in Review, listing what
          went live and how to edit or unpublish it. Nothing is sent for a sync on its own.
        </p>
      </div>

      {/* ── What the run did ─────────────────────────────────────────────────
             Not a numbered step: it is the answer to step 4, and it appears in
             place rather than as another card further down the page. */}
      {run && totals && (
        <div style={sectionRow}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: '13px', fontWeight: 700, color: '#222' }}>
              {run.status === 'done' ? 'Run finished' : 'Running…'}
            </h3>
            <span style={hint}>${totals.costUsd.toFixed(4)} spent</span>
            {run.status !== 'done' && !busy && (
              <button onClick={resume} style={{ ...secondaryButton, marginLeft: 'auto' }}>Resume</button>
            )}
          </div>

          {/* The arithmetic on screen: selected 12, queued 9, and where the
              other three went. Anything less makes a correct run look broken. */}
          <p style={{ margin: '8px 0 0', fontSize: '13px', color: '#444', lineHeight: 1.7 }} data-testid="run-summary">
            Selected {totals.selected} · queued for review <strong>{totals.drafted}</strong>
            {totals.rejected > 0 && <> · {totals.rejected} dropped by the gate (not a recipe)</>}
            {totals.skipped > 0 && <> · {totals.skipped} already imported</>}
            {totals.failed > 0 && <> · {totals.failed} failed</>}
            {totals.pending > 0 && <> · {totals.pending} still to go</>}
          </p>

          {totals.drafted > 0 && (
            <p style={{ margin: '10px 0 0', fontSize: '12px', color: '#b45309', lineHeight: 1.6 }}>
              Nothing is live yet. {totals.drafted} {totals.drafted === 1 ? 'draft is' : 'drafts are'} waiting in{' '}
              <strong>Review</strong>
              {totals.needALook > 0 && <> · {totals.needALook} {totals.needALook === 1 ? 'field' : 'fields'} flagged for a look</>}.
            </p>
          )}

          <div style={{ marginTop: '12px', maxHeight: '340px', overflowY: 'auto' }}>
            {run.items.map((item, i) => {
              const style = ITEM_STYLES[item.status];
              return (
                <div key={item.itemId} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '8px 0', borderTop: i === 0 ? 'none' : '1px solid #f7f7f7' }}>
                  <span style={{ fontSize: '11px', fontWeight: 700, borderRadius: '99px', padding: '2px 8px', flexShrink: 0, background: style.bg, color: style.fg }}>
                    {style.label}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: '13px', color: '#222' }}>{item.mealName || item.title || item.url}</span>
                    {item.detail && (
                      <span style={{ display: 'block', fontSize: '11px', color: '#888', lineHeight: 1.5 }}>{item.detail}</span>
                    )}
                  </span>
                  {item.status === 'drafted' && item.needALook != null && (
                    <span style={{ fontSize: '11px', color: item.needALook > 0 ? '#b45309' : '#aaa', flexShrink: 0 }}>
                      {item.needALook > 0 ? `${item.needALook} flagged` : 'nothing flagged'}
                    </span>
                  )}
                  {item.status === 'failed' && (
                    <button onClick={() => retryItem(item.itemId)} disabled={busy} style={secondaryButton}>Retry</button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Afterwards: link their videos back to Mealio (MEAL-79) ───────────
             Folded away by default. It is not part of the sequence — it acts on
             meals already approved — and for most creators the honest answer is
             a refusal, so it should not take up the screen until asked for. */}
      {creatorId && (
        <div style={sectionRow} data-testid="append-panel">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => setAppendOpen(open => !open)}
              aria-expanded={appendOpen}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', minWidth: 0, flex: '1 1 240px' }}
            >
              <span style={{ ...stepTitle, whiteSpace: 'normal' }}>Add the Mealio link to their videos</span>
              <span style={{ fontSize: '11px', color: '#9ca3af' }}>{appendOpen ? 'Hide' : 'Show'}</span>
            </button>
            <button
              onClick={loadAppendable}
              disabled={appendBusy === 'list'}
              style={secondaryButton}
            >
              {appendBusy === 'list' ? 'Checking…' : appendable ? 'Reload' : 'Check what can be linked'}
            </button>
          </div>

          {appendOpen && (
            <>
              <p style={{ margin: '10px 0 0', fontSize: '12px', color: '#888', lineHeight: 1.6 }}>
                Only meals we imported <em>from one of their videos</em> are offered, and only when the creator has
                turned on description editing. Adding a link twice does nothing. Turning consent off stops future
                writes — it does not remove links already added, because we cannot un-tell a viewer.
              </p>

              {/* The refusal, in place of the list. Which of the three gates was
                  shut is the whole content, so the sentence is shown verbatim. */}
              {appendRefusal && (
                <p
                  style={{ margin: '12px 0 0', fontSize: '12px', color: '#92400e', background: '#fff8e1', border: '1px solid #fde68a', borderRadius: '8px', padding: '10px 12px', lineHeight: 1.6 }}
                  data-testid="append-refusal"
                >
                  {appendRefusal}
                </p>
              )}

              {appendable && appendable.length === 0 && (
                <p style={{ margin: '12px 0 0', fontSize: '12px', color: '#888' }}>
                  Nothing yet. A meal becomes linkable once it has been imported from one of their videos and
                  approved in <strong>Review</strong>.
                </p>
              )}

              {/* There is no cursor past the ceiling, so saying so is the whole
                  remedy: a creator past it would otherwise have their older
                  imports become unlinkable with the screen showing nothing. */}
              {appendTruncated && (
                <p style={{ margin: '12px 0 0', fontSize: '11px', color: '#b45309' }} data-testid="append-truncated">
                  Showing the {appendable?.length ?? 0} most recently approved. This creator has more, and there is
                  no way to reach them from here yet — link these, then reload.
                </p>
              )}

              {appendable && appendable.length > 0 && (
                <div style={{ marginTop: '12px', maxHeight: '340px', overflowY: 'auto', border: '1px solid #f0f0f0', borderRadius: '8px' }}>
                  {appendable.map((meal, i) => (
                    <div
                      key={meal.draftId}
                      style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '10px 12px', borderTop: i === 0 ? 'none' : '1px solid #f7f7f7' }}
                    >
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: '13px', color: '#222', fontWeight: 500 }}>{meal.mealName}</span>
                        <span style={{ display: 'block', fontSize: '11px', color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {meal.videoUrl} → {meal.mealUrl}
                        </span>
                        {appendResults[meal.draftId] && (
                          <span style={{ display: 'block', fontSize: '11px', color: '#555', lineHeight: 1.5, marginTop: '2px' }}>
                            {appendResults[meal.draftId]}
                          </span>
                        )}
                      </span>
                      <button
                        onClick={() => appendOne(meal)}
                        disabled={Boolean(appendBusy)}
                        aria-label={`Append the Mealio link for ${meal.mealName}`}
                        style={{ ...secondaryButton, flexShrink: 0, cursor: appendBusy ? 'wait' : 'pointer' }}
                      >
                        {appendBusy === meal.draftId ? 'Writing…' : 'Append link'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
