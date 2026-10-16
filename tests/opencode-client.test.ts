import { describe, expect, it, vi } from "vitest";
import { OpencodeClient } from "../src/bridge/opencode-client.js";
import type { FetchLike } from "../src/bridge/resilient-fetch.js";

const cfg = {
  OPENCODE_HOST: "127.0.0.1",
  OPENCODE_PORT: 4096,
  OPENCODE_AGENT: "whatsapp-bridge",
  OPENCODE_PASSWORD: "",
  OPENCODE_TIMEOUT_MS: 5000,
} as const;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("OpencodeClient transport resilience", () => {
  it("recovers createSession when the first attempt fails at the transport layer", async () => {
    const calls: Request[] = [];
    const failingOnce: FetchLike = vi.fn(async (request: Request) => {
      calls.push(request);
      if (calls.length === 1) {
        throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      }
      return jsonResponse({ id: "ses_recovered" });
    });

    const client = new OpencodeClient(cfg, { fetch: failingOnce });

    await expect(client.createSession("whatsapp:628@x")).resolves.toBe("ses_recovered");
    expect(calls).toHaveLength(2);
    // The retry must target the same endpoint (body survives the replay).
    expect(calls[1].url).toContain("/session");
  });

  it("does not retry an HTTP error response", async () => {
    const impl: FetchLike = vi.fn(
      async () =>
        new Response(JSON.stringify({ name: "NotFound", message: "no such session" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new OpencodeClient(cfg, { fetch: impl });

    // 404 is a response, not a transport throw: the SDK surfaces res.error and
    // we must fail immediately rather than replay the request.
    await expect(client.createSession()).rejects.toThrow(/createSession failed/);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled request at OPENCODE_TIMEOUT_MS and does not retry it", async () => {
    let calls = 0;
    const neverResolves: FetchLike = () => {
      calls++;
      return new Promise<Response>(() => {});
    };
    const client = new OpencodeClient({ ...cfg, OPENCODE_TIMEOUT_MS: 30 }, { fetch: neverResolves });

    await expect(client.createSession()).rejects.toThrow(/timed out after 30ms/);
    expect(calls).toBe(1);
  });
});
