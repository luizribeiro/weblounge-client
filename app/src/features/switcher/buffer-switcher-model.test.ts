import { describe, expect, it } from "vitest";
import type {
  BufferProjection,
  NetworkProjection,
} from "../../engine/protocol";
import {
  moveSwitcherSelection,
  switcherBuffers,
  switcherKeyIntent,
} from "./buffer-switcher-model";

const networks: readonly NetworkProjection[] = [
  { id: 1, label: "Libera", nickname: "me", state: "online" },
  { id: 2, label: "OFTC", nickname: "me", state: "online" },
];
const buffers = [
  buffer(1, "#general", 1, 100),
  buffer(2, "#solid-dev", 1, 400),
  buffer(3, "Alice", 2, 300, "direct"),
  buffer(4, "server", 1, 500, "server"),
];

describe("buffer switcher model", () => {
  it("ranks visited buffers before activity when the query is empty", () => {
    expect(
      switcherBuffers(buffers, networks, [1, 3], "").map(
        ({ buffer: current }) => current.id,
      ),
    ).toEqual([1, 3, 2]);
  });

  it("favors exact, prefix, substring, then fuzzy subsequence matches", () => {
    const candidates = [
      buffer(1, "#social", 1),
      buffer(2, "#solid-dev", 1),
      buffer(3, "old-solid", 1),
      buffer(4, "#snowy-owl-island", 1),
    ];
    expect(
      switcherBuffers(candidates, networks, [], "solid").map(
        ({ buffer: current }) => current.id,
      ),
    ).toEqual([2, 3, 4]);
  });

  it("wraps selection and maps only switcher-owned keys", () => {
    expect(moveSwitcherSelection(0, 3, -1)).toBe(2);
    expect(moveSwitcherSelection(2, 3, 1)).toBe(0);
    expect(intent("ArrowDown")).toBe("next");
    expect(intent("p", { ctrlKey: true })).toBe("previous");
    expect(intent("Enter")).toBe("open");
    expect(intent("Enter", { ctrlKey: true })).toBeUndefined();
    expect(intent("Escape")).toBe("dismiss");
    expect(intent("ArrowDown", { isComposing: true })).toBeUndefined();
  });
});

function buffer(
  id: number,
  title: string,
  networkId: number,
  lastActivity = 0,
  kind: BufferProjection["kind"] = "channel",
): BufferProjection {
  return {
    id,
    network_id: networkId,
    kind,
    sync_state: "synced",
    title,
    draft_key: `${networkId}:${title}`,
    topic: null,
    unread: 0,
    mentions: 0,
    last_activity_ms: lastActivity,
  };
}

function intent(
  key: string,
  overrides: Partial<KeyboardEvent> = {},
): ReturnType<typeof switcherKeyIntent> {
  return switcherKeyIntent({
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    key,
    metaKey: false,
    repeat: false,
    shiftKey: false,
    ...overrides,
  });
}
