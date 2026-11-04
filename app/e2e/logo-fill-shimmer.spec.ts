import { expect, type Locator, type Page, test } from "@playwright/test";

const frameTimes = [0, 100, 150, 200, 250, 300, 350, 400, 500, 650];

for (const shell of ["desktop", "mobile"] as const) {
  test.describe(`${shell} connection brand`, () => {
    if (shell === "mobile") {
      test.use({
        hasTouch: true,
        isMobile: true,
        viewport: { height: 874, width: 402 },
      });
    }

    test("moves one rendered fill band from logo through title and settles", async ({
      browserName,
      page,
    }) => {
      await installDelayedLiveListEngine(page);
      await page.goto("/");
      const brand = connectionBrand(page, shell);
      await expect(brand).toHaveAttribute("data-connection-phase", "loading");
      await page.evaluate(() => {
        const setHidden = Reflect.get(globalThis, "setLogoFillHidden");
        if (typeof setHidden !== "function") throw new Error("setter missing");
        setHidden(true);
      });
      await expect(brand).not.toHaveAttribute("data-connection-visible");
      await expect(brand).toHaveCSS("animation-play-state", "paused");
      await page.evaluate(() => {
        const setHidden = Reflect.get(globalThis, "setLogoFillHidden");
        if (typeof setHidden !== "function") throw new Error("setter missing");
        setHidden(false);
      });
      await expect(brand).toHaveCSS("animation-play-state", "running");

      const frames = [];
      for (const time of frameTimes)
        frames.push(await captureFrame(brand, time));
      if (browserName === "firefox") {
        await captureFrame(brand, 300);
        await brand.screenshot({
          animations: "allow",
          path: `e2e/screenshots/logo-fill-firefox-${shell}-mid.png`,
          scale: "css",
        });
      }
      expect(frames.map((frame) => frame.progress)).toEqual(
        [...frames.map((frame) => frame.progress)].sort((a, b) => a - b),
      );

      const baseline = frames[0];
      if (baseline === undefined) throw new Error("missing baseline frame");
      const logoChanges = frames.map((frame) =>
        maxPixelChange(baseline, frame, frame.logo),
      );
      const titleChanges = frames.map((frame) =>
        maxPixelChange(baseline, frame, frame.title),
      );
      const logoStart = firstChangedFrame(logoChanges);
      const titleStart = firstChangedFrame(titleChanges);
      expect(logoStart).toBeGreaterThan(0);
      expect(titleStart).toBeGreaterThan(logoStart);
      for (let index = logoStart; index <= titleStart; index += 1) {
        expect(
          Math.max(logoChanges[index] ?? 0, titleChanges[index] ?? 0),
        ).toBeGreaterThan(10);
      }

      await brand.evaluate((element) => {
        for (const animation of element.getAnimations({ subtree: true }))
          animation.play();
        const release = Reflect.get(globalThis, "releaseLiveChatList");
        if (typeof release !== "function") throw new Error("release missing");
        release();
      });
      await expect(brand).toHaveAttribute("data-connection-phase", "finishing");
      await expect(brand).toHaveAttribute("data-connection-phase", "filling");
      await expect(brand).not.toHaveAttribute("data-connection-progress");

      const finalFrame = await captureStillFrame(brand);
      expect(
        maxPixelChange(baseline, finalFrame, finalFrame.logo),
      ).toBeGreaterThan(10);
      expect(
        maxPixelChange(baseline, finalFrame, finalFrame.title),
      ).toBeGreaterThan(10);
      expect(
        await brand.evaluate(
          (element) =>
            element
              .getAnimations({ subtree: true })
              .filter((animation) => animation.playState === "running").length,
        ),
      ).toBe(0);
    });

    test("uses a static partial fill with reduced motion", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await installDelayedLiveListEngine(page);
      await page.goto("/");
      const brand = connectionBrand(page, shell);

      await expect(brand).toHaveAttribute("data-connection-phase", "reduced");
      expect(
        await brand.evaluate((element) => element.getAnimations().length),
      ).toBe(0);
      await expect(brand.locator("[data-connection-fill]")).toHaveCSS(
        "opacity",
        "0.45",
      );

      await page.evaluate(() => {
        const release = Reflect.get(globalThis, "releaseLiveChatList");
        if (typeof release !== "function") throw new Error("release missing");
        release();
      });
      await expect(brand).not.toHaveAttribute("data-connection-progress");
      expect(
        await brand.evaluate((element) => element.getAnimations().length),
      ).toBe(0);
    });
  });
}

interface Rect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

interface Frame {
  readonly height: number;
  readonly logo: Rect;
  readonly pixels: readonly number[];
  readonly progress: number;
  readonly title: Rect;
  readonly width: number;
}

function connectionBrand(page: Page, shell: "desktop" | "mobile"): Locator {
  const root = shell === "mobile" ? "[data-mobile-chats]" : "[data-sidebar]";
  return page.locator(`${root} [data-connection-brand]`);
}

