'use client';

/**
 * MEAL-222. What imports have cost, and the token shape behind the estimate.
 *
 * TWO NUMBERS MATTER HERE AND ONLY ONE IS MONEY. The spend split by creator vs
 * user is what Stephen asked for. The MEDIAN TOKENS beside it are what makes
 * `TYPICAL_IMPORT_TOKENS` checkable: it was measured when extraction ran on
 * Opus with adaptive thinking, extraction is Haiku now with thinking off, and
 * nobody re-measured the shape. Pricing follows the model automatically; those
 * counts do not, so they are the one figure in the import estimate that can be
 * silently wrong.
 *
 * Rejections are counted as imports on purpose. A run the gate refused still
 * cost money, and a panel that showed only successes would understate the month
 * by exactly the amount that had nothing to show for it.
 */

import { useEffect, useState } from 'react';

interface Bucket {
  imports: number;
  rejected: number;
  cached: number;
  costUsd: number;
  gateCostUsd: number;
  extractCostUsd: number;
  medianTokens: {
    gateInput: number | null;
    gateOutput: number | null;
    extractInput: number | null;
    extractOutput: number | null;
  };
}

interface SpendResponse {
  days: number;
  truncated: boolean;
  rowsScanned: number;
  total: Bucket;
  byActor: Record<string, Bucket>;
}

const WINDOWS = [7, 30, 90] as const;

const TH: React.CSSProperties = { padding: '6px 8px', textAlign: 'left', fontWeight: 600, color: '#666' };
const TD: React.CSSProperties = { padding: '6px 8px', color: '#333' };

/** Four decimal places, because a single import costs about $0.015. */
const usd = (n: number) => `$${n.toFixed(4)}`;
const tok = (n: number | null) => (n == null ? '—' : n.toLocaleString());

export default function AdminImportSpend({ token }: { token: string }) {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<SpendResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (window: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/import-spend?days=${window}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => null);
      if (res.ok) setData(body);
      // A 409 means the migration has not been run. That is specific and
      // fixable, and the message names the file, so it is shown as written
      // rather than flattened into "something broke".
      else setError(body?.error ?? 'Failed to read import spend');
    } catch {
      setError('Failed to read import spend');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(days); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [days]);

  const actors = data ? Object.entries(data.byActor) : [];

  return (
    <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', padding: '20px 24px', marginTop: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#222' }}>Import spend</h2>
        <div style={{ display: 'flex', gap: '6px' }}>
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setDays(w)}
              style={{
                padding: '4px 10px', fontSize: '12px', borderRadius: '6px', cursor: 'pointer',
                border: '1px solid ' + (days === w ? '#dd0031' : '#ddd'),
                background: days === w ? '#dd0031' : 'white',
                color: days === w ? 'white' : '#555',
              }}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      <p style={{ margin: '4px 0 14px', fontSize: '12px', color: '#888' }}>
        Every import ATTEMPT, creator and user. A rejection cost money too and is counted here.
      </p>

      {error && (
        <div style={{ padding: '12px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', fontSize: '13px', color: '#b91c1c' }}>
          {error}
        </div>
      )}

      {!error && loading && !data && (
        <p style={{ fontSize: '13px', color: '#888' }}>Reading…</p>
      )}

      {!error && data && data.total.imports === 0 && (
        <p style={{ fontSize: '13px', color: '#888' }} data-testid="import-spend-empty">
          No imports in this window. Nothing has been spent, which is not the same as nothing
          having been measured.
        </p>
      )}

      {!error && data && data.total.imports > 0 && (
        <>
          {data.truncated && (
            <p style={{ fontSize: '12px', color: '#92400e', marginTop: 0 }}>
              Showing a partial window: the row cap was hit, so every number below is a floor.
            </p>
          )}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #eee' }}>
                  <th style={TH}>Who</th>
                  <th style={TH}>Imports</th>
                  <th style={TH} title="Counted in Imports. They cost money.">Rejected</th>
                  <th style={TH} title="Answered from cache: no call, no money.">Cached</th>
                  <th style={TH}>Gate</th>
                  <th style={TH}>Extract</th>
                  <th style={TH}>Total</th>
                  <th style={TH} title="Median over the rows that actually paid. Not a mean: one enormous page tells you nothing about the next import.">
                    Median tokens (gate in/out · extract in/out)
                  </th>
                </tr>
              </thead>
              <tbody>
                {actors.map(([actor, b]) => (
                  <tr key={actor} style={{ borderBottom: '1px solid #f6f6f6' }} data-testid={`spend-row-${actor}`}>
                    <td style={{ ...TD, fontWeight: 600 }}>{actor}</td>
                    <td style={TD}>{b.imports}</td>
                    <td style={TD}>{b.rejected}</td>
                    <td style={TD}>{b.cached}</td>
                    <td style={TD}>{usd(b.gateCostUsd)}</td>
                    <td style={TD}>{usd(b.extractCostUsd)}</td>
                    <td style={{ ...TD, fontWeight: 600 }}>{usd(b.costUsd)}</td>
                    <td style={{ ...TD, color: '#666' }}>
                      {tok(b.medianTokens.gateInput)}/{tok(b.medianTokens.gateOutput)}
                      {' · '}
                      {tok(b.medianTokens.extractInput)}/{tok(b.medianTokens.extractOutput)}
                    </td>
                  </tr>
                ))}
                <tr style={{ borderTop: '2px solid #eee' }} data-testid="spend-row-total">
                  <td style={{ ...TD, fontWeight: 700 }}>All</td>
                  <td style={{ ...TD, fontWeight: 700 }}>{data.total.imports}</td>
                  <td style={TD}>{data.total.rejected}</td>
                  <td style={TD}>{data.total.cached}</td>
                  <td style={TD}>{usd(data.total.gateCostUsd)}</td>
                  <td style={TD}>{usd(data.total.extractCostUsd)}</td>
                  <td style={{ ...TD, fontWeight: 700 }}>{usd(data.total.costUsd)}</td>
                  <td style={{ ...TD, color: '#666' }}>
                    {tok(data.total.medianTokens.gateInput)}/{tok(data.total.medianTokens.gateOutput)}
                    {' · '}
                    {tok(data.total.medianTokens.extractInput)}/{tok(data.total.medianTokens.extractOutput)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p style={{ margin: '12px 0 0', fontSize: '11px', color: '#888' }}>
            Compare the median row against TYPICAL_IMPORT_TOKENS in lib/import/cost.ts. That
            estimate was measured on Opus with thinking on; extraction is Haiku with thinking off,
            so the shape has never been re-checked against real rows.
          </p>
        </>
      )}
    </div>
  );
}
