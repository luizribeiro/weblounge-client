import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { settledScreenshot } from "./filehost-peer";
import { messageId } from "./irc-client";
import { expect, test } from "./irc-fixture";
import { productionMessageRow } from "./production-ergo";
import { expectConfirmedOwn } from "./reaction-chip";

const screenshots = path.join(process.cwd(), "e2e", "screenshots", "reactions");
const themes = { light: "lounge", dark: "lounge-night" } as const;

test("captures the reaction toolbar, picker and chip states in both Lounge themes", async ({
  page,
  irc,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const text = "the relay never sees plaintext, it only forwards ciphertext";
  const bot = await irc.peer("bruno");
  await page.goto(irc.url());
  await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);
  await bot.privmsgConfirmed(
    irc.channel,
    "pushed the relay fix, try it on iOS",
  );
  const id = messageId(await bot.privmsgConfirmed(irc.channel, text));
  await bot.privmsgConfirmed(
    irc.channel,
    "notification arrived with the phone locked",
  );
  await bot.reactionConfirmed(irc.channel, id, "👍");
  const row = productionMessageRow(page, text);
  const chip = (reaction: string) =>
    row.locator(`[data-reaction="${reaction}"]`);

  await chip("👍").click();
  await bot.waitForReaction(irc.channel, id, "👍", irc.account);
  await expectConfirmedOwn(chip("👍"), "2");

  await bot.mode(irc.channel, "+m");
  await row.hover();
  await row.getByRole("button", { name: "React with ❤️" }).click();
  await expect(chip("❤️")).toHaveAttribute("data-reaction-delivery", "failed");
  await bot.mode(irc.channel, "-m");

  await irc.forwarder.pauseIncoming();
  try {
    await row.getByRole("button", { name: "React with 😂" }).click();
    await expect(chip("😂")).toHaveAttribute(
      "data-reaction-delivery",
      "sending",
    );
    await row.hover();
    await expect(row.getByRole("toolbar")).toBeVisible();
    await captureThemes(page, "toolbar-and-chips", () => around(row));

    await row.getByRole("button", { name: "Add reaction" }).click();
    const picker = page.getByRole("dialog", { name: "Add reaction" });
    await expect(picker).toBeVisible();
    await captureThemes(page, "picker", () => around(row, picker));
  } finally {
    await irc.forwarder.resumeIncoming();
  }
});

async function captureThemes(
  page: Page,
  name: string,
  region: () => Promise<Clip>,
): Promise<void> {
  for (const [scheme, theme] of Object.entries(themes) as [
    keyof typeof themes,
    string,
  ][]) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await settledScreenshot(page, screenshots, `${name}-${theme}`);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({
      clip: await region(),
      path: path.join(screenshots, `${name}-${theme}-detail.png`),
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

interface Clip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function around(...targets: Locator[]): Promise<Clip> {
  const boxes = await Promise.all(
    targets.map(async (target) => {
      const box = await target.boundingBox();
      if (box === null) throw new Error("screenshot target is not visible");
      return box;
    }),
  );
  const margin = 28;
  const left = Math.max(0, Math.min(...boxes.map((box) => box.x)) - margin);
  const top = Math.max(0, Math.min(...boxes.map((box) => box.y)) - margin);
  const right = Math.max(...boxes.map((box) => box.x + box.width)) + margin;
  const bottom = Math.max(...boxes.map((box) => box.y + box.height)) + margin;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
