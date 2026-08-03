/**
 * Anthropic client wiring for the import pipeline (MEAL-71).
 *
 * The rest of the pipeline never sees the SDK. It depends on `StructuredCaller`
 * — "give me a schema and a prompt, hand me back a validated object" — so tests
 * inject a stub and `npm test` needs no network and no API key.
 *
 * Per MEAL-68, this is funded by Anthropic API credits billed through the
 * Console, not by anyone's Claude subscription. `ANTHROPIC_API_KEY` must be set
 * in the Vercel project before the extraction path can run; until it is, the
 * pipeline rejects at the extract stage with a clear reason rather than
 * throwing.
 */

import type { z } from 'zod';

/** Models this pipeline is allowed to call, with their published per-MTok rates. */
export const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
};

/**
 * Extraction model. MEAL-71 asked for an A/B on measured accuracy; this is its
 * answer, run 2026-08-03 over the 12-item eval set.
 *
 * | | ingredient match | $/import | mean | median |
 * | --- | --- | --- | --- | --- |
 * | haiku-4-5  | 100% | $0.0090 |  6.1s |  4.4s |
 * | opus-5     | 100% | $0.0599 | 10.9s | 11.2s |
 * | sonnet-5   | 100% | $0.0580 | 28.8s | 25.2s |
 *
 * Haiku is 6.7× cheaper and ~1.8× faster than Opus at identical ingredient
 * accuracy, and it was the only one of the three that never invented a serving
 * count — Opus returned a `serves` for a page that states only a volume yield on
 * all three full runs (MEAL-95). Sonnet is out on latency: two of its twelve
 * items exceeded `REQUEST_TIMEOUT_MS` outright.
 *
 * Note that Haiku does not accept adaptive thinking, so extraction now runs
 * without it — which is exactly the configuration those numbers were measured
 * in. See `supportsAdaptiveThinking`.
 *
 * The eval set is 12 items. Widen it before treating this as settled.
 */
export const EXTRACTION_MODEL = 'claude-haiku-4-5';

/**
 * Gate model — the cheap yes/no that runs before we pay extraction rates.
 *
 * Now the same model as extraction. The gate still earns its place: it runs on a
 * much shorter prompt and rejects non-recipe pages before we send the full
 * document, so the saving is in tokens rather than in rate.
 */
export const GATE_MODEL = 'claude-haiku-4-5';

/**
 * Which stage of the pipeline a call belongs to.
 *
 * The model used to say this implicitly — the gate was Haiku and extraction was
 * Opus, so a usage record could be attributed to a stage by its model alone.
 * Now both are Haiku and that inference is gone, taking with it the ability to
 * answer "how much of this bill is the gate?" — which is the whole argument for
 * having a gate.
 *
 * It is a required field rather than an optional one because the failure mode of
 * forgetting it is silent: an unlabelled call is invisible to attribution rather
 * than obviously wrong.
 */
export type CallPurpose = 'gate' | 'extract';

export interface StructuredRequest<T> {
  model: string;
  purpose: CallPurpose;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  /**
   * Ask for adaptive thinking. Honoured only on models that accept it — see
   * `supportsAdaptiveThinking`, which is what actually decides.
   */
  thinking?: boolean;
}

/**
 * Whether a model accepts `thinking: { type: 'adaptive' }`.
 *
 * The comment on `thinking` used to say "only set on models that accept it" and
 * nothing enforced it, so every caller passed `true` and the parameter went out
 * on whatever model was named. That is fine while the model is Opus; pointing
 * `EVAL_MODEL` at Haiku 4.5 turns every single request into
 * `400 adaptive thinking is not supported on this model` — a whole eval run
 * reporting 0% accuracy for a reason that has nothing to do with accuracy.
 *
 * Adaptive thinking arrived with the 4.6 generation, so 4.5 and earlier are out.
 * Matched on the family and version in the id rather than an allowlist of exact
 * ids: an allowlist silently drops thinking from the next model we add, which
 * fails in the expensive direction — quietly worse output, no error.
 */
export function supportsAdaptiveThinking(model: string): boolean {
  if (/^claude-(opus|sonnet|fable|mythos)-[5-9]/.test(model)) return true;
  const legacy = /^claude-(opus|sonnet)-4-(\d+)/.exec(model);
  return legacy ? Number(legacy[2]) >= 6 : false;
}

export interface StructuredUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface StructuredResponse<T> {
  output: T;
  usage: StructuredUsage;
}

/** The single seam between this pipeline and the Anthropic API. */
export type StructuredCaller = <T>(request: StructuredRequest<T>) => Promise<StructuredResponse<T>>;

export class AnthropicUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnthropicUnavailableError';
  }
}

/** The dated form the API echoes back, e.g. `claude-haiku-4-5-20251001`. */
const DATED_MODEL_SUFFIX = /-\d{8}$/;

