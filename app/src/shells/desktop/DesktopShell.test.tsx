import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type {
  BufferProjection,
  MessageProjection,
} from "../../engine/protocol";
import type { MemberWindow } from "../../features/members/MemberPanel";
import { installPlatformEnvironment } from "../../platform/environment";
import { DesktopShell } from "./DesktopShell";

const channel: BufferProjection = {
  id: 2,
  network_id: 1,
  sync_state: "synced" as const,
  kind: "channel",
  title: "#room",
  draft_key: "1:#room",
  topic: "Room topic",
  member_count: 7,
  unread: 0,
  mentions: 0,
};
const otherChannel: BufferProjection = {
  ...channel,
  id: 3,
  title: "#other",
  draft_key: "1:#other",
};
const direct: BufferProjection = {
  id: 4,
  network_id: 1,
  sync_state: "synced" as const,
  kind: "direct",
  title: "mel",
  direct_identity: "different_account",
  draft_key: "1:mel",
  topic: null,
  unread: 0,
  mentions: 0,
};
const otherDirect: BufferProjection = {
  ...direct,
  id: 5,
  title: "alice",
  direct_identity: "verified",
  draft_key: "1:alice",
};
const nickMessage: MessageProjection = {
  id: 1,
  author: "mel",
  text: "hello mel",
  kind: "text",
  bot: false,
  authorship: "other",
  nick_color_index: 1,
  highlighted: false,
  delivery: "received",
  local_send_id: null,
  server_ids: [],
  server_time_ms: 1,
  received_at_ms: 1,
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
      account: { state: "logged_in", name: "mel" },
      nick_color_index: 1,
      is_you: false,
    },
  ],
};

it("places the notification prompt above the desktop channel list", () => {
  const turnOn = vi.fn();
  const dismiss = vi.fn();
  render(() => (
    <DesktopShell
      buffers={[channel]}
      composerNotice={undefined}
      completion={undefined}
      focusRequest={undefined}
      memberships={new Map()}
      messages={new Map()}
      networks={[]}
      notificationPromptVisible
      onDismissNotificationPrompt={dismiss}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSend={async () => true}
      onTurnOnNotifications={turnOn}
    />
  ));

  const prompt = screen.getByRole("region", { name: "Notifications" });
  const sidebar = screen.getByRole("complementary", { name: "Channel list" });
  expect(sidebar.contains(prompt)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss notification prompt" }),
  );
  expect(turnOn).toHaveBeenCalledOnce();
  expect(dismiss).toHaveBeenCalledOnce();
});

it("closes a direct downward, keeps sidebar focus, and offers Undo", async () => {
  const send = vi.fn(async () => true);
  const openDirect = vi.fn();
  render(() => (
    <DesktopShell
      activeBufferId={direct.id}
      buffers={[channel, direct, otherDirect]}
      composerNotice={undefined}
      completion={undefined}
      focusRequest={undefined}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onOpenDirect={openDirect}
      onRequestCompletion={() => {}}
      onSend={send}
    />
  ));

  fireEvent.click(
    screen.getByRole("button", { name: "Close conversation with mel" }),
  );
  await waitFor(() => expect(send).toHaveBeenCalledWith(direct.id, "/close"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "alice" })).toHaveFocus(),
  );
  expect(screen.getByRole("heading", { name: "alice" })).toBeVisible();
  expect(screen.getByText("Closed chat with mel")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(openDirect).toHaveBeenCalledWith(1, "mel");
  expect(screen.queryByText("Closed chat with mel")).not.toBeInTheDocument();
});

it("resolves a cached direct through normal history", () => {
  const loadHistory = vi.fn();
  render(() => (
    <DesktopShell
      activeBufferId={4}
      buffers={[{ ...direct, unread: 2, mentions: 2 }]}
      composerNotice={undefined}
      completion={undefined}
      focusRequest={undefined}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onLoadHistory={loadHistory}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSend={async () => true}
    />
  ));

  expect(loadHistory).toHaveBeenCalledWith(4, "latest");
  expect(document.querySelector("[data-message-list]")).not.toBeNull();
});

