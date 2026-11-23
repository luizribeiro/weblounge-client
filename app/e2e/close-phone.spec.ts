import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { screenshotWithInter } from "./inter-font";
import type { IrcClient } from "./irc-client";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
  resetNativeFeelLayoutShift,
} from "./native-feel-audit";
import { backToChatList, backToChats, expectSettled } from "./settled";

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
    irc,
  }) => {
    const channel = irc.channelNamed("phone-close");
    await mkdir(screenshots, { recursive: true });
    await installNativeFeelInstrumentation(page);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(irc.url());
    await openChannel(page, irc, channel);
    const peer = await irc.peer("phone", [channel]);
    await backToChats(page, channel);

    await peer.privmsgConfirmed(irc.account, "phone close");
    const directRow = () => rowFor(page, peer.nickname);
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
    await expect(directWrapper()).toHaveAttribute("data-swipe-state", "closed");
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

    await revealActions(directWrapper());
    await tapAction(page, directWrapper(), "Close");
    await expect(directRow()).toHaveCount(0);
    const toast = page.getByRole("status").filter({
      hasText: `Closed chat with ${peer.nickname}`,
    });
    await expect(toast).toBeVisible();
    await captureThemes(page, shell, "undo-toast", browserName);
    await toast.getByRole("button", { name: "Undo" }).click();
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
    let parted = peer.waitForNextPart(channel, irc.account);
    await confirmation.getByRole("button", { name: "Leave" }).click();
    await parted;
    await expect(channelRow).toHaveCount(0);

    await openChannel(page, irc, channel);
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
    parted = peer.waitForNextPart(channel, irc.account);
    await confirmation.getByRole("button", { name: "Leave" }).click();
    await parted;
    await expect(page.locator("[data-mobile-chats]")).toBeVisible();

    await seedScrollableChannels(page, irc);
    await page.setViewportSize({ width: 402, height: 500 });
    const list = page.locator("[data-mobile-chat-list]");
    await expect
      .poll(() =>
        list.evaluate((element) => element.scrollHeight > element.clientHeight),
      )
      .toBe(true);
    await list.evaluate((element) => element.scrollBy(0, 500));
    await expect
      .poll(() => list.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect(list.locator('[data-swipe-state="dragging"]')).toHaveCount(0);

    await resetNativeFeelLayoutShift(page);
    await nativeFeelAudit(page);
  });

  test("lifts a long-pressed row without moving it or its contents", async ({
    page,
    irc,
  }) => {
    await installNativeFeelInstrumentation(page);
    await page.goto(irc.url());
    const row = rowFor(page, irc.channel);
    await expect(row).toBeVisible();
    await expectSettled(page);
    const atRest = await boxesOf(row);
    await resetNativeFeelLayoutShift(page);

    await pointer(wrapperFor(row), "pointerdown", 0, 1_000);
    const lifted = page.locator("[data-mobile-lifted-row] [data-buffer-id]");
    await expect(lifted).toBeVisible();
    expect(await boxesOf(lifted)).toEqual(atRest);
    expect(await boxesOf(row)).toEqual(atRest);
    await nativeFeelAudit(page);
  });

  test("a touch tap on revealed Close or Leave removes the row for good", async ({
    page,
    irc,
  }) => {
    const channel = irc.channelNamed("phone-tap-close");
    await installNativeFeelInstrumentation(page);
    await page.goto(irc.url());
    await openChannel(page, irc, channel);
    const peer = await irc.peer("tapper", [channel]);
    await backToChats(page, channel);
    const directRow = await receiveDirect(page, irc, peer, "tap close");

    await revealActions(wrapperFor(directRow));
    await tapAction(page, wrapperFor(directRow), "Close");
    await expect(directRow).toHaveCount(0);

    const channelRow = rowFor(page, channel);
    await revealActions(wrapperFor(channelRow));
    await tapAction(page, wrapperFor(channelRow), "Leave");
    const confirmation = page.getByRole("alertdialog", {
      name: `Leave ${channel}?`,
    });
    await expect(confirmation).toBeVisible();
    const parted = peer.waitForNextPart(channel, irc.account);
    await confirmation.getByRole("button", { name: "Leave" }).click();
    await parted;
    await expect(channelRow).toHaveCount(0);

    await expectSettled(page);
    await expect(directRow).toHaveCount(0);
    await page.goto(irc.url());
    await expect(rowFor(page, irc.channel)).toBeVisible();
    await expectSettled(page);
    await expect(directRow).toHaveCount(0);
    await expect(channelRow).toHaveCount(0);
    await nativeFeelAudit(page);
  });

  test("a full fast swipe only opens the row and its button closes or leaves", async ({
    browserName,
    page,
    irc,
  }) => {
    const channel = irc.channelNamed("phone-full-swipe");
    await mkdir(screenshots, { recursive: true });
    await installNativeFeelInstrumentation(page);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(irc.url());
    await openChannel(page, irc, channel);
    const peer = await irc.peer("swiper", [channel]);
    await backToChats(page, channel);
    const directRow = await receiveDirect(page, irc, peer, "full swipe");
    const directWrapper = wrapperFor(directRow);
    const shell = page.locator("[data-mobile-shell]");
    await expectSettled(page);

    await dragThrough(directWrapper, fullRowFastSwipe);
    await expect(directWrapper).toHaveAttribute("data-swipe-state", "dragging");
    await captureThemes(page, shell, "full-swipe-dragging", browserName);
    await expectOffset(directWrapper, -148);
    await lift(directWrapper, fullRowFastSwipe);
    await expectOpenedAfterFullSwipe(directWrapper, "Close");
    await captureThemes(page, shell, "full-swipe-released", browserName);
    await touchGesture(directWrapper, rowSwipeBack);
    await expect(directWrapper).toHaveAttribute("data-swipe-state", "closed");
    await expectOffset(directWrapper, 0);
    await touchGesture(directWrapper, fullRowFastSwipe);
    await expectOpenedAfterFullSwipe(directWrapper, "Close");
    await tapAction(page, directWrapper, "Close");
    await expect(directRow).toHaveCount(0);

    const channelWrapper = wrapperFor(rowFor(page, channel));
    await touchGesture(channelWrapper, fullRowFastSwipe);
    await expectOpenedAfterFullSwipe(channelWrapper, "Leave");
    await tapAction(page, channelWrapper, "Leave");
    const confirmation = page.getByRole("alertdialog", {
      name: `Leave ${channel}?`,
    });
    await expect(confirmation).toBeVisible();
    const parted = peer.waitForNextPart(channel, irc.account);
    await confirmation.getByRole("button", { name: "Leave" }).click();
    await parted;
    await expect(rowFor(page, channel)).toHaveCount(0);

    await expectSettled(page);
    await nativeFeelAudit(page);
  });

  test("undo of a DM closed from the chat list keeps the chat list", async ({
    page,
    irc,
  }) => {
    const peer = await irc.peer("from-list");
    await installNativeFeelInstrumentation(page);
    await page.goto(irc.url());
    await expect(rowFor(page, irc.channel)).toBeVisible();
    const directRow = await receiveDirect(
      page,
      irc,
      peer,
      "close me from the list",
    );

    await revealActions(wrapperFor(directRow));
    await tapAction(page, wrapperFor(directRow), "Close");
    await expect(directRow).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();

    await expect(directRow).toBeVisible();
    await expectSettled(page);
    await expect(page.locator("[data-mobile-chats]")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Back to chats" }),
    ).toHaveCount(0);
    await nativeFeelAudit(page);
  });

  test("undo of a DM closed with /close reopens it", async ({ page, irc }) => {
    const peer = await irc.peer("by-command");
    await installNativeFeelInstrumentation(page);
    await page.goto(irc.url());
    await expect(rowFor(page, irc.channel)).toBeVisible();
    const directRow = await receiveDirect(
      page,
      irc,
      peer,
      "close me with a command",
    );
    await directRow.click();
    const composer = page.getByRole("textbox", {
      name: `Message ${peer.nickname}`,
    });
    await composer.fill("/close");
    await composer.press("Enter");
    await expect(page.locator("[data-mobile-chats]")).toBeVisible();
    await expect(directRow).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();

    await expect(
      page.getByRole("heading", { name: peer.nickname }),
    ).toBeVisible();
    await backToChatList(page, peer.nickname);
    await expect(directRow).toBeVisible();
    await nativeFeelAudit(page);
  });

  test("reveals actions for realistic diagonal drags and short flicks", async ({
    page,
    irc,
  }) => {
    await page.goto(irc.url());
    const wrapper = wrapperFor(rowFor(page, irc.channel));
    await expect(wrapper).toHaveAttribute("data-swipe-state", "closed");

    for (const gesture of realisticRevealGestures) {
      await touchGesture(wrapper, gesture.samples);
      await expect(wrapper, gesture.name).toHaveAttribute(
        "data-swipe-state",
        "revealed",
      );
      await rowFor(page, irc.channel).click();
      await expect(wrapper).toHaveAttribute("data-swipe-state", "closed");
    }

    await touchGesture(wrapper, verticalScrollSamples);
    await expect(wrapper).toHaveAttribute("data-swipe-state", "closed");
  });

  test("keeps a horizontal row drag from turning into a list scroll", async ({
    page,
    irc,
  }) => {
    await page.goto(irc.url());
    const wrapper = wrapperFor(rowFor(page, irc.channel));
    await expect(wrapper).toHaveAttribute("data-swipe-state", "closed");

    expect(await touchMoveCancelled(wrapper, 40, 6)).toBe(true);
    await expect(wrapper).toHaveAttribute("data-swipe-state", "closed");
    expect(await touchMoveCancelled(wrapper, 6, 40)).toBe(false);
  });
});

