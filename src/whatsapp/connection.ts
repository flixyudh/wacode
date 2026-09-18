import fs from "node:fs";
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
  type MessageUpsertType,
  type WAMessage,
  type WAMessageUpdate,
  type WASocket,
} from "@whiskeysockets/baileys";
import type { Logger } from "pino";
import qrcode from "qrcode-terminal";
import type { AppConfig } from "../config.js";

export type ConnectionState = "open" | "connecting" | "close";

export interface ConnectionDeps {
  cfg: AppConfig;
  logger: Logger;
}

export interface UpsertData {
  messages: WAMessage[];
  type: MessageUpsertType;
  requestId?: string;
}

/** Events our sink supports (subset of Baileys' emitter). */
export type KnownBaileysEvent =
  | "messages.upsert"
  | "messages.update"
  | "contacts.upsert"
  | "contacts.update"
  | "lid-mapping.update"
  | "messaging-history.set";

/** Minimal structural contact (avoids coupling to Baileys' Contact export). */
export interface ContactLike {
  id?: string;
  lid?: string;
  phoneNumber?: string;
  name?: string;
  notify?: string;
}

/** LID↔PN pair as shared by Baileys v7 (`lid-mapping.update`, history sync). */
export interface LidPnMapping {
  lid: string;
  pn: string;
}

/** History-sync payload subset we harvest mappings/contacts from. */
export interface HistorySetLike {
  contacts?: ContactLike[];
  lidPnMappings?: LidPnMapping[];
}

/** Reconnect-safe Baileys event subscription (see WaConnection.onEvent). */
export interface BaileysEventSink {
  onEvent(event: "messages.upsert", handler: (data: UpsertData) => void): void;
  onEvent(event: "messages.update", handler: (data: WAMessageUpdate[]) => void): void;
  onEvent(event: "contacts.upsert" | "contacts.update", handler: (data: ContactLike[]) => void): void;
  onEvent(event: "lid-mapping.update", handler: (data: LidPnMapping) => void): void;
  onEvent(event: "messaging-history.set", handler: (data: HistorySetLike) => void): void;
}

export interface WaConnection extends BaileysEventSink {
  sock: WASocket;
  getState: () => ConnectionState;
  close: () => Promise<void>;
  /**
   * Live diagnostics for /healthz: subscription attach counts per event
   * (they grow across reconnects) plus transport state.
   */
  getDiagnostics: () => { wsOpen: boolean | null; attached: Record<string, number> };
}

/**
 * Validate auth dir early: if it exists but is unreadable/corrupt we must
 * fail loudly instead of silently starting a fresh QR/pairing flow.
 */
function assertAuthDirReadable(authDir: string, logger: Logger): void {
  try {
    if (!fs.existsSync(authDir)) return;
    const stat = fs.statSync(authDir);
    if (!stat.isDirectory()) {
      throw new Error(`${authDir} exists but is not a directory`);
    }
    // Try listing + reading files — EACCES / parse errors surface here.
    const files = fs.readdirSync(authDir);
    for (const f of files.slice(0, 20)) {
      try {
        fs.accessSync(`${authDir}/${f}`, fs.constants.R_OK);
      } catch (e) {
        throw new Error(`auth file not readable: ${f}: ${(e as Error).message}`);
      }
    }
    logger.info({ authDir, files: files.length }, "auth dir present, readable");
  } catch (e) {
    throw new Error(
      `Auth storage at ${authDir} is present but unreadable/corrupt: ${(e as Error).message}. ` +
        `Back it up, fix permissions, or delete it deliberately to re-pair. Refusing to start with a silent fresh login.`,
    );
  }
}

/** Normalize + validate a phone number for `requestPairingCode`.
 * Must be digits with country code, no `+`, no spaces, no leading trunk `0`.
 * Throws with an actionable message instead of letting WA fail cryptically. */
