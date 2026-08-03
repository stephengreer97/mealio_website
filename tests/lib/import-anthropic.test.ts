import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  supportsAdaptiveThinking,
  AnthropicUnavailableError,
  createStructuredCaller,
  estimateCostUsd,
  EXTRACTION_MODEL,
  GATE_MODEL,
  MODEL_PRICING,
  type AnthropicMessagesClient,
} from '@/lib/import/anthropic';

/**
 * The Anthropic seam. These tests exercise the real `createStructuredCaller`
 * against a stub client — so the request shape (model, structured-output format,
 * adaptive thinking) is covered even though no live call is ever made.
 */

const Schema = z.object({ verdict: z.enum(['yes', 'no']), reason: z.string() });

function stubClient(response: Record<string, unknown>) {
  const parse = vi.fn(async (_params: Record<string, unknown>) => response);
  return { client: { messages: { parse } } as unknown as AnthropicMessagesClient, parse };
}

describe('import/anthropic — request shape', () => {
  it('sends the model, system prompt and a structured-output format', async () => {
    const { client, parse } = stubClient({
      parsed_output: { verdict: 'yes', reason: 'r' },
      stop_reason: 'end_turn',
      model: GATE_MODEL,
      usage: { input_tokens: 900, output_tokens: 40 },
    });

    const call = createStructuredCaller(client);
    const result = await call({
      model: GATE_MODEL,
      system: 'You classify things.',
      prompt: 'TITLE: x',
      schema: Schema,
      maxTokens: 512,
    });

    expect(result.output).toEqual({ verdict: 'yes', reason: 'r' });
    const params = parse.mock.calls[0][0] as Record<string, any>;
    expect(params.model).toBe(GATE_MODEL);
    expect(params.max_tokens).toBe(512);
    expect(params.system).toBe('You classify things.');
    expect(params.messages).toEqual([{ role: 'user', content: 'TITLE: x' }]);
    // Structured outputs: the API guarantees schema-valid JSON.
    expect(params.output_config?.format).toBeTruthy();
    expect(params.output_config.format.type).toBe('json_schema');
    // No thinking config unless asked for — the gate model predates adaptive.
    expect(params.thinking).toBeUndefined();
  });

  it('enables adaptive thinking when requested', async () => {
    const { client, parse } = stubClient({
      parsed_output: { verdict: 'no', reason: 'r' },
      stop_reason: 'end_turn',
      model: EXTRACTION_MODEL,
      usage: { input_tokens: 3000, output_tokens: 1500 },
    });

    await createStructuredCaller(client)({
      model: EXTRACTION_MODEL,
      system: 's',
      prompt: 'p',
      schema: Schema,
      maxTokens: 12_000,
      thinking: true,
    });

    const params = parse.mock.calls[0][0] as Record<string, any>;
    expect(params.thinking).toEqual({ type: 'adaptive' });
  });
});

describe('import/anthropic — failure modes surface as typed errors', () => {
  it('turns a refusal into an actionable error rather than an empty draft', async () => {
    const { client } = stubClient({ stop_reason: 'refusal', parsed_output: null, model: EXTRACTION_MODEL });
    await expect(
      createStructuredCaller(client)({ model: EXTRACTION_MODEL, system: 's', prompt: 'p', schema: Schema, maxTokens: 100 }),
    ).rejects.toBeInstanceOf(AnthropicUnavailableError);
  });

  it('turns a truncated response into an error rather than a half-parsed draft', async () => {
    const { client } = stubClient({ stop_reason: 'max_tokens', parsed_output: null, model: EXTRACTION_MODEL });
    await expect(
      createStructuredCaller(client)({ model: EXTRACTION_MODEL, system: 's', prompt: 'p', schema: Schema, maxTokens: 100 }),
    ).rejects.toThrow(/max_tokens/);
  });

  it('errors when the response carries no parsed output', async () => {
    const { client } = stubClient({ stop_reason: 'end_turn', parsed_output: null, model: EXTRACTION_MODEL });
    await expect(
      createStructuredCaller(client)({ model: EXTRACTION_MODEL, system: 's', prompt: 'p', schema: Schema, maxTokens: 100 }),
    ).rejects.toThrow(/no parseable output/);
  });
});

