import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import { installNativeFeelInstrumentation } from "./native-feel-audit";

const screenshotDirectory = path.join(process.cwd(), "e2e", "screenshots");

test.describe("composer suggestions against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test.describe("desktop", () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    test("suggests without moving or covering the conversation", async ({
      page,
    }) => {
      const ana = await connectAna("suggestions-desktop");
      const anita = await IrcClient.connect(
        "anita",
        "weblounge-bot",
        "weblounge-bot-test",
        "#weblounge-test",
      );
      try {
        await installNativeFeelInstrumentation(page);
        await page.emulateMedia({ colorScheme: "light" });
        await page.goto("/?irc-password=weblounge-test&completion-delay=100");
        await page.getByRole("button", { name: /^#weblounge-test/ }).click();
        const composer = page.getByRole("textbox", {
          name: "Message #weblounge-test",
        });
        await expect(composer).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Toggle member list" }),
        ).toContainText("3");
        const geometryBefore = await conversationGeometry(page, composer);
        await resetLayoutShift(page);

        await composer.fill("/");
        await expect(
          page.getByRole("option", { name: /\/join/u }),
        ).toBeVisible();
        await expect(page.getByText("Join one or more channels")).toBeVisible();
        await expect(page.getByRole("option").first()).toHaveAccessibleName(
          /\/join/u,
        );
        await expect(page.getByText(/\/join <channels>/u)).toHaveCount(0);
        await assertOpaquePopup(page);
        await settlePopup(page);
        await assertStableUpdates(page, composer);
        await resetLayoutShift(page);
        await assertSelectedContrast(page);
        await assertGeometry(page, composer, 6, geometryBefore);
        await capture(page, "composer-suggestions-desktop-slash-light.png");
        await page.emulateMedia({ colorScheme: "dark" });
        await assertSelectedContrast(page);
        await capture(page, "composer-suggestions-desktop-slash-dark.png");

        await composer.fill("");
        await expect(page.locator("[data-composer-suggestions]")).toHaveCount(
          0,
        );
        await assertConversationGeometry(page, composer, geometryBefore);
        await assertNoLayoutShift(page);

        await composer.fill("/jo");
        await expectMatchingCompletion(page, "/jo");
        await expect(
          page.getByRole("option", { name: /\/join/u }),
        ).toBeVisible();
        await composer.press("Enter");
        await expect(composer).toHaveValue("/join ");
        await expect(page.getByText("/join <channels> [keys]")).toBeVisible();
        await composer.fill("@an");
        const mention = page.getByRole("option", { name: /ana/u });
        await expect(mention).toBeVisible();
        await capture(page, "composer-suggestions-desktop-mention-dark.png");
        await page.emulateMedia({ colorScheme: "light" });
        await capture(page, "composer-suggestions-desktop-mention-light.png");
        await mention.click();
        await expect(composer).toHaveValue("ana: ");
        await assertComposerCaret(composer);

        await composer.fill("hello @an");
        await expectMatchingCompletion(page, "hello @an");
        await expect(page.getByRole("option", { name: /ana/u })).toBeVisible();
        await composer.press("Enter");
        await expect(composer).toHaveValue("hello ana");
        await composer.fill("#we");
        await expectMatchingCompletion(page, "#we");
        await expect(
          page.getByRole("option", { name: /#weblounge-test/u }),
        ).toBeVisible();
        await composer.press("Enter");
        await expect(composer).toHaveValue("#weblounge-test");

        await composer.fill("an");
        await composer.press("Tab");
        await expect(composer).toHaveValue("ana: ");
        await composer.press("Tab");
        await expect(composer).toHaveValue("anita: ");

        await composer.fill("hello an");
        await composer.press("Tab");
        await expect(composer).toHaveValue("hello ana");
        await composer.press("Tab");
        await expect(composer).toHaveValue("hello anita");

        await composer.fill("focus stays after desktop send");
        await page.getByRole("button", { name: "Send" }).click();
        await expect(composer).toBeFocused();
        await expect(
          page.getByText("focus stays after desktop send", { exact: true }),
        ).toBeVisible();
      } finally {
        ana.close();
        anita.close();
      }
    });
  });

  test.describe("mobile", () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 402, height: 874 },
    });
    test("suggests with touch-sized bounded rows", async ({ page }) => {
      const ana = await connectAna("suggestions-mobile");
      try {
        await installNativeFeelInstrumentation(page);
        await page.emulateMedia({ colorScheme: "light" });
        await page.goto("/?irc-password=weblounge-test&completion-delay=100");
        await page.getByRole("button", { name: "#weblounge-test" }).click();
        const composer = page.getByRole("textbox", {
          name: "Message #weblounge-test",
        });
        await expect(composer).toBeVisible();
        await expect
          .poll(
            async () =>
              (await page.locator("[data-message-list]").boundingBox())?.x,
          )
          .toBe(0);
        const geometryBefore = await conversationGeometry(page, composer);
        await resetLayoutShift(page);

        await composer.fill("/");
        await expect(
          page.getByRole("option", { name: /\/join/u }),
        ).toBeVisible();
        await expect(page.getByText("Join one or more channels")).toBeVisible();
        await expect(page.getByRole("option").first()).toHaveAccessibleName(
          /\/join/u,
        );
        await expect(page.getByText(/\/join <channels>/u)).toHaveCount(0);
        await assertOpaquePopup(page);
        await settlePopup(page);
        await assertStableUpdates(page, composer);
        await resetLayoutShift(page);
        await assertSelectedContrast(page);
        await assertGeometry(page, composer, 4.5, geometryBefore);
        await capture(page, "composer-suggestions-mobile-slash-light.png");
        await page.emulateMedia({ colorScheme: "dark" });
        await assertSelectedContrast(page);
        await capture(page, "composer-suggestions-mobile-slash-dark.png");

        await composer.fill("");
        await expect(page.locator("[data-composer-suggestions]")).toHaveCount(
          0,
        );
        await assertConversationGeometry(page, composer, geometryBefore);
        await assertNoLayoutShift(page);

        await composer.fill("/jo");
        await expectMatchingCompletion(page, "/jo");
        await expect(
          page.getByRole("option", { name: /\/join/u }),
        ).toBeVisible();
        await composer.press("Enter");
        await expect(composer).toHaveValue("/join ");
        await expect(page.getByText("/join <channels> [keys]")).toBeVisible();
        await composer.fill("@an");
        const mention = page.getByRole("option", { name: /ana/u });
        await expect(mention).toBeVisible();
        await capture(page, "composer-suggestions-mobile-mention-dark.png");
        await page.emulateMedia({ colorScheme: "light" });
        await capture(page, "composer-suggestions-mobile-mention-light.png");
        await mention.tap();
        await expect(composer).toHaveValue("ana: ");
        await assertComposerCaret(composer);
        await composer.fill("hello @an");
        await expectMatchingCompletion(page, "hello @an");
        await expect(page.getByRole("option", { name: /ana/u })).toBeVisible();
        await composer.press("Enter");
        await expect(composer).toHaveValue("hello ana");
        await composer.fill("#we");
        await expectMatchingCompletion(page, "#we");
        await expect(
          page.getByRole("option", { name: /#weblounge-test/u }),
        ).toBeVisible();
        await composer.press("Enter");
        await expect(composer).toHaveValue("#weblounge-test");
        await composer.fill("focus stays after mobile send");
        await page.getByRole("button", { name: "Send" }).tap();
        await expect(composer).toBeFocused();
        await expect(
          page.getByText("focus stays after mobile send", { exact: true }),
        ).toBeVisible();
      } finally {
        ana.close();
      }
    });
  });
});

