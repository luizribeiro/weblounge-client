import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { NetworkSection } from "./NetworkSection";
import { SidebarFooter } from "./SidebarFooter";

const network = {
  id: 7,
  label: "Local Ergo",
  nickname: "weblounge",
  state: "connecting" as const,
};

it("keeps network rows and account chrome in focused components", () => {
  const openServer = vi.fn();
  const openBuffer = vi.fn();
  const { container } = render(() => (
    <>
      <NetworkSection
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
            unread: 0,
            mentions: 0,
          },
        ]}
        network={network}
        onFocus={() => {}}
        onOpenBuffer={openBuffer}
        onOpenMenu={() => {}}
        onOpenServer={openServer}
        registerElement={() => {}}
        rovingId={2}
        visibleBufferIds={new Set([2])}
      />
      <SidebarFooter networks={[network]} />
    </>
  ));

  fireEvent.click(
    screen.getByRole("button", { name: "Local Ergo, connecting" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "#lounge" }));
  expect(openServer).toHaveBeenCalledOnce();
  expect(openBuffer).toHaveBeenCalledOnce();
  expect(screen.getByText("weblounge", { exact: true })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  expect(screen.queryByText("Connecting…")).not.toBeInTheDocument();
  expect(container.querySelector("[data-connection-indicator]")).toBeNull();
});
