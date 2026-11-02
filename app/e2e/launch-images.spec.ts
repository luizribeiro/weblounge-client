import { devices, expect, test } from "@playwright/test";
import { emulateStandalone } from "./mobile-platform";

test.use({
  ...devices["iPhone 16 Pro"],
  screen: { height: 874, width: 402 },
  viewport: { height: 874, width: 402 },
});

for (const appearance of ["light", "dark"] as const) {
  test(`iPhone 16 Pro mobile ${appearance} launch chair matches every startup layout`, async ({
    page,
  }) => {
    await emulateStandalone(page);
    await page.emulateMedia({ colorScheme: appearance });
    let releaseConfig = () => undefined;
    const configGate = new Promise<void>((resolve) => {
      releaseConfig = resolve;
    });
    await page.route("**/config.json", async (route) => {
      await configGate;
      await route.fulfill({
        body: '{"mode":"app"}',
        contentType: "application/json",
      });
    });

    try {
      await page.goto("/");
      const splash = page.locator("[data-initial-splash]");
      await expect(splash).toBeVisible();
      await expect(page.locator("#root")).toHaveAttribute(
        "data-display",
        "standalone",
      );
      const launch = page.locator(
        `link[rel="apple-touch-startup-image"][href="/startup/iphone-16-pro-portrait-${appearance}.png"]`,
      );
      await expect(launch).toHaveAttribute(
        "media",
        `(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: ${appearance})`,
      );

      const launchRect = await page.evaluate(
        async (launchHref) => {
          const mark =
            document.querySelector<SVGSVGElement>("[data-splash-mark]");
          if (mark === null) throw new Error("inline splash mark is missing");
          const markColor = rgb(getComputedStyle(mark).color);
          const background = rgb(
            getComputedStyle(mark.closest("[data-initial-splash]") ?? mark)
              .backgroundColor,
          );
          const launchImage = await loadImage(launchHref);
          const launchBox = coloredBounds(
            pixels(
              launchImage,
              launchImage.naturalWidth,
              launchImage.naturalHeight,
            ),
            launchImage.naturalWidth,
            background,
            markColor,
          );

          return {
            bottom: launchBox.bottom / 3,
            left: launchBox.left / 3,
            right: launchBox.right / 3,
            top: launchBox.top / 3,
          };

          async function loadImage(src: string): Promise<HTMLImageElement> {
            const image = new Image();
            image.src = src;
            await image.decode();
            return image;
          }

          function pixels(
            image: CanvasImageSource,
            width: number,
            height: number,
          ): Uint8ClampedArray {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d");
            if (context === null) throw new Error("2D canvas is unavailable");
            context.drawImage(image, 0, 0, width, height);
            return context.getImageData(0, 0, width, height).data;
          }

          function coloredBounds(
            data: Uint8ClampedArray,
            width: number,
            bg: readonly number[],
            fg: readonly number[],
          ) {
            return bounds(data, width, (red, green, blue) => {
              const foregroundDistance = distance([red, green, blue], fg);
              const backgroundDistance = distance([red, green, blue], bg);
              return foregroundDistance < backgroundDistance;
            });
          }

          function bounds(
            data: Uint8ClampedArray,
            width: number,
            includes: (
              red: number,
              green: number,
              blue: number,
              alpha: number,
            ) => boolean,
          ) {
            let left = width;
            let right = 0;
            let top = data.length / 4 / width;
            let bottom = 0;
            for (let index = 0; index < data.length; index += 4) {
              if (
                !includes(
                  data[index] ?? 0,
                  data[index + 1] ?? 0,
                  data[index + 2] ?? 0,
                  data[index + 3] ?? 0,
                )
              )
                continue;
              const pixel = index / 4;
              left = Math.min(left, pixel % width);
              right = Math.max(right, (pixel % width) + 1);
              top = Math.min(top, Math.floor(pixel / width));
              bottom = Math.max(bottom, Math.floor(pixel / width) + 1);
            }
            return { bottom, left, right, top };
          }

          function distance(
            first: readonly number[],
            second: readonly number[],
          ) {
            return first.reduce(
              (sum, value, index) => sum + (value - (second[index] ?? 0)) ** 2,
              0,
            );
          }

          function rgb(value: string): readonly number[] {
            const channels = value.match(/\d+/gu)?.slice(0, 3).map(Number);
            if (channels === undefined || channels.length !== 3) {
              throw new Error(`couldn't parse ${value}`);
            }
            return channels;
          }
        },
        await launch.getAttribute("href"),
      );
      const inlineRects = [];
      for (const layout of [
        { containingBlockHeight: 874, minHeight: true },
        { containingBlockHeight: 812, minHeight: true },
        { containingBlockHeight: 812, minHeight: false },
      ]) {
        inlineRects.push(
          await page.locator("[data-splash-mark]").evaluate((mark, value) => {
            const documentRoot = document.documentElement;
            const appRoot = document.querySelector<HTMLElement>("#root");
            if (appRoot === null) throw new Error("app root is missing");
            documentRoot.style.setProperty("--wl-safe-top", "62px");
            documentRoot.style.setProperty(
              "--wl-splash-screen-block-size",
              "100lvh",
            );
            documentRoot.style.minBlockSize = value.minHeight ? "" : "100%";
            appRoot.style.blockSize = `${value.containingBlockHeight}px`;
            // A transformed ancestor models WebKit's short fixed containing block without shrinking the screen's 100lvh.
            appRoot.style.transform = "translateZ(0)";
            const markRect = mark.getBoundingClientRect();
            const pathBounds = [...mark.querySelectorAll("path")].map((path) =>
              (path as SVGGraphicsElement).getBBox(),
            );
            const left = Math.min(...pathBounds.map((box) => box.x));
            const right = Math.max(
              ...pathBounds.map((box) => box.x + box.width),
            );
            const top = Math.min(...pathBounds.map((box) => box.y));
            const bottom = Math.max(
              ...pathBounds.map((box) => box.y + box.height),
            );
            return {
              bottom: markRect.top + (bottom / 16) * markRect.height,
              left: markRect.left + (left / 16) * markRect.width,
              right: markRect.left + (right / 16) * markRect.width,
              top: markRect.top + (top / 16) * markRect.height,
            };
          }, layout),
        );
      }
      const devicePixelRatio = await page.evaluate(
        () => window.devicePixelRatio,
      );
      const expectedInlineRect = snapRectToDevicePixels(
        inlineRects[0],
        devicePixelRatio,
      );
      for (const inlineRect of inlineRects) {
        // Browser layout floats can differ below a physical pixel; the same painted pixels are the invariant.
        expect(snapRectToDevicePixels(inlineRect, devicePixelRatio)).toEqual(
          expectedInlineRect,
        );
        for (const edge of ["bottom", "left", "right", "top"] as const) {
          expect(launchRect[edge]).toBeCloseTo(inlineRect[edge], 0);
        }
      }
    } finally {
      releaseConfig();
    }
  });
}

function snapRectToDevicePixels(
  rect: Readonly<Record<"bottom" | "left" | "right" | "top", number>>,
  devicePixelRatio: number,
) {
  return {
    bottom: Math.round(rect.bottom * devicePixelRatio) / devicePixelRatio,
    left: Math.round(rect.left * devicePixelRatio) / devicePixelRatio,
    right: Math.round(rect.right * devicePixelRatio) / devicePixelRatio,
    top: Math.round(rect.top * devicePixelRatio) / devicePixelRatio,
  };
}
