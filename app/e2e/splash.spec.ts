import { expect, test } from "@playwright/test";

const appearances = [
  {
    background: "rgb(243, 241, 233)",
    mark: "rgb(78, 98, 68)",
    name: "light",
  },
  {
    background: "rgb(24, 34, 30)",
    mark: "rgb(189, 217, 167)",
    name: "dark",
  },
] as const;

for (const appearance of appearances) {
  test(`${appearance.name} desktop splash waits for the engine`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name === "webkit-splash-mobile",
      "covered by the iPhone splash case",
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await verifySplash(page, appearance, testInfo);
  });

  test.describe(`${appearance.name} touch-primary splash`, () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 402, height: 874 },
    });

    test(`${appearance.name} mobile splash waits for the engine`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name === "webkit-splash-desktop",
        "covered by the desktop splash case",
      );
      await verifySplash(page, appearance, testInfo);
    });
  });
}

async function verifySplash(
  page: import("@playwright/test").Page,
  appearance: (typeof appearances)[number],
  testInfo: import("@playwright/test").TestInfo,
): Promise<void> {
  await page.emulateMedia({ colorScheme: appearance.name });
  await page.addInitScript(() => {
    const observed = window as unknown as {
      __webloungeCspViolations: Array<{
        blocked: string;
        directive: string;
        source: string;
      }>;
      __webloungeReleaseEngine: () => void;
    };
    observed.__webloungeCspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      observed.__webloungeCspViolations.push({
        blocked: event.blockedURI,
        directive: event.violatedDirective,
        source: event.sourceFile,
      });
    });
    class HeldEnginePort extends EventTarget {
      released = false;

      close(): void {}
      postMessage(message: unknown): void {
        if (!this.released || !isRecord(message)) return;
        const payload = message.payload;
        if (
          message.type !== "request" ||
          !isRecord(payload) ||
          typeof payload.id !== "string" ||
          !isRecord(payload.request) ||
          payload.request.type !== "diagnostic" ||
          typeof payload.request.message !== "string"
        ) {
          return;
        }
        queueMicrotask(() => {
          this.emit({
            type: "diagnostic",
            command_id: payload.id,
            message: payload.request.message,
          });
          this.emit({ type: "command_result", id: payload.id });
        });
      }
      start(): void {}
      release(): void {
        this.released = true;
        this.emit({
          type: "ready",
          engine_instance: "held-splash-engine",
          revision: 0,
        });
      }
      private emit(data: unknown): void {
        this.dispatchEvent(new MessageEvent("message", { data }));
      }
    }
    const port = new HeldEnginePort();
    Object.defineProperty(window, "SharedWorker", {
      configurable: true,
      value: class {
        readonly port = port;
      },
    });
    observed.__webloungeReleaseEngine = () => port.release();

    function isRecord(value: unknown): value is Record<string, unknown> {
      return typeof value === "object" && value !== null;
    }
  });
  const consoleErrors: string[] = [];
  let fontRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/fonts/inter-latin.woff2")) fontRequests += 1;
  });
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleErrors.push(message.text());
    }
  });

  let released = false;
  const releaseEngine = async () => {
    if (released) return;
    released = true;
    await page.evaluate(() => {
      (
        window as unknown as { __webloungeReleaseEngine: () => void }
      ).__webloungeReleaseEngine();
    });
  };

  try {
    const response = await page.goto("/");
    expect(response?.headers()["content-security-policy"]).toContain(
      "style-src 'self'",
    );
    const splash = page.locator("[data-initial-splash]");
    await expect(splash).toBeVisible();
    await expect(page.getByRole("heading", { name: "weblounge" })).toHaveCount(
      0,
    );
    await expect(page.locator("[data-splash-status]")).toHaveCSS(
      "opacity",
      "1",
    );

    const colors = await splash.evaluate((element) => {
      const mark = element.querySelector("[data-splash-mark] path");
      if (mark === null) throw new Error("splash mark is missing");
      return {
        background: getComputedStyle(element).backgroundColor,
        fill: getComputedStyle(mark).fill,
      };
    });
    expect(colors).toEqual({
      background: appearance.background,
      fill: appearance.mark,
    });
    expect(contrastRatio(colors.background, colors.fill)).toBeGreaterThan(3);

    await page.evaluate(() => document.fonts.ready);
    expect(fontRequests).toBe(1);
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              __webloungeCspViolations: Array<{
                blocked: string;
                directive: string;
                source: string;
              }>;
            }
          ).__webloungeCspViolations,
      ),
    ).toEqual([]);
    expect(
      consoleErrors.filter((message) =>
        /content security policy|preload.*not used/iu.test(message),
      ),
    ).toEqual([]);

    const screenshot = await page.screenshot();
    await testInfo.attach(
      `${appearance.name}-${testInfo.title.includes("mobile") ? "mobile" : "desktop"}-splash`,
      { body: screenshot, contentType: "image/png" },
    );

    await releaseEngine();
    await expect(
      page.getByRole("heading", { name: "weblounge" }),
    ).toBeVisible();
    await expect(splash).toHaveCount(0);
    expect(
      consoleErrors.filter((message) => /preload.*not used/iu.test(message)),
    ).toEqual([]);
  } finally {
    await releaseEngine().catch(() => undefined);
  }
}

function contrastRatio(background: string, foreground: string): number {
  const first = luminance(background);
  const second = luminance(foreground);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function luminance(color: string): number {
  const channels = color.match(/\d+/g)?.slice(0, 3).map(Number);
  if (channels === undefined || channels.length !== 3) {
    throw new Error(`couldn't parse ${color}`);
  }
  const [red = 0, green = 0, blue = 0] = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
