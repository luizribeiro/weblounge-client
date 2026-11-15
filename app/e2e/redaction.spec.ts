import type { Locator, Page } from "@playwright/test";
import { type IrcClient, messageId, serverTime } from "./irc-client";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { productionMessageRow } from "./production-ergo";
import { expectSettled } from "./settled";

test.describe("message redaction against local Ergo", () => {
  for (const shell of ["desktop", "phone"] as const) {
    test.describe(shell, { tag: shell === "phone" ? "@phone" : [] }, () => {
      if (shell === "phone")
        test.use({
          hasTouch: true,
          isMobile: true,
          viewport: { width: 390, height: 844 },
        });
      else test.skip(({ isMobile }) => isMobile, "desktop layout");

      test("shows a peer's channel deletion as bars", async ({ page, irc }) => {
        const peer = await openWithPeer(page, irc, "chan");
        await openConversation(page, irc.channel);
        await expectRedactedByPeer(
          page,
          irc,
          peer,
          irc.channel,
          "channel secret",
        );
      });

      if (shell === "desktop")
        test("deletes your own message after confirming, for everyone", async ({
          page,
          irc,
        }) => {
          const peer = await openWithPeer(page, irc, "own");
          await openConversation(page, irc.channel);
          const text = "I take this back";
          await composer(page).fill(text);
          await composer(page).press("Enter");
          const sent = await peer.waitForPrivmsg(
            irc.channel,
            text,
            irc.account,
          );
          const row = productionMessageRow(page, text);
          await expect(row).toHaveAttribute("data-delivery", "confirmed");
          await waitForReadDwell(irc, irc.channel, serverTime(sent));

          await row.hover();
          await page.getByRole("button", { name: "More actions" }).click();
          await screenshot(page, "desktop-menu");
          await page.keyboard.press("Escape");
          await expect(page.getByRole("menu")).toHaveCount(0);

          await row.locator("time").click({ button: "right" });
          await page.getByRole("menuitem", { name: "Delete message" }).click();
          const dialog = page.getByRole("alertdialog", {
            name: "Delete this message?",
          });
          await expect(dialog).toBeVisible();
          await screenshot(page, "desktop-confirm");
          await dialog.getByRole("button", { name: "Cancel" }).click();
          await expect(dialog).toHaveCount(0);
          await expect(row).toContainText(text);

          await composer(page).click();
          await composer(page).press("ArrowUp");
          await expect(
            page.locator('li[data-selected="true"] [data-message-row]'),
          ).toContainText(text);
          await page.keyboard.press("Delete");
          await dialog.getByRole("button", { name: "Delete" }).click();

          await peer.waitForRedact(irc.channel, messageId(sent));
          await expect(productionMessageRow(page, text)).toHaveCount(0);
          await expect(redactedRow(page)).toContainText("Message deleted");
          await page.mouse.move(0, 0);
          await screenshot(page, "desktop-bars");
          await nativeFeelAudit(page);

          await page.goto(irc.url());
          await expect(conversationButton(page, irc.channel)).toBeVisible();
          await openConversation(page, irc.channel);
          await expect(
            page
              .locator("[data-message-list]")
              .getByText(peer.nickname)
              .first(),
          ).toBeVisible();
          await expect(page.getByText(text, { exact: true })).toHaveCount(0);
          await expect(redactedRow(page)).toHaveCount(0);
        });

      test("shows a peer's direct-message deletion as bars", async ({
        page,
        irc,
      }) => {
        const peer = await openWithPeer(page, irc, "dm");
        await peer.privmsgConfirmed(irc.account, "opening line");
        await openConversation(page, peer.nickname);
        await expectRedactedByPeer(
          page,
          irc,
          peer,
          irc.account,
          "direct secret",
        );
      });
    });
  }
});

async function openWithPeer(
  page: Page,
  irc: IrcTestAccount,
  label: string,
): Promise<IrcClient> {
  await installNativeFeelInstrumentation(page);
  await page.goto(irc.url());
  await expect(conversationButton(page, irc.channel)).toBeVisible();
  return irc.peer(`redact-${label}`);
}

function conversationButton(page: Page, title: string): Locator {
  return page
    .getByRole("button", { name: new RegExp(`^${escaped(title)}(?:,|$)`, "u") })
    .first();
}

async function openConversation(page: Page, title: string): Promise<void> {
  await conversationButton(page, title).click();
  await expectSettled(page, { conversation: title });
}

async function expectRedactedByPeer(
  page: Page,
  irc: IrcTestAccount,
  peer: IrcClient,
  target: string,
  text: string,
): Promise<void> {
  const echoed = await peer.privmsgConfirmed(target, text);
  const row = productionMessageRow(page, text);
  await expect(row).toBeVisible();
  await waitForReadDwell(
    irc,
    target === irc.account ? peer.nickname : target,
    serverTime(echoed),
  );

  await peer.redactConfirmed(target, messageId(echoed));
  await expect(productionMessageRow(page, text)).toHaveCount(0);
  const redacted = redactedRow(page);
  await expect(redacted).toHaveCount(1);
  await expect(redacted).toContainText("Message deleted");
  await expect(redacted).not.toContainText(text);
  await expect(redacted.locator("[data-redaction-bar]")).not.toHaveCount(0);
  await expectOneLine(redacted.locator("[data-redacted]"));
  await nativeFeelAudit(page);
}

// The read dwell marks a new row read a moment after it shows; waiting for the marker keeps that
// timer out of the idle audit that follows the redaction.
async function waitForReadDwell(
  irc: IrcTestAccount,
  target: string,
  time: string,
): Promise<void> {
  const reader = await irc.self();
  await expect
    .poll(async () => (await reader.readMarker(target)) ?? "")
    .toBe(time);
}

function composer(page: Page): Locator {
  return page.getByRole("textbox", { name: /^Message/u });
}

async function screenshot(page: Page, name: string): Promise<void> {
  const directory = process.env.WEBLOUNGE_REDACTION_SHOTS;
  if (directory === undefined) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `${directory}/${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: null });
}

function redactedRow(page: Page): Locator {
  return page
    .locator("[data-message-row]")
    .filter({ has: page.locator("[data-redacted]") });
}

async function expectOneLine(body: Locator): Promise<void> {
  const lines = await body.evaluate((element) => {
    const bars = [...element.querySelectorAll("[data-redaction-bar]")];
    const visibleTops = new Set(
      bars
        .map((bar) => bar.getBoundingClientRect())
        .filter(
          (rect) => rect.bottom <= element.getBoundingClientRect().bottom + 0.5,
        )
        .map((rect) => Math.round(rect.top)),
    );
    return {
      visibleRows: visibleTops.size,
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
    };
  });
  expect(Number.isFinite(lines.lineHeight)).toBe(true);
  expect(lines.visibleRows).toBe(1);
  expect(lines.height).toBeCloseTo(lines.lineHeight, 0);
}

function escaped(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
