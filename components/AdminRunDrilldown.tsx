'use client';

import { useState } from 'react';

/**
 * One automation run, step by step (MEAL-143).
 *
 * The funnel above this card deals in rates: it can say HEB's confirm step fails
 * 12% of the time, and nothing whatsoever about any of the runs that failed. This
 * is the other end — a picker for recent failing runs, and the ordered trace behind
 * whichever one is opened.
 *
 * Deliberately plain. Two tables and a banner stack, in the styling the funnel card
 * already uses; the value here is the rows, not the presentation, and a drilldown
 * that needed its own visual language would be a second dashboard to maintain.
 *
 * THREE PLACES IT HAS TO CONTRADICT ITSELF ON PURPOSE, because each is a way the
 * screen would otherwise lie:
 *
 *   * An empty trace is not an idle run (MEAL-122). The parallel and pre-search add
 *     pools emit no per-item rows at all, and Kroger never runs the WebView engine,
 *     so a run that added everything can leave nothing behind. The empty state says
 *     "not instrumented", never "did nothing".
 *   * A truncated trace is not a trace. It is labelled before the steps rather than
 *     under them, because the misreading it invites — the last row is where the run
 *     stopped — happens at a glance.
 *   * The run_summary code is not the cause (MEAL-123). It is the run's most
 *     frequent code, so it can name three confirm failures and hide the WAF block
 *     that caused them. It is shown next to "first failure", which for a complete
 *     trace is an observation rather than a ranking, and marked as the weaker of
 *     the two.
 */

/** A run row as the list and trace endpoints return it — stored shape, unrenamed. */
export interface RunRow {
  id: string;
  store_id: string;
  source: string | null;
  status: string;
  outcome: string | null;
  meal_count: number | null;
  items_requested: number | null;
  items_added: number | null;
  started_at: string | null;
  completed_at: string | null;
  config_version: number | null;
  app_version: string | null;
  platform: string | null;
}

export interface RunConcern {
  abandoned: boolean;
  failed: boolean;
  /** Reported, never filtered on: PostgREST cannot compare two columns. */
  partialAdds: boolean;
  clean: boolean;
}

export interface TraceStep {
  seq: number;
  step: string;
  outcome: string;
  code: string | null;
  duration_ms: number | null;
  item_index: number | null;
  detail: Record<string, unknown> | null;
  config_version: number | null;
  app_version: string | null;
  occurred_at: string | null;
}

interface FirstFailure {
  kind: 'failed' | 'clean' | 'no_trace' | 'incomplete';
  seq?: number;
  step?: string;
  outcome?: string;
  code?: string | null;
  itemIndex?: number | null;
  blocked?: boolean;
}

interface TraceResponse {
  run: RunRow;
  steps: TraceStep[];
  summary: {
    stepsRead: number;
    complete: boolean;
    firstFailure: FirstFailure;
    failures: number;
    blocked: number;
    runSummaryCode: string | null;
    hasRunSummary: boolean;
    seq: { min: number | null; max: number | null; count: number; missing: number; startsLate: boolean };
    versions: { configVersions: number[]; appVersions: string[]; mixed: boolean };
    missingItemSteps: string[];
    noItemInstrumentation: boolean;
    itemsMissed: number | null;
  };
  read: { stepsRead: number; expectedSteps: number | null; pagesComplete: boolean; complete: boolean; reason?: string };
  truncated: boolean;
  caveats: string[];
}

interface ListResponse {
  days: number;
  storeId: string | null;
  filter: string;
  limit: number;
  runs: Array<RunRow & { concern: RunConcern }>;
  listMaybeTruncated: boolean;
  caveats: string[];
}

const CARD: React.CSSProperties = {
  background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden',
};
const WARN: React.CSSProperties = {
  margin: '16px 24px 0', padding: '12px 16px', background: '#fffbeb', border: '1px solid #fde68a',
  borderRadius: '8px', fontSize: '13px', color: '#92400e',
};
const CONTROL: React.CSSProperties = {
  border: '1px solid #e0e0e0', background: 'white', borderRadius: '6px', padding: '4px 10px',
  fontSize: '13px', color: '#666',
};
const TH: React.CSSProperties = { padding: '6px 8px' };
const TD: React.CSSProperties = { padding: '6px 8px' };
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

