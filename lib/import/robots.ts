/**
 * robots.txt handling (MEAL-70).
 *
 * Cheap to do, and this is a creator's own site — being a well-behaved client
 * costs us nothing and a blocked fetch is a rejection we can explain.
 *
 * Deliberately a small subset of the spec: User-agent groups, Allow, Disallow,
 * `*` and `$` wildcards, longest-match-wins. No Crawl-delay (we make one
 * request), no Sitemap, no non-group directives.
 */

import { safeFetch, USER_AGENT, type SafeFetchOptions } from './ssrf';

const ROBOTS_MAX_BYTES = 128 * 1024;
const ROBOTS_TIMEOUT_MS = 5_000;

/** Our token as it would appear in a robots.txt User-agent line. */
export const ROBOTS_AGENT = 'mealiobot';

interface Rule {
  allow: boolean;
  pattern: string;
}

/** Parses robots.txt into the rules that apply to `agent` (falling back to `*`). */
export function parseRobots(body: string, agent = ROBOTS_AGENT): Rule[] {
  const specific: Rule[] = [];
  const wildcard: Rule[] = [];

  // A group is one or more consecutive User-agent lines followed by rules.
  let currentAgents: string[] = [];
  let collectingAgents = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;

    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === 'user-agent') {
      if (!collectingAgents) {
        currentAgents = [];
        collectingAgents = true;
      }
      currentAgents.push(value.toLowerCase());
      continue;
    }

    if (field !== 'allow' && field !== 'disallow') continue;
    collectingAgents = false;
    if (currentAgents.length === 0) continue;

    const rule: Rule = { allow: field === 'allow', pattern: value };
    if (currentAgents.includes(agent)) specific.push(rule);
    if (currentAgents.includes('*')) wildcard.push(rule);
  }

  // A group naming us wins outright; otherwise the `*` group applies.
  return specific.length > 0 ? specific : wildcard;
}

function matches(pattern: string, path: string): number {
  // An empty Disallow means "allow everything" and matches nothing.
  if (pattern === '') return -1;

  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const segments = body.split('*');

  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === '') continue;
    const at = i === 0 ? (path.startsWith(segment) ? 0 : -1) : path.indexOf(segment, cursor);
    if (at === -1) return -1;
    cursor = at + segment.length;
  }

  if (anchored && cursor !== path.length) {
    // With a trailing wildcard the rest can be anything; otherwise it must end here.
    if (!body.endsWith('*')) return -1;
  }
  return body.length;
}

/** Longest matching rule wins; Allow beats Disallow at equal length. */
export function isAllowed(rules: Rule[], path: string): boolean {
  let best: Rule | null = null;
  let bestLength = -1;

  for (const rule of rules) {
    const length = matches(rule.pattern, path);
    if (length < 0) continue;
    if (length > bestLength || (length === bestLength && rule.allow)) {
      best = rule;
      bestLength = length;
    }
  }

  return best ? best.allow : true;
}

export interface RobotsCheck {
  allowed: boolean;
  /** Why — logged by the poller when it skips. */
  detail: string;
}

/**
 * Fetches and evaluates robots.txt for `targetUrl`.
 *
 * Fail-open: a missing, unreachable or unparseable robots.txt means allowed.
 * A site that cannot serve robots.txt has not disallowed anything, and failing
 * closed would make every import depend on a second network call succeeding.
 */
export async function checkRobots(
  targetUrl: string,
  options: SafeFetchOptions = {},
): Promise<RobotsCheck> {
  let robotsUrl: string;
  let path: string;
  try {
    const url = new URL(targetUrl);
    robotsUrl = new URL('/robots.txt', url).toString();
    path = url.pathname + url.search;
  } catch {
    return { allowed: true, detail: 'Unparseable URL; robots.txt not checked' };
  }

  const result = await safeFetch(robotsUrl, {
    ...options,
    maxBytes: ROBOTS_MAX_BYTES,
    timeoutMs: options.timeoutMs ?? ROBOTS_TIMEOUT_MS,
  });

  if (!result.ok) {
    return { allowed: true, detail: `No usable robots.txt (${result.reason}); proceeding` };
  }

  const rules = parseRobots(result.html);
  const allowed = isAllowed(rules, path);
  return {
    allowed,
    detail: allowed
      ? `Allowed by robots.txt for ${USER_AGENT}`
      : `Disallowed by ${robotsUrl} for ${USER_AGENT}`,
  };
}
