'use client';

// MEAL-7. The canary's panel: two text boxes per store, and what happened.
//
// WHY ONLY TWO BOXES. A canary meal walks five branches, and three of them need
// no curation -- a plain add, something sold by weight, and something nothing on
// earth matches. Only two depend on a particular store's shelves: an item that
// is genuinely out of stock, and one that returns candidates none of which
// should match. Those go stale as shelves change, which is exactly why they are
// typed here rather than deployed.
//
// AN EMPTY BOX SKIPS THAT BRANCH, and the panel says so rather than leaving
// someone to wonder. A branch we are honestly not testing beats one we are
// pretending to.

import { useEffect, useState } from 'react';

interface Plan {
  store_id: string;
  meal_name: string;
  enabled: boolean;
}
interface Run {
  id: string;
  store_id: string;
  started_at: string;
  ran: boolean;
  skip_reason: string | null;
  passed: boolean | null;
  shape: string;
  lines: Array<{ item: string; status: string; expected: string; actual: string }> | null;
}

export default function AdminCanary({ token, storeIds }: { token: () => string | null; storeIds: string[] }) {
  const [migrated, setMigrated] = useState(true);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [draft, setDraft] = useState<Record<string, { on: boolean }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch('/api/admin/canary', { headers: { Authorization: `Bearer ${token()}` } });
      if (!res.ok) { setErr(`Failed to load (${res.status})`); return; }
      const d = await res.json();
      setMigrated(d.migrated !== false);
      setPlans(d.plans ?? []);
      setRuns(d.runs ?? []);
      const next: Record<string, { on: boolean }> = {};
      for (const p of d.plans ?? []) {
        next[p.store_id] = { on: p.enabled !== false };
      }
      setDraft(next);
    } catch { setErr('Failed to load'); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const save = async (storeId: string, override?: { on: boolean }) => {
    setSaving(storeId); setErr(null);
    try {
      const d = override ?? draft[storeId] ?? { on: true };
      const res = await fetch('/api/admin/canary', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ storeId, enabled: d.on }),
      });
      if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? `Save failed (${res.status})`); return; }
      await load();
    } finally { setSaving(null); }
  };

  const latest = (storeId: string) => runs.find((r) => r.store_id === storeId);

  return (
    <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
      <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0' }}>
        <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Nightly canary</h2>
        <p style={{ margin: '6px 0 0', fontSize: '12px', color: '#666', lineHeight: 1.6 }}>
          Three lines run everywhere and need nothing from you: a plain add, something sold by
          weight, and something nothing matches. The two below depend on a particular store&apos;s
          shelves, so they are typed rather than deployed.{' '}
          <strong>Leave a box empty and that branch is skipped</strong> rather than guessed at.
        </p>
        {err && <div style={{ marginTop: '8px', fontSize: '13px', color: '#dd0031' }}>{err}</div>}
      </div>

      {!migrated && (
        <div style={{ padding: '16px 24px', fontSize: '13px', color: '#e8710a' }}>
          The canary tables do not exist yet. Run <code>supabase/RUN-NOW-canary.sql</code>.
        </div>
      )}

      {migrated && (
        <div style={{ padding: '8px 24px 24px' }}>
          {storeIds.map((sid) => {
            const d = draft[sid] ?? { on: true };
            const last = latest(sid);
            return (
              <div key={sid} style={{ borderTop: '1px solid #f0f0f0', padding: '14px 0' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '8px' }}>
                  {/* OFF means the canary SKIPS this store entirely -- distinct from
                      an empty text box, which skips one branch. A store being
                      turned off is a decision; a branch being uncurated is a gap. */}
                  <button
                    onClick={() => { const n = { ...draft, [sid]: { ...d, on: !d.on } }; setDraft(n); void save(sid, n[sid]); }}
                    title={d.on ? 'Canary runs this store' : 'Canary skips this store'}
                    style={{
                      border: '1px solid ' + (d.on ? '#0f9d58' : '#d0d0d0'),
                      background: d.on ? '#0f9d58' : '#f2f2f2',
                      color: d.on ? 'white' : '#999',
                      borderRadius: '999px', padding: '2px 10px', fontSize: '11px',
                      cursor: 'pointer', fontWeight: 700, minWidth: '46px',
                    }}
                  >
                    {d.on ? 'ON' : 'OFF'}
                  </button>
                  <strong style={{ fontSize: '14px', opacity: d.on ? 1 : 0.5 }}>{sid}</strong>
                  {last ? (
                    <span style={{
                      fontSize: '12px',
                      color: !last.ran ? '#9aa0a6' : last.passed ? '#0f9d58' : '#dd0031',
                      fontWeight: 600,
                    }}>
                      {!last.ran ? `did not run: ${last.skip_reason ?? 'unknown'}` : last.passed ? 'passed' : 'FAILED'}
                      <span style={{ color: '#9aa0a6', fontWeight: 400 }}>
                        {' '}· {new Date(last.started_at).toLocaleString()}
                      </span>
                    </span>
                  ) : (
                    <span style={{ fontSize: '12px', color: '#9aa0a6' }}>never run</span>
                  )}
                </div>

                {/* THE ITEM BOXES ARE GONE (2026-09-09). Stephen: "lets remove the
                    canary text boxes from the admin health dashboard. Instead, I
                    will add out of stock and no match to the saved meals myself."

                    They were a second place to say what a canary meal contains,
                    and the meal is the first. Curating a branch here meant the
                    saved meal and this panel could disagree about what was being
                    tested, with the panel winning silently. An out-of-stock line
                    and a line with no good match are ingredients; they belong in
                    the meal alongside the ones that do match. */}

                {!d.on && (
                  <div style={{ fontSize: '11px', color: '#9aa0a6', marginTop: '6px' }}>
                    Off. The canary skips this store entirely, and its last result stays
                    above rather than going stale silently.
                  </div>
                )}


                {last?.lines && last.lines.length > 0 && (
                  <div style={{ marginTop: '8px', fontSize: '12px' }}>
                    {last.lines.map((l) => (
                      <div key={l.item} style={{ color: l.status === 'as_predicted' ? '#666' : '#dd0031' }}>
                        {l.status === 'as_predicted' ? '✓' : '✗'} {l.item}
                        <span style={{ color: '#9aa0a6' }}> · expected {l.expected}, got {l.actual}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
