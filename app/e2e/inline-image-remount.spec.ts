import type { Page } from "@playwright/test";
import { E2E_FILEHOST_ORIGIN } from "../csp";
import { slotIn, withDirectPeer } from "./filehost-peer";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { expectSettled } from "./settled";

interface ImageMount {
  readonly opacity: string;
  readonly state: string;
  readonly width: number;
}

// wide.png is 8:1, so its slot stops at the 360px desktop cap, while the
// unloaded placeholder is 4:3 (320px at the 240px slot height).
const wideSlotWidth = 360;
const filler = "words that wrap across the transcript ".repeat(4);

test.describe("inline image remounts against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  test.use({ ignoreHTTPSErrors: true });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await recordImageMounts(page);
  });

  test("shows a seen image at once after switching away and scrolling back", async ({
    page,
    irc,
  }) => {
    await withDirectPeer(page, irc, "remount", async (peer, suffix) => {
      const image = `${E2E_FILEHOST_ORIGIN}/${suffix}/wide.png`;
      const fetches = countRequests(page, image);
      await peer.privmsgConfirmed(irc.account, `look ${image}`);
      const slot = slotIn(page, image);
      await expect(slot).toHaveAttribute("data-inline-image", "loaded");
      const firstMounts = (await imageMounts(page)).length;

      await page.getByRole("button", { name: irc.channel }).click();
      await expect(slot).toHaveCount(0);
      await page
        .getByRole("button", { name: new RegExp(`^${peer.nickname}`, "u") })
        .click();
      await expect(slot).toHaveAttribute("data-inline-image", "loaded");

      for (let index = 0; index < 30; index += 1)
        await peer.privmsgConfirmed(irc.account, `filler ${index} ${filler}`);
      await expect(slot).toHaveCount(0);
      await page.locator("[data-message-list]").hover();
      await expect
        .poll(async () => {
          await page.mouse.wheel(0, -300);
          return slot.count();
        })
        .toBe(1);

      const remounts = (await imageMounts(page)).slice(firstMounts);
      expect(remounts.length).toBeGreaterThanOrEqual(2);
      for (const mount of remounts) expectShownAtOnce(mount);
      expect(fetches()).toBe(1);
      await page.mouse.move(0, 0);
      await expectSettled(page);
      await nativeFeelAudit(page);
    });
  });

  test("shows a seen image at its size without fading in on a new page", async ({
    page,
    irc,
  }) => {
    await withDirectPeer(page, irc, "fresh", async (peer, suffix) => {
      const image = `${E2E_FILEHOST_ORIGIN}/${suffix}/wide.png`;
      await peer.privmsgConfirmed(irc.account, `look ${image}`);
      await expect(slotIn(page, image)).toHaveAttribute(
        "data-inline-image",
        "loaded",
      );

      const fresh = await page.context().newPage();
      await installNativeFeelInstrumentation(fresh);
      await fresh.goto(irc.url());
      await fresh
        .getByRole("button", { name: new RegExp(`^${peer.nickname}`, "u") })
        .click();
      await expect(slotIn(fresh, image)).toHaveAttribute(
        "data-inline-image",
        "loaded",
      );
      const [firstMount] = await imageMounts(fresh);
      if (firstMount === undefined) throw new Error("the image never mounted");
      expectShownAtOnce(firstMount);
      await expectSettled(fresh);
      await nativeFeelAudit(fresh);
    });
  });
});

function expectShownAtOnce(mount: ImageMount): void {
  expect(mount).toEqual({
    opacity: "1",
    state: "loaded",
    width: wideSlotWidth,
  });
}

function countRequests(page: Page, url: string): () => number {
  let count = 0;
  page.on("request", (request) => {
    if (request.url() === url) count += 1;
  });
  return () => count;
}

// Samples each slot as it is inserted, before the image has had a frame to
// load, so a slot that paints blank or fades in is caught.
async function recordImageMounts(page: Page): Promise<void> {
  await page.context().addInitScript(() => {
    const mounts: ImageMount[] = [];
    Reflect.set(window, "__imageMounts", mounts);
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          for (const slot of node.querySelectorAll("[data-inline-image]")) {
            const image = slot.querySelector("img");
            mounts.push({
              opacity: image === null ? "" : getComputedStyle(image).opacity,
              state: slot.getAttribute("data-inline-image") ?? "",
              width: Math.round(slot.getBoundingClientRect().width),
            });
          }
        }
    }).observe(document, { childList: true, subtree: true });
  });
}

function imageMounts(page: Page): Promise<ImageMount[]> {
  return page.evaluate(
    () => Reflect.get(window, "__imageMounts") as ImageMount[],
  );
}