function ms(v: number | null): string {
  if (v == null) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`;
}

function when(ts: string | null): string {
  if (!ts) return '—';
  const t = Date.parse(ts);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : ts;
}

/** Colour by what the row means, not by whether it is non-ok: a wall is not drift. */
function outcomeColor(step: TraceStep): string {
  if (step.step === 'blocked' || step.outcome === 'blocked' || step.code === 'waf_block') return '#92400e';
  if (step.outcome === 'ok') return '#16a34a';
  if (step.outcome === 'skipped') return '#999';
  return '#b91c1c';
}

/** The shortest true label for a run row, from the flags the API computed. */
function concernLabel(concern: RunConcern): { text: string; color: string; background: string; border: string } {
  if (concern.abandoned) return { text: 'ABANDONED', color: '#92400e', background: '#fffbeb', border: '#fde68a' };
  if (concern.failed) return { text: 'FAILED', color: '#b91c1c', background: '#fef2f2', border: '#fecaca' };
  if (concern.partialAdds) return { text: 'PARTIAL', color: '#92400e', background: '#fffbeb', border: '#fde68a' };
  if (concern.clean) return { text: 'OK', color: '#16a34a', background: '#f0fdf4', border: '#bbf7d0' };
  // Finished, no outcome recorded. The row PostgREST's `outcome <> 'success'`
  // silently drops, which is why the filter names it explicitly.
  return { text: 'NO OUTCOME', color: '#92400e', background: '#fffbeb', border: '#fde68a' };
}

export default function AdminRunDrilldown({ stores }: { stores: string[] }) {
  const token = () => localStorage.getItem('accessToken');

  const [storeId, setStoreId] = useState('');
  const [days, setDays] = useState(7);
  const [filter, setFilter] = useState<'failing' | 'all'>('failing');
  const [list, setList] = useState<ListResponse | null>(null);
  const [listing, setListing] = useState(false);
  const [runIdInput, setRunIdInput] = useState('');
  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [tracing, setTracing] = useState(false);
  const [error, setError] = useState('');

  const loadList = async () => {
    setError('');
    setListing(true);
    const params = new URLSearchParams({ days: String(days), filter });
    if (storeId) params.set('storeId', storeId);
    const res = await fetch(`/api/admin/automation-runs?${params}`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    setListing(false);
    if (!res.ok) {
      setError(`Could not list runs (${res.status}).`);
      return;
    }
    setList(await res.json());
  };

  const loadTrace = async (id: string) => {
    const runId = id.trim();
    if (!runId) return;
    setError('');
    setTracing(true);
    setRunIdInput(runId);
    const res = await fetch(`/api/admin/automation-runs/${encodeURIComponent(runId)}`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    setTracing(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setTrace(null);
      setError(
        res.status === 404
          ? 'No run with that id. Runs are pruned, so a bookmarked trace outlives its row.'
          : `Could not load that trace (${res.status}${body.error ? `: ${body.error}` : ''}).`,
      );
      return;
    }
    setTrace(await res.json());
  };

  const first = trace?.summary.firstFailure;

  return (
    <div style={CARD}>
      <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0' }}>
        <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Run drilldown</h2>
        <p style={{ margin: '6px 0 0', fontSize: '13px', color: '#888' }}>
          The funnel above is a set of rates and cannot show you a run. This lists recent runs that
          were not a clean success and reads the whole ordered trace behind one of them — every step,
          in the order the app reported it, with the failure code and the <code>detail</code> payload.
        </p>
      </div>

      {/* ── Picker ─────────────────────────────────────────────────────── */}
      <div style={{ padding: '16px 24px', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', borderBottom: '1px solid #f0f0f0' }}>
        <select value={storeId} onChange={(e) => setStoreId(e.target.value)} style={CONTROL}>
          <option value="">All stores</option>
          {stores.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={filter} onChange={(e) => setFilter(e.target.value as 'failing' | 'all')} style={CONTROL}>
          <option value="failing">Not a clean success</option>
          <option value="all">Every run</option>
        </select>
        <div style={{ display: 'flex', gap: '6px' }}>
          {[1, 7, 30].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              style={{
                ...CONTROL,
                cursor: 'pointer',
                borderColor: days === d ? '#dd0031' : '#e0e0e0',
                background: days === d ? '#fff1f3' : 'white',
                color: days === d ? '#dd0031' : '#666',
                fontWeight: days === d ? 600 : 400,
              }}
            >
              {d}d
            </button>
          ))}
        </div>
        <button
          onClick={loadList}
          disabled={listing}
          style={{ ...CONTROL, cursor: listing ? 'not-allowed' : 'pointer', borderColor: '#dd0031', color: '#dd0031' }}
        >
          {listing ? 'Loading…' : 'List runs'}
        </button>
        <div style={{ display: 'flex', gap: '6px', marginLeft: 'auto' }}>
          <input
            value={runIdInput}
            onChange={(e) => setRunIdInput(e.target.value)}
            placeholder="…or paste a run id"
            style={{ ...CONTROL, width: '300px', fontFamily: MONO, fontSize: '12px' }}
          />
          <button onClick={() => loadTrace(runIdInput)} disabled={tracing} style={{ ...CONTROL, cursor: 'pointer' }}>
            Open
          </button>
        </div>
      </div>

      {error && (
        <div style={{ margin: '16px 24px 0', padding: '12px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', fontSize: '13px', color: '#b91c1c' }}>
          {error}
        </div>
      )}

      {/* ── The list ───────────────────────────────────────────────────── */}
      {list && (
        <div style={{ padding: '0 24px 20px' }}>
          {list.listMaybeTruncated && (
            <div style={{ ...WARN, margin: '16px 0 0' }}>
              Showing the {list.limit} most recent matching runs and there are probably more. Narrow the
              window or pick one store — this list is a way in, not a census.
            </div>
          )}

          {list.runs.length === 0 ? (
            <p style={{ fontSize: '13px', color: '#888', margin: '16px 0 0' }}>
              No run in the last {list.days} day{list.days === 1 ? '' : 's'} matched.
              {list.filter === 'failing' && ' Note that a run reporting outcome=success while adding fewer items ' +
                'than it was asked for is not in this filter — PostgREST cannot compare two columns. Switch to ' +
                '“Every run” and look for the PARTIAL badge.'}
            </p>
          ) : (
            <div style={{ overflowX: 'auto', marginTop: '16px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '760px' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#888', fontSize: '12px' }}>
                    <th style={TH}>Started</th>
                    <th style={TH}>Store</th>
                    <th style={TH}>Verdict</th>
                    <th style={TH}>Status / outcome</th>
                    <th style={TH} title="Items added over items requested, from the run row">Items</th>
                    <th style={TH} title="What the client reported when the run started">Config / app</th>
                    <th style={TH}></th>
                  </tr>
                </thead>
                <tbody>
                  {list.runs.map((r) => {
                    const label = concernLabel(r.concern);
                    const open = trace?.run.id === r.id;
                    return (
                      <tr key={r.id} style={{ borderTop: '1px solid #f5f5f5', background: open ? '#fff8f8' : undefined }}>
                        <td style={{ ...TD, whiteSpace: 'nowrap' }}>{when(r.started_at)}</td>
                        <td style={TD}>{r.store_id}</td>
                        <td style={TD}>
                          <span style={{ background: label.background, color: label.color, border: `1px solid ${label.border}`, borderRadius: '999px', padding: '1px 10px', fontSize: '11px', fontWeight: 700 }}>
                            {label.text}
                          </span>
                        </td>
                        <td style={{ ...TD, color: '#666' }}>{r.status} / {r.outcome ?? '—'}</td>
                        <td style={{ ...TD, color: '#666' }}>
                          {r.items_added ?? '—'}/{r.items_requested ?? '—'}
                        </td>
                        <td style={{ ...TD, color: '#666' }}>
                          v{r.config_version ?? '—'} · {r.app_version ?? '—'} · {r.platform ?? '—'}
                        </td>
                        <td style={TD}>
                          <button onClick={() => loadTrace(r.id)} style={{ ...CONTROL, cursor: 'pointer', padding: '3px 10px', fontSize: '12px' }}>
                            {open ? 'Open ✓' : 'Trace'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── The trace ──────────────────────────────────────────────────── */}
      {tracing && <p style={{ padding: '0 24px 20px', color: '#888', fontSize: '13px', margin: 0 }}>Loading trace…</p>}

      {trace && !tracing && (
        <div style={{ borderTop: '1px solid #f0f0f0' }}>
          <div style={{ padding: '20px 24px 0' }}>
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>
              {trace.run.store_id} · {when(trace.run.started_at)}
            </h3>
            <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#999', fontFamily: MONO }}>{trace.run.id}</p>
            <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', marginTop: '12px', fontSize: '13px', color: '#666' }}>
              <span>{trace.run.status} / {trace.run.outcome ?? 'no outcome'}</span>
              <span>{trace.run.items_added ?? '—'}/{trace.run.items_requested ?? '—'} items added</span>
              <span>{trace.run.meal_count ?? '—'} meal(s) · {trace.run.source ?? '—'}</span>
              <span>
                config v{trace.summary.versions.configVersions.join(', v') || '—'} · app{' '}
                {trace.summary.versions.appVersions.join(', ') || '—'} · {trace.run.platform ?? '—'}
              </span>
              <span>
                {trace.read.stepsRead} step row{trace.read.stepsRead === 1 ? '' : 's'}
                {trace.read.expectedSteps != null && ` of ${trace.read.expectedSteps}`}
              </span>
            </div>

            {/* The two verdicts, side by side, with the weaker one marked. */}
            <div style={{ display: 'flex', gap: '28px', flexWrap: 'wrap', marginTop: '14px' }}>
              <div>
                <div style={{ fontSize: '11px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  First failure, in run order
                </div>
                <div style={{ fontSize: '16px', fontWeight: 700, color: first?.kind === 'failed' ? '#b91c1c' : '#333' }}>
                  {first?.kind === 'failed'
                    ? `${first.step} · seq ${first.seq}`
                    : first?.kind === 'clean' ? 'nothing failed'
                      : first?.kind === 'no_trace' ? 'no step rows'
                        : 'unknown — trace incomplete'}
                </div>
                <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>
                  {first?.kind === 'failed'
                    ? `${first.outcome}${first.code ? ` · ${first.code}` : ' · no code'}` +
                      `${first.itemIndex != null ? ` · item ${first.itemIndex}` : ''}` +
                      `${first.blocked ? ' · robot wall, not drift' : ''}`
                    : first?.kind === 'incomplete'
                      ? 'the rows read are a prefix, so “first” is not a fact about this run'
                      : first?.kind === 'no_trace'
                        ? 'instrumentation, not inactivity — see the note below'
                        : 'every step reported ok or skipped'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  run_summary says
                </div>
                <div style={{ fontSize: '16px', fontWeight: 700, color: '#666' }}>
                  {trace.summary.runSummaryCode ?? (trace.summary.hasRunSummary ? 'no code' : '—')}
                </div>
                <div style={{ fontSize: '11px', color: '#999', marginTop: '2px', maxWidth: '280px' }}>
                  The run&apos;s most frequent code, not its most severe (MEAL-123). Where the two
                  columns disagree, the ordered one on the left is the one that saw the rows.
                </div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Failures / walls
                </div>
                <div style={{ fontSize: '16px', fontWeight: 700, color: trace.summary.failures > 0 ? '#b91c1c' : '#333' }}>
                  {trace.summary.failures} / {trace.summary.blocked}
                </div>
                <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>
                  drift-shaped rows / robot walls{trace.truncated ? ' · lower bounds' : ''}
                </div>
              </div>
            </div>
          </div>

          {/* Caveats first. The misreadings they head off happen at a glance. */}
          {trace.caveats.map((c) => (
            <div key={c} style={WARN}>{c}</div>
          ))}

          <div style={{ padding: '20px 24px' }}>
            {trace.steps.length === 0 ? (
              <p style={{ fontSize: '13px', color: '#92400e', margin: 0, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '8px', padding: '10px 14px' }}>
                This run reported no steps at all. That is a statement about instrumentation, not about
                the run: the parallel and pre-search add pools emit no per-item rows (MEAL-122, on for
                HEB, Walmart, Amazon Fresh and Albertsons), and Kroger adds through the public API
                without running the WebView engine. The run above is real —{' '}
                {trace.run.items_added ?? '—'} of {trace.run.items_requested ?? '—'} items added — there
                is simply nothing recorded about how it got there.
              </p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '860px' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: '#888', fontSize: '12px' }}>
                      <th style={TH} title="Client-assigned and unique per run; a gap means rows are missing">seq</th>
                      <th style={TH}>Step</th>
                      <th style={TH}>Outcome</th>
                      <th style={TH}>Code</th>
                      <th style={TH} title="Which item of the basket, when the step is per-item">Item</th>
                      <th style={TH}>Duration</th>
                      <th style={TH}>When</th>
                      <th style={TH}>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trace.steps.map((s) => {
                      const detail = s.detail ? JSON.stringify(s.detail) : '';
                      const isFirstBad = first?.kind === 'failed' && first.seq === s.seq;
                      return (
                        <tr key={s.seq} style={{ borderTop: '1px solid #f5f5f5', background: isFirstBad ? '#fff8f8' : undefined }}>
                          <td style={{ ...TD, color: '#999', fontFamily: MONO }}>{s.seq}</td>
                          <td style={{ ...TD, fontWeight: 600 }}>{s.step}</td>
                          <td style={{ ...TD, color: outcomeColor(s) }}>{s.outcome}</td>
                          <td style={{ ...TD, color: '#666' }}>{s.code ?? '—'}</td>
                          <td style={{ ...TD, color: '#666' }}>{s.item_index ?? '—'}</td>
                          <td style={{ ...TD, color: '#666' }}>{ms(s.duration_ms)}</td>
                          <td style={{ ...TD, color: '#999', whiteSpace: 'nowrap' }}>{when(s.occurred_at)}</td>
                          <td style={{ ...TD, color: '#666', fontFamily: MONO, fontSize: '11px', maxWidth: '320px' }}>
                            {detail ? <span title={detail}>{detail.length > 140 ? `${detail.slice(0, 140)}…` : detail}</span> : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
