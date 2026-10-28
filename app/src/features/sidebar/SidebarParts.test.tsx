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
  const settings = vi.fn();
  render(() => (
    <>
      <NetworkSection
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
            unread: 0,
            mentions: 0,
            read_through: null,
          },
        ]}
        network={network}
        onFocus={() => {}}
        onOpenBuffer={openBuffer}
        onOpenServer={openServer}
        registerElement={() => {}}
        rovingId={2}
        visibleBufferIds={new Set([2])}
      />
      <SidebarFooter
        networks={[network]}
        onOpenSettings={settings}
        settingsTooltip="Settings (Ctrl+,)"
      />
    </>
  ));

  fireEvent.click(
    screen.getByRole("button", { name: "Local Ergo, connecting" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "#lounge" }));
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(openServer).toHaveBeenCalledOnce();
  expect(openBuffer).toHaveBeenCalledOnce();
  expect(settings).toHaveBeenCalledOnce();
  expect(screen.getByText("connecting")).toBeInTheDocument();
});
