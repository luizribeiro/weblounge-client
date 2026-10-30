import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import type { BufferProjection } from "../../engine/protocol";
import type { MemberWindow } from "../../features/members/MemberPanel";
import { installPlatformEnvironment } from "../../platform/environment";
import { DesktopShell } from "./DesktopShell";

const channel: BufferProjection = {
  id: 2,
  network_id: 1,
  kind: "channel",
  title: "#room",
  draft_key: "1:#room",
  topic: "Room topic",
  member_count: 7,
  unread: 0,
  mentions: 0,
  read_through: null,
};
const members: MemberWindow = {
  type: "members_changed",
  buffer_id: 2,
  view_id: "test-port:desktop:pane-1",
  version: 0,
  window_size: 256,
  offset: 0,
  total: 7,
  counts: [1, 0, 6, 0, 0],
  members: [
    {
      group: "operators",
      nick: "mel",
      mode_symbol: "@",
      away: false,
      bot: false,
      account: "mel",
      nick_color_index: 1,
      is_you: false,
    },
  ],
};

it("toggles the channel member panel and routes direct messages", () => {
  const openDirect = vi.fn();
  const requestMembers = vi.fn();
  render(() => (
    <DesktopShell
      activeBufferId={2}
      buffers={[channel]}
      composerNotice={undefined}
      completion={undefined}
      focusRequest={undefined}
      memberships={new Map()}
      memberViewScope="test-port"
      memberWindows={new Map([["test-port:desktop:pane-1", members]])}
      messages={new Map()}
      networks={[]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onOpenDirect={openDirect}
      onRequestCompletion={() => {}}
      onRequestMembers={requestMembers}
      onSend={async () => true}
    />
  ));

  const toggle = screen.getByRole("button", { name: "Toggle member list" });
  expect(toggle).toHaveTextContent("7");
  expect(requestMembers).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  expect(screen.getByRole("complementary", { name: "Members" })).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Open direct message with mel" }),
  );
  expect(openDirect).toHaveBeenCalledWith(1, "mel");
  fireEvent.click(screen.getByRole("button", { name: "Hide members" }));
  expect(screen.queryByRole("complementary", { name: "Members" })).toBeNull();
  expect(requestMembers).toHaveBeenCalledWith("test-port:desktop:pane-1", 2, 0);
});

it("shows the projected member total while the panel is closed", () => {
  render(() => (
    <DesktopShell
      activeBufferId={2}
      buffers={[channel]}
      composerNotice={undefined}
      completion={undefined}
      focusRequest={undefined}
      memberships={new Map()}
      messages={new Map()}
      networks={[]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSend={async () => true}
    />
  ));

  expect(
    screen.getByRole("button", { name: "Toggle member list" }),
  ).toHaveTextContent("7");
  expect(screen.queryByRole("complementary", { name: "Members" })).toBeNull();
});

it("keeps the desktop shell and opens narrow panels as one drawer", async () => {
  const innerWidth = vi.spyOn(window, "innerWidth", "get").mockReturnValue(400);
  let resize: ((width: number) => void) | undefined;
  const platform = installPlatformEnvironment(document.body, window, {
    observeWidth: (_element, onWidth) => {
      resize = onWidth;
      return () => {};
    },
  });
  resize?.(400);
  render(() => (
    <DesktopShell
      activeBufferId={2}
      buffers={[channel]}
      composerNotice={undefined}
      completion={undefined}
      focusRequest={undefined}
      memberships={new Map()}
      messages={new Map()}
      networks={[
        { id: 1, label: "Local Ergo", nickname: "me", state: "online" },
      ]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSend={async () => true}
    />
  ));

  expect(document.querySelector("[data-desktop-shell]")).not.toBeNull();
  expect(
    screen.queryByRole("complementary", { name: "Channel list" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Toggle channel list" }));
  expect(screen.getByRole("dialog", { name: "Channels" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "#room" }));
  await Promise.resolve();
  expect(screen.queryByRole("dialog", { name: "Channels" })).toBeNull();
  const composer = screen.getByRole("textbox", { name: "Message #room" });
  expect(composer).toHaveFocus();

  fireEvent.click(screen.getByRole("button", { name: "Toggle member list" }));
  const membersDialog = screen.getByRole("dialog", { name: "Members" });
  expect(membersDialog).toBeVisible();
  fireEvent.keyDown(membersDialog, { key: "Escape" });
  await Promise.resolve();
  expect(screen.queryByRole("dialog", { name: "Members" })).toBeNull();
  expect(composer).toHaveFocus();
  platform.dispose();
  innerWidth.mockRestore();
});

it("replaces the URL when a buffer is selected", () => {
  const replace = vi.spyOn(window.history, "replaceState");
  const push = vi.spyOn(window.history, "pushState");
  try {
    render(() => (
      <DesktopShell
        buffers={[channel]}
        composerNotice={undefined}
        completion={undefined}
        focusRequest={undefined}
        memberships={new Map()}
        messages={new Map()}
        networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
        onLoadHistory={() => {}}
        onMarkRead={() => {}}
        onRequestCompletion={() => {}}
        onSend={async () => true}
        pathForBuffer={() => "/Local/room"}
      />
    ));

    fireEvent.click(screen.getByRole("button", { name: "#room" }));

    expect(window.location.pathname).toBe("/Local/room");
    expect(replace).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  } finally {
    replace.mockRestore();
    push.mockRestore();
  }
});
