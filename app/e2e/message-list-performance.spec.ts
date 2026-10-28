import { expect, test } from "@playwright/test";

test("keeps a 10k-message timeline bounded at 4x CPU", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's instrumented build",
  );
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug-messages=10000");
  const list = page.locator("[data-message-list]");
  await expect(list).toBeVisible();

  const frameTimes = await list.evaluate(async (element) => {
    const samples: number[] = [];
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
  const metrics = await page.evaluate(() => ({
    domNodes: document.querySelectorAll("*").length,
    messageRows: document.querySelectorAll("[data-message-row]").length,
  }));
  const sorted = [...frameTimes].sort((left, right) => left - right);
  const p95FrameMs = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
  const result = { ...metrics, p95FrameMs };

  await testInfo.attach("message-list-performance", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  console.info(`message-list-performance ${JSON.stringify(result)}`);
  expect(metrics.messageRows).toBeLessThan(80);
  expect(metrics.domNodes).toBeLessThan(450);
});
