import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, test } from "@playwright/test";

const screenshotDirectory = path.join(process.cwd(), "e2e", "screenshots");
const sixLines = ["one", "two", "three", "four", "five", "six"].join("\n");

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

test("keeps the phone Send control inside a capped composer", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    isMobile: true,
    viewport: { width: 402, height: 874 },
  });
  const page = await context.newPage();
  try {
    await page.goto("/?irc-password=weblounge-test");
    await page.getByRole("button", { name: "#weblounge-test" }).click();
    await expect(page.locator("[data-motion]")).toHaveCount(0);
    const input = page.getByRole("textbox", {
      name: "Message #weblounge-test",
    });
    const field = page.locator("[data-composer-field]");
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toHaveAttribute("data-empty", "true");
    await expect(send).toHaveCSS("opacity", "1");
    await input.fill("phone composer one line");
    await capture(page, "phone-composer-after-one-line.png");
    await input.fill(sixLines);
    await capture(page, "phone-composer-after-six-lines.png");
    await input.fill("phone composer one line");

    await expect(send).toBeVisible();
    await expect(send).toHaveAccessibleName("Send");
    await expectInside(field, send);
    await expectBottomAligned(field, send);
    const hitBox = await send.boundingBox();
    expect(hitBox?.width).toBeGreaterThanOrEqual(44);
    expect(hitBox?.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator("[data-composer-send-visual]")).toHaveCSS(
      "width",
      "34px",
    );

    await input.fill(sixLines);
    const cappedHeight = await field.evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    await expectBottomAligned(field, send);
    await expect
      .poll(() =>
        input.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      )
      .toBe(true);
    await input.fill(`${sixLines}\nseven\neight`);
    await expect
      .poll(() =>
        field.evaluate((element) => element.getBoundingClientRect().height),
      )
      .toBeCloseTo(cappedHeight, 0);

    const sent = `phone composer send ${Date.now()}`;
    await input.fill(sent);
    await send.tap();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("");
    await expect(page.getByText(sent, { exact: true })).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test("bottom-aligns desktop Send with a multiline field", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    hasTouch: false,
    isMobile: false,
    viewport: { width: 1_200, height: 800 },
  });
  const page = await context.newPage();
  try {
    await page.goto("/?irc-password=weblounge-test");
    const input = page.getByRole("textbox", {
      name: "Message #weblounge-test",
    });
    const field = page.locator("[data-composer-field]");
    const send = page.getByRole("button", { name: "Send" });
    await input.fill(sixLines);

    await expectBottomAligned(field, send);
  } finally {
    await context.close();
  }
});

async function expectInside(field: Locator, control: Locator): Promise<void> {
  const [fieldBox, controlBox] = await Promise.all([
    field.boundingBox(),
    control.boundingBox(),
  ]);
  expect(fieldBox).not.toBeNull();
  expect(controlBox).not.toBeNull();
  if (fieldBox === null || controlBox === null) return;
  expect(controlBox.x).toBeGreaterThanOrEqual(fieldBox.x);
  expect(controlBox.y).toBeGreaterThanOrEqual(fieldBox.y);
  expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(
    fieldBox.x + fieldBox.width,
  );
  expect(controlBox.y + controlBox.height).toBeLessThanOrEqual(
    fieldBox.y + fieldBox.height,
  );
}

async function expectBottomAligned(
  field: Locator,
  control: Locator,
): Promise<void> {
  await expect
    .poll(async () => {
      const [fieldBox, controlBox] = await Promise.all([
        field.boundingBox(),
        control.boundingBox(),
      ]);
      if (fieldBox === null || controlBox === null)
        return Number.POSITIVE_INFINITY;
      return Math.abs(
        fieldBox.y + fieldBox.height - (controlBox.y + controlBox.height),
      );
    })
    .toBeLessThanOrEqual(1);
}

async function capture(
  page: import("@playwright/test").Page,
  name: string,
): Promise<void> {
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDirectory, name) });
}
