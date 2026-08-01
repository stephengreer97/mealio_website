/**
 * Import telemetry.
 *
 * There is no real creator data to calibrate against yet: the MEAL-69 spike
 * measured 27% JSON-LD coverage across a sample of 49 URLs, but that is *a*
 * sample, not *our* creators. One structured line per import attempt — platform,
 * path taken, gate verdict, and the resulting confidence spread — is how that
 * question gets re-answered against real usage in a few weeks instead of
 * re-argued from the same sample.
 *
 * Deliberately a log line rather than a table: no schema change, it lands in the
 * same place as every other server event, and it can be promoted to a table once
 * the poller (MEAL-75) makes the volume worth querying.
 */

import { log } from '@/lib/logger';
import type { FieldConfidence, ImportTelemetry } from './types';

export type TelemetrySink = (event: ImportTelemetry) => void;

/** Counts how many fields landed on each confidence level. */
export function summariseConfidence(fields: FieldConfidence[]): {
  green: number;
  amber: number;
  red: number;
} {
  const summary = { green: 0, amber: 0, red: 0 };
  for (const field of fields) summary[field.level]++;
  return summary;
}

/** Formats one telemetry record as a single greppable `key=value` line. */
export function formatTelemetry(event: ImportTelemetry): string {
  const parts: string[] = [
    `outcome=${event.outcome}`,
    `stage=${event.stage}`,
    `platform=${event.platform ?? '-'}`,
    `path=${event.path ?? '-'}`,
    `gate=${event.gateVerdict ?? '-'}/${event.gateSource ?? '-'}`,
    `cached=${event.cached}`,
    `ingredients=${event.ingredientCount ?? '-'}`,
  ];
  if (event.confidence) {
    parts.push(
      `green=${event.confidence.green}`,
      `amber=${event.confidence.amber}`,
      `red=${event.confidence.red}`,
    );
  }
  parts.push(`cost=$${event.costUsd.toFixed(4)}`, `ms=${event.durationMs}`, `url=${event.url}`);
  if (event.reason) parts.push(`reason=${JSON.stringify(event.reason)}`);
  return parts.join(' ');
}

/** The production sink. Injected everywhere so tests can collect instead. */
export const defaultTelemetrySink: TelemetrySink = (event) => {
  log({
    event: 'CREATOR:MEAL_IMPORT',
    status: event.outcome === 'ok' ? 'success' : 'error',
    detail: formatTelemetry(event),
  });
};
