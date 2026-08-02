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
 * And the checklist is drawn from feed metadata alone — opening it costs one
 * feed request, so an operator can look at a 200-post archive without spending
 * anything to find out what is in it.
 *
 * The cost line under the selection is the real guard rail. A confirmation
 * dialog gets clicked through; "137 selected · about $9.16" gets read.
 *
 * A run **queues drafts for review** (MEAL-91). It used to publish, and the
 * language on this screen said so; a finished run now hands over to the Review
 * tab, and every "Published" here would be a lie about where the recipe is.
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

  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(false);

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
    setRun(null);
    setTotals(null);
    setError('');
    const chosen = creators.find(c => c.id === id);
    // Default to whatever source they are already set up on; the operator can
    // still pick another of their links.
    const primary = chosen?.primary_source;
    setSource(primary && primary !== 'none' ? (primary as PlatformSource) : 'website');
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
    setCatalog(data.catalog as CatalogResult);
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }} data-testid="admin-sync-panel">

      <div style={{ background: '#f8f9fa', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '18px 20px' }}>
        <h2 style={{ margin: '0 0 6px', fontSize: '14px', fontWeight: 700, color: '#374151' }}>Manual sync</h2>
        <p style={{ margin: 0, fontSize: '12px', color: '#6b7280', lineHeight: 1.6 }}>
          Imports run on behalf of the creator you pick and land in <strong>Review</strong> as drafts — nothing
          goes live until somebody opens the meal card there and approves it. Listing a catalog is free; running a
          selection is not.
        </p>
      </div>

      <div style={card}>
        <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#444', marginBottom: '6px' }}>
          Creator
        </label>
        <select
          value={creatorId}
          onChange={e => chooseCreator(e.target.value)}
          aria-label="Creator"
          style={{ padding: '7px 12px', border: '1px solid #ddd', borderRadius: '8px', fontSize: '14px', background: 'white', cursor: 'pointer', minWidth: '260px' }}
        >
          <option value="">Choose a creator…</option>
          {creators.map(c => (
            <option key={c.id} value={c.id}>{c.display_name}</option>
          ))}
        </select>

        <div style={{ display: 'flex', gap: '16px', marginTop: '16px', flexWrap: 'wrap' }}>
          {(['link', 'catalog'] as const).map(value => (
            <label key={value} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#333', cursor: 'pointer' }}>
              <input
                type="radio"
                name="sync-mode"
                checked={mode === value}
                onChange={() => { setMode(value); setError(''); }}
                style={{ accentColor: '#dd0031' }}
              />
              {value === 'link' ? 'One link' : 'Pick from their catalog'}
            </label>
          ))}
        </div>

        {mode === 'link' ? (
          <div style={{ marginTop: '14px' }}>
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
          <div style={{ marginTop: '14px' }}>
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
              <span style={{ fontSize: '11px', color: '#aaa' }}>
                Reads the feed only — no pages are fetched and no model is called.
              </span>
            </div>
          </div>
        )}
      </div>

      {catalog && !catalog.ok && (
        <div style={{ ...card, background: '#fff8e1', border: '1px solid #fde68a' }}>
          <p style={{ margin: 0, fontSize: '13px', color: '#92400e', lineHeight: 1.6 }}>{catalog.detail}</p>
        </div>
      )}

      {catalog?.ok && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
            <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#222' }}>
              {catalog.entries.length} item{catalog.entries.length === 1 ? '' : 's'} published
            </h3>
            {catalog.feed && (
              <a href={catalog.feed.url} target="_blank" rel="noopener noreferrer nofollow" style={{ fontSize: '11px', color: '#2563eb' }}>
                {catalog.feed.url}
              </a>
            )}
            {catalog.truncated && (
              <span style={{ fontSize: '11px', color: '#b45309' }}>
                Showing the most recent {catalog.entries.length}; sync those, then reload for more.
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
            <button onClick={selectAllNew} style={secondaryButton}>
              Select all not yet imported ({unimported.length})
            </button>
            <button onClick={() => setSelected([])} style={secondaryButton}>Clear selection</button>
          </div>

          <div style={{ maxHeight: '360px', overflowY: 'auto', border: '1px solid #f0f0f0', borderRadius: '8px' }}>
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
        </div>
      )}

      {creatorId && (
        <div style={card}>
          {/* No notify checkbox here any more. A run tells the creator nothing
              because a run publishes nothing; the email is offered on Approve,
              which is the first point at which there is something true to say. */}
          <p style={{ margin: '0 0 14px', fontSize: '12px', color: '#888', lineHeight: 1.6 }}>
            {creator?.display_name ?? 'The creator'} is emailed when you approve a draft in Review, listing what
            went live and how to edit or unpublish it. Nothing is sent for a sync on its own.
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
            <button onClick={start} disabled={!canStart || busy} style={{ ...primaryButton(busy), opacity: canStart ? 1 : 0.4 }}>
              {busy ? 'Syncing…' : mode === 'link' ? 'Sync this link' : 'Sync selection'}
            </button>
            {mode === 'catalog' && (
              <span style={{ fontSize: '13px', fontWeight: 600, color: selected.length > 0 ? '#222' : '#aaa' }} data-testid="cost-estimate">
                {formatSelectionCost(selected.length)}
              </span>
            )}
          </div>
        </div>
      )}

      {error && (
        <div style={{ background: '#fff0f0', border: '1px solid #ffcccc', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: '#c40029' }}>
          {error}
        </div>
      )}

      {run && totals && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#222' }}>
              {run.status === 'done' ? 'Run finished' : 'Running…'}
            </h3>
            <span style={{ fontSize: '11px', color: '#aaa' }}>${totals.costUsd.toFixed(4)} spent</span>
            {run.status !== 'done' && !busy && (
              <button onClick={resume} style={secondaryButton}>Resume</button>
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

          <div style={{ marginTop: '12px', maxHeight: '360px', overflowY: 'auto' }}>
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
    </div>
  );
}
