import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it } from "vitest";
import { ReactionChips } from "./ReactionChips";

it("renders counts, ownership, text truncation, and the full who tooltip", async () => {
  render(() => (
    <ReactionChips
      reactions={[
        {
          text: "👍",
          actors: [
            { nick: "alice", mine: false },
            { nick: "weblounge", mine: true },
          ],
          mine: true,
        },
        {
          text: "ship it, ship it now",
          actors: [{ nick: "alice", mine: false }],
          mine: false,
        },
      ]}
    />
  ));

  const own = screen.getByLabelText("👍, 2 reactions, including you");
  expect(own).toHaveAttribute("data-reaction-own", "true");
  expect(own).toHaveTextContent("👍2");
  expect(
    screen.getByLabelText("ship it, ship it now, 1 reaction"),
  ).toHaveTextContent("ship it, ship it…1");

  fireEvent.mouseEnter(own);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "alice and you reacted with 👍",
  );
  expect(screen.getByText("alice and you", { exact: true }).tagName).toBe(
    "STRONG",
  );
});

it("renders received reactions as read-only labels without a toggle", () => {
  render(() => (
    <ReactionChips
      reactions={[
        { text: "👍", actors: [{ nick: "alice", mine: false }], mine: false },
      ]}
    />
  ));

  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByRole("img", { name: "👍, 1 reaction" })).toBeVisible();
});

it("toggles your reaction from a pressed chip", () => {
  const toggled: string[] = [];
  render(() => (
    <ReactionChips
      onToggle={(reaction) => toggled.push(reaction)}
      reactions={[
        {
          text: "👍",
          actors: [{ nick: "weblounge", mine: true }],
          mine: true,
        },
        { text: "🎉", actors: [{ nick: "alice", mine: false }], mine: false },
      ]}
    />
  ));

  const own = screen.getByRole("button", {
    name: "👍, 1 reaction, including you",
  });
  expect(own).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(own);
  fireEvent.click(screen.getByRole("button", { name: "🎉, 1 reaction" }));

  expect(toggled).toEqual(["👍", "🎉"]);
});

it("marks sending and failed own reactions and retries a failed one", async () => {
  const toggled: string[] = [];
  render(() => (
    <ReactionChips
      onToggle={(reaction) => toggled.push(reaction)}
      reactions={[
        {
          text: "🎉",
          actors: [{ nick: "weblounge", mine: true }],
          mine: true,
          own_delivery: "sending",
        },
        {
          text: "👍",
          actors: [{ nick: "weblounge", mine: true }],
          mine: true,
          own_delivery: "failed",
        },
      ]}
    />
  ));

  expect(
    screen.getByRole("button", {
      name: "🎉, 1 reaction, including you, sending",
    }),
  ).toHaveAttribute("data-reaction-delivery", "sending");
  const failed = screen.getByRole("button", {
    name: "Your 👍 reaction failed. Click to retry",
  });
  expect(failed).toHaveAttribute("data-reaction-delivery", "failed");
  expect(failed).toHaveTextContent("👍!");
  fireEvent.mouseEnter(failed);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Couldn’t react. Click to retry",
  );
  fireEvent.click(failed);

  expect(toggled).toEqual(["👍"]);
});
