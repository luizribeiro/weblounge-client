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
        buffers={buffers}
        networks={networks}
        onDismiss={() => setOpen(false)}
        onOpen={opened}
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
