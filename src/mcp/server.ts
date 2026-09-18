import type { WASocket } from "@whiskeysockets/baileys";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Store } from "../whatsapp/store.js";
import { getMessagesTool } from "./tools/get-messages.js";
import { markReadTool } from "./tools/mark-read.js";
import { sendMessageTool } from "./tools/send-message.js";

export interface McpDeps {
  sock: () => WASocket;
  store: Store;
}

function textResult(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

/** Create a fresh McpServer per request (stateless transport). */
export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "whatsapp-bridge", version: "0.1.2" });

  server.tool(
    "send_message",
    "Send a WhatsApp text message (auto-chunked to 4096 chars). `to` accepts a full JID or bare phone number.",
    { to: z.string().min(1), text: z.string().min(1).max(200_000) },
    async ({ to, text }) => textResult(await sendMessageTool(deps.sock, deps.store, { to, text })),
  );

  server.tool(
    "get_messages",
    "Read stored WhatsApp messages. Omit `jid` for recent across all chats.",
    { jid: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) },
    async ({ jid, limit }) => textResult(getMessagesTool(deps.store, { jid, limit })),
  );

  server.tool(
    "mark_read",
    "Mark a chat (or specific message ids) as read, locally and on the wire (best-effort).",
    { jid: z.string().min(1), ids: z.array(z.string()).optional() },
    async ({ jid, ids }) => textResult(await markReadTool(deps.sock, deps.store, { jid, ids })),
  );

  return server;
}

/** Express middleware: require `Authorization: Bearer <token>` (constant-time compare). */
export function bearerAuth(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? "";
    const expected = `Bearer ${token}`;
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (!ok) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

/** Stateless Streamable-HTTP handler: new server+transport per POST. */
export function mcpPostHandler(deps: McpDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const server = buildMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({ error: "mcp handler failed", detail: (e as Error).message });
      }
    } finally {
      try {
        await transport.close?.();
      } catch {
        // ignore
      }
      try {
        await server.close?.();
      } catch {
        // ignore
      }
    }
  };
}

/** GET/DELETE on /mcp are not supported in stateless mode — tell clients plainly. */
export function mcpMethodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    error: "method not allowed in stateless mode",
    hint: "Use POST /mcp with Accept: application/json, text/event-stream",
  });
}
