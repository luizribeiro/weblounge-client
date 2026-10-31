import { expect, type Locator } from "@playwright/test";
import { expectInterFont } from "./inter-font";

interface PrefixGeometry {
  readonly columnWidth: number;
  readonly expectedColumnWidth: number;
  readonly expectedGap: number;
  readonly gap: number;
  readonly nameLeft: number;
  readonly prefixRight: number | undefined;
}

interface PrefixColumnOptions {
  readonly avatarSelector: string;
  readonly gapProperty: string;
}

export async function expectAlignedPrefixColumn(
  container: Locator,
  prefixSelector: string,
  nameSelector: string,
  options?: PrefixColumnOptions,
): Promise<void> {
  await expectInterFont(
    container.locator(`${prefixSelector}, ${nameSelector}`),
  );
  const geometry: readonly PrefixGeometry[] = await container
    .locator(nameSelector)
    .evaluateAll(
      (names, prefix) =>
        names
          .filter((name) => name.getClientRects().length > 0)
          .map((name) => {
            const row = name.closest("button");
            const prefixElement = row?.querySelector<HTMLElement>(prefix);
            if (!(name instanceof HTMLElement) || prefixElement == null)
              throw new Error("prefix-column geometry is missing");

            const nameRange = document.createRange();
            nameRange.selectNodeContents(name);
            const nameLeft = nameRange.getBoundingClientRect().left;
            const symbol = prefixElement.textContent ?? "";
            const reference = document.createElement("span");
            const style = getComputedStyle(name);
            reference.style.position = "fixed";
            reference.style.visibility = "hidden";
            reference.style.whiteSpace = "nowrap";
            for (const property of [
              "font-family",
              "font-size",
              "font-stretch",
              "font-style",
              "font-weight",
              "letter-spacing",
            ])
              reference.style.setProperty(
                property,
                style.getPropertyValue(property),
              );
            const referenceText = document.createTextNode(
              symbol + (name.textContent ?? ""),
            );
            reference.append(referenceText);
            document.body.append(reference);

            const referencePrefix = document.createRange();
            referencePrefix.setStart(referenceText, 0);
            referencePrefix.setEnd(referenceText, symbol.length);
            const referenceName = document.createRange();
            referenceName.setStart(referenceText, symbol.length);
            referenceName.setEnd(referenceText, referenceText.length);
            const expectedGap =
              referenceName.getBoundingClientRect().left -
              referencePrefix.getBoundingClientRect().right;
            reference.textContent = symbol;
            const expectedColumnWidth = reference.getBoundingClientRect().width;
            reference.remove();

            if (symbol === "")
              return {
                columnWidth: prefixElement.getBoundingClientRect().width,
                expectedColumnWidth,
                expectedGap,
                gap: 0,
                nameLeft,
                prefixRight: undefined,
              };

            const prefixRight = prefixElement.getBoundingClientRect().right;
            return {
              columnWidth: prefixElement.getBoundingClientRect().width,
              expectedColumnWidth,
              expectedGap,
              gap: nameLeft - prefixRight,
              nameLeft,
              prefixRight,
            };
          }),
      prefixSelector,
    );

  expect(
    spread(geometry.map(({ nameLeft }) => nameLeft)),
    JSON.stringify(geometry),
  ).toBeLessThan(0.5);
  const prefixRights = geometry.flatMap(({ prefixRight }) =>
    prefixRight === undefined ? [] : [prefixRight],
  );
  expect(spread(prefixRights), JSON.stringify(geometry)).toBeLessThan(0.5);
  for (const { expectedGap, gap, prefixRight } of geometry) {
    if (prefixRight !== undefined)
      expect(gap, JSON.stringify(geometry)).toBeCloseTo(expectedGap, 0);
  }
  const expectedWidth = Math.max(
    ...geometry.map(({ expectedColumnWidth }) => expectedColumnWidth),
  );
  for (const { columnWidth } of geometry)
    expect(columnWidth).toBeCloseTo(expectedWidth, 0);

  if (options !== undefined) {
    const avatarGaps = await container.locator(nameSelector).evaluateAll(
      (names, selectors) =>
        names
          .filter((name) => name.getClientRects().length > 0)
          .map((name) => {
            const row = name.closest("button");
            const avatar = row?.querySelector<HTMLElement>(selectors.avatar);
            const prefix = row?.querySelector<HTMLElement>(selectors.prefix);
            if (row === null || avatar == null || prefix == null)
              throw new Error("avatar-prefix geometry is missing");
            return {
              actual:
                prefix.getBoundingClientRect().left -
                avatar.getBoundingClientRect().right,
              expected: Number.parseFloat(
                getComputedStyle(row).getPropertyValue(selectors.gapProperty),
              ),
            };
          }),
      {
        avatar: options.avatarSelector,
        gapProperty: options.gapProperty,
        prefix: prefixSelector,
      },
    );
    for (const gap of avatarGaps)
      expect(gap.actual, JSON.stringify(avatarGaps)).toBeCloseTo(
        gap.expected,
        0,
      );
  }
}

function spread(values: readonly number[]): number {
  return Math.max(...values) - Math.min(...values);
}
