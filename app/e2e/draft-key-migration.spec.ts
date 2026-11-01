import { expect, test } from "@playwright/test";

test("migrates a visible direct draft from nick to account identity", async ({
  page,
}) => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the instrumented build",
  );
  await page.goto("/e2e/draft-key-migration.html");
  const composer = page.getByRole("textbox", { name: "Message alice" });
  await composer.fill("draft before account discovery");
  await page.getByRole("button", { name: "Account known" }).click();
  await expect(composer).toHaveValue("draft before account discovery");
  await composer.fill("draft after account discovery");

  await page.reload();

  await expect(
    page.getByRole("textbox", { name: "Message alice" }),
  ).toHaveValue("draft after account discovery");
});