it("resolves a cached channel through normal history", () => {
  const loadHistory = vi.fn();
  render(() => (
    <DesktopShell
      activeBufferId={2}
      buffers={[{ ...channel, unread: 2 }]}
      composerNotice={undefined}
      completion={undefined}
      focusRequest={undefined}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onLoadHistory={loadHistory}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSend={async () => true}
    />
  ));

  expect(loadHistory).toHaveBeenCalledWith(2, "latest");
});

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
  expect(
    screen.getByRole("complementary", { name: "Members of #room" }),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Open direct message with mel" }),
  );
  expect(openDirect).toHaveBeenCalledWith(1, "mel");
  fireEvent.click(screen.getByRole("button", { name: "Hide members" }));
  expect(
    screen.queryByRole("complementary", { name: "Members of #room" }),
  ).toBeNull();
  expect(requestMembers).toHaveBeenCalledWith("test-port:desktop:pane-1", 2, 0);
});

it("routes transcript nicknames through the direct-message action", () => {
  const openDirect = vi.fn();
  const result = render(() => (
    <DesktopShell
      activeBufferId={2}
      buffers={[channel]}
      composerNotice={undefined}
      completion={undefined}
      focusRequest={undefined}
      memberships={new Map()}
      messages={new Map([[2, [nickMessage]]])}
      networks={[]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onOpenDirect={openDirect}
      onRequestCompletion={() => {}}
      onSend={async () => true}
    />
  ));

  fireEvent.click(
    screen.getAllByRole("button", {
      name: "Open direct message with mel",
    })[0] as HTMLElement,
  );
  expect(openDirect).toHaveBeenCalledWith(1, "mel");
  result.unmount();

  const server = { ...channel, id: 4, kind: "server" as const, title: "Local" };
  render(() => (
    <DesktopShell
      activeBufferId={4}
      buffers={[server]}
      composerNotice={undefined}
      completion={undefined}
      focusRequest={undefined}
      memberships={new Map()}
      messages={new Map([[4, [nickMessage]]])}
      networks={[]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onOpenDirect={openDirect}
      onRequestCompletion={() => {}}
      onSend={async () => true}
    />
  ));
  expect(
    screen.queryByRole("button", { name: "Open direct message with mel" }),
  ).toBeNull();
});

it("blocks a mismatched direct thread and routes both identity decisions", () => {
  const trust = vi.fn();
  const defer = vi.fn();
  const [directBuffer, setDirectBuffer] = createSignal<BufferProjection>({
    ...direct,
    direct_identity: "unverified",
  });
  render(() => (
    <DesktopShell
      activeBufferId={direct.id}
      buffers={[directBuffer()]}
      composerNotice={undefined}
      completion={undefined}
      focusRequest={undefined}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onDeferDirectIdentity={defer}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSend={async () => true}
      onTrustDirectIdentity={trust}
    />
  ));

  expect(screen.queryByRole("alert")).toBeNull();
  setDirectBuffer(direct);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "This isn't the same mel — different account",
  );
  expect(screen.getByRole("textbox", { name: "Message mel" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Trust new identity" }));
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(trust).toHaveBeenCalledWith(direct.id);
  expect(defer).toHaveBeenCalledWith(direct.id);
});

it("keeps a kicked channel readable and disables its composer", () => {
  render(() => (
    <DesktopShell
      activeBufferId={channel.id}
      buffers={[{ ...channel, channel_status: "kicked" }]}
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
    />
  ));

  expect(screen.getByRole("status")).toHaveTextContent(
    "You were kicked from #room. Rejoin to send messages.",
  );
  expect(screen.getByRole("textbox", { name: "Message #room" })).toBeDisabled();
  expect(document.querySelector("[data-message-list]")).not.toBeNull();
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
  expect(
    screen.queryByRole("complementary", { name: "Members of #room" }),
  ).toBeNull();
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

it("does not reset a local selection to a stale external selection", () => {
  render(() => (
    <DesktopShell
      activeBufferId={otherChannel.id}
      buffers={[channel, otherChannel]}
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
    />
  ));

  fireEvent.click(screen.getByRole("button", { name: "#room" }));

  expect(screen.getByRole("textbox", { name: "Message #room" })).toBeVisible();
});

it("keeps the initial channel until a command focus request arrives", async () => {
  const [activeBufferId, setActiveBufferId] = createSignal<number>();
  const [buffers, setBuffers] = createSignal<readonly BufferProjection[]>([
    channel,
  ]);
  const [focusRequest, setFocusRequest] = createSignal<
    { readonly bufferId: number } | undefined
  >();
  render(() => (
    <DesktopShell
      activeBufferId={activeBufferId()}
      buffers={buffers()}
      composerNotice={undefined}
      completion={undefined}
      focusRequest={focusRequest()}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSelectBuffer={setActiveBufferId}
      onSend={async () => true}
    />
  ));

  expect(
    await screen.findByRole("textbox", { name: "Message #room" }),
  ).toBeVisible();

  setBuffers([otherChannel, channel]);
  expect(screen.getByRole("heading", { name: "#room" })).toBeVisible();

  setFocusRequest({ bufferId: otherChannel.id });
  expect(
    await screen.findByRole("textbox", { name: "Message #other" }),
  ).toBeVisible();
});

it("focuses the composer after buffer navigation and engine focus requests", async () => {
  const [focusRequest, setFocusRequest] = createSignal<
    { readonly bufferId: number } | undefined
  >();
  render(() => (
    <DesktopShell
      activeBufferId={channel.id}
      buffers={[channel, otherChannel]}
      composerNotice={undefined}
      completion={undefined}
      focusRequest={focusRequest()}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSend={async () => true}
    />
  ));

  fireEvent.click(screen.getByRole("button", { name: "#other" }));
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Message #other" }),
    ).toHaveFocus(),
  );

  screen.getByRole("button", { name: "#other" }).focus();
  fireEvent.keyDown(document, { altKey: true, key: "ArrowUp" });
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Message #room" }),
    ).toHaveFocus(),
  );

  setFocusRequest({ bufferId: otherChannel.id });
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Message #other" }),
    ).toHaveFocus(),
  );
});