interface TouchSample {
  readonly left: number;
  readonly down: number;
  readonly at: number;
}

function samples(
  left: number,
  down: number,
  durationMs: number,
): readonly TouchSample[] {
  const frames = Math.max(2, Math.round(durationMs / 16));
  return Array.from({ length: frames + 1 }, (_, frame) => ({
    left: Math.round((left * frame) / frames),
    down: Math.round((down * frame) / frames),
    at: Math.round((durationMs * frame) / frames),
  }));
}

const realisticRevealGestures = [
  { name: "slow 30-degree drag", samples: samples(80, 46, 400) },
  { name: "fast 45px flick", samples: samples(45, 10, 70) },
  { name: "fast 30px flick", samples: samples(30, 8, 50) },
] as const;

const verticalScrollSamples = samples(12, 60, 200);

const fullRowFastSwipe = samples(330, 4, 80);

const rowSwipeBack = samples(-148, 2, 200);

const gestureStartTimeStamp = 10_000;

async function touchGesture(
  wrapper: Locator,
  gesture: readonly TouchSample[],
): Promise<void> {
  await dragThrough(wrapper, gesture);
  await lift(wrapper, gesture);
}

async function dragThrough(
  wrapper: Locator,
  gesture: readonly TouchSample[],
): Promise<void> {
  const [first, ...rest] = gesture;
  if (first === undefined) throw new Error("a touch gesture needs samples");
  await pointer(
    wrapper,
    "pointerdown",
    first.left,
    gestureStartTimeStamp + first.at,
    first.down,
  );
  for (const sample of rest)
    await pointer(
      wrapper,
      "pointermove",
      sample.left,
      gestureStartTimeStamp + sample.at,
      sample.down,
    );
}

