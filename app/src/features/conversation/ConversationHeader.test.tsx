import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createMemo, createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { ConversationHeader } from "./ConversationHeader";

it("renders one-line identity and routes both header controls", () => {
  const toggleSidebar = vi.fn();
  const toggleMembers = vi.fn();
  render(() => (
    <ConversationHeader
      membersTooltip="Toggle member list (Ctrl+.)"
      memberCount={1284}
      membersPressed={true}
      onToggleMembers={toggleMembers}
      onToggleSidebar={toggleSidebar}
      sidebarTooltip="Toggle channel list (Ctrl+Alt+S)"
      title="#lounge"
      topic="A very long channel topic"
    />
  ));

  expect(screen.getByRole("heading", { name: "#lounge" })).toBeInTheDocument();
  expect(screen.getByText("A very long channel topic")).toHaveAttribute(
    "data-selectable",
    "true",
  );
  expect(screen.getByText("1,284")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Toggle member list" }),
  ).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Toggle channel list" }));
  fireEvent.click(screen.getByRole("button", { name: "Toggle member list" }));
  expect(toggleSidebar).toHaveBeenCalledOnce();
  expect(toggleMembers).toHaveBeenCalledOnce();
});

it("switches from a channel with a cleared topic to a DM", () => {
  const [buffer, setBuffer] = createSignal<{
    readonly title: string;
    readonly memberCount?: number;
  }>({ title: "#another", memberCount: 1 });
  const [topicShown, setTopicShown] = createSignal(true);
  const active = createMemo(buffer);
  render(() => (
    <ConversationHeader
      membersTooltip="Toggle member list"
      memberCount={
        active().memberCount !== undefined ? active().memberCount : undefined
      }
      onToggleMembers={() => {}}
      onToggleSidebar={() => {}}
      sidebarTooltip="Toggle channel list"
      title={active().title}
      topic={topicShown() ? active().title : undefined}
    />
  ));

  setTopicShown(false);
  setBuffer({ title: "composer" });

  expect(screen.getByRole("heading", { name: "composer" })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Toggle member list" }),
  ).toBeNull();
});
