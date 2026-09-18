import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import type { Logger } from "pino";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { BaileysEventSink } from "../whatsapp/connection.js";
import { LruDedupe } from "../whatsapp/dedupe.js";
import {
  extractChatJid,
  extractMessageId,
  messageTimestampMs,
  routeMessage,
  type MinimalWaMessage,
} from "../whatsapp/message-router.js";
import { Store } from "../whatsapp/store.js";
import { chunkText } from "./chunker.js";
import { LidResolver } from "./lid-resolver.js";
import { OpencodeClient } from "./opencode-client.js";
import { RateLimiter } from "./rate-limiter.js";
import { SessionManager, isResetCommand } from "./session-manager.js";
import { Whitelist, isGroupJid, isLidJid, passesSharedSecret, pickIdentityJid } from "./whitelist.js";

export interface ListenerDeps {
  cfg: AppConfig;
  logger: Logger;
  sock: WASocket;
  onEvent: BaileysEventSink["onEvent"];
  lidResolver: LidResolver;
  store: Store;
  whitelist: Whitelist;
  sessions: SessionManager;
  limiter: RateLimiter;
  opencode: OpencodeClient;
  dedupeHot: LruDedupe;
  onInbound?: (atMs: number) => void;
}

function shouldAutoRead(cfg: AppConfig, allowed: boolean): boolean {
  if (cfg.AUTO_READ_SCOPE === "all") return true;
  return allowed;
}

async function tryMarkRead(sock: WASocket, logger: Logger, chatJid: string, waId: string): Promise<void> {
  try {
    await sock.readMessages([{ remoteJid: chatJid, id: waId } as unknown as Parameters<WASocket["readMessages"]>[0][number]]);
  } catch (e) {
    logger.debug({ err: (e as Error).message, chatJid, waId }, "readMessages failed (non-fatal)");
  }
}

/**
 * Collect every usable identity for an inbound message. WhatsApp
 * increasingly addresses 1:1 DMs by opaque LID (`xxx@lid`); the phone
 * number may sit in `remoteJidAlt`/participant alts or be known to the
 * local LidResolver (static map + learned cache).
 */
async function resolveCandidates(
  sock: WASocket,
  log: Logger,
  raw: WAMessage,
  lidResolver: LidResolver,
): Promise<string[]> {
  const key = raw.key as
    | { remoteJid?: string; remoteJidAlt?: string; participant?: string; participantAlt?: string }
    | undefined;
  const out: string[] = [];
  for (const jid of [key?.remoteJid, key?.remoteJidAlt, key?.participant, key?.participantAlt]) {
    if (jid && !out.includes(jid)) out.push(jid);
  }
  for (const jid of [...out]) {
    if (!isLidJid(jid)) continue;
    // Our own map first (static + learned cache).
    const known = lidResolver.toPnJid(jid);
    if (known && !out.includes(known)) {
      out.push(known);
      log.debug({ lid: jid, pn: known }, "resolved LID via local map");
      continue;
    }
    // Then Baileys v7's signal store (tolerant: absent on v6).
    try {
      const repo = (
        sock as unknown as {
          signalRepository?: {
            lidMapping?: { getPNForLID?: (lid: string) => Promise<string | null> };
          };
        }
      ).signalRepository?.lidMapping;
      const pn = await repo?.getPNForLID?.(jid);
      if (pn && !out.includes(pn)) {
        out.push(pn);
        lidResolver.learn(jid, pn);
        log.debug({ lid: jid, pn }, "resolved LID via Baileys signal store");
      }
    } catch (e) {
      log.debug({ err: (e as Error).message, lid: jid }, "signal-store LID lookup failed (non-fatal)");
    }
  }
  return out;
}

/**
 * Attach the `messages.upsert` orchestration pipeline:
 * dedupe → route → /reset → whitelist → shared-secret → rate-limit → auto-read → forward.
 */
