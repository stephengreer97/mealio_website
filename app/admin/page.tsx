'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  describeSourceHealth,
  PLATFORM_SOURCES,
  SOURCE_COLUMNS,
  SOURCE_LABELS,
  summariseCreatorViability,
  type PlatformSource,
  type PrimarySource,
  type ViabilityOutcome,
} from '@/lib/creator-sources';
// Type-only: `lib/import/viability` reaches undici and must never be bundled
// into the client. The import is erased at compile time.
import type { ViabilityReport } from '@/lib/import/viability';
import { pollConcern, pollStatus, type CreatorPollHealth, type PollStatusKind } from '@/lib/poll-health';
import { daysSince, relativeTime } from '@/lib/relative-time';
import AdminSyncPanel from '@/components/AdminSyncPanel';
import AdminReviewQueue from '@/components/AdminReviewQueue';
import { TrendSparkline, CodeChips, DayPoint } from '@/components/AdminFunnelChart';
// The per-run drilldown (MEAL-143). Its own component and its own fetches: the
// funnel is a set of rates over a window and this is one run's rows, so nothing is
// shared but the store list the picker offers.
import AdminRunDrilldown from '@/components/AdminRunDrilldown';
// Pure, no server imports: the "which step is this store dying on" verdict lives
// in the same module as the aggregation it reads, and is unit-tested there.
import {
  DEFAULT_BLOCKED_RATE_THRESHOLD,
  DEFAULT_CONFIRM_RATE_THRESHOLD,
  DEFAULT_ITEM_SUCCESS_DROP_THRESHOLD,
  worstStep,
  type AlertReason,
} from '@/lib/automation-funnel';

type Tab = 'applications' | 'sources' | 'sync' | 'review' | 'meals' | 'stats' | 'broadcast' | 'storage' | 'email' | 'automation';

// Store options for broadcast targeting (id → label).
const BROADCAST_STORE_OPTIONS: { id: string; label: string }[] = [
  { id: 'heb', label: 'H-E-B' }, { id: 'walmart', label: 'Walmart' }, { id: 'kroger', label: 'Kroger' },
  { id: 'aldi', label: 'ALDI' }, { id: 'albertsons', label: 'Albertsons' }, { id: 'amazon', label: 'Amazon Fresh' },
  { id: 'safeway', label: 'Safeway' }, { id: 'vons', label: 'Vons' }, { id: 'jewel_osco', label: 'Jewel-Osco' },
  { id: 'shaws', label: "Shaw's" }, { id: 'acme', label: 'Acme Markets' }, { id: 'tom_thumb', label: 'Tom Thumb' },
  { id: 'randalls', label: 'Randalls' }, { id: 'pavilions', label: 'Pavilions' }, { id: 'star_market', label: 'Star Market' },
  { id: 'haggen', label: 'Haggen' }, { id: 'carrs', label: 'Carrs' }, { id: 'kings', label: 'Kings Food Markets' },
  { id: 'balduccis', label: "Balducci's" }, { id: 'ralphs', label: 'Ralphs' }, { id: 'fred_meyer', label: 'Fred Meyer' },
  { id: 'king_soopers', label: 'King Soopers' }, { id: 'smiths', label: "Smith's Food & Drug" }, { id: 'frys', label: "Fry's Food" },
  { id: 'qfc', label: 'QFC' }, { id: 'city_market', label: 'City Market' }, { id: 'dillons', label: 'Dillons' },
  { id: 'bakers', label: "Baker's" }, { id: 'marianos', label: "Mariano's" }, { id: 'pick_n_save', label: "Pick 'n Save" },
  { id: 'metro_market', label: 'Metro Market' }, { id: 'pay_less', label: 'Pay-Less' }, { id: 'harris_teeter', label: 'Harris Teeter' },
  { id: 'united', label: 'United Supermarkets' }, { id: 'wegmans', label: 'Wegmans' },
];

// Per-store add-to-cart reliability funnel (GET /api/admin/automation-funnel).
// Rates are null when there is no denominator — rendered as "—" rather than 0%,
// because "no data" and "everything failed" must not look the same.
interface StepStats {
  step: string;
  total: number;
  outcomes: Record<string, number>;
  /** WAF/robot walls. Held out of `attempted`, so they never read as drift. */
  blocked: number;
  attempted: number;
  okRate: number | null;
  failures: number;
  /** MEAL-4 failure codes; `uncoded` is the pre-taxonomy bucket, not zero. */
  codes: Record<string, number>;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
}

interface WindowSummary {
  runs: number;
  runsSucceeded: number;
  runsUnverified: number;
  terminalSuccessRate: number | null;
  blocked: number;
  failures: number;
}

interface WeekOverWeek {
  current: WindowSummary;
  previous: WindowSummary;
  terminalSuccessRateDelta: number | null;
  runsDelta: number;
}

interface FunnelCoverage {
  missingSteps: string[];
  partialInstrumentation: boolean;
  uncodedFailures: number;
}

/** The item rate now against this store's own trailing median (MEAL-6). */
interface ItemSuccessTrend {
  recent: number | null;
  recentItemsRequested: number;
  recentItemsUnavailable: number;
  /** The rate's real denominator: requested minus what the store did not have. */
  recentItemsJudged: number;
  median: number | null;
  baselineWindows: number;
  drop: number | null;
}

interface StoreFunnel {
  storeId: string;
  runs: number;
  runsSucceeded: number;
  /** Runs that finished without ever reading the cart — the coverage number. */
  runsUnverified: number;
  runsAbandoned: number;
  itemsRequested: number;
  itemsAdded: number;
  /** Requested items the store reported it did not have — out of the rate below. */
  itemsUnavailable: number;
  itemSuccessRate: number | null;
  /** The number `success_drop` fires on, so the page can show what the email said. */
  itemSuccess: ItemSuccessTrend;
  steps: StepStats[];
  confirmRate: number | null;
  firstClickConfirmRate: number | null;
  terminalSuccessRate: number | null;
  /** `runs` is distinct runs walled off; `rate` is those over runs, not steps. */
  blocked: { steps: number; runs: number; rate: number | null };
  failureCodes: Record<string, number>;
  runSummaryCodes: Record<string, number>;
  /** Share of RUNS walled off — a real percentage, so it cannot exceed 100%. */
  blockedRate: number | null;
  coverage: FunnelCoverage;
  daily: DayPoint[];
  weekOverWeek: WeekOverWeek | null;
  alerting: boolean;
  /** Why it is alerting. The badge and banners name the reason. */
  alertReasons: AlertReason[];
}

interface FunnelResponse {
  days: number;
  since: string;
  truncated: boolean;
  stepRowsScanned: number;
  runRowsScanned: number;
  stores: StoreFunnel[];
  alerting: string[];
  confirmRateAlerting: string[];
  successDropAlerting: string[];
  blockedAlerting: string[];
  partialInstrumentation: string[];
}

interface ConfigVersion {
  id: string;
  version: number;
  config: Record<string, unknown>;
  is_active: boolean;
  notes: string | null;
  created_at: string;
}

// A rate of null means "no denominator" — no runs, or no add clicks. Rendering it
// as "—" rather than 0% keeps "we have no data" visually distinct from "everything
// failed", which is the difference between ignoring a store and paging someone.
function pct(v: number | null): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}

