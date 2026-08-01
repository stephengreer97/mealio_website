import { readFileSync } from 'fs';
import { join } from 'path';
import type { LookupFn } from '@/lib/import/ssrf';
import type { StructuredCaller, StructuredRequest } from '@/lib/import/anthropic';

/**
 * Stubs for the import pipeline's four injection seams: DNS, fetch, the
 * Anthropic caller, and the clock. Nothing here touches the network, and no
 * test in this suite needs an API key.
 */

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/import');

export function readHtmlFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, 'html', name), 'utf8');
}

/** DNS that answers everything with one public address. */
export const publicLookup: LookupFn = async () => ['93.184.216.34'];

/** DNS that answers with whatever the map says, per hostname. */
export function lookupMap(map: Record<string, string[]>): LookupFn {
  return async (hostname) => {
    const addresses = map[hostname];
    if (!addresses) throw new Error(`ENOTFOUND ${hostname}`);
    return addresses;
  };
}

export interface StubRoute {
  status?: number;
  headers?: Record<string, string>;
  body?: string | ReadableStream<Uint8Array> | null;
}

/**
 * A fetch that serves a fixed map of URL → response. Records every URL it was
 * asked for, so a test can assert on the redirect chain that actually happened.
 */
export function stubFetch(routes: Record<string, StubRoute>) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    const route = routes[url];
    if (!route) {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    }
    const status = route.status ?? 200;
    const headers = { 'content-type': 'text/html; charset=utf-8', ...(route.headers ?? {}) };
    const nullBody = status === 204 || status === 304 || (status >= 300 && status < 400);
    return new Response(nullBody ? null : (route.body ?? ''), { status, headers });
  }) as unknown as typeof fetch;

  return { impl, calls };
}

/** A fetch that never resolves until its signal aborts. */
export const hangingFetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      reject(error);
    });
  })) as unknown as typeof fetch;

/** A body stream that keeps producing 1 MB chunks — the 50 MB page case. */
export function endlessBody(chunkSize = 1024 * 1024, maxChunks = 50) {
  let produced = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced >= maxChunks) {
        controller.close();
        return;
      }
      produced++;
      controller.enqueue(new Uint8Array(chunkSize));
    },
  });
  return { stream, chunksProduced: () => produced };
}

/**
 * An Anthropic caller that returns canned output without any network call.
 * `handler` receives the request so a test can branch on which model was asked.
 */
export function stubCaller(
  handler: (request: StructuredRequest<unknown>) => unknown,
  usage: { inputTokens?: number; outputTokens?: number } = {},
): StructuredCaller & { requests: StructuredRequest<unknown>[] } {
  const requests: StructuredRequest<unknown>[] = [];
  const call = (async (request: StructuredRequest<unknown>) => {
    requests.push(request);
    return {
      output: handler(request),
      usage: {
        model: request.model,
        inputTokens: usage.inputTokens ?? 3000,
        outputTokens: usage.outputTokens ?? 1500,
        costUsd: 0.0525,
      },
    };
  }) as StructuredCaller & { requests: StructuredRequest<unknown>[] };
  call.requests = requests;
  return call;
}

/** A caller that always throws — the "no API key provisioned" case. */
export function failingCaller(message = 'ANTHROPIC_API_KEY is not set'): StructuredCaller {
  return (async () => {
    throw new Error(message);
  }) as StructuredCaller;
}

/** A minimal well-formed extraction payload, for tests that don't care about content. */
export function extractionFixture(overrides: Record<string, unknown> = {}) {
  return {
    name: { value: 'Best Guacamole', evidence: 'Best Guacamole', derivation: 'json-ld' },
    ingredients: [
      {
        productName: 'avocados',
        measure: '4',
        unit: 'qty',
        qty: 4,
        // Verbatim from the recorded page's JSON-LD block.
        evidence: '4 medium ripe avocados, halved and pitted',
        derivation: 'json-ld',
      },
    ],
    recipe: { value: 'Mash the avocados.', evidence: 'Mash the avocados', derivation: 'normalized' },
    story: { value: '', evidence: null, derivation: 'absent' },
    difficulty: { value: 1, evidence: 'ready in 15 minutes', derivation: 'inferred' },
    tags: { value: ['Mexican', 'No Cook'], evidence: 'guacamole', derivation: 'inferred' },
    serves: { value: '2 1/2 cups guacamole', evidence: '2 1/2 cups guacamole', derivation: 'json-ld' },
    ...overrides,
  };
}

/**
 * A body that emits one byte every `intervalMs` and never ends — the slow-drip
 * server. It never trips the size cap and never stalls a single read, so only a
 * wall-clock deadline stops it.
 */
export function drippingBody(intervalMs = 20) {
  let emitted = 0;
  let timer: NodeJS.Timeout | undefined;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      return new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          emitted++;
          controller.enqueue(new Uint8Array([0x61]));
          resolve();
        }, intervalMs);
      });
    },
    cancel() {
      if (timer) clearTimeout(timer);
    },
  });
  return { stream, bytesEmitted: () => emitted };
}

/** A cache whose every operation throws — the durable-store-outage case. */
export function brokenCache() {
  return {
    async get(): Promise<never> {
      throw new Error('cache backend unavailable');
    },
    async set(): Promise<never> {
      throw new Error('cache backend unavailable');
    },
    async delete(): Promise<never> {
      throw new Error('cache backend unavailable');
    },
  };
}
