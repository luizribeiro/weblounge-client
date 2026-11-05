import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  markConversationRead,
  notificationDataIsRead,
  notificationStateTotal,
  recordPresentedNotification,
} from "./push-notification-state";
import {
  readNotificationState,
  updateNotificationState,
} from "./push-notification-store";

const tag = "Lounge/#lounge";
const time = "2026-11-03T12:34:56.789Z";

describe("push notification state storage", () => {
  it("counts concurrent same-time pushes by distinct msgid", async () => {
    const factory = new IDBFactory();

    await Promise.all([
      record(factory, "push-read-one", time),
      record(factory, "push-read-two", time),
    ]);

    const state = await readNotificationState(factory);
    expect(notificationStateTotal(state)).toBe(2);
    expect(state.conversations.get(tag)?.messages).toEqual(
      new Map([
        ["push-read-one", Date.parse(time)],
        ["push-read-two", Date.parse(time)],
      ]),
    );
  });

  it("does not count a redelivered msgid twice", async () => {
    const factory = new IDBFactory();

    await record(factory, "duplicate", time);
    await record(factory, "duplicate", time);

    await expect(total(factory)).resolves.toBe(1);
  });

  it("applies MARKREAD after earlier messages and not to a later receipt", async () => {
    const factory = new IDBFactory();
    const marker = Date.parse(time);
    await record(factory, "before-read", time);
    await updateNotificationState(
      (state) => markConversationRead(state, tag, marker),
      factory,
    );

    let state = await readNotificationState(factory);
    expect(notificationStateTotal(state)).toBe(0);
    expect(
      notificationDataIsRead(
        { conversationTag: tag, messageTime: time },
        state.readAtMs,
      ),
    ).toBe(true);

    await record(factory, "after-read", time);
    state = await readNotificationState(factory);
    expect(notificationStateTotal(state)).toBe(1);
    expect(state.readAtMs.has(tag)).toBe(false);
  });
});

async function record(
  factory: IDBFactory,
  messageId: string,
  messageTime: string,
): Promise<number> {
  return updateNotificationState(
    (state) =>
      recordPresentedNotification(state, { tag, messageId, messageTime }),
    factory,
  );
}

async function total(factory: IDBFactory): Promise<number> {
  return notificationStateTotal(await readNotificationState(factory));
}
