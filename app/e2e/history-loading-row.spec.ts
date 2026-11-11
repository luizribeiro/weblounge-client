import { expect, type Locator, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import { scrollToTranscriptTop } from "./message-list-scroll";
import { installNativeFeelInstrumentation } from "./native-feel-audit";
import { useDedicatedWorker } from "./production-ergo";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);
test.skip(
  process.env.WEBLOUNGE_E2E_FORWARDER_URL === undefined,
  "requires the controllable socket forwarder",
);

for (const layout of [
  { name: "desktop", project: "chromium" },
  { name: "iPhone WebKit", project: "webkit-phone-layout" },
] as const) {
  test(`shows the in-flight older-history row at the top on ${layout.name}`, async ({
    baseURL,
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== layout.project, "layout project only");
    const fixture = await seedHistory();
    let incomingPaused = false;
    try {
      await installNativeFeelInstrumentation(page);
      await useDedicatedWorker(page);
      await page.goto(startUrl(baseURL, fixture));
      await page.getByRole("button", { name: fixture.channel }).click();
      await expect(
        page.getByText(fixture.newest, { exact: true }),
      ).toBeVisible();

      const list = page.locator("[data-message-list]");
      const loading = list.locator('[data-divider-kind="loading"]');
      await expect(loading).toHaveCount(0);
      await controlForwarder("pause-incoming");
      incomingPaused = true;
      await scrollToTranscriptTop(list);
      await expect(loading).toHaveCount(1);
      await expect.poll(() => scrollTop(list)).toBe(0);
      await expect(loading).toBeVisible();
      await expect
        .poll(async () => (await viewportOverflow(list, loading)).bottom)
        .toBeLessThanOrEqual(1);
      await expect
        .poll(async () => (await viewportOverflow(list, loading)).top)
        .toBeLessThanOrEqual(1);
      const loader = loading.locator("svg");
      await expect(loader).toHaveCSS("animation-duration", "1.4s");
      await expect.poll(() => activeAnimations(loader)).toBe(1);
      const moving = await sampledTransforms(loader);
      expect(moving.after).not.toBe(moving.before);

      await setNativeVisibility(page, true);
      await expect(
        page.locator('[data-transcript-foreground="false"]'),
      ).toHaveCount(1);
      await expect(loader).toHaveCSS("animation-play-state", "paused");
      await expect.poll(() => activeAnimations(loader)).toBe(0);
      await setNativeVisibility(page, false);
      await expect(loader).toHaveCSS("animation-play-state", "running");

      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(loader).toHaveCSS("animation-duration", "0s");
      const reduced = await sampledTransforms(loader);
      expect(reduced.after).toBe(reduced.before);

      await controlForwarder("resume-incoming");
      incomingPaused = false;
      await expect(loading).toHaveCount(0);
      await expect.poll(() => loadingAnimationCount(page)).toBe(0);
    } finally {
      if (incomingPaused) await controlForwarder("resume-incoming");
      await page.context().close();
      fixture.keeper.close();
      for (const sender of fixture.senders) sender.close();
    }
  });
}

function activeAnimations(loader: Locator): Promise<number> {
  return loader.evaluate(
    (element) =>
      element
        .getAnimations()
        .filter((animation) => animation.playState === "running").length,
  );
}

function loadingAnimationCount(page: Page) {
  return page.evaluate(
    () =>
      document
        .querySelector('[data-divider-kind="loading"] svg')
        ?.getAnimations().length ?? 0,
  );
}

function sampledTransforms(
  loader: Locator,
): Promise<{ readonly after: string; readonly before: string }> {
  return loader.evaluate(
    (element) =>
      new Promise((resolve) => {
        const before = getComputedStyle(element).transform;
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            resolve({ after: getComputedStyle(element).transform, before }),
          ),
        );
      }),
  );
}

function setNativeVisibility(page: Page, hidden: boolean): Promise<void> {
  return page.evaluate((nextHidden) => {
    const setter = Reflect.get(globalThis, "__setNativeVisibility");
    if (typeof setter !== "function")
      throw new Error("native visibility instrumentation is missing");
    setter(nextHidden);
  }, hidden);
}

interface HistoryFixture {
  readonly account: string;
  readonly channel: string;
  readonly keeper: IrcClient;
  readonly newest: string;
  readonly senders: readonly IrcClient[];
}

async function seedHistory(): Promise<HistoryFixture> {
  const suffix = Date.now().toString(36);
  const account = `loading-${suffix}`;
  const channel = `#loading-${suffix}`;
  const keeper = await IrcClient.connectIsolated(account, channel);
  const senders = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      IrcClient.connect(
        `loading-${index}-${suffix}`,
        "weblounge-bot",
        "weblounge-bot-test",
        channel,
      ),
    ),
  );
  const messages = Array.from(
    { length: 140 },
    (_, index) => `loading history ${suffix} ${index}`,
  );
  for (let index = 0; index < messages.length; index += senders.length) {
    await Promise.all(
      senders.map((sender, offset) => {
        const message = messages[index + offset];
        if (message === undefined) return Promise.resolve("");
        return sender.privmsgConfirmed(channel, message);
      }),
    );
  }
  const newest = `loading fence ${suffix}`;
  const writer = senders[0];
  if (writer === undefined) throw new Error("history writer is missing");
  await writer.privmsgConfirmed(channel, newest);
  return { account, channel, keeper, newest, senders };
}

function startUrl(
  baseURL: string | undefined,
  fixture: HistoryFixture,
): string {
  if (baseURL === undefined) throw new Error("Playwright base URL is missing");
  const url = new URL("/", baseURL);
  url.searchParams.set("irc-password", `test-${fixture.account}`);
  url.searchParams.set("irc-account", fixture.account);
  url.searchParams.set("irc-nickname", fixture.account);
  url.searchParams.append("irc-autojoin", fixture.channel);
  return url.href;
}

function scrollTop(list: Locator): Promise<number> {
  return list.evaluate((element) => element.scrollTop);
}

async function viewportOverflow(
  list: Locator,
  row: Locator,
): Promise<{ readonly bottom: number; readonly top: number }> {
  const [viewport, bounds] = await Promise.all([
    list.boundingBox(),
    row.boundingBox(),
  ]);
  if (viewport === null || bounds === null)
    throw new Error("history row geometry is missing");
  return {
    bottom: Math.max(
      0,
      bounds.y + bounds.height - (viewport.y + viewport.height),
    ),
    top: Math.max(0, viewport.y - bounds.y),
  };
}

async function controlForwarder(
  action: "pause-incoming" | "resume-incoming",
): Promise<void> {
  const base = process.env.WEBLOUNGE_E2E_FORWARDER_URL;
  if (base === undefined) throw new Error("forwarder URL is missing");
  const response = await fetch(new URL(`/${action}`, base), { method: "POST" });
  if (!response.ok)
    throw new Error(`forwarder ${action} failed: ${response.status}`);
}
