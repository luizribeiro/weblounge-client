import { expect, test } from "./irc-fixture";
import {
  auditMessageSelection,
  installNativeFeelInstrumentation,
  nativeFeelAudit,
  waitForKeyboardGeometrySettle,
} from "./native-feel-audit";
import { expectSettled } from "./settled";

const ready = "Engine ready: wasm worker round trip complete";

test("passes the native-feel audit at rest", async ({ page }) => {
  await installNativeFeelInstrumentation(page);
  await page.goto("/");
  await expect(page.getByText(ready, { exact: true })).toBeAttached();
  await expect(page.locator("[data-initial-splash]")).toHaveCount(0);

  await nativeFeelAudit(page);
});

test.describe("native feel against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("selects and copies message rows without browser chrome", async ({
    page,
    irc,
  }) => {
    await installNativeFeelInstrumentation(page);
    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });
    const bot = await irc.peer("native-audit");
    const first = "first selectable";
    const second = "second selectable";
    bot.privmsg(irc.channel, first);
    bot.privmsg(irc.channel, second);
    await expect(page.getByText(first, { exact: false })).toBeVisible();
    await expect(page.getByText(second, { exact: false })).toBeVisible();
    await expect(
      page.locator('[data-buffer-id][aria-current="page"]'),
    ).toHaveAttribute("data-unread", "0");

    await page.route("**/__native-feel-probe.css", (route) =>
      route.fulfill({
        contentType: "text/css",
        body: "[data-app-root] * { cursor: inherit; user-select: none; }",
      }),
    );
    await page.evaluate(async () => {
      const metrics = (
        window as Window & {
          __nativeFeelMetrics?: { layoutShift: number };
        }
      ).__nativeFeelMetrics;
      if (metrics !== undefined) metrics.layoutShift = 0;
      const reorderedChromeRule = document.createElement("link");
      reorderedChromeRule.rel = "stylesheet";
      reorderedChromeRule.href = "/__native-feel-probe.css";
      await new Promise<void>((resolve, reject) => {
        reorderedChromeRule.addEventListener("load", () => resolve(), {
          once: true,
        });
        reorderedChromeRule.addEventListener("error", () => reject(), {
          once: true,
        });
        document.head.append(reorderedChromeRule);
      });
    });
    await nativeFeelAudit(page);

    await auditMessageSelection(page, bot.nickname, first, second);
  });

  test("uses one focus border on the composer", async ({ page, irc }) => {
    await page.goto(irc.url());
    const composer = page.getByRole("textbox", {
      name: `Message ${irc.channel}`,
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

  test.describe("touch-primary rendering", () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 402, height: 874 },
    });

    test("batches hidden message rendering into one visible catch-up", async ({
      page,
      irc,
    }) => {
      await installNativeFeelInstrumentation(page);
      await page.goto(irc.url());
      await page.getByRole("button", { name: irc.channel }).click();
      await expectSettled(page, { conversation: irc.channel });
      await expect(
        page.locator("[data-mobile-chats]").locator(".."),
      ).toHaveAttribute("aria-hidden", "true");
      const bot = await irc.peer("hidden-audit");
      const text = `hidden message ${Date.now()}`;
      await page.getByRole("button", { name: "Show members" }).click();
      await expect(page.getByRole("dialog", { name: "Members" })).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: `Open direct message with ${bot.nickname}`,
        }),
      ).toBeVisible();
      await waitForKeyboardGeometrySettle(page);
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
        }).observe(list, {
          attributes: true,
          childList: true,
          subtree: true,
        });
        if (state.__nativeFeelMetrics === undefined) {
          throw new Error("native-feel metrics are missing");
        }
        state.__nativeFeelMetrics.enginePatches = 0;
        state.__setNativeVisibility?.(true);
      });

      bot.privmsg(irc.channel, text);
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
      const message = page
        .locator("[data-message-row]")
        .getByText(text, { exact: true });
      await expect(message).toHaveCount(0);

      await page.evaluate(() =>
        (
          window as Window & {
            __setNativeVisibility?: (hidden: boolean) => void;
          }
        ).__setNativeVisibility?.(false),
      );
      await expect(message).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            (window as Window & { __hiddenMutations?: number })
              .__hiddenMutations,
        ),
      ).toBe(1);
    });
  });
});
