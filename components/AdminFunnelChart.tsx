'use client';

// Presentation for the automation funnel's two non-tabular pieces: the daily
// trend line and the failure-code chips. Split out of app/admin/page.tsx so both
// can be rendered in a test — the rules they encode ("a day with no runs is a
// gap, not a zero"; "uncoded is a real bucket, not an absence") are exactly the
// kind that get quietly undone by a later styling pass.

/** One UTC day of a store's history, as the funnel endpoint returns it. */
export interface DayPoint {
  day: string;
  runs: number;
  runsSucceeded: number;
  terminalSuccessRate: number | null;
  blocked: number;
  failures: number;
}

/**
 * Single-series trend of a RATE over the window: fixed 0–100% y-domain, one hue,
 * 2px line, recessive reference lines, last value direct-labeled. One series, so
 * no legend — the caption above it names the measure.
 *
 * Days with no runs are a GAP, not a zero. The line breaks across them and an
 * isolated day is drawn as a dot, because interpolating through a day nobody
 * shopped invents a number — and a run of zeros along the floor of the chart
 * reads as a total outage, which is the opposite of "nothing happened".
 */
export function TrendSparkline({
  daily,
  width = 300,
  height = 56,
}: {
  daily: DayPoint[];
  width?: number;
  height?: number;
}) {
  const padY = 6;
  const plotted = daily.filter((d) => d.terminalSuccessRate != null);
  if (daily.length < 2 || plotted.length === 0) {
    return <div style={{ fontSize: '12px', color: '#aaa' }}>No daily history in this window.</div>;
  }

  const x = (i: number) => (daily.length === 1 ? 0 : (i / (daily.length - 1)) * (width - 1));
  const y = (v: number) => padY + (1 - v) * (height - padY * 2);

  // Contiguous runs of days that actually have a rate.
  const segments: { i: number; d: DayPoint }[][] = [];
  let current: { i: number; d: DayPoint }[] = [];
  daily.forEach((d, i) => {
    if (d.terminalSuccessRate == null) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    current.push({ i, d });
  });
  if (current.length) segments.push(current);

  const last = plotted[plotted.length - 1];

  return (
    <svg width={width} height={height + 14} role="img" aria-label="Daily terminal success rate">
      {/* Recessive reference lines at 0%, 50%, 100%. */}
      {[0, 0.5, 1].map((v) => (
        <line key={v} x1={0} x2={width} y1={y(v)} y2={y(v)} stroke="#f0f0f0" strokeWidth={1} />
      ))}
      {segments.map((seg, si) =>
        seg.length === 1 ? (
          <circle key={si} cx={x(seg[0].i)} cy={y(seg[0].d.terminalSuccessRate!)} r={2.5} fill="#dd0031" />
        ) : (
          <polyline
            key={si}
            fill="none"
            stroke="#dd0031"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            points={seg.map((p) => `${x(p.i)},${y(p.d.terminalSuccessRate!)}`).join(' ')}
          />
        ),
      )}
      {/* Hover layer: one wide invisible target per day, so a point's value is
          readable without pulling in a charting library. */}
      {daily.map((d, i) => (
        <rect
          key={d.day}
          x={x(i) - width / daily.length / 2}
          y={0}
          width={width / daily.length}
          height={height}
          fill="transparent"
        >
          <title>
            {`${d.day}: ${
              d.terminalSuccessRate == null
                ? 'no runs'
                : `${(d.terminalSuccessRate * 100).toFixed(0)}% of ${d.runs} run${d.runs === 1 ? '' : 's'}`
            }${d.blocked > 0 ? ` · ${d.blocked} blocked` : ''}`}
          </title>
        </rect>
      ))}
      <text x={0} y={height + 11} fontSize={10} fill="#aaa">
        {daily[0].day.slice(5)}
      </text>
      <text x={width} y={height + 11} fontSize={10} fill="#aaa" textAnchor="end">
        {`${daily[daily.length - 1].day.slice(5)} · last ${(last.terminalSuccessRate! * 100).toFixed(0)}%`}
      </text>
    </svg>
  );
}

/**
 * Failure codes as counted chips, biggest first.
 *
 * `uncoded` is rendered in muted ink and spelled out: those failures predate
 * MEAL-4's taxonomy, and no backfill can give them one (step rows upsert with
 * ignoreDuplicates, so an old row never gains a code). Leaving them out would
 * read as "no unexplained failures", the reverse of the truth.
 */
export function CodeChips({ codes, empty = '—' }: { codes: Record<string, number>; empty?: string }) {
  const entries = Object.entries(codes).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <span style={{ color: '#aaa' }}>{empty}</span>;
  return (
    <span style={{ display: 'inline-flex', gap: '6px', flexWrap: 'wrap' }}>
      {entries.map(([code, count]) => {
        const uncoded = code === 'uncoded';
        return (
          <span
            key={code}
            title={
              uncoded
                ? 'Failures with no code — recorded before the taxonomy shipped, or from a client that does not send one.'
                : undefined
            }
            style={{
              background: uncoded ? '#f6f6f6' : '#fff1f3',
              color: uncoded ? '#999' : '#b91c1c',
              border: '1px solid ' + (uncoded ? '#ececec' : '#fecaca'),
              borderRadius: '999px',
              padding: '1px 8px',
              fontSize: '11px',
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >
            {uncoded ? 'uncoded' : code} {count}
          </span>
        );
      })}
    </span>
  );
}
