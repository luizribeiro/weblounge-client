import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { InlineImage } from "./InlineImage";

function renderImage(url: string, onOpenExternal?: (href: string) => void) {
  return render(() => (
    <InlineImage
      author="alice"
      onOpenExternal={onOpenExternal}
      presentation="desktop"
      url={url}
    />
  ));
}

function slotFor(url: string, onOpenExternal?: (href: string) => void) {
  renderImage(url, onOpenExternal);
  return screen.getByRole("link", {
    name: "Open image from alice on files.example.test",
  });
}

function loadNaturalSize(slot: HTMLElement, width: number, height: number) {
  const image = slot.querySelector("img") as HTMLImageElement;
  Object.defineProperty(image, "naturalWidth", { value: width });
  Object.defineProperty(image, "naturalHeight", { value: height });
  fireEvent.load(image);
  return image;
}

it("reserves a non-draggable link slot before the image loads", () => {
  const url = "https://files.example.test/loading.png";
  const slot = slotFor(url);

  expect(slot).toHaveAttribute("href", url);
  expect(slot).toHaveAttribute("data-inline-image", "loading");
  expect(slot).toHaveAttribute("draggable", "false");
  const image = slot.querySelector("img");
  expect(image).toHaveAttribute("src", url);
  expect(image).toHaveAttribute("loading", "lazy");
  expect(image).toHaveAttribute("draggable", "false");
  expect(slot.style.getPropertyValue("--wl-inline-image-aspect")).toBe("");
});

it("follows the loaded image's aspect and keeps it across remounts", () => {
  const url = "https://files.example.test/wide.png";
  const first = renderImage(url);
  const slot = screen.getByRole("link");
  const image = loadNaturalSize(slot, 1600, 200);

  expect(slot).toHaveAttribute("data-inline-image", "loaded");
  expect(slot.style.getPropertyValue("--wl-inline-image-aspect")).toBe("8");
  expect(image).toHaveAttribute("data-loaded", "true");

  first.unmount();
  const remounted = slotFor(url);
  expect(remounted).toHaveAttribute("data-inline-image", "loaded");
  expect(remounted.style.getPropertyValue("--wl-inline-image-aspect")).toBe(
    "8",
  );
});

it("treats an image without a natural size as a failure", () => {
  const slot = slotFor("https://files.example.test/empty.png");

  loadNaturalSize(slot, 0, 0);

  expect(slot).toHaveAttribute("data-inline-image", "failed");
});

it("keeps the slot as an error tile that still opens the link", () => {
  const open = vi.fn();
  const url = "https://files.example.test/missing.png";
  const slot = slotFor(url, open);

  fireEvent.error(slot.querySelector("img") as HTMLImageElement);

  expect(slot).toHaveAttribute("data-inline-image", "failed");
  expect(slot.querySelector("img")).toBeNull();
  expect(slot).toHaveTextContent("Couldn’t load image · Open link");
  fireEvent.click(slot);
  expect(open).toHaveBeenCalledWith(url);
});
