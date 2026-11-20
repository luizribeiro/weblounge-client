import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import annotations from "../../assets/emoji-annotations.json";
import { ReactionPickerPanel } from "./ReactionPickerPanel";

const load = vi.hoisted(() => vi.fn());

vi.mock("./emoji-search", async (actual) => ({
  ...(await actual<typeof import("./emoji-search")>()),
  loadEmojiIndex: load,
}));

afterEach(() => {
  document.body.replaceChildren();
  load.mockReset();
});

function renderPanel() {
  render(() => (
    <ReactionPickerPanel mine={new Set()} nick="alice" onPick={() => {}} />
  ));
  return screen.getByPlaceholderText("Search emoji");
}

it("browses by glyph while the annotations load, then by name", async () => {
  const { buildEmojiIndex } =
    await vi.importActual<typeof import("./emoji-search")>("./emoji-search");
  let resolve = (_: ReturnType<typeof buildEmojiIndex>) => {};
  load.mockReturnValue(
    new Promise((settle) => {
      resolve = settle;
    }),
  );
  renderPanel();

  expect(screen.getByRole("button", { name: "👍" })).toBeVisible();
  resolve(buildEmojiIndex(annotations));
  expect(
    await screen.findByRole("button", { name: "thumbs up" }),
  ).toBeVisible();
});

it("says when search could not load and retries on the next input", async () => {
  const { buildEmojiIndex } =
    await vi.importActual<typeof import("./emoji-search")>("./emoji-search");
  load.mockRejectedValueOnce(new Error("chunk failed"));
  load.mockResolvedValueOnce(buildEmojiIndex(annotations));
  const search = renderPanel();

  fireEvent.input(search, { target: { value: "fire" } });
  expect(
    await screen.findByText("Emoji search didn’t load. Type again to retry."),
  ).toBeVisible();
  expect(screen.queryByText(/No emoji match/u)).toBeNull();

  fireEvent.input(search, { target: { value: "fire" } });
  expect(await screen.findByRole("button", { name: "fire" })).toBeVisible();
  expect(load).toHaveBeenCalledTimes(2);
});