function ms(v: number | null): string {
  if (v == null) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`;
}

/** A signed percentage-point change, or "—" when either side had no denominator. */
function delta(v: number | null): string {
  if (v == null) return '—';
  const pp = v * 100;
  if (Math.abs(pp) < 0.05) return 'no change';
  return `${pp > 0 ? '+' : '−'}${Math.abs(pp).toFixed(1)} pts`;
}

/**
 * The badge's word for each alert reason, and the sentence behind it.
 *
 * Keyed by `AlertReason`, so the compiler asks for an entry when the funnel
 * grows a reason. The conditions are independent — a store walled off at 90% can
 * have a flawless confirm rate, and one whose item rate has fallen away from its
 * own median can have both — so a badge that names the wrong one, or names none,
 * sends someone to a number that is fine.
 */
const ALERT_REASON_BADGE: Record<AlertReason, { tag: string; title: string }> = {
  confirm_rate: {
    tag: 'CONFIRM RATE',
    title: 'Confirm rate below threshold on a large enough sample.',
  },
  success_drop: {
    tag: 'SUCCESS DROP',
    title: `Item success is more than ${DEFAULT_ITEM_SUCCESS_DROP_THRESHOLD * 100} points below this store’s own trailing 7-day median.`,
  },
  blocked: {
    tag: 'BLOCKED',
    title: 'A large share of this store’s runs are being walled off by a WAF or robot wall.',
  },
};

function Metric({ label, value, bad, note }: { label: string; value: string; bad?: boolean; note?: string }) {
  return (
    <div>
      <div style={{ fontSize: '11px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: '20px', fontWeight: 700, color: bad ? '#b91c1c' : '#333' }}>{value}</div>
      {note && <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>{note}</div>}
    </div>
  );
}

interface Broadcast {
  id: string;
  message: string;
  stores: string[];
  forceShow: boolean;
  createdAt: string;
}

interface Application {
  id: string;
  display_name: string;
  phone: string | null;
  find_us: string | null;
  website_url: string | null;
  youtube_url: string | null;
  instagram_url: string | null;
  tiktok_url: string | null;
  status: string;
  created_at: string;
  user_profiles: { email: string } | null;
}

/** A creator row as the sources tab needs it (MEAL-81). */
interface CreatorSource {
  id: string;
  display_name: string;
  handle: string | null;
  website_url: string | null;
  youtube_url: string | null;
  instagram_url: string | null;
  tiktok_url: string | null;
  primary_source: PrimarySource;
  import_opt_in: boolean;
  feed_url: string | null;
  /**
   * Why polling is off, and since when — written whenever a creator's own link
   * edit paused it. The email that goes out at the same time is push-only; these
   * two columns are what answers the question later.
   */
  import_paused_reason?: string | null;
  import_paused_at?: string | null;
  /** OAuth grants, with `brokenReason` set when one has stopped working (MEAL-74). */
  connections?: Array<{ platform: string; externalName: string | null; brokenReason: string | null }>;
  /** Is polling working for this creator, and producing anything (MEAL-96). */
  pollHealth?: CreatorPollHealth | null;
}

const OUTCOME_STYLES: Record<ViabilityOutcome, { bg: string; fg: string; label: string }> = {
  viable:        { bg: '#e6f9ed', fg: '#1a7a3a', label: 'Viable' },
  partial:       { bg: '#fff8e1', fg: '#b45309', label: 'Partial' },
  'not-viable':  { bg: '#fff0f0', fg: '#c40029', label: 'Not viable here' },
  unsupported:   { bg: '#f3f4f6', fg: '#374151', label: 'Unsupported platform' },
  unavailable:   { bg: '#eef2ff', fg: '#3730a3', label: 'Could not check' },
};

const VERDICT_COLORS: Record<string, string> = {
  yes: '#16a34a', no: '#c40029', unsure: '#b45309', error: '#6b7280',
};

// ── Reads that came back short (MEAL-112 / MEAL-128) ─────────────────────────

/**
 * A figure, or an em dash when the API could not complete the read behind it.
 *
 * `?? 0` was the old habit and it is this whole class of bug in one
 * operator-facing character: a zero looks like an answer. A dash cannot be
 * mistaken for a number.
 */
const orDash = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : value.toLocaleString();

/** What each name an API puts in `incomplete` means to a human. */
const READ_LABELS: Record<string, string> = {
  creators:    'the creator list',
  connections: 'connected platform accounts',
  pollHealth:  'poll health for creators past the first 500',
  campaigns:   'the per-campaign funnel',
  totalSent:   'the total emails sent',
};

/**
 * Says that a screen is showing less than it was asked for.
 *
 * Above the numbers rather than under them, and loud, because the failure this
 * replaces was never a visible error: PostgREST truncates a read at 1000 rows
 * without saying so, so the screen rendered a plausible wrong answer and nobody
 * had a reason to disbelieve it. MEAL-112 was the worst shape of that — the Sources
 * tab reported every creator as having no source configured.
 */
function IncompleteBanner({ names, children }: { names: string[]; children?: React.ReactNode }) {
  if (names.length === 0) return null;
  return (
    <div
      data-testid="incomplete-banner"
      style={{ padding: '14px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', fontSize: '13px', color: '#b91c1c' }}
    >
      <strong>Incomplete data — this screen is showing less than it was asked for.</strong>{' '}
      These reads could not be completed: {names.map(n => READ_LABELS[n] ?? n).join(', ')}.{' '}
      {children ?? 'The affected figures are shown as “—” rather than as a number that would be understated.'}{' '}
      Retry, and if it persists check the server log.
    </div>
  );
}

// ── Poll health on the Sources tab (MEAL-96) ─────────────────────────────────

const POLL_STATUS_STYLES: Record<PollStatusKind, { label: string; fg: string; bg: string; accent: string }> = {
  failing:      { label: 'Source failing',    fg: '#c40029', bg: '#fdeaee', accent: '#dc2626' },
  silent:       { label: 'Producing nothing', fg: '#92400e', bg: '#fff8e1', accent: '#f59e0b' },
  wobbling:     { label: 'Recent failure',    fg: '#92400e', bg: '#fffbeb', accent: '#fcd34d' },
  ok:           { label: 'Polling healthily', fg: '#1a7a3a', bg: '#e6f9ed', accent: '#34d399' },
  unconfigured: { label: 'No source',         fg: '#6b7280', bg: '#f3f4f6', accent: '#e5e7eb' },
};

/**
 * The badge, beside the connection badges an operator is already scanning.
 *
 * Silent gets a number of days rather than "Producing nothing": a month and a
 * year both read as "producing nothing" and only one of them is an emergency.
 */
function PollStatusBadge({ health, now }: { health: CreatorPollHealth; now: number }) {
  const kind = pollStatus(health, now);
  // A creator nobody has set polling up for is not a state worth a badge — the
  // "Not polled" pill beside it already says everything true about them.
  if (kind === 'unconfigured') return null;

  const style = POLL_STATUS_STYLES[kind];
  const quiet = daysSince(health.lastNewItemAt, now);
  const label =
    kind === 'failing' ? `${style.label} · ${health.consecutiveFailures} in a row`
    : kind === 'silent' && quiet !== null ? `Producing nothing for ${quiet} days`
    : style.label;

  return (
    <span
      data-testid={`poll-status-${health.creatorId}`}
      data-poll-status={kind}
      style={{ fontSize: '12px', fontWeight: 600, borderRadius: '99px', padding: '2px 10px', color: style.fg, background: style.bg }}
    >
      {label}
    </span>
  );
}

/**
 * Who is broken, above the list, so it is answered before anyone scrolls.
 *
 * The counts a creator asking "why has nothing appeared?" would otherwise be the
 * first notification of.
 */
function PollHealthSummary({ creators, now }: { creators: CreatorSource[]; now: number }) {
  const tally: Record<PollStatusKind, number> = { failing: 0, silent: 0, wobbling: 0, ok: 0, unconfigured: 0 };
  // Creators the API returned no health for at all. Counting these as
  // `unconfigured` is exactly the MEAL-112 lie — "222 with no source" was the
  // sentence a 414 produced — so a missing answer is counted as missing.
  let unknown = 0;
  for (const creator of creators) {
    if (!creator.pollHealth) { unknown += 1; continue; }
    tally[pollStatus(creator.pollHealth, now)] += 1;
  }

  const parts: Array<[PollStatusKind, string]> = [
    ['failing', `${tally.failing} failing`],
    ['silent', `${tally.silent} producing nothing`],
    ['wobbling', `${tally.wobbling} with a recent failure`],
    ['ok', `${tally.ok} polling healthily`],
    ['unconfigured', `${tally.unconfigured} with no source`],
  ];

  return (
    <div
      data-testid="poll-health-summary"
      style={{
        background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
        padding: '14px 20px', display: 'flex', alignItems: 'center', gap: '10px 18px', flexWrap: 'wrap',
      }}
    >
      <strong style={{ fontSize: '13px', color: '#333' }}>Poll health</strong>
      {parts.filter(([kind]) => tally[kind] > 0).map(([kind, text]) => (
        <span key={kind} style={{ fontSize: '12px', fontWeight: 600, borderRadius: '99px', padding: '3px 12px', color: POLL_STATUS_STYLES[kind].fg, background: POLL_STATUS_STYLES[kind].bg }}>
          {text}
        </span>
      ))}
      {unknown > 0 && (
        <span
          data-testid="poll-health-unknown"
          style={{ fontSize: '12px', fontWeight: 600, borderRadius: '99px', padding: '3px 12px', color: '#b91c1c', background: '#fef2f2' }}
        >
          {unknown} not read
        </span>
      )}
      <span style={{ fontSize: '11px', color: '#aaa', marginLeft: 'auto' }}>Least healthy first</span>
    </div>
  );
}

/** The exact instant, for the `title` under a "4 days ago". */
function exactly(at: string | null): string | undefined {
  if (!at) return undefined;
  const t = Date.parse(at);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : undefined;
}

/**
 * How much of a remote server's prose ends up in the DOM.
 *
 * `last_error` is not written by us — it is whatever the source said, and an
 * HTML error page or a stack trace arrives as a single unbroken paragraph.
 * Rendered as text (never as HTML) and cut here, with the rest available on
 * hover, so one bad source cannot push the rest of the card off the screen.
 */
const ERROR_CHARS = 320;

function PollHealthPanel({ health, now }: { health: CreatorPollHealth; now: number }) {
  const kind = pollStatus(health, now);
  const style = POLL_STATUS_STYLES[kind];

  // Nothing is broken about a creator nobody has set polling up for, so they get
  // a grey sentence rather than a panel of empty columns and a "never polled"
  // that reads like a failure.
  if (kind === 'unconfigured' && !health.lastPolledAt && health.draftedCount === 0) {
    return (
      <p data-testid={`poll-health-${health.creatorId}`} style={{ margin: '4px 0 16px', fontSize: '12px', color: '#aaa' }}>
        No source is being polled for this creator — nothing here is broken, there is just nothing to report yet.
      </p>
    );
  }

  const lastNew = relativeTime(health.lastNewItemAt, now);
  const failed = health.consecutiveFailures;

  return (
    <div
      data-testid={`poll-health-${health.creatorId}`}
      style={{
        margin: '4px 0 16px', borderRadius: '10px', border: '1px solid #f0f0f0',
        borderLeft: `4px solid ${style.accent}`, padding: '14px 16px', background: '#fcfcfc',
      }}
    >
      {/* The one that matters, given the size of a headline rather than a slot
          in a row of timestamps: a source can poll successfully forever and
          yield nothing, and that reads as healthy on every other column. */}
      <div
        data-testid={`poll-last-new-${health.creatorId}`}
        style={{
          borderRadius: '8px', padding: '10px 12px', marginBottom: '12px',
          background: kind === 'silent' ? '#fff8e1' : '#f6f8fa',
        }}
      >
        <div style={{ fontSize: '11px', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Last poll that found a new post
        </div>
        <div
          title={exactly(health.lastNewItemAt)}
          style={{ fontSize: '19px', fontWeight: 700, color: kind === 'silent' ? '#92400e' : '#333', marginTop: '2px' }}
        >
          {lastNew ?? 'Nothing seen yet'}
        </div>
        <div style={{ fontSize: '11px', color: '#888', marginTop: '2px' }}>
          {health.lastNewItemAt
            ? kind === 'silent'
              ? 'Polling is fine and this source is producing nothing — the failure no other column shows.'
              : `First seen ${exactly(health.lastNewItemAt)}`
            : 'Polling has never met a post here. Normal for a source only just set up.'}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '18px 28px' }}>
        {/* Deliberately named "successful": this column does not advance on a
            failure, and an operator reading it as "last time the queue reached
            them" would take a broken source for a quiet one. */}
        <Figure
          label="Last successful poll"
          value={relativeTime(health.lastPolledAt, now) ?? 'Never'}
          title={exactly(health.lastPolledAt)}
          note="unchanged by a failed poll"
        />
        <Figure
          label="Next poll due"
          value={relativeTime(health.pollAfter, now) ?? 'As soon as the queue reaches it'}
          title={exactly(health.pollAfter)}
        />
        <div>
          <div style={{ fontSize: '11px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Failures in a row</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '3px' }}>
            <FailureDots count={failed} />
            <span style={{ fontSize: '15px', fontWeight: 700, color: failed === 0 ? '#1a7a3a' : failed >= 3 ? '#c40029' : '#b45309' }}>
              {failed === 0 ? 'None' : failed}
            </span>
          </div>
        </div>
        <Figure label="Drafted by polling" value={String(health.draftedCount)} note="lifetime" />
        <Figure label="Published from those" value={String(health.publishedCount)} note="lifetime" />
      </div>

      {(health.lastFailedAt || health.lastError) && (
        <div
          data-testid={`poll-last-failure-${health.creatorId}`}
          style={{
            marginTop: '12px', borderRadius: '8px', padding: '10px 12px',
            background: failed > 0 ? '#fff5f6' : '#fafafa',
          }}
        >
          <div style={{ fontSize: '12px', fontWeight: 600, color: failed > 0 ? '#c40029' : '#888' }}>
            Last failed poll {relativeTime(health.lastFailedAt, now) ?? 'at an unrecorded time'}
            {health.lastStatus ? ` · HTTP ${health.lastStatus}` : ''}
            {/* Kept visible after it recovers, greyed: "it failed on Tuesday and
                has been fine since" is a different story from "it is failing". */}
            {failed === 0 ? ' · polling has recovered since' : ''}
          </div>
          {health.lastError && (
            <p
              title={health.lastError}
              style={{
                margin: '4px 0 0', fontSize: '12px', lineHeight: 1.5, color: '#555',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                // The source's own words, and they arrive as one unbroken line
                // as often as not. Wrapped mid-word and capped in height so a
                // remote stack trace cannot take the card over.
                whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '5.5em', overflow: 'hidden',
              }}
            >
              {health.lastError.length > ERROR_CHARS ? `${health.lastError.slice(0, ERROR_CHARS)}…` : health.lastError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Figure({ label, value, title, note }: { label: string; value: string; title?: string; note?: string }) {
  return (
    <div>
      <div style={{ fontSize: '11px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div title={title} style={{ fontSize: '15px', fontWeight: 700, color: '#333', marginTop: '3px' }}>{value}</div>
      {note && <div style={{ fontSize: '10px', color: '#bbb' }}>{note}</div>}
    </div>
  );
}

/**
 * Consecutive failures as a shape before it is a number.
 *
 * One failure is weather and six is a broken source nobody has looked at, and
 * that difference should survive a glance down a column — a row of filled red
 * dots is legible at a distance a "6" is not.
 */
function FailureDots({ count }: { count: number }) {
  const filled = Math.min(count, 6);
  return (
    <span aria-hidden style={{ display: 'inline-flex', gap: '3px' }}>
      {Array.from({ length: 6 }, (_, i) => (
        <span
          key={i}
          style={{
            width: '7px', height: '7px', borderRadius: '99px',
            background: i < filled ? (count >= 3 ? '#dc2626' : '#f59e0b') : '#e8e8e8',
          }}
        />
      ))}
    </span>
  );
}

/**
 * Least healthy first — the operator's question is "who is broken", not "how is
 * everyone doing", and the API's order (newest creator first) answers neither.
 * Ties break on name so the list does not reshuffle between renders.
 */
function byConcernFirst(creators: CreatorSource[], now: number): CreatorSource[] {
  const concern = (c: CreatorSource) => (c.pollHealth ? pollConcern(c.pollHealth, now) : 0);
  return [...creators].sort((a, b) => concern(b) - concern(a) || a.display_name.localeCompare(b.display_name));
}

interface Meal {
  id: string;
  name: string;
  author: string;
  creator_name: string | null;
  difficulty: number | null;
  trending_score: number;
}

interface AvailableQuarter { year: number; q: number; label: string }

interface Stats {
  isCurrent: boolean;
  quarterLabel: string;
  availableQuarters: AvailableQuarter[];
  totals: {
    saves30d: number | null;
    savesQtr: number;
    savesAll: number | null;
    // Payout-relevant figures are `number | null`, and the null is not "zero yet":
    // it is the API saying the read behind this number could not be completed, so
    // any number here would be understated. Rendered as a dash, never as 0.
    totalCreatorAnnualSaves: number | null;
    signups30d: number | null;
    signupsQtr: number;
    signupsAll: number | null;
    subsStarted30d: number | null;
    subsStartedQtr: number | null;
    subsStartedAll: number | null;
    subsCancelled30d: number | null;
    subsCancelledQtr: number | null;
    subsCancelledAll: number | null;
    netNewPaid30d: number | null;
    netNewPaidQtr: number | null;
    netNewPaidAll: number | null;
  };
  /** Aggregates the API could not read in full — empty on a healthy response. */
  incomplete: string[];
  /** null when the creator-save read was short; [] genuinely means no saves. */
  leaderboard: {
    name: string;
    annualSaves: number;
    sharePercent: number;
  }[] | null;
}

/**
 * A figure, or an em dash when the API could not complete the read behind it.
 *
 * `?? 0` was the old habit and it is the whole MEAL-127 failure mode in one
 * operator-facing character: a zero looks like an answer, and payouts get read off
 * it. A dash cannot be mistaken for a number.
 */
const figure = (value: number | null) => (value === null ? '—' : value.toLocaleString());

/** Same, signed, for the net-new-paid tiles. */
const signedFigure = (value: number | null) =>
  value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toLocaleString()}`;

/** What each name in `stats.incomplete` means to a human. */
const INCOMPLETE_LABELS: Record<string, string> = {
  creatorSaves:       'creator saves (profit-share leaderboard)',
  subscriptionEvents: 'subscription events (net new paid)',
};

/**
 * What a bounded backfill reports back (MEAL-129).
 *
 * `complete` is the field that did not exist and had to: both of these routes
 * process an explicit batch, so "it returned 200" and "the job is done" are
 * different facts and the operator needs the second one.
 */
interface BackfillResult {
  total: number;
  processed: number;
  skipped: number;
  errors: number;
  /** Candidates found but not attempted this run. */
  remaining: number;
  /** False when another run is required. */
  complete: boolean;
  /** False when the scan hit its page bound, so `total` is a floor not a count. */
  scanComplete: boolean;
  batchLimit: number;
}

interface EmailCampaign {
  type: string;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  suppressed: number;
  error: number;
  openRate: number;
  clickRate: number;
}

interface EmailStats {
  /**
   * `null` when the row walk behind the funnel came back short.
   *
   * Not `[]`: an empty list means "no campaign has ever sent", which is a
   * different and equally actionable answer from "we could not read them". A
   * truncated read does not scale every campaign down uniformly either — it drops
   * whichever rows sat past the cut, so the open and click RATES are wrong too.
   */
  campaigns: EmailCampaign[] | null;
  totals: { totalSent: number | null; unsubscribes: number };
  recent: { email: string; type: string; status: string; sent_at: string; opened_at: string | null; clicked_at: string | null }[];
  /** Figures the API could not read in full — empty on a healthy response. */
  incomplete: string[];
}

export default function AdminPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('applications');

  const [applications, setApplications] = useState<Application[]>([]);
  const [creators, setCreators] = useState<CreatorSource[]>([]);
  /** Reads behind the Sources tab that came back short — empty when all is well. */
  const [creatorsIncomplete, setCreatorsIncomplete] = useState<string[]>([]);
  // Viability results for this session only, keyed creator → source. Not stored:
  // a check is a measurement of the feed as it is today, and a stale "viable"
  // from three months ago is worse than no answer.
  const [viability, setViability] = useState<Record<string, Partial<Record<PlatformSource, ViabilityReport>>>>({});
  const [sourceError, setSourceError] = useState<Record<string, string>>({});
  const [meals, setMeals] = useState<Meal[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [selectedQuarter, setSelectedQuarter] = useState<AvailableQuarter | null>(null);
  const [emailStats, setEmailStats] = useState<EmailStats | null>(null);
  const [emailSearch, setEmailSearch] = useState('');

  const [funnel, setFunnel] = useState<FunnelResponse | null>(null);
  // 30 by default: the trend line and the week-over-week comparison both need a
  // window wider than the week being judged, and this is the view the ticket's
  // "is HEB worse than last week" question is actually asked from.
  const [funnelDays, setFunnelDays] = useState(30);
  const [configVersions, setConfigVersions] = useState<ConfigVersion[]>([]);
  const [configDraft, setConfigDraft] = useState('');
  const [configNotes, setConfigNotes] = useState('');
  const [configMsg, setConfigMsg] = useState<string | null>(null);

  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [bcMessage, setBcMessage] = useState('');
  const [bcStores, setBcStores] = useState<string[]>([]);
  const [bcForceShow, setBcForceShow] = useState(false);
  const [bcSaving, setBcSaving] = useState(false);
  const [bcStatus, setBcStatus] = useState('');

  const [storageLoading, setStorageLoading] = useState(false);
  // `wouldBlock`/`blockReason` are the cleanup route's own verdict on its result
  // (MEAL-126): the orphan list is only worth acting on if the route considers it
  // trustworthy, and that has to be on screen next to the number.
  //
  // MEAL-133: `warnings`, `ageFilterAvailable` and `objectsTooNewToDelete` are on
  // the response too, and were being dropped on the floor here. The one that
  // matters is `ageFilterAvailable: false` — the shape of the response until the
  // `list_storage_objects` migration is applied by hand, in which no object's age
  // is knowable and the sweep can still take a photo a user is part-way through
  // attaching. The route says so; this is the screen an operator reads instead.
  const [storageDryRunResult, setStorageDryRunResult] = useState<{ orphanCount: number; estimatedBytes: number; paths: string[]; wouldBlock?: boolean; blockReason?: string; warnings?: string[]; ageFilterAvailable?: boolean; objectsTooNewToDelete?: number } | null>(null);
  // `hashInvalidationComplete` for the same reason (MEAL-132): a sweep that
  // destroyed objects but could not prune their dedupe rows has left those bytes
  // pointing at a dead URL for every future upload, and must not read as clean.
  const [storageDeleteResult, setStorageDeleteResult] = useState<{ deleted: number; estimatedBytes: number; warnings?: string[]; hashInvalidationComplete?: boolean } | null>(null);
  const [storageError, setStorageError] = useState('');
  const [backfillLoading, setBackfillLoading] = useState(false);
  /**
   * A backfill result, including whether the job actually finished (MEAL-129).
   *
   * `complete` and `remaining` are load-bearing, not decoration: both backfills used
   * to process at most 1000 rows and report success, so an operator had no way to
   * tell a finished job from one that hit the page ceiling.
   */
  const [backfillResult, setBackfillResult] = useState<BackfillResult | null>(null);
  const [photoBackfillLoading, setPhotoBackfillLoading] = useState(false);
  const [photoBackfillResult, setPhotoBackfillResult] = useState<BackfillResult | null>(null);

  useEffect(() => {
    verifyAdmin();
  }, []);

  const token = () => localStorage.getItem('accessToken');

  const verifyAdmin = async () => {
    try {
      const t = token();
      if (!t) { router.push('/signin'); return; }

      const res = await fetch('/api/auth/verify', {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (!res.ok) { localStorage.clear(); router.push('/signin'); return; }

      const data = await res.json();
      if (!data.user?.isAdmin) { router.push('/discover'); return; }

      setLoading(false);
      loadApplications();
    } catch {
      router.push('/signin');
    }
  };

  const loadApplications = async () => {
    const res = await fetch('/api/admin/applications', {
      headers: { Authorization: `Bearer ${token()}` },
    });
    if (res.ok) {
      const data = await res.json();
      setApplications(data.applications);
    }
  };

  const loadCreators = async () => {
    const res = await fetch('/api/admin/creators', {
      headers: { Authorization: `Bearer ${token()}` },
    });
    if (res.ok) {
      const data = await res.json();
      setCreators(data.creators ?? []);
      setCreatorsIncomplete(data.incomplete ?? []);
    }
  };

  /** Sets primary_source / import_opt_in / feed_url. The route refuses incoherent combinations. */
  const patchCreator = async (id: string, patch: Record<string, unknown>) => {
    setActionLoading('creator' + id);
    setSourceError(prev => ({ ...prev, [id]: '' }));
    const res = await fetch('/api/admin/creators', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ id, ...patch }),
    });
    const data = await res.json().catch(() => ({}));
    setActionLoading(null);
    if (!res.ok) {
      setSourceError(prev => ({ ...prev, [id]: data.error || 'Update failed.' }));
      return;
    }
    setCreators(prev => prev.map(c => (c.id === id ? { ...c, ...data.creator } : c)));
  };

  const runViability = async (id: string, source: PlatformSource) => {
    setActionLoading('viability' + id + source);
    setSourceError(prev => ({ ...prev, [id]: '' }));
    const res = await fetch('/api/admin/creators/viability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ id, source }),
    });
    const data = await res.json().catch(() => ({}));
    setActionLoading(null);
    if (!res.ok) {
      setSourceError(prev => ({ ...prev, [id]: data.error || 'Viability check failed.' }));
      return;
    }
    setViability(prev => ({ ...prev, [id]: { ...prev[id], [source]: data.report as ViabilityReport } }));
  };

  const loadMeals = async () => {
    const res = await fetch('/api/admin/meals', {
      headers: { Authorization: `Bearer ${token()}` },
    });
    if (res.ok) {
      const data = await res.json();
      setMeals(data.meals);
    }
  };

  const loadStats = async (qtr?: AvailableQuarter) => {
    const q = qtr ?? selectedQuarter;
    const params = q ? `?year=${q.year}&q=${q.q}` : '';
    const res = await fetch(`/api/admin/stats${params}`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    if (res.ok) {
      const data = await res.json();
      setStats(data);
    }
  };

  const loadEmailStats = async (search?: string) => {
    const params = search ? `?email=${encodeURIComponent(search)}` : '';
    const res = await fetch(`/api/admin/email-stats${params}`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    if (res.ok) setEmailStats(await res.json());
  };

  const loadFunnel = async (days = funnelDays) => {
    const res = await fetch(`/api/admin/automation-funnel?days=${days}`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    if (res.ok) setFunnel(await res.json());
  };

  const loadAutomationConfig = async () => {
    const res = await fetch('/api/admin/automation-config', {
      headers: { Authorization: `Bearer ${token()}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    setConfigVersions(data.versions ?? []);
    // Seed the editor with the active config so a push is an EDIT of what is
    // live, not a blank slate someone has to reconstruct from memory.
    if (data.active) setConfigDraft(JSON.stringify(data.active.config, null, 2));
  };

  const publishConfig = async () => {
    setConfigMsg(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(configDraft || '{}');
    } catch (e) {
      setConfigMsg(`Invalid JSON: ${(e as Error).message}`);
      return;
    }
    setActionLoading('publish-config');
    const res = await fetch('/api/admin/automation-config', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: parsed, notes: configNotes || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    setActionLoading(null);
    setConfigMsg(res.ok ? `Published v${data.version}` : `Failed: ${data.error ?? res.status}`);
    if (res.ok) { setConfigNotes(''); loadAutomationConfig(); }
  };

  const activateConfigVersion = async (version: number) => {
    if (!confirm(`Roll back to config v${version}? Clients pick it up within a few minutes.`)) return;
    setActionLoading(`activate-${version}`);
    const res = await fetch('/api/admin/automation-config', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ activateVersion: version }),
    });
    const data = await res.json().catch(() => ({}));
    setActionLoading(null);
    setConfigMsg(res.ok ? `Activated v${version}` : `Failed: ${data.error ?? res.status}`);
    if (res.ok) loadAutomationConfig();
  };

  const switchTab = (t: Tab) => {
    setTab(t);
    if (t === 'sources' && creators.length === 0) loadCreators();
    if (t === 'sync' && creators.length === 0) loadCreators();
    if (t === 'meals' && meals.length === 0) loadMeals();
    if (t === 'stats' && !stats) loadStats();
    if (t === 'broadcast') loadBroadcasts();
    if (t === 'email' && !emailStats) loadEmailStats();
    if (t === 'automation') { if (!funnel) loadFunnel(); if (configVersions.length === 0) loadAutomationConfig(); }
  };

  const loadBroadcasts = async () => {
    const res = await fetch('/api/broadcast');
    if (res.ok) {
      const data = await res.json();
      setBroadcasts(Array.isArray(data.broadcasts) ? data.broadcasts : []);
    }
  };

  const addBroadcast = async () => {
    if (!bcMessage.trim()) { setBcStatus('Message required.'); return; }
    setBcSaving(true);
    setBcStatus('');
    const res = await fetch('/api/admin/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ message: bcMessage, stores: bcStores, forceShow: bcForceShow }),
    });
    setBcSaving(false);
    if (res.ok) {
      setBcMessage('');
      setBcStores([]);
      setBcForceShow(false);
      setBcStatus('Added.');
      loadBroadcasts();
    } else {
      setBcStatus('Failed to add.');
    }
  };

  const removeBroadcast = async (id: string) => {
    const res = await fetch('/api/admin/broadcast', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ id }),
    });
    if (res.ok) setBroadcasts((prev) => prev.filter((b) => b.id !== id));
  };

  const handleApplication = async (id: string, action: 'approve' | 'reject') => {
    setActionLoading(id + action);
    const res = await fetch('/api/admin/applications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ id, action }),
    });
    if (res.ok) {
      setApplications(prev =>
        prev.map(a => a.id === id ? { ...a, status: action === 'approve' ? 'approved' : 'rejected' } : a)
      );
    }
    setActionLoading(null);
  };

  const handleDeleteMeal = async (id: string, name: string) => {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    setActionLoading('meal' + id);
    const res = await fetch('/api/admin/meals', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      setMeals(prev => prev.filter(m => m.id !== id));
    }
    setActionLoading(null);
  };

  const runStorageDryRun = async () => {
    setStorageLoading(true);
    setStorageError('');
    setStorageDryRunResult(null);
    setStorageDeleteResult(null);
    const res = await fetch('/api/admin/storage/cleanup-orphans?dryRun=true', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}` },
    });
    setStorageLoading(false);
    if (res.ok) {
      const data = await res.json();
      setStorageDryRunResult(data);
    } else {
      // The server's message, not a generic one: a 409 here means it refused to
      // compute orphans because the reference read was incomplete, and "Dry run
      // failed." would read as a hiccup worth retrying rather than a defect.
      const data = await res.json().catch(() => null);
      setStorageError(data?.error ?? 'Dry run failed.');
    }
  };

  const runStorageDelete = async () => {
    if (!confirm(`Delete ${storageDryRunResult?.orphanCount} orphaned files? This cannot be undone.`)) return;
    setStorageLoading(true);
    setStorageError('');
    const res = await fetch('/api/admin/storage/cleanup-orphans', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}` },
    });
    setStorageLoading(false);
    if (res.ok) {
      const data = await res.json();
      setStorageDeleteResult(data);
      setStorageDryRunResult(null);
    } else {
      const data = await res.json().catch(() => null);
      setStorageError(data?.error ?? 'Delete failed.');
    }
  };

  const runPhotoBackfill = async () => {
    if (!confirm('This will re-download and permanently store all Pixabay proxy photos in meals and preset_meals. May take several minutes. Continue?')) return;
    setPhotoBackfillLoading(true);
    setPhotoBackfillResult(null);
    const res = await fetch('/api/admin/storage/backfill-photos', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}` },
    });
    setPhotoBackfillLoading(false);
    if (res.ok) setPhotoBackfillResult(await res.json());
  };

  const runBackfill = async () => {
    if (!confirm('This will download and hash all storage files not yet in photo_hashes. This may take several minutes. Continue?')) return;
    setBackfillLoading(true);
    setBackfillResult(null);
    const res = await fetch('/api/admin/storage/backfill-hashes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}` },
    });
    setBackfillLoading(false);
    if (res.ok) {
      const data = await res.json();
      setBackfillResult(data);
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5' }}>
        <p style={{ color: '#888' }}>Loading…</p>
      </div>
    );
  }

  const tabStyle = (t: Tab): React.CSSProperties => ({
    padding: '8px 20px',
    border: 'none',
    borderBottom: tab === t ? '2px solid #dd0031' : '2px solid transparent',
    background: 'none',
    fontWeight: tab === t ? 700 : 400,
    color: tab === t ? '#dd0031' : '#666',
    cursor: 'pointer',
    fontSize: '14px',
  });

  // One instant for the whole Sources tab, so the order and every "4 days ago"
  // on it are answers to the same "now".
  const pollNow = Date.now();
  const sourcesByConcern = byConcernFirst(creators, pollNow);

  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      {/* Header */}
      <div style={{ background: 'linear-gradient(160deg, #c40029 0%, #dd0031 55%, #e8193a 100%)', color: 'white', padding: '20px 24px', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button onClick={() => router.push('/discover')} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '14px', opacity: 0.8 }}>
          ← Dashboard
        </button>
        <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 700 }}>Admin</h1>
      </div>

      {/* Tabs */}
      <div style={{ background: 'white', borderBottom: '1px solid #e0e0e0', display: 'flex', paddingLeft: '24px' }}>
        <button style={tabStyle('applications')} onClick={() => switchTab('applications')}>Applications</button>
        <button style={tabStyle('sources')} onClick={() => switchTab('sources')}>Sources</button>
        <button style={tabStyle('sync')} onClick={() => switchTab('sync')}>Sync</button>
        <button style={tabStyle('review')} onClick={() => switchTab('review')}>Review</button>
        <button style={tabStyle('meals')} onClick={() => switchTab('meals')}>Meals</button>
        <button style={tabStyle('stats')} onClick={() => switchTab('stats')}>Stats</button>
        <button style={tabStyle('broadcast')} onClick={() => switchTab('broadcast')}>Broadcast</button>
        <button style={tabStyle('storage')} onClick={() => switchTab('storage')}>Storage</button>
        <button style={tabStyle('email')} onClick={() => switchTab('email')}>Email</button>
        <button style={tabStyle('automation')} onClick={() => switchTab('automation')}>Automation</button>
      </div>

      <div style={{ maxWidth: '1000px', margin: '32px auto', padding: '0 20px' }}>

        {/* Applications Tab */}
        {tab === 'applications' && (
          <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
            <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0' }}>
              <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#222' }}>Creator Applications</h2>
            </div>
            {applications.length === 0 ? (
              <p style={{ padding: '32px 24px', color: '#888', textAlign: 'center' }}>No applications yet.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '600px' }}>
                <thead>
                  <tr style={{ background: '#fafafa', borderBottom: '1px solid #e0e0e0' }}>
                    {['Email', 'Display Name', 'Phone', 'How to find them', 'Links', 'Applied', 'Status', ''].map(h => (
                      <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#555' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {applications.map(app => (
                    <tr key={app.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={{ padding: '12px 16px', color: '#333' }}>{app.user_profiles?.email ?? '—'}</td>
                      <td style={{ padding: '12px 16px', fontWeight: 500 }}>{app.display_name}</td>
                      <td style={{ padding: '12px 16px', color: '#555' }}>{app.phone || '—'}</td>
                      <td style={{ padding: '12px 16px', color: '#555', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.find_us || '—'}</td>
                      {/* A real site with real recipes is the most useful single
                          signal for approving an application, so the four links
                          are visible here rather than only after approval. */}
                      <td style={{ padding: '12px 16px' }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {PLATFORM_SOURCES.filter(s => app[SOURCE_COLUMNS[s] as keyof Application]).map(s => (
                            <a
                              key={s}
                              href={String(app[SOURCE_COLUMNS[s] as keyof Application])}
                              target="_blank"
                              rel="noopener noreferrer nofollow"
                              style={{ fontSize: '12px', color: '#2563eb', textDecoration: 'none', border: '1px solid #dbeafe', borderRadius: '99px', padding: '2px 8px' }}
                            >
                              {SOURCE_LABELS[s]}
                            </a>
                          ))}
                          {PLATFORM_SOURCES.every(s => !app[SOURCE_COLUMNS[s] as keyof Application]) && (
                            <span style={{ color: '#aaa' }}>—</span>
                          )}
                        </div>
                      </td>
                      <td style={{ padding: '12px 16px', color: '#888' }}>{new Date(app.created_at).toLocaleDateString()}</td>
                      <td style={{ padding: '12px 16px' }}>
                        <span style={{
                          padding: '3px 8px', borderRadius: '99px', fontSize: '12px', fontWeight: 600,
                          background: app.status === 'approved' ? '#e6f9ed' : app.status === 'rejected' ? '#fff0f0' : '#fff8e1',
                          color: app.status === 'approved' ? '#1a7a3a' : app.status === 'rejected' ? '#c40029' : '#b45309',
                        }}>
                          {app.status}
                        </span>
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        {app.status === 'pending' && (
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <button
                              onClick={() => handleApplication(app.id, 'approve')}
                              disabled={actionLoading === app.id + 'approve'}
                              style={{ padding: '5px 12px', background: '#16a34a', color: 'white', border: 'none', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
                            >
                              Approve
                            </button>
                            <button
                              onClick={() => handleApplication(app.id, 'reject')}
                              disabled={actionLoading === app.id + 'reject'}
                              style={{ padding: '5px 12px', background: '#fff0f0', color: '#c40029', border: '1px solid #ffcccc', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
                            >
                              Reject
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </div>
        )}

        {/* Sources Tab — MEAL-81. One manually-chosen source per creator. */}
        {tab === 'sources' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

            {/* A creator missing from the list, or a creator whose health was never
                read, both used to render as a confident "nothing is configured". */}
            <IncompleteBanner names={creatorsIncomplete}>
              Creators whose poll health could not be read are counted as “not read”
              rather than as having no source — the two look identical on a row and mean
              opposite things.
            </IncompleteBanner>

            {creators.length === 0 ? (
              <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', padding: '32px', textAlign: 'center', color: '#888' }}>
                No creators yet.
              </div>
            ) : <PollHealthSummary creators={creators} now={pollNow} />}

            {sourcesByConcern.map(creator => {
              const reports = viability[creator.id] ?? {};
              const links: Partial<Record<PlatformSource, string | null>> = Object.fromEntries(
                PLATFORM_SOURCES.map(s => [s, creator[SOURCE_COLUMNS[s] as keyof CreatorSource] as string | null]),
              );
              const outcomes = Object.fromEntries(
                PLATFORM_SOURCES.filter(s => reports[s]).map(s => [s, reports[s]!.outcome]),
              ) as Partial<Record<PlatformSource, ViabilityOutcome>>;
              const verdict = summariseCreatorViability(links, outcomes);
              // Why this creator is not being polled, and what would still
              // refuse the switch if an operator tried to turn it back on. Both
              // are otherwise invisible here: one lived in an email, the other
              // only surfaced as a 400 at the moment of turning import on.
              const health = describeSourceHealth(creator as unknown as Record<string, unknown>);

              return (
                <div key={creator.id} style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', padding: '22px 24px' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', marginBottom: '4px' }}>
                    <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#222' }}>{creator.display_name}</h2>
                    {creator.handle && <span style={{ fontSize: '12px', color: '#aaa' }}>mealio.co/{creator.handle}</span>}
                    {creator.import_opt_in && creator.primary_source !== 'none' ? (
                      <span style={{ fontSize: '12px', fontWeight: 600, color: '#1a7a3a', background: '#e6f9ed', borderRadius: '99px', padding: '2px 10px' }}>
                        Polling {SOURCE_LABELS[creator.primary_source as PlatformSource]}
                      </span>
                    ) : (
                      <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', background: '#f3f4f6', borderRadius: '99px', padding: '2px 10px' }}>
                        Not polled
                      </span>
                    )}
                    {creator.pollHealth && <PollStatusBadge health={creator.pollHealth} now={pollNow} />}
                    {/* A grant that has stopped working looks exactly like a
                        creator who published nothing, so it is shown here rather
                        than left in a log for whoever thinks to look (MEAL-74). */}
                    {(creator.connections ?? []).map(connection => (
                      <span
                        key={connection.platform}
                        title={connection.brokenReason ?? undefined}
                        style={{
                          fontSize: '12px', fontWeight: 600, borderRadius: '99px', padding: '2px 10px',
                          color: connection.brokenReason ? '#c40029' : '#1a7a3a',
                          background: connection.brokenReason ? '#fdeaee' : '#e6f9ed',
                        }}
                      >
                        {SOURCE_LABELS[connection.platform as PlatformSource] ?? connection.platform}
                        {connection.brokenReason ? ' disconnected' : ' connected'}
                        {connection.externalName ? ` · ${connection.externalName}` : ''}
                      </span>
                    ))}
                    {/* Beside the connection badges, because they answer the
                        same question an operator is scanning this row for:
                        is anything actually going to arrive from this creator? */}
                    {health.map(notice => (
                      <span
                        key={notice.kind}
                        style={{
                          fontSize: '12px', fontWeight: 600, borderRadius: '99px', padding: '2px 10px',
                          color: notice.kind === 'paused' ? '#b45309' : '#c40029',
                          background: notice.kind === 'paused' ? '#fff8e1' : '#fdeaee',
                        }}
                      >
                        {notice.label}
                      </span>
                    ))}
                  </div>

                  {/* The sentence itself, not a tooltip. An operator asking why
                      a creator stopped being polled should not have to know
                      there is something to hover over. */}
                  {health.map(notice => (
                    <p
                      key={notice.kind}
                      data-testid={`source-health-${notice.kind}`}
                      style={{
                        margin: '8px 0 0', fontSize: '12px', lineHeight: 1.6, borderRadius: '8px', padding: '8px 10px',
                        color: notice.kind === 'paused' ? '#92400e' : '#c40029',
                        background: notice.kind === 'paused' ? '#fffbeb' : '#fff5f6',
                      }}
                    >
                      {notice.detail}
                      {notice.at && (
                        <span style={{ color: '#aaa' }}>
                          {' · '}{relativeTime(notice.at, pollNow) ?? ''} ({new Date(notice.at).toLocaleString()})
                        </span>
                      )}
                    </p>
                  ))}

                  {/* Creator-level answer: importable, not importable, or not yet known. */}
                  <p style={{
                    margin: '8px 0 8px', fontSize: '12px', lineHeight: 1.6,
                    color: verdict.importable === false ? '#c40029' : verdict.importable ? '#1a7a3a' : '#888',
                  }}>
                    {verdict.summary}
                  </p>

                  {/* Is polling working, and is it producing anything (MEAL-96).
                      Above the link rows because it is what the operator came to
                      the tab to find out; the links are what they change after. */}
                  {creator.pollHealth && <PollHealthPanel health={creator.pollHealth} now={pollNow} />}

                  {/* One row per link: check it, then choose it. */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {PLATFORM_SOURCES.map(source => {
                      const link = links[source];
                      const report = reports[source];
                      const busy = actionLoading === 'viability' + creator.id + source;
                      // Three of the four sources can only be measured through a
                      // grant now — YouTube joined Instagram and TikTok when the
                      // uploads feed went (MEAL-79). A creator who connected
                      // their channel but never pasted a link is exactly the one
                      // the check applies to, so a link cannot be what unlocks
                      // the button.
                      const connected = (creator.connections ?? []).some(c => c.platform === source);
                      const checkable = Boolean(link) || connected;
                      return (
                        <div key={source} style={{ border: '1px solid #f0f0f0', borderRadius: '10px', padding: '12px 14px', background: creator.primary_source === source ? '#fffdf7' : 'white' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 600, color: '#444', cursor: link ? 'pointer' : 'not-allowed', opacity: link ? 1 : 0.5 }}>
                              <input
                                type="radio"
                                name={`source-${creator.id}`}
                                checked={creator.primary_source === source}
                                disabled={!link}
                                onChange={() => patchCreator(creator.id, { primarySource: source })}
                                style={{ accentColor: '#dd0031' }}
                              />
                              {SOURCE_LABELS[source]}
                            </label>
                            {link ? (
                              <a href={link} target="_blank" rel="noopener noreferrer nofollow" style={{ fontSize: '12px', color: '#2563eb', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {link}
                              </a>
                            ) : (
                              <span style={{ fontSize: '12px', color: '#bbb', flex: 1 }}>
                                {connected ? 'no link — read through the connection' : 'no link'}
                              </span>
                            )}
                            {checkable && (
                              <button
                                onClick={() => runViability(creator.id, source)}
                                disabled={busy}
                                style={{ padding: '5px 12px', background: busy ? '#aaa' : '#2563eb', color: 'white', border: 'none', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: busy ? 'wait' : 'pointer', flexShrink: 0 }}
                              >
                                {busy ? 'Checking…' : report ? 'Re-check' : 'Check viability'}
                              </button>
                            )}
                          </div>

                          {report && (
                            <div style={{ marginTop: '12px', borderTop: '1px solid #f5f5f5', paddingTop: '12px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                                <span style={{ fontSize: '11px', fontWeight: 700, borderRadius: '99px', padding: '2px 10px', background: OUTCOME_STYLES[report.outcome].bg, color: OUTCOME_STYLES[report.outcome].fg }}>
                                  {OUTCOME_STYLES[report.outcome].label}
                                </span>
                                <span style={{ fontSize: '11px', color: '#aaa' }}>
                                  {report.passed}/{report.checked} passed · ${report.costUsd.toFixed(4)}
                                </span>
                              </div>
                              <p style={{ margin: '0 0 10px', fontSize: '12px', color: '#555', lineHeight: 1.6, whiteSpace: 'pre-line' }}>{report.summary}</p>

                              {/* The discovered feed, confirmed by a human before
                                  it is stored. A silent wrong guess here starts
                                  importing a stranger's recipes. */}
                              {report.feed && (
                                <div style={{ background: '#fafafa', borderRadius: '8px', padding: '10px 12px', marginBottom: '10px' }}>
                                  <div style={{ fontSize: '12px', color: '#444', marginBottom: '6px' }}>
                                    Feed found via <strong>{report.feed.via}</strong> ({report.feed.kind}):{' '}
                                    <a href={report.feed.url} target="_blank" rel="noopener noreferrer nofollow" style={{ color: '#2563eb' }}>{report.feed.url}</a>
                                  </div>
                                  <div style={{ fontSize: '11px', color: '#888', marginBottom: '8px' }}>Most recent entries — confirm these are this creator&apos;s:</div>
                                  <ol style={{ margin: '0 0 10px', paddingLeft: '18px' }}>
                                    {report.feed.entries.slice(0, 5).map(entry => (
                                      <li key={entry.id} style={{ fontSize: '12px', color: '#555', padding: '2px 0' }}>
                                        <a href={entry.url} target="_blank" rel="noopener noreferrer nofollow" style={{ color: '#555' }}>
                                          {entry.title || entry.url}
                                        </a>
                                        {entry.publishedAt && <span style={{ color: '#bbb' }}> · {new Date(entry.publishedAt).toLocaleDateString()}</span>}
                                      </li>
                                    ))}
                                  </ol>
                                  {creator.feed_url === report.feed.url ? (
                                    <span style={{ fontSize: '12px', color: '#1a7a3a', fontWeight: 600 }}>✓ Confirmed and saved</span>
                                  ) : (
                                    <button
                                      onClick={() => patchCreator(creator.id, { feedUrl: report.feed!.url })}
                                      disabled={actionLoading === 'creator' + creator.id}
                                      style={{ padding: '5px 12px', background: '#16a34a', color: 'white', border: 'none', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
                                    >
                                      Confirm this feed
                                    </button>
                                  )}
                                </div>
                              )}

                              {report.items.length > 0 && (
                                <div style={{ maxHeight: '220px', overflowY: 'auto' }}>
                                  {report.items.map((item, i) => (
                                    <div key={`${item.url}-${i}`} style={{ display: 'flex', gap: '8px', padding: '4px 0', fontSize: '12px', borderTop: i === 0 ? 'none' : '1px solid #f7f7f7' }}>
                                      <span style={{ color: VERDICT_COLORS[item.verdict] ?? '#666', fontWeight: 700, width: '48px', flexShrink: 0 }}>{item.verdict}</span>
                                      <span style={{ flex: 1, minWidth: 0 }}>
                                        <a href={item.url} target="_blank" rel="noopener noreferrer nofollow" style={{ color: '#333', textDecoration: 'none' }}>{item.title}</a>
                                        <div style={{ color: '#999' }}>{item.reason}</div>
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* The switch. Nothing is polled until a source is chosen AND this is on. */}
                  <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', borderTop: '1px solid #f0f0f0', paddingTop: '14px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#333', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={creator.import_opt_in}
                        onChange={e => patchCreator(creator.id, { importOptIn: e.target.checked })}
                        style={{ accentColor: '#dd0031', width: '16px', height: '16px' }}
                      />
                      Import from this source
                    </label>
                    {creator.primary_source !== 'none' && (
                      <button
                        onClick={() => patchCreator(creator.id, { primarySource: 'none' })}
                        style={{ background: 'none', border: '1px solid #e0e0e0', borderRadius: '8px', padding: '4px 12px', fontSize: '12px', color: '#666', cursor: 'pointer' }}
                      >
                        Clear source
                      </button>
                    )}
                    {creator.feed_url && (
                      <span style={{ fontSize: '11px', color: '#aaa', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        feed_url: {creator.feed_url}
                      </span>
                    )}
                  </div>
                  {sourceError[creator.id] && (
                    <div style={{ marginTop: '10px', background: '#fff0f0', border: '1px solid #ffcccc', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: '#c40029' }}>
                      {sourceError[creator.id]}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Sync Tab — MEAL-90. One link, or a reviewed checklist. */}
        {tab === 'sync' && <AdminSyncPanel creators={creators} />}

        {/* Where a synced recipe becomes live. Nothing published under a
            creator's name skips this tab any more (MEAL-91). */}
        {tab === 'review' && <AdminReviewQueue />}

        {/* Meals Tab */}
        {tab === 'meals' && (
          <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
            <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0' }}>
              <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#222' }}>All Preset Meals</h2>
            </div>
            {meals.length === 0 ? (
              <p style={{ padding: '32px 24px', color: '#888', textAlign: 'center' }}>Loading…</p>
            ) : (
              <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '600px' }}>
                <thead>
                  <tr style={{ background: '#fafafa', borderBottom: '1px solid #e0e0e0' }}>
                    {['Name', 'Author', 'Difficulty', 'Trending Score', ''].map(h => (
                      <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#555' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {meals.map(meal => (
                    <tr key={meal.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={{ padding: '12px 16px', fontWeight: 500 }}>{meal.name}</td>
                      <td style={{ padding: '12px 16px', color: '#555' }}>{meal.creator_name || meal.author || '—'}</td>
                      <td style={{ padding: '12px 16px', color: '#555' }}>{meal.difficulty ?? '—'}</td>
                      <td style={{ padding: '12px 16px', color: '#555' }}>{Number(meal.trending_score).toFixed(1)}</td>
                      <td style={{ padding: '12px 16px' }}>
                        <button
                          onClick={() => handleDeleteMeal(meal.id, meal.name)}
                          disabled={actionLoading === 'meal' + meal.id}
                          style={{ padding: '5px 12px', background: '#fff0f0', color: '#c40029', border: '1px solid #ffcccc', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </div>
        )}

        {/* Stats Tab */}
        {tab === 'stats' && (
          <>
            {!stats ? (
              <p style={{ textAlign: 'center', color: '#888', padding: '32px' }}>Loading…</p>
            ) : (
              <>
                {/* An aggregate came back short. Loud, and above the numbers rather
                    than under them: the figures below decide creator payouts, and the
                    bug this replaces was precisely that nothing said the answer was
                    partial. */}
                {stats.incomplete.length > 0 && (
                  <div style={{ marginBottom: '20px', padding: '14px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', fontSize: '13px', color: '#b91c1c' }}>
                    <strong>Incomplete data — do not pay out from this screen.</strong>{' '}
                    These reads could not be completed:{' '}
                    {stats.incomplete.map(k => INCOMPLETE_LABELS[k] ?? k).join(', ')}. The
                    affected figures are shown as “—” rather than as a number that would be
                    understated. Retry, and if it persists check the server log for
                    ADMIN:STATS.
                  </div>
                )}

                {/* Quarter selector */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
                  <label style={{ fontSize: '13px', fontWeight: 600, color: '#555' }}>Quarter:</label>
                  <select
                    value={`${(selectedQuarter ?? stats.availableQuarters[0]).year}-${(selectedQuarter ?? stats.availableQuarters[0]).q}`}
                    onChange={e => {
                      const [year, q] = e.target.value.split('-').map(Number);
                      const qtr = stats.availableQuarters.find(x => x.year === year && x.q === q)!;
                      setSelectedQuarter(qtr);
                      loadStats(qtr);
                    }}
                    style={{ padding: '7px 12px', border: '1px solid #ddd', borderRadius: '8px', fontSize: '14px', background: 'white', cursor: 'pointer' }}
                  >
                    {stats.availableQuarters.map(qtr => (
                      <option key={`${qtr.year}-${qtr.q}`} value={`${qtr.year}-${qtr.q}`}>
                        {qtr.label}{qtr === stats.availableQuarters[0] ? ' (current)' : ''}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Platform totals */}
                {stats.isCurrent ? (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '12px' }}>
                      {[
                        { label: 'Meals (30d)',      value: stats.totals.saves30d ?? 0 },
                        { label: `Meals (${stats.quarterLabel})`, value: stats.totals.savesQtr },
                        { label: 'Meals (all time)', value: stats.totals.savesAll ?? 0 },
                      ].map(s => (
                        <div key={s.label} style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', textAlign: 'center' }}>
                          <div style={{ fontSize: '32px', fontWeight: 700, color: '#dd0031' }}>{s.value.toLocaleString()}</div>
                          <div style={{ fontSize: '13px', color: '#888', marginTop: '4px' }}>{s.label}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '16px', marginBottom: '24px' }}>
                      <div style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', textAlign: 'center' }}>
                        <div style={{ fontSize: '32px', fontWeight: 700, color: '#555' }}>{figure(stats.totals.totalCreatorAnnualSaves)}</div>
                        <div style={{ fontSize: '13px', color: '#888', marginTop: '4px' }}>Creator saves (last 12 months)</div>
                      </div>
                    </div>

                    {/* User signups — current quarter view */}
                    <div style={{ fontSize: '13px', fontWeight: 600, color: '#555', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>User Signups</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '24px' }}>
                      {[
                        { label: 'Signups (30d)',      value: stats.totals.signups30d ?? 0 },
                        { label: `Signups (${stats.quarterLabel})`, value: stats.totals.signupsQtr },
                        { label: 'Signups (all time)', value: stats.totals.signupsAll ?? 0 },
                      ].map(s => (
                        <div key={s.label} style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', textAlign: 'center' }}>
                          <div style={{ fontSize: '32px', fontWeight: 700, color: '#2563eb' }}>{s.value.toLocaleString()}</div>
                          <div style={{ fontSize: '13px', color: '#888', marginTop: '4px' }}>{s.label}</div>
                        </div>
                      ))}
                    </div>

                    {/* Net new paid — current quarter view */}
                    <div style={{ fontSize: '13px', fontWeight: 600, color: '#555', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Net New Paid</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '32px' }}>
                      {[
                        { label: 'Net new paid (30d)',      started: stats.totals.subsStarted30d,  cancelled: stats.totals.subsCancelled30d,  net: stats.totals.netNewPaid30d },
                        { label: `Net new paid (${stats.quarterLabel})`, started: stats.totals.subsStartedQtr, cancelled: stats.totals.subsCancelledQtr, net: stats.totals.netNewPaidQtr },
                        { label: 'Net new paid (all time)', started: stats.totals.subsStartedAll,  cancelled: stats.totals.subsCancelledAll,  net: stats.totals.netNewPaidAll },
                      ].map(s => (
                        <div key={s.label} style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', textAlign: 'center' }}>
                          <div style={{ fontSize: '32px', fontWeight: 700, color: s.net === null ? '#aaa' : s.net >= 0 ? '#16a34a' : '#c40029' }}>{signedFigure(s.net)}</div>
                          <div style={{ fontSize: '13px', color: '#888', marginTop: '4px' }}>{s.label}</div>
                          <div style={{ fontSize: '11px', color: '#aaa', marginTop: '6px' }}>{figure(s.started)} started · {figure(s.cancelled)} cancelled</div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '16px', marginBottom: '24px' }}>
                    <div style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', textAlign: 'center' }}>
                      <div style={{ fontSize: '32px', fontWeight: 700, color: '#dd0031' }}>{stats.totals.savesQtr.toLocaleString()}</div>
                      <div style={{ fontSize: '13px', color: '#888', marginTop: '4px' }}>Meals ({stats.quarterLabel})</div>
                    </div>
                  </div>

                  {/* User signups — historical quarter view */}
                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#555', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>User Signups</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '16px', marginBottom: '24px' }}>
                    <div style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', textAlign: 'center' }}>
                      <div style={{ fontSize: '32px', fontWeight: 700, color: '#2563eb' }}>{stats.totals.signupsQtr.toLocaleString()}</div>
                      <div style={{ fontSize: '13px', color: '#888', marginTop: '4px' }}>Signups ({stats.quarterLabel})</div>
                    </div>
                  </div>

                  {/* Net new paid — historical quarter view */}
                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#555', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Net New Paid</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '16px', marginBottom: '32px' }}>
                    <div style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', textAlign: 'center' }}>
                      <div style={{ fontSize: '32px', fontWeight: 700, color: stats.totals.netNewPaidQtr === null ? '#aaa' : stats.totals.netNewPaidQtr >= 0 ? '#16a34a' : '#c40029' }}>
                        {signedFigure(stats.totals.netNewPaidQtr)}
                      </div>
                      <div style={{ fontSize: '13px', color: '#888', marginTop: '4px' }}>Net new paid ({stats.quarterLabel})</div>
                      <div style={{ fontSize: '11px', color: '#aaa', marginTop: '6px' }}>{figure(stats.totals.subsStartedQtr)} started · {figure(stats.totals.subsCancelledQtr)} cancelled</div>
                    </div>
                  </div>
                  </>
                )}

                {/* Profit-share leaderboard — rolling 12-month window (window-relative, shown for any quarter view) */}
                <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden', marginBottom: '24px' }}>
                  <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0' }}>
                    <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#222' }}>Profit-Share Leaderboard</h2>
                    <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#888' }}>Creator saves over the rolling last 12 months — sorted by share of pool</p>
                  </div>
                  {stats.leaderboard === null ? (
                    /* The read was short, so the shares are wrong for everybody — not
                       just small. Showing the table anyway is how a creator gets
                       under-paid by a number that looked plausible. */
                    <p style={{ padding: '32px 24px', color: '#b91c1c', textAlign: 'center', fontSize: '13px', margin: 0 }}>
                      Leaderboard unavailable — the creator-save read could not be completed,
                      so every share below it would be understated. Nothing is shown rather
                      than something partial. Retry before paying out.
                    </p>
                  ) : stats.leaderboard.length === 0 ? (
                    <p style={{ padding: '32px 24px', color: '#888', textAlign: 'center' }}>No creator saves in the last 12 months.</p>
                  ) : (
                    <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '600px' }}>
                      <thead>
                        <tr style={{ background: '#fafafa', borderBottom: '1px solid #e0e0e0' }}>
                          {['#', 'Creator', 'Saves (last 12 mo)', 'Share'].map(h => (
                            <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#555' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {stats.leaderboard.map((c, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                            <td style={{ padding: '12px 16px', color: '#aaa', fontWeight: 600 }}>{i + 1}</td>
                            <td style={{ padding: '12px 16px', fontWeight: 500 }}>{c.name}</td>
                            <td style={{ padding: '12px 16px', color: '#555' }}>{c.annualSaves.toLocaleString()}</td>
                            <td style={{ padding: '12px 16px', fontWeight: 700, color: '#dd0031' }}>{c.sharePercent.toFixed(1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table></div>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {/* Storage Tab */}
        {tab === 'email' && (
          <>
            {!emailStats ? (
              <p style={{ textAlign: 'center', color: '#888', padding: '32px' }}>Loading…</p>
            ) : (
              <>
                {/* A funnel computed over an arbitrary 1000 sends is not a smaller
                    funnel, it is a biased one — physical row order decided which sends
                    counted. So it is withheld rather than shown. */}
                <div style={{ marginBottom: '20px' }}>
                  <IncompleteBanner names={emailStats.incomplete}>
                    Rates are withheld rather than shown from a partial sample: which sends
                    survive a truncated read is decided by physical row order, so the
                    percentages would be biased, not merely based on fewer rows.
                  </IncompleteBanner>
                </div>

                {/* Totals */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px', marginBottom: '24px' }}>
                  <div style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', textAlign: 'center' }}>
                    <div style={{ fontSize: '32px', fontWeight: 700, color: emailStats.totals.totalSent === null ? '#aaa' : '#dd0031' }}>{orDash(emailStats.totals.totalSent)}</div>
                    <div style={{ fontSize: '13px', color: '#888', marginTop: '4px' }}>Emails sent</div>
                  </div>
                  <div style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', textAlign: 'center' }}>
                    <div style={{ fontSize: '32px', fontWeight: 700, color: '#555' }}>{emailStats.totals.unsubscribes.toLocaleString()}</div>
                    <div style={{ fontSize: '13px', color: '#888', marginTop: '4px' }}>Unsubscribed</div>
                  </div>
                </div>

                {/* Campaigns */}
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#555', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Campaigns</div>
                <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden', marginBottom: '32px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ background: '#faf7f5', color: '#888' }}>
                        {['Campaign', 'Sent', 'Delivered', 'Open %', 'Click %', 'Bounced', 'Complaints'].map((h, i) => (
                          <th key={h} style={{ padding: '10px 12px', fontWeight: 600, textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {emailStats.campaigns === null ? (
                        <tr><td colSpan={7} style={{ padding: '20px', textAlign: 'center', color: '#b91c1c' }}>
                          Funnel unavailable — the send log could not be read in full, so every
                          rate below it would be computed over a biased slice. Nothing is shown
                          rather than something partial.
                        </td></tr>
                      ) : emailStats.campaigns.length === 0 ? (
                        <tr><td colSpan={7} style={{ padding: '20px', textAlign: 'center', color: '#aaa' }}>No emails sent yet.</td></tr>
                      ) : emailStats.campaigns.map(c => (
                        <tr key={c.type} style={{ borderTop: '1px solid #f0eae6' }}>
                          <td style={{ padding: '10px 12px', fontWeight: 600, color: '#333' }}>{c.type}</td>
                          <td style={{ padding: '10px 12px', textAlign: 'right' }}>{c.sent}</td>
                          <td style={{ padding: '10px 12px', textAlign: 'right' }}>{c.delivered}</td>
                          <td style={{ padding: '10px 12px', textAlign: 'right' }}>{c.openRate}%</td>
                          <td style={{ padding: '10px 12px', textAlign: 'right' }}>{c.clickRate}%</td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', color: c.bounced ? '#dd0031' : '#333' }}>{c.bounced}</td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', color: c.complained ? '#dd0031' : '#333' }}>{c.complained}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Recent log */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Recent sends</div>
                  <input
                    value={emailSearch}
                    onChange={e => setEmailSearch(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') loadEmailStats(emailSearch); }}
                    placeholder="Search email…"
                    style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: '8px', fontSize: '13px' }}
                  />
                </div>
                <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ background: '#faf7f5', color: '#888', textAlign: 'left' }}>
                        {['Email', 'Campaign', 'Status', 'Sent', 'Opened', 'Clicked'].map(h => (
                          <th key={h} style={{ padding: '10px 12px', fontWeight: 600 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {emailStats.recent.length === 0 ? (
                        <tr><td colSpan={6} style={{ padding: '20px', textAlign: 'center', color: '#aaa' }}>No sends match.</td></tr>
                      ) : emailStats.recent.map((r, i) => (
                        <tr key={i} style={{ borderTop: '1px solid #f0eae6' }}>
                          <td style={{ padding: '10px 12px', color: '#333' }}>{r.email}</td>
                          <td style={{ padding: '10px 12px', color: '#666' }}>{r.type}</td>
                          <td style={{ padding: '10px 12px', color: '#666' }}>{r.status}</td>
                          <td style={{ padding: '10px 12px', color: '#999' }}>{new Date(r.sent_at).toLocaleDateString()}</td>
                          <td style={{ padding: '10px 12px' }}>{r.opened_at ? '✓' : ''}</td>
                          <td style={{ padding: '10px 12px' }}>{r.clicked_at ? '✓' : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}

        {tab === 'storage' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

            {/* Orphan Cleanup */}
            <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', padding: '24px' }}>
              <h2 style={{ margin: '0 0 6px', fontSize: '16px', fontWeight: 600, color: '#222' }}>Orphan Cleanup</h2>
              <p style={{ margin: '0 0 20px', fontSize: '13px', color: '#888' }}>
                Finds storage files in the meal-photos bucket that are not referenced by any meal, preset meal, creator,
                application, or pending import draft. Run a dry run first to preview what would be deleted.
              </p>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  onClick={runStorageDryRun}
                  disabled={storageLoading}
                  style={{ background: '#2563eb', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 20px', fontSize: '14px', fontWeight: 600, cursor: storageLoading ? 'not-allowed' : 'pointer', opacity: storageLoading ? 0.7 : 1 }}
                >
                  {storageLoading ? 'Running…' : 'Dry Run'}
                </button>
                {storageDryRunResult && storageDryRunResult.orphanCount > 0 && (
                  <button
                    onClick={runStorageDelete}
                    disabled={storageLoading}
                    style={{ background: '#c40029', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 20px', fontSize: '14px', fontWeight: 600, cursor: storageLoading ? 'not-allowed' : 'pointer', opacity: storageLoading ? 0.7 : 1 }}
                  >
                    Delete {storageDryRunResult.orphanCount} Orphans
                  </button>
                )}
                {storageError && <span style={{ fontSize: '13px', color: '#c40029' }}>{storageError}</span>}
              </div>
              {storageDryRunResult && (
                <div style={{ marginTop: '16px', padding: '14px 16px', background: '#f8f9fa', borderRadius: '8px', fontSize: '13px' }}>
                  <div style={{ fontWeight: 600, color: '#222', marginBottom: '6px' }}>
                    Dry run: {storageDryRunResult.orphanCount} orphan{storageDryRunResult.orphanCount !== 1 ? 's' : ''} found
                    — ~{(storageDryRunResult.estimatedBytes / 1024 / 1024).toFixed(2)} MB
                  </div>
                  {storageDryRunResult.wouldBlock && (
                    <div style={{ margin: '0 0 8px', padding: '10px 12px', background: '#fff4e5', border: '1px solid #f0b37e', borderRadius: '6px', color: '#8a4b08', fontWeight: 600 }}>
                      Delete will refuse: {storageDryRunResult.blockReason}
                    </div>
                  )}
                  {/* The route's own warnings, same amber as the block notice above.
                      `ageFilterAvailable: false` gets a headline of its own because it
                      is the one an operator has to act on rather than read. */}
                  {(storageDryRunResult.ageFilterAvailable === false || (storageDryRunResult.warnings?.length ?? 0) > 0) && (
                    <div data-testid="storage-dry-run-warnings" style={{ margin: '0 0 8px', padding: '10px 12px', background: '#fff4e5', border: '1px solid #f0b37e', borderRadius: '6px', color: '#8a4b08' }}>
                      {storageDryRunResult.ageFilterAvailable === false && (
                        <div style={{ fontWeight: 600 }}>
                          Age filter unavailable — a photo uploaded moments ago cannot be told from an
                          abandoned one, and can still be deleted by this sweep.
                        </div>
                      )}
                      {storageDryRunResult.warnings?.map((w, i) => (
                        <div key={i} style={{ marginTop: '6px' }}>{w}</div>
                      ))}
                    </div>
                  )}
                  {(storageDryRunResult.objectsTooNewToDelete ?? 0) > 0 && (
                    <div style={{ margin: '0 0 8px', color: '#555' }}>
                      {storageDryRunResult.objectsTooNewToDelete} unreferenced object
                      {storageDryRunResult.objectsTooNewToDelete !== 1 ? 's' : ''} held back as too new
                      to delete, and not listed below. A later sweep will take them if nothing ever
                      references them.
                    </div>
                  )}
                  {storageDryRunResult.orphanCount === 0 ? (
                    <div style={{ color: '#16a34a' }}>No orphans — storage is clean.</div>
                  ) : (
                    <div style={{ maxHeight: '160px', overflowY: 'auto', marginTop: '8px' }}>
                      {storageDryRunResult.paths.map(p => (
                        <div key={p} style={{ color: '#555', fontFamily: 'monospace', fontSize: '12px', padding: '2px 0' }}>{p}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {storageDeleteResult && (
                <div style={{ marginTop: '16px', padding: '14px 16px', background: storageDeleteResult.hashInvalidationComplete === false ? '#fff4e5' : '#e6f9ed', borderRadius: '8px', fontSize: '13px', color: storageDeleteResult.hashInvalidationComplete === false ? '#8a4b08' : '#1a7a3a', fontWeight: 600 }}>
                  Deleted {storageDeleteResult.deleted} file{storageDeleteResult.deleted !== 1 ? 's' : ''} (~{(storageDeleteResult.estimatedBytes / 1024 / 1024).toFixed(2)} MB freed)
                  {/* A sweep that could not prune its dedupe rows is not a clean sweep
                      (MEAL-132), and the route says which. */}
                  {storageDeleteResult.warnings?.map((w, i) => (
                    <div key={i} style={{ marginTop: '6px', fontWeight: 400 }}>{w}</div>
                  ))}
                </div>
              )}
            </div>

            {/* Photo URL Backfill */}
            <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', padding: '24px' }}>
              <h2 style={{ margin: '0 0 6px', fontSize: '16px', fontWeight: 600, color: '#222' }}>Backfill Proxy Photos</h2>
              <p style={{ margin: '0 0 20px', fontSize: '13px', color: '#888' }}>
                Finds all meals and preset meals whose <code>photo_url</code> is still a Pixabay proxy URL (these expire ~24h after generation),
                re-downloads each image, and saves it permanently to Supabase Storage. Run this once to fix missing photos.
              </p>
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                <button
                  onClick={runPhotoBackfill}
                  disabled={photoBackfillLoading}
                  style={{ background: '#7c3aed', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 20px', fontSize: '14px', fontWeight: 600, cursor: photoBackfillLoading ? 'not-allowed' : 'pointer', opacity: photoBackfillLoading ? 0.7 : 1 }}
                >
                  {photoBackfillLoading ? 'Backfilling…' : 'Backfill Proxy Photos'}
                </button>
              </div>
              {photoBackfillResult && (
                <div data-testid="photo-backfill-result" style={{ marginTop: '16px', padding: '14px 16px', background: photoBackfillResult.complete ? '#f5f3ff' : '#fffbeb', borderRadius: '8px', fontSize: '13px', color: photoBackfillResult.complete ? '#5b21b6' : '#92400e', fontWeight: 600 }}>
                  {photoBackfillResult.complete ? 'Done' : 'Partial run'} — {photoBackfillResult.processed} resolved, {photoBackfillResult.skipped} skipped (already permanent or unchanged), {photoBackfillResult.errors} errors
                  {' '}({photoBackfillResult.total} proxy URLs found)
                  {/* The sentence that was missing. A batch of 500 out of 1200 used to
                      read simply as "Done". */}
                  {!photoBackfillResult.complete && (
                    <div style={{ marginTop: '6px', fontWeight: 400 }}>
                      {photoBackfillResult.remaining.toLocaleString()} still to do — this run is capped at{' '}
                      {photoBackfillResult.batchLimit.toLocaleString()} rows. Run it again.
                      {!photoBackfillResult.scanComplete && ' The scan was also truncated, so the total above is a floor.'}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Hash Backfill */}
            <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', padding: '24px' }}>
              <h2 style={{ margin: '0 0 6px', fontSize: '16px', fontWeight: 600, color: '#222' }}>Backfill Photo Hashes</h2>
              <p style={{ margin: '0 0 20px', fontSize: '13px', color: '#888' }}>
                One-time operation: downloads and SHA-256 hashes all existing storage files not yet in the photo_hashes table.
                This enables deduplication for files uploaded before the feature was added. May take several minutes.
              </p>
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                <button
                  onClick={runBackfill}
                  disabled={backfillLoading}
                  style={{ background: '#555', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 20px', fontSize: '14px', fontWeight: 600, cursor: backfillLoading ? 'not-allowed' : 'pointer', opacity: backfillLoading ? 0.7 : 1 }}
                >
                  {backfillLoading ? 'Backfilling…' : 'Backfill Hashes'}
                </button>
              </div>
              {backfillResult && (
                <div data-testid="hash-backfill-result" style={{ marginTop: '16px', padding: '14px 16px', background: backfillResult.complete ? '#e6f9ed' : '#fffbeb', borderRadius: '8px', fontSize: '13px', color: backfillResult.complete ? '#1a7a3a' : '#92400e', fontWeight: 600 }}>
                  {backfillResult.complete ? 'Done' : 'Partial run'} — {backfillResult.processed} hashed, {backfillResult.skipped} skipped, {backfillResult.errors} errors (of {backfillResult.total} total files)
                  {!backfillResult.complete && (
                    <div style={{ marginTop: '6px', fontWeight: 400 }}>
                      {backfillResult.remaining.toLocaleString()} still to do — this run is capped at{' '}
                      {backfillResult.batchLimit.toLocaleString()} files. Run it again.
                      {!backfillResult.scanComplete && ' The scan was also truncated, so the total above is a floor.'}
                    </div>
                  )}
                </div>
              )}
            </div>

          </div>
        )}

        {/* Broadcast Tab */}
        {tab === 'broadcast' && (
          <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', padding: '24px' }}>
            <h2 style={{ margin: '0 0 6px', fontSize: '16px', fontWeight: 600, color: '#222' }}>Broadcast Messages</h2>
            <p style={{ margin: '0 0 20px', fontSize: '13px', color: '#888' }}>
              Active broadcasts show as banners in the mobile app. You can run several at once (e.g. different stores).
            </p>

            {broadcasts.length === 0 ? (
              <p style={{ fontSize: '13px', color: '#aaa', margin: '0 0 24px' }}>No active broadcasts.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '28px' }}>
                {broadcasts.map((b) => {
                  const labels = b.stores.length
                    ? b.stores.map((id) => BROADCAST_STORE_OPTIONS.find((o) => o.id === id)?.label ?? id).join(', ')
                    : 'Everyone';
                  return (
                    <div key={b.id} style={{ border: '1px solid #eee', borderRadius: '8px', padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '14px', color: '#222', marginBottom: '4px' }}>{b.message}</div>
                        <div style={{ fontSize: '12px', color: '#888' }}>
                          {labels}{b.forceShow ? ' · shows every launch' : ''}
                        </div>
                      </div>
                      <button
                        onClick={() => removeBroadcast(b.id)}
                        style={{ background: 'none', border: '1px solid #e0e0e0', borderRadius: '8px', padding: '6px 12px', fontSize: '12px', color: '#dd0031', cursor: 'pointer', flexShrink: 0 }}
                      >
                        Remove
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600, color: '#444', borderTop: '1px solid #f0f0f0', paddingTop: '20px' }}>New broadcast</h3>
            <textarea
              value={bcMessage}
              onChange={e => { setBcMessage(e.target.value); setBcStatus(''); }}
              placeholder="Enter a message to broadcast…"
              rows={3}
              style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #e0e0e0', borderRadius: '8px', padding: '10px 12px', fontSize: '14px', fontFamily: 'inherit', resize: 'vertical', outline: 'none' }}
            />
            <div style={{ marginTop: '16px' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#444', marginBottom: '4px' }}>Target stores (optional)</div>
              <p style={{ margin: '0 0 10px', fontSize: '12px', color: '#888' }}>
                Leave all unchecked to show to everyone. Otherwise, only users with a saved meal at a selected store will see it.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px 12px' }}>
                {BROADCAST_STORE_OPTIONS.map((s) => {
                  const checked = bcStores.includes(s.id);
                  return (
                    <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#333', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => { setBcStatus(''); setBcStores((prev) => (checked ? prev.filter((x) => x !== s.id) : [...prev, s.id])); }}
                      />
                      {s.label}
                    </label>
                  );
                })}
              </div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '16px', fontSize: '13px', color: '#333', cursor: 'pointer' }}>
              <input type="checkbox" checked={bcForceShow} onChange={() => { setBcStatus(''); setBcForceShow((v) => !v); }} />
              Show on every launch (ignore dismissal)
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '16px' }}>
              <button
                onClick={addBroadcast}
                disabled={bcSaving}
                style={{ background: '#dd0031', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 20px', fontSize: '14px', fontWeight: 600, cursor: bcSaving ? 'not-allowed' : 'pointer', opacity: bcSaving ? 0.7 : 1 }}
              >
                {bcSaving ? 'Adding…' : 'Add broadcast'}
              </button>
              {bcStatus && (
                <span style={{ fontSize: '13px', color: bcStatus === 'Added.' ? '#16a34a' : '#dd0031' }}>
                  {bcStatus}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Automation Tab — add-to-cart reliability funnel + remote store config */}
        {tab === 'automation' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

            {/* ── Funnel ─────────────────────────────────────────────────── */}
            <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
              <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Add-to-cart funnel</h2>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {[7, 14, 30].map((d) => (
                    <button
                      key={d}
                      onClick={() => { setFunnelDays(d); loadFunnel(d); }}
                      style={{
                        border: '1px solid ' + (funnelDays === d ? '#dd0031' : '#e0e0e0'),
                        background: funnelDays === d ? '#fff1f3' : 'white',
                        color: funnelDays === d ? '#dd0031' : '#666',
                        borderRadius: '6px', padding: '4px 12px', fontSize: '13px', cursor: 'pointer',
                        fontWeight: funnelDays === d ? 600 : 400,
                      }}
                    >
                      {d}d
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => loadFunnel()}
                  style={{ marginLeft: 'auto', border: '1px solid #e0e0e0', background: 'white', borderRadius: '6px', padding: '4px 12px', fontSize: '13px', cursor: 'pointer', color: '#666' }}
                >
                  Refresh
                </button>
              </div>

              {!funnel && <p style={{ padding: '24px', color: '#888', fontSize: '14px', margin: 0 }}>Loading…</p>}

              {funnel && funnel.confirmRateAlerting?.length > 0 && (
                <div style={{ margin: '16px 24px 0', padding: '12px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', fontSize: '13px', color: '#b91c1c' }}>
                  <strong>Confirm rate below threshold:</strong> {funnel.confirmRateAlerting.join(', ')}
                </div>
              )}

              {/* Its own banner for the same reason the email gives it its own
                  line: this is not "these stores are bad" but "these stores got
                  worse", which is the shape a renamed selector makes and the one
                  an absolute floor cannot see. It is also the only condition that
                  can see the stores with no per-item step rows at all
                  (MEAL-122) — it is read off run rows every store writes. */}
              {funnel && funnel.successDropAlerting?.length > 0 && (
                <div style={{ margin: '16px 24px 0', padding: '12px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', fontSize: '13px', color: '#b91c1c' }}>
                  <strong>Item success has fallen away from normal:</strong> {funnel.successDropAlerting.join(', ')}. More
                  than {DEFAULT_ITEM_SUCCESS_DROP_THRESHOLD * 100} points below each store&apos;s own trailing 7-day
                  median. Compare the Item success tile with its median, not with the other stores.
                </div>
              )}

              {/* Its own banner, because it is its own failure and the confirm
                  rate cannot see it: blocked clicks leave that denominator, so a
                  store with nearly all of its runs walled off reports a healthy
                  confirm rate on the few that got through. */}
              {funnel && funnel.blockedAlerting?.length > 0 && (
                <div style={{ margin: '16px 24px 0', padding: '12px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', fontSize: '13px', color: '#b91c1c' }}>
                  <strong>Runs being walled off:</strong> {funnel.blockedAlerting.join(', ')}. A large share of
                  these stores&apos; runs hit a WAF or robot wall. Nothing to the left of the WAF tile can show
                  this — blocked clicks are excluded from those rates on purpose — so judge these stores on
                  terminal success, not on their confirm rate.
                </div>
              )}

              {funnel && funnel.truncated && (
                <div style={{ margin: '16px 24px 0', padding: '12px 16px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '8px', fontSize: '13px', color: '#92400e' }}>
                  Showing a partial window — the row cap was hit. Every number below is an
                  undercount. Narrow the range or filter to one store.
                </div>
              )}

              {/* The most important caveat on the page, so it sits above the data
                  rather than inside a card someone has to scroll to. */}
              {funnel && funnel.partialInstrumentation.length > 0 && (
                <div style={{ margin: '16px 24px 0', padding: '12px 16px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '8px', fontSize: '13px', color: '#92400e' }}>
                  <strong>Funnel has no middle for:</strong> {funnel.partialInstrumentation.join(', ')}.
                  No <code>search</code>, <code>candidates</code>, <code>add_click</code> or{' '}
                  <code>confirm</code> rows at all — so the funnel is{' '}
                  <code>login_check → (nothing) → reconcile</code>. Two known causes: the parallel and
                  pre-search add pools emit no per-item steps (MEAL-122, and they are on for HEB,
                  Walmart, Amazon Fresh and Albertsons), and Kroger adds through the public API rather
                  than the WebView, so it reports no steps at all. Either way a clean funnel here means{' '}
                  <em>no data</em>, not no failures — judge these stores on terminal success and items
                  added, not on the step table.
                </div>
              )}

              {funnel && funnel.stores.length === 0 && (
                <p style={{ padding: '24px', color: '#888', fontSize: '14px', margin: 0 }}>
                  No runs in the last {funnel.days} day{funnel.days === 1 ? '' : 's'}.
                </p>
              )}

              {funnel && funnel.stores.map((s) => {
                // The step the eye should go to first — or an explicit reason
                // there isn't one. The rules (a 20-attempt floor, ranking by the
                // optimistic reading rather than the raw rate, and no answer at
                // all for a store whose per-item funnel isn't instrumented) live
                // in lib/automation-funnel.ts with the tests that pin them.
                const worst = worstStep(s);
                // `?? []` only for a response served from before this deploy.
                const reasons = s.alertReasons ?? [];
                const badges = reasons.map((r) => ALERT_REASON_BADGE[r]).filter(Boolean);
                const worstNote =
                  worst.kind === 'dying'
                    ? `${pct(worst.okRate)} ok over ${worst.attempted}`
                    : worst.kind === 'unmeasured'
                      ? 'per-item steps not reported for this store'
                      : worst.kind === 'insufficient_sample'
                        ? 'no step with a usable sample (20+ attempts)'
                        : 'no step convincingly below 90%';

                return (
                <div key={s.storeId} data-testid={`funnel-store-${s.storeId}`} style={{ borderTop: '1px solid #f0f0f0', padding: '20px 24px' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
                    <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>{s.storeId}</h3>
                    {s.alerting && (
                      <span
                        title={badges.map((b) => b.title).join(' ')}
                        style={{ background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: '999px', padding: '1px 10px', fontSize: '11px', fontWeight: 700 }}
                      >
                        {/* Every reason, named. An unlabelled badge sends someone
                            to the wrong number, and so does a labelled one that
                            leaves a reason out: a store already known to be
                            walled off and now also drifting is a second problem
                            with a second fix. `reasons` is empty only for a
                            response served from before this deploy. */}
                        ALERTING{badges.map((b) => ` · ${b.tag}`).join('')}
                      </span>
                    )}
                    {s.coverage.partialInstrumentation && (
                      <span style={{ background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a', borderRadius: '999px', padding: '1px 10px', fontSize: '11px', fontWeight: 700 }}>
                        NO STEP DATA
                      </span>
                    )}
                    <span style={{ fontSize: '13px', color: '#666' }}>
                      {s.runs} run{s.runs === 1 ? '' : 's'} · {s.runsSucceeded} full success · {s.runsAbandoned} abandoned
                      {/* Beside the run counts and not tucked into a tooltip: it is
                          the qualifier on every other number in this card. An
                          unverified run finished without reading the cart, so its
                          item counts are the run's own report of itself with
                          nothing able to contradict them (MEAL-190). Always shown,
                          zero included — "0 unverified" is a statement about
                          coverage, and only a number that is always there can be
                          read as one. */}
                      {' · '}
                      <span title="Runs that finished without reading the cart. Their item counts are unchecked — the cart diff is the only thing that has ever disagreed with a run.">
                        {s.runsUnverified} unverified
                      </span>
                    </span>
                    <span style={{ fontSize: '13px', color: '#666', marginLeft: 'auto' }}>
                      {s.itemsAdded}/{s.itemsRequested} items added
                      {/* Named rather than left implicit: these are subtracted
                          from the Item success denominator below (MEAL-29), so a
                          reader who cannot see them cannot make the two agree. */}
                      {s.itemsUnavailable > 0 && ` · ${s.itemsUnavailable} out of stock`}
                    </span>
                  </div>

                  {/* Headline: where is it dying, and is that new? */}
                  <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', marginBottom: '16px', alignItems: 'flex-start' }}>
                    <Metric
                      label="Terminal success"
                      value={pct(s.terminalSuccessRate)}
                      bad={s.terminalSuccessRate != null && s.terminalSuccessRate < 0.9}
                      // Unverified runs stay in this denominator and out of its
                      // numerator, so they pull the rate down exactly as a real
                      // failure would. The note says how many, because otherwise a
                      // store whose cart page starts redirecting reads as an
                      // automation regression that never happened (MEAL-190).
                      note={`${s.runsSucceeded}/${s.runs} runs`
                        + (s.runsUnverified > 0 ? ` · ${s.runsUnverified} unverified` : '')}
                    />
                    <Metric
                      label="Dying on"
                      value={worst.kind === 'dying' ? worst.step : '—'}
                      bad={worst.kind === 'dying'}
                      note={worstNote}
                    />
                    {/* The number `success_drop` fires on, shown the way the
                        alert reads it: the last 24h against this store's own
                        trailing median, not against a bar every store shares. An
                        email naming a store the page has no tile for is an
                        operator with nothing to check. */}
                    <Metric
                      label="Item success"
                      value={pct(s.itemSuccess?.recent ?? null)}
                      bad={s.itemSuccess?.drop != null && s.itemSuccess.drop > DEFAULT_ITEM_SUCCESS_DROP_THRESHOLD}
                      note={
                        (s.itemSuccess?.median != null
                          ? `24h · median ${pct(s.itemSuccess.median)} over ${s.itemSuccess.baselineWindows}d`
                          : '24h · too little history for a median')
                        // The sample the alert gates on, shown only when the
                        // subtraction actually moved it. Otherwise an operator
                        // reading a quiet tile has no way to tell a store with a
                        // real 24h sample from one whose sample is five items
                        // because the other twenty were off the shelf.
                        + (s.itemSuccess?.recentItemsUnavailable
                          ? ` · over ${s.itemSuccess.recentItemsJudged} of ${s.itemSuccess.recentItemsRequested} items`
                          : '')
                      }
                    />
                    <Metric label="Confirm rate" value={pct(s.confirmRate)} bad={s.confirmRate != null && s.confirmRate < DEFAULT_CONFIRM_RATE_THRESHOLD} />
                    <Metric label="First-click confirm" value={pct(s.firstClickConfirmRate)} />
                    {/* Blocks sit apart on purpose: they are excluded from every
                        rate to the left of here, because a WAF wall and a renamed
                        button need different people to fix them. */}
                    <div style={{ paddingLeft: '16px', borderLeft: '2px solid #fde68a' }}>
                      {/* A share of RUNS, so it reads as a percentage of this
                          store's traffic and cannot exceed 100%. The step count
                          stays beside it as a count, which is the only honest way
                          to show it: one walled-off run emits a blocked row per
                          item, so steps over runs is not a percentage of
                          anything — it rendered "WAF blocked 450.0%". */}
                      {/* Red at the alert's threshold, not at a second one of its
                          own: a tile that colours at a number the email does not
                          use is how a page and an inbox come to disagree. */}
                      <Metric
                        label="WAF blocked"
                        value={pct(s.blockedRate)}
                        bad={s.blockedRate != null && s.blockedRate >= DEFAULT_BLOCKED_RATE_THRESHOLD}
                        note={`${s.blocked.runs} run${s.blocked.runs === 1 ? '' : 's'} walled off · ${s.blocked.steps} blocked step${s.blocked.steps === 1 ? '' : 's'} · excluded from the rates left`}
                      />
                    </div>
                  </div>

                  {/* Week over week + 30-day trend, side by side. */}
                  <div style={{ display: 'flex', gap: '32px', flexWrap: 'wrap', marginBottom: '16px', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontSize: '11px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>
                        Terminal success, daily
                      </div>
                      <TrendSparkline daily={s.daily} />
                    </div>
                    <div>
                      <div style={{ fontSize: '11px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>
                        Week over week
                      </div>
                      {s.weekOverWeek ? (
                        <div style={{ fontSize: '13px', color: '#666', lineHeight: 1.7 }}>
                          <div>
                            <strong style={{ color: (s.weekOverWeek.terminalSuccessRateDelta ?? 0) < -0.05 ? '#b91c1c' : '#333' }}>
                              {delta(s.weekOverWeek.terminalSuccessRateDelta)}
                            </strong>{' '}
                            terminal success
                          </div>
                          <div>
                            this week {pct(s.weekOverWeek.current.terminalSuccessRate)} of {s.weekOverWeek.current.runs} run
                            {s.weekOverWeek.current.runs === 1 ? '' : 's'}
                          </div>
                          <div>
                            prior week {pct(s.weekOverWeek.previous.terminalSuccessRate)} of {s.weekOverWeek.previous.runs} run
                            {s.weekOverWeek.previous.runs === 1 ? '' : 's'}
                          </div>
                          <div style={{ color: '#999' }}>
                            blocks {s.weekOverWeek.current.blocked} vs {s.weekOverWeek.previous.blocked} · failures{' '}
                            {s.weekOverWeek.current.failures} vs {s.weekOverWeek.previous.failures}
                          </div>
                        </div>
                      ) : (
                        <p style={{ fontSize: '13px', color: '#aaa', margin: 0, maxWidth: '260px' }}>
                          Needs a 14-day window or wider — a seven-day fetch has no prior week to
                          compare against, and half a week of data would invent a regression.
                        </p>
                      )}
                    </div>
                  </div>

                  {s.coverage.partialInstrumentation ? (
                    <p style={{ fontSize: '13px', color: '#92400e', margin: '0 0 12px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '8px', padding: '10px 14px' }}>
                      This store reported no <code>search</code>, <code>candidates</code>, <code>add_click</code> or{' '}
                      <code>confirm</code> rows at all — the parallel-add blind spot (MEAL-122), or a store
                      that never runs the WebView engine. Not a flawless run: whatever is below cannot tell
                      you where this store is dying.
                    </p>
                  ) : s.coverage.missingSteps.length > 0 ? (
                    <p style={{ fontSize: '12px', color: '#999', margin: '0 0 12px' }}>
                      No rows for {s.coverage.missingSteps.join(', ')} in this window — either the run
                      never got that far, or that pool does not report.
                    </p>
                  ) : null}

                  {s.steps.length === 0 ? (
                    <p style={{ fontSize: '13px', color: '#888', margin: 0 }}>
                      No step telemetry at all in this window — a store that adds through the public API,
                      a pool that reports nothing, or a build that predates step reporting. The runs above
                      are real; there is simply nothing to break down.
                    </p>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '720px' }}>
                        <thead>
                          <tr style={{ textAlign: 'left', color: '#888', fontSize: '12px' }}>
                            <th style={{ padding: '6px 8px' }}>Step</th>
                            <th style={{ padding: '6px 8px' }} title="Rows where the automation got to try — blocked rows excluded">Attempted</th>
                            <th style={{ padding: '6px 8px' }}>OK</th>
                            <th style={{ padding: '6px 8px' }}>Failures</th>
                            <th style={{ padding: '6px 8px' }} title="WAF/robot walls; never counted as a failure">Blocked</th>
                            <th style={{ padding: '6px 8px' }}>Why (code)</th>
                            <th style={{ padding: '6px 8px' }}>p50</th>
                            <th style={{ padding: '6px 8px' }}>p95</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.steps.map((st) => (
                            <tr
                              key={st.step}
                              style={{
                                borderTop: '1px solid #f5f5f5',
                                background: worst.kind === 'dying' && st.step === worst.step ? '#fff8f8' : undefined,
                              }}
                            >
                              <td style={{ padding: '6px 8px', fontWeight: 600 }}>{st.step}</td>
                              <td style={{ padding: '6px 8px' }}>
                                {st.attempted}
                                {st.blocked > 0 && <span style={{ color: '#aaa' }}> / {st.total}</span>}
                              </td>
                              <td style={{ padding: '6px 8px', color: st.okRate != null && st.okRate < 0.9 ? '#b91c1c' : '#333' }}>
                                {pct(st.okRate)}
                              </td>
                              <td style={{ padding: '6px 8px', color: '#666' }}>
                                {st.failures}
                                {st.failures > 0 && (
                                  <span style={{ color: '#999' }}>
                                    {' '}
                                    ({Object.entries(st.outcomes)
                                      .filter(([k]) => k !== 'ok' && k !== 'blocked')
                                      .map(([k, v]) => `${k} ${v}`)
                                      .join(', ')})
                                  </span>
                                )}
                              </td>
                              <td style={{ padding: '6px 8px', color: st.blocked > 0 ? '#92400e' : '#ccc' }}>{st.blocked || '—'}</td>
                              <td style={{ padding: '6px 8px' }}><CodeChips codes={st.codes} /></td>
                              <td style={{ padding: '6px 8px', color: '#666' }}>{ms(st.p50DurationMs)}</td>
                              <td style={{ padding: '6px 8px', color: '#666' }}>{ms(st.p95DurationMs)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div style={{ marginTop: '12px', display: 'flex', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap', fontSize: '12px', color: '#888' }}>
                    <span style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>All failures</span>
                    <CodeChips codes={s.failureCodes} empty="none in this window" />
                    {s.coverage.uncodedFailures > 0 && (
                      <span style={{ color: '#999' }}>
                        — {s.coverage.uncodedFailures} of them predate the code taxonomy and can never be attributed.
                      </span>
                    )}
                  </div>

                  {Object.keys(s.runSummaryCodes).length > 0 && (
                    <div style={{ marginTop: '8px', display: 'flex', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap', fontSize: '12px', color: '#888' }}>
                      <span style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>run_summary says</span>
                      <CodeChips codes={s.runSummaryCodes} />
                      <span style={{ color: '#999' }}>
                        — the run&apos;s MOST FREQUENT code, not its most severe (MEAL-123). Three
                        confirm_failed and one waf_block reports confirm_failed. Trust the per-step
                        codes above over this.
                      </span>
                    </div>
                  )}
                </div>
                );
              })}
            </div>

            {/* ── Per-run drilldown ──────────────────────────────────────── */}
            {/* Directly under the funnel, because it is the next question: the
                funnel names the step a store is dying on and cannot show you a
                single one of the runs that died. The store list is passed from the
                funnel response so the picker offers the stores that actually have
                traffic rather than the full 35-store broadcast list. */}
            <AdminRunDrilldown stores={(funnel?.stores ?? []).map((s) => s.storeId)} />

            {/* ── Remote config ──────────────────────────────────────────── */}
            <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
              <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0' }}>
                <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Store config</h2>
                <p style={{ margin: '6px 0 0', fontSize: '13px', color: '#888' }}>
                  Partial overrides on top of the app&apos;s bundled defaults. Publishing creates a new
                  version and activates it; clients pick it up on their next launch. Keys the app
                  does not recognize, and values outside their safe range, are ignored by the client.
                </p>
              </div>

              <div style={{ padding: '20px 24px' }}>
                <textarea
                  value={configDraft}
                  onChange={(e) => { setConfigMsg(null); setConfigDraft(e.target.value); }}
                  spellCheck={false}
                  placeholder={'{\n  "stores": {\n    "albertsons": {\n      "selectors": { "atc": "button[aria-label^=Add]" }\n    }\n  }\n}'}
                  style={{
                    width: '100%', minHeight: '220px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: '13px', padding: '12px', border: '1px solid #e0e0e0', borderRadius: '8px',
                    resize: 'vertical', boxSizing: 'border-box',
                  }}
                />
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginTop: '12px', flexWrap: 'wrap' }}>
                  <input
                    value={configNotes}
                    onChange={(e) => setConfigNotes(e.target.value)}
                    placeholder="What changed and why (shown in version history)"
                    style={{ flex: 1, minWidth: '240px', padding: '8px 12px', border: '1px solid #e0e0e0', borderRadius: '8px', fontSize: '13px', boxSizing: 'border-box' }}
                  />
                  <button
                    onClick={publishConfig}
                    disabled={actionLoading === 'publish-config'}
                    style={{ background: '#dd0031', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 20px', fontSize: '14px', fontWeight: 600, cursor: actionLoading === 'publish-config' ? 'not-allowed' : 'pointer', opacity: actionLoading === 'publish-config' ? 0.7 : 1 }}
                  >
                    Publish
                  </button>
                </div>
                {configMsg && (
                  <p style={{ margin: '12px 0 0', fontSize: '13px', color: configMsg.startsWith('Failed') || configMsg.startsWith('Invalid') ? '#b91c1c' : '#16a34a' }}>
                    {configMsg}
                  </p>
                )}
              </div>

              {configVersions.length > 0 && (
                <div style={{ borderTop: '1px solid #f0f0f0', padding: '16px 24px' }}>
                  <h3 style={{ margin: '0 0 10px', fontSize: '13px', color: '#888', fontWeight: 600 }}>Version history</h3>
                  {configVersions.map((v) => (
                    <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 0', borderTop: '1px solid #f8f8f8', fontSize: '13px', flexWrap: 'wrap' }}>
                      <strong style={{ minWidth: '40px' }}>v{v.version}</strong>
                      {v.is_active && (
                        <span style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0', borderRadius: '999px', padding: '1px 10px', fontSize: '11px', fontWeight: 700 }}>
                          ACTIVE
                        </span>
                      )}
                      <span style={{ color: '#888' }}>{new Date(v.created_at).toLocaleString()}</span>
                      <span style={{ color: '#666', flex: 1, minWidth: '160px' }}>{v.notes ?? '—'}</span>
                      <button
                        onClick={() => setConfigDraft(JSON.stringify(v.config, null, 2))}
                        style={{ border: '1px solid #e0e0e0', background: 'white', borderRadius: '6px', padding: '3px 10px', fontSize: '12px', cursor: 'pointer', color: '#666' }}
                      >
                        Load
                      </button>
                      {!v.is_active && (
                        <button
                          onClick={() => activateConfigVersion(v.version)}
                          disabled={actionLoading === `activate-${v.version}`}
                          style={{ border: '1px solid #dd0031', background: 'white', borderRadius: '6px', padding: '3px 10px', fontSize: '12px', cursor: 'pointer', color: '#dd0031' }}
                        >
                          Activate
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
