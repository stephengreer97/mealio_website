import { describe, it, expect } from 'vitest';
import { classifySource, resolveGate, THIN_CONTENT_CHARS } from '@/lib/import/gate';
import { GATE_MODEL } from '@/lib/import/anthropic';
import { failingCaller, stubCaller } from '../helpers/import-stubs';

/**
 * MEAL-70's gate. The acceptance criteria it has to hold:
 *  - a non-recipe URL is rejected before any extraction call is billed
 *  - a non-recipe *video* is rejected from title/description/captions alone
 *  - the same unsure verdict proceeds under manual import and skips under the poller
 *  - every rejection carries a reason the poller can log
 */

const VLOG = {
  title: 'GROCERY HAUL + what I actually ate this week 🛒',
  text:
    'Hi everyone! Welcome back to the channel. This week I went to three different stores and ' +
    'I am showing you everything I picked up, plus a little tour of the new pantry shelves my ' +
    'partner built. No recipes today, just chatting about what is in season and answering some ' +
    'of your questions from the last video about the kitchen renovation. Links to everything ' +
    'are down below in the description. Thanks so much for watching, see you Thursday!',
};

const RECIPE_VIDEO = {
  title: 'The Only Weeknight Dal You Need | 20 minutes',
  text:
    'Ingredients: 1 cup red lentils, 1 onion, 3 cloves garlic, 1 tbsp ginger, 2 tsp cumin, ' +
    '1 tsp turmeric, 400ml coconut milk, salt. [captions] okay so first we are going to rinse ' +
    'the lentils until the water runs clear, then get your onion going in a bit of oil over ' +
    'medium heat until it softens, about five minutes, then add the garlic and ginger...',
};

describe('import/gate — the free shortcut', () => {
  it('skips the classifier entirely when the page publishes a Recipe block', async () => {
    const call = stubCaller(() => {
      throw new Error('classifier should not have been called');
    });
    const result = await classifySource(
      { title: 'Anything', text: 'x'.repeat(1000), hasRecipeJsonLd: true },
      { call },
    );
    expect(result.verdict.verdict).toBe('yes');
    expect(result.verdict.source).toBe('json-ld');
    expect(call.requests).toHaveLength(0);
    expect(result.usage).toBeNull();
  });
});

describe('import/gate — video sources with no JSON-LD to help', () => {
  it('rejects a grocery haul from title, description and captions alone', async () => {
    const call = stubCaller(() => ({
      verdict: 'no',
      reason: 'Grocery haul: describes items bought and a pantry tour, no preparation steps.',
    }));

    const result = await classifySource(VLOG, { call });

    expect(result.verdict.verdict).toBe('no');
    expect(result.verdict.source).toBe('classifier');
    expect(result.verdict.reason).toMatch(/haul/i);
    // Cheap model, and only the title plus the opening words.
    expect(call.requests[0].model).toBe(GATE_MODEL);
    expect(call.requests[0].prompt).toContain('GROCERY HAUL');
  });

  it('accepts a recipe video from the same shape of input', async () => {
    const call = stubCaller(() => ({
      verdict: 'yes',
      reason: 'Lists 8 ingredients and narrates the method for a red lentil dal.',
    }));
    const result = await classifySource(RECIPE_VIDEO, { call });
    expect(result.verdict.verdict).toBe('yes');
  });

  it('truncates long input to roughly the first 500 words', async () => {
    const call = stubCaller(() => ({ verdict: 'no', reason: 'x' }));
    await classifySource({ title: 'T', text: Array(2000).fill('word').join(' ') }, { call });
    const words = call.requests[0].prompt.split(/\s+/).length;
    expect(words).toBeLessThan(560);
  });
});

describe('import/gate — content too thin to hold a recipe', () => {
  it('rejects a near-empty landing page without paying for a classifier call', async () => {
    const call = stubCaller(() => {
      throw new Error('should not be called');
    });
    const result = await classifySource({ title: 'Super Recipes', text: 'x'.repeat(120) }, { call });

    expect(result.verdict.verdict).toBe('no');
    expect(result.verdict.source).toBe('no-content');
    expect(result.verdict.reason).toMatch(/link-in-bio|too little/i);
    expect(call.requests).toHaveLength(0);
  });

  it('still classifies a page just over the thin-content threshold', async () => {
    const call = stubCaller(() => ({ verdict: 'yes', reason: 'ok' }));
    await classifySource({ title: 'T', text: 'a '.repeat(THIN_CONTENT_CHARS) }, { call });
    expect(call.requests).toHaveLength(1);
  });
});

describe('import/gate — classifier outage', () => {
  it('returns unsure rather than yes when the classifier cannot be reached', async () => {
    const result = await classifySource(VLOG, { call: failingCaller() });
    expect(result.verdict.verdict).toBe('unsure');
    expect(result.verdict.source).toBe('classifier-unavailable');
    expect(result.verdict.reason).toMatch(/could not be reached/i);
  });

  it('returns unsure when no caller is configured at all', async () => {
    const result = await classifySource(VLOG);
    expect(result.verdict.verdict).toBe('unsure');
    expect(result.verdict.source).toBe('classifier-unavailable');
  });
});

describe('import/gate — one classifier, two thresholds', () => {
  const unsure = { verdict: 'unsure' as const, reason: 'Title reads like a dish but the body is truncated.', source: 'classifier' as const };

  it('proceeds on unsure for a manual import and skips for the poller', () => {
    const manual = resolveGate(unsure, 'manual');
    const poller = resolveGate(unsure, 'poller');

    expect(manual.proceed).toBe(true);
    expect(poller.proceed).toBe(false);
    // Both explain themselves — a working gate and a dead feed must not look alike.
    expect(manual.reason).toContain(unsure.reason);
    expect(poller.reason).toContain(unsure.reason);
    expect(poller.reason).toMatch(/skipping/i);
  });

  it('agrees on yes and no regardless of mode', () => {
    const yes = { verdict: 'yes' as const, reason: 'r', source: 'classifier' as const };
    const no = { verdict: 'no' as const, reason: 'Kitchen tour, no cooking.', source: 'classifier' as const };

    expect(resolveGate(yes, 'manual').proceed).toBe(true);
    expect(resolveGate(yes, 'poller').proceed).toBe(true);
    expect(resolveGate(no, 'manual').proceed).toBe(false);
    expect(resolveGate(no, 'poller').proceed).toBe(false);
    expect(resolveGate(no, 'poller').reason).toContain('Kitchen tour');
  });
});
