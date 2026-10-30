import { expect, test } from "@playwright/test";
import { performanceRunCount, summarizeFrameRuns } from "./performance-runs";

test("keeps a 10k-message timeline bounded at 4x CPU", async ({
  page,
}, testInfo) => {
  test.slow(); // wait-ok: perf scenario samples 40 scroll steps
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's instrumented build",
  );
  const runPages = [
    page,
    ...(await Promise.all(
      Array.from({ length: performanceRunCount - 1 }, () =>
        page.context().newPage(),
      ),
    )),
  ];
  const frameRuns = await Promise.all(
    runPages.map(async (runPage) => {
      const session = await runPage.context().newCDPSession(runPage);
      await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await runPage.setViewportSize({ width: 1440, height: 900 });
      await runPage.goto("/e2e/message-list-performance.html");
      await expect(
        runPage.locator("[data-performance-harness='render-only']"),
      ).toBeVisible();
      const list = runPage.locator("[data-message-list]");
      await expect(list).toBeVisible();
      return list.evaluate(async (element) => {
        const samples: number[] = [];
        element.scrollTop = 0;
        let previous = performance.now();
        for (let step = 0; step <= 40; step += 1) {
          element.scrollTop =
            (element.scrollHeight - element.clientHeight) * (step / 40);
          await new Promise<void>((resolve) =>
            requestAnimationFrame((now) => {
              samples.push(now - previous);
              previous = now;
              resolve();
            }),
          );
        }
        return samples;
      });
    }),
  );
  const metrics = await page.evaluate(() => ({
    domNodes: document.querySelectorAll("*").length,
    messageRows: document.querySelectorAll("[data-message-row]").length,
  }));
  const result = { ...metrics, ...summarizeFrameRuns(frameRuns) };

  await testInfo.attach("message-list-performance", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  console.info(`message-list-performance ${JSON.stringify(result)}`);
  expect(metrics.messageRows).toBeLessThan(80);
  expect(metrics.domNodes).toBeLessThan(450);
});
