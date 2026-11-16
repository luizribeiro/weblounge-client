import { describe, expect, it } from "vitest";
import type { BufferProjection } from "../../engine/protocol";
import { closeMessageNotifications, syncAppPushState } from "../push/app-badge";
import type { DeliveredNotification } from "./generated/DeliveredNotification";
import type { NativeBridge } from "./native-bridge";
import {
  hostNotificationCenter,
  nativeNotificationCenter,
} from "./native-notification-center";

function recordingBridge(
  delivered: readonly DeliveredNotification[],
  failing?: string,
) {
  const calls: [string, unknown][] = [];
  const bridge = {
    call: async (command: string, request?: unknown) => {
      calls.push([command, request]);
      if (command === failing)
        throw { kind: "notification_center", message: "unavailable" };
      return command === "delivered_notifications" ? delivered : null;
    },
  } as NativeBridge;
  return { bridge, calls };
}

function chat(identifier: string, tag: string, time: string) {
  return {
    identifier,
    data: {
      route: "/Lounge/@mel",
      conversationTag: tag,
      messageId: identifier,
      messageTime: time,
    },
  };
}

const mel: BufferProjection = {
  id: 7,
  network_id: 1,
  kind: "direct",
  title: "mel",
  draft_key: "draft",
  topic: null,
  sync_state: "synced",
  unread: 0,
  mentions: 0,
  read_at_ms: Date.parse("2026-11-16T10:00:00.000Z"),
};

describe("native notification center", () => {
  it("is the host's center only inside the iPhone app", async () => {
    const { bridge, calls } = recordingBridge([]);

    expect(hostNotificationCenter(undefined).badge).toBe(navigator);
    await hostNotificationCenter(bridge).badge.clearAppBadge?.();
    expect(calls).toEqual([["set_badge", { count: 0 }]]);
  });

  it("writes the counts, sets the badge and withdraws read notifications", async () => {
    const { bridge, calls } = recordingBridge([
      chat("read-msgid", "Lounge/mel", "2026-11-16T09:59:00.000Z"),
      chat("newer-msgid", "Lounge/mel", "2026-11-16T10:01:00.000Z"),
      { identifier: "placeholder", data: null },
    ]);

    await syncAppPushState(
      [{ ...mel, unread: 1, mentions: 1 }],
      new Map([[1, "Lounge"]]),
      nativeNotificationCenter(bridge),
    );

    expect(calls).toEqual([
      [
        "write_notification_counts",
        {
          counts: [
            {
              tag: "Lounge/mel",
              count: 1,
              readAtMs: Date.parse("2026-11-16T10:00:00.000Z"),
            },
          ],
        },
      ],
      ["delivered_notifications", undefined],
      ["set_badge", { count: 1 }],
      ["remove_delivered_notifications", { identifiers: ["read-msgid"] }],
    ]);
  });

  it("keeps syncing when the shell can't withdraw a notification", async () => {
    const { bridge, calls } = recordingBridge(
      [chat("read-msgid", "Lounge/mel", "2026-11-16T09:59:00.000Z")],
      "remove_delivered_notifications",
    );

    await expect(
      syncAppPushState(
        [mel],
        new Map([[1, "Lounge"]]),
        nativeNotificationCenter(bridge),
      ),
    ).resolves.toBeUndefined();
    expect(calls).toContainEqual([
      "remove_delivered_notifications",
      { identifiers: ["read-msgid"] },
    ]);
  });

  it("clears the badge by setting it to zero", async () => {
    const { bridge, calls } = recordingBridge([]);

    await syncAppPushState(
      [mel],
      new Map([[1, "Lounge"]]),
      nativeNotificationCenter(bridge),
    );

    expect(calls).toContainEqual(["set_badge", { count: 0 }]);
  });

  it("withdraws the notification of a deleted message", async () => {
    const { bridge, calls } = recordingBridge([
      chat("gone", "Lounge/mel", "2026-11-16T10:01:00.000Z"),
      chat("kept", "Lounge/mel", "2026-11-16T10:02:00.000Z"),
    ]);

    await closeMessageNotifications(
      ["gone"],
      nativeNotificationCenter(bridge).registrations,
    );

    expect(calls).toEqual([
      ["delivered_notifications", undefined],
      ["remove_delivered_notifications", { identifiers: ["gone"] }],
    ]);
  });
});
