import type { Request, Response } from "express";
import type { ConnectionState } from "./whatsapp/connection.js";
import type { OpencodeClient } from "./bridge/opencode-client.js";

export interface HealthDeps {
  getSocketState: () => ConnectionState;
  getLastInboundAtMs: () => number | null;
  opencode: OpencodeClient;
  startedAtMs: number;
  version: string;
  /** Effective config snapshot — makes stale-config (edited .env without
   * restart) visible without reading the terminal. */
  configSnapshot: {
    loginMode: string;
    autoReadScope: string;
    whitelistSize: number;
    opencode: { host: string; port: number; agent: string };
  };
  getDiagnostics: () => { wsOpen: boolean | null; attached: Record<string, number> };
}

export function healthHandler(deps: HealthDeps) {
  return async (_req: Request, res: Response): Promise<void> => {
    const opencodeReachable = await deps.opencode.isReachable().catch(() => false);
    const socket = deps.getSocketState();
    const lastInbound = deps.getLastInboundAtMs();
    const ok = socket === "open";
    res.status(ok ? 200 : 503).json({
      status: ok ? "ok" : "degraded",
      version: deps.version,
      uptime_s: Math.floor((Date.now() - deps.startedAtMs) / 1000),
      socket,
      lastInboundAt: lastInbound ? new Date(lastInbound).toISOString() : null,
      opencodeReachable,
      config: deps.configSnapshot,
      diag: deps.getDiagnostics(),
    });
  };
}
