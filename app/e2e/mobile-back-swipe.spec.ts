import { expect, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import { emulateStandalone } from "./mobile-platform";

test.beforeEach(async ({ browserName, page }) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  test.skip(browserName !== "webkit", "requires WebKit touch events");
  await emulateStandalone(page);
  await page.goto("/?irc-password=weblounge-test");
});

test("mobile back gestures cancel and complete aligned", async ({ page }) => {
  await openChat(page);
  await drag(page, 1, 90, "pointercancel");
  await expect(page.locator("[data-swipe]")).toHaveCount(0);
  await expectAligned(page);

  await drag(page, 2, 360, "pointerup");
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await expectAligned(page);
});

test("mobile back gesture velocity completes aligned", async ({ page }) => {
  await openChat(page);
  await drag(page, 3, 80, "pointerup");
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await expectAligned(page);
});

test("mobile back gesture midpoint completes aligned", async ({ page }) => {
  await openChat(page);
  await drag(page, 4, 200, "pointerup");
  await expect(page.locator("[data-position]")).toHaveCount(0);
  await expectAligned(page);
});

test("mobile back swipe stays owned over selectable transcript content", async ({
  page,
}) => {
  const bot = await IrcClient.connect(
    "swipe-audit",
    "weblounge-bot",
    "weblounge-bot-test",
    "#weblounge-test",
  );
  const text = `selectable swipe target ${Date.now()}`;
  try {
    bot.privmsg("#weblounge-test", text);
    await openChat(page);
    const message = page.getByText(text, { exact: true });
    await expect(message).toBeVisible();
    await expect(page.locator("[data-message-list]")).toHaveCSS(
      "touch-action",
      "pan-y",
    );
    await expect(message).toHaveCSS("user-select", "text");

    const messageY = await message.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.top + bounds.height / 2;
    });
    await panOverTranscript(page, messageY, 80, 500);
    await expect(page.locator("[data-mobile-chat]")).toBeVisible();
    await expect(page.locator("[data-swipe]")).toHaveCount(0);
    await expectAligned(page);

    const listY = await page.locator("[data-message-list]").evaluate((list) => {
      const bounds = list.getBoundingClientRect();
      return bounds.top + 4;
    });
    await panOverTranscript(page, listY, 220, 600);
    await expect(page.locator("[data-mobile-chats]")).toBeVisible();
    await expectAligned(page);

    await openChat(page);
    await panOverTranscript(page, messageY, 80, 80);
    await expect(page.locator("[data-mobile-chats]")).toBeVisible();
    await expectAligned(page);
  } finally {
    bot.close();
  }
});

test("mobile history interrupts a gesture aligned", async ({ page }) => {
  await openChat(page);
  const shell = page.locator("[data-mobile-shell]");
  await shell.dispatchEvent("pointerdown", {
    clientX: 5,
    clientY: 300,
    pointerId: 5,
  });
  await shell.dispatchEvent("pointermove", {
    clientX: 120,
    clientY: 300,
    pointerId: 5,
  });
  await page.evaluate(() => dispatchEvent(new PopStateEvent("popstate")));
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await shell.dispatchEvent("pointerup", {
    clientX: 120,
    clientY: 300,
    pointerId: 5,
  });
  await expect(page.locator("[data-swipe]")).toHaveCount(0);
  await expectAligned(page);
});

async function openChat(page: Page): Promise<void> {
  await page.getByRole("button", { name: "#weblounge-test" }).click();
  await expect(
    page.getByRole("heading", { name: "#weblounge-test" }),
  ).toBeVisible();
  await expect(page.locator("[data-position]")).toHaveCount(0);
}

async function drag(
  page: Page,
  pointerId: number,
  endX: number,
  end: string,
): Promise<void> {
  const shell = page.locator("[data-mobile-shell]");
  await shell.dispatchEvent("pointerdown", {
    clientX: 5,
    clientY: 300,
    pointerId,
  });
  await shell.dispatchEvent("pointermove", {
    clientX: endX,
    clientY: 300,
    pointerId,
  });
  await shell.dispatchEvent(end, {
    clientX: endX,
    clientY: 300,
    pointerId,
  });
}

async function panOverTranscript(
  page: Page,
  clientY: number,
  endX: number,
  duration: number,
): Promise<void> {
  await page.evaluate(
    ({ clientY, duration, endX }) => {
      const target = document.elementFromPoint(5, clientY);
      if (target === null) throw new Error("swipe start target is missing");
      const dispatch = (type: string, clientX: number, timeStamp: number) => {
        const event = new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          pointerId: 41,
          pointerType: "touch",
        });
        Object.defineProperty(event, "timeStamp", { value: timeStamp });
        target.dispatchEvent(event);
      };
      dispatch("pointerdown", 5, 1_000);
      dispatch("pointermove", endX, 1_000 + duration / 2);
      dispatch("pointerup", endX, 1_000 + duration);
    },
    { clientY, duration, endX },
  );
}

async function expectAligned(page: Page): Promise<void> {
  const active = page.locator(
    '[data-mobile-shell] > :not([aria-hidden="true"]) > [data-mobile-chats], [data-mobile-shell] > :not([aria-hidden="true"]) > [data-mobile-chat]',
  );
  await expect(active).toHaveCount(1);
  await expect
    .poll(() =>
      active.evaluate((element) => {
        const screen = element.parentElement;
        if (screen === null) throw new Error("mobile screen is missing");
        const box = screen.getBoundingClientRect();
        return {
          left: Math.round(box.left),
          right: Math.round(box.right),
          transform: getComputedStyle(screen).transform,
          viewport: window.innerWidth,
        };
      }),
    )
    .toEqual({ left: 0, right: 402, transform: "none", viewport: 402 });
}