it("opens, dismisses, and navigates with the buffer switcher", async () => {
  render(() => (
    <DesktopShell
      activeBufferId={channel.id}
      buffers={[channel, otherChannel, direct]}
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
    />
  ));

  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Message #room" }),
    ).toHaveFocus(),
  );
  const launcher = screen.getByRole("button", { name: "Jump to" });
  launcher.focus();
  fireEvent.click(launcher);
  const firstInput = await screen.findByRole("combobox", { name: "Jump to" });
  await waitFor(() => expect(firstInput).toHaveFocus());
  fireEvent.keyDown(firstInput, { key: "Escape" });
  await waitFor(() => expect(launcher).toHaveFocus());

  fireEvent.keyDown(document, { ctrlKey: true, key: "k" });
  const input = await screen.findByRole("combobox", { name: "Jump to" });
  fireEvent.input(input, { target: { value: "oth" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Message #other" }),
    ).toHaveFocus(),
  );
});

it("opens Settings from the web chord and returns focus on Escape", async () => {
  const onChangeSetting = vi.fn();
  render(() => (
    <DesktopShell
      activeBufferId={channel.id}
      buffers={[channel]}
      composerNotice={undefined}
      completion={undefined}
      focusRequest={undefined}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onChangeSetting={onChangeSetting}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSend={async () => true}
      settings={{ app: { theme: "lounge", message_density: "cozy" } }}
    />
  ));
  const composer = screen.getByRole("textbox", { name: "Message #room" });
  await waitFor(() => expect(composer).toHaveFocus());

  fireEvent.keyDown(composer, {
    code: "Comma",
    ctrlKey: true,
    key: "<",
    shiftKey: true,
  });
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await waitFor(() => expect(dialog).toHaveFocus());
  expect(screen.getByRole("radio", { name: "Lounge" })).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: "Compact" }));
  expect(onChangeSetting).toHaveBeenCalledWith({
    scope: "app",
    setting: { key: "message_density", value: "compact" },
  });

  fireEvent.keyDown(dialog, { ctrlKey: true, key: "k" });
  expect(screen.queryByRole("combobox", { name: "Jump to" })).toBeNull();

  fireEvent.keyDown(dialog, { key: "Escape" });

  await waitFor(() => expect(composer).toHaveFocus());
  expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();

  window.dispatchEvent(
    new CustomEvent("weblounge:action", { detail: "settings.open" }),
  );
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Settings" }), {
    key: "Escape",
  });
  await waitFor(() => expect(composer).toHaveFocus());
});

