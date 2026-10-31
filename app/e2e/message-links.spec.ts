import { expect, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";

test.describe("message links and nicknames against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("opens desktop URLs and channel links", async ({ page }) => {
    await installNativeFeelInstrumentation(page);
    await page.setViewportSize({ width: 1200, height: 800 });
    await exerciseLinks(page, "desktop", false, true);
  });

  test("opens desktop nickname authors and mentions accessibly", async ({
    page,
  }) => {
    const suffix = Date.now().toString().slice(-6);
    const authorNick = `clicka${suffix}`;
    const mentionNick = `clickb${suffix}`;
    const marker = `clickable nick ${suffix}`;
    const author = await IrcClient.connect(
      authorNick,
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    const mentioned = await IrcClient.connect(
      mentionNick,
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    try {
      await mentioned.privmsgConfirmed(
        "#weblounge-test",
        `known nick ${suffix}`,
      );
      await author.privmsgConfirmed(
        "#weblounge-test",
        `${marker} ${mentionNick}`,
      );
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.goto("/?irc-password=weblounge-test");

      const authorRow = page.locator("[data-message-row]").filter({
        has: page.getByText(marker, { exact: false }),
      });
      const authorAction = authorRow.getByRole("button", {
        name: `Open direct message with ${authorNick}`,
      });
      await expect(authorAction).toHaveCSS("cursor", "pointer");
      await authorAction.click();
      await expect(
        page.getByRole("heading", { name: authorNick }),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: `Message ${authorNick}` }),
      ).toBeFocused();

      await page.getByRole("button", { name: "#weblounge-test" }).click();
      const mentionAction = authorRow.getByRole("button", {
        name: `Open direct message with ${mentionNick}`,
      });
      await mentionAction.click();
      await expect(
        page.getByRole("textbox", { name: `Message ${mentionNick}` }),
      ).toBeFocused();

      await page.getByRole("button", { name: "#weblounge-test" }).click();
      await mentionAction.focus();
      await mentionAction.press("Space");
      await expect(
        page.getByRole("heading", { name: mentionNick }),
      ).toBeVisible();

      await page.getByRole("button", { name: "#weblounge-test" }).click();
      const ownMarker = `own nick inert ${suffix}`;
      const composer = page.getByRole("textbox", {
        name: "Message #weblounge-test",
      });
      await composer.fill(`${ownMarker} weblounge`);
      await composer.press("Enter");
      const ownRow = page.locator("[data-message-row]").filter({
        has: page.getByText(ownMarker, { exact: false }),
      });
      await expect(ownRow).toBeVisible();
      await expect(
        ownRow.getByRole("button", {
          name: "Open direct message with weblounge",
        }),
      ).toHaveCount(0);
    } finally {
      author.close();
      mentioned.close();
    }
  });

  test.describe("touch-primary rendering", () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 402, height: 874 },
    });

    test("opens mobile URLs and channel links without overflowing", async ({
      page,
    }) => {
      await exerciseLinks(page, "mobile", true);
    });

    test("opens a mobile nickname without raising the keyboard", async ({
      page,
    }) => {
      const suffix = Date.now().toString().slice(-6);
      const nick = `tapnick${suffix}`;
      const marker = `tap nick ${suffix}`;
      const bot = await IrcClient.connect(
        nick,
        "weblounge-bot",
        "weblounge-bot-test",
        "#weblounge-test",
      );
      try {
        await bot.privmsgConfirmed("#weblounge-test", marker);
        await page.goto("/?irc-password=weblounge-test");
        await page.getByRole("button", { name: "#weblounge-test" }).tap();
        const row = page.locator("[data-message-row]").filter({
          has: page.getByText(marker, { exact: true }),
        });
        await row
          .getByRole("button", {
            name: `Open direct message with ${nick}`,
          })
          .tap();

        await expect(page.getByRole("heading", { name: nick })).toBeVisible();
        await expect(
          page.getByRole("textbox", { name: `Message ${nick}` }),
        ).not.toBeFocused();
        await expect(page.locator("#root")).toHaveAttribute(
          "data-keyboard",
          "closed",
        );
      } finally {
        bot.close();
      }
    });
  });
});

async function exerciseLinks(
  page: import("@playwright/test").Page,
  label: string,
  longUrl: boolean,
  audit = false,
): Promise<void> {
  const suffix = Date.now().toString().slice(-6);
  const target = `#links-${label}-${suffix}`;
  const url = `http://127.0.0.1:4174/${longUrl ? "unbroken-segment".repeat(12) : `message-${suffix}`}`;
  const source = await IrcClient.connect(
    `source${suffix}`,
    "weblounge-bot",
    "weblounge-bot-test",
    "#weblounge-test",
  );
  const targetMember = await IrcClient.connect(
    `target${suffix}`,
    "weblounge-bot",
    "weblounge-bot-test",
    target,
  );
  try {
    await source.privmsgConfirmed(
      "#weblounge-test",
      `visit ${url}. then open ${target}`,
    );
    await page.goto("/?irc-password=weblounge-test");
    if (label === "mobile")
      await page.getByRole("button", { name: "#weblounge-test" }).click();

    const external = page
      .locator("[data-message-list]")
      .getByRole("link", { name: url });
    await expect(external).toHaveAttribute("href", url);
    await expect(external).toHaveAttribute("target", "_blank");
    await expect(external).toHaveAttribute("rel", "noopener noreferrer");
    await expect(external).toHaveCSS("cursor", "pointer");
    if (audit) {
      await expect(
        page.locator('[data-buffer-id][aria-current="page"]'),
      ).toHaveAttribute("data-unread", "0");
      await nativeFeelAudit(page);
    }
    if (longUrl) {
      const geometry = await external.evaluate((link) => {
        const list = link.closest<HTMLElement>("[data-message-list]");
        if (list === null) throw new Error("message list is missing");
        return {
          clientWidth: list.clientWidth,
          linkRight: link.getBoundingClientRect().right,
          listRight: list.getBoundingClientRect().right,
          scrollWidth: list.scrollWidth,
        };
      });
      expect(geometry.linkRight).toBeLessThanOrEqual(geometry.listRight);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    }

    const popupPromise = page.waitForEvent("popup");
    await external.click();
    const popup = await popupPromise;
    await expect.poll(() => popup.url()).toBe(url);
    await popup.close();

    const channel = page.getByRole("link", { name: target });
    await expect(channel).toHaveCSS("cursor", "pointer");
    await channel.click();
    await expect(page.getByRole("heading", { name: target })).toBeVisible();
  } finally {
    source.close();
    targetMember.close();
  }
}
