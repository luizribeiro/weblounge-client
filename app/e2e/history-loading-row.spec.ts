import type { Locator, Page } from "@playwright/test";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
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
    page,
    irc,
  }, testInfo) => {
    test.skip(testInfo.project.name !== layout.project, "layout project only");
    const fixture = await seedHistory(irc);
    await installNativeFeelInstrumentation(page);
    await useDedicatedWorker(page);
    await page.goto(irc.url());
    await page.getByRole("button", { name: fixture.channel }).click();
    await expect(page.getByText(fixture.newest, { exact: true })).toBeVisible();

    const list = page.locator("[data-message-list]");
    const loading = list.locator('[data-divider-kind="loading"]');
    await expect(loading).toHaveCount(0);
    await irc.forwarder.pauseIncoming();
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

    await irc.forwarder.resumeIncoming();
    await expect(loading).toHaveCount(0);
    await expect.poll(() => loadingAnimationCount(page)).toBe(0);
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
  readonly channel: string;
  readonly newest: string;
}

async function seedHistory(irc: IrcTestAccount): Promise<HistoryFixture> {
  const suffix = irc.id;
  const channel = irc.channel;
  await irc.self([channel]);
  const senders = await Promise.all(
    Array.from({ length: 10 }, (_, index) => irc.peer(`loading-${index}`)),
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
  return { channel, newest };
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
