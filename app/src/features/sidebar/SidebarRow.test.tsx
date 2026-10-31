import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import type { BufferProjection } from "../../engine/protocol";
import { SidebarRow } from "./SidebarRow";

const buffer: BufferProjection = {
  id: 1,
  network_id: 2,
  kind: "channel",
  title: "#lounge",
  ...{ draft_key: "test:#lounge" },
  topic: null,
  unread: 4,
  mentions: 2,
  read_through: null,
};

describe("SidebarRow", () => {
  it("suppresses badges for a buffer rendered in a visible pane", () => {
    const onClick = vi.fn();
    render(() => (
      <SidebarRow
        active
        badgesSuppressed
        buffer={buffer}
        onClick={onClick}
        tabIndex={0}
      />
    ));

    const row = screen.getByRole("button", {
      name: "#lounge",
    });
    expect(row).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText("2")).not.toBeInTheDocument();
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

  it.each([
    ["channel", "#ops"],
    ["channel", "&help"],
    ["channel", "##linux"],
    ["direct", "mel"],
  ] as const)("renders the exact %s name %s without an icon", (kind, title) => {
    const { container } = render(() => (
      <SidebarRow
        active={false}
        buffer={{ ...buffer, kind, title }}
        onClick={() => {}}
        tabIndex={-1}
      />
    ));

    const prefix = kind === "channel" ? title.slice(0, 1) : "";
    const name = kind === "channel" ? title.slice(1) : title;
    expect(container.querySelector("button")).toHaveAttribute(
      "aria-label",
      `${title}, 2 mentions`,
    );
    expect(container.querySelector("[data-sidebar-prefix]")).toHaveTextContent(
      prefix,
    );
    expect(container.querySelector("[data-sidebar-name]")).toHaveTextContent(
      name,
    );
  });
});
