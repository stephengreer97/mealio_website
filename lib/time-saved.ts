// MEAL-214 part 2. "Hours of shopping this app has taken off you."
//
//     time_saved = (time a human takes for N items) - (time Mealio took)
//
// The second half is measured and stored. The first half is an ASSUMPTION, and
// the ticket is explicit that choosing it badly is how this feature makes people
// trust the rest of the app less. So three rules, and they are the whole design:
//
//   1. NAME THE SOURCE in the UI. An unsourced "you saved 47 hours" is exactly
//      the kind of number that reads as marketing. This app has spent months
//      making its numbers checkable and this one must not be the exception.
//   2. BE CONSERVATIVE. A figure that survives someone doing the arithmetic
//      themselves is worth more than a bigger one that does not.
//   3. COUNT ONLY WHAT MEALIO ACTUALLY DID. An item that went to review and was
//      picked by hand is not time saved -- it is time spent.

/**
 * Minutes per item attributed to shopping by hand.
 *
 * SOURCE, and it is deliberately the low end of it. The U.S. Bureau of Labor
 * Statistics' American Time Use Survey puts grocery shopping at roughly 44
 * minutes per trip for those who shopped on a given day; industry basket
 * research commonly puts a full trip at 40-60 minutes for a 25-40 item basket.
 * That is about 1.2-1.8 minutes per item INCLUDING travel, aisle-walking,
 * queueing and checkout.
 *
 * We take 1.2 -- the bottom of that range -- because every objection to this
 * number is an objection to it being too high, and a claim nobody argues with is
 * worth more than a claim that is merely bigger.
 *
 * If this constant changes, the copy naming it has to change with it. That is
 * why they live in the same file.
 */
export const MINUTES_PER_ITEM_BY_HAND = 1.2;

/** The sentence that must appear wherever the number does. */
export const TIME_SAVED_BASIS =
  'Based on 1.2 minutes per item to shop by hand, the low end of published '
  + 'estimates covering travel, aisles, queueing and checkout.';

export interface RunForTimeSaved {
  /** What the run actually put in the cart. NOT what was requested. */
  items_added: number | null;
  /** Wall clock, if the run recorded both ends. */
  started_at?: string | null;
  completed_at?: string | null;
  outcome?: string | null;
}

export interface TimeSavedResult {
  /** Items Mealio actually added, across all counted runs. */
  itemsAdded: number;
  /** Runs that contributed. */
  runs: number;
  /** Minutes those items would have taken by hand. */
  byHandMinutes: number;
  /** Wall-clock minutes Mealio spent, where the run recorded it. */
  mealioMinutes: number;
  /** The headline. Never negative. */
  savedMinutes: number;
  basis: string;
}

/**
 * Total time saved across a set of runs.
 *
 * Runs with no `items_added` are skipped rather than counted as zero: a run that
 * never reported is unknown, and folding unknowns in as zeroes would quietly
 * drag the average down while looking like data.
 */
export function timeSaved(runs: RunForTimeSaved[]): TimeSavedResult {
  let itemsAdded = 0;
  let mealioMs = 0;
  let counted = 0;

  for (const r of runs) {
    if (typeof r.items_added !== 'number' || r.items_added <= 0) continue;
    counted += 1;
    itemsAdded += r.items_added;
    if (r.started_at && r.completed_at) {
      const ms = new Date(r.completed_at).getTime() - new Date(r.started_at).getTime();
      // A negative or absurd duration is a clock problem, not a fast run.
      if (Number.isFinite(ms) && ms > 0 && ms < 60 * 60 * 1000) mealioMs += ms;
    }
  }

  const byHandMinutes = itemsAdded * MINUTES_PER_ITEM_BY_HAND;
  const mealioMinutes = mealioMs / 60000;
  return {
    itemsAdded,
    runs: counted,
    byHandMinutes,
    mealioMinutes,
    // Clamped at zero. If Mealio somehow took longer, the honest display is
    // "no time saved", not a negative number dressed up as a saving.
    savedMinutes: Math.max(0, byHandMinutes - mealioMinutes),
    basis: TIME_SAVED_BASIS,
  };
}

/** "3 hours 20 minutes", or null when there is not yet enough to say. */
export function formatTimeSaved(saved: TimeSavedResult): string | null {
  // Below a threshold the number is noise and claiming it cheapens the rest.
  if (saved.itemsAdded < 10 || saved.savedMinutes < 10) return null;
  const total = Math.round(saved.savedMinutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} minutes`;
  if (m === 0) return h === 1 ? '1 hour' : `${h} hours`;
  return `${h} ${h === 1 ? 'hour' : 'hours'} ${m} minutes`;
}
