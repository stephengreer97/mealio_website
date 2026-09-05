// What Mealio may send, and how a user says no to one kind without saying no to
// all of them.
//
// MEAL-217. Before this there was one switch, in Account, and its off state was
// stored in SecureStore ON THE HANDSET. The server never learned about it, so
// any sender written afterwards would have pushed to someone who had turned
// notifications off — the setting looked like a preference and was a local
// mute.
//
// It is also worth being blunt about the starting position: NOTHING WAS EVER
// SENT. `sendPushToUsers` had no production callers at all, the admin broadcast
// wrote an in-app banner rather than a push, and the opt-in card promised to
// tell creators when a recipe was imported — a notification nothing produced.
// So this file is not adding controls to an existing stream; it is defining the
// stream, and the controls, together.

/**
 * The kinds of notification that exist.
 *
 * Deliberately short. A category the product does not actually send is a switch
 * wired to nothing, which is the exact failure the flags section of the
 * automation config already learned (see FlagConfig): a control that changes
 * nothing is worse than no control, because it reads like something an operator
 * can rely on.
 *
 * Each one here has a real trigger behind it or is not in the list.
 */
export const NOTIFICATION_CATEGORIES = ['broadcast', 'creator_draft'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** What each switch says on the settings screen. */
export const CATEGORY_LABEL: Record<NotificationCategory, string> = {
  broadcast: 'News from Mealio',
  creator_draft: 'Your recipes',
};

export const CATEGORY_DESCRIPTION: Record<NotificationCategory, string> = {
  broadcast: 'Occasional announcements: new stores, big changes.',
  creator_draft: 'When a recipe you posted has been imported and needs a look.',
};

/**
 * Categories only a creator can receive.
 *
 * Shown to everyone would be a switch that does nothing for most accounts,
 * which is the same problem as an unwired flag wearing a different hat.
 */
export const CREATOR_ONLY: ReadonlySet<NotificationCategory> = new Set(['creator_draft']);

export type NotificationPrefs = Partial<Record<NotificationCategory | 'all', boolean>>;

/**
 * May we send this category to this user?
 *
 * DEFAULT IS ON, and `undefined` means on. A user who has never opened the
 * settings screen, and every row written before this shipped, has no stored
 * preference — reading that as "off" would mean the first notification Mealio
 * ever sends reaches nobody, silently, and looks like a broken sender.
 *
 * `all` is the master switch and wins when it is off. It is stored separately
 * from the per-category flags rather than by writing false into every one of
 * them, so turning the master back on restores the user's individual choices
 * instead of flattening them.
 */
export function mayNotify(
  prefs: NotificationPrefs | null | undefined,
  category: NotificationCategory,
): boolean {
  if (!prefs) return true;
  if (prefs.all === false) return false;
  return prefs[category] !== false;
}

/**
 * Sanitize what a client sent before it is stored.
 *
 * Unknown keys are DROPPED rather than stored, which is the opposite of the
 * rule the telemetry ingest follows — and deliberately so. There, an unknown
 * value is a newer client saying something true that an older server has not
 * learned yet, and the row is worth more than the field. Here it is a write to
 * a user's account from a client we do not control, and a preference nothing
 * reads is a promise nothing keeps.
 */
export function sanitizePrefs(input: unknown): NotificationPrefs {
  const out: NotificationPrefs = {};
  if (!input || typeof input !== 'object') return out;
  const raw = input as Record<string, unknown>;
  if (typeof raw.all === 'boolean') out.all = raw.all;
  for (const c of NOTIFICATION_CATEGORIES) {
    if (typeof raw[c] === 'boolean') out[c] = raw[c] as boolean;
  }
  return out;
}
