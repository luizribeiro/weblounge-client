import { expect, type Page } from "@playwright/test";

export async function expectFullBleedHighlight(
  page: Page,
  text: string,
): Promise<void> {
  const list = page.getByRole("list", { name: "Messages" });
  const row = list.locator("[data-message-row]").filter({ hasText: text });
  await expect(row).toHaveAttribute("data-message-text", text);

  const geometry = await row.evaluate((element) => {
    const list = element.closest<HTMLElement>("[data-message-list]");
    if (list === null) throw new Error("highlighted row has no message list");
    const rowBox = element.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    const band = getComputedStyle(element, "::before");
    const sample = document.createElement("div");
    sample.style.background = "var(--wl-color-mention-bg)";
    document.body.append(sample);
    const themeColor = getComputedStyle(sample).backgroundColor;
    sample.remove();
    const leftInset = Number.parseFloat(band.left);
    const rightInset = Number.parseFloat(band.right);
    const listLeft = listBox.left + list.clientLeft;
    return {
      bandColor: band.backgroundColor,
      bandLeft: rowBox.left + leftInset,
      bandRight: rowBox.right - rightInset,
      content: band.content,
      listLeft,
      listRight: listLeft + list.clientWidth,
      themeColor,
    };
  });

  expect(geometry.content).not.toBe("none");
  expect(geometry.bandColor).toBe(geometry.themeColor);
  expect(Math.abs(geometry.bandLeft - geometry.listLeft)).toBeLessThanOrEqual(
    1,
  );
  expect(Math.abs(geometry.bandRight - geometry.listRight)).toBeLessThanOrEqual(
    1,
  );
}
