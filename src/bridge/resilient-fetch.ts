import type { Logger } from "pino";

/**
 * Transport-level failures safe to retry once. Deliberately excludes:
 *  - HTTP error responses (those surface as `res.error`, not throws);
 *  - undici timeouts (`UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT` /
 *    `UND_ERR_ABORTED`): these mean the request *was* delivered and the server
 *    is still working. Retrying doubles the wait and can run the agent turn
 *    twice.
 */
const TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const MESSAGE_HINTS =
  /fetch failed|socket hang up|other side closed|network|econnreset|econnrefused|etimedout|terminated|connection (?:reset|closed)/i;

/** Walk an error's `cause` chain for the first string `code` (undici/Node set it there). */
export function errorCauseCode(error: unknown): string | undefined {
  let cur = error as { code?: unknown; cause?: unknown } | undefined;
  const seen = new Set<unknown>();
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    if (typeof cur.code === "string") return cur.code;
    cur = cur.cause as typeof cur;
  }
  return undefined;
}

/**
 * True when an error is a transport/socket failure rather than an HTTP/API
 * error. Node's global `fetch` reports these as `TypeError: fetch failed`
 * with the real reason on `.cause`.
 *
 * When a cause code is present it is authoritative (so undici timeouts, which
 * also say "fetch failed", are correctly rejected); the message heuristic only
 * applies to coding-less errors (e.g. a bare `TypeError: fetch failed`).
 */
export function isTransportError(error: unknown): boolean {
  const code = errorCauseCode(error);
  if (code) return TRANSPORT_CODES.has(code);
  if (error instanceof Error) {
    return MESSAGE_HINTS.test(`${error.name}: ${error.message}`);
  }
  return false;
}

/** Short, loggable description that keeps the hidden transport cause visible. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCauseCode(error);
  return code && !message.includes(code) ? `${message} (cause: ${code})` : message;
}

export type FetchLike = (request: Request) => Promise<Response>;

export interface ResilientFetchOptions {
  /** Extra attempts after the first. Default 1. */
  retries?: number;
  /** Fixed delay between attempts. Default 250ms. */
  delayMs?: number;
  /** Called before each retry — wire a logger here. */
  onRetry?: (info: { attempt: number; error: unknown }) => void;
  /** Override the retry predicate (tests). */
  isRetryable?: (error: unknown) => boolean;
  logger?: Logger;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wrap a `fetch` so transport-level failures are retried a bounded number of
 * times. The opencode server can drop the first request after an idle period;
 * without this the bridge treated that transient blip as fatal and replied
 * "Bridge error talking to the agent" instead of the answer.
 *
 * Retries replay a clone of the original `Request` (bodies are single-use),
 * so the prompt payload survives the retry. HTTP error responses are not
 * retried — only thrown transport errors.
 */
export function createResilientFetch(
  base: FetchLike = (request) => globalThis.fetch(request),
  options: ResilientFetchOptions = {},
): FetchLike {
  const retries = options.retries ?? 1;
  const delayMs = options.delayMs ?? 250;
  const retryable = options.isRetryable ?? isTransportError;

  return async (request: Request): Promise<Response> => {
    if (retries <= 0) return base(request);

    // Pre-clone for every additional attempt BEFORE the body is consumed.
    const attempts: Request[] = [request];
    for (let i = 0; i < retries; i++) attempts.push(request.clone());

    let lastError: unknown;
    for (let attempt = 0; attempt < attempts.length; attempt++) {
      try {
        return await base(attempts[attempt]);
      } catch (error) {
        lastError = error;
        const isLast = attempt === attempts.length - 1;
        if (isLast || !retryable(error)) throw error;
        options.onRetry?.({ attempt: attempt + 1, error });
        if (delayMs > 0) await sleep(delayMs);
      }
    }
    throw lastError;
  };
}