/**
 * Pricing for a model id, tolerating the dated id.
 *
 * We send an alias (`claude-haiku-4-5`) but the API answers with the concrete
 * snapshot it served (`claude-haiku-4-5-20251001`), and usage is costed against
 * *that* — the honest choice, since it is what actually ran. Keyed on the alias
 * alone, the lookup missed and `estimateCostUsd` returned 0, so every call to
 * the Haiku gate has been booked at no cost. It fails silently and in the
 * direction that hides spend, which is the worst of both.
 *
 * Opus is unaffected only by luck: `claude-opus-5` is echoed back unchanged.
 */
export function pricingFor(model: string): { inputPerMTok: number; outputPerMTok: number } | undefined {
  return MODEL_PRICING[model] ?? MODEL_PRICING[model.replace(DATED_MODEL_SUFFIX, '')];
}

/**
 * `fallbackModel` is the id we asked for, used when the id we got back prices
 * to nothing. A model we cannot price still returns 0 — there is no honest
 * number to invent — but it should no longer be reachable by a snapshot suffix.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  fallbackModel?: string,
): number {
  const price = pricingFor(model) ?? (fallbackModel ? pricingFor(fallbackModel) : undefined);
  if (!price) return 0;
  const usd =
    (inputTokens / 1_000_000) * price.inputPerMTok +
    (outputTokens / 1_000_000) * price.outputPerMTok;
  return Math.round(usd * 1e6) / 1e6;
}

/** Minimal structural view of the SDK surface we use, so the client is swappable. */
export interface AnthropicMessagesClient {
  messages: {
    parse(params: Record<string, unknown>): Promise<{
      parsed_output?: unknown;
      stop_reason?: string | null;
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>;
  };
}

/**
 * Per-call ceiling, and the number `LEASE_MS` is derived from.
 *
 * The SDK's default is ten minutes plus retries. Left at that, one item of an
 * admin sync run can outlast the lease its worker holds on that run — and a
 * lease that expires while its holder is still importing is worse than none:
 * a second worker claims the run, reads the same still-pending item and imports
 * it again, and one post becomes two drafts in the review queue. A bound here
 * is what makes "a wave cannot outlive its lease" arithmetic rather than hope.
 * See `LEASE_MS` in `lib/admin-sync.ts` for the sum.
 *
 * Generous rather than tight: a long page legitimately takes an extraction
 * model tens of seconds, and cutting one short wastes the tokens already spent.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * One retry, not the SDK's two. Retries are worth having — a 429 or a 503 is
 * transient and nothing is charged for the failed attempt — but each one
 * multiplies the worst case the lease has to cover, and an item that fails here
 * is retryable by hand from the run screen anyway.
 */
export const MAX_RETRIES = 1;

let cachedClient: AnthropicMessagesClient | null = null;

/**
 * Constructs the SDK client lazily and once. Lazy because module load happens
 * at build time on Vercel, where the key may legitimately be absent.
 */
async function getClient(): Promise<AnthropicMessagesClient> {
  if (cachedClient) return cachedClient;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AnthropicUnavailableError(
      'ANTHROPIC_API_KEY is not set. Per MEAL-68 this feature is funded by Anthropic API ' +
        'credits billed through the Console; provision a key and add it to the Vercel project.',
    );
  }
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  // The SDK's `parse` is generic over its own param types; this pipeline talks to
  // it through the narrow structural port above.
  cachedClient = new Anthropic({
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  }) as unknown as AnthropicMessagesClient;
  return cachedClient;
}

/** Test hook: replaces the memoised client. Pass null to reset. */
export function __setAnthropicClient(client: AnthropicMessagesClient | null): void {
  cachedClient = client;
}

/**
 * The production `StructuredCaller`.
 *
 * Uses `client.messages.parse()` with `output_config.format` — structured
 * outputs mean the API guarantees schema-valid JSON, so the entire "did it
 * return parseable JSON" failure class disappears.
 */
export function createStructuredCaller(clientOverride?: AnthropicMessagesClient): StructuredCaller {
  return async function call<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const client = clientOverride ?? (await getClient());
    const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');

    const response = await client.messages.parse({
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      ...(request.thinking && supportsAdaptiveThinking(request.model)
        ? { thinking: { type: 'adaptive' } }
        : {}),
      output_config: { format: zodOutputFormat(request.schema as never) },
      messages: [{ role: 'user', content: request.prompt }],
    });

    if (response.stop_reason === 'refusal') {
      throw new AnthropicUnavailableError(
        'The model declined this request. The page may contain content our safety ' +
          'classifiers refuse; the creator should publish this meal manually.',
      );
    }
    if (response.stop_reason === 'max_tokens') {
      throw new AnthropicUnavailableError(
        `Response hit max_tokens (${request.maxTokens}) before completing. The page is ` +
          'probably too long; raise the cap or trim the source text.',
      );
    }
    if (response.parsed_output == null) {
      throw new AnthropicUnavailableError('Model returned no parseable output.');
    }

    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const model = response.model ?? request.model;

    return {
      output: response.parsed_output as T,
      usage: {
        model,
        inputTokens,
        outputTokens,
        costUsd: estimateCostUsd(model, inputTokens, outputTokens, request.model),
      },
    };
  };
}
