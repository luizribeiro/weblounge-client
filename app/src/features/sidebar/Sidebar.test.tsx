import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { ActionRegistry } from "../../actions/action-registry";
import type { CommandSpec } from "../../engine/protocol";
import { installContextMenuHandler } from "../../ui/context-menu";
import type { SidebarListController } from "./Sidebar";
import { Sidebar } from "./Sidebar";

it("groups projected buffers and routes sidebar actions through commands", () => {
  const show = vi.fn();
  const server = vi.fn();
  const switcher = vi.fn();
  const registry = new ActionRegistry(
    {
      "network.open-server": server,
      "pane.show-buffer": show,
      "switcher.open": switcher,
    },
    "other",
  );
  render(() => (
    <Sidebar
      activeBufferId={2}
      buffers={[
        {
          id: 1,
          network_id: 7,
          sync_state: "synced" as const,
          kind: "server",
          title: "Local Ergo",
          ...{ draft_key: "test:server" },
          topic: null,
          unread: 0,
          mentions: 0,
        },
        {
          id: 2,
          network_id: 7,
          sync_state: "synced" as const,
          kind: "channel",
          title: "#lounge",
          ...{ draft_key: "test:#lounge" },
          topic: null,
          unread: 3,
          mentions: 1,
        },
      ]}
      commandContext={{ bufferCount: 2, listActive: true }}
      networks={[
        {
          id: 7,
          label: "Local Ergo",
          nickname: "weblounge",
          state: "online",
        },
      ]}
      registerListController={() => {}}
      registry={registry}
      visibleBufferIds={new Set([2])}
    />
  ));

  expect(screen.getByText("1 network")).toBeInTheDocument();
  expect(
    screen.getByText("weblounge", {
      exact: true,
      selector: "footer [data-line]",
    }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Jump to" }));
  expect(switcher).toHaveBeenCalledOnce();
  expect(
    screen.queryByRole("button", { name: "Add network" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Settings" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "#lounge" }));
  fireEvent.click(screen.getByRole("button", { name: "Local Ergo, online" }));
  expect(show).toHaveBeenCalledWith(
    expect.objectContaining({ targetBufferId: 2 }),
  );
  expect(server).toHaveBeenCalledWith(
    expect.objectContaining({ targetBufferId: 1, targetNetworkId: 7 }),
  );
});

it("moves roving focus through real list commands", () => {
  let controller: SidebarListController | undefined;
  const registry = new ActionRegistry(
    {
      "list.next": () => controller?.next(),
      "list.previous": () => controller?.previous(),
    },
    "other",
  );
  const context = { bufferCount: 2, listActive: true };
  render(() => (
    <fieldset onKeyDown={(event) => registry.handleKeydown(event, context)}>
      <Sidebar
        activeBufferId={1}
        buffers={[
          {
            id: 1,
            network_id: 7,
            sync_state: "synced" as const,
            kind: "server",
            title: "Local Ergo",
            ...{ draft_key: "test:server" },
            topic: null,
            unread: 0,
            mentions: 0,
          },
          {
            id: 2,
            network_id: 7,
            sync_state: "synced" as const,
            kind: "channel",
            title: "#lounge",
            ...{ draft_key: "test:#lounge" },
            topic: null,
            unread: 0,
            mentions: 0,
          },
        ]}
        commandContext={context}
        networks={[
          {
            id: 7,
            label: "Local Ergo",
            nickname: "weblounge",
            state: "online",
          },
        ]}
        registerListController={(value) => {
          controller = value;
        }}
        registry={registry}
        visibleBufferIds={new Set()}
      />
    </fieldset>
  ));
  const server = screen.getByRole("button", { name: "Local Ergo, online" });
  const channel = screen.getByRole("button", { name: "#lounge" });

  server.focus();
  fireEvent.keyDown(server, { key: "ArrowDown" });
  expect(channel).toHaveFocus();
  expect(channel).toHaveAttribute("tabindex", "0");

  fireEvent.keyDown(channel, { key: "ArrowUp" });
  expect(server).toHaveFocus();
});

it("shows only runnable row-menu items and dispatches against its target", async () => {
  const markRead = vi.fn();
  const runCommand = vi.fn();
  const registry = new ActionRegistry(
    { "buffer.mark-read": markRead },
    "other",
    [channelCommand("cycle"), channelCommand("topic")],
    runCommand,
  );
  const removeContextMenuHandler = installContextMenuHandler(document);
  render(() => (
    <Sidebar
      buffers={[
        buffer(2, "channel", "#lounge", 3),
        buffer(3, "direct", "alice", 0),
      ]}
      commandContext={{ bufferCount: 2, connected: true, listActive: true }}
      networks={[
        {
          id: 7,
          label: "Local Ergo",
          nickname: "weblounge",
          state: "online",
        },
      ]}
      registerListController={() => {}}
      registry={registry}
      visibleBufferIds={new Set()}
    />
  ));
  const channel = screen.getByRole("button", {
    name: "#lounge, 3 unread",
  });

  fireEvent.contextMenu(channel);
  expect(await screen.findByRole("menu")).toHaveAccessibleName(
    "Actions for #lounge",
  );
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual([
    "Mark as read",
    "Leave and rejoin a channel",
    "Show or change the channel topic",
  ]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Mark as read" }));
  expect(markRead).toHaveBeenCalledWith(
    expect.objectContaining({ targetBufferId: 2, targetUnread: true }),
  );

  fireEvent.contextMenu(screen.getByRole("button", { name: "alice" }));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  removeContextMenuHandler();
});

function buffer(
  id: number,
  kind: "channel" | "direct",
  title: string,
  unread: number,
) {
  return {
    id,
    network_id: 7,
    sync_state: "synced" as const,
    kind,
    title,
    draft_key: `test:${title}`,
    topic: null,
    unread,
    mentions: 0,
  };
}

function channelCommand(name: "cycle" | "topic"): CommandSpec {
  return {
    name,
    aliases: [],
    arguments: [{ name: "channel", kind: "channel", required: false }],
    usage: `cmd.${name}.usage`,
    description: `cmd.${name}.description`,
    requirements: [{ type: "connected" }],
    permission: "anyone",
    surfaces: ["channel_menu"],
    confirm: "none",
    secret_arguments: false,
  };
}
