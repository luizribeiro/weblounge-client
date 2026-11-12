import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { expect, it, vi } from "vitest";
import type {
  BufferProjection,
  NetworkProjection,
} from "../../engine/protocol";
import { BufferSwitcher } from "./BufferSwitcher";

const networks: readonly NetworkProjection[] = [
  { id: 1, label: "Libera", nickname: "me", state: "online" },
  { id: 2, label: "OFTC", nickname: "me", state: "online" },
];
const buffers = [
  buffer(1, "#general", 1),
  { ...buffer(2, "Alice", 2, "direct"), unread: 3, mentions: 1 },
  buffer(3, "#solid-dev", 1),
];

it("filters, moves the active option, and opens the selected buffer", async () => {
  const [open, setOpen] = createSignal(true);
  const opened = vi.fn((_: number) => setOpen(false));
  render(() => (
    <Show when={open()}>
      <BufferSwitcher
        actions={[]}
        buffers={buffers}
        networks={networks}
        onDismiss={() => setOpen(false)}
        onOpen={opened}
        onRunAction={() => false}
        recentActionIds={[]}
        recentBufferIds={[1]}
      />
    </Show>
  ));
  await Promise.resolve();
  const input = screen.getByRole("combobox", { name: "Jump to" });
  expect(input).toHaveAttribute(
    "aria-activedescendant",
    "buffer-switcher-option-1",
  );

  fireEvent.input(input, { target: { value: "sdev" } });
  expect(screen.getByRole("option", { name: /#solid-dev/u })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.queryByRole("option", { name: /#general/u })).toBeNull();

  fireEvent.input(input, { target: { value: "" } });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: /Alice/u })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  fireEvent.keyDown(input, { key: "Enter" });
  expect(opened).toHaveBeenCalledWith(2);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("switches to commands with a leading greater-than and back on deletion", () => {
  const run = vi.fn(() => true);
  render(() => (
    <BufferSwitcher
      actions={[
        {
          id: "members.toggle",
          title: "Toggle member list",
          group: "View",
          chord: "Ctrl+.",
        },
      ]}
      buffers={buffers}
      networks={networks}
      onDismiss={() => {}}
      onOpen={() => {}}
      onRunAction={run}
      recentActionIds={[]}
      recentBufferIds={[]}
    />
  ));
  const input = screen.getByRole("combobox", { name: "Jump to" });

  fireEvent.input(input, { target: { value: ">member" } });
  expect(
    screen.getByRole("combobox", { name: "Run a command" }),
  ).toHaveAttribute("aria-controls", "omnibar-results");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(run).toHaveBeenCalledWith("members.toggle");

  fireEvent.input(input, { target: { value: "member" } });
  expect(screen.getByRole("combobox", { name: "Jump to" })).toBeInTheDocument();
});

function buffer(
  id: number,
  title: string,
  networkId: number,
  kind: BufferProjection["kind"] = "channel",
): BufferProjection {
  return {
    id,
    network_id: networkId,
    kind,
    sync_state: "synced",
    title,
    draft_key: `${networkId}:${title}`,
    topic: null,
    unread: 0,
    mentions: 0,
  };
}
