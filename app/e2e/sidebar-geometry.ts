import { expect, type Locator, type Page } from "@playwright/test";

export async function expectPinnedToHeaderEnd(button: Locator): Promise<void> {
  const geometry = await button.evaluate((element) => {
    const header = element.closest<HTMLElement>("[data-connection-brand]");
    const title = header?.querySelector("[data-connection-title]");
    if (header == null || title == null)
      throw new Error("header button is outside the sidebar brand row");
    const buttonBox = element.getBoundingClientRect();
    const paddingRight = Number.parseFloat(
      getComputedStyle(header).paddingRight,
    );
    return {
      buttonLeft: buttonBox.left,
      buttonRight: buttonBox.right,
      contentRight: header.getBoundingClientRect().right - paddingRight,
      titleRight: title.getBoundingClientRect().right,
    };
  });
  expect(
    Math.abs(geometry.contentRight - geometry.buttonRight),
  ).toBeLessThanOrEqual(1);
  expect(geometry.titleRight).toBeLessThanOrEqual(geometry.buttonLeft);
}

// Pinned so restyling the network header never moves the rows under it.
const firstRowOffsetByDensity = {
  compact: 34,
  cozy: 38,
  comfortable: 44,
} as const;

export async function expectBalancedNetworkHeaderAtEachDensity(
  page: Page,
  header: Locator,
): Promise<void> {
  const root = page.locator("html");
  const initial = await root.getAttribute("data-sidebar-density");
  for (const [density, offset] of Object.entries(firstRowOffsetByDensity)) {
    await root.evaluate((element, value) => {
      element.dataset.sidebarDensity = value;
    }, density);
    await expectBalancedNetworkHeader(header, offset);
  }
  await root.evaluate((element, value) => {
    if (value === null) delete element.dataset.sidebarDensity;
    else element.dataset.sidebarDensity = value;
  }, initial);
}

async function expectBalancedNetworkHeader(
  header: Locator,
  firstRowOffset: number,
): Promise<void> {
  const geometry = await header.evaluate((element) => {
    const navigation = element.closest("nav");
    const name = element.querySelector("[data-line]");
    const firstRow = element
      .closest("section")
      ?.querySelector("[data-sidebar-row]");
    if (navigation == null || name == null || firstRow == null)
      throw new Error("network header geometry is missing");
    const headerBox = element.getBoundingClientRect();
    const nameBox = name.getBoundingClientRect();
    const rowBox = firstRow.getBoundingClientRect();
    return {
      headerCenter: (headerBox.top + headerBox.bottom) / 2,
      headerLeft: headerBox.left,
      headerRight: headerBox.right,
      nameCenter: (nameBox.top + nameBox.bottom) / 2,
      rowLeft: rowBox.left,
      rowOffset: rowBox.top - navigation.getBoundingClientRect().top,
      rowRight: rowBox.right,
    };
  });
  expect(
    Math.abs(geometry.nameCenter - geometry.headerCenter),
  ).toBeLessThanOrEqual(1);
  expect(geometry.rowOffset).toBeCloseTo(firstRowOffset, 1);
  expect(geometry.headerLeft).toBeCloseTo(geometry.rowLeft, 1);
  expect(geometry.headerRight).toBeCloseTo(geometry.rowRight, 1);
}
