import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import {
  closeImageViewer,
  currentImageViewerRequest,
} from "../image-viewer/image-viewer-request";
import { InlineImage } from "./InlineImage";

const sentAt = Date.UTC(2026, 10, 13, 22, 1);

afterEach(() => {
  closeImageViewer();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderImage(url: string, onOpenExternal?: (href: string) => void) {
  return render(() => (
    <InlineImage
      author="alice"
      onOpenExternal={onOpenExternal}
      presentation="desktop"
      time={sentAt}
      url={url}
    />
  ));
}

function slotFor(url: string, onOpenExternal?: (href: string) => void) {
  renderImage(url, onOpenExternal);
  return screen.getByRole("link");
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

  expect(slot).toHaveAccessibleName(
    "Open image from alice on files.example.test",
  );
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

it.each([
  ["animates a GIF without reduced motion", false, "animated.gif", "img"],
  ["stills a GIF under reduced motion", true, "still.gif", "canvas"],
  ["keeps a PNG under reduced motion", true, "photo.png", "img"],
])("%s", (_label, reduced, name, element) => {
  const drawImage = vi.fn();
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: reduced && query === "(prefers-reduced-motion: reduce)",
      }) as MediaQueryList,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  const slot = slotFor(`https://files.example.test/${name}`);

  const image = loadNaturalSize(slot, 160, 120);

  expect(slot.querySelector("img, canvas")?.localName).toBe(element);
  expect(slot.style.getPropertyValue("--wl-inline-image-aspect")).toBe(
    String(160 / 120),
  );
  if (element === "canvas") expect(drawImage).toHaveBeenCalledWith(image, 0, 0);
});

it("keeps a remounted GIF hidden until its still frame replaces it", () => {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query === "(prefers-reduced-motion: reduce)",
      }) as MediaQueryList,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  const url = "https://files.example.test/remounted.gif";
  const first = renderImage(url);
  loadNaturalSize(screen.getByRole("link"), 160, 120);
  first.unmount();

  const slot = slotFor(url);

  expect(slot.querySelector("img")).not.toHaveAttribute("data-loaded", "true");
  expect(slot.style.getPropertyValue("--wl-inline-image-aspect")).toBe(
    String(160 / 120),
  );
  loadNaturalSize(slot, 160, 120);
  expect(slot.querySelector("canvas")).not.toBeNull();
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

it("opens the viewer from a loaded image with its size, sender and time", () => {
  const url = "https://files.example.test/viewer.png";
  const slot = slotFor(url);
  expect(slot).toHaveAccessibleName(
    "Open image from alice on files.example.test",
  );
  fireEvent.click(slot);
  expect(currentImageViewerRequest()).toBeUndefined();

  loadNaturalSize(slot, 640, 480);
  expect(slot).toHaveAccessibleName("Image from alice, open viewer");
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  slot.dispatchEvent(click);

  expect(click.defaultPrevented).toBe(true);
  expect(currentImageViewerRequest()).toEqual({
    author: "alice",
    naturalHeight: 480,
    naturalWidth: 640,
    origin: slot,
    time: sentAt,
    url,
  });
});

it("opens the viewer with Space on the focused image", () => {
  const slot = slotFor("https://files.example.test/keyboard.png");
  loadNaturalSize(slot, 640, 480);
  slot.focus();
  const space = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: " ",
  });
  slot.dispatchEvent(space);

  expect(space.defaultPrevented).toBe(true);
  expect(currentImageViewerRequest()?.origin).toBe(slot);
});

it("leaves a modified click to the browser's new-tab behaviour", () => {
  const slot = slotFor("https://files.example.test/modified.png");
  loadNaturalSize(slot, 640, 480);
  const click = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    metaKey: true,
  });
  slot.dispatchEvent(click);

  expect(click.defaultPrevented).toBe(false);
  expect(currentImageViewerRequest()).toBeUndefined();
});

it("keeps a failed image a link", () => {
  const slot = slotFor("https://files.example.test/missing-viewer.png");
  fireEvent.error(slot.querySelector("img") as HTMLImageElement);
  fireEvent.click(slot);
  fireEvent.keyDown(slot, { key: " " });

  expect(currentImageViewerRequest()).toBeUndefined();
});

it("hands a modified click on a viewable image to the external opener", () => {
  const open = vi.fn();
  const url = "https://files.example.test/external.png";
  const slot = slotFor(url, open);
  loadNaturalSize(slot, 640, 480);
  const click = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    metaKey: true,
  });
  slot.dispatchEvent(click);

  expect(click.defaultPrevented).toBe(true);
  expect(open).toHaveBeenCalledWith(url);
  expect(currentImageViewerRequest()).toBeUndefined();
});
