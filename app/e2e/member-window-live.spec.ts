import { expect, test } from "@playwright/test";

test("keeps two live member windows through worker delivery", async ({
  page,
}) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the instrumented build",
  );
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/e2e/member-window-live.html");
  const views = ["left", "right"].map((id) =>
    page.locator(`[data-member-view="${id}"]`),
  );
  for (const [index, view] of views.entries()) {
    const list = view.getByRole("list");
    await expect(list).toBeVisible();
    await expect(view.locator("[data-offset]")).toHaveText("0");
    await list.evaluate(
      (element, fraction) => {
        element.scrollTop = element.scrollHeight * fraction;
      },
      index === 0 ? 0.35 : 0.7,
    );
  }
  await expect
    .poll(() => views[0]?.locator("[data-offset]").textContent())
    .not.toBe("0");
  await expect
    .poll(() => views[1]?.locator("[data-offset]").textContent())
    .not.toBe("0");
  const offsets = await Promise.all(
    views.map((view) => view.locator("[data-offset]").textContent()),
  );
  expect(offsets[0]).not.toBe(offsets[1]);

  for (const [version, change] of ["join", "mode", "split"].entries()) {
    await page.getByRole("button", { name: change }).click();
    for (const view of views)
      await expect(view.locator("[data-version]")).toHaveText(
        (version + 1).toString(),
      );
  }

  for (const [index, view] of views.entries()) {
    await expect(view.locator("[data-offset]")).toHaveText(
      offsets[index] ?? "",
    );
    await expect(view.locator("[data-first]")).toHaveText(
      /^u(0[5-9]|1\d)\d\d$/,
    );
    await expect(
      view.locator("button[aria-label='Open direct message with ']"),
    ).toHaveCount(0);
  }
  await expect(page.locator("[data-patches]")).toHaveText("6");
});
