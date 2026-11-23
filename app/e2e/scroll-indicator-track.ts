import { expect, type Locator } from "@playwright/test";

export async function scrollToMiddle(scroller: Locator): Promise<void> {
  const scrollTop = await scroller.evaluate((element) => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
    return element.scrollTop;
  });
  expect(scrollTop, "the scroller must overflow").toBeGreaterThan(0);
}

/**
 * iOS draws an overflow scroller's indicator inside the scroller's own layer,
 * along its right edge. Anything painted above that layer hides it: chrome
 * overlapping the scroller, and positioned content whose stacking context lies
 * outside the scroller, which WebKit composites above the scroller so it can
 * move with the scroll (RenderLayerCompositor's OverflowScrollPositioning).
 * Returns what covers the track.
 */
export async function scrollIndicatorTrackCovers(
  scroller: Locator,
): Promise<string[]> {
  return scroller.evaluate((list) => {
    const trackInset = 3;
    const sampleStep = 8;
    const stackingWillChange = new Set([
      "transform",
      "translate",
      "rotate",
      "scale",
      "opacity",
      "filter",
      "backdrop-filter",
      "clip-path",
      "mask",
      "isolation",
      "mix-blend-mode",
      "perspective",
      "position",
      "z-index",
    ]);
    const isFlexOrGridItem = (element: Element) => {
      const parent = element.parentElement;
      return (
        parent !== null && /flex|grid/u.test(getComputedStyle(parent).display)
      );
    };
    const isStackingContext = (element: Element) => {
      if (element === document.documentElement) return true;
      const style = getComputedStyle(element);
      return (
        style.position === "fixed" ||
        style.position === "sticky" ||
        (style.zIndex !== "auto" &&
          (style.position !== "static" || isFlexOrGridItem(element))) ||
        Number(style.opacity) < 1 ||
        style.transform !== "none" ||
        style.translate !== "none" ||
        style.rotate !== "none" ||
        style.scale !== "none" ||
        style.filter !== "none" ||
        style.backdropFilter !== "none" ||
        style.perspective !== "none" ||
        style.clipPath !== "none" ||
        style.maskImage !== "none" ||
        style.isolation === "isolate" ||
        style.mixBlendMode !== "normal" ||
        /layout|paint|strict|content/u.test(style.contain) ||
        /size/u.test(style.containerType) ||
        style.willChange
          .split(",")
          .some((property) => stackingWillChange.has(property.trim()))
      );
    };
    const paintOrderParent = (element: Element) => {
      let ancestor = element.parentElement;
      while (ancestor !== null && !isStackingContext(ancestor))
        ancestor = ancestor.parentElement;
      return ancestor;
    };
    const isLayer = (element: Element) =>
      getComputedStyle(element).position !== "static" ||
      isStackingContext(element);
    const paintsOutsideScroller = (element: Element) => {
      if (!isLayer(element)) return false;
      const parent = paintOrderParent(element);
      return parent === null || !list.contains(parent);
    };
    const label = (element: Element) => {
      const attributes = [...element.attributes]
        .filter(({ name }) => name.startsWith("data-") || name === "class")
        .map(({ name, value }) => `${name}="${value}"`);
      return `<${element.localName} ${attributes.join(" ")}>`;
    };
    const coverAt = (x: number, y: number): string | undefined => {
      const hit = document.elementFromPoint(x, y);
      if (hit === null) return undefined;
      if (!list.contains(hit)) return `${label(hit)} overlaps the scroller`;
      let element: Element | null = hit;
      while (element !== null && element !== list) {
        if (paintsOutsideScroller(element))
          return `${label(element)} paints outside the scroller`;
        element = element.parentElement;
      }
      return undefined;
    };
    const box = list.getBoundingClientRect();
    const covers = new Set<string>();
    for (let y = box.top + 1; y < box.bottom - 1; y += sampleStep) {
      const cover = coverAt(box.right - trackInset, y);
      if (cover !== undefined) covers.add(cover);
    }
    return [...covers];
  });
}
