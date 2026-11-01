import { expect, test } from "@playwright/test";

for (const appearance of ["light", "dark"] as const) {
  test(`iPhone 16 Pro ${appearance} launch chair matches the inline splash`, async ({
    page,
  }) => {
    await page.setViewportSize({ height: 874, width: 402 });
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
      const launch = page.locator(
        `link[rel="apple-touch-startup-image"][href="/startup/iphone-16-pro-portrait-${appearance}.png"]`,
      );
      await expect(launch).toHaveAttribute(
        "media",
        `(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: ${appearance})`,
      );

      const positions = await page.evaluate(
        async (launchHref) => {
          const mark =
            document.querySelector<SVGSVGElement>("[data-splash-mark]");
          if (mark === null) throw new Error("inline splash mark is missing");
          const markRect = mark.getBoundingClientRect();
          const pathBounds = [...mark.querySelectorAll("path")].map((path) =>
            path.getBBox(),
          );
          const vectorLeft = Math.min(...pathBounds.map((box) => box.x));
          const vectorTop = Math.min(...pathBounds.map((box) => box.y));
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
            inline: {
              left: markRect.left + (vectorLeft / 16) * markRect.width,
              top: markRect.top + (vectorTop / 16) * markRect.height,
            },
            launch: {
              left: launchBox.left / 3,
              top: launchBox.top / 3,
            },
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
            let top = data.length / 4 / width;
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
              top = Math.min(top, Math.floor(pixel / width));
            }
            return { left, top };
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
      expect(positions.launch.left).toBeCloseTo(positions.inline.left, 0);
      expect(positions.launch.top).toBeCloseTo(positions.inline.top, 0);
    } finally {
      releaseConfig();
    }
  });
}
