/**
 * WhatsApp JID / phone-number helpers + whitelist matcher.
 *
 * JIDs look like `6281234567890@s.whatsapp.net` (1:1),
 * `12345-67890@g.us` (group), or `...@lid`.
 * We normalise the user part to digits-only for comparison so
 * `+62 812-...`, `62812...`, and full JIDs all match.
 */

export function normalizeDigits(input: string): string {
  return (input ?? "").replace(/\D/g, "");
}

/** Extract the user part of a JID (`user@server`) or return digits of a bare number. */
export function jidToDigits(jid: string): string {
  const at = jid.indexOf("@");
  const user = at >= 0 ? jid.slice(0, at) : jid;
  return normalizeDigits(user);
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}

export function isLidJid(jid: string): boolean {
  return jid.endsWith("@lid");
}

export function isPnJid(jid: string): boolean {
  return jid.endsWith("@s.whatsapp.net");
}

/**
 * Pick the stable identity from candidate JIDs: prefer a phone-number JID
 * (@s.whatsapp.net) over an opaque LID (@lid), else the first candidate.
 * WhatsApp increasingly addresses DMs by LID, with the PN in `remoteJidAlt`
 * or resolvable via the signal LID-mapping store.
 */
export function pickIdentityJid(candidates: Array<string | undefined | null>): string {
  const list = candidates.filter((c): c is string => !!c);
  return list.find(isPnJid) ?? list[0] ?? "";
}

export class Whitelist {
  private allowed: Set<string>;

  constructor(entries: string[]) {
    this.allowed = new Set(entries.map(normalizeDigits).filter(Boolean));
  }

  isAllowed(jidOrNumber: string): boolean {
    const digits = jidOrNumber.includes("@") ? jidToDigits(jidOrNumber) : normalizeDigits(jidOrNumber);
    if (!digits) return false;
    if (this.allowed.has(digits)) return true;
    // Allow suffix match for numbers with/without country-code truncation differences?
    // No — exact match only. Whitelist must be explicit (security).
    return false;
  }

  get size(): number {
    return this.allowed.size;
  }

  list(): string[] {
    return [...this.allowed];
  }
}

/** Optional shared-secret gate (off when secret is empty). */
export function passesSharedSecret(text: string | null | undefined, secret: string): boolean {
  if (!secret) return true;
  if (!text) return false;
  return text.includes(secret);
}
