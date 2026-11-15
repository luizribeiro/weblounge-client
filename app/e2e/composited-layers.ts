import type { CDPSession, Page } from "@playwright/test";

interface CompositedLayer {
  readonly backendNodeId?: number;
}

export async function compositedLayerOwners(
  page: Page,
  selector: string,
): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.getDocument", { depth: -1 });
    const layers = nextLayerTree(cdp);
    await cdp.send("LayerTree.enable");
    await repaintOneFrame(page);
    const owners = await Promise.all(
      (await layers).map((layer) => ownerLabel(cdp, layer, selector)),
    );
    return owners.filter((owner) => owner !== undefined);
  } finally {
    await cdp.detach();
  }
}

// A settled page commits no frames, so Chromium reports no layer tree until
// something repaints.
async function repaintOneFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const root = document.documentElement;
        const background = root.style.backgroundColor;
        root.style.backgroundColor = "rgb(1, 2, 3)";
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            root.style.backgroundColor = background;
            resolve();
          });
        });
      }),
  );
}

function nextLayerTree(cdp: CDPSession): Promise<readonly CompositedLayer[]> {
  return new Promise((resolve) => {
    cdp.once("LayerTree.layerTreeDidChange", ({ layers }) => {
      resolve(layers ?? []);
    });
  });
}

async function ownerLabel(
  cdp: CDPSession,
  layer: CompositedLayer,
  selector: string,
): Promise<string | undefined> {
  if (layer.backendNodeId === undefined) return undefined;
  const { object } = await cdp.send("DOM.resolveNode", {
    backendNodeId: layer.backendNodeId,
  });
  if (object.objectId === undefined) return undefined;
  const { result } = await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration:
      "function (selector) { const owner = this instanceof Element ? this.closest(selector) : null; return owner === null ? null : owner.getAttribute('aria-label') ?? owner.tagName; }",
    arguments: [{ value: selector }],
    returnByValue: true,
  });
  await cdp.send("Runtime.releaseObject", { objectId: object.objectId });
  return typeof result.value === "string" ? result.value : undefined;
}
