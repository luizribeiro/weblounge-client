import { expect, type Page, test } from "@playwright/test";
import { installNativeFeelInstrumentation } from "./native-feel-audit";

const channel = "#weblounge-test";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

for (const shell of ["desktop", "mobile"] as const) {
  test.describe(`${shell} conversation title`, () => {
    if (shell === "mobile") {
      test.use({
        hasTouch: true,
        isMobile: true,
        viewport: { height: 874, width: 402 },
      });
    }

    test("fills while history resolves and stops when current", async ({
      page,
    }) => {
      await installNativeFeelInstrumentation(page);
      await holdSyncedBufferProjection(page, channel);
      await openChannel(page, shell);
      const title = page.locator("[data-conversation-title]");

      await expect(title).toHaveAttribute("data-connection-phase", "loading");
      await expect(title).toHaveCSS("animation-duration", "1s");
      await expect(title).toHaveCSS("background-clip", "text");

      await pauseSweep(title);
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await page.screenshot({
          path: `e2e/screenshots/conversation-title-${shell}-${theme}.png`,
        });
      }
      await resumeSweep(title);

      await setVisibility(page, true);
      await expect(title).not.toHaveAttribute("data-connection-visible");
      await expect(title).toHaveCSS("animation-play-state", "paused");
      await setVisibility(page, false);
      await expect(title).toHaveCSS("animation-play-state", "running");

      await releaseSyncedBufferProjection(page);
      await expect(title).not.toHaveAttribute("data-connection-progress");
      expect(await runningAnimations(title)).toBe(0);
    });

    test("uses a static dim title with reduced motion", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await holdSyncedBufferProjection(page, channel);
      await openChannel(page, shell);
      const title = page.locator("[data-conversation-title]");

      await expect(title).toHaveAttribute("data-connection-phase", "reduced");
      expect(await runningAnimations(title)).toBe(0);
      await expect(title).toHaveCSS("color", /^(?:color|rgba?)\(/u);
      await releaseSyncedBufferProjection(page);
      await expect(title).not.toHaveAttribute("data-connection-progress");
      expect(await runningAnimations(title)).toBe(0);
    });
  });
}

async function openChannel(page: Page, shell: "desktop" | "mobile") {
  await page.goto("/?irc-password=weblounge-test");
  await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
  if (shell === "mobile") {
    const channelButton = page.getByRole("button", { name: channel });
    await expect(channelButton).toBeVisible();
    await channelButton.click();
    const active = page.locator(
      '[data-mobile-shell] > :not([aria-hidden="true"]) > [data-mobile-chat]',
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
  await expect(page.getByRole("heading", { name: channel })).toBeVisible();
}

function runningAnimations(locator: ReturnType<Page["locator"]>) {
  return locator.evaluate(
    (element) =>
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState === "running").length,
  );
}

async function pauseSweep(locator: ReturnType<Page["locator"]>): Promise<void> {
  await locator.evaluate((element) => {
    const animation = element.getAnimations()[0];
    if (animation === undefined) throw new Error("title sweep is missing");
    animation.pause();
    animation.currentTime = 500;
  });
}

async function resumeSweep(
  locator: ReturnType<Page["locator"]>,
): Promise<void> {
  await locator.evaluate((element) => element.getAnimations()[0]?.play());
}

async function setVisibility(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((nextHidden) => {
    const setter = Reflect.get(globalThis, "__setNativeVisibility");
    if (typeof setter !== "function")
      throw new Error("visibility control is missing");
    setter(nextHidden);
  }, hidden);
}

async function holdSyncedBufferProjection(
  page: Page,
  title: string,
): Promise<void> {
  await page.addInitScript((targetTitle) => {
    const addListener = MessagePort.prototype.addEventListener;
    const held: Array<{
      event: MessageEvent<unknown>;
      listener: EventListenerOrEventListenerObject;
      port: MessagePort;
    }> = [];
    let released = false;
    let syncingBufferId: number | undefined;
    const state = {
      release: () => {
        released = true;
        for (const item of held.splice(0)) {
          if (typeof item.listener === "function")
            item.listener.call(item.port, item.event);
          else item.listener.handleEvent(item.event);
        }
      },
    };
    Reflect.set(globalThis, "__titleShimmerGate", state);
    MessagePort.prototype.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type !== "message" || listener === null) {
        addListener.call(this, type, listener, options);
        return;
      }
      const wrapped: EventListener = (rawEvent) => {
        const event = rawEvent as MessageEvent<unknown>;
        const projected = projectedBuffers(event.data);
        const syncing = projected.find(
          (buffer) =>
            buffer.title === targetTitle && buffer.sync_state === "syncing",
        );
        if (syncing !== undefined) syncingBufferId = syncing.id;
        if (
          syncingBufferId !== undefined &&
          projected.some(
            (buffer) =>
              buffer.id === syncingBufferId && buffer.sync_state === "synced",
          )
        ) {
          if (!released) {
            held.push({ event, listener, port: this });
            return;
          }
        }
        if (typeof listener === "function") listener.call(this, event);
        else listener.handleEvent(event);
      };
      addListener.call(this, type, wrapped, options);
    };

    interface ProjectedBuffer {
      readonly id: number;
      readonly sync_state: string;
      readonly title: string;
    }

    function projectedBuffers(value: unknown): readonly ProjectedBuffer[] {
      if (!isRecord(value)) return [];
      if (isProjectedBuffer(value.buffer)) return [value.buffer];
      return Array.isArray(value.buffers)
        ? value.buffers.filter(isProjectedBuffer)
        : [];
    }

    function isProjectedBuffer(value: unknown): value is ProjectedBuffer {
      return (
        isRecord(value) &&
        typeof value.id === "number" &&
        typeof value.title === "string" &&
        typeof value.sync_state === "string"
      );
    }

    function isRecord(value: unknown): value is Record<string, unknown> {
      return typeof value === "object" && value !== null;
    }
  }, title);
}

async function releaseSyncedBufferProjection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const gate = Reflect.get(globalThis, "__titleShimmerGate");
    if (
      typeof gate !== "object" ||
      gate === null ||
      !("release" in gate) ||
      typeof gate.release !== "function"
    )
      throw new Error("title shimmer gate is missing");
    gate.release();
  });
}
