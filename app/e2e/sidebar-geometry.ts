import { expect, type Locator, type Page } from "@playwright/test";

export async function expectHeaderButtonsAtEnd(
  buttons: readonly Locator[],
): Promise<void> {
  const edges = await Promise.all(
    buttons.map((button) =>
      button.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right };
      }),
    ),
  );
  const first = buttons[0];
  const firstEdge = edges[0];
  const lastEdge = edges.at(-1);
  if (first === undefined || firstEdge === undefined || lastEdge === undefined)
    throw new Error("no header buttons");
  const header = await first.evaluate((element) => {
    const row = element.closest<HTMLElement>("[data-connection-brand]");
    const title = row?.querySelector("[data-connection-title]");
    if (row == null || title == null)
      throw new Error("header button is outside the sidebar brand row");
    const line = title.querySelector<HTMLElement>("[data-line]");
    if (line == null)
      throw new Error("the brand title has no ellipsizing line");
    return {
      contentRight:
        row.getBoundingClientRect().right -
        Number.parseFloat(getComputedStyle(row).paddingRight),
      titleRight: title.getBoundingClientRect().right,
      titleClientWidth: line.clientWidth,
      titleScrollWidth: line.scrollWidth,
    };
  });
  for (const [index, edge] of edges.slice(1).entries())
    expect(
      Math.abs(edge.left - (edges[index]?.right ?? Number.NaN)),
    ).toBeLessThanOrEqual(1);
  expect(Math.abs(header.contentRight - lastEdge.right)).toBeLessThanOrEqual(1);
  expect(header.titleRight).toBeLessThanOrEqual(firstEdge.left);
  expect(header.titleScrollWidth).toBeLessThanOrEqual(header.titleClientWidth);
}

// Pinned so restyling the network header never moves the rows under it.
const firstRowOffsetByDensity = {
  compact: 38,
  cozy: 44,
  comfortable: 50,
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
    const tile = element.querySelector("[data-network-tile]");
    const rowPrefix = firstRow.querySelector("[data-sidebar-prefix]");
    const rowName = firstRow.querySelector("[data-sidebar-name]");
    if (tile == null || rowPrefix == null || rowName == null)
      throw new Error("network tile or row columns are missing");
    const radius = (box: Element) =>
      Number.parseFloat(getComputedStyle(box).borderTopLeftRadius);
    return {
      tileLeft: tile.getBoundingClientRect().left,
      rowPrefixLeft: rowPrefix.getBoundingClientRect().left,
      nameLeft: nameBox.left,
      rowNameLeft: rowName.getBoundingClientRect().left,
      headerHeight: headerBox.height,
      headerRadius: radius(element),
      rowHeight: rowBox.height,
      rowRadius: radius(firstRow),
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
  expect(
    Math.abs(geometry.tileLeft - geometry.rowPrefixLeft),
  ).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs(geometry.nameLeft - geometry.rowNameLeft),
  ).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs(geometry.headerHeight - geometry.rowHeight),
  ).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs(geometry.headerRadius - geometry.rowRadius),
  ).toBeLessThanOrEqual(0.5);
  expect(geometry.headerLeft).toBeCloseTo(geometry.rowLeft, 1);
  expect(geometry.headerRight).toBeCloseTo(geometry.rowRight, 1);
}
