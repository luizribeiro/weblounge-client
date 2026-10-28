import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { CommandRegistry } from "../../commands/command-registry";
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
          unread: 0,
          mentions: 0,
        },
        {
          id: 2,
          network_id: 7,
          kind: "channel",
          title: "#lounge",
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
    />
  ));

  expect(screen.getByText("1 network · connected")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "#lounge, 1 mentions" }));
  fireEvent.click(screen.getByRole("button", { name: "Local Ergo, online" }));
  expect(show).toHaveBeenCalledWith(
    expect.objectContaining({ targetBufferId: 2 }),
  );
  expect(server).toHaveBeenCalledWith(
    expect.objectContaining({ targetBufferId: 1, targetNetworkId: 7 }),
  );
});
