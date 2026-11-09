import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { waitForStableGeometry } from "./stable-geometry";

const screenshotDirectory = path.join(process.cwd(), "e2e", "screenshots");
const sixLines = ["one", "two", "three", "four", "five", "six"].join("\n");
const fiveLines = ["one", "two", "three", "four", "five"].join("\n");

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

test("centres the phone composer text with its field", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  try {
    await page.goto("/?irc-password=weblounge-test");
    await page.getByRole("button", { name: "#weblounge-test" }).click();
    await expect(page.locator("[data-motion]")).toHaveCount(0);
    const input = page.getByRole("textbox", {
      name: "Message #weblounge-test",
    });
    const empty = await firstLineGeometry(input);

    await input.fill("M");
    const typed = await firstLineGeometry(input);

    expect(Math.abs(empty.textCenter - empty.fieldCenter)).toBeLessThanOrEqual(
      1,
    );
    expect(Math.abs(empty.textCenter - empty.sendCenter)).toBeLessThanOrEqual(
      1,
    );
    expect(Math.abs(typed.textCenter - typed.fieldCenter)).toBeLessThanOrEqual(
      1,
    );
    expect(Math.abs(typed.textCenter - typed.sendCenter)).toBeLessThanOrEqual(
      1,
    );
    expect(Math.abs(typed.textCenter - empty.textCenter)).toBeLessThanOrEqual(
      1,
    );
  } finally {
    await context.close();
  }
});

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
    await input.fill(fiveLines);
    await input.press("Shift+Enter");
    await input.pressSequentially("six");
    await waitForStableGeometry(input);
    await expectLastVisibleLineFullyInside(input, 6);
    await expectLineFullyVisible(input, 5);
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
    await waitForStableGeometry(input);
    await expectLastVisibleLineFullyInside(input, 6);
    await expectLineFullyVisible(input, 5);
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

interface LineGeometry {
  bottom: number;
  contentBottom: number;
  contentTop: number;
  top: number;
}

interface FirstLineGeometry {
  readonly fieldCenter: number;
  readonly sendCenter: number;
  readonly textCenter: number;
}

async function firstLineGeometry(input: Locator): Promise<FirstLineGeometry> {
  return input.evaluate(async (element) => {
    const textarea = element as HTMLTextAreaElement;
    await document.fonts.ready;
    const field = textarea.closest<HTMLElement>("[data-composer-field]");
    const send = field?.querySelector<HTMLElement>("[data-composer-send]");
    if (field === null || field === undefined || send === null)
      throw new Error("composer geometry is missing");
    const inputStyle = getComputedStyle(textarea);
    const inputRect = textarea.getBoundingClientRect();
    const fieldStyle = getComputedStyle(field);
    const fieldRect = field.getBoundingClientRect();
    const sendRect = send.getBoundingClientRect();
    const probe = document.createElement("span");
    probe.style.background = "transparent";
    probe.style.border = "0";
    probe.style.font = inputStyle.font;
    probe.style.fontKerning = inputStyle.fontKerning;
    probe.style.letterSpacing = inputStyle.letterSpacing;
    probe.style.lineHeight = inputStyle.lineHeight;
    probe.style.margin = "0";
    probe.style.opacity = "0";
    probe.style.padding = "0";
    probe.style.position = "fixed";
    probe.style.whiteSpace = "pre";
    probe.style.left = `${inputRect.left + Number.parseFloat(inputStyle.borderLeftWidth) + Number.parseFloat(inputStyle.paddingLeft)}px`;
    probe.style.top = `${inputRect.top + Number.parseFloat(inputStyle.borderTopWidth) + Number.parseFloat(inputStyle.paddingTop) - textarea.scrollTop}px`;
    probe.textContent = textarea.value || textarea.placeholder;
    document.body.append(probe);
    const range = document.createRange();
    range.selectNodeContents(probe);
    const textRect = range.getBoundingClientRect();
    probe.remove();
    const fieldInnerTop =
      fieldRect.top + Number.parseFloat(fieldStyle.borderTopWidth);
    const fieldInnerBottom =
      fieldRect.bottom - Number.parseFloat(fieldStyle.borderBottomWidth);
    return {
      fieldCenter: (fieldInnerTop + fieldInnerBottom) / 2,
      sendCenter: (sendRect.top + sendRect.bottom) / 2,
      textCenter: (textRect.top + textRect.bottom) / 2,
    };
  });
}

async function lineGeometry(
  input: Locator,
  lineIndex: number,
): Promise<LineGeometry> {
  return input.evaluate((element, index) => {
    const textarea = element as HTMLTextAreaElement;
    const style = getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const paddingTop = Number.parseFloat(style.paddingTop);
    const paddingBottom = Number.parseFloat(style.paddingBottom);
    const top = paddingTop + index * lineHeight - textarea.scrollTop;
    return {
      bottom: top + lineHeight,
      contentBottom: textarea.clientHeight - paddingBottom,
      contentTop: paddingTop,
      top,
    };
  }, lineIndex);
}

async function expectLastVisibleLineFullyInside(
  input: Locator,
  lineCount: number,
): Promise<void> {
  const lines = await Promise.all(
    Array.from({ length: lineCount }, (_, index) => lineGeometry(input, index)),
  );
  const visible = lines.filter(
    (line) =>
      line.bottom > line.contentTop + 0.5 &&
      line.top < line.contentBottom - 0.5,
  );
  const last = visible.at(-1);
  expect(last).toBeDefined();
  if (last === undefined) return;
  expect(last.bottom - last.contentBottom).toBeLessThanOrEqual(0.5);
}

async function expectLineFullyVisible(
  input: Locator,
  lineIndex: number,
): Promise<void> {
  const line = await lineGeometry(input, lineIndex);
  expect(line.bottom - line.contentBottom).toBeLessThanOrEqual(0.5);
  expect(line.contentTop - line.top).toBeLessThanOrEqual(0.5);
}

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
