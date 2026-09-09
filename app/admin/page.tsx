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
import { withoutRetiredStoreIds, withoutRetiredStores } from '@/lib/retired-stores';
import AdminSyncPanel from '@/components/AdminSyncPanel';
import AdminImportSpend from '@/components/AdminImportSpend';
import AdminReviewQueue from '@/components/AdminReviewQueue';
import { TrendSparkline, CodeChips, DayPoint } from '@/components/AdminFunnelChart';
// Type-only: the aggregation itself runs on the server, and this is the shape
// it answers with. Erased at compile time.
import type { NetworkStoreStats } from '@/lib/automation-network-stats';
// Type-only: the aggregation runs on the server; this is the shape it answers with.
import type { SpendBucket } from '@/lib/import-spend';
import AdminCanary from '@/components/AdminCanary';
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
  type AlertReason,
} from '@/lib/automation-funnel';

/**
 * The leaf a click lands on. Every one of these was a top-level tab of its own
 * until the bar grew to ten and stopped being scannable; what changed is the
 * navigation above them, not the screens.
 *
 * Three are gone rather than moved. `review` is now a subsection of each
 * creator's card on Creator integrations — a queue that spans creators answered
 * "what is waiting" and could not answer "what is waiting on THIS creator",
 * which is the question an operator looking at a creator actually has. `meals`
 * and `storage` were removed outright; the storage routes still exist and are
 * still admin-only, they simply have no screen.
 */
type Tab = 'applications' | 'sources' | 'sync' | 'stats' | 'email' | 'broadcast' | 'automation';

type Section = 'creators' | 'marketing' | 'health';

/**
 * The two-level bar, declared once so the sections, the subtabs and the
 * section-of-a-tab lookup below cannot drift apart.
 *
 * A section with one tab draws no subtab row: Health Dashboard is a single
 * screen, and a row of tabs containing one tab is a control with no choice in it.
 */
const SECTIONS: ReadonlyArray<{ id: Section; label: string; tabs: ReadonlyArray<{ id: Tab; label: string }> }> = [
  {
    id: 'creators',
    label: 'Creators',
    tabs: [
      { id: 'applications', label: 'Creator applications' },
      { id: 'sources', label: 'Creator integrations' },
      { id: 'sync', label: 'Manual sync' },
    ],
  },
  {
    id: 'marketing',
    label: 'Marketing',
    tabs: [
      { id: 'stats', label: 'Sign Ups and Saves' },
      { id: 'email', label: 'Emails' },
      { id: 'broadcast', label: 'Broadcast' },
    ],
  },
  {
    id: 'health',
    label: 'Health Dashboard',
    tabs: [{ id: 'automation', label: 'Health Dashboard' }],
  },
];

/** Which section a leaf belongs to, derived so it cannot disagree with the bar. */
const SECTION_OF = new Map<Tab, Section>(
  SECTIONS.flatMap(section => section.tabs.map(tab => [tab.id, section.id] as const)),
);

