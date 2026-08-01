/**
 * The is-this-a-recipe gate (MEAL-70).
 *
 * Not every URL a creator pastes is a recipe. Running full extraction on an
 * About page pays Opus rates to produce nothing, and in Phase 2 a false positive
 * is an unsolicited email to a partner about a meal that does not exist.
 *
 * Three properties the design turns on:
 *
 *  - **Source-agnostic input.** `{ title, text }`, where `text` is cleaned page
 *    text for a blog and description-plus-captions for a video. Video is where
 *    the gate matters most and where the JSON-LD escape hatch is missing: a
 *    channel feed carries vlogs, hauls and kitchen tours, none of which expose
 *    JSON-LD.
 *  - **Three verdicts, not a boolean.** Manual import and the feed poller want
 *    opposite defaults for `unsure` — attempt vs skip. Same classifier; the
 *    caller decides.
 *  - **Every rejection carries a reason.** A poller that skipped a creator's
 *    post has to be able to say why, or nobody can tell a working gate from a
 *    dead feed.
 */

import { z } from 'zod';
import {
  AnthropicUnavailableError,
  GATE_MODEL,
  type StructuredCaller,
  type StructuredUsage,
} from './anthropic';
import type { GateInput, GateMode, GateVerdict } from './types';

/** The classifier only ever sees the title plus roughly the first 500 words. */
export const GATE_TEXT_WORD_LIMIT = 500;

/**
 * Below this much readable text a page cannot contain a recipe, so we reject
 * without paying for a classifier call.
 *
 * Set well under the MEAL-69 spike's link-in-bio case (311 characters) on
 * purpose. The deterministic catch for those is the `link-in-bio` platform
 * check in the pipeline, which is precise; this is the generic backstop for a
 * self-hosted landing page, and a wrong refusal here costs a creator a real
 * import. Anything in the 250–800 band goes to the classifier, which is cheap
 * and is the thing that stops the expensive extraction call either way.
 */
export const THIN_CONTENT_CHARS = 250;

const GateSchema = z.object({
  verdict: z.enum(['yes', 'no', 'unsure']),
  reason: z
    .string()
    .describe('One short sentence naming the evidence that decided it. Loggable on its own.'),
});

const GATE_SYSTEM = `You classify whether a piece of published content is a COOKING RECIPE that a
home cook could follow to make a dish.

The content may be a blog post (title + page text) or a video (title + description + captions).
Treat both the same way: judge from what is actually present.

Answer "yes" when the content teaches how to make a specific dish — it names ingredients and
describes preparation, even loosely. A recipe narrated in a video counts.

Answer "no" when the content is not a recipe. Common non-recipes from food creators:
- vlogs, day-in-the-life, travel and trip write-ups
- grocery hauls, pantry tours, kitchen tours, equipment reviews
- channel updates, Q&As, announcements, sponsorships
- restaurant reviews and round-ups that link elsewhere rather than giving a recipe
- About, contact, privacy and category/index pages

Answer "unsure" only when you genuinely cannot tell — for example a title that sounds like a dish
but a body that is too short, truncated or off-topic to confirm. Do not use "unsure" to hedge a
clear call; the caller resolves it differently depending on context and overusing it is costly
in both directions.

The reason must be one short sentence naming the specific evidence, e.g. "Lists 9 ingredients and
numbered steps for a black bean soup" or "Grocery haul: describes items bought, no preparation
steps". It is written into logs and shown to creators, so make it stand on its own.`;

export interface GateOptions {
  call?: StructuredCaller;
}

export interface GateResult {
  verdict: GateVerdict;
  usage: StructuredUsage | null;
}

function firstWords(text: string, limit: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length <= limit ? words.join(' ') : `${words.slice(0, limit).join(' ')}…`;
}

/**
 * Classifies a source. Skips the model entirely when a valid `schema.org/Recipe`
 * block is present — the answer is trivially yes and re-classifying is waste.
 */
export async function classifySource(
  input: GateInput,
  options: GateOptions = {},
): Promise<GateResult> {
  if (input.hasRecipeJsonLd) {
    return {
      verdict: {
        verdict: 'yes',
        reason: 'Page publishes a schema.org/Recipe block with ingredients or instructions.',
        source: 'json-ld',
      },
      usage: null,
    };
  }

  const title = input.title.trim();
  const text = input.text.trim();

  if (!title && text.length < 40) {
    return {
      verdict: {
        verdict: 'no',
        reason: 'Source has no title and almost no text, so there is nothing to classify.',
        source: 'no-content',
      },
      usage: null,
    };
  }

  // Link-in-bio pages are unsupported, not merely hard: the MEAL-69 spike found
  // beacons.ai/superrecipes had 311 characters of body text and no recipe
  // anywhere on it. Detected here so it costs nothing rather than burning an
  // extraction call on a page that cannot contain an answer.
  if (text.length < THIN_CONTENT_CHARS) {
    return {
      verdict: {
        verdict: 'no',
        reason:
          `Page has only ${text.length} characters of readable text — too little to hold a ` +
          'recipe. Link-in-bio and landing pages look like this; link the recipe post itself.',
        source: 'no-content',
      },
      usage: null,
    };
  }

  const call = options.call;
  if (!call) {
    return {
      verdict: {
        verdict: 'unsure',
        reason: 'Classifier is not configured, so the source could not be checked.',
        source: 'classifier-unavailable',
      },
      usage: null,
    };
  }

  const prompt = [
    `TITLE: ${title || '(none)'}`,
    '',
    'CONTENT:',
    firstWords(text, GATE_TEXT_WORD_LIMIT) || '(none)',
  ].join('\n');

  try {
    const response = await call({
      model: GATE_MODEL,
      system: GATE_SYSTEM,
      prompt,
      schema: GateSchema,
      maxTokens: 512,
    });
    return {
      verdict: { ...response.output, source: 'classifier' },
      usage: response.usage,
    };
  } catch (err) {
    // A classifier outage must not silently become a "yes". Unsure means the
    // poller stays quiet and manual import proceeds at the creator's request.
    const detail = err instanceof AnthropicUnavailableError ? err.message : String(err);
    return {
      verdict: {
        verdict: 'unsure',
        reason: `Classifier could not be reached: ${detail}`,
        source: 'classifier-unavailable',
      },
      usage: null,
    };
  }
}

export interface GateDecision {
  proceed: boolean;
  /** Why we proceeded or stopped — the poller writes this to its skip log. */
  reason: string;
}

/**
 * Resolves a verdict for a caller.
 *
 * | Caller                    | `unsure` means | Why |
 * | ------------------------- | -------------- | --- |
 * | Manual import (Phase 1)   | attempt        | The creator picked this URL and is watching. A wrong refusal is worse than a wasted extraction. |
 * | Feed poller (Phase 2)     | skip           | Nobody asked. A false positive is an unsolicited email about a meal that does not exist. |
 */
export function resolveGate(verdict: GateVerdict, mode: GateMode): GateDecision {
  if (verdict.verdict === 'yes') {
    return { proceed: true, reason: verdict.reason };
  }
  if (verdict.verdict === 'no') {
    return { proceed: false, reason: `Not a recipe: ${verdict.reason}` };
  }
  return mode === 'manual'
    ? { proceed: true, reason: `Unsure, attempting anyway (manual import): ${verdict.reason}` }
    : { proceed: false, reason: `Unsure, skipping (automatic mode): ${verdict.reason}` };
}
