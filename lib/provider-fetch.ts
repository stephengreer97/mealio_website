/**
 * Talking to a platform API: a timeout, and a bounded body.
 *
 * These are the *credentialed* calls — `oauth2.googleapis.com`,
 * `graph.instagram.com`, `open.tiktokapis.com`. They deliberately skip the
 * guarded fetcher in `lib/import/ssrf.ts`, which exists for destinations an
 * outsider chose and cannot carry a token anyway. That reasoning is right about
 * the *host*, and it quietly took two other things with it: `ssrf.ts` also caps
 * the response at 2 MB and the request at 10 s, and neither of those is about
 * who chose the URL.
 *
 * Both matter here for the same reason. Every one of these calls runs inside a
 * function timeout, several of them inside the daily sweep's shared budget, and
 * an unbounded `await response.json()` on a socket that is answering slowly is
 * how one stalled provider consumes an invocation that had three other platforms
 * left to sweep. undici's own ceiling is a 300-second *headers* timeout, which is
 * no ceiling at all at cron scale.
 *
 * So: every provider call gets an `AbortSignal`, and every body is read through
 * a byte cap before it is parsed.
 */

/**
 * How long any single provider call may take, start to finish.
 *
 * Fifteen seconds. Google, Meta and TikTok all answer a token or list request in
 * well under a second when they are healthy, so this is not a latency budget —
 * it is the point past which "slow" and "never" stop being worth telling apart.
 * The sweep gives a hundred rows the same invocation; three hung sockets at
 * undici's default would be the whole of it.
 */
export const PROVIDER_TIMEOUT_MS = 15_000;

/**
 * The most of a provider response we will read.
 *
 * 2 MB, the same figure `lib/import/ssrf.ts` uses, and for the same reason: it
 * is far past anything these endpoints legitimately return (a token response is
 * a few hundred bytes; a hundred TikTok videos with descriptions is tens of
 * kilobytes) and far short of a body that could exhaust a function's memory. A
 * fixed host is not a promise about response size — a compromised or misbehaving
 * edge in front of one serves whatever it likes.
 */
export const PROVIDER_MAX_BYTES = 2 * 1024 * 1024;

/**
 * An `AbortSignal` that fires after `ms`, combined with a caller's own signal.
 *
 * Separate from the fetch call so the sweep can hand down a deadline that is
 * shorter than `PROVIDER_TIMEOUT_MS` when it is nearly out of budget: whichever
 * fires first wins, which is the behaviour a shared budget needs.
 */
export function providerSignal(ms: number = PROVIDER_TIMEOUT_MS, outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return outer ? AbortSignal.any([outer, timeout]) : timeout;
}

/**
 * Reads a JSON body, refusing to buffer more than `PROVIDER_MAX_BYTES`.
 *
 * Returns null on anything that is not parseable JSON within the cap, which is
 * the same thing every call site already did with `.catch(() => null)` — so the
 * failure paths that read `response.status` still read it, and nothing has to
 * learn a new error shape.
 *
 * The stream is read chunk by chunk rather than through `response.text()`
 * because `text()` buffers the whole body first, which is the thing being
 * bounded. A body that goes over the cap is abandoned mid-read.
 */
export async function readJsonCapped(
  response: Response,
  maxBytes: number = PROVIDER_MAX_BYTES,
): Promise<Record<string, any> | null> {
  const body = response.body;
  // No stream to read (an empty body, or a fetch mock that only implements
  // `json()`). Fall back, still guarded — nothing here trusts the parse.
  if (!body) return (await response.json().catch(() => null)) as Record<string, any> | null;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    // A socket that died mid-body. Indistinguishable from unparseable, and
    // handled the same way by every caller.
    return null;
  }

  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(joined));
  } catch {
    return null;
  }
}
