import type { Logger } from "pino";
import { normalizeDigits } from "./whitelist.js";
import type { Store } from "../whatsapp/store.js";

/**
 * LID → phone-number mapping (Baileys v6 has no built-in LID API).
 *
 * Sources, in precedence order:
 *  1. Static env map `WHATSAPP_LID_MAP=lid:pn,lid:pn` (explicit override).
 *  2. SQLite `lid_map` cache (learned entries persist across restarts).
 *  3. Passive learning (wired in listener.ts):
 *     - `chats.phoneNumberShare` ({ lid, jid }) — WhatsApp proactively
 *       shares PN↔LID pairs.
 *     - `contacts.upsert` / `contacts.update` (Contact{id, lid?}).
 *
 * All keys/values are digit-only strings (`lidToDigits` / `pnToDigits`).
 */
export class LidResolver {
  constructor(
    private store: Store,
    private staticMap: Map<string, string>,
    private logger?: Logger,
  ) {}

  /** Resolve a `@lid` JID (or bare LID digits) to a PN JID, or null. */
  toPnJid(lidJidOrDigits: string): string | null {
    const lid = normalizeDigits(lidJidOrDigits);
    if (!lid) return null;
    const fromStatic = this.staticMap.get(lid);
    if (fromStatic) return `${fromStatic}@s.whatsapp.net`;
    try {
      const cached = this.store.getPnForLid(lid);
      if (cached) return `${cached}@s.whatsapp.net`;
    } catch (e) {
      this.logger?.debug({ err: (e as Error).message, lid }, "lid cache read failed");
    }
    return null;
  }

  /** Persist a learned pair (either order accepted, roles detected). */
  learn(a: string | undefined | null, b: string | undefined | null): boolean {
    const pair = classifyPair(a, b);
    if (!pair) return false;
    const [lid, pn] = pair;
    if (this.staticMap.get(lid) === pn) return false; // static already covers it
    try {
      const changed = this.store.setLidMap(lid, pn);
      if (changed) this.logger?.info({ lid, pn }, "learned LID→PN mapping");
      return changed;
    } catch (e) {
      this.logger?.debug({ err: (e as Error).message, lid, pn }, "lid cache write failed");
      return false;
    }
  }

  /** Learn from a Baileys contact ({ id, lid?, phoneNumber? }). */
  learnFromContact(c: { id?: string; lid?: string; phoneNumber?: string }): boolean {
    if (!c) return false;
    return (
      this.learn(c.lid, c.id) ||
      this.learn(c.lid, c.phoneNumber) ||
      this.learn(c.phoneNumber, c.id)
    );
  }

  /** Learn a raw { lid, pn } pair (v7 `lid-mapping.update`, history sync). */
  learnMapping(m: { lid?: string; pn?: string }): boolean {
    if (!m) return false;
    return this.learn(m.lid, m.pn);
  }

  get staticSize(): number {
    return this.staticMap.size;
  }
}

/** Detect (lidDigits, pnDigits) from two JIDs/digit-strings in any order. */
export function classifyPair(
  a: string | undefined | null,
  b: string | undefined | null,
): [lid: string, pn: string] | null {
  if (!a || !b) return null;
  const aIsLid = a.endsWith("@lid");
  const bIsLid = b.endsWith("@lid");
  const aIsPn = a.endsWith("@s.whatsapp.net");
  const bIsPn = b.endsWith("@s.whatsapp.net");
  let lid = "";
  let pn = "";
  if (aIsLid && bIsPn) {
    lid = normalizeDigits(a);
    pn = normalizeDigits(b);
  } else if (bIsLid && aIsPn) {
    lid = normalizeDigits(b);
    pn = normalizeDigits(a);
  } else {
    return null;
  }
  if (!lid || !pn || lid === pn) return null;
  return [lid, pn];
}

/**
 * Parse `WHATSAPP_LID_MAP` (`lid:pn,lid:pn` — full JIDs or bare digits).
 * Throws with an actionable message on malformed entries (fail fast).
 */
export function parseStaticMap(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return map;
  for (const entry of trimmed.split(",")) {
    const part = entry.trim();
    if (!part) continue;
    const [lidRaw, pnRaw] = part.split(":").map((s) => s.trim());
    if (!lidRaw || !pnRaw || part.split(":").length !== 2) {
      throw new Error(
        `Invalid WHATSAPP_LID_MAP entry "${part}" — expected lid:pn, e.g. 122608481730748:6282110928426`,
      );
    }
    const lid = normalizeDigits(lidRaw);
    const pn = normalizeDigits(pnRaw);
    if (!lid || !pn) {
      throw new Error(`Invalid WHATSAPP_LID_MAP entry "${part}" — both sides must contain digits`);
    }
    map.set(lid, pn);
  }
  return map;
}

/**
 * Seed Baileys v7's signal LID store with static mappings so Baileys
 * itself resolves them everywhere (receipts, groups, quoting).
 * Best-effort and version-tolerant: no-op on v6 (no such store).
 */
export async function seedSignalStore(
  sock: unknown,
  staticMap: Map<string, string>,
  logger?: Logger,
): Promise<void> {
  if (staticMap.size === 0) return;
  try {
    const store = (
      sock as {
        signalRepository?: {
          lidMapping?: {
            storeLIDPNMappings?: (pairs: Array<{ lid: string; pn: string }>) => Promise<void>;
          };
        };
      }
    ).signalRepository?.lidMapping;
    if (!store?.storeLIDPNMappings) return;
    await store.storeLIDPNMappings(
      [...staticMap].map(([lid, pn]) => ({ lid: `${lid}@lid`, pn: `${pn}@s.whatsapp.net` })),
    );
    logger?.info({ count: staticMap.size }, "seeded Baileys LID store with static mappings");
  } catch (e) {
    logger?.debug({ err: (e as Error).message }, "seeding Baileys LID store failed (non-fatal)");
  }
}