async function lift(
  wrapper: Locator,
  gesture: readonly TouchSample[],
): Promise<void> {
  const last = gesture.at(-1);
  if (last === undefined) throw new Error("a touch gesture needs samples");
  await pointer(
    wrapper,
    "pointerup",
    last.left,
    gestureStartTimeStamp + last.at + 8,
    last.down,
  );
}

async function touchMoveCancelled(
  wrapper: Locator,
  left: number,
  down: number,
): Promise<boolean> {
  const touch = (type: "touchstart" | "touchmove", sample: TouchSample) =>
    wrapper.evaluate(
      (element, init) => {
        const rect = element.getBoundingClientRect();
        const clientX = rect.right - 12 - init.left;
        const clientY = rect.top + rect.height / 2 + init.down;
        const target = element.querySelector("[data-buffer-id]") ?? element;
        const event = new Event(init.type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "touches", {
          value: [{ clientX, clientY, identifier: 7, target }],
        });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      },
      { ...sample, type },
    );
  const start = { at: 0, down: 0, left: 0 };
  const moved = { at: 32, down, left };
  await touch("touchstart", start);
  await pointer(wrapper, "pointerdown", 0, gestureStartTimeStamp);
  await pointer(wrapper, "pointermove", left, gestureStartTimeStamp + 32, down);
  const cancelled = await touch("touchmove", moved);
  await pointer(wrapper, "pointerup", left, gestureStartTimeStamp + 400, down);
  return cancelled;
}

