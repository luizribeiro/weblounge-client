import { fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, expect, it } from "vitest";
import { ReactionPicker } from "./ReactionPicker";

afterEach(() => {
  document.body.replaceChildren();
});

function renderPicker(mine: ReadonlySet<string> = new Set()) {
  const invoker = document.createElement("button");
  document.body.append(invoker);
  const picked: string[] = [];
  let closed = 0;
  render(() => (
    <ReactionPicker
      invoker={invoker}
      mine={mine}
      nick="alice"
      onClose={() => {
        closed += 1;
      }}
      onPick={(reaction) => picked.push(reaction)}
    />
  ));
  return { invoker, picked, closed: () => closed };
}

it("opens with focus in the search field and every category", async () => {
  renderPicker();

  const dialog = screen.getByRole("dialog", { name: "Add reaction" });
  expect(dialog).toHaveTextContent("React to alice");
  expect(screen.getByPlaceholderText("Search emoji")).toHaveFocus();
  expect(
    (await screen.findAllByRole("region")).map((region) =>
      region.getAttribute("aria-label"),
    ),
  ).toEqual([
    "Frequent",
    "Smileys",
    "People",
    "Nature",
    "Food",
    "Objects",
    "Symbols",
  ]);
});

it("lists matches by rank and says when nothing matches", async () => {
  renderPicker();
  const search = screen.getByPlaceholderText("Search emoji");

  fireEvent.input(search, { target: { value: "rocket" } });
  const results = await screen.findByRole("region", { name: "Results" });
  expect(
    within(results)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["🚀", "🧑‍🚀", "👨‍🚀", "👩‍🚀"]);

  fireEvent.input(search, { target: { value: "zebra-unicorn" } });
  expect(screen.getByText("No emoji match “zebra-unicorn”.")).toBeVisible();
});

it("picks a new emoji and returns focus to the add button", async () => {
  const { invoker, picked, closed } = renderPicker();

  fireEvent.click(await screen.findByRole("button", { name: "party popper" }));

  expect(picked).toEqual(["🎉"]);
  expect(closed()).toBe(1);
  expect(invoker).toHaveFocus();
});

it("does not remove a reaction you already gave when picked again", async () => {
  const { picked, closed } = renderPicker(new Set(["👍"]));
  const thumbs = await screen.findByRole("button", { name: "thumbs up" });

  expect(thumbs).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(thumbs);

  expect(picked).toEqual([]);
  expect(closed()).toBe(1);
});

it("closes on Escape and on a click outside", () => {
  const { invoker, closed } = renderPicker();

  fireEvent.keyDown(screen.getByPlaceholderText("Search emoji"), {
    key: "Escape",
  });
  expect(invoker).toHaveFocus();
  fireEvent.pointerDown(document.body);

  expect(closed()).toBe(2);
});
