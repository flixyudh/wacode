/**
 * Message-type router (DESIGN §5).
 *
 * Baileys reality: `messages.upsert` delivers `WAMessage` objects whose
 * payload lives under `message.*`. We route:
 *  - conversation / extendedTextMessage → text path
 *  - imageMessage / videoMessage / documentMessage with caption → caption as text
 *    (media itself is logged, not processed, in v2)
 *  - reactionMessage, protocolMessage, everything else → ignored
 *
 * Pure function — no Baileys import so unit tests stay light.
 */

export interface MinimalWaMessage {
  key?: { id?: string; remoteJid?: string; fromMe?: boolean; participant?: string };
  message?: Record<string, unknown> | null;
  messageTimestamp?: unknown;
  pushName?: string;
}

export type RouteResult =
  | { kind: "text"; text: string }
  | { kind: "media-caption"; text: string; mediaType: "image" | "video" | "document"; sizeBytes?: number }
  | { kind: "ignore"; reason: string };

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function extractMessageId(msg: MinimalWaMessage): string | undefined {
  return msg.key?.id;
}

export function extractChatJid(msg: MinimalWaMessage): string | undefined {
  return msg.key?.remoteJid;
}

export function routeMessage(msg: MinimalWaMessage): RouteResult {
  const inner = asRecord(msg.message);
  if (!inner) return { kind: "ignore", reason: "empty-message" };

  // Protocol / system messages first — never forward.
  if (inner["protocolMessage"]) return { kind: "ignore", reason: "protocolMessage" };
  if (inner["reactionMessage"]) return { kind: "ignore", reason: "reactionMessage" };
  if (inner["pollCreationMessage"] || inner["pollUpdateMessage"]) {
    return { kind: "ignore", reason: "poll" };
  }
  if (inner["stickerMessage"]) return { kind: "ignore", reason: "stickerMessage" };
  if (inner["audioMessage"]) {
    const ptt = asRecord(inner["audioMessage"])?.["ptt"];
    return { kind: "ignore", reason: ptt ? "voice-note-not-transcribed" : "audioMessage" };
  }
  if (inner["contactMessage"] || inner["contactsArrayMessage"] || inner["locationMessage"] || inner["liveLocationMessage"]) {
    return { kind: "ignore", reason: "structured-message" };
  }
  // Ephemeral wrapper: unwrap one level.
  const ephemeral = asRecord(inner["ephemeralMessage"])?.["message"];
  if (ephemeral) {
    return routeMessage({ ...msg, message: asRecord(ephemeral) });
  }
  const viewOnce = asRecord(inner["viewOnceMessageV2"])?.["message"] ?? asRecord(inner["viewOnceMessage"])?.["message"];
  if (viewOnce) {
    return { kind: "ignore", reason: "view-once" };
  }

  const conversation = str(inner["conversation"]);
  if (conversation) return { kind: "text", text: conversation };

  const extended = asRecord(inner["extendedTextMessage"]);
  const extText = extended ? str(extended["text"]) : undefined;
  if (extText) return { kind: "text", text: extText };

  for (const [key, mediaType] of [
    ["imageMessage", "image"],
    ["videoMessage", "video"],
    ["documentMessage", "document"],
  ] as const) {
    const media = asRecord(inner[key]);
    if (media) {
      const caption = str(media["caption"]);
      if (caption) {
        const sizeBytes =
          typeof media["fileLength"] === "number"
            ? (media["fileLength"] as number)
            : typeof media["fileLength"] === "bigint"
              ? Number(media["fileLength"])
              : undefined;
        return { kind: "media-caption", text: caption, mediaType, sizeBytes };
      }
      return { kind: "ignore", reason: `${key}-without-caption` };
    }
  }

  return { kind: "ignore", reason: "unsupported-type" };
}

/** Message timestamp in ms (Baileys gives seconds, sometimes Long-like). */
export function messageTimestampMs(msg: MinimalWaMessage): number {
  const t = msg.messageTimestamp as unknown;
  if (typeof t === "number") return t * 1000;
  if (typeof t === "bigint") return Number(t) * 1000;
  if (t && typeof t === "object" && "low" in (t as Record<string, unknown>)) {
    const low = (t as Record<string, unknown>)["low"];
    if (typeof low === "number") return low * 1000;
  }
  return Date.now();
}
