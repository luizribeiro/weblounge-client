import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContextOptions, Locator, Page } from "@playwright/test";
import { expectEdgesAligned, firstLineGeometry } from "./composer-geometry";
import { expect, test } from "./irc-fixture";
import { choose, choosePhoneAppearance } from "./settings-fixture";
import { expectSettled } from "./settled";
import { waitForStableGeometry } from "./stable-geometry";

const screenshotDirectory = path.join(
  process.cwd(),
  "e2e",
  "screenshots",
  "composer-line-height",
);

const centreTolerancePx = 1;

const themes = [
  "Lounge",
  "Lounge Night",
  "Black",
  "Modern",
  "Terminal",
  "Retro",
  "Monokai",
  "Earthsong",
] as const;

interface Layout {
  readonly name: string;
  readonly context: BrowserContextOptions;
  chooseTheme(page: Page, theme: string): Promise<void>;
  expectSendAligned(page: Page, input: Locator): Promise<void>;
}

const layouts: readonly Layout[] = [
  {
    name: "desktop",
    context: {
      deviceScaleFactor: 2,
      hasTouch: false,
      isMobile: false,
      viewport: { width: 1_280, height: 800 },
    },
    async chooseTheme(page, theme) {
      await page
        .getByRole("complementary", { name: "Channel list" })
        .getByRole("button", { name: "Settings" })
        .click();
      await choose(page, theme);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
    },
    async expectSendAligned(page, input) {
      const send = page.getByRole("button", { name: "Send" });
      await expectEdgesAligned(input, send);
    },
  },
  {
    name: "phone",
    context: {
      deviceScaleFactor: 3,
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    },
    async chooseTheme(page, theme) {
      await choosePhoneAppearance(page, [theme]);
    },
    async expectSendAligned(_page, input) {
      const line = await firstLineGeometry(input);
      expect(Math.abs(line.textCenter - line.sendCenter)).toBeLessThanOrEqual(
        centreTolerancePx,
      );
    },
  },
];

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

for (const layout of layouts) {
  test.describe(`${layout.name} composer line height`, () => {
    for (const theme of themes) {
      test(`${theme} sizes the field in whole font lines`, async ({
        browser,
        baseURL,
        irc,
      }) => {
        const context = await browser.newContext({
          baseURL,
          ...layout.context,
        });
        await irc.scope(context);
        const page = await context.newPage();
        try {
          await page.goto(irc.url());
          await layout.chooseTheme(page, theme);
          await page.getByRole("button", { name: irc.channel }).click();
          await expectSettled(page, { conversation: irc.channel });
          const input = page.getByRole("textbox", {
            name: `Message ${irc.channel}`,
          });

          await input.fill("Mg");
          await waitForStableGeometry(input);
          await capture(input, `${layout.name}-${theme}.png`);
          await expectCentredSingleLine(input);
          await layout.expectSendAligned(page, input);
          await expectGrowsByWholeLines(input);
        } finally {
          await context.close();
        }
      });
    }
  });
}

interface FieldLines {
  readonly clientHeight: number;
  readonly lineHeight: number;
  readonly maxRows: number;
  readonly paddingBottom: number;
  readonly paddingTop: number;
  readonly scrollHeight: number;
}

async function fieldLines(input: Locator): Promise<FieldLines> {
  return input.evaluate(async (element) => {
    await document.fonts.ready;
    const style = getComputedStyle(element);
    return {
      clientHeight: element.clientHeight,
      lineHeight: Number.parseFloat(style.lineHeight),
      maxRows: Number.parseInt(
        style.getPropertyValue("--wl-composer-max-rows"),
        10,
      ),
      paddingBottom: Number.parseFloat(style.paddingBottom),
      paddingTop: Number.parseFloat(style.paddingTop),
      scrollHeight: element.scrollHeight,
    };
  });
}

async function expectCentredSingleLine(input: Locator): Promise<void> {
  const lines = await fieldLines(input);
  expect(lines.lineHeight).toBeGreaterThan(0);
  expect(lines.paddingTop).toBeCloseTo(lines.paddingBottom, 1);
  expect(lines.clientHeight).toBeCloseTo(
    lines.lineHeight + lines.paddingTop + lines.paddingBottom,
    0,
  );
  expect(lines.scrollHeight).toBe(lines.clientHeight);
  const line = await firstLineGeometry(input);
  expect(Math.abs(line.textCenter - line.fieldCenter)).toBeLessThanOrEqual(
    centreTolerancePx,
  );
}

async function expectGrowsByWholeLines(input: Locator): Promise<void> {
  const single = await fieldLines(input);
  expect(single.maxRows).toBeGreaterThan(1);
  for (let rows = 2; rows <= single.maxRows; rows += 1) {
    await input.fill(linesOf(rows));
    await waitForStableGeometry(input);
    const grown = await fieldLines(input);
    expect(grown.clientHeight).toBe(
      single.clientHeight + (rows - 1) * single.lineHeight,
    );
    expect(grown.scrollHeight).toBe(grown.clientHeight);
  }
  const capped = await fieldLines(input);
  await input.fill(linesOf(single.maxRows + 1));
  await waitForStableGeometry(input);
  const overflowing = await fieldLines(input);
  expect(overflowing.clientHeight).toBe(capped.clientHeight);
  expect(overflowing.scrollHeight - overflowing.clientHeight).toBe(
    single.lineHeight,
  );
}

function linesOf(count: number): string {
  return Array.from({ length: count }, () => "Mg").join("\n");
}

async function capture(input: Locator, name: string): Promise<void> {
  await mkdir(screenshotDirectory, { recursive: true });
  await input
    .locator("xpath=ancestor::*[@data-composer][1]")
    .screenshot({ path: path.join(screenshotDirectory, name) });
}
