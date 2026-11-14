import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import ImageViewer from "./ImageViewer";
import { openPhotoSwipe } from "./photoswipe-viewer";

vi.mock("./photoswipe-viewer", () => ({ openPhotoSwipe: vi.fn() }));

const viewer = { close: vi.fn(), destroy: vi.fn(), run: vi.fn() };

beforeEach(() => {
  vi.mocked(openPhotoSwipe).mockReset().mockReturnValue(viewer);
  viewer.close.mockReset();
  viewer.destroy.mockReset();
  viewer.run.mockReset();
});

function renderViewer() {
  const [open, setOpen] = createSignal(false);
  let invoker: HTMLButtonElement | undefined;
  render(() => (
    <>
      <main>
        <button
          onClick={() => setOpen(true)}
          ref={(element) => {
            invoker = element;
          }}
          type="button"
        >
          Image from alice, open viewer
        </button>
      </main>
      <Show when={open()}>
        <ImageViewer
          onClosed={() => setOpen(false)}
          request={{
            author: "alice",
            naturalHeight: 480,
            naturalWidth: 640,
            origin: invoker as HTMLButtonElement,
            time: Date.UTC(2026, 10, 13, 22, 1),
            url: "https://files.example.test/shot.png",
          }}
        />
      </Show>
    </>
  ));
  const origin = screen.getByRole("button", {
    name: "Image from alice, open viewer",
  });
  origin.focus();
  fireEvent.click(origin);
  return { origin, setOpen };
}

it("opens a labelled modal with the sender, original link and status", () => {
  renderViewer();
  const dialog = screen.getByRole("dialog", { name: "Image from alice" });

  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(dialog).toHaveFocus();
  expect(dialog).toHaveTextContent("alice");
  expect(screen.getByRole("link", { name: "Open original" })).toHaveAttribute(
    "href",
    "https://files.example.test/shot.png",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Image from alice. Press Escape to close.",
  );
  expect(document.querySelector("main")?.inert).toBe(true);
  expect(vi.mocked(openPhotoSwipe).mock.calls[0]?.[0].image.url).toBe(
    "https://files.example.test/shot.png",
  );
});

it("owns every key while open, even when focus has left the dialog", () => {
  renderViewer();
  const reached = vi.fn();
  document.addEventListener("keydown", reached);
  onTestFinished(() => document.removeEventListener("keydown", reached));
  const dialog = screen.getByRole("dialog");

  fireEvent.keyDown(dialog, { key: "+" });
  fireEvent.keyDown(document.body, { key: "Escape" });
  fireEvent.keyDown(dialog, { key: "a" });

  expect(viewer.run).toHaveBeenNthCalledWith(1, {
    kind: "zoom",
    direction: "in",
  });
  expect(viewer.run).toHaveBeenNthCalledWith(2, { kind: "close" });
  expect(reached).not.toHaveBeenCalled();
});

it("closes from its button and restores the app and the invoker's focus", async () => {
  const { origin } = renderViewer();
  fireEvent.click(screen.getByRole("button", { name: "Close image" }));
  expect(viewer.close).toHaveBeenCalled();

  const { onDestroyed } = vi.mocked(openPhotoSwipe).mock.calls[0]?.[0] ?? {};
  onDestroyed?.();

  await waitFor(() => expect(origin).toHaveFocus());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(document.querySelector("main")?.inert).toBe(false);
  expect(viewer.destroy).toHaveBeenCalled();
});

it("destroys PhotoSwipe and releases the app when unmounted while open", () => {
  const { setOpen } = renderViewer();
  setOpen(false);

  expect(viewer.destroy).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(document.querySelector("main")?.inert).toBe(false);
  const reached = vi.fn();
  document.addEventListener("keydown", reached);
  onTestFinished(() => document.removeEventListener("keydown", reached));
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(reached).toHaveBeenCalled();
});
