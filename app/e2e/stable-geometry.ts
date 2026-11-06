import type { Locator } from "@playwright/test";

const stableFrameCount = 3;

export async function waitForStableGeometry(
  root: Locator,
  descendants?: string,
): Promise<void> {
  await root.evaluate(
    async (element, { frames, selector }) => {
      const nextFrame = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const snapshot = () => {
        const targets = [
          element,
          ...(selector === undefined
            ? []
            : element.querySelectorAll<HTMLElement>(selector)),
        ];
        return JSON.stringify(
          targets.map((target) => {
            const rect = target.getBoundingClientRect();
            const x = Math.max(0, Math.min(innerWidth - 1, rect.left + 2));
            const y = Math.max(
              0,
              Math.min(innerHeight - 1, (rect.top + rect.bottom) / 2),
            );
            const hit = document.elementFromPoint(x, y);
            return [
              target.dataset.rowKey ?? "",
              rect.left,
              rect.top,
              rect.right,
              rect.bottom,
              target.scrollTop,
              target.scrollHeight,
              target.clientHeight,
              hit instanceof HTMLElement
                ? (hit.closest<HTMLElement>("[data-message-row]")?.dataset
                    .messageText ?? hit.tagName)
                : "",
            ];
          }),
        );
      };

      let previous = snapshot();
      let stableFrames = 1;
      while (stableFrames < frames) {
        await nextFrame();
        if (!element.isConnected)
          throw new Error("geometry root was replaced while settling");
        const current = snapshot();
        stableFrames = current === previous ? stableFrames + 1 : 1;
        previous = current;
      }
    },
    { frames: stableFrameCount, selector: descendants },
  );
}