async function captureFrame(brand: Locator, time: number): Promise<Frame> {
  await brand.evaluate(async (element, currentTime) => {
    const animations = element
      .getAnimations({ subtree: true })
      .filter((candidate) => candidate.effect?.getTiming().duration === 1000);
    if (animations.length === 0) throw new Error("brand sweep is missing");
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = currentTime;
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }, time);
  const geometry = await brand.evaluate(frameGeometry);
  return decodeScreenshot(brand, geometry);
}

async function captureStillFrame(brand: Locator): Promise<Frame> {
  return decodeScreenshot(brand, await brand.evaluate(frameGeometry));
}

function frameGeometry(element: Element) {
  const bounds = element.getBoundingClientRect();
  const relativeRect = (selector: string) => {
    const child = element.querySelector(selector);
    if (child === null) throw new Error(`${selector} is missing`);
    const rect = child.getBoundingClientRect();
    return {
      height: Math.round(rect.height),
      width: Math.round(rect.width),
      x: Math.round(rect.x - bounds.x),
      y: Math.round(rect.y - bounds.y),
    };
  };
  return {
    height: Math.round(bounds.height),
    logo: relativeRect("[data-connection-logo]"),
    progress: Number(
      element.getAnimations().find((animation) => {
        return animation.effect?.getTiming().duration === 1000;
      })?.currentTime ?? 0,
    ),
    title: relativeRect("[data-connection-title]"),
    width: Math.round(bounds.width),
  };
}

async function decodeScreenshot(
  brand: Locator,
  geometry: Omit<Frame, "pixels">,
): Promise<Frame> {
  const image = await brand.screenshot({ animations: "allow", scale: "css" });
  const pixels = await brand.page().evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) =>
      character.charCodeAt(0),
    );
    const source = await createImageBitmap(
      new Blob([bytes], { type: "image/png" }),
    );
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("canvas context unavailable");
    context.drawImage(source, 0, 0);
    return [...context.getImageData(0, 0, canvas.width, canvas.height).data];
  }, image.toString("base64"));
  return { ...geometry, pixels };
}

function firstChangedFrame(changes: readonly number[]): number {
  return changes.findIndex((change) => change > 10);
}

function maxPixelChange(baseline: Frame, frame: Frame, rect: Rect): number {
  let maximum = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const offset = (y * frame.width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        maximum = Math.max(
          maximum,
          Math.abs(
            (frame.pixels[offset + channel] ?? 0) -
              (baseline.pixels[offset + channel] ?? 0),
          ),
        );
      }
    }
  }
  return maximum;
}

async function installDelayedLiveListEngine(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let hidden = false;
    Object.defineProperties(document, {
      hidden: { configurable: true, get: () => hidden },
      visibilityState: {
        configurable: true,
        get: () => (hidden ? "hidden" : "visible"),
      },
    });
    Reflect.set(globalThis, "setLogoFillHidden", (next: boolean) => {
      hidden = next;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    class DelayedLiveListPort extends EventTarget {
      postMessage(message: unknown): void {
        if (!isRecord(message)) return;
        if (message.type === "hello") {
          this.emit({
            type: "ready",
            engine_instance: "logo-fill-engine",
            revision: 0,
          });
          return;
        }
        const payload = message.payload;
        if (!isRecord(payload) || typeof payload.id !== "string") return;
        const request = payload.request;
        if (isRecord(request) && request.type === "diagnostic") {
          this.emit({
            type: "diagnostic",
            command_id: payload.id,
            message: "wasm worker round trip complete",
          });
          this.emit({
            type: "network_state_changed",
            network: {
              id: 1,
              label: "Local Ergo",
              nickname: "weblounge",
              state: "online",
            },
          });
          this.emit({
            type: "chat_list_snapshot_loaded",
            network_id: 1,
            buffers: [buffer(2, "#cached", true)],
          });
        }
        this.emit({ type: "command_result", id: payload.id });
      }

      start(): void {}
      close(): void {}

      releaseLiveList(): void {
        this.emit({
          type: "chat_list_live",
          network_id: 1,
          buffers: [buffer(3, "#live", false)],
        });
      }

      private emit(data: unknown): void {
        this.dispatchEvent(new MessageEvent("message", { data }));
      }
    }
    const buffer = (id: number, title: string, cached: boolean) => ({
      id,
      network_id: 1,
      kind: "channel",
      sync_state: cached ? "pending" : "synced",
      title,
      draft_key: `test:${title}`,
      topic: null,
      member_count: 0,
      unread: 0,
      mentions: 0,
      read_through: null,
      ...(cached ? { cached: true, cached_preview: "seeded cache" } : {}),
    });
    const port = new DelayedLiveListPort();
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: class {
        readonly port = port;
      },
    });
    Reflect.set(globalThis, "releaseLiveChatList", () =>
      port.releaseLiveList(),
    );

    function isRecord(value: unknown): value is Record<string, unknown> {
      return typeof value === "object" && value !== null;
    }
  });
}