// An incoming DM lands at the top of the activity-sorted list and pushes the rows below
// it down without input, which the layout-shift audit would count against the test.
async function receiveDirect(
  page: Page,
  irc: IrcTestAccount,
  peer: IrcClient,
  text: string,
): Promise<Locator> {
  await peer.privmsgConfirmed(irc.account, text);
  const row = rowFor(page, peer.nickname);
  await expect(row).toBeVisible();
  await resetNativeFeelLayoutShift(page);
  return row;
}

async function revealActions(wrapper: Locator): Promise<void> {
  await touchGesture(wrapper, samples(80, 4, 200));
  await expect(wrapper).toHaveAttribute("data-swipe-state", "revealed");
  await expectOffset(wrapper, -148);
}

async function expectOpenedAfterFullSwipe(
  wrapper: Locator,
  action: "Close" | "Leave",
): Promise<void> {
  await expect(wrapper).toHaveAttribute("data-swipe-state", "revealed");
  await expectOffset(wrapper, -148);
  await expect(wrapper.getByRole("button", { name: action })).toBeVisible();
}

async function tapAction(
  page: Page,
  wrapper: Locator,
  name: "Close" | "Leave",
): Promise<void> {
  const box = await wrapper.getByRole("button", { name }).boundingBox();
  if (box === null) throw new Error(`${name} action has no box`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

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

async function boxesOf(row: Locator): Promise<readonly string[]> {
  return row.evaluate((element) =>
    [element, ...element.querySelectorAll("*")].map((child) => {
      const { x, y, width, height } = child.getBoundingClientRect();
      return [x, y, width, height].map((value) => value.toFixed(1)).join(" ");
    }),
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

async function openChannel(
  page: Page,
  irc: IrcTestAccount,
  channel: string,
): Promise<void> {
  const home = rowFor(page, irc.channel);
  await home.click();
  const composer = page.locator("[data-composer] textarea");
  await composer.fill(`/join ${channel}`);
  await composer.press("Enter");
  await expect(page.getByRole("heading", { name: channel })).toBeVisible();
}

async function seedScrollableChannels(page: Page, irc: IrcTestAccount) {
  await rowFor(page, irc.channel).click();
  let current = irc.channel;
  for (let index = 0; index < 5; index += 1) {
    const channel = irc.channelNamed(`phone-scroll-${index}`);
    const composer = page.getByRole("textbox", { name: `Message ${current}` });
    await composer.fill(`/join ${channel}`);
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    current = channel;
  }
  await backToChats(page, current);
  await expectSettled(page);
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
