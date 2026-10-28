import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import type { BufferProjection } from "../../engine/protocol";
import { SidebarRow } from "./SidebarRow";

const buffer: BufferProjection = {
  id: 1,
  network_id: 2,
  kind: "channel",
  title: "#lounge",
  unread: 4,
  mentions: 2,
};

describe("SidebarRow", () => {
  it("renders active mention state on a real button", () => {
    const onClick = vi.fn();
    render(() => (
      <SidebarRow active buffer={buffer} onClick={onClick} tabIndex={0} />
    ));

    const row = screen.getByRole("button", {
      name: "#lounge, 2 mentions",
    });
    expect(row).toHaveAttribute("aria-current", "page");
    row.click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("renders unread and muted states without a mention badge", () => {
    render(() => (
      <SidebarRow
        active={false}
        buffer={{ ...buffer, mentions: 0 }}
        muted
        onClick={() => {}}
        tabIndex={-1}
      />
    ));

    expect(
      screen.getByRole("button", { name: "#lounge, 4 unread" }),
    ).toHaveAttribute("data-muted", "true");
  });
});