it("focuses the Settings dialog when run from the command palette", async () => {
  render(() => (
    <DesktopShell
      activeBufferId={channel.id}
      buffers={[channel]}
      composerNotice={undefined}
      completion={undefined}
      focusRequest={undefined}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onChangeSetting={() => {}}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSend={async () => true}
    />
  ));
  const composer = screen.getByRole("textbox", { name: "Message #room" });
  await waitFor(() => expect(composer).toHaveFocus());

  fireEvent.keyDown(composer, { ctrlKey: true, key: "k" });
  const query = await screen.findByRole("combobox", { name: "Jump to" });
  fireEvent.input(query, { target: { value: ">sett" } });
  fireEvent.keyDown(
    await screen.findByRole("combobox", { name: "Run a command" }),
    { key: "Enter" },
  );

  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await waitFor(() => expect(dialog).toHaveFocus());
});

it("routes printable chrome keys to the composer without hijacking controls", () => {
  render(() => (
    <DesktopShell
      activeBufferId={channel.id}
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
    />
  ));

  const toggle = screen.getByRole("button", { name: "Toggle channel list" });
  const composer = screen.getByRole("textbox", { name: "Message #room" });
  toggle.focus();
  fireEvent.keyDown(toggle, { key: "h" });
  expect(composer).toHaveFocus();
  expect(composer).toHaveValue("h");

  toggle.focus();
  fireEvent.keyDown(toggle, { key: " " });
  expect(toggle).toHaveFocus();
  expect(composer).toHaveValue("h");
});

it("keeps the read dwell across equal buffer and message replacements", () => {
  vi.useFakeTimers();
  const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("visible");
  const [snapshot, setSnapshot] = createSignal({
    buffers: [{ ...channel, unread: 1 }] as readonly BufferProjection[],
    messages: new Map<number, readonly MessageProjection[]>([
      [channel.id, [nickMessage]],
    ]),
  });
  const markRead = vi.fn();
  const result = render(() => (
    <DesktopShell
      activeBufferId={channel.id}
      buffers={snapshot().buffers}
      composerNotice={undefined}
      completion={undefined}
      focusRequest={undefined}
      memberships={new Map()}
      messages={snapshot().messages}
      networks={[]}
      onLoadHistory={() => {}}
      onMarkRead={markRead}
      onRequestCompletion={() => {}}
      onSend={async () => true}
    />
  ));

  try {
    fireEvent.keyDown(screen.getByRole("list", { name: "Messages" }), {
      key: "End",
    });
    vi.advanceTimersByTime(300);
    setSnapshot((current) => ({
      buffers: current.buffers.map((buffer) => ({ ...buffer })),
      messages: new Map(
        [...current.messages].map(([bufferId, messages]) => [
          bufferId,
          messages.map((message) => ({ ...message })),
        ]),
      ),
    }));
    vi.advanceTimersByTime(200);

    expect(markRead).toHaveBeenCalledOnce();
    expect(markRead).toHaveBeenCalledWith(channel.id, nickMessage.id);
  } finally {
    result.unmount();
    hasFocus.mockRestore();
    visibility.mockRestore();
    vi.useRealTimers();
  }
});
