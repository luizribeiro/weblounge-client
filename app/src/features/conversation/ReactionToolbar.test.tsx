import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it } from "vitest";
import { ReactionToolbar } from "./ReactionToolbar";

it("offers the quick reactions and marks the ones that are yours", () => {
  const reacted: string[] = [];
  render(() => (
    <ReactionToolbar
      mine={new Set(["❤️"])}
      onReact={(reaction) => reacted.push(reaction)}
    />
  ));

  const toolbar = screen.getByRole("toolbar", { name: "Message actions" });
  expect(toolbar).toHaveTextContent("👍❤️😂");
  fireEvent.click(screen.getByRole("button", { name: "React with 👍" }));
  const heart = screen.getByRole("button", { name: "React with ❤️" });
  expect(heart).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(heart);

  expect(reacted).toEqual(["👍", "❤️"]);
  expect(screen.queryByRole("button", { name: "Add reaction" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
});

it("opens the picker from its own button", () => {
  const invokers: HTMLElement[] = [];
  render(() => (
    <ReactionToolbar
      mine={new Set()}
      onOpenPicker={(invoker) => invokers.push(invoker)}
      onReact={() => undefined}
    />
  ));

  const add = screen.getByRole("button", { name: "Add reaction" });
  fireEvent.click(add);

  expect(invokers).toEqual([add]);
});

it("starts a reply from its own button, beside the reactions", () => {
  let replies = 0;
  render(() => (
    <ReactionToolbar
      mine={new Set()}
      onOpenPicker={() => undefined}
      onReact={() => undefined}
      onReply={() => {
        replies += 1;
      }}
    />
  ));

  const buttons = screen.getAllByRole("button");
  const reply = screen.getByRole("button", { name: "Reply" });
  expect(buttons.indexOf(reply)).toBe(
    buttons.indexOf(screen.getByRole("button", { name: "Add reaction" })) + 1,
  );
  fireEvent.click(reply);

  expect(replies).toBe(1);
});

it("offers Reply alone on a network that cannot react", () => {
  render(() => <ReactionToolbar mine={new Set()} onReply={() => undefined} />);

  expect(
    screen.getAllByRole("button").map((button) => button.ariaLabel),
  ).toEqual(["Reply"]);
});
