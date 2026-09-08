'use client';

// MEAL-219 phase 4. The automation tab's network half.
//
// The existing funnel answers a DOM-era question over a DOM-era vocabulary. This
// answers the question the rail can actually be asked: what is the store saying,
// where do runs die, and how hard is the retry policy working.
//
// The design rule here is one thing: NEVER IMPLY HEALTH FROM ABSENT DATA. Every
// row written before MEAL-219 shipped carries null for these columns, so a
// coverage line sits above the numbers and a store with no status rows says so
// instead of showing a reassuring 0%.

import { useEffect, useState } from 'react';
import type { NetworkStoreStats } from '@/lib/automation-network-stats';

interface Payload {
  days: number;
  rowsScanned: number;
  truncated: boolean;
  coverage: { rowsWithStatus: number; rowsWithPhase: number; rowsWithAttempts: number };
  stores: NetworkStoreStats[];
  headlines: string[];
}

/** The walls, which get colour. A spike here is a campaign, not a bug. */
const WALL = new Set(['403', '429', '412', '418']);

function statusColour(label: string): string {
  if (WALL.has(label)) return '#dd0031';
  if (label === '5xx') return '#e8710a';
  if (label === '401') return '#8b5cf6';
  if (label === '2xx') return '#0f9d58';
  return '#9aa0a6';
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export default function AdminNetworkStats({ token }: { token: () => string | null }) {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (d = days) => {
    setLoading(true); setErr(null);
    try {
      const res = await fetch(`/api/admin/automation-network?days=${d}`, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      if (!res.ok) { setErr(`Failed to load (${res.status})`); return; }
      setData(await res.json());
    } catch {
      setErr('Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(days); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const card: React.CSSProperties = {
    background: 'white', borderRadius: '12px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden',
  };

  return (
    <div style={card}>
      <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Network rail</h2>
        <div style={{ display: 'flex', gap: '6px' }}>
          {[1, 7, 30].map((d) => (
            <button
              key={d}
              onClick={() => { setDays(d); void load(d); }}
              style={{
                border: '1px solid ' + (days === d ? '#dd0031' : '#e0e0e0'),
                background: days === d ? '#fff1f3' : 'white',
                color: days === d ? '#dd0031' : '#666',
                borderRadius: '6px', padding: '4px 12px', fontSize: '13px',
                cursor: 'pointer', fontWeight: days === d ? 600 : 400,
              }}
            >
              {d}d
            </button>
          ))}
        </div>
        {loading && <span style={{ fontSize: '13px', color: '#999' }}>loading…</span>}
        {err && <span style={{ fontSize: '13px', color: '#dd0031' }}>{err}</span>}
      </div>

      {data && (
        <div style={{ padding: '16px 24px 24px' }}>
          {/* COVERAGE FIRST. Every rate below is computed over the rows that can
              answer, and before MEAL-219 shipped none of them could. Reading a
              retry rate without knowing this is reading a number about a
              different window. */}
          <div style={{ fontSize: '12px', color: '#666', marginBottom: '18px', lineHeight: 1.6 }}>
            {data.rowsScanned.toLocaleString()} step rows in {data.days}d
            {data.truncated && <strong style={{ color: '#e8710a' }}> · truncated, showing the most recent</strong>}
            <br />
            carrying a status: <strong>{data.coverage.rowsWithStatus.toLocaleString()}</strong>
            {' · '}a phase: <strong>{data.coverage.rowsWithPhase.toLocaleString()}</strong>
            {' · '}attempts: <strong>{data.coverage.rowsWithAttempts.toLocaleString()}</strong>
            {data.coverage.rowsWithStatus < data.rowsScanned && (
              <span>. The rest predate the network columns and are excluded from the rates, not counted as clean.</span>
            )}
          </div>

          {data.stores.length === 0 && (
            <div style={{ fontSize: '13px', color: '#999' }}>No steps in this window.</div>
          )}

          {data.stores.map((s) => (
            <div key={s.storeId} style={{ borderTop: '1px solid #f0f0f0', padding: '16px 0' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
                <strong style={{ fontSize: '14px' }}>{s.storeId}</strong>
                <span style={{ fontSize: '12px', color: '#999' }}>{s.rows.toLocaleString()} rows</span>
                {s.rails.length > 0 && (
                  <span style={{ fontSize: '11px', color: '#9aa0a6' }}>{s.rails.join(', ')}</span>
                )}
              </div>

              {s.rows === s.rowsWithoutStatus ? (
                <div style={{ fontSize: '12px', color: '#999', marginTop: '8px' }}>
                  No rows carry a status yet: nothing to report rather than nothing wrong.
                </div>
              ) : (
                <>
                  {/* Status histogram */}
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px' }}>
                    {s.statuses.map((b) => (
                      <span
                        key={b.label}
                        style={{
                          fontSize: '12px', padding: '3px 9px', borderRadius: '999px',
                          background: statusColour(b.label) + '18',
                          color: statusColour(b.label),
                          fontWeight: WALL.has(b.label) || b.label === '5xx' ? 700 : 500,
                        }}
                      >
                        {b.label} · {b.count}
                      </span>
                    ))}
                  </div>

                  {/* Phase funnel, in the order a run walks it */}
                  <div style={{ display: 'flex', gap: '14px', marginTop: '12px', flexWrap: 'wrap' }}>
                    {s.phases.map((p) => (
                      <div key={p.phase} style={{ fontSize: '12px', minWidth: '96px' }}>
                        <div style={{ color: '#666', fontWeight: 600 }}>{p.phase}</div>
                        <div style={{ color: p.failed > 0 ? '#dd0031' : '#0f9d58' }}>
                          {p.ok} ok{p.failed > 0 ? ` · ${p.failed} failed` : ''}
                        </div>
                        {p.topCode && (
                          <div style={{ color: '#9aa0a6', fontSize: '11px' }}>{p.topCode}</div>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Retry pressure */}
                  <div style={{ fontSize: '12px', color: '#666', marginTop: '10px' }}>
                    {s.retried > 0 ? (
                      <>retried <strong>{pct(s.retryRate)}</strong> of answerable rows
                        {' · '}<strong>{pct(s.retrySuccessRate)}</strong> of those recovered
                        {' '}<span style={{ color: '#9aa0a6' }}>({s.retriedOk}/{s.retried})</span></>
                    ) : (
                      <span style={{ color: '#9aa0a6' }}>no retries recorded</span>
                    )}
                  </div>

                  {/* Legacy, in its own line so a 2026-08 selector_miss is never
                      read as a live problem. */}
                  {s.legacyCodeRows > 0 && (
                    <div style={{ fontSize: '11px', color: '#9aa0a6', marginTop: '6px' }}>
                      {s.legacyCodeRows} row{s.legacyCodeRows === 1 ? '' : 's'} carrying pre-network codes
                      (selector_miss / nav_failed) from before 2026-09-01, not live failures.
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
