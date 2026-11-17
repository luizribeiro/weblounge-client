import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import type { ImageRejection } from "./attachable-image";
import { ImageDropZone } from "./ImageDropZone";
import { createDropTargets, type DropAvailability } from "./image-drop";

const photo = new File([new Uint8Array([0x89, 0x50])], "photo.png", {
  type: "image/png",
});

function drag(
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  data: { types: readonly string[]; files?: readonly File[] } = {
    types: ["Files"],
    files: [photo],
  },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const dataTransfer = { dropEffect: "none", ...data, files: data.files ?? [] };
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  window.dispatchEvent(event);
  return { event, dataTransfer };
}

function renderZone(
  availability: DropAvailability = "ready",
  rejection?: ImageRejection,
) {
  const targets = createDropTargets();
  const target = {
    availability: () => availability,
    attach: vi.fn(async (_file: File) => rejection),
    focus: vi.fn(),
  };
  targets.register(target);
  render(() => <ImageDropZone targets={targets} />);
  return target;
}

const overlay = () => document.querySelector("[data-drop-overlay]");

it("hints while files are over the window, through child enter and leave", () => {
  renderZone();
  expect(drag("dragenter").event.defaultPrevented).toBe(true);
  expect(overlay()).not.toBeNull();
  drag("dragenter");
  drag("dragleave");
  expect(overlay()).not.toBeNull();
  const { event, dataTransfer } = drag("dragover");
  expect(event.defaultPrevented).toBe(true);
  expect(dataTransfer.dropEffect).toBe("copy");
  drag("dragleave");
  expect(overlay()).toBeNull();
});

it("clears the hint on drop and when the window loses focus", () => {
  renderZone();
  drag("dragenter");
  drag("drop");
  expect(overlay()).toBeNull();
  drag("dragenter");
  fireEvent.blur(window);
  expect(overlay()).toBeNull();
});

it("attaches a dropped image without the browser opening it", async () => {
  const target = renderZone();
  drag("dragenter");
  expect(drag("drop").event.defaultPrevented).toBe(true);
  await waitFor(() => expect(target.attach).toHaveBeenCalledWith(photo));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("leaves text and other non-file drags to the browser", () => {
  const target = renderZone();
  const text = { types: ["text/plain"] };
  for (const type of ["dragenter", "dragover", "drop"] as const)
    expect(drag(type, text).event.defaultPrevented).toBe(false);
  expect(overlay()).toBeNull();
  expect(target.attach).not.toHaveBeenCalled();
});

it("explains a refused drop and returns focus to the composer on OK", async () => {
  const target = renderZone("ready", "not_image");
  drag("drop", { types: ["Files"], files: [new File(["PK"], "archive.zip")] });
  const dialog = await screen.findByRole("alertdialog", {
    name: "Can’t attach archive.zip",
  });
  expect(dialog.textContent).toContain("Only images can be sent.");
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(target.focus).toHaveBeenCalledOnce();
});

it.each([
  [
    "several",
    [photo, photo],
    "Can’t attach these files",
    "Drop one image at a time.",
  ],
  [
    "closed",
    [photo],
    "Can’t attach photo.png",
    "You can’t send messages here.",
  ],
  [
    "unavailable",
    [photo],
    "Can’t attach photo.png",
    "This network doesn’t accept uploads.",
  ],
] as const)(
  "explains a %s drop",
  async (availability, files, title, explanation) => {
    renderZone(availability === "several" ? "ready" : availability);
    drag("drop", { types: ["Files"], files });
    const dialog = await screen.findByRole("alertdialog", { name: title });
    expect(dialog.textContent).toContain(explanation);
  },
);

it("explains a drop with no conversation open", async () => {
  render(() => <ImageDropZone targets={createDropTargets()} />);
  drag("drop");
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog.textContent).toContain(
    "Open a channel or direct message first.",
  );
});

it("ignores a drop behind a modal dialog but still keeps the browser from opening it", async () => {
  const target = renderZone("ready", "not_image");
  drag("drop", { types: ["Files"], files: [new File(["PK"], "a.zip")] });
  await screen.findByRole("alertdialog");
  drag("dragenter");
  expect(overlay()).toBeNull();
  expect(drag("dragover").dataTransfer.dropEffect).toBe("none");
  expect(drag("drop").event.defaultPrevented).toBe(true);
  expect(target.attach).toHaveBeenCalledOnce();
});
