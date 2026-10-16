import { describe, expect, it, vi } from "vitest";
import { OpencodeClient, extractText, stripThinking } from "../src/bridge/opencode-client.js";
import type { FetchLike } from "../src/bridge/resilient-fetch.js";

const cfg = {
  OPENCODE_HOST: "127.0.0.1",
  OPENCODE_PORT: 4096,
  OPENCODE_AGENT: "whatsapp-bridge",
  OPENCODE_MODEL: "opencode/big-pickle",
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

  it("sends the configured model on every prompt (overrides stale session state)", async () => {
    let sent: { agent?: string; model?: unknown } = {};
    const impl: FetchLike = async (req) => {
      sent = JSON.parse(await req.text());
      return jsonResponse({ info: {}, parts: [{ type: "text", text: "ok" }] });
    };
    const client = new OpencodeClient(cfg, { fetch: impl });

    await expect(client.sendMessage("ses_1", "hi")).resolves.toBe("ok");
    expect(sent.model).toEqual({ providerID: "opencode", modelID: "big-pickle" });
    expect(sent.agent).toBe("whatsapp-bridge");
  });
});

describe("thinking is not sent to WhatsApp", () => {
  it("ignores reasoning-typed parts", () => {
    const text = extractText({
      parts: [
        { type: "reasoning", text: "17*23 = 391, so the answer is 391" },
        { type: "text", text: "391" },
      ],
    });
    expect(text).toBe("391");
  });

  it("strips a leaked think block", () => {
    expect(stripThinking("<thinking>17*23 = 391, so 391.</thinking>391")).toBe("391");
    expect(stripThinking("<think>let me work it out</think>391")).toBe("391");
  });

  it("strips a stray closing think tag", () => {
    expect(stripThinking("</think>Output: `hi`")).toBe("Output: `hi`");
  });

  it("drops an unclosed/truncated thinking block", () => {
    expect(stripThinking("<thinking>secret reasoning with no close")).toBe("");
    expect(stripThinking("Part one <think>truncated reason")).toBe("Part one");
    expect(stripThinking("Answer first<thinking>trailing")).toBe("Answer first");
  });

  it("drops a text part that is nothing but thinking", () => {
    const text = extractText({ parts: [{ type: "text", text: "</think>" }, { type: "text", text: "Hello" }] });
    expect(text).toBe("Hello");
  });
});