export function attachListener(deps: ListenerDeps): void {
  const { cfg, logger, sock, onEvent, store, whitelist, sessions, limiter, opencode, dedupeHot, onInbound, lidResolver } = deps;

  // Receipt/status traffic — proves server→device flow works even when no
  // chat messages arrive (key "is WhatsApp delivering to us at all" signal).
  onEvent("messages.update", (updates) => {
    logger.trace({ count: updates.length }, "messages.update received");
  });

  // Passive LID→PN learning (v6 has no built-in LID API; v7 also emits these).
  onEvent("lid-mapping.update", (m) => {
    lidResolver.learnMapping(m);
  });
  onEvent("messaging-history.set", (h) => {
    let n = 0;
    for (const m of h.lidPnMappings ?? []) {
      if (lidResolver.learnMapping(m)) n++;
    }
    for (const c of h.contacts ?? []) {
      if (lidResolver.learnFromContact(c)) n++;
    }
    if (n > 0) logger.debug({ learned: n }, "harvested LID mappings from history sync");
  });
  const learnContacts = (contacts: Array<{ id?: string; lid?: string; phoneNumber?: string }>): void => {
    for (const c of contacts) lidResolver.learnFromContact(c);
  };
  onEvent("contacts.upsert", learnContacts);
  onEvent("contacts.update", learnContacts);

  onEvent("messages.upsert", (async ({ messages, type }) => {
    // First line of defense for "no response" reports: log EVERY batch,
    // even empty ones, before any filtering.
    logger.trace({ type, count: messages.length }, "messages.upsert received");
    // History sync on (re)connect is explicitly ignored, never replayed.
    if (type !== "notify") {
      logger.debug({ type, count: messages.length }, "ignoring non-notify upsert (history sync)");
      return;
    }

    for (const raw of messages as WAMessage[]) {
      const correlationId = randomUUID();
      const log = logger.child({ correlationId });
      const msg = raw as unknown as MinimalWaMessage;

      try {
        // 1. fromMe filter — skip echoes of our own sent messages.
        // (Trace-logged: sending the test message from the paired phone
        // itself is the classic "no response" false alarm.)
        if (raw.key?.fromMe) {
          log.trace({ remoteJid: raw.key?.remoteJid }, "skipping fromMe echo");
          continue;
        }

        const waId = extractMessageId(msg);
        const chatJid = extractChatJid(msg);
        if (!waId || !chatJid) {
          log.debug("message without id/jid, skipping");
          continue;
        }

        // 2. Dedupe — persisted + hot LRU. Mark immediately before processing.
        if (dedupeHot.has(waId) || store.hasSeen(waId)) {
          log.debug({ waId }, "duplicate delivery, skipping");
          continue;
        }
        dedupeHot.add(waId);
        store.markSeen(waId);

        const senderJid = raw.key?.participant ?? chatJid;
        const timestampMs = messageTimestampMs(msg);
        const pushName = (raw as { pushName?: string }).pushName;
        onInbound?.(Date.now());
        if (pushName) store.touchContact(senderJid, pushName);

        // Identity resolution (LID migration): 1:1 DMs increasingly arrive
        // addressed by opaque LID (`xxx@lid`) instead of the phone number.
        // Collect every candidate (remoteJidAlt / participant alts / resolved
        // PN) — whitelist passes if ANY matches, sessions key on the PN.
        const candidates = await resolveCandidates(sock, log, raw, lidResolver);
        const identityJid = pickIdentityJid(candidates);
        const allowed = candidates.some((c) => whitelist.isAllowed(c));
        log.debug({ chatJid, identityJid, candidates, allowed }, "sender identity resolved");

        // Group chats are out of scope for v2 (1:1 only): store, don't forward.
        if (isGroupJid(chatJid)) {
          log.info({ chatJid, waId }, "group message stored, not forwarded (1:1 only in v2)");
          store.saveMessage({
            wa_id: waId,
            chat_jid: chatJid,
            sender_jid: senderJid,
            direction: "inbound",
            body: null,
            msg_type: "group-ignored",
            timestamp_ms: timestampMs,
          });
          continue;
        }

        // 4. Type router.
        const routed = routeMessage(msg);
        if (routed.kind === "ignore") {
          log.info({ waId, reason: routed.reason }, "message type ignored");
          store.saveMessage({
            wa_id: waId,
            chat_jid: chatJid,
            sender_jid: senderJid,
            direction: "inbound",
            body: null,
            msg_type: routed.reason,
            timestamp_ms: timestampMs,
          });
          continue;
        }

        const text = routed.text;
        if (routed.kind === "media-caption") {
          log.info(
            { waId, mediaType: routed.mediaType, sizeBytes: routed.sizeBytes },
            "media caption forwarded as text; media not processed in v2",
          );
        }

        // Explicit reset: handled before the whitelist-forward path.
        if (isResetCommand(text)) {
          if (!allowed) {
            log.info({ chatJid, identityJid }, "/reset from non-whitelisted sender ignored");
            store.saveMessage({
              wa_id: waId,
              chat_jid: identityJid,
              sender_jid: identityJid,
              direction: "inbound",
              body: text,
              msg_type: "text",
              timestamp_ms: timestampMs,
            });
            continue;
          }
          sessions.reset(identityJid);
          limiter.reset(identityJid);
          log.info({ identityJid }, "session reset via /reset");
          store.saveMessage({
            wa_id: waId,
            chat_jid: identityJid,
            sender_jid: identityJid,
            direction: "inbound",
            body: text,
            msg_type: "text",
            timestamp_ms: timestampMs,
            is_read: 1,
          });
          await tryMarkRead(sock, log, chatJid, waId);
          const reply = "Session reset ✅ — starting fresh on your next message.";
          for (const chunk of chunkText(reply)) {
            await sock.sendMessage(chatJid, { text: chunk });
          }
          continue;
        }

        // Persist inbound text before any forwarding decision.
        // Stored under the resolved identity (PN when known) so history is
        // stable across LID/PN representations; wire ops still use raw chatJid.
        store.saveMessage({
          wa_id: waId,
          chat_jid: identityJid,
          sender_jid: identityJid,
          direction: "inbound",
          body: text,
          msg_type: routed.kind === "media-caption" ? `media-caption:${routed.mediaType}` : "text",
          timestamp_ms: timestampMs,
        });

        if (!allowed) {
          log.info({ chatJid, identityJid, candidates }, "non-whitelisted sender: stored, left unread");
          if (shouldAutoRead(cfg, false)) await tryMarkRead(sock, log, chatJid, waId);
          continue;
        }

        if (!passesSharedSecret(text, cfg.WHATSAPP_SHARED_SECRET)) {
          log.info({ identityJid }, "whitelisted sender missing shared-secret keyword: stored, not forwarded");
          continue;
        }

        if (!limiter.allow(identityJid)) {
          const retryMs = limiter.retryAfterMs(identityJid);
          log.warn({ identityJid, retryMs }, "rate limited, not forwarding to opencode");
          continue;
        }

        // Auto-read whitelisted senders by default.
        if (shouldAutoRead(cfg, true)) await tryMarkRead(sock, log, chatJid, waId);

        // Ensure opencode session (TTL / restart persistence handled in SessionManager).
        let session = sessions.get(identityJid);
        if (!session) {
          const title = `whatsapp:${identityJid}`;
          const opencodeSessionId = await opencode.createSession(title);
          session = sessions.create(identityJid, opencodeSessionId);
          log.info({ identityJid, opencodeSessionId }, "new opencode session");
        }

        // Typing presence while awaiting opencode.
        try {
          await sock.sendPresenceUpdate("composing", chatJid);
        } catch {
          // non-fatal
        }

        let reply: string;
        try {
          reply = await opencode.sendMessage(session.opencodeSessionId, text);
        } catch (e) {
          log.error({ err: (e as Error).message, chatJid }, "opencode call failed");
          try {
            await sock.sendPresenceUpdate("paused", chatJid);
          } catch {
            // ignore
          }
          const fallback = "⚠️ Bridge error talking to the agent — try again in a bit.";
          for (const chunk of chunkText(fallback)) {
            await sock.sendMessage(chatJid, { text: chunk });
          }
          continue;
        }

        try {
          await sock.sendPresenceUpdate("paused", chatJid);
        } catch {
          // ignore
        }

        const chunks = chunkText(reply || "(empty response)");
        log.info({ identityJid, chunks: chunks.length, sessionId: session.opencodeSessionId }, "replying to sender");
        for (const chunk of chunks) {
          const sent = await sock.sendMessage(chatJid, { text: chunk });
          const sentId =
            (sent as unknown as { key?: { id?: string } })?.key?.id ?? `${waId}:out:${randomUUID()}`;
          store.saveMessage({
            wa_id: sentId,
            chat_jid: identityJid,
            sender_jid: "me",
            direction: "outbound",
            body: chunk,
            msg_type: "text",
            timestamp_ms: Date.now(),
            is_read: 1,
          });
        }

        const touched = sessions.touch(identityJid, 1);

        // Compaction: summarize-and-restart after N messages.
        if (touched && sessions.needsCompaction(identityJid)) {
          log.info({ identityJid, count: touched.messageCount }, "compaction threshold reached, restarting session");
          try {
            await opencode.summarizeSession(touched.opencodeSessionId);
          } catch (e) {
            log.warn({ err: (e as Error).message }, "summarize failed, restarting fresh anyway");
          }
          try {
            await opencode.deleteSession(touched.opencodeSessionId);
          } catch {
            // ignore
          }
          sessions.reset(identityJid);
          log.info({ identityJid }, "session compacted (restarted); next message starts fresh");
        }
      } catch (e) {
        log.error({ err: (e as Error).message }, "listener failed on message");
      }
    }
  }));
}
