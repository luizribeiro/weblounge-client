import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { ConversationHeader } from "./ConversationHeader";

it("renders one-line identity and routes both header controls", () => {
  const toggleSidebar = vi.fn();
  const toggleMembers = vi.fn();
  render(() => (
    <ConversationHeader
      membersTooltip="Toggle member list (Ctrl+.)"
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
  fireEvent.click(screen.getByRole("button", { name: "Toggle channel list" }));
  fireEvent.click(screen.getByRole("button", { name: "Toggle member list" }));
  expect(toggleSidebar).toHaveBeenCalledOnce();
  expect(toggleMembers).toHaveBeenCalledOnce();
});