async function connectAna(id: string): Promise<IrcClient> {
  const ana = await IrcClient.connect(
    "ana",
    "weblounge-bot",
    "weblounge-bot-test",
    "#weblounge-test",
  );
  await ana.privmsgConfirmed("#weblounge-test", `hello from ana ${id}`);
  return ana;
}

async function capture(page: Page, name: string): Promise<void> {
  await settlePopup(page);
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDirectory, name) });
}

interface ConversationGeometry {
  readonly composer: Awaited<ReturnType<Locator["boundingBox"]>>;
  readonly list: Awaited<ReturnType<Locator["boundingBox"]>>;
}

async function conversationGeometry(
  page: Page,
  composer: Locator,
): Promise<ConversationGeometry> {
  const [composerBox, list] = await Promise.all([
    composer.boundingBox(),
    page.locator("[data-message-list]").boundingBox(),
  ]);
  return { composer: composerBox, list };
}

async function assertGeometry(
  page: Page,
  composer: Locator,
  visibleRows: number,
  before: ConversationGeometry,
): Promise<void> {
  const popup = page.locator("[data-composer-suggestions]");
  const [popupBox, composerBox, rowBox, listAfter] = await Promise.all([
    popup.boundingBox(),
    composer.boundingBox(),
    popup.getByRole("option").first().boundingBox(),
    page.locator("[data-message-list]").boundingBox(),
  ]);
  expect(popupBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(rowBox).not.toBeNull();
  expect(popupBox?.y ?? 0).toBeGreaterThanOrEqual(0);
  expect(
    Math.abs((popupBox?.x ?? 0) - (composerBox?.x ?? 0)),
  ).toBeLessThanOrEqual(1);
  expect((popupBox?.x ?? 0) + (popupBox?.width ?? 0)).toBeLessThanOrEqual(
    page.viewportSize()?.width ?? 0,
  );
  expect((popupBox?.y ?? 0) + (popupBox?.height ?? 0)).toBeLessThanOrEqual(
    (composerBox?.y ?? 0) + 1,
  );
  expect(popupBox?.height ?? 0).toBeLessThanOrEqual(
    (rowBox?.height ?? 0) * visibleRows + 3,
  );
  expect(listAfter).toEqual(before.list);
  expect(composerBox).toEqual(before.composer);
}

async function assertConversationGeometry(
  page: Page,
  composer: Locator,
  before: ConversationGeometry,
): Promise<void> {
  expect(await conversationGeometry(page, composer)).toEqual(before);
}

async function assertOpaquePopup(page: Page): Promise<void> {
  const surface = await page
    .locator("[data-composer-suggestions]")
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const channels = style.backgroundColor.match(/[\d.]+/gu)?.map(Number);
      return {
        alpha: channels?.[3] ?? 1,
        opacity: style.opacity,
        shadow: style.boxShadow,
      };
    });
  expect(surface.alpha).toBe(1);
  expect(surface.opacity).toBe("1");
  expect(surface.shadow).not.toBe("none");
}

