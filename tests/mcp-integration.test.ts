import type { WASocket } from "@whiskeysockets/baileys";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearerAuth, mcpPostHandler } from "../src/mcp/server.js";
import { Store } from "../src/whatsapp/store.js";

const TOKEN = "test-token-0123456789abcdef";

function mockSock(): () => WASocket {
  let n = 0;
  const sock = {
    sendMessage: async () => ({ key: { id: `mock-${++n}` } }),
    readMessages: async () => undefined,
  } as unknown as WASocket;
  return () => sock;
}

describe("MCP Streamable HTTP (Inspector-compatible)", () => {
  let baseUrl = "";
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let store: Store;

  beforeAll(async () => {
    store = new Store(":memory:");
    store.saveMessage({
      wa_id: "seed-1",
      chat_jid: "62812@s.whatsapp.net",
      sender_jid: "62812@s.whatsapp.net",
      direction: "inbound",
      body: "hello",
      msg_type: "text",
      timestamp_ms: Date.now(),
    });
    const app = express();
    app.use(express.json());
    app.post("/mcp", bearerAuth(TOKEN), mcpPostHandler({ sock: mockSock(), store }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((e) => (e ? reject(e) : resolve()));
    });
    store.close();
  });

  it("rejects missing bearer token with 401", async () => {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
  });

  it("lists tools and calls get_messages / send_message / mark_read", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_messages", "mark_read", "send_message"]);

    const got = await client.callTool({ name: "get_messages", arguments: { limit: 5 } });
    const text = (got.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text).count).toBe(1);

    const sent = await client.callTool({
      name: "send_message",
      arguments: { to: "62812@s.whatsapp.net", text: "hi from test" },
    });
    expect(JSON.parse((sent.content as Array<{ text: string }>)[0].text).ok).toBe(true);

    const marked = await client.callTool({
      name: "mark_read",
      arguments: { jid: "62812@s.whatsapp.net" },
    });
    expect(JSON.parse((marked.content as Array<{ text: string }>)[0].text).ok).toBe(true);

    await client.close();
  }, 30_000);
});
