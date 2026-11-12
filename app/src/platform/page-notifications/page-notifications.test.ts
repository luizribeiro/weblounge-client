import { describe, expect, it } from "vitest";
import type {
  BufferProjection,
  MessageProjection,
} from "../../engine/protocol";
import type { PushDelivery } from "./page-notification-policy";
import {
  chatNotificationMessage,
  type PageNotificationContext,
  PageNotifications,
} from "./page-notifications";
import type {
  PageNotification,
  PageNotificationOptions,
} from "./page-notifier";

const directBuffer: BufferProjection = {
  id: 7,
  network_id: 1,
  kind: "direct",
  sync_state: "synced",
  title: "mel",
  draft_key: "9:weblounge:rfc1459:mel",
  topic: null,
  unread: 1,
  mentions: 1,
};

const peerMessage: MessageProjection = {
  id: 41,
  author: "mel",
  text: "are you around?",
  kind: "text",
  bot: false,
  authorship: "other",
  nick_color_index: 2,
  highlighted: false,
  delivery: "received",
  local_send_id: null,
  server_ids: ["msg-41"],
  server_time_ms: Date.parse("2026-11-12T15:00:00.000Z"),
  received_at_ms: Date.parse("2026-11-12T15:00:00.020Z"),
};

interface Shown {
  readonly title: string;
  readonly options: PageNotificationOptions;
}

function harness(
  overrides: Partial<{
    pushDelivery: PushDelivery;
    foreground: boolean;
    shown: ReadonlySet<number>;
    supported: boolean;
  }> = {},
) {
  const shown: Shown[] = [];
  const opened: string[] = [];
  const context: PageNotificationContext = {
    networkLabel: (networkId) => (networkId === 1 ? "weblounge" : undefined),
    pushDelivery: () => overrides.pushDelivery ?? "unavailable",
    pageForeground: () => overrides.foreground ?? false,
    shownBufferIds: () => overrides.shown ?? new Set([7]),
    openRoute: (route) => opened.push(route),
  };
  const notifications = new PageNotifications(context, {
    locks: undefined,
    notifications:
      overrides.supported === false
        ? undefined
        : {
            permission: () => "granted",
            create: (title, options): PageNotification => {
              shown.push({ title, options });
              return { onclick: null, close: () => undefined };
            },
          },
  });
  return { notifications, shown, opened };
}

describe("PageNotifications", () => {
  it("posts a direct message while the page is in the background", () => {
    const { notifications, shown } = harness();

    notifications.handle({ buffer: directBuffer, message: peerMessage });

    expect(shown).toEqual([
      {
        title: "mel",
        options: { body: "are you around?", tag: "weblounge/mel" },
      },
    ]);
  });

  it("stays quiet for the buffer on screen in the foreground", () => {
    const { notifications, shown } = harness({ foreground: true });

    notifications.handle({ buffer: directBuffer, message: peerMessage });

    expect(shown).toEqual([]);
  });

  it("leaves the alert to Web Push when this device receives push", () => {
    const { notifications, shown } = harness({ pushDelivery: "active" });

    notifications.handle({ buffer: directBuffer, message: peerMessage });

    expect(shown).toEqual([]);
  });

  it("does nothing where the Notification API is missing", () => {
    const { notifications, shown } = harness({ supported: false });

    notifications.handle({ buffer: directBuffer, message: peerMessage });

    expect(shown).toEqual([]);
  });

  it("ignores buffers of networks the page no longer knows", () => {
    const { notifications, shown } = harness();

    notifications.handle({
      buffer: { ...directBuffer, network_id: 9 },
      message: peerMessage,
    });

    expect(shown).toEqual([]);
  });
});

describe("chatNotificationMessage", () => {
  it("maps a channel action to the push formatter's input", () => {
    expect(
      chatNotificationMessage(
        "weblounge",
        { ...directBuffer, kind: "channel", title: "#lounge" },
        {
          ...peerMessage,
          kind: "action",
          text: "waves at luiz",
          server_ids: [],
          server_time_ms: null,
        },
      ),
    ).toEqual({
      networkLabel: "weblounge",
      buffer: "#lounge",
      direct: false,
      sender: "mel",
      action: true,
      text: "waves at luiz",
      msgid: "local:41",
      time: "2026-11-12T15:00:00.020Z",
    });
  });
});