describe('import/anthropic — cost model (MEAL-68)', () => {
  it('prices an import from the published per-MTok rates', () => {
    // MEAL-68's planning figure: ~3k input, ~1.5k output on the JSON-LD path.
    expect(estimateCostUsd('claude-opus-5', 3000, 1500)).toBeCloseTo(0.0525, 4);
    expect(estimateCostUsd('claude-sonnet-5', 3000, 1500)).toBeCloseTo(0.0315, 4);
    expect(estimateCostUsd('claude-haiku-4-5', 900, 40)).toBeCloseTo(0.0011, 4);
  });

  it('returns zero rather than guessing for an unpriced model', () => {
    expect(estimateCostUsd('some-future-model', 1000, 1000)).toBe(0);
  });

  it('prices every model the pipeline is allowed to call', () => {
    for (const model of [EXTRACTION_MODEL, GATE_MODEL]) {
      expect(MODEL_PRICING[model]).toBeTruthy();
    }
  });

  it('prices the dated snapshot id the API answers with', () => {
    // We send `claude-haiku-4-5`; the response says `claude-haiku-4-5-20251001`
    // and usage is costed against that. Keyed on the alias alone this missed and
    // booked the whole gate at $0.00.
    expect(estimateCostUsd('claude-haiku-4-5-20251001', 900, 40)).toBeCloseTo(0.0011, 4);
    expect(estimateCostUsd('claude-opus-5-20260315', 3000, 1500)).toBeCloseTo(0.0525, 4);
  });

  it('falls back to the requested model when the returned id prices to nothing', () => {
    expect(estimateCostUsd('some-served-variant', 3000, 1500, 'claude-opus-5')).toBeCloseTo(
      0.0525,
      4,
    );
  });

  it('still returns zero when neither id can be priced', () => {
    expect(estimateCostUsd('some-future-model', 1000, 1000, 'another-unknown')).toBe(0);
  });

  it('costs a real call against the dated id the client hands back', async () => {
    const client: AnthropicMessagesClient = {
      messages: {
        parse: vi.fn().mockResolvedValue({
          parsed_output: { ok: true },
          stop_reason: 'end_turn',
          model: 'claude-haiku-4-5-20251001',
          usage: { input_tokens: 900, output_tokens: 40 },
        }),
      },
    };
    const { usage } = await createStructuredCaller(client)({
      model: 'claude-haiku-4-5',
      system: 's',
      prompt: 'p',
      schema: z.object({ ok: z.boolean() }),
      maxTokens: 64,
    });
    expect(usage.costUsd).toBeCloseTo(0.0011, 4);
  });
});

describe('import/anthropic — the client the pipeline actually constructs', () => {
  it('bounds a call so one item cannot outlive a sync run’s lease', async () => {
    // The SDK default is ten minutes plus retries. Under that, one item of an
    // admin sync run can outlast the lease its worker holds — a second worker
    // then claims the run, re-imports the same still-pending post, and one post
    // becomes two drafts in the review queue.
    vi.resetModules();
    const construct = vi.fn();
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: class {
        messages = { parse: async () => ({ parsed_output: { verdict: 'yes', reason: 'r' }, stop_reason: 'end_turn' }) };
        constructor(options: unknown) { construct(options); }
      },
    }));
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');

    const anthropic = await import('@/lib/import/anthropic');
    anthropic.__setAnthropicClient(null);
    await anthropic.createStructuredCaller()({
      model: anthropic.GATE_MODEL, system: 's', prompt: 'p', schema: Schema, maxTokens: 100,
    });

    expect(construct).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: anthropic.REQUEST_TIMEOUT_MS, maxRetries: anthropic.MAX_RETRIES }),
    );
    // And the bound is one a wave of two items fits inside its lease with.
    const { LEASE_MS } = await import('@/lib/admin-sync');
    const worstCallMs = anthropic.REQUEST_TIMEOUT_MS * (anthropic.MAX_RETRIES + 1);
    // Fetch, then the gate call, then the extraction — the sequence one item runs.
    expect(10_000 + worstCallMs * 2).toBeLessThan(LEASE_MS);

    anthropic.__setAnthropicClient(null);
    vi.unstubAllEnvs();
    vi.doUnmock('@anthropic-ai/sdk');
    vi.resetModules();
  });
});

describe('import/anthropic — adaptive thinking is model-dependent', () => {
  it('is sent to the models that accept it, and never to the ones that do not', () => {
    // 4.6 is where adaptive thinking arrived. Below it the parameter is a 400,
    // and a caller that always asks turns a whole eval run into "0% accuracy"
    // for a reason that has nothing to do with accuracy.
    for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-8']) {
      expect(supportsAdaptiveThinking(model)).toBe(true);
    }
    for (const model of ['claude-haiku-4-5', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-3-5-sonnet']) {
      expect(supportsAdaptiveThinking(model)).toBe(false);
    }
  });
});
