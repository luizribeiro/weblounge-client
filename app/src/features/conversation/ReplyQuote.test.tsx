import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { ReplyQuote } from "./ReplyQuote";

const quoted = { author: "alice", nick_color_index: 2, text: "ship it?" };

describe("ReplyQuote", () => {
  it("jumps to a loaded parent", () => {
    const jump = vi.fn();
    render(() => (
      <ReplyQuote
        onJump={jump}
        parent={{ state: "loaded", message_id: 41, ...quoted }}
      />
    ));

    const quote = screen.getByRole("button", {
      name: "Reply to alice. Go to the original message",
    });
    expect(quote).toHaveTextContent("aliceship it?");
    fireEvent.click(quote);
    expect(jump).toHaveBeenCalledWith(41);
  });

  it("quotes a fetched parent without offering a jump", () => {
    render(() => (
      <ReplyQuote onJump={vi.fn()} parent={{ state: "fetched", ...quoted }} />
    ));

    expect(screen.queryByRole("button")).toBeNull();
    expect(
      screen.getByRole("note", { name: "Reply to alice" }),
    ).toHaveTextContent("aliceship it?");
  });

  it.each([
    ["loading", "Loading the original message…"],
    ["deleted", "Original message deleted"],
    ["unavailable", "Original message unavailable"],
  ] as const)("says the parent is %s", (state, text) => {
    render(() => <ReplyQuote onJump={vi.fn()} parent={{ state }} />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(
      screen.getByText(text).closest("[data-reply-quote]"),
    ).toHaveAttribute("data-reply-quote", state);
  });
});
