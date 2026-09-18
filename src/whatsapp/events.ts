import { EventEmitter } from "node:events";

export interface InboundMessageEvent {
  correlationId: string;
  chatJid: string;
  senderJid: string;
  waId: string;
  pushName?: string;
  timestampMs: number;
  /** Raw Baileys WAMessage — kept opaque here so events.ts has no Baileys dep. */
  raw: unknown;
}

export class BridgeEvents extends EventEmitter {
  emitInbound(e: InboundMessageEvent): boolean {
    return this.emit("inbound", e);
  }

  onInbound(listener: (e: InboundMessageEvent) => void): this {
    return this.on("inbound", listener);
  }
}
