import { expect, test } from "@playwright/test";
import { IrcClient } from "./irc-client";

const ready = "Engine ready: wasm worker round trip complete";

test("handshakes through the SharedWorker", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("status")).toHaveText(ready);
  await expect(page.getByRole("note")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => typeof SharedWorker))
    .toBe("function");
});

test("handshakes through the dedicated Worker fallback", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto("/");

  await expect(page.getByRole("status")).toHaveText(ready);
  await expect(page.getByRole("note")).toContainText("one connection per tab");
  await expect
    .poll(() => page.evaluate(() => typeof SharedWorker))
    .toBe("undefined");
});

test.describe("local Ergo user flow", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("sends, receives, and counts a mention", async ({ page }) => {
    await page.goto("/?irc-password=weblounge-test");
    await expect(page).toHaveURL(/^(?!.*irc-password)/);
    await expect(
      page.getByRole("heading", { name: /#weblounge-test/ }),
    ).toBeVisible();

    const ownText = `from browser ${Date.now()}`;
    await observeDeliveries(page, ownText);
    await page.getByRole("textbox", { name: "Message" }).fill(ownText);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(`${ownText} [confirmed]`, { exact: false }),
    ).toBeVisible();
    await expect
      .poll(() => observedDeliveries(page))
      .toEqual(expect.arrayContaining(["optimistic", "confirmed"]));

    const bot = await IrcClient.connect(
      "weblounge-bot",
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    try {
      bot.privmsg("#weblounge-test", "hello from the test bot");
      await expect(
        page.getByText(/hello from the test bot \[received\]/),
      ).toBeVisible();
      bot.privmsg("#weblounge-test", "hello weblounge, this is a mention");
      await expect(
        page.getByRole("heading", { name: /1 mentions/ }),
      ).toBeVisible();
    } finally {
      bot.close();
    }
  });

  test("broadcasts pending and confirmed sends to a second tab", async ({
    context,
    page: secondTab,
  }) => {
    await secondTab.goto("/");
    await expect(secondTab.getByRole("status")).toHaveText(ready);
    const firstTab = await context.newPage();
    await firstTab.goto("/?irc-password=weblounge-test");
    await expect(
      firstTab.getByRole("heading", { name: /#weblounge-test/ }),
    ).toBeVisible();
    await expect(
      secondTab.getByRole("heading", { name: /#weblounge-test/ }),
    ).toBeVisible();

    const text = `shared send ${Date.now()}`;
    await observeDeliveries(secondTab, text);
    await firstTab.getByRole("textbox", { name: "Message" }).fill(text);
    await firstTab.getByRole("button", { name: "Send" }).click();
    await expect(
      secondTab.getByText(`${text} [confirmed]`, { exact: false }),
    ).toBeVisible();

    await expect
      .poll(() => observedDeliveries(secondTab))
      .toEqual(expect.arrayContaining(["optimistic", "confirmed"]));
  });
});

async function observeDeliveries(
  page: import("@playwright/test").Page,
  text: string,
): Promise<void> {
  await page.evaluate((messageText) => {
    const state = window as Window & { observedDeliveries?: string[] };
    state.observedDeliveries = [];
    const record = () => {
      for (const row of document.querySelectorAll<HTMLElement>(
        `[data-message-text="${CSS.escape(messageText)}"]`,
      )) {
        const delivery = row.dataset.delivery;
        if (
          delivery !== undefined &&
          !state.observedDeliveries?.includes(delivery)
        ) {
          state.observedDeliveries?.push(delivery);
        }
      }
    };
    new MutationObserver(record).observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    record();
  }, text);
}

async function observedDeliveries(
  page: import("@playwright/test").Page,
): Promise<string[]> {
  return page.evaluate(
    () =>
      (window as Window & { observedDeliveries?: string[] })
        .observedDeliveries ?? [],
  );
}
