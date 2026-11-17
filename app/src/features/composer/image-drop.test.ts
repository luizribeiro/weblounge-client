import { describe, expect, it, vi } from "vitest";
import type { ImageRejection } from "./attachable-image";
import {
  createDropTargets,
  type DropAvailability,
  dropFiles,
  type ImageDropTarget,
  shortFileName,
} from "./image-drop";

function target(
  availability: DropAvailability = "ready",
  rejection?: ImageRejection,
) {
  return {
    availability: () => availability,
    attach: vi.fn(async (_file: File) => rejection),
    focus: vi.fn(),
  } satisfies ImageDropTarget;
}

const photo = new File([new Uint8Array([0x89, 0x50])], "photo.png", {
  type: "image/png",
});
const archive = new File(["PK"], "archive.zip", { type: "application/zip" });

describe("createDropTargets", () => {
  it("sends drops to the latest composer, or the one focused since", () => {
    const targets = createDropTargets();
    const first = target();
    const second = target();
    expect(targets.front()).toBeUndefined();
    const firstRegistration = targets.register(first);
    const secondRegistration = targets.register(second);
    expect(targets.front()).toBe(second);
    firstRegistration.raise();
    expect(targets.front()).toBe(first);
    firstRegistration.unregister();
    expect(targets.front()).toBe(second);
    firstRegistration.raise();
    expect(targets.front()).toBe(second);
    secondRegistration.unregister();
    expect(targets.front()).toBeUndefined();
  });

  it("moves a composer registered again to the front, and its old handle with it", () => {
    const targets = createDropTargets();
    const first = target();
    const stale = targets.register(first);
    targets.register(target());
    targets.register(first);
    expect(targets.front()).toBe(first);
    stale.unregister();
    expect(targets.front()).not.toBe(first);
  });
});

describe("dropFiles", () => {
  it("attaches a single image to a ready composer", async () => {
    const composer = target();
    await expect(dropFiles([photo], composer)).resolves.toBeUndefined();
    expect(composer.attach).toHaveBeenCalledWith(photo);
  });

  it("passes on the attach check's rejection with the file's name", async () => {
    const composer = target("ready", "not_image");
    await expect(dropFiles([archive], composer)).resolves.toEqual({
      reason: "not_image",
      name: "archive.zip",
    });
  });

  it("refuses several files without attaching any", async () => {
    const composer = target();
    await expect(dropFiles([photo, archive], composer)).resolves.toEqual({
      reason: "several",
    });
    expect(composer.attach).not.toHaveBeenCalled();
  });

  it("refuses when no conversation is open", async () => {
    await expect(dropFiles([photo], undefined)).resolves.toEqual({
      reason: "no_conversation",
      name: "photo.png",
    });
  });

  it.each(["unavailable", "closed"] as const)(
    "refuses a composer that is %s",
    async (availability) => {
      const composer = target(availability);
      await expect(dropFiles([photo], composer)).resolves.toEqual({
        reason: availability,
        name: "photo.png",
      });
      expect(composer.attach).not.toHaveBeenCalled();
    },
  );

  it("ignores a drop that carried no file", async () => {
    const composer = target();
    await expect(dropFiles([], composer)).resolves.toBeUndefined();
    expect(composer.attach).not.toHaveBeenCalled();
  });
});

describe("shortFileName", () => {
  it("keeps a name of up to 40 characters whole", () => {
    const name = `${"x".repeat(36)}.png`;
    expect(shortFileName(name)).toBe(name);
  });

  it("counts characters, not code units, and keeps an emoji extension whole", () => {
    const short = shortFileName(`${"📸".repeat(45)}.🖼️`);
    expect(Array.from(short)).toHaveLength(40);
    expect(short.endsWith(".🖼️")).toBe(true);
  });

  it("shortens a long name without an extension", () => {
    const short = shortFileName("a".repeat(30) + "b".repeat(30));
    expect(short).toBe(`${"a".repeat(20)}…${"b".repeat(19)}`);
  });

  it("shortens a long name in the middle and keeps its extension", () => {
    const name = `${"holiday-".repeat(10)}final.jpeg`;
    const short = shortFileName(name);
    expect(Array.from(short)).toHaveLength(40);
    expect(short.startsWith("holiday-holiday-")).toBe(true);
    expect(short).toContain("…");
    expect(short.endsWith("final.jpeg")).toBe(true);
  });

  it("does not take a long tail for an extension", () => {
    const short = shortFileName(`report.${"x".repeat(60)}`);
    expect(Array.from(short)).toHaveLength(40);
    expect(short.startsWith("report.")).toBe(true);
  });
});
