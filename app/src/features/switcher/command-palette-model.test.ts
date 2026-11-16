import { describe, expect, it } from "vitest";
import {
  commandQuery,
  omnibarMode,
  paletteActions,
  paletteSuffix,
} from "./command-palette-model";

const actions = [
  {
    id: "members.toggle" as const,
    title: "Toggle member list",
    group: "View" as const,
  },
  {
    id: "buffer.next" as const,
    title: "Next buffer",
    group: "Navigation" as const,
  },
  {
    id: "sidebar.toggle" as const,
    title: "Toggle channel list",
    group: "View" as const,
  },
];

describe("command palette model", () => {
  it("names an action's group unless it is the default Commands group", () => {
    expect(
      paletteSuffix({ id: "buffer.next", title: "Next", group: "Navigation" }),
    ).toBe("Navigation");
    expect(
      paletteSuffix({ id: "command.part", title: "Leave", group: "Commands" }),
    ).toBeUndefined();
  });

  it("switches modes only while the first character is greater-than", () => {
    expect(omnibarMode(">tog")).toBe("commands");
    expect(commandQuery("> tog")).toBe("tog");
    expect(omnibarMode("tog")).toBe("buffers");
    expect(omnibarMode(" >tog")).toBe("buffers");
  });

  it("filters fuzzy matches and uses action recency to break ties", () => {
    expect(paletteActions(actions, [], "member").map(({ id }) => id)).toEqual([
      "members.toggle",
    ]);
    expect(
      paletteActions(
        actions,
        ["sidebar.toggle", "members.toggle"],
        "toggle",
      ).map(({ id }) => id),
    ).toEqual(["sidebar.toggle", "members.toggle"]);
  });
});
