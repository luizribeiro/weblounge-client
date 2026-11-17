import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import { nativeFeelAudit } from "./native-feel-audit";
import { expectSettled } from "./settled";
import {
  captureThemes,
  expectThumbnailLoaded,
  uploads,
  withDirectPeer,
} from "./upload-harness";

interface DraggedFile {
  readonly name: string;
  readonly type: string;
  readonly bytes: readonly number[];
  /** Pads the file with zeros to this many bytes. */
  readonly size?: number;
}

interface DraggedData {
  readonly files?: readonly DraggedFile[];
  readonly text?: string;
}

type DragType = "dragenter" | "dragover" | "dragleave" | "drop";

const landscape = fileURLToPath(
  new URL("./fixtures/filehost/landscape.png", import.meta.url),
);

test.describe("image drag and drop against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  test.use({ ignoreHTTPSErrors: true });

  test("hints while a PNG is dragged over the window and attaches it on drop", async ({
    page,
    irc,
    isMobile,
  }) => {
    test.skip(isMobile, "drag and drop is a desktop gesture");
    await page.setViewportSize({ width: 1280, height: 800 });
    const png = await pngFile();
    await withDirectPeer(page, irc, "drop", async (peer, composer) => {
      const overlay = page.locator("[data-drop-overlay]");
      expect(await drag(page, "dragenter", { files: [png] })).toBe(true);
      await expect(overlay).toBeVisible();
      await expect(overlay).toContainText("Drop an image to attach it");
      await captureThemes(page, "f9-overlay");
      await drag(page, "dragleave", { files: [png] });
      await expect(overlay).toHaveCount(0);

      await drag(page, "dragenter", { files: [png] });
      expect(await drag(page, "dragover", { files: [png] })).toBe(true);
      expect(await drag(page, "drop", { files: [png] })).toBe(true);
      await expect(overlay).toHaveCount(0);
      const chip = page.locator("[data-attachment-chip]");
      await expect(chip).toHaveAttribute("data-state", "ready");
      await expect(chip).toContainText("Image · 4 KB");
      await expectThumbnailLoaded(chip);
      await expect(composer).toHaveValue("");
      expect(await uploads(page.request, irc)).toEqual([]);
      await expectSettled(page, { conversation: peer.nickname });
      await nativeFeelAudit(page);
    });
  });

  test("explains a file that is not an image, too large, or one of several", async ({
    page,
    irc,
    isMobile,
  }) => {
    test.skip(isMobile, "drag and drop is a desktop gesture");
    await page.setViewportSize({ width: 1280, height: 800 });
    const png = await pngFile();
    await withDirectPeer(page, irc, "dropbad", async (peer, composer) => {
      const zip = { name: "archive.zip", type: "application/zip", bytes: [] };
      await drag(page, "dragenter", { files: [zip] });
      await drag(page, "drop", { files: [zip] });
      const dialog = await expectRefusal(
        page,
        "Can’t attach archive.zip",
        "Only images can be sent.",
      );
      await captureThemes(page, "f9-dialog");
      await dialog.getByRole("button", { name: "OK" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(composer).toBeFocused();

      const huge = { ...png, name: "huge.png", size: 50_000_001 };
      await drag(page, "drop", { files: [huge] });
      await dismiss(
        page,
        await expectRefusal(
          page,
          "Can’t attach huge.png",
          "Image is too large (max 50.0 MB).",
        ),
      );

      await drag(page, "drop", { files: [png, png] });
      await dismiss(
        page,
        await expectRefusal(
          page,
          "Can’t attach these files",
          "Drop one image at a time.",
        ),
      );
      await expect(page.locator("[data-attachment-chip]")).toHaveCount(0);
      await expect(page.locator("[data-drop-overlay]")).toHaveCount(0);
      await expectSettled(page, { conversation: peer.nickname });
      await nativeFeelAudit(page);
    });
  });

  test("leaves a text drop to the browser", async ({ page, irc, isMobile }) => {
    test.skip(isMobile, "drag and drop is a desktop gesture");
    await withDirectPeer(page, irc, "droptext", async (_peer, composer) => {
      const text = { text: "dragged words" };
      for (const type of ["dragenter", "dragover", "drop"] as const)
        expect(await drag(page, type, text)).toBe(false);
      await expect(page.locator("[data-drop-overlay]")).toHaveCount(0);
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(page.locator("[data-attachment-chip]")).toHaveCount(0);
      await expect(composer).toHaveValue("");
    });
  });
});

async function pngFile(): Promise<DraggedFile> {
  return {
    name: "landscape.png",
    type: "image/png",
    bytes: Array.from(await readFile(landscape)),
  };
}

/** Dispatches one drag event in the middle of the window and answers whether it was prevented. */
function drag(page: Page, type: DragType, data: DraggedData): Promise<boolean> {
  return page.evaluate(
    ({ type, data }) => {
      const transfer = new DataTransfer();
      for (const file of data.files ?? []) {
        const bytes = new Uint8Array(file.size ?? file.bytes.length);
        bytes.set(file.bytes);
        transfer.items.add(new File([bytes], file.name, { type: file.type }));
      }
      if (data.text !== undefined) transfer.setData("text/plain", data.text);
      const target =
        document.elementFromPoint(innerWidth / 2, innerHeight / 2) ??
        document.body;
      const event = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer: transfer,
      });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { type, data },
  );
}

async function expectRefusal(page: Page, title: string, explanation: string) {
  const dialog = page.getByRole("alertdialog", { name: title });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(explanation);
  await expect(dialog.getByRole("button", { name: "OK" })).toBeFocused();
  return dialog;
}

async function dismiss(
  page: Page,
  dialog: ReturnType<Page["getByRole"]>,
): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}
