import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { screenshotWithInter } from "./inter-font";
import { IrcClient } from "./irc-client";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
  resetNativeFeelLayoutShift,
} from "./native-feel-audit";

const screenshots = path.join(
  process.cwd(),
  "..",
  "screenshots",
  "close-phone",
);

test.describe("phone conversation closing against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("swipes, undoes, opens sheets, confirms Leave, and keeps scrolling", async ({
    browserName,
    page,
  }) => {
    const suffix = Date.now().toString(36).slice(-6);
    const channel = `#phone-close-${suffix}`;
    let peer: IrcClient | undefined;
    try {
      await mkdir(screenshots, { recursive: true });
      await installNativeFeelInstrumentation(page);
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto("/?irc-password=weblounge-test");
      await openChannel(page, channel);
      peer = await IrcClient.connect(
        `phone-${suffix}`,
        "weblounge-bot",
        "weblounge-bot-test",
        channel,
      );
      await page.getByRole("button", { name: "Back to chats" }).click();

      await peer.privmsgConfirmed("weblounge", `phone close ${suffix}`);
      const directRow = () => rowFor(page, peer?.nickname ?? "");
      await expect(directRow()).toBeVisible();
      const directWrapper = () => wrapperFor(directRow());
      const shell = page.locator("[data-mobile-shell]");

      await pointer(directWrapper(), "pointerdown", 0, 1_000);
      await pointer(directWrapper(), "pointermove", 64, 1_100);
      await expect(directWrapper()).toHaveAttribute(
        "data-swipe-state",
        "dragging",
      );
      await expectOffset(directWrapper(), -64);
      await captureThemes(page, shell, "row-mid-swipe", browserName);
      await pointer(directWrapper(), "pointerup", 64, 1_150);
      await expect(directWrapper()).toHaveAttribute(
        "data-swipe-state",
        "revealed",
      );
      await expectOffset(directWrapper(), -148);
      await captureThemes(page, shell, "actions-revealed", browserName);

      await directRow().click();
      await expect(directWrapper()).toHaveAttribute(
        "data-swipe-state",
        "closed",
      );
      await pointer(directWrapper(), "pointerdown", 0, 2_000);
      await pointer(directWrapper(), "pointermove", 0, 2_050, 70);
      await pointer(directWrapper(), "pointerup", 0, 2_100, 70);
      await expect(directWrapper()).not.toHaveAttribute(
        "data-swipe-state",
        "dragging",
      );

      await pointer(directWrapper(), "pointerdown", 0, 3_000);
      const actions = page.getByRole("dialog", {
        name: `Actions for ${peer.nickname}`,
      });
      await expect(actions).toBeVisible();
      await captureThemes(page, shell, "long-press-sheet", browserName);
      await actions.getByRole("button", { name: "Cancel" }).click();

      await pointer(directWrapper(), "pointerdown", 0, 4_000);
      await pointer(directWrapper(), "pointermove", 270, 4_100);
      await pointer(directWrapper(), "pointerup", 270, 4_150);
      await expect(directRow()).toHaveCount(0);
      const toast = page.getByRole("status").filter({
        hasText: `Closed chat with ${peer.nickname}`,
      });
      await expect(toast).toBeVisible();
      await captureThemes(page, shell, "undo-toast", browserName);
      await toast.getByRole("button", { name: "Undo" }).click();
      await expect(
        page.getByRole("heading", { name: peer.nickname }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Back to chats" }).click();
      await expect(directRow()).toBeVisible();

      const channelRow = rowFor(page, channel);
      await pointer(wrapperFor(channelRow), "pointerdown", 0, 5_000);
      const channelActions = page.getByRole("dialog", {
        name: `Actions for ${channel}`,
      });
      await expect(channelActions).toBeVisible();
      await channelActions
        .getByRole("button", { name: `Leave ${channel}` })
        .click();
      let confirmation = page.getByRole("alertdialog", {
        name: `Leave ${channel}?`,
      });
      await expect(confirmation).toBeVisible();
      await captureThemes(page, shell, "leave-confirm", browserName);
      let parted = peer.waitForNextPart(channel, "weblounge");
      await confirmation.getByRole("button", { name: "Leave" }).click();
      await parted;
      await expect(channelRow).toHaveCount(0);

      await openChannel(page, channel);
      await page
        .getByRole("button", { name: `Show details for ${channel}` })
        .click();
      const details = page.getByRole("dialog", {
        name: `Details for ${channel}`,
      });
      await expect(details).toBeVisible();
      await details.getByRole("button", { name: "Leave channel" }).click();
      confirmation = page.getByRole("alertdialog", {
        name: `Leave ${channel}?`,
      });
      parted = peer.waitForNextPart(channel, "weblounge");
      await confirmation.getByRole("button", { name: "Leave" }).click();
      await parted;
      await expect(page.locator("[data-mobile-chats]")).toBeVisible();

      await seedScrollableChannels(page, suffix);
      await page.setViewportSize({ width: 402, height: 500 });
      const list = page.locator("[data-mobile-chat-list]");
      await expect
        .poll(() =>
          list.evaluate(
            (element) => element.scrollHeight > element.clientHeight,
          ),
        )
        .toBe(true);
      await list.evaluate((element) => element.scrollBy(0, 500));
      await expect
        .poll(() => list.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      await expect(list.locator('[data-swipe-state="dragging"]')).toHaveCount(
        0,
      );

      await resetNativeFeelLayoutShift(page);
      await nativeFeelAudit(page);
    } finally {
      peer?.close();
    }
  });
});

