import { expect, type Locator } from "@playwright/test";

interface RowGeometry {
  readonly nameLeft: number;
  readonly slotLeft: number;
  readonly slotRight: number;
  readonly contentLeft: number | undefined;
  readonly contentRight: number | undefined;
  readonly nameTruncated: boolean;
  readonly suffixWidth: number | undefined;
}

export async function expectOmnibarColumnsAligned(
  listbox: Locator,
): Promise<readonly RowGeometry[]> {
  const rows: readonly RowGeometry[] = await listbox
    .getByRole("option")
    .evaluateAll((options) =>
      options.map((option) => {
        const box = (selector: string) =>
          option.querySelector(selector)?.getBoundingClientRect();
        const nameBox = box("[data-omnibar-name]");
        const slot = box("[data-omnibar-slot]");
        if (nameBox === undefined || slot === undefined)
          throw new Error("omnibar row is missing its name or slot");
        const content = box("[data-omnibar-slot] > *");
        const name = option.querySelector("[data-omnibar-name]");
        const suffix = option.querySelector("[data-omnibar-suffix]");
        return {
          nameLeft: nameBox.left,
          slotLeft: slot.left,
          slotRight: slot.right,
          contentLeft: content?.left,
          contentRight: content?.right,
          nameTruncated: name !== null && name.scrollWidth > name.clientWidth,
          suffixWidth: suffix?.getBoundingClientRect().width,
        };
      }),
    );
  expect(rows.length).toBeGreaterThan(1);
  const [first] = rows;
  for (const row of rows) {
    expect(row.nameLeft).toBeCloseTo(first?.nameLeft ?? Number.NaN, 1);
    expect(row.slotLeft).toBeCloseTo(first?.slotLeft ?? Number.NaN, 1);
    expect(row.slotRight).toBeCloseTo(first?.slotRight ?? Number.NaN, 1);
    if (row.nameTruncated && row.suffixWidth !== undefined)
      expect(row.suffixWidth).toBeLessThan(1);
    if (row.contentLeft === undefined || row.contentRight === undefined)
      continue;
    expect(row.contentLeft).toBeGreaterThanOrEqual(row.slotLeft - 0.5);
    expect(row.contentRight).toBeLessThanOrEqual(row.slotRight + 0.5);
  }
  return rows;
}
