import { describe, expect, it } from "vitest";
import type { PushedMessage } from "./generated/PushedMessage";
import type { NativeBridge } from "./native-bridge";
import { nativePushedMessageDrain } from "./pushed-message-drain";

function pushed(msgid: string): PushedMessage {
  return {
    schema: 1,
    network_label: "Lounge",
    nickname: "me",
    route: "/Lounge/@mel",
    sender: "mel",
    account: "mel",
    target: "me",
    msgid,
    time: "2026-11-16T10:00:00.000Z",
    text: `message ${msgid}`,
    kind: "message",
  };
}

function queueBridge(queue: () => Promise<readonly PushedMessage[]>) {
  let takes = 0;
  const bridge = {
    call: async () => {
      takes += 1;
      return queue();
    },
  } as NativeBridge;
  return { bridge, takes: () => takes };
}

describe("native pushed-message drain", () => {
  it("stores every queued message, even after one fails", async () => {
    const stored: string[] = [];
    const { bridge } = queueBridge(async () => [
      pushed("one"),
      pushed("two"),
      pushed("three"),
    ]);
    const drain = nativePushedMessageDrain(bridge, async (message) => {
      if (message.msgid === "two") throw new Error("database blocked");
      stored.push(message.msgid);
    });

    await drain();

    expect(stored).toEqual(["one", "three"]);
  });

  it("joins a drain already in flight instead of taking twice", async () => {
    let release = (_messages: readonly PushedMessage[]) => {};
    const { bridge, takes } = queueBridge(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const stored: string[] = [];
    const drain = nativePushedMessageDrain(bridge, async (message) => {
      stored.push(message.msgid);
    });

    const first = drain();
    const second = drain();
    release([pushed("one")]);
    await Promise.all([first, second]);
    expect(takes()).toBe(1);
    expect(stored).toEqual(["one"]);

    const third = drain();
    release([]);
    await third;
    expect(takes()).toBe(2);
  });

  it("settles when the shell can't read its queue, then drains again", async () => {
    let unavailable = true;
    const stored: string[] = [];
    const { bridge } = queueBridge(async () => {
      if (unavailable)
        throw { kind: "app_group", message: "container unavailable" };
      return [pushed("later")];
    });
    const drain = nativePushedMessageDrain(bridge, async (message) => {
      stored.push(message.msgid);
    });

    await expect(drain()).resolves.toBeUndefined();
    unavailable = false;
    await drain();
    expect(stored).toEqual(["later"]);
  });
});