function rowFor(page: Page, title: string): Locator {
  return page.getByRole("button", {
    name: new RegExp(`^${escapeRegExp(title)}(?:,|$)`, "u"),
  });
}

function wrapperFor(row: Locator): Locator {
  return row.locator("..");
}

async function pointer(
  wrapper: Locator,
  type: "pointerdown" | "pointermove" | "pointerup",
  leftDistance: number,
  timeStamp: number,
  verticalDistance = 0,
): Promise<void> {
  await wrapper.evaluate(
    (element, init) => {
      const rect = element.getBoundingClientRect();
      const event = new PointerEvent(init.type, {
        bubbles: true,
        button: 0,
        cancelable: true,
        clientX: rect.right - 12 - init.leftDistance,
        clientY: rect.top + rect.height / 2 + init.verticalDistance,
        isPrimary: true,
        pointerId: 31,
        pointerType: "touch",
      });
      Object.defineProperty(event, "timeStamp", { value: init.timeStamp });
      element.dispatchEvent(event);
    },
    { leftDistance, timeStamp, type, verticalDistance },
  );
}

async function expectOffset(wrapper: Locator, expected: number): Promise<void> {
  await expect
    .poll(() =>
      wrapper
        .locator("[data-buffer-id]")
        .evaluate(
          (element) => new DOMMatrix(getComputedStyle(element).transform).m41,
        ),
    )
    .toBe(expected);
}

async function openChannel(page: Page, channel: string): Promise<void> {
  const home = page.getByRole("button", { name: /^#weblounge-test/u });
  await home.click();
  const composer = page.locator("[data-composer] textarea");
  await composer.fill(`/join ${channel}`);
  await composer.press("Enter");
  await expect(page.getByRole("heading", { name: channel })).toBeVisible();
}

async function seedScrollableChannels(page: Page, suffix: string) {
  await page.getByRole("button", { name: /^#weblounge-test/u }).click();
  let current = "#weblounge-test";
  for (let index = 0; index < 5; index += 1) {
    const channel = `#phone-scroll-${suffix}-${index}`;
    const composer = page.getByRole("textbox", { name: `Message ${current}` });
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    current = channel;
  }
  await page.getByRole("button", { name: "Back to chats" }).click();
  await expect(page.locator("[data-motion]")).toHaveCount(0);
}

async function captureThemes(
  page: Page,
  target: Locator,
  name: string,
  browserName: string,
): Promise<void> {
  if (browserName !== "webkit") return;
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      theme === "light" ? "lounge" : "lounge-night",
    );
    await screenshotWithInter(target, {
      path: path.join(screenshots, `${name}-${theme}.png`),
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
