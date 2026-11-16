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
          shortcut: { labels: ["Ctrl+."], ariaKeyShortcuts: "Control+." },
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

it("leads with the sidebar's prefix and bolds unread names", () => {
  render(() => (
    <BufferSwitcher
      actions={[]}
      buffers={[
        ...buffers,
        { ...buffer(4, "Bea", 1, "direct"), peer_presence: "away" },
        { ...buffer(5, "deploybot", 2, "direct"), peer_bot: true },
      ]}
      networks={networks}
      onDismiss={() => {}}
      onOpen={() => {}}
      onRunAction={() => false}
      recentActionIds={[]}
      recentBufferIds={[]}
    />
  ));
  const row = (name: RegExp) => screen.getByRole("option", { name });

  expect(
    row(/^#general/u).querySelector("[data-channel-sign]"),
  ).toHaveTextContent("#");
  expect(row(/^Bea/u).querySelector("[data-presence-dot]")).toHaveAttribute(
    "data-presence",
    "away",
  );
  expect(row(/^deploybot/u).querySelector("[data-peer-bot]")).not.toBeNull();
  const emphasized = (name: RegExp) =>
    row(name).querySelector("[data-omnibar-name]")?.className ?? "";
  expect(emphasized(/^Alice/u)).not.toBe(emphasized(/^Bea/u));
  expect(emphasized(/^Bea/u)).toBe(emphasized(/^#general/u));
});

it.each([
  ["two networks", networks, "OFTC"],
  ["one network", networks.slice(1), undefined],
] as const)(
  "names the network after each row with %s",
  (_, connected, suffix) => {
    render(() => (
      <BufferSwitcher
        actions={[]}
        buffers={buffers}
        networks={connected}
        onDismiss={() => {}}
        onOpen={() => {}}
        onRunAction={() => false}
        recentActionIds={[]}
        recentBufferIds={[]}
      />
    ));
    const alice = screen.getByRole("option", { name: /^Alice/u });
    expect(alice).toHaveAccessibleName(
      ["Alice", suffix, "3 unread, including mentions"]
        .filter(Boolean)
        .join(", "),
    );

    if (suffix === undefined)
      expect(alice.querySelector("[data-omnibar-suffix]")).toBeNull();
    else
      expect(alice.querySelector("[data-omnibar-suffix]")).toHaveTextContent(
        suffix,
      );
  },
);

it("shows only an action's primary chord and keeps the rest in its tooltip", () => {
  render(() => (
    <BufferSwitcher
      actions={[
        {
          id: "buffer.previous",
          title: "Previous buffer",
          group: "Navigation",
          shortcut: {
            labels: ["⌥↑", "⌃⇧Tab", "⇧⌘["],
            ariaKeyShortcuts:
              "Alt+ArrowUp Control+Shift+Tab Meta+Shift+BracketLeft",
          },
        },
      ]}
      buffers={buffers}
      initialMode="commands"
      networks={networks}
      onDismiss={() => {}}
      onOpen={() => {}}
      onRunAction={() => true}
      recentActionIds={[]}
      recentBufferIds={[]}
    />
  ));
  const option = screen.getByRole("option", { name: /Previous buffer/u });

  expect(option.querySelectorAll("kbd")).toHaveLength(1);
  expect(option.querySelector("kbd")).toHaveTextContent(/^⌥↑$/u);
  expect(option).toHaveAttribute("title", "⌥↑ / ⌃⇧Tab / ⇧⌘[");
  expect(option).toHaveAttribute(
    "aria-keyshortcuts",
    "Alt+ArrowUp Control+Shift+Tab Meta+Shift+BracketLeft",
  );
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
