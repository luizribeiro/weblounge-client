import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { E2E_FILEHOST_ORIGIN } from "../csp";
import { expect, test } from "./irc-fixture";
import { nativeFeelAudit } from "./native-feel-audit";
import {
  approveUpload,
  captureThemes,
  expectThumbnailLoaded,
  uploads,
  withDirectPeer,
} from "./upload-harness";

const landscape = fileURLToPath(
  new URL("./fixtures/filehost/landscape.png", import.meta.url),
);

test.describe("/file against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  test.use({ ignoreHTTPSErrors: true });

  test.afterEach(async ({ irc }) => irc.forwarder.clearTextRewrites());

  test("suggests /file, picks an image and sends it on Enter", async ({
    page,
    irc,
    isMobile,
  }) => {
    test.skip(isMobile, "the phone layout has its own test");
    await page.setViewportSize({ width: 1280, height: 800 });
    await withDirectPeer(page, irc, "file", async (peer, composer) => {
      await composer.pressSequentially("/fi");
      await expectFileSuggested(page);
      await captureThemes(page, "file-desktop-suggestions");

      await countFilePickerClicks(page);
      await composer.fill("/file");
      const chooser = page.waitForEvent("filechooser");
      await composer.press("Enter");
      const picker = await chooser;
      expect(picker.isMultiple()).toBe(false);
      expect(await filePickerClicks(page)).toBe(1);
      await expect(composer).toHaveValue("");
      await picker.setFiles(landscape);
      const chip = await expectPickedChip(page);
      await expect(composer).toBeFocused();
      expect(await uploads(page.request, irc)).toEqual([]);
      await captureThemes(page, "file-desktop-chip");

      await composer.fill("from disk");
      await composer.press("Enter");
      await approveUpload(page);
      await expectSentInline(
        page,
        await peer.waitForPrivmsg(
          peer.nickname,
          `from disk ${E2E_FILEHOST_ORIGIN}/`,
          irc.account,
        ),
      );
      await expect(chip).toHaveCount(0);
      const [upload] = await uploads(page.request, irc);
      expect(upload?.contentType).toBe("image/png");
      expect(upload?.disposition).toBe(
        "inline; filename*=UTF-8''landscape.png",
      );
      await nativeFeelAudit(page);
    });
  });

  test("cancelling the picker leaves an empty composer", async ({
    page,
    irc,
    isMobile,
  }) => {
    test.skip(isMobile, "covered on desktop");
    await withDirectPeer(page, irc, "filecancel", async (_peer, composer) => {
      await composer.fill("/file");
      const chooser = page.waitForEvent("filechooser");
      await composer.press("Enter");
      await (await chooser).setFiles([]);
      await expect(composer).toHaveValue("");
      await expect(page.locator("[data-attachment-chip]")).toHaveCount(0);
      expect(await uploads(page.request, irc)).toEqual([]);

      await composer.fill("/file");
      const again = page.waitForEvent("filechooser");
      await composer.press("Enter");
      await (await again).setFiles(landscape);
      await expectPickedChip(page);
    });
  });

  test("notes that a network without a file host takes no uploads", async ({
    page,
    irc,
    isMobile,
  }) => {
    test.skip(isMobile, "covered on desktop");
    await irc.forwarder.rewriteIncomingText(
      "draft/FILEHOST=",
      "draft/XILEHOST=",
    );
    await withDirectPeer(page, irc, "filenohost", async (_peer, composer) => {
      await countFilePickerClicks(page);
      await composer.fill("/file");
      await composer.press("Enter");
      await expect(
        page.getByText("This network doesn’t accept uploads."),
      ).toBeVisible();
      await expect(composer).toHaveValue("");
      await expect(page.locator("[data-attachment-chip]")).toHaveCount(0);
      expect(await filePickerClicks(page)).toBe(0);
    });
  });

  test("picks an image from the phone's Send button", async ({
    page,
    irc,
    isMobile,
  }) => {
    test.skip(!isMobile, "phone layout");
    await withDirectPeer(page, irc, "filephone", async (peer, composer) => {
      await composer.tap();
      await composer.pressSequentially("/fi");
      await expectFileSuggested(page);
      await captureThemes(page, "file-phone-suggestions");

      await composer.fill("/file");
      const send = page.locator("[data-composer-send]").first();
      const chooser = page.waitForEvent("filechooser");
      await send.tap();
      await (await chooser).setFiles(landscape);
      await expectPickedChip(page);
      await captureThemes(page, "file-phone-chip");

      await composer.fill("from my photos");
      await send.tap();
      await approveUpload(page);
      await expectSentInline(
        page,
        await peer.waitForPrivmsg(
          peer.nickname,
          `from my photos ${E2E_FILEHOST_ORIGIN}/`,
          irc.account,
        ),
      );
      await expect(page.locator("[data-attachment-chip]")).toHaveCount(0);
      const [upload] = await uploads(page.request, irc);
      expect(upload?.contentType).toBe("image/png");
      await nativeFeelAudit(page);
    });
  });
});

// The image must finish loading before the native-feel audit's idle window.
async function expectSentInline(page: Page, received: string): Promise<void> {
  const url = /(https:\/\/\S+)/u.exec(received)?.[1];
  if (url === undefined) throw new Error(`no URL in ${received}`);
  await expect(
    page
      .locator("[data-message-row]")
      .filter({ hasText: url })
      .locator("[data-inline-image]"),
  ).toHaveAttribute("data-inline-image", "loaded");
}

// The picker opens synchronously inside the key press, so the count is final once the note shows.
async function countFilePickerClicks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const click = HTMLInputElement.prototype.click;
    Reflect.set(window, "__filePickerClicks", 0);
    HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
      if (this.type === "file")
        Reflect.set(
          window,
          "__filePickerClicks",
          Number(Reflect.get(window, "__filePickerClicks")) + 1,
        );
      click.call(this);
    };
  });
}

function filePickerClicks(page: Page): Promise<number> {
  return page.evaluate(() => Number(Reflect.get(window, "__filePickerClicks")));
}

async function expectFileSuggested(page: Page): Promise<void> {
  await expect(
    page.getByRole("option", { name: /\/file.*Upload an image/u }),
  ).toBeVisible();
}

async function expectPickedChip(page: Page): Promise<Locator> {
  const chip = page.locator("[data-attachment-chip]");
  await expect(chip).toHaveAttribute("data-state", "ready");
  await expect(chip).toContainText("Image · 4 KB");
  await expectThumbnailLoaded(chip);
  return chip;
}
