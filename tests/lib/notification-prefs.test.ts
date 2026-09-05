// MEAL-217. Who may be sent what, and why absent means yes.
import { describe, it, expect } from 'vitest';
import {
  mayNotify, sanitizePrefs, NOTIFICATION_CATEGORIES, CREATOR_ONLY,
  CATEGORY_LABEL, CATEGORY_DESCRIPTION,
} from '@/lib/notification-prefs';

describe('may we send this?', () => {
  it('sends to a user who has never touched the settings', () => {
    // THE LOAD-BEARING DEFAULT. Every account predates this column, so reading
    // absent as "off" would mean the first notification Mealio ever sends
    // reaches nobody — silently, and looking exactly like a broken sender.
    expect(mayNotify(null, 'broadcast')).toBe(true);
    expect(mayNotify(undefined, 'broadcast')).toBe(true);
    expect(mayNotify({}, 'broadcast')).toBe(true);
  });

  it('honours a category the user turned off', () => {
    expect(mayNotify({ broadcast: false }, 'broadcast')).toBe(false);
  });

  it('does not let one category silence another', () => {
    expect(mayNotify({ broadcast: false }, 'creator_draft')).toBe(true);
  });

  it('lets the master switch win', () => {
    expect(mayNotify({ all: false, broadcast: true }, 'broadcast')).toBe(false);
  });

  it('keeps individual choices behind the master switch', () => {
    // `all` is stored separately rather than by writing false into every
    // category, so turning it back on restores what the user actually chose
    // instead of flattening it.
    const prefs = { all: false, broadcast: false, creator_draft: true };
    expect(mayNotify({ ...prefs, all: true }, 'creator_draft')).toBe(true);
    expect(mayNotify({ ...prefs, all: true }, 'broadcast')).toBe(false);
  });
});

describe('what a client is allowed to store', () => {
  it('keeps the keys it knows', () => {
    expect(sanitizePrefs({ all: false, broadcast: true, creator_draft: false }))
      .toEqual({ all: false, broadcast: true, creator_draft: false });
  });

  it('DROPS a key nobody reads', () => {
    // The opposite of the telemetry ingest's rule, on purpose: there an unknown
    // value is a newer client saying something true. Here it is a write to a
    // user's account, and a preference nothing reads is a promise nothing keeps.
    expect(sanitizePrefs({ broadcast: false, marketing_emails: false, '': true }))
      .toEqual({ broadcast: false });
  });

  it('ignores values that are not booleans', () => {
    expect(sanitizePrefs({ broadcast: 'false', all: 1, creator_draft: null })).toEqual({});
  });

  it('survives rubbish', () => {
    for (const bad of [null, undefined, 'x', 5, []]) {
      expect(sanitizePrefs(bad)).toEqual({});
    }
  });
});

describe('the catalogue itself', () => {
  it('gives every category copy to render', () => {
    // A category with no label ships as a blank switch.
    for (const c of NOTIFICATION_CATEGORIES) {
      expect(CATEGORY_LABEL[c]).toBeTruthy();
      expect(CATEGORY_DESCRIPTION[c]).toBeTruthy();
    }
  });

  it('only lists categories something actually sends', () => {
    // The rule the automation config's flags section learned the hard way: a
    // control that changes nothing is worse than no control. If a category is
    // added here, a sender has to exist for it.
    expect([...NOTIFICATION_CATEGORIES].sort()).toEqual(['broadcast', 'creator_draft']);
  });

  it('marks the creator-only ones so they are not shown to everyone', () => {
    expect(CREATOR_ONLY.has('creator_draft')).toBe(true);
    expect(CREATOR_ONLY.has('broadcast')).toBe(false);
  });
});