export function normalizePhoneForPairing(raw: string): string {
  const phone = (raw ?? "").replace(/\D/g, "");
  if (!phone) {
    throw new Error(
      "WHATSAPP_PHONE_NUMBER is required for pairing mode (digits with country code, e.g. 6281234567890)",
    );
  }
  if (phone.startsWith("0")) {
    throw new Error(
      `WHATSAPP_PHONE_NUMBER="${raw}" starts with 0 — use full international format without "+" or trunk zero (e.g. Indonesian 0812… → 62812…). Got digits: ${phone}`,
    );
  }
  if (phone.length < 7 || phone.length > 15) {
    throw new Error(
      `WHATSAPP_PHONE_NUMBER="${raw}" looks wrong (E.164 is 7–15 digits with country code). Got digits: ${phone}`,
    );
  }
  return phone;
}

function statusCodeOf(err: unknown): number | undefined {
  const e = err as { output?: { statusCode?: number } } | undefined;
  return e?.output?.statusCode;
}

/**
 * Wait until the underlying WebSocket transport is open.
 *
 * NOTE: this is deliberately NOT `connection.update === "open"` — that event
 * means login complete, which never fires for a fresh device until pairing
 * succeeds. `requestPairingCode` only needs the transport (`ws.isOpen`),
 * and Baileys exposes exactly that as `sock.waitForSocketOpen()`.
 * While waiting we also watch `connection.update` so a server-side close
 * (e.g. rejected version, stream error) is reported with its real status
 * code instead of a bare timeout.
 */
async function waitForTransport(sock: WASocket, logger: Logger, timeoutMs = 30_000): Promise<void> {
  let closeErr: unknown;
  const onUpdate = (u: { connection?: string; lastDisconnect?: { error?: unknown } }): void => {
    if (u.connection === "close" && u.lastDisconnect?.error) {
      closeErr = u.lastDisconnect.error;
      const code = statusCodeOf(closeErr);
      logger.error({ code, err: (closeErr as Error)?.message }, "connection closed while waiting for transport");
    }
  };
  sock.ev.on("connection.update", onUpdate);
  try {
    await Promise.race([
      sock.waitForSocketOpen(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `transport not open after ${timeoutMs}ms. ` +
                  `If logs show "connected to WA", the handshake reached WhatsApp but stalled — retry. ` +
                  `If nothing after "connection.update connecting", the network is blocking WhatsApp ` +
                  `(corporate firewall/VPN/DNS) — try a phone hotspot to confirm.`,
              ),
            ),
          timeoutMs,
        ),
      ),
    ]);
  } catch (e) {
    // Prefer the server-reported close reason over the generic WS error.
    if (closeErr) throw closeErr;
    throw e;
  } finally {
    try {
      sock.ev.off("connection.update", onUpdate);
    } catch {
      // ignore
    }
  }
}

/** Wait until `getSock()` returns a different instance (reconnect happened). */
async function waitForNewSocket(prev: WASocket, getSock: () => WASocket, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (getSock() === prev && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 250));
  }
}

export type PairingReady = "qr" | "settled" | "open";

/**
 * Docs-driven pairing trigger (https://baileys.wiki/authentication/pairing-code):
 * the server emits `qr` (pair-device refs) even in pairing-code mode, AFTER
 * the handshake settles on the registration path — so it is the
 * deterministic "safe to request" signal (no magic delay needed).
 * Falls back to transport-open + quiet settle if no qr arrives (covers a
 * missed trigger); rejects if the connection closes first.
 */
async function waitForPairingReady(
  s: WASocket,
  logger: Logger,
  opts?: { qrTimeoutMs?: number; settleMs?: number },
): Promise<PairingReady> {
  const qrTimeoutMs = opts?.qrTimeoutMs ?? 45_000;
  const settleMs = opts?.settleMs ?? 4000;
  return new Promise((resolve, reject) => {
    let done = false;
    let settleTimer: NodeJS.Timeout | undefined;
    const finish = (v: PairingReady): void => {
      if (done) return;
      done = true;
      cleanup();
      resolve(v);
    };
    const fail = (e: unknown): void => {
      if (done) return;
      done = true;
      cleanup();
      reject(e);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      if (settleTimer) clearTimeout(settleTimer);
      try {
        s.ev.off("connection.update", onUpdate);
      } catch {
        // ignore
      }
    };
    const timer = setTimeout(() => {
      logger.warn("no pairing qr seen — requesting code after settle fallback");
      finish("settled");
    }, qrTimeoutMs);
    const onUpdate = (u: { connection?: string; lastDisconnect?: { error?: unknown }; qr?: string }): void => {
      if (u.qr) {
        logger.debug("pairing trigger: server-issued qr (handshake settled)");
        finish("qr");
        return;
      }
      if (u.connection === "open") {
        finish("open");
        return;
      }
      if (u.connection === "close") {
        const code = statusCodeOf(u.lastDisconnect?.error);
        fail(new Error(`connection closed while awaiting pairing trigger (code ${code ?? "unknown"})`));
      }
    };
    s.ev.on("connection.update", onUpdate);
    // Settle fallback in case the qr was missed: transport open + quiet window.
    void waitForTransport(s, logger, qrTimeoutMs)
      .then(() => {
        if (done) return;
        settleTimer = setTimeout(() => finish("settled"), settleMs);
      })
      .catch((e) => fail(e));
  });
}

