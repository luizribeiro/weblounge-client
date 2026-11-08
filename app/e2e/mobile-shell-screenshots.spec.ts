import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { screenshotWithInter } from "./inter-font";
import { IrcClient } from "./irc-client";

const screenshotDirectory = path.join(process.cwd(), "e2e", "screenshots");

test.use({
  colorScheme: "light",
  hasTouch: true,
  isMobile: true,
  viewport: { width: 402, height: 874 },
});

test.describe("mobile shell screenshots against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("captures the chats list and pushed conversation", async ({ page }) => {
    await page.goto("/?irc-password=weblounge-test");
    await expect(
      page.getByRole("button", { name: "#weblounge-test" }),
    ).toBeVisible();
    const bots: IrcClient[] = [];
    try {
      for (const nick of ["ana-mobile", "tomo-mobile", "mel-mobile"]) {
        bots.push(
          await IrcClient.connect(
            nick,
            "weblounge-bot",
            "weblounge-bot-test",
            "#weblounge-test",
          ),
        );
      }
      await bots[0]?.privmsgConfirmed(
        "#weblounge-test",
        "The garden is looking especially cozy today",
      );
      await bots[1]?.actionConfirmed(
        "#weblounge-test",
        "puts a fresh pot of coffee on",
      );
      await bots[2]?.privmsgConfirmed(
        "#weblounge-test",
        "weblounge: Mobile history is ready for the lounge",
      );
      await bots[0]?.privmsgConfirmed(
        "weblounge",
        "Are you joining the garden chat later?",
      );
      await bots[1]?.privmsgConfirmed(
        "weblounge",
        "I saved you the window seat",
      );
      await bots[2]?.privmsgConfirmed(
        "weblounge",
        "The mobile shell feels delightfully calm",
      );

      await expect(
        page.getByRole("button", { name: "mel-mobile" }),
      ).toContainText("delightfully calm");
      const avatarPresentation = await page
        .getByRole("button", { name: "mel-mobile" })
        .locator("[data-nick-color-index]")
        .evaluate((avatar) => {
          const index = avatar.getAttribute("data-nick-color-index");
          const style = getComputedStyle(avatar);
          return {
            color: style.color,
            inlineStyle: avatar.getAttribute("style"),
            index,
            fontSize: Number.parseFloat(style.fontSize),
          };
        });
      expect(avatarPresentation.index).not.toBeNull();
      expect(avatarPresentation.inlineStyle).toMatch(/var\(--wl-nick-\d+\)/u);
      expect(avatarPresentation.color).not.toBe("");
      expect(avatarPresentation.fontSize).toBeGreaterThanOrEqual(22);
      await mkdir(screenshotDirectory, { recursive: true });
      const chats = page.locator("[data-mobile-chats]");
      await screenshotWithInter(chats, {
        path: path.join(screenshotDirectory, "mobile-chats-light.png"),
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await screenshotWithInter(chats, {
        path: path.join(screenshotDirectory, "mobile-chats-dark.png"),
      });

      await page.emulateMedia({ colorScheme: "light" });
      await page.getByRole("button", { name: "#weblounge-test" }).click();
      await expect(
        page.getByText("weblounge: Mobile history is ready for the lounge", {
          exact: true,
        }),
      ).toBeVisible();
      await expectFullBleedHighlight(
        page,
        "weblounge: Mobile history is ready for the lounge",
      );
      await expect(page.locator("[data-mobile-chats]")).toHaveCount(1);
      await expect(
        page.locator("[data-mobile-chats]").locator(".."),
      ).toHaveAttribute("aria-hidden", "true");
      const composerBox = await page
        .getByRole("textbox", { name: "Message #weblounge-test" })
        .boundingBox();
      expect(composerBox?.y).toBeGreaterThan(760);
      await expect
        .poll(() =>
          page.locator("[data-message-row]").evaluateAll((rows) =>
            rows.some((row, index) => {
              const next = rows[index + 1];
              return (
                next !== undefined &&
                row.getBoundingClientRect().bottom >
                  next.getBoundingClientRect().top + 0.5
              );
            }),
          ),
        )
        .toBe(false);
      const messageList = page.locator("[data-message-list]");
      await screenshotWithInter(messageList, {
        path: path.join(screenshotDirectory, "mobile-chat-light.png"),
      });
      const lightWithoutScrim = await sampleScrimPixel(page, messageList);
      await page.emulateMedia({ colorScheme: "dark" });
      await screenshotWithInter(messageList, {
        path: path.join(screenshotDirectory, "mobile-chat-dark.png"),
      });
      const darkWithoutScrim = await sampleScrimPixel(page, messageList);
      await page.getByRole("button", { name: "Show members" }).click();
      const membersDialog = page.getByRole("dialog", { name: "Members" });
      await expect(membersDialog).toBeVisible();
      await expect(page.locator("[data-overlay-drawer]")).toHaveAttribute(
        "data-phase",
        "open",
      );
      await expect(
        membersDialog.getByRole("button", {
          name: "Open direct message with mel-mobile",
        }),
      ).toBeVisible();
      await page.emulateMedia({ colorScheme: "light" });
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        "lounge",
      );
      const memberNames = membersDialog.locator("[data-member-name]");
      expect(await sampleScrimPixel(page, memberNames)).toBeLessThan(
        lightWithoutScrim,
      );
      await screenshotWithInter(memberNames, {
        path: path.join(screenshotDirectory, "mobile-members-light.png"),
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        "lounge-night",
      );
      expect(await sampleScrimPixel(page, memberNames)).toBeLessThan(
        darkWithoutScrim,
      );
      await screenshotWithInter(memberNames, {
        path: path.join(screenshotDirectory, "mobile-members-dark.png"),
      });
    } finally {
      for (const bot of bots) bot.close();
    }
  });
});

async function expectFullBleedHighlight(
  page: Page,
  text: string,
): Promise<void> {
  const list = page.getByRole("list", { name: "Messages" });
  const row = list.locator("[data-message-row]").filter({ hasText: text });
  const listWidth = await list.evaluate((element) => element.clientWidth);
  const highlightBackground = await page.locator("html").evaluate((element) => {
    const sample = document.createElement("div");
    sample.style.background = getComputedStyle(element).getPropertyValue(
      "--wl-color-mention-bg",
    );
    document.body.append(sample);
    const background = getComputedStyle(sample).backgroundColor;
    sample.remove();
    return background;
  });
  await expect(row).toHaveAttribute("data-message-text", text);
  await expect(row).toHaveCSS("background-color", highlightBackground);
  await expect(row).toHaveCSS("width", `${listWidth}px`);
}

async function sampleScrimPixel(
  page: Page,
  fontTarget: Locator,
): Promise<number> {
  const image = await screenshotWithInter(fontTarget, {
    clip: { x: 32, y: 430, width: 1, height: 1 },
  });
  return page.evaluate(async (encoded) => {
    const bytes = Uint8Array.from(atob(encoded), (character) =>
      character.charCodeAt(0),
    );
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: "image/png" }),
    );
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("2D canvas is unavailable");
    context.drawImage(bitmap, 0, 0);
    const pixel = context.getImageData(0, 0, 1, 1).data;
    return (
      0.2126 * (pixel[0] ?? 0) +
      0.7152 * (pixel[1] ?? 0) +
      0.0722 * (pixel[2] ?? 0)
    );
  }, image.toString("base64"));
}
