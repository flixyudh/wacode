import express from "express";
import type { Logger } from "pino";
import { loadConfig } from "./config.js";
import { healthHandler } from "./health.js";
import { attachListener } from "./bridge/listener.js";
import { LidResolver, parseStaticMap, seedSignalStore } from "./bridge/lid-resolver.js";
import { OpencodeClient } from "./bridge/opencode-client.js";
import { RateLimiter } from "./bridge/rate-limiter.js";
import { SessionManager } from "./bridge/session-manager.js";
import { Whitelist } from "./bridge/whitelist.js";
import { getLogger, createLogger } from "./logger.js";
import { bearerAuth, mcpMethodNotAllowed, mcpPostHandler } from "./mcp/server.js";
import { createWaConnection } from "./whatsapp/connection.js";
import { LruDedupe } from "./whatsapp/dedupe.js";
import { Store } from "./whatsapp/store.js";

const VERSION = "0.1.2";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger: Logger = createLogger(cfg);
  const startedAtMs = Date.now();
  let lastInboundAtMs: number | null = null;

  logger.info(
    {
      version: VERSION,
      mcpBind: cfg.MCP_BIND,
      mcpPort: cfg.MCP_PORT,
      loginMode: cfg.WHATSAPP_LOGIN_MODE,
      autoReadScope: cfg.AUTO_READ_SCOPE,
      sessionTtlHours: cfg.SESSION_TTL_HOURS,
      compactAfter: cfg.SESSION_COMPACT_AFTER,
      rateLimitSec: cfg.RATE_LIMIT_PER_SENDER_SECONDS,
      opencodeAgent: cfg.OPENCODE_AGENT,
      opencodeHost: cfg.OPENCODE_HOST,
      opencodePort: cfg.OPENCODE_PORT,
      whitelistSize: cfg.WHATSAPP_WHITELIST.length,
      sharedSecretGate: Boolean(cfg.WHATSAPP_SHARED_SECRET),
    },
    "wacode starting",
  );

  if (cfg.OPENCODE_AGENT === "build" || cfg.OPENCODE_AGENT === "plan") {
    logger.warn(
      { agent: cfg.OPENCODE_AGENT },
      "OPENCODE_AGENT targets a privileged built-in agent — use the dedicated least-privilege whatsapp-bridge agent",
    );
  }

  const store = new Store(cfg.DB_PATH);
  const whitelist = new Whitelist(cfg.WHATSAPP_WHITELIST);
  let staticLidMap: Map<string, string>;
  try {
    staticLidMap = parseStaticMap(cfg.WHATSAPP_LID_MAP);
  } catch (e) {
    logger.fatal({ err: (e as Error).message }, "invalid WHATSAPP_LID_MAP");
    process.exit(1);
  }
  const lidResolver = new LidResolver(store, staticLidMap, logger);
  logger.info(
    { staticLidEntries: lidResolver.staticSize },
    "LID resolver ready (static map + SQLite cache + passive learning)",
  );
  const sessions = new SessionManager(store, cfg.SESSION_TTL_HOURS, cfg.SESSION_COMPACT_AFTER);
  const limiter = new RateLimiter(cfg.RATE_LIMIT_PER_SENDER_SECONDS);
  const dedupeHot = new LruDedupe(2000);
  const opencode = new OpencodeClient(cfg);

  const conn = await createWaConnection({ cfg, logger });
  const { sock, getState, close: closeWa } = conn;

  // Seed Baileys' own LID store (v7+) with static mappings — best effort.
  await seedSignalStore(sock, staticLidMap, logger);

  attachListener({
    cfg,
    logger,
    sock,
    onEvent: conn.onEvent,
    lidResolver,
    store,
    whitelist,
    sessions,
    limiter,
    opencode,
    dedupeHot,
    onInbound: (at) => {
      lastInboundAtMs = at;
    },
  });
  logger.info(conn.getDiagnostics(), "messages.upsert listener attached");

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", healthHandler({
    getSocketState: getState,
    getLastInboundAtMs: () => lastInboundAtMs,
    opencode,
    startedAtMs,
    version: VERSION,
    getDiagnostics: () => conn.getDiagnostics(),
    configSnapshot: {
      loginMode: cfg.WHATSAPP_LOGIN_MODE,
      autoReadScope: cfg.AUTO_READ_SCOPE,
      whitelistSize: cfg.WHATSAPP_WHITELIST.length,
      opencode: { host: cfg.OPENCODE_HOST, port: cfg.OPENCODE_PORT, agent: cfg.OPENCODE_AGENT },
    },
  }));

  const mcpDeps = { sock: () => sock, store };
  app.post("/mcp", bearerAuth(cfg.MCP_TOKEN), mcpPostHandler(mcpDeps));
  app.get("/mcp", bearerAuth(cfg.MCP_TOKEN), mcpMethodNotAllowed);
  app.delete("/mcp", bearerAuth(cfg.MCP_TOKEN), mcpMethodNotAllowed);

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const s = app.listen(cfg.MCP_PORT, cfg.MCP_BIND, () => resolve(s));
    s.on("error", reject);
  });
  logger.info({ bind: cfg.MCP_BIND, port: cfg.MCP_PORT }, "HTTP server listening (/mcp + /healthz)");

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    try {
      server.close();
    } catch {
      // ignore
    }
    try {
      await closeWa();
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "wa close failed");
    }
    try {
      store.close();
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "store close failed");
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  try {
    getLogger().fatal({ err: (e as Error).message, stack: (e as Error).stack }, "fatal boot error");
  } catch {
    console.error("fatal boot error", e);
  }
  process.exit(1);
});