export async function createWaConnection({ cfg, logger }: ConnectionDeps): Promise<WaConnection> {
  assertAuthDirReadable(cfg.AUTH_DIR, logger);

  const { state, saveCreds } = await useMultiFileAuthState(cfg.AUTH_DIR).catch((e: Error) => {
    throw new Error(
      `Failed to load auth state from ${cfg.AUTH_DIR}: ${e.message}. ` +
        `Restore from backup or delete deliberately to re-pair. Refusing silent fresh login.`,
    );
  });
  const { version } = await fetchLatestBaileysVersion().catch((e: Error) => {
    logger.warn({ err: e.message }, "fetchLatestBaileysVersion failed, using Baileys default version");
    return { version: undefined as unknown as [number, number, number] | undefined };
  });

  let connectionState: ConnectionState = "connecting";
  let sock: WASocket;
  let closed = false;
  let backoffAttempt = 0;
  let qrCount = 0;
  const eventHandlers: Array<
    | { event: "messages.upsert"; handler: (data: UpsertData) => void }
    | { event: "messages.update"; handler: (data: WAMessageUpdate[]) => void }
    | { event: "contacts.upsert" | "contacts.update"; handler: (data: ContactLike[]) => void }
    | { event: "lid-mapping.update"; handler: (data: LidPnMapping) => void }
    | { event: "messaging-history.set"; handler: (data: HistorySetLike) => void }
  > = [];
  const attachedCounts: Record<string, number> = {};

  const connect = (): WASocket => {
    const s = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      // NOTE: the legacy printQRInTerminal option is deprecated per official
      // docs — never set it. We print QRs ourselves (once, numbered) below.
      browser: ["WACode", "Chrome", "1.0.0"],
      markOnlineOnConnect: true,
      syncFullHistory: false,
    });

    s.ev.on("creds.update", saveCreds);
    // Re-attach inbound handlers: each reconnect creates a new socket
    // (and EventEmitter), so boot-time-only subscriptions would go deaf.
    for (const entry of eventHandlers) {
      if (entry.event === "messages.upsert") {
        s.ev.on("messages.upsert", entry.handler);
      } else if (entry.event === "messages.update") {
        s.ev.on("messages.update", entry.handler);
      } else if (entry.event === "lid-mapping.update") {
        s.ev.on("lid-mapping.update", entry.handler);
      } else if (entry.event === "messaging-history.set") {
        s.ev.on("messaging-history.set", entry.handler);
      } else {
        s.ev.on(entry.event, entry.handler);
      }
      attachedCounts[entry.event] = (attachedCounts[entry.event] ?? 0) + 1;
    }

    s.ev.on("connection.update", async (u) => {
      const { connection, lastDisconnect, qr } = u;
      // QR mode: print exactly once per rotation. WhatsApp rotates the ref
      // (~60s first, ~20s after) and reconnects mint fresh refs — EVERY new
      // QR invalidates all previous ones, so number them and say so.
      if (qr && cfg.WHATSAPP_LOGIN_MODE === "qr") {
        qrCount += 1;
        logger.warn(
          { qrNumber: qrCount },
          `QR #${qrCount} received — scan NOW with WhatsApp > Linked devices > Link a device${qrCount > 1 ? " (earlier codes are INVALID, use this one)" : ""}`,
        );
        try {
          qrcode.generate(qr, { small: true });
        } catch {
          logger.info({ qr }, "QR (paste into a renderer)");
        }
      }
      if (connection) {
        connectionState = connection as ConnectionState;
        logger.info({ connection }, "connection.update");
      }
      if (connection === "close" && !closed) {
        const code = statusCodeOf(lastDisconnect?.error);
        // 401 before first pairing is NOT a logout — the server rejects the
        // login handshake while the device is still unpaired (428 close then
        // 401 failure is the usual sequence). Only a 401 on an established
        // (registered) session means re-auth is needed.
        const registered = s.authState?.creds?.registered;
        if (code === DisconnectReason.loggedOut && registered) {
          logger.fatal(
            { code },
            "Logged out from WhatsApp — delete data/auth_info and re-pair. Not retrying.",
          );
          return;
        }
        if (code === DisconnectReason.loggedOut && !registered) {
          logger.warn(
            { code },
            "server rejected pre-pairing login (expected until the code is approved) — reconnecting to await approval",
          );
        }
        // Transient drop → exponential backoff reconnect.
        backoffAttempt += 1;
        const delayMs = Math.min(60_000, 2000 * 2 ** Math.min(backoffAttempt - 1, 5));
        logger.warn({ code, attempt: backoffAttempt, delayMs }, "connection closed, reconnecting with backoff");
        await new Promise((r) => setTimeout(r, delayMs));
        if (closed) return;
        try {
          sock = connect();
        } catch (e) {
          logger.error({ err: (e as Error).message }, "reconnect failed, will retry on next close event");
        }
      }
      if (connection === "open") {
        backoffAttempt = 0;
        logger.info("WhatsApp socket open");
      }
    });

    return s;
  };

  sock = connect()!;

  // Pairing-code login (headless default). See the settle loop below for why
  // the request must wait for the initial handshake to finish.
  if (cfg.WHATSAPP_LOGIN_MODE === "pairing" && !state.creds.registered) {
    const phone = normalizePhoneForPairing(cfg.WHATSAPP_PHONE_NUMBER);

    // Stale auth for a *different* number is the other classic failure:
    // Baileys pins creds.me on first request, so changing the number
    // without wiping auth always fails. Fail loudly with the fix.
    const existingMe = state.creds.me?.id;
    if (existingMe && !existingMe.startsWith(`${phone}@`) && !existingMe.startsWith(`${phone}:`)) {
      throw new Error(
        `Auth in ${cfg.AUTH_DIR} belongs to ${existingMe} but WHATSAPP_PHONE_NUMBER=${phone}. ` +
          `Delete ${cfg.AUTH_DIR} deliberately to re-pair with the new number (this wipes the old pairing).`,
      );
    }

    logger.info({ phone }, "waiting for pairing trigger before requesting code…");

    // Official pattern (baileys.wiki/authentication/pairing-code): request on
    // the server-issued `qr` trigger — it fires after the handshake settles
    // on the REGISTRATION path, so requesting then can't flip
    // validateConnection onto the login path with still-unpaired creds
    // (server kills those with 428 close → 401 on retry).
    //
    // Critical: request EXACTLY ONCE per boot. Every requestPairingCode call
    // mints a NEW random code server-side, so re-requesting after a reconnect
    // invalidates the code the user may already be typing on their phone —
    // the phone then fails with "Couldn't link device". If the socket drops
    // after issuing, just wait: the pending code survives transport drops and
    // pair-success arrives on the reconnected socket.
    let code: string | undefined;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3 && !state.creds.registered && !code; attempt++) {
      const s = sock; // current transport; reconnects replace it
      try {
        const ready = await waitForPairingReady(s, logger);
        logger.info({ ready, attempt }, "pairing trigger reached, requesting code");
        // requestPairingCode is send-only (no server ack): a throw means the
        // stanza never left, so retrying is safe and does NOT invalidate
        // anything. A success means the code is live — never ask again.
        code = await s.requestPairingCode(phone);
        lastErr = undefined;
      } catch (e) {
        lastErr = e;
        logger.warn({ err: (e as Error).message, attempt }, "pairing attempt failed before issuance, waiting for reconnect…");
        await waitForNewSocket(s, () => sock, 30_000);
      }
    }
    if (state.creds.registered) {
      logger.info("device became registered while requesting pairing code — continuing");
    } else if (!code) {
      throw new Error(
        `requestPairingCode failed after retries: ${(lastErr as Error)?.message ?? lastErr}. ` +
          `Common causes: wrong number format (must be country-code digits, no "+" / spaces / leading 0), ` +
          `no network route to WhatsApp, or stale ${cfg.AUTH_DIR} — delete it and retry.`,
      );
    } else {
      logger.warn(
        { pairingCode: code, phone },
        "Enter this pairing code on your phone within ~60s: WhatsApp > Settings > Linked devices > Link a device > Link with phone number",
      );
      console.log(`\n========================================`);
      console.log(`  Pairing code for ${phone}: ${code}`);
      console.log(`  Phone: WhatsApp > Settings > Linked devices`);
      console.log(`         > Link a device > Link with phone number`);
      console.log(`  Enter THIS code within ~60s. Older codes from previous`);
      console.log(`  boots are invalid — never restart while typing it in.`);
      console.log(`  NOTE: "401 rejected pre-pairing login" warnings below are`);
      console.log(`  expected until you approve — keep the daemon running.`);
      console.log(`========================================\n`);
    }
  }

  // NOTE: `sock` is reassigned on reconnect. Expose a stable proxy that
  // always forwards to the current socket (binding methods to it).
  const sockProxy = new Proxy({} as WASocket, {
    get: (_t, p) => {
      const v = (sock as unknown as Record<string | symbol, unknown>)[p as string];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(sock) : v;
    },
    set: (_t, p, value) => {
      (sock as unknown as Record<string | symbol, unknown>)[p as string] = value;
      return true;
    },
  }) as WASocket;

  return {
    sock: sockProxy,
    getState: () => connectionState,
    getDiagnostics: () => {
      let wsOpen: boolean | null = null;
      try {
        const anySock = sock as unknown as { ws?: { isOpen?: boolean } };
        if (typeof anySock.ws?.isOpen === "boolean") wsOpen = anySock.ws.isOpen;
      } catch {
        // diagnostics must never throw
      }
      return { wsOpen, attached: { ...attachedCounts } };
    },
    onEvent: ((event: KnownBaileysEvent, handler: (data: never) => void) => {
      if (event === "messages.upsert") {
        eventHandlers.push({ event, handler: handler as (data: UpsertData) => void });
      } else if (event === "messages.update") {
        eventHandlers.push({ event, handler: handler as (data: WAMessageUpdate[]) => void });
      } else if (event === "lid-mapping.update") {
        eventHandlers.push({ event, handler: handler as (data: LidPnMapping) => void });
      } else if (event === "messaging-history.set") {
        eventHandlers.push({ event, handler: handler as (data: HistorySetLike) => void });
      } else {
        eventHandlers.push({ event, handler: handler as (data: ContactLike[]) => void });
      }
      try {
        if (event === "messages.upsert") {
          sock.ev.on("messages.upsert", handler as (data: UpsertData) => void);
        } else if (event === "messages.update") {
          sock.ev.on("messages.update", handler as (data: WAMessageUpdate[]) => void);
        } else if (event === "lid-mapping.update") {
          sock.ev.on("lid-mapping.update", handler as (data: LidPnMapping) => void);
        } else if (event === "messaging-history.set") {
          sock.ev.on("messaging-history.set", handler as (data: HistorySetLike) => void);
        } else {
          sock.ev.on(event, handler as (data: ContactLike[]) => void);
        }
        attachedCounts[event] = (attachedCounts[event] ?? 0) + 1;
      } catch {
        // socket not ready yet — connect() will attach on creation
      }
    }) as BaileysEventSink["onEvent"],
    close: async () => {
      closed = true;
      try {
        sock.end(undefined as unknown as Error);
      } catch {
        // ignore
      }
      try {
        (sock as unknown as { ws?: { close?: () => void } }).ws?.close?.();
      } catch {
        // ignore
      }
    },
  };
}
