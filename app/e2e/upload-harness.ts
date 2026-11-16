import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { E2E_FILEHOST_ORIGIN } from "../csp";
import { screenshotWithInter } from "./inter-font";
import type { IrcClient } from "./irc-client";
import { expect, type IrcTestAccount } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  resetNativeFeelLayoutShift,
} from "./native-feel-audit";
import { expectSettled } from "./settled";

const screenshots =
  process.env.WEBLOUNGE_UPLOAD_SCREENSHOTS ??
  path.join(process.cwd(), "e2e", "screenshots", "image-uploads");

export interface RecordedUpload {
  readonly authorization: string | null;
  readonly contentType: string | null;
  readonly disposition: string | null;
  readonly size: number;
  readonly body: string | null;
}

export async function withDirectPeer(
  page: Page,
  irc: IrcTestAccount,
  label: string,
  body: (peer: IrcClient, composer: Locator) => Promise<void>,
): Promise<void> {
  await installNativeFeelInstrumentation(page);
  await recordShiftsOutsideComposer(page);
  await page.goto(irc.url());
  await expect(page.getByRole("button", { name: irc.channel })).toBeVisible();
  const peer = await irc.peer(`up-${label}`, [irc.channelNamed(`up-${label}`)]);
  await peer.privmsgConfirmed(irc.account, `uploads ${label}${irc.id}`);
  await page
    .getByRole("button", { name: new RegExp(`^${peer.nickname}(?:,|$)`, "u") })
    .click();
  await expectSettled(page, { conversation: peer.nickname });
  await resetNativeFeelLayoutShift(page);
  await body(peer, page.getByLabel(`Message ${peer.nickname}`));
}

export async function expectThumbnailLoaded(chip: Locator): Promise<void> {
  await expect
    .poll(() =>
      chip
        .locator("[data-attachment-thumbnail]")
        .evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth,
        ),
    )
    .toBeGreaterThan(0);
}

export async function control(
  request: APIRequestContext,
  irc: IrcTestAccount,
  action: "hold" | "limit" | "next",
  parameters: Record<string, string> = {},
): Promise<void> {
  const url = new URL(`/control/${action}`, E2E_FILEHOST_ORIGIN);
  url.searchParams.set("scope", irc.account);
  for (const [name, value] of Object.entries(parameters))
    url.searchParams.set(name, value);
  const response = await request.post(url.href);
  expect(response.ok()).toBe(true);
}

export async function uploads(
  request: APIRequestContext,
  irc: IrcTestAccount,
): Promise<readonly RecordedUpload[]> {
  const url = new URL("/control/uploads", E2E_FILEHOST_ORIGIN);
  url.searchParams.set("scope", irc.account);
  const response = await request.get(url.href);
  return (await response.json()) as RecordedUpload[];
}

export async function captureThemes(page: Page, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      theme === "light" ? "lounge" : "lounge-night",
    );
    await mkdir(screenshots, { recursive: true });
    await screenshotWithInter(page.locator("[data-app-root]"), {
      path: path.join(screenshots, `${name}-${theme}.png`),
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

// Records which elements outside the composer moved. Only Chromium reports layout shifts, so
// the chromium and android projects carry this check and WebKit runs it vacuously.
async function recordShiftsOutsideComposer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const shifts: { at: number; nodes: string[] }[] = [];
    Reflect.set(window, "__uploadShifts", shifts);
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const sources = (entry as unknown as { sources: { node?: Node }[] })
            .sources;
          shifts.push({
            at: entry.startTime,
            nodes: sources
              .map((source) => source.node)
              .filter(
                (node): node is Element =>
                  node instanceof Element &&
                  node.closest("[data-composer]") === null,
              )
              .map((node) => node.outerHTML.slice(0, 120)),
          });
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      // WebKit reports no layout shifts; the native-feel audit covers what it can.
    }
  });
}

// The fake file host is on the IRC endpoint's host but another port, so the password asks first.
export async function approveUpload(page: Page): Promise<void> {
  const dialog = page.getByRole("alertdialog", {
    name: "Allow upload to 127.0.0.1:4175",
  });
  await dialog
    .getByRole("checkbox", { name: "Remember for this network" })
    .check();
  await dialog.getByRole("button", { name: "Upload" }).click();
  await expect(dialog).toHaveCount(0);
}
