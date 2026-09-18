import { z } from "zod";
import type { Store } from "../../whatsapp/store.js";

export const GetMessagesSchema = z.object({
  /** Full JID or bare number. Omit to list recent across all chats. */
  jid: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

export type GetMessagesInput = z.infer<typeof GetMessagesSchema>;

export function getMessagesTool(store: Store, input: GetMessagesInput) {
  const parsed = GetMessagesSchema.parse(input);
  const messages = parsed.jid
    ? store.getMessages(normalizeJid(parsed.jid), parsed.limit)
    : store.getRecentMessages(parsed.limit);
  return {
    count: messages.length,
    messages: messages.map((m) => ({
      id: m.wa_id,
      chat: m.chat_jid,
      sender: m.sender_jid,
      direction: m.direction,
      type: m.msg_type,
      body: m.body,
      timestamp: new Date(m.timestamp_ms).toISOString(),
      read: m.is_read === 1,
    })),
  };
}

function normalizeJid(jid: string): string {
  if (jid.includes("@")) return jid;
  return `${jid.replace(/\D/g, "")}@s.whatsapp.net`;
}