// Store options for broadcast targeting (id → label).
const BROADCAST_STORE_OPTIONS: { id: string; label: string }[] = [
  { id: 'heb', label: 'H-E-B' }, { id: 'walmart', label: 'Walmart' }, { id: 'kroger', label: 'Kroger' },
  { id: 'aldi', label: 'ALDI' }, { id: 'albertsons', label: 'Albertsons' },
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

// MEAL-219. The request view, straight from lib/automation-requests.ts.
interface RequestsResponse {
  days: number;
  since: string;
  truncated: boolean;
  rowsScanned: number;
  stores: Array<{
    storeId: string;
    rails: string[];
    requests: number;
    statuses: Array<{ bucket: string; count: number }>;
    okRate: number | null;
    retryRate: number | null;
    retrySuccessRate: number | null;
    phases: Array<{ phase: string; requests: number; okRate: number | null; failures: number; p50: number | null; p95: number | null }>;
    codes: Array<{ code: string; count: number }>;
  }>;
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

/**
 * `GET /api/admin/automation-network` — the same `automation_steps` rows the
 * funnel counted, read through the columns the network rail actually writes.
 *
 * Its coverage block is load-bearing rather than decoration, and it is why this
 * panel says how many rows could answer before it says what they answered: every
 * row written before MEAL-219 shipped carries NULL in `http_status`, `phase` and
 * `attempts`, and a rate computed over the rows that can answer is a rate about a
 * different window than the one the header names.
 */
interface NetworkResponse {
  days: number;
  rowsScanned: number;
  truncated: boolean;
  coverage: { rowsWithStatus: number; rowsWithPhase: number; rowsWithAttempts: number };
  stores: NetworkStoreStats[];
  headlines: string[];
}

/**
 * A creator with no imports in the window, as opposed to one not read yet.
 *
 * `spendByCreator` only holds creators who spent something, so a creator absent
 * from it has genuinely spent nothing — which is a fact, and different from the
 * read not having happened. Both used to render as the same dash.
 */
const EMPTY_SPEND: SpendBucket = {
  imports: 0, rejected: 0, cached: 0,
  costUsd: 0, gateCostUsd: 0, extractCostUsd: 0,
  medianTokens: { gateInput: null, gateOutput: null, extractInput: null, extractOutput: null },
};

/** The walls, which get colour. A spike here is a campaign, not a bug. */
const WALL = new Set(['403', '429', '412', '418']);

function statusColour(label: string): string {
  if (WALL.has(label)) return '#dd0031';
  if (label === '5xx') return '#e8710a';
  if (label === '401') return '#8b5cf6';
  if (label === '2xx') return '#0f9d58';
  return '#9aa0a6';
}

/** A whole-number percentage. The funnel's `pct` keeps a decimal; this does not. */
const wholePct = (n: number) => `${Math.round(n * 100)}%`;

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
  /**
   * Drafts of this creator's still waiting on somebody, whichever queue.
   *
   * `null` when the walk behind it came back short — drawn as “—”, never as a
   * nought, because a nought here reads as "nothing to review" and is the one
   * answer that stops an operator opening the subsection.
   */
  pendingDraftCount?: number | null;
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
  pendingDrafts: 'the pending draft counts on each creator',
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
      <strong>Incomplete data. This screen is showing less than it was asked for.</strong>{' '}
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

function PollHealthPanel({
  health, now, pendingDrafts, spend, spendDays,
}: {
  health: CreatorPollHealth;
  now: number;
  pendingDrafts: number | null | undefined;
  spend: SpendBucket | null;
  spendDays: number;
}) {
  const kind = pollStatus(health, now);
  const style = POLL_STATUS_STYLES[kind];

  // Nothing is broken about a creator nobody has set polling up for, so they get
  // a grey sentence rather than a panel of empty columns and a "never polled"
  // that reads like a failure.
  //
  // Pending drafts join that test because they do not have to come from polling:
  // a manual sync queues drafts for a creator nobody polls, and "nothing here is
  // broken, there is nothing to report" is false while some of them are waiting.
  // Only a POSITIVE count keeps the panel open — a `null` we could not read is
  // already reported by the banner at the top of the tab, and the collapsed
  // subsection below this says the same number either way.
  if (kind === 'unconfigured' && !health.lastPolledAt && health.draftedCount === 0
      && !pendingDrafts && !spend?.imports) {
    return (
      <p data-testid={`poll-health-${health.creatorId}`} style={{ margin: '4px 0 16px', fontSize: '12px', color: '#aaa' }}>
        No source is being polled for this creator. Nothing here is broken, there is just nothing to report yet.
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
              ? 'Polling is fine and this source is producing nothing: the failure no other column shows.'
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
        {/* Beside the two lifetime counts because it is the third state of the
            same thing — drafted, published, and the ones still in between. The
            other two are history; this is the only one anybody can act on, and
            the subsection that acts on it is directly below. */}
        <Figure
          label="Pending drafts"
          value={pendingDrafts == null ? '—' : String(pendingDrafts)}
          note={pendingDrafts == null ? 'could not be counted' : 'waiting on a decision'}
        />
        {/* MEAL-222, moved onto the card. It used to live only on Manual sync
            as one number per ACTOR TYPE — creators against users — which answers
            a platform question. Beside the drafts it answers the one actually
            asked while looking at a creator: what did THIS creator's imports
            cost, and what did the money buy. */}
        <Figure
          label={`Import spend (${spendDays}d)`}
          value={spend == null ? '—' : `$${spend.costUsd.toFixed(4)}`}
          note={spend == null
            ? 'not read'
            : spend.imports === 0
              ? 'no imports in this window'
              : `${spend.imports} attempt${spend.imports === 1 ? '' : 's'}`
                + (spend.rejected > 0 ? ` · ${spend.rejected} rejected` : '')
                + (spend.cached > 0 ? ` · ${spend.cached} free from cache` : '')}
        />
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

/**
 * One creator's pending drafts, folded into their card (was the Review tab).
 *
 * COLLAPSED BY DEFAULT, and that is what makes this affordable. The queue it
 * mounts is the same component the standalone tab was — cards, flag groups,
 * approve / send / edit / decline — and mounting one per creator eagerly would
 * be one full queue read per card on every visit to the tab. Nothing fetches
 * until somebody opens it, so a tab with thirty creators on it costs the same as
 * it did before this existed.
 *
 * The count in the header comes from the creator list rather than from the queue
 * below it, which is the only way it can be shown while closed. `onChanged`
 * exists so it does not go stale the moment a draft is decided: a header saying
 * "3" over a list of two is worse than a header saying nothing.
 */
function CreatorDrafts({
  creatorId, count, onChanged,
}: { creatorId: string; count: number | null | undefined; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const label = count == null ? 'Pending drafts' : `Pending drafts (${count})`;

  return (
    <div
      data-testid={`creator-drafts-${creatorId}`}
      style={{ margin: '4px 0 16px', border: '1px solid #f0f0f0', borderRadius: '10px', background: '#fcfcfc' }}
    >
      <button
        onClick={() => setOpen(prev => !prev)}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '10px 14px',
          background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
          fontSize: '13px', fontWeight: 700, color: count ? '#b45309' : '#666',
        }}
      >
        <span aria-hidden style={{ fontSize: '10px', color: '#aaa' }}>{open ? '▼' : '▶'}</span>
        {label}
        <span style={{ fontWeight: 400, fontSize: '12px', color: '#aaa' }}>
          {count === 0
            ? 'nothing waiting'
            : count == null
              ? 'the count could not be read'
              : 'not live until approved'}
        </span>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid #f0f0f0', padding: '14px' }}>
          <AdminReviewQueue creatorId={creatorId} onChanged={onChanged} />
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
  /**
   * What each creator's imports have cost, over the last 30 days (MEAL-222).
   *
   * One read for the whole tab, keyed by creator id, rather than a request per
   * card — same reason the pending-draft counts are read that way. The full
   * breakdown with a window selector stays on Manual sync; a card wants the
   * number, not the dashboard.
   */
  const [spendByCreator, setSpendByCreator] = useState<Record<string, SpendBucket> | null>(null);
  const [spendDays, setSpendDays] = useState(30);
  const [stats, setStats] = useState<Stats | null>(null);
  const [selectedQuarter, setSelectedQuarter] = useState<AvailableQuarter | null>(null);
  const [emailStats, setEmailStats] = useState<EmailStats | null>(null);
  const [emailSearch, setEmailSearch] = useState('');

  const [funnel, setFunnel] = useState<FunnelResponse | null>(null);
  // MEAL-219. The served rate and the per-phase latencies, drawn on each store's
  // own card rather than in a panel of their own.
  const [requests, setRequests] = useState<RequestsResponse | null>(null);
  const [requestsErr, setRequestsErr] = useState<string | null>(null);
  // The network rail's read of the same rows, folded into the per-store cards
  // rather than sitting in a panel of its own (it was `AdminNetworkStats`). The
  // run-level facts and the request-level facts are one story about one store,
  // and they were two cards a screen apart.
  const [network, setNetwork] = useState<NetworkResponse | null>(null);
  const [networkErr, setNetworkErr] = useState<string | null>(null);
  // 30 by default: the trend line and the week-over-week comparison both need a
  // window wider than the week being judged, and this is the view the ticket's
  // "is HEB worse than last week" question is actually asked from.
  //
  // ONE window for all three reads. Runs, steps and requests are three readings
  // of the same traffic, and two selectors over them is a card whose halves are
  // answers about different fortnights with nothing on screen saying so.
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

  const loadCreatorSpend = async (days = spendDays) => {
    const res = await fetch(`/api/admin/import-spend?days=${days}`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    if (!res.ok) { setSpendByCreator({}); return; }
    const data = await res.json().catch(() => null);
    // `{}` rather than null on a failure: null means "not read yet" and the card
    // says nothing at all, which is the right thing while it is in flight and the
    // wrong thing forever after.
    setSpendByCreator(data?.byCreator ?? {});
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
    if (!res.ok) return;
    const data = (await res.json()) as FunnelResponse;
    // Retired stores lose their card AND their name in the banners above it. A
    // banner that names a store with no card below it sends an operator looking
    // for something that is not on the page. The window totals are left alone:
    // they describe the read, and shrinking them to match a filtered list makes
    // the two disagree with nothing saying which is right.
    setFunnel({
      ...data,
      stores: withoutRetiredStores(data.stores),
      confirmRateAlerting: withoutRetiredStoreIds(data.confirmRateAlerting),
      blockedAlerting: withoutRetiredStoreIds(data.blockedAlerting),
      successDropAlerting: withoutRetiredStoreIds(data.successDropAlerting),
    });
  };

  const loadNetwork = async (days = funnelDays) => {
    setNetworkErr(null);
    const res = await fetch(`/api/admin/automation-network?days=${days}`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    if (!res.ok) { setNetworkErr(`Could not read the network rail (${res.status})`); return; }
    const data = (await res.json()) as NetworkResponse;
    // Retired stores keep their rows and lose their card. `rowsScanned` and the
    // coverage counts are left alone deliberately: they describe the read, and
    // quietly shrinking them to match a filtered list would make the two
    // disagree with nothing on screen saying which was wrong.
    setNetwork({ ...data, stores: withoutRetiredStores(data.stores) });
  };

  const loadRequests = async (days = funnelDays) => {
    setRequestsErr(null);
    const res = await fetch(`/api/admin/automation-requests?days=${days}`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    const data = await res.json().catch(() => null);
    // Retired stores lose their panel. `data` is still allowed to be null here —
    // a 200 whose body would not parse — and a `{ stores: [] }` stand-in would
    // draw "no request rows in the last undefined days" as though it were an
    // answer, so that case stays exactly as it was.
    if (res.ok) { setRequests(data ? { ...data, stores: withoutRetiredStores(data.stores) } : null); return; }
    // A 409 means the migration has not been run. That is a specific, fixable
    // thing and the page should say which file, not render "something broke".
    setRequestsErr(data?.error ?? 'Failed to load request telemetry');
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
    if (t === 'sources' && !spendByCreator) loadCreatorSpend();
    if (t === 'sync' && creators.length === 0) loadCreators();
    if (t === 'stats' && !stats) loadStats();
    if (t === 'broadcast') loadBroadcasts();
    if (t === 'email' && !emailStats) loadEmailStats();
    if (t === 'automation') {
      if (!funnel) loadFunnel();
      if (!network && !networkErr) loadNetwork();
      if (!requests && !requestsErr) loadRequests();
      if (configVersions.length === 0) loadAutomationConfig();
    }
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

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5' }}>
        <p style={{ color: '#888' }}>Loading…</p>
      </div>
    );
  }

  const section = SECTION_OF.get(tab) ?? 'creators';
  const activeSection = SECTIONS.find(s => s.id === section)!;

  const sectionStyle = (id: Section): React.CSSProperties => ({
    padding: '10px 20px',
    border: 'none',
    borderBottom: section === id ? '2px solid #dd0031' : '2px solid transparent',
    background: 'none',
    fontWeight: section === id ? 700 : 500,
    color: section === id ? '#dd0031' : '#666',
    cursor: 'pointer',
    fontSize: '15px',
  });

  const subTabStyle = (t: Tab): React.CSSProperties => ({
    padding: '7px 14px',
    border: '1px solid ' + (tab === t ? '#f5c2cb' : 'transparent'),
    borderRadius: '99px',
    background: tab === t ? '#fff1f3' : 'none',
    fontWeight: tab === t ? 700 : 400,
    color: tab === t ? '#dd0031' : '#666',
    cursor: 'pointer',
    fontSize: '13px',
  });

  // One instant for the whole Sources tab, so the order and every "4 days ago"
  // on it are answers to the same "now".
  const pollNow = Date.now();
  const sourcesByConcern = byConcernFirst(creators, pollNow);

  // The run half and the request half of each store, joined for the merged card.
  // Keyed rather than searched: this is one lookup per store card, and a `find`
  // inside the map would be quadratic over a list that grows with the catalogue.
  const netByStore = new Map((network?.stores ?? []).map(n => [n.storeId, n]));
  // Stores the rail saw and the runs did not. Named on the page rather than
  // dropped — a store missing from a health screen reads as a store with nothing
  // wrong, which is the one thing this page must never say by omission.
  const funnelStoreIds = new Set((funnel?.stores ?? []).map(f => f.storeId));
  const networkOnlyStores = (network?.stores ?? [])
    .map(n => n.storeId)
    .filter(id => !funnelStoreIds.has(id));
  // The third read of the same traffic. `automation-network` and
  // `automation-requests` aggregate the same table and neither is a superset:
  // the first knows how many rows could not answer, which codes each phase died
  // on and how many retries there were; the second knows the served rate and the
  // p50/p95 of each phase. Both are on the card, from the store's own row.
  const reqByStore = new Map((requests?.stores ?? []).map(r => [r.storeId, r]));

  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      {/* Header */}
      <div style={{ background: 'linear-gradient(160deg, #c40029 0%, #dd0031 55%, #e8193a 100%)', color: 'white', padding: '20px 24px', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button onClick={() => router.push('/discover')} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '14px', opacity: 0.8 }}>
          ← Dashboard
        </button>
        <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 700 }}>Admin</h1>
      </div>

      {/* Sections. Clicking one lands on its first subtab rather than on a
          landing page: every section here is a set of screens, and an
          intermediate page whose only content is links to three tabs is a click
          nobody wanted. */}
      <div style={{ background: 'white', borderBottom: '1px solid #e0e0e0', display: 'flex', paddingLeft: '24px' }}>
        {SECTIONS.map(entry => (
          <button key={entry.id} style={sectionStyle(entry.id)} onClick={() => switchTab(entry.tabs[0].id)}>
            {entry.label}
          </button>
        ))}
      </div>

      {/* Subtabs, and only where there is a choice to make. Health Dashboard is
          one screen; a row of tabs containing one tab is a control with nothing
          in it. */}
      {activeSection.tabs.length > 1 && (
        <div style={{ background: '#fafafa', borderBottom: '1px solid #eee', display: 'flex', gap: '6px', padding: '8px 24px' }}>
          {activeSection.tabs.map(entry => (
            <button key={entry.id} style={subTabStyle(entry.id)} onClick={() => switchTab(entry.id)}>
              {entry.label}
            </button>
          ))}
        </div>
      )}

      {/* The Health Dashboard is two columns of panels; everything else is a
          single column of forms and tables that reads worse the wider it gets. */}
      <div style={{ maxWidth: tab === 'automation' ? '1500px' : '1000px', margin: '32px auto', padding: '0 20px' }}>

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
              rather than as having no source. The two look identical on a row and mean
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
                  {creator.pollHealth && (
                    <PollHealthPanel
                      health={creator.pollHealth}
                      now={pollNow}
                      pendingDrafts={creator.pendingDraftCount}
                      spend={spendByCreator ? (spendByCreator[creator.id] ?? EMPTY_SPEND) : null}
                      spendDays={spendDays}
                    />
                  )}

                  {/* What has arrived and not been decided, which used to be its
                      own tab spanning every creator. Directly under the counts it
                      belongs with — drafted, published, and these — and closed
                      until somebody asks, because the review queue inside it is a
                      read of its own. */}
                  <CreatorDrafts
                    creatorId={creator.id}
                    count={creator.pendingDraftCount}
                    onChanged={loadCreators}
                  />

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
                                {connected ? 'no link, read through the connection' : 'no link'}
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
                                  <div style={{ fontSize: '11px', color: '#888', marginBottom: '8px' }}>Most recent entries. Confirm these are this creator&apos;s:</div>
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
        {tab === 'sync' && (
          <>
            <AdminSyncPanel creators={creators} />
            {/* MEAL-222. What the imports on this tab have cost, split by who
                ran them, with the median token shape that makes the estimate in
                lib/import/cost.ts checkable rather than arguable. Here rather
                than on Stats because it is about the thing this tab does, and
                the operator deciding whether to sync fifty posts is the person
                who should see what the last fifty cost. */}
            <AdminImportSpend token={token() ?? ''} />
          </>
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
                    <strong>Incomplete data. Do not pay out from this screen.</strong>{' '}
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
                    <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#888' }}>Creator saves over the rolling last 12 months, sorted by share of pool</p>
                  </div>
                  {stats.leaderboard === null ? (
                    /* The read was short, so the shares are wrong for everybody — not
                       just small. Showing the table anyway is how a creator gets
                       under-paid by a number that looked plausible. */
                    <p style={{ padding: '32px 24px', color: '#b91c1c', textAlign: 'center', fontSize: '13px', margin: 0 }}>
                      Leaderboard unavailable. The creator-save read could not be completed,
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
                          Funnel unavailable. The send log could not be read in full, so every
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

        {/* Health Dashboard — per-store reliability + remote store config */}
        {tab === 'automation' && (
          /* Two columns (`min-w-0` on each, or the wide phase tables refuse to
             shrink and push the grid past the viewport), collapsing to one on a
             narrow screen. Split by what the panel is FOR rather than by height:
             the left column is the measurements — one card per store, everything
             known about it — and the right is the things that act on them: the
             nightly canary, one run walked step by step, and the config that
             changes what the next run does. */
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">

            {/* ── Left: what happened ─────────────────────────────────────── */}
            <div className="flex flex-col gap-6 min-w-0">

              {/* ── Per-store health ────────────────────────────────────────
                  One card per store, from all three reads of the same traffic:
                  the runs (terminal success, items, blocks), the network rail
                  (what the store answered, which phase asked, how hard the retry
                  policy worked), and the code taxonomy over both.

                  THIS USED TO BE TWO PANELS. "Add-to-cart funnel" counted a
                  DOM-era vocabulary — search, candidates, add_click, confirm —
                  and "Network rail" counted the same rows through the columns the
                  rail actually writes. An operator asking "is HEB healthy" read
                  two cards a screen apart and had to hold one in their head.

                  THE STEP TABLE IS GONE, and it is the only thing that was
                  deleted rather than moved. DOM automation was removed on
                  2026-09-01 and its step names went with it: HEB, Walmart and
                  Albertsons emit no per-item steps at all (the parallel and
                  pre-search add pools, MEAL-122), Kroger adds through the public
                  API and reports none, and "first-click confirm" had already been
                  deleted because the only path that set `detail.attempt` was the
                  deleted one. For every live store the table read
                  `login_check → (nothing) → reconcile`, which is not a funnel, and
                  a clean one meant NO DATA rather than no failures. Every banner
                  and badge that existed to say so went with it.

                  What survived it: `confirmRate` stays a tile, because the MEAL-6
                  alert email still fires on it and a store named in an inbox must
                  have a number on the page to check. */}
              <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
                <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                  <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Per-store health</h2>
                  {/* One selector for all three reads. Two of them over the same
                      traffic is a card whose halves answer about different
                      fortnights with nothing saying so. */}
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {[7, 14, 30].map((d) => (
                      <button
                        key={d}
                        onClick={() => { setFunnelDays(d); loadFunnel(d); loadNetwork(d); loadRequests(d); }}
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
                    onClick={() => { loadFunnel(); loadNetwork(); loadRequests(); }}
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
                    this (blocked clicks are excluded from those rates on purpose), so judge these stores on
                    terminal success, not on their confirm rate.
                  </div>
                )}

                {funnel && funnel.truncated && (
                  <div style={{ margin: '16px 24px 0', padding: '12px 16px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '8px', fontSize: '13px', color: '#92400e' }}>
                    Showing a partial window. The row cap was hit. Every number below is an
                    undercount. Narrow the range or filter to one store.
                  </div>
                )}

                {/* COVERAGE, above the numbers it qualifies. Every request-level
                    rate on these cards is computed over the rows that can answer,
                    and before MEAL-219 shipped none of them could. Its absence is
                    said out loud rather than left to read as health. */}
                {network && (
                  <div style={{ margin: '16px 24px 0', fontSize: '12px', color: '#666', lineHeight: 1.6 }} data-testid="network-coverage">
                    {network.rowsScanned.toLocaleString()} step rows in {network.days}d
                    {network.truncated && <strong style={{ color: '#e8710a' }}> · truncated, showing the most recent</strong>}
                    {' · '}carrying a status: <strong>{network.coverage.rowsWithStatus.toLocaleString()}</strong>
                    {' · '}a phase: <strong>{network.coverage.rowsWithPhase.toLocaleString()}</strong>
                    {' · '}attempts: <strong>{network.coverage.rowsWithAttempts.toLocaleString()}</strong>
                    {network.coverage.rowsWithStatus < network.rowsScanned && (
                      <span>. The rest predate the network columns and are excluded from the request rates
                        below, not counted as clean.</span>
                    )}
                  </div>
                )}

                {networkErr && (
                  <div style={{ margin: '16px 24px 0', padding: '12px 16px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '8px', fontSize: '13px', color: '#92400e' }}>
                    {networkErr}. The run-level numbers below are unaffected; the request half of each card is
                    missing rather than empty.
                  </div>
                )}

                {funnel && funnel.stores.length === 0 && (
                  <p style={{ padding: '24px', color: '#888', fontSize: '14px', margin: 0 }}>
                    No runs in the last {funnel.days} day{funnel.days === 1 ? '' : 's'}.
                  </p>
                )}

                {funnel && funnel.stores.map((s) => {
                  // `?? []` only for a response served from before this deploy.
                  const reasons = s.alertReasons ?? [];
                  const badges = reasons.map((r) => ALERT_REASON_BADGE[r]).filter(Boolean);
                  // The same store's request-level half. `undefined` is a real
                  // answer here — a store with runs and no instrumented steps —
                  // and it is drawn as a sentence rather than as empty tiles.
                  const net = netByStore.get(s.storeId);
                  const req = reqByStore.get(s.storeId);
                  // p50/p95 belong to the phase table below, and only
                  // `automation-requests` measures them.
                  const latency = new Map((req?.phases ?? []).map(ph => [ph.phase, ph]));

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
                      {/* The implementation, not the banner: fifteen Albertsons
                          banners share one, and a rail-level regression otherwise
                          reads as fifteen unrelated store problems. */}
                      {net && net.rails.length > 0 && (
                        <span style={{ fontSize: '11px', color: '#9aa0a6' }}>rail: {net.rails.join(', ')}</span>
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
                        <span title="Runs that finished without reading the cart. Their item counts are unchecked. The cart diff is the only thing that has ever disagreed with a run.">
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

                    {/* Headline: is it working, and is that new? */}
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
                      {/* "Dying on" was here and went with the step table. It was
                          `worstStep` over the per-item rows, so for every store
                          still running it answered "per-item steps not reported
                          for this store" — a tile whose only value was an excuse.
                          Where a run dies now is the phase strip below. */}
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
                      {/* The one step-vocabulary number that survived the table,
                          and only because the MEAL-6 email still fires on it: a
                          store named in an inbox has to have a number on the page
                          to check. Reads "—" for every store whose adds do not go
                          through a confirm step, which is most of them. */}
                      <Metric label="Confirm rate" value={pct(s.confirmRate)} bad={s.confirmRate != null && s.confirmRate < DEFAULT_CONFIRM_RATE_THRESHOLD} />
                      {/* Blocks sit apart on purpose: they are excluded from every
                          rate to the left of here, because a WAF wall and a broken
                          request need different people to fix them. */}
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
                            Needs a 14-day window or wider. A seven-day fetch has no prior week to
                            compare against, and half a week of data would invent a regression.
                          </p>
                        )}
                      </div>
                    </div>

                    {/* ── What the store answered ──────────────────────────── */}
                    {/* The second half of the same story, in the same card. A
                        store with runs but no instrumented rows says so: an empty
                        histogram and a 0% retry rate would both read as a store
                        behaving perfectly. */}
                    <div style={{ borderTop: '1px dashed #eee', paddingTop: '14px' }} data-testid={`store-network-${s.storeId}`}>
                      {!net || net.rows === net.rowsWithoutStatus ? (
                        <div style={{ fontSize: '12px', color: '#999' }}>
                          {networkErr
                            ? 'The network rail could not be read this time, so what this store answered is unknown rather than clean.'
                            : 'No rows carry an HTTP status yet: nothing to report rather than nothing wrong.'}
                        </div>
                      ) : (
                        <>
                          <div style={{ fontSize: '11px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>
                            What the store answered · {net.rows.toLocaleString()} rows
                            {req && ` · ${req.requests} instrumented requests`}
                          </div>

                          {/* The request-level headline. `Served` and the two
                              retry rates were a panel of their own until the
                              per-store cards absorbed it: they are three numbers
                              about the store whose card this is, and they were
                              being read a screen away from its terminal success. */}
                          {req && (
                            <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', marginBottom: '12px' }}>
                              <Metric label="Served" value={pct(req.okRate)} bad={req.okRate != null && req.okRate < 0.95} />
                              <Metric label="Asked twice" value={pct(req.retryRate)} bad={req.retryRate != null && req.retryRate > 0.1} />
                              {/* Null when nothing was retried. "0%" would read as
                                  a broken retry policy; it means there was nothing
                                  to retry. */}
                              <Metric label="Retry worked" value={pct(req.retrySuccessRate)} />
                            </div>
                          )}

                          {/* Status histogram */}
                          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                            {net.statuses.map((b) => (
                              <span
                                key={b.label}
                                title={b.label === 'none' ? 'No answer at all: dropped or aborted. Not a 5xx.' : undefined}
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

                          {/* The phase table, in the order a run walks it. This
                              is where a run dies now that the step table is gone,
                              and unlike `search` / `add_click` / `confirm` it is a
                              vocabulary every rail actually writes — `phase` was
                              added as a column precisely because `step` could not
                              answer it (one of its values is literally
                              `add_click`).

                              Two sources, one table: the counts and the failure
                              code come off the network read, the latencies off the
                              request read, and a phase missing from either is
                              blank rather than zero. */}
                          <div style={{ overflowX: 'auto', marginTop: '12px' }}>
                            <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
                              <thead>
                                <tr style={{ textAlign: 'left', color: '#888', fontSize: '12px' }}>
                                  <th style={{ padding: '4px 8px 4px 0' }}>Phase</th>
                                  <th style={{ padding: '4px 8px' }}>OK</th>
                                  <th style={{ padding: '4px 8px' }}>Failed</th>
                                  <th style={{ padding: '4px 8px' }}>Why</th>
                                  <th style={{ padding: '4px 8px' }}>p50</th>
                                  <th style={{ padding: '4px 8px' }}>p95</th>
                                </tr>
                              </thead>
                              <tbody>
                                {net.phases.map((ph) => {
                                  const lat = latency.get(ph.phase);
                                  return (
                                    <tr key={ph.phase} style={{ borderTop: '1px solid #f6f6f6' }}>
                                      <td style={{ padding: '5px 8px 5px 0', fontWeight: 600 }}>{ph.phase}</td>
                                      <td style={{ padding: '5px 8px', color: '#0f9d58' }}>{ph.ok}</td>
                                      <td style={{ padding: '5px 8px', color: ph.failed > 0 ? '#dd0031' : '#ccc' }}>{ph.failed || '—'}</td>
                                      <td style={{ padding: '5px 8px', color: '#9aa0a6' }}>{ph.topCode ?? '—'}</td>
                                      <td style={{ padding: '5px 8px', color: '#666' }}>{lat?.p50 != null ? `${lat.p50}ms` : '—'}</td>
                                      <td style={{ padding: '5px 8px', color: '#666' }}>{lat?.p95 != null ? `${lat.p95}ms` : '—'}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>

                          {/* Retry pressure, from the retry policy's own count
                              rather than from `detail.attempt` — which only the
                              deleted click path ever set. */}
                          <div style={{ fontSize: '12px', color: '#666', marginTop: '10px' }}>
                            {net.retried > 0 ? (
                              <>retried <strong>{wholePct(net.retryRate)}</strong> of answerable rows
                                {' · '}<strong>{wholePct(net.retrySuccessRate)}</strong> of those recovered
                                {' '}<span style={{ color: '#9aa0a6' }}>({net.retriedOk}/{net.retried})</span></>
                            ) : (
                              <span style={{ color: '#9aa0a6' }}>no retries recorded</span>
                            )}
                          </div>

                          {/* Legacy, in its own line so a 2026-08 selector_miss is
                              never read as a live problem. */}
                          {net.legacyCodeRows > 0 && (
                            <div style={{ fontSize: '11px', color: '#9aa0a6', marginTop: '6px' }}>
                              {net.legacyCodeRows} row{net.legacyCodeRows === 1 ? '' : 's'} carrying pre-network codes
                              (selector_miss / nav_failed) from before 2026-09-01, not live failures.
                            </div>
                          )}
                        </>
                      )}
                    </div>

                    <div style={{ marginTop: '12px', display: 'flex', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap', fontSize: '12px', color: '#888' }}>
                      <span style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>All failures</span>
                      <CodeChips codes={s.failureCodes} empty="none in this window" />
                      {s.coverage.uncodedFailures > 0 && (
                        <span style={{ color: '#999' }}>
                          {s.coverage.uncodedFailures} of them predate the code taxonomy and can never be attributed.
                        </span>
                      )}
                    </div>

                    {Object.keys(s.runSummaryCodes).length > 0 && (
                      <div style={{ marginTop: '8px', display: 'flex', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap', fontSize: '12px', color: '#888' }}>
                        <span style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>run_summary says</span>
                        <CodeChips codes={s.runSummaryCodes} />
                        <span style={{ color: '#999' }}>
                          This is the run&apos;s MOST FREQUENT code, not its most severe (MEAL-123). Three
                          confirm_failed and one waf_block reports confirm_failed. Trust the per-phase
                          codes above over this.
                        </span>
                      </div>
                    )}
                  </div>
                  );
                })}

                {/* Stores the network rail saw and the runs did not. Rare and
                    real: a run that started before this window emits steps inside
                    it. Named rather than dropped, because a store missing from a
                    health page is indistinguishable from a store with nothing
                    wrong. */}
                {networkOnlyStores.length > 0 && (
                  <p
                    style={{ margin: 0, padding: '14px 24px', borderTop: '1px solid #f0f0f0', fontSize: '12px', color: '#92400e', background: '#fffbeb' }}
                    data-testid="network-only-stores"
                  >
                    <strong>Request rows but no runs in this window:</strong> {networkOnlyStores.join(', ')}.
                    Their runs started before the window opened, so there is no card for them here. Widen the
                    range to see one.
                  </p>
                )}
              </div>

              {/* The Requests panel stood here and is now the second half of
                  each store's card above. It drew the same three facts — what the
                  store answered, which phase asked, whether the retry worked —
                  for the same stores, one panel below the numbers they qualify.
                  Its p50/p95 came with it; nothing was dropped. The
                  `automation-requests` route is unchanged and still read. */}

              {/* What the request read could not cover, kept at panel level
                  because it is a statement about that read as a whole rather than
                  about any one store. */}
              {requestsErr && (
                <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '12px', padding: '14px 20px', fontSize: '13px', color: '#92400e' }}>
                  {requestsErr}. The served rate and the phase latencies are missing from the cards above,
                  rather than showing as zero.
                </div>
              )}
              {!requestsErr && requests?.truncated && (
                <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '12px', padding: '14px 20px', fontSize: '12px', color: '#92400e' }}>
                  Request telemetry is showing a prefix, not the whole window: the read hit its page
                  ceiling, so the served rates and latencies above are computed over part of it.
                </div>
              )}

            </div>

            {/* ── Right: what to do about it ──────────────────────────────── */}
            <div className="flex flex-col gap-6 min-w-0">
              {/* ── Nightly canary (MEAL-7) ────────────────────────────────────
                  Sits with the automation data rather than in its own tab: it is
                  the same question as the panels around it, asked on a schedule
                  against a meal built to fail in known ways. */}
              <AdminCanary
                token={token}
                storeIds={['heb', 'walmart', 'aldi', 'wegmans', 'albertsons', 'publix']}
              />

              {/* ── Per-run drilldown ──────────────────────────────────────── */}
              {/* The next question after the cards opposite: they name the phase a
                  store is dying on and cannot show you a single one of the runs
                  that died. The store list is passed from the funnel response so
                  the picker offers the stores that actually have traffic rather
                  than the full 35-store broadcast list. */}
              <AdminRunDrilldown stores={(funnel?.stores ?? []).map((s) => s.storeId)} />

              {/* ── Remote config ──────────────────────────────────────────── */}
              <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
                <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0' }}>
                  <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Store config</h2>
                  <p style={{ margin: '6px 0 0', fontSize: '13px', color: '#888' }}>
                    Partial overrides on top of the app&apos;s bundled defaults. Publishing creates a new
                    version and activates it; clients pick it up on their next launch. Keys the app
                    does not recognize, and values outside their safe range, are ignored by the client.
                    {' '}<b>Selectors are no longer read by anything.</b> DOM automation was removed on
                    2026-09-01 and the key is still parsed and validated, but nothing consumes it. The
                    step table that measured it came off this page for the same reason. The live levers
                    are the per-store <code>networkSearch</code> / <code>networkAdd</code> switches and{' '}
                    <code>flags.manualPrefetch</code>.
                  </p>
                </div>

                <div style={{ padding: '20px 24px' }}>
                  <textarea
                    value={configDraft}
                    onChange={(e) => { setConfigMsg(null); setConfigDraft(e.target.value); }}
                    spellCheck={false}
                    placeholder={'{\n  "stores": {\n    "albertsons": {\n      "networkSearch": true,\n      "networkAdd": false\n    }\n  }\n}'}
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
          </div>
        )}

      </div>
    </div>
  );
}
