import { expect, it } from "vitest";
import { connectionPresentation } from "./connection-state";
import type { NetworkProjection } from "./protocol";

it("maps every connection state to one label and color token", () => {
  const cases: readonly [
    NetworkProjection["state"],
    string,
    "online" | "muted",
  ][] = [
    ["connecting", "Connecting…", "muted"],
    ["registering", "Connecting…", "muted"],
    ["online", "Online", "online"],
    [
      { reconnecting: { attempt: 2, next_retry_at_ms: 1_000 } },
      "Reconnecting…",
      "muted",
    ],
    [{ offline: { reason: "device_offline" } }, "Offline", "muted"],
    [
      { failed: { reason: "transport", message_key: "engine.failed" } },
      "Offline · Retry",
      "muted",
    ],
  ];

  for (const [state, label, colorToken] of cases) {
    expect(connectionPresentation(state)).toMatchObject({ label, colorToken });
  }
});
