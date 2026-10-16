import { describe, expect, it, vi } from "vitest";
import { createResilientFetch, isTransportError } from "../src/bridge/resilient-fetch.js";

/** A `fetch` that rejects with undici-style transport errors the given number
 * of times before succeeding. */
function flakyFetch(failures: unknown[], ok: Response) {
  const calls: Request[] = [];
  const impl = vi.fn(async (req: Request) => {
    calls.push(req);
    const next = failures.shift();
    if (next) throw next;
    return ok;
  });
  return { impl, calls };
}

describe("isTransportError", () => {
  it("recognizes undici 'fetch failed' with a socket cause code", () => {
    const err = new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
    expect(isTransportError(err)).toBe(true);
  });

  it("recognizes a bare 'fetch failed'", () => {
    expect(isTransportError(new TypeError("fetch failed"))).toBe(true);
  });

  it("does not treat an HTTP-ish/unknown error as transport", () => {
    expect(isTransportError(new Error("prompt failed: 404"))).toBe(false);
    expect(isTransportError(new Error("boom"))).toBe(false);
    expect(isTransportError(undefined)).toBe(false);
  });
});

describe("createResilientFetch", () => {
  it("retries once on a transport error and returns the successful response", async () => {
    const transport = new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    const { impl } = flakyFetch([transport], new Response("ok", { status: 200 }));
    const fetchImpl = createResilientFetch(impl, { delayMs: 0, retries: 1 });

    const res = await fetchImpl(new Request("http://x/session/1/message", { method: "POST", body: "hello" }));

    expect(res.status).toBe(200);
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it("replays the request body on the retry (body is not consumed by the failed attempt)", async () => {
    const transport = new TypeError("fetch failed");
    const { impl, calls } = flakyFetch([transport], new Response("ok"));
    const fetchImpl = createResilientFetch(impl, { delayMs: 0, retries: 1 });

    await fetchImpl(new Request("http://x/y", { method: "POST", body: "payload" }));

    expect(calls).toHaveLength(2);
    await expect(calls[1].text()).resolves.toBe("payload");
  });

  it("does not retry a non-transport error", async () => {
    const { impl } = flakyFetch([new Error("boom")], new Response("ok"));
    const fetchImpl = createResilientFetch(impl, { delayMs: 0, retries: 2 });

    await expect(fetchImpl(new Request("http://x/y"))).rejects.toThrow("boom");
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured number of retries", async () => {
    const transport = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    const { impl } = flakyFetch([transport, transport, transport], new Response("ok"));
    const fetchImpl = createResilientFetch(impl, { delayMs: 0, retries: 1 });

    await expect(fetchImpl(new Request("http://x/y"))).rejects.toThrow("fetch failed");
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it("reports retries via onRetry for observability", async () => {
    const transport = new TypeError("fetch failed", { cause: { code: "ETIMEDOUT" } });
    const { impl } = flakyFetch([transport], new Response("ok"));
    const onRetry = vi.fn();
    const fetchImpl = createResilientFetch(impl, { delayMs: 0, retries: 1, onRetry });

    await fetchImpl(new Request("http://x/y"));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 1 });
  });
});
