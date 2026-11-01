import { expect, test } from "@playwright/test";

test("migrates a visible direct draft from an account key to its nick thread", async ({
  page,
}) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the instrumented build",
  );
  await page.goto("/e2e/draft-key-migration.html");
  const composer = page.getByRole("textbox", { name: "Message alice" });
  await composer.fill("draft before identity migration");
  await page.getByRole("button", { name: "Migrate identity" }).click();
  await expect(composer).toHaveValue("draft before identity migration");
  await composer.fill("draft after identity migration");

  await page.reload();

  await expect(
    page.getByRole("textbox", { name: "Message alice" }),
  ).toHaveValue("draft after identity migration");
});
