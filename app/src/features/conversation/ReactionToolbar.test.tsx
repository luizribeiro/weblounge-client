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
