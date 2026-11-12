import { describe, expect, it } from "vitest";
import type { ChatNotificationMessage } from "../push/push-notification";
import {
  type PageNotification,
  type PageNotificationOptions,
  PageNotifier,
} from "./page-notifier";

class RecordedNotification implements PageNotification {
  onclick: (() => void) | null = null;
  closed = false;

  constructor(
    readonly title: string,
    readonly options: PageNotificationOptions,
  ) {}

  close(): void {
    this.closed = true;
  }
}

function harness() {
  const shown: RecordedNotification[] = [];
  const opened: string[] = [];
  const notifier = new PageNotifier(
    (title, options) => {
      const notification = new RecordedNotification(title, options);
      shown.push(notification);
      return notification;
    },
    (route) => opened.push(route),
  );
  return { notifier, shown, opened };
}

const directMessage: ChatNotificationMessage = {
  networkLabel: "weblounge",
  buffer: "mel",
  direct: true,
  sender: "mel",
  action: false,
  text: "are you around?",
  msgid: "msg-101",
  time: "2026-11-12T15:00:00.000Z",
};

const channelMention: ChatNotificationMessage = {
  networkLabel: "weblounge",
  buffer: "#lounge",
  direct: false,
  sender: "ana",
  action: false,
  text: "luiz: can you review the deploy?",
  msgid: "msg-102",
  time: "2026-11-12T15:01:00.000Z",
};

describe("PageNotifier", () => {
  it("shows a direct message with the push path's title, body and tag", () => {
    const { notifier, shown } = harness();

    expect(notifier.post(directMessage, 1)).toBe(true);

    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe("mel");
    expect(shown[0]?.options).toEqual({
      body: "are you around?",
      tag: "weblounge/mel",
    });
  });

  it("posts each msgid once, even when the engine repeats it", () => {
    const { notifier, shown } = harness();

    notifier.post(channelMention, 1);
    expect(notifier.post(channelMention, 1)).toBe(false);

    expect(shown).toHaveLength(1);
  });

  it("keeps one notification per conversation with the unread count", () => {
    const { notifier, shown } = harness();

    notifier.post(channelMention, 1);
    notifier.post(
      {
        ...channelMention,
        msgid: "msg-103",
        text: "luiz: ping",
        time: "2026-11-12T15:02:00.000Z",
      },
      2,
    );
    notifier.post(directMessage, 1);

    expect(shown.map((notification) => notification.closed)).toEqual([
      true,
      false,
      false,
    ]);
    expect(shown[1]?.options.body).toBe("luiz: ping\n· 2 new messages");
  });

  it("opens the conversation and closes the notification on click", () => {
    const { notifier, shown, opened } = harness();
    notifier.post(channelMention, 1);

    shown[0]?.onclick?.();

    expect(opened).toEqual(["/weblounge/lounge"]);
    expect(shown[0]?.closed).toBe(true);
  });

  it("closes only notifications covered by their conversation's read marker", () => {
    const { notifier, shown } = harness();
    notifier.post(directMessage, 1);
    notifier.post(channelMention, 1);

    notifier.closeRead(
      new Map([
        ["weblounge/mel", Date.parse("2026-11-12T15:00:00.000Z")],
        ["weblounge/#lounge", Date.parse("2026-11-12T15:00:30.000Z")],
      ]),
    );

    expect(shown.map((notification) => notification.closed)).toEqual([
      true,
      false,
    ]);
  });

  it("skips posting when the platform refuses to construct notifications", () => {
    const notifier = new PageNotifier(
      () => {
        throw new TypeError("Illegal constructor");
      },
      () => undefined,
    );

    expect(notifier.post(directMessage, 1)).toBe(false);
  });
});
