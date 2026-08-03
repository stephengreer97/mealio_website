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

/** Extraction model. MEAL-71 asks for an opus-vs-sonnet A/B on measured accuracy. */
export const EXTRACTION_MODEL = 'claude-opus-5';

/** Gate model — the cheap yes/no that runs before we pay extraction rates. */
export const GATE_MODEL = 'claude-haiku-4-5';

export interface StructuredRequest<T> {
  model: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  /** Adaptive thinking. Only set on models that accept it (4.6+). */
  thinking?: boolean;
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

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = MODEL_PRICING[model];
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
  cachedClient = new Anthropic() as unknown as AnthropicMessagesClient;
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
      ...(request.thinking ? { thinking: { type: 'adaptive' } } : {}),
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
        costUsd: estimateCostUsd(model, inputTokens, outputTokens),
      },
    };
  };
}
