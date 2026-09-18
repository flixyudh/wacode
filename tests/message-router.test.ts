import { describe, expect, it } from "vitest";
import { messageTimestampMs, routeMessage } from "../src/whatsapp/message-router.js";

describe("routeMessage", () => {
  it("routes conversation", () => {
    expect(routeMessage({ message: { conversation: "hi" } })).toEqual({ kind: "text", text: "hi" });
  });

  it("routes extendedTextMessage", () => {
    expect(
      routeMessage({ message: { extendedTextMessage: { text: "hello there" } } }),
    ).toEqual({ kind: "text", text: "hello there" });
  });

  it("routes media captions, logs media", () => {
    const r = routeMessage({
      message: { imageMessage: { caption: "look", fileLength: 1234 } },
    });
    expect(r).toEqual({ kind: "media-caption", text: "look", mediaType: "image", sizeBytes: 1234 });
  });

  it("ignores media without caption", () => {
    expect(routeMessage({ message: { imageMessage: {} } }).kind).toBe("ignore");
  });

  it("ignores reactions and protocol messages", () => {
    expect(routeMessage({ message: { reactionMessage: { text: "👍" } } })).toEqual({
      kind: "ignore",
      reason: "reactionMessage",
    });
    expect(routeMessage({ message: { protocolMessage: {} } }).kind).toBe("ignore");
  });

  it("unwraps ephemeral messages", () => {
    expect(
      routeMessage({ message: { ephemeralMessage: { message: { conversation: "secret" } } } }),
    ).toEqual({ kind: "text", text: "secret" });
  });

  it("ignores empty / unsupported", () => {
    expect(routeMessage({}).kind).toBe("ignore");
    expect(routeMessage({ message: { stickerMessage: {} } })).toEqual({
      kind: "ignore",
      reason: "stickerMessage",
    });
  });
});

describe("messageTimestampMs", () => {
  it("converts seconds to ms", () => {
    expect(messageTimestampMs({ messageTimestamp: 1_700_000_000 })).toBe(1_700_000_000_000);
  });
});
