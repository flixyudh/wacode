import type { WASocket } from "@whiskeysockets/baileys";
import { z } from "zod";
import { chunkText } from "../../bridge/chunker.js";
import { jidToDigits } from "../../bridge/whitelist.js";
import type { Store } from "../../whatsapp/store.js";

export const SendMessageSchema = z.object({
  /** Full JID (`628..@s.whatsapp.net`) or bare phone number (`628..`). */
  to: z.string().min(1),
  text: z.string().min(1).max(200_000),
});

export type SendMessageInput = z.infer<typeof SendMessageSchema>;

function normalizeTo(to: string): string {
  if (to.includes("@")) return to;
  return `${jidToDigits(to)}@s.whatsapp.net`;
}

export async function sendMessageTool(
  sock: () => WASocket,
  store: Store,
  input: SendMessageInput,
): Promise<{ ok: true; to: string; chunks: number; messageIds: string[] }> {
  const parsed = SendMessageSchema.parse(input);
  const to = normalizeTo(parsed.to);
  const chunks = chunkText(parsed.text);
  const ids: string[] = [];
  const s = sock();
  for (const chunk of chunks) {
    const sent = await s.sendMessage(to, { text: chunk });
    const id =
      (sent as unknown as { key?: { id?: string } })?.key?.id ?? `local:${Date.now()}:${ids.length}`;
    ids.push(id);
    store.saveMessage({
      wa_id: id,
      chat_jid: to,
      sender_jid: "me",
      direction: "outbound",
      body: chunk,
      msg_type: "text",
      timestamp_ms: Date.now(),
      is_read: 1,
    });
  }
  return { ok: true, to, chunks: chunks.length, messageIds: ids };
}
