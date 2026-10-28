import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import type { BufferProjection } from "../../engine/protocol";
import type { MemberWindow } from "../../features/members/MemberPanel";
import { DesktopShell } from "./DesktopShell";

const channel: BufferProjection = {
  id: 2,
  network_id: 1,
  kind: "channel",
  title: "#room",
  draft_key: "1:#room",
  topic: "Room topic",
  unread: 0,
  mentions: 0,
  read_through: null,
};
const members: MemberWindow = {
  type: "members_changed",
  buffer_id: 2,
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
