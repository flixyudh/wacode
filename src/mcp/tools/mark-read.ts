import type { WASocket } from "@whiskeysockets/baileys";
import { z } from "zod";
import type { Store } from "../../whatsapp/store.js";

export const MarkReadSchema = z.object({
  jid: z.string().min(1),
  /** Specific WhatsApp message ids. Omit to mark the whole chat read. */
  ids: z.array(z.string()).optional(),
});

export type MarkReadInput = z.infer<typeof MarkReadSchema>;

export async function markReadTool(
  sock: () => WASocket,
  store: Store,
  input: MarkReadInput,
): Promise<{ ok: true; marked: number }> {
  const parsed = MarkReadSchema.parse(input);
  const jid = parsed.jid.includes("@") ? parsed.jid : `${parsed.jid.replace(/\D/g, "")}@s.whatsapp.net`;
  const marked = store.markRead(jid, parsed.ids);

  // Best-effort read receipt on the wire (needs ids — fetch recent unread if omitted).
  try {
    const s = sock();
    const ids = parsed.ids ?? store.getMessages(jid, 30).filter((m) => m.is_read === 0).map((m) => m.wa_id);
    for (const id of ids.slice(0, 30)) {
      await s.readMessages([{ remoteJid: jid, id } as unknown as Parameters<WASocket["readMessages"]>[0][number]]);
    }
  } catch {
    // DB state is source of truth for tools; wire receipt is best-effort.
  }
  return { ok: true, marked };
}
