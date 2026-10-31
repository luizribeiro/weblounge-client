import { expect, test } from "@playwright/test";
import { expectAlignedPrefixColumn } from "./prefix-column-geometry";

test("aligns real-font sigil and mode columns", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await page.goto("/e2e/prefix-column.html");

  const sidebar = page.getByRole("complementary", {
    name: "Channel samples",
  });
  await expect(sidebar.getByRole("button", { name: "#lounge" })).toBeVisible();
  expect(
    await sidebar.locator("[data-sidebar-prefix]").allTextContents(),
  ).toEqual(["#", "&", ""]);
  await expectAlignedPrefixColumn(
    sidebar,
    "[data-sidebar-prefix]",
    "[data-sidebar-name]",
  );

  const members = page.getByRole("complementary", { name: "Members" });
  await expect(
    members.getByRole("button", { name: "Open direct message with plain" }),
  ).toBeVisible();
  const memberPrefixes = await members
    .locator("[data-member-name]:visible")
    .evaluateAll((names) =>
      names.map(
        (name) =>
          name.closest("button")?.querySelector("[data-member-prefix]")
            ?.textContent ?? "",
      ),
    );
  expect(memberPrefixes).toEqual(["@", "~", "&", "%", "+", ""]);
  await expectAlignedPrefixColumn(
    members,
    "[data-member-prefix]",
    "[data-member-name]",
    {
      avatarSelector: "[data-member-avatar]",
      gapProperty: "--wl-space-list-gap",
    },
  );
});
