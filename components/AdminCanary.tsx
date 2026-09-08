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
  out_of_stock_item: string | null;
  unmatched_item: string | null;
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
  const [draft, setDraft] = useState<Record<string, { oos: string; un: string }>>({});
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
      const next: Record<string, { oos: string; un: string }> = {};
      for (const p of d.plans ?? []) next[p.store_id] = { oos: p.out_of_stock_item ?? '', un: p.unmatched_item ?? '' };
      setDraft(next);
    } catch { setErr('Failed to load'); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const save = async (storeId: string) => {
    setSaving(storeId); setErr(null);
    try {
      const d = draft[storeId] ?? { oos: '', un: '' };
      const res = await fetch('/api/admin/canary', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ storeId, outOfStockItem: d.oos, unmatchedItem: d.un }),
      });
      if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? `Save failed (${res.status})`); return; }
      await load();
    } finally { setSaving(null); }
  };

  const latest = (storeId: string) => runs.find((r) => r.store_id === storeId);
  const input: React.CSSProperties = {
    border: '1px solid #e0e0e0', borderRadius: '6px', padding: '6px 9px',
    fontSize: '13px', width: '100%', boxSizing: 'border-box',
  };

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
            const d = draft[sid] ?? { oos: '', un: '' };
            const last = latest(sid);
            const skipped = [!d.oos.trim() && 'out of stock', !d.un.trim() && 'no good match'].filter(Boolean);
            return (
              <div key={sid} style={{ borderTop: '1px solid #f0f0f0', padding: '14px 0' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '8px' }}>
                  <strong style={{ fontSize: '14px' }}>{sid}</strong>
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

                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 240px' }}>
                    <label style={{ fontSize: '11px', color: '#666' }}>Out-of-stock item</label>
                    <input
                      style={input}
                      value={d.oos}
                      placeholder="leave empty to skip this branch"
                      onChange={(e) => setDraft({ ...draft, [sid]: { ...d, oos: e.target.value } })}
                    />
                  </div>
                  <div style={{ flex: '1 1 240px' }}>
                    <label style={{ fontSize: '11px', color: '#666' }}>Item with no good match</label>
                    <input
                      style={input}
                      value={d.un}
                      placeholder="leave empty to skip this branch"
                      onChange={(e) => setDraft({ ...draft, [sid]: { ...d, un: e.target.value } })}
                    />
                  </div>
                  <button
                    onClick={() => save(sid)}
                    disabled={saving === sid}
                    style={{
                      alignSelf: 'flex-end', border: '1px solid #dd0031', background: '#fff1f3',
                      color: '#dd0031', borderRadius: '6px', padding: '7px 14px',
                      fontSize: '13px', cursor: 'pointer', fontWeight: 600,
                    }}
                  >
                    {saving === sid ? 'saving…' : 'Save'}
                  </button>
                </div>

                {skipped.length > 0 && (
                  <div style={{ fontSize: '11px', color: '#9aa0a6', marginTop: '6px' }}>
                    Skipping: {skipped.join(', ')}. Those branches are not being tested.
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
