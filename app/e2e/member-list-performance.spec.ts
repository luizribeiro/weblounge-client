import { expect, test } from "@playwright/test";

test("keeps a 10k-member channel bounded at 4x CPU", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the instrumented build",
  );
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/e2e/member-list-performance.html");
  const list = page.getByRole("list", { name: "Members of #ten-thousand" });
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
  const sorted = [...frameTimes].sort((left, right) => left - right);
  const result = {
    domNodes: await page.locator("*").count(),
    renderedRows: await list.locator("li").count(),
    p95FrameMs: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0,
  };
  await testInfo.attach("member-list-performance", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  console.info(`member-list-performance ${JSON.stringify(result)}`);
  expect(result.renderedRows).toBeLessThan(80);
  expect(result.domNodes).toBeLessThan(400);
  expect(result.p95FrameMs).toBeLessThan(120);
});
