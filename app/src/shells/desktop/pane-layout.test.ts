import { describe, expect, it } from "vitest";
import { createSinglePane, showInFocusedPane } from "./pane-layout";

describe("single-pane layout", () => {
  it("keeps the required root and focus when empty", () => {
    const layout = createSinglePane();

    expect(layout.root.kind).toBe("leaf");
    expect(layout.focused).toBe(layout.root.id);
    expect(layout.root.bufferId).toBeUndefined();
  });

  it("shows a buffer without replacing the stable pane", () => {
    const initial = createSinglePane(1);
    const next = showInFocusedPane(initial, 2);

    expect(next.root.id).toBe(initial.root.id);
    expect(next.root.bufferId).toBe(2);
  });
});
