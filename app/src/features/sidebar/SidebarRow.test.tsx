import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import type { BufferProjection } from "../../engine/protocol";
import { SidebarRow } from "./SidebarRow";

const buffer: BufferProjection = {
  id: 1,
  network_id: 2,
  sync_state: "synced" as const,
  kind: "channel",
  title: "#lounge",
  ...{ draft_key: "test:#lounge" },
  topic: null,
  unread: 4,
  mentions: 2,
};

describe("SidebarRow", () => {
  it.each([
    ["direct", "alice", "Close conversation with alice", "Close conversation"],
    ["channel", "#lounge", "Leave channel", "Leave channel"],
  ] as const)(
    "offers close on a %s row as %s",
    (kind, title, label, tooltip) => {
      const close = vi.fn();
      render(() => (
        <SidebarRow
          active={false}
          buffer={{ ...buffer, kind, title }}
          onClick={() => {}}
          onClose={close}
          tabIndex={0}
        />
      ));

      const button = screen.getByRole("button", { name: label });
      expect(button).toHaveAttribute("title", tooltip);
      expect(
        screen.getByRole("button", { name: /unread/u }),
      ).toHaveAccessibleName(`${title}, 4 unread, including mentions`);
      button.click();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["direct", "alice"],
    ["channel", "#lounge"],
  ] as const)(
    "offers no close on a %s row without a close handler",
    (kind, title) => {
      render(() => (
        <SidebarRow
          active={false}
          buffer={{ ...buffer, kind, title }}
          onClick={() => {}}
          tabIndex={0}
        />
      ));

      expect(screen.getAllByRole("button")).toHaveLength(1);
    },
  );

  describe("middle-click", () => {
    const click = (target: Element, init: MouseEventInit) => {
      const event = new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      target.dispatchEvent(event);
      return event;
    };
    const renderRow = (onClose?: () => void) => {
      render(() => (
        <SidebarRow
          active={false}
          buffer={buffer}
          onClick={() => {}}
          onClose={onClose}
          tabIndex={0}
        />
      ));
      return screen.getByRole("button", { name: /^#lounge/u });
    };

    it("closes the row, like its close button, without autoscroll or paste", () => {
      const close = vi.fn();
      const row = renderRow(close);

      expect(fireEvent.mouseDown(row, { button: 1 })).toBe(false);
      expect(click(row, { button: 1 }).defaultPrevented).toBe(true);
      expect(close).toHaveBeenCalledOnce();
    });

    it("ignores other buttons and a middle press during a drag", () => {
      const close = vi.fn();
      const row = renderRow(close);

      expect(fireEvent.mouseDown(row, { button: 0 })).toBe(true);
      click(row, { button: 2 });
      click(row, { button: 1, buttons: 1 });
      expect(close).not.toHaveBeenCalled();
    });

    it("still swallows the middle press on a row that cannot close", () => {
      const row = renderRow();

      expect(fireEvent.mouseDown(row, { button: 1 })).toBe(false);
      expect(click(row, { button: 1 }).defaultPrevented).toBe(true);
    });

    it("closes once from a middle-click on the close button itself", () => {
      const close = vi.fn();
      renderRow(close);
      const closeButton = screen.getByRole("button", { name: "Leave channel" });

      expect(fireEvent.mouseDown(closeButton, { button: 1 })).toBe(false);
      click(closeButton, { button: 1 });
      expect(close).toHaveBeenCalledOnce();
    });
  });

  it("keeps the row's text to its name while a jump number waits in the slot", () => {
    render(() => (
      <SidebarRow
        active={false}
        buffer={{ ...buffer, unread: 0, mentions: 0 }}
        jumpSlot={1}
        onClick={() => {}}
        tabIndex={0}
      />
    ));

    expect(screen.getByRole("button", { name: "#lounge" })).toHaveTextContent(
      /^#lounge$/u,
    );
  });

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
    expect(row).toHaveAttribute("data-unread", "0");
    expect(row).toHaveAttribute("data-mentions", "0");
    expect(screen.queryByText("4")).not.toBeInTheDocument();
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
      `${title}, 4 unread, including mentions`,
    );
    expect(container.querySelector("[data-sidebar-prefix]")).toHaveTextContent(
      prefix,
    );
    expect(container.querySelector("[data-sidebar-name]")).toHaveTextContent(
      name,
    );
  });

  it.each([
    ["online", "alice, 4 unread, including mentions, online"],
    ["away", "alice, 4 unread, including mentions, away"],
  ] as const)(
    "marks a direct peer reported %s on its leading column",
    (presence, label) => {
      const { container } = render(() => (
        <SidebarRow
          active={false}
          buffer={{
            ...buffer,
            kind: "direct",
            title: "alice",
            peer_presence: presence,
          }}
          onClick={() => {}}
          tabIndex={0}
        />
      ));

      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
      expect(
        container.querySelector("[data-sidebar-prefix] [data-presence]"),
      ).toHaveAttribute("data-presence", presence);
    },
  );

  it("shows no presence for a direct peer the network reports nothing about", () => {
    const { container } = render(() => (
      <SidebarRow
        active={false}
        buffer={{ ...buffer, kind: "direct", title: "alice" }}
        onClick={() => {}}
        tabIndex={0}
      />
    ));

    expect(container.querySelector("[data-presence]")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "alice, 4 unread, including mentions",
      }),
    ).toBeInTheDocument();
  });

  it("names a read direct row with its peer's presence alone", () => {
    render(() => (
      <SidebarRow
        active={false}
        buffer={{
          ...buffer,
          kind: "direct",
          title: "alice",
          unread: 0,
          mentions: 0,
          peer_presence: "online",
        }}
        onClick={() => {}}
        tabIndex={0}
      />
    ));

    expect(
      screen.getByRole("button", { name: "alice, online" }),
    ).toBeInTheDocument();
  });
});
