import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { type IrcClient, messageId, serverTime } from "./irc-client";
import type { IrcTestAccount } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { productionMessageRow } from "./production-ergo";
import { expectSettled } from "./settled";

export async function openWithPeer(
  page: Page,
  irc: IrcTestAccount,
  label: string,
): Promise<IrcClient> {
  await installNativeFeelInstrumentation(page);
  await page.goto(irc.url());
  await expect(conversationButton(page, irc.channel)).toBeVisible();
  return irc.peer(`redact-${label}`);
}

export function conversationButton(page: Page, title: string): Locator {
  return page
    .getByRole("button", { name: new RegExp(`^${escaped(title)}(?:,|$)`, "u") })
    .first();
}

export async function openConversation(
  page: Page,
  title: string,
): Promise<void> {
  await conversationButton(page, title).click();
  await expectSettled(page, { conversation: title });
}

export async function expectRedactedByPeer(
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
  await expect(redacted.locator("[data-redaction-bars]")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await expectOneLine(redacted.locator("[data-redacted]"));
  await nativeFeelAudit(page);
}

// The read dwell marks a new row read a moment after it shows; waiting for the marker keeps that
// timer out of the idle audit that follows the redaction.
export async function waitForReadDwell(
  irc: IrcTestAccount,
  target: string,
  time: string,
): Promise<void> {
  const reader = await irc.self();
  await expect
    .poll(async () => (await reader.readMarker(target)) ?? "")
    .toBe(time);
}

export function redactedRow(page: Page): Locator {
  return page
    .locator("[data-message-row]")
    .filter({ has: page.locator("[data-redacted]") });
}

export function composer(page: Page): Locator {
  return page.getByRole("textbox", { name: /^Message/u });
}

/** Saves a screenshot for review when WEBLOUNGE_REDACTION_SHOTS names a directory. */
export async function reviewShot(page: Page, name: string): Promise<void> {
  const directory = process.env.WEBLOUNGE_REDACTION_SHOTS;
  if (directory === undefined) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`) });
}

async function expectOneLine(body: Locator): Promise<void> {
  const lines = await body.evaluate((element) => {
    const bottom = element.getBoundingClientRect().bottom + 0.5;
    const visibleTops = new Set(
      [...element.querySelectorAll("[data-redaction-bar]")]
        .map((bar) => bar.getBoundingClientRect())
        .filter((rect) => rect.bottom <= bottom)
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
