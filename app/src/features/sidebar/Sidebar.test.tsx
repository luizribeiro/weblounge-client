import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { CommandRegistry } from "../../commands/command-registry";
import type { SidebarListController } from "./Sidebar";
import { Sidebar } from "./Sidebar";

it("groups projected buffers and routes sidebar actions through commands", () => {
  const show = vi.fn();
  const server = vi.fn();
  const registry = new CommandRegistry(
    { "pane.show-buffer": show, "network.open-server": server },
    "other",
  );
  render(() => (
    <Sidebar
      activeBufferId={2}
      buffers={[
        {
          id: 1,
          network_id: 7,
          kind: "server",
          title: "Local Ergo",
          topic: null,
          unread: 0,
          mentions: 0,
          read_through: null,
        },
        {
          id: 2,
          network_id: 7,
          kind: "channel",
          title: "#lounge",
          topic: null,
          unread: 3,
          mentions: 1,
          read_through: null,
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

  expect(screen.getByText("1 network · connected")).toBeInTheDocument();
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
  const registry = new CommandRegistry(
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
            kind: "server",
            title: "Local Ergo",
            topic: null,
            unread: 0,
            mentions: 0,
            read_through: null,
          },
          {
            id: 2,
            network_id: 7,
            kind: "channel",
            title: "#lounge",
            topic: null,
            unread: 0,
            mentions: 0,
            read_through: null,
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
