import { expect, test } from "@playwright/test";
import { IrcClient } from "./irc-client";
import {
  auditMessageSelection,
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";

const ready = "Engine ready: wasm worker round trip complete";

test("passes the native-feel audit at rest", async ({ page }) => {
  await installNativeFeelInstrumentation(page);
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText(ready);

  await nativeFeelAudit(page);
});

test.describe("native feel against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("selects and copies message rows without browser chrome", async ({
    page,
  }) => {
    await installNativeFeelInstrumentation(page);
    await page.goto("/?irc-password=weblounge-test");
    await expect(
      page.getByRole("heading", { name: /#weblounge-test/ }),
    ).toBeVisible();
    const bot = await IrcClient.connect(
      "native-audit",
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    const suffix = Date.now().toString();
    const first = `first selectable ${suffix}`;
    const second = `second selectable ${suffix}`;
    try {
      bot.privmsg("#weblounge-test", first);
      bot.privmsg("#weblounge-test", second);
      await expect(page.getByText(first, { exact: false })).toBeVisible();
      await expect(page.getByText(second, { exact: false })).toBeVisible();
      await expect(
        page.locator('[data-buffer-id][aria-current="page"]'),
      ).toHaveAttribute("data-unread", "0");

      await page.evaluate(() => {
        const metrics = (
          window as Window & {
            __nativeFeelMetrics?: { layoutShift: number };
          }
        ).__nativeFeelMetrics;
        if (metrics !== undefined) metrics.layoutShift = 0;
        const reorderedChromeRule = document.createElement("style");
        reorderedChromeRule.textContent =
          "[data-app-root] * { cursor: inherit; user-select: none; }";
        document.head.append(reorderedChromeRule);
      });
      await nativeFeelAudit(page);

      await auditMessageSelection(page, first, second);
    } finally {
      bot.close();
    }
  });

  test("uses one focus border on the composer", async ({ page }) => {
    await page.goto("/?irc-password=weblounge-test");
    const composer = page.getByRole("textbox", {
      name: "Message #weblounge-test",
    });
    await composer.focus();

    const composerFocus = await composer.evaluate((element) => {
      const style = getComputedStyle(element);
      const probe = document.createElement("span");
      probe.style.color = "var(--wl-color-focus-ring)";
      document.body.append(probe);
      const focus = getComputedStyle(probe).color;
      probe.remove();
      return {
        border: style.borderTopColor,
        focus,
        outline: style.outlineStyle,
      };
    });
    expect(composerFocus.outline).toBe("none");
    expect(composerFocus.border).toBe(composerFocus.focus);

    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toHaveCSS("outline-style", "solid");
  });

  test("batches hidden message rendering into one visible catch-up", async ({
    page,
  }) => {
    await installNativeFeelInstrumentation(page);
    await page.setViewportSize({ width: 402, height: 874 });
    await page.goto("/?irc-password=weblounge-test");
    await page.getByRole("button", { name: "#weblounge-test" }).click();
    await expect(
      page.getByRole("heading", { name: /#weblounge-test/ }),
    ).toBeVisible();
    await expect(page.locator("[data-mobile-chats]")).toHaveCount(0);
    const bot = await IrcClient.connect(
      "hidden-audit",
      "weblounge-bot",
      "weblounge-bot-test",
      "#weblounge-test",
    );
    const text = `hidden message ${Date.now()}`;
    try {
      await page.getByRole("button", { name: "Show members" }).click();
      await expect(page.getByRole("dialog", { name: "Members" })).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: "Open direct message with hidden-audit",
        }),
      ).toBeVisible();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await page.evaluate(() => {
        const state = window as Window & {
          __hiddenMutations?: number;
          __nativeFeelMetrics?: { enginePatches: number };
          __setNativeVisibility?: (hidden: boolean) => void;
        };
        const list = document.querySelector("[data-message-list]");
        if (list === null) throw new Error("channel message list is missing");
        state.__hiddenMutations = 0;
        let catchupPending = false;
        new MutationObserver(() => {
          if (catchupPending) return;
          catchupPending = true;
          state.__hiddenMutations = (state.__hiddenMutations ?? 0) + 1;
          requestAnimationFrame(() => {
            catchupPending = false;
          });
        }).observe(list, { attributes: true, childList: true, subtree: true });
        if (state.__nativeFeelMetrics === undefined) {
          throw new Error("native-feel metrics are missing");
        }
        state.__nativeFeelMetrics.enginePatches = 0;
        state.__setNativeVisibility?.(true);
      });

      bot.privmsg("#weblounge-test", text);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as Window & {
                  __nativeFeelMetrics?: { enginePatches: number };
                }
              ).__nativeFeelMetrics?.enginePatches ?? 0,
          ),
        )
        .toBe(1);
      expect(
        await page.evaluate(
          () =>
            (window as Window & { __hiddenMutations?: number })
              .__hiddenMutations,
        ),
      ).toBe(0);
      await expect(page.getByText(text, { exact: false })).toHaveCount(0);

      await page.evaluate(() =>
        (
          window as Window & {
            __setNativeVisibility?: (hidden: boolean) => void;
          }
        ).__setNativeVisibility?.(false),
      );
      await expect(page.getByText(text, { exact: false })).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            (window as Window & { __hiddenMutations?: number })
              .__hiddenMutations,
        ),
      ).toBe(1);
    } finally {
      bot.close();
    }
  });
});