async function assertSelectedContrast(page: Page): Promise<void> {
  const colors = await page
    .locator('[data-composer-suggestions] [data-selected="true"]')
    .evaluate((element) => {
      const selected = getComputedStyle(element);
      const popup = getComputedStyle(
        element.closest("[data-composer-suggestions]") as Element,
      );
      return {
        popup: popup.backgroundColor,
        selected: selected.backgroundColor,
        marker: selected.boxShadow,
      };
    });
  expect(colors.selected).not.toBe(colors.popup);
  expect(colors.marker).not.toBe("none");
}

async function assertComposerCaret(composer: Locator): Promise<void> {
  await expect(composer).toBeFocused();
  await expect
    .poll(() =>
      composer.evaluate(
        (element) =>
          element instanceof HTMLTextAreaElement &&
          element.selectionStart === element.value.length &&
          element.selectionEnd === element.value.length,
      ),
    )
    .toBe(true);
}

async function expectMatchingCompletion(
  page: Page,
  input: string,
): Promise<void> {
  await expect(page.locator("[data-composer-suggestions]")).toHaveAttribute(
    "data-completion-input",
    input,
  );
}

async function settlePopup(page: Page): Promise<void> {
  await page
    .locator("[data-composer-suggestions]")
    .evaluate(async (element) => {
      await Promise.all(
        element.getAnimations({ subtree: true }).map((item) => item.finished),
      );
    });
}

async function assertStableUpdates(
  page: Page,
  composer: Locator,
): Promise<void> {
  await composer.fill("/");
  const join = page.getByRole("option", { name: /\/join/u });
  await expect(join).toBeVisible();
  await join.evaluate((element) => {
    (
      window as Window & { __webloungePersistentSuggestion?: Element }
    ).__webloungePersistentSuggestion = element;
  });
  for (const input of ["/j", "/jo", "/joi"]) {
    await composer.fill(input);
    await assertPopupRemainsStable(page, join);
  }
  for (const input of ["/jo", "/j", "/"]) {
    await composer.press("Backspace");
    await expect(composer).toHaveValue(input);
    await assertPopupRemainsStable(page, join);
  }
}

async function assertPopupRemainsStable(
  page: Page,
  persistentRow: Locator,
): Promise<void> {
  const samples = await page.locator("[data-composer-suggestions]").evaluate(
    (popup) =>
      new Promise<
        readonly { readonly opacity: number; readonly rows: number }[]
      >((resolve) => {
        const values: { opacity: number; rows: number }[] = [];
        const sample = () => {
          values.push({
            opacity: Number.parseFloat(getComputedStyle(popup).opacity),
            rows: popup.querySelectorAll('[role="option"]').length,
          });
          if (values.length === 8) resolve(values);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
  );
  expect(samples.every(({ opacity, rows }) => opacity === 1 && rows > 0)).toBe(
    true,
  );
  await expect(persistentRow).toBeVisible();
  expect(
    await persistentRow.evaluate(
      (element) =>
        (
          window as Window & {
            __webloungePersistentSuggestion?: Element;
          }
        ).__webloungePersistentSuggestion === element,
    ),
  ).toBe(true);
}

async function resetLayoutShift(page: Page): Promise<void> {
  await page.evaluate(() => {
    const metrics = (
      window as Window & {
        __nativeFeelMetrics?: { layoutShift: number };
      }
    ).__nativeFeelMetrics;
    if (metrics === undefined)
      throw new Error("native-feel metrics are missing");
    metrics.layoutShift = 0;
  });
}

async function assertNoLayoutShift(page: Page): Promise<void> {
  const shift = await page.evaluate(
    () =>
      (
        window as Window & {
          __nativeFeelMetrics?: { readonly layoutShift: number };
        }
      ).__nativeFeelMetrics?.layoutShift,
  );
  expect(shift).toBe(0);
}
