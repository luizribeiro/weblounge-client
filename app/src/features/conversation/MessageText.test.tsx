import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { MessageText } from "./MessageText";

it("renders safe external and in-app message links", () => {
  const openChannel = vi.fn();
  const openExternal = vi.fn();
  render(() => (
    <MessageText
      authors={new Map()}
      onOpenChannel={openChannel}
      onOpenExternal={openExternal}
      text="visit https://example.org/path and #lounge"
    />
  ));

  const external = screen.getByRole("link", {
    name: "https://example.org/path",
  });
  expect(external).toHaveAttribute("href", "https://example.org/path");
  expect(external).toHaveAttribute("target", "_blank");
  expect(external).toHaveAttribute("rel", "noopener noreferrer");
  fireEvent.click(external);
  expect(openExternal).toHaveBeenCalledWith("https://example.org/path");

  fireEvent.click(screen.getByRole("link", { name: "#lounge" }));
  expect(openChannel).toHaveBeenCalledWith("#lounge");
});

it("opens only known non-own nickname tokens by pointer or keyboard", () => {
  const openDirect = vi.fn();
  render(() => (
    <MessageText
      authors={
        new Map([
          ["alice", { authorship: "other" as const, nick_color_index: 2 }],
          ["weblounge", { authorship: "own" as const, nick_color_index: 0 }],
        ])
      }
      onOpenDirect={openDirect}
      text="Alice unknown weblounge"
    />
  ));

  const alice = screen.getByRole("button", {
    name: "Open direct message with Alice",
  });
  fireEvent.click(alice);
  expect(openDirect).toHaveBeenCalledWith("Alice");
  expect(screen.getByText("unknown")).not.toHaveAttribute("role");
  expect(screen.getByText("weblounge")).not.toHaveAttribute("role");
});

it("keeps known nicknames inert when direct messages are unavailable", () => {
  render(() => (
    <MessageText
      authors={
        new Map([
          ["alice", { authorship: "other" as const, nick_color_index: 2 }],
        ])
      }
      text="alice"
    />
  ));

  expect(screen.getByText("alice")).not.toHaveAttribute("role");
});
