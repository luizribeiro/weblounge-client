import { expect, it } from "vitest";
import { bufferSyncPresentation } from "./buffer-sync";
import type { BufferProjection, NetworkProjection } from "./protocol";

it("derives title progress from network and per-buffer sync state", () => {
  expect(presentation("online", "synced").progressing).toBe(false);
  expect(presentation("online", "pending").progressing).toBe(false);
  expect(presentation("online", "syncing").progressing).toBe(true);
  expect(presentation("connecting", "synced").progressing).toBe(true);
  expect(presentation("registering", "synced").progressing).toBe(true);
  expect(
    presentation(
      { reconnecting: { attempt: 1, next_retry_at_ms: 10 } },
      "synced",
    ).progressing,
  ).toBe(true);
});

it("lets actionable errors interrupt progress", () => {
  expect(
    presentation(
      {
        failed: {
          reason: "transport",
          message_key: "engine.connection_failed",
        },
      },
      "syncing",
    ),
  ).toEqual({ interrupted: true, progressing: false });
});

it("does not make one title wait for whole-list cache hydration", () => {
  expect(presentation("online", "pending").progressing).toBe(false);
});

function presentation(
  state: NetworkProjection["state"],
  syncState: BufferProjection["sync_state"],
) {
  return bufferSyncPresentation(
    {
      id: 2,
      network_id: 1,
      kind: "channel",
      sync_state: syncState,
      title: "#room",
      draft_key: "room",
      topic: null,
      unread: 0,
      mentions: 0,
      read_through: null,
    },
    { id: 1, label: "Local", nickname: "me", state },
  );
}
