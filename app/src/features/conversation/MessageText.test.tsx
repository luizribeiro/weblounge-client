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
