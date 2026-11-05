import { expect, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import { installNativeFeelInstrumentation } from "./native-feel-audit";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

for (const cycle of ["visible", "hidden", "reconnecting"] as const) {
  test(`confirms a DM after its unshared peer returns while ${cycle}`, async ({
    context,
    page,
  }) => {
    await installNativeFeelInstrumentation(page);
    const suffix = `${cycle.slice(0, 1)}${Date.now().toString().slice(-6)}`;
    const nick = `return-${suffix}`;
    let peer = await connectPeer(nick);
    const watcher = await connectPeer(`watch-${suffix}`);
    try {
      await page.goto("/?irc-password=weblounge-test");
      await expect(page.locator('[data-network-state="online"]')).toHaveCount(
        1,
      );
      const opening = `open returned peer ${suffix}`;
      await peer.privmsgConfirmed("weblounge", opening);
      const direct = page.getByRole("button", {
        name: new RegExp(`^${nick}(?:,|$)`),
      });
      await expect(direct).toBeVisible();
      await direct.click();
      await expect(page.getByText(opening, { exact: true })).toBeVisible();
      await expectTitleSettled(page);

      if (cycle === "hidden") await setVisibility(page, true);
      if (cycle === "reconnecting") {
        await context.setOffline(true);
        await expect.poll(() => networkState(page)).not.toBe("online");
      }

      const departure = watcher.waitForNickDeparture(nick);
      peer.close();
      await peer.waitForDisconnect();
      await departure;
      const offlineBarrier = `offline barrier ${suffix}`;
      await watcher.privmsgConfirmed("weblounge", offlineBarrier);
      if (cycle !== "hidden") await expectOfflineBarrier(page, watcher);
      peer = await connectPeer(nick);

      if (cycle === "hidden") {
        await setVisibility(page, false);
        await expectOfflineBarrier(page, watcher);
      }
      if (cycle === "reconnecting") {
        await context.setOffline(false);
        await dispatchPersistedPageShow(page);
        await expect(page.locator('[data-network-state="online"]')).toHaveCount(
          1,
        );
        await expectTitleSettled(page);
      }

      const reply = `reply to returned peer ${suffix}`;
      const composer = page.getByRole("textbox", { name: `Message ${nick}` });
      await expect(composer).toBeEnabled();
      await composer.fill(reply);
      await composer.press("Enter");
      await expect(
        page
          .locator('[data-message-row][data-delivery="confirmed"]')
          .filter({ has: page.getByText(reply, { exact: true }) }),
      ).toHaveCount(1);
      await expect(
        page.getByText("Messages can't be sent to this conversation."),
      ).toHaveCount(0);
      await expectTitleSettled(page);
      await peer.waitForPrivmsg(peer.nickname, reply, "weblounge");
    } finally {
      await context.setOffline(false);
      peer.close();
      watcher.close();
    }
  });
}

function connectPeer(nick: string): Promise<IrcClient> {
  return IrcClient.connectWithoutJoin(
    nick,
    "weblounge-bot",
    "weblounge-bot-test",
  );
}

async function expectOfflineBarrier(
  page: Page,
  watcher: IrcClient,
): Promise<void> {
  await expect(
    page.getByRole("button", {
      name: new RegExp(`^${watcher.nickname}(?:,|$)`),
    }),
  ).toBeVisible();
}

async function expectTitleSettled(page: Page): Promise<void> {
  const title = page.locator("[data-conversation-title]");
  await expect(title).toHaveText(/^return-/u);
  await expect(title).not.toHaveAttribute("data-connection-progress");
}

async function networkState(page: Page): Promise<string | null> {
  return page
    .locator("[data-network-state]")
    .first()
    .getAttribute("data-network-state");
}

async function setVisibility(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((nextHidden) => {
    const setter = Reflect.get(globalThis, "__setNativeVisibility");
    if (typeof setter !== "function")
      throw new Error("visibility control is missing");
    setter(nextHidden);
  }, hidden);
}

async function dispatchPersistedPageShow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const event = new Event("pageshow");
    Object.defineProperty(event, "persisted", { value: true });
    window.dispatchEvent(event);
  });
}
