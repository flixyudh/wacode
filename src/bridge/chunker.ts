/** WhatsApp max text length per message. */
export const WHATSAPP_MAX_CHUNK = 4096;

/**
 * Split outgoing text into ≤maxChars chunks.
 * Tries to break on the last newline within the window so we don't
 * split mid-paragraph; falls back to a hard slice. Unicode-safe
 * (splits on code points, not UTF-16 units).
 */
export function chunkText(text: string, maxChars = WHATSAPP_MAX_CHUNK): string[] {
  if (!text) return [];
  const chars = Array.from(text);
  if (chars.length <= maxChars) return [text];

  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    let end = Math.min(i + maxChars, chars.length);
    if (end < chars.length) {
      // Prefer a newline boundary within the last 20% of the window.
      const window = chars.slice(i, end).join("");
      const lastNl = window.lastIndexOf("\n");
      if (lastNl > maxChars * 0.5) {
        end = i + Array.from(window.slice(0, lastNl + 1)).length;
      }
    }
    out.push(chars.slice(i, end).join(""));
    i = end;
  }
  return out;
}
