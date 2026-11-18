import { createRoot } from "solid-js";
import { expect, it } from "vitest";
import { createDocumentTheme } from "./document-theme";

const flushMutations = () =>
  new Promise<void>((resolve) => queueMicrotask(resolve));

function rootWithTheme(theme: string): HTMLElement {
  const root = document.createElement("html");
  root.dataset.theme = theme;
  return root;
}

it("starts from the applied theme and follows later changes", async () => {
  const root = rootWithTheme("lounge");
  const theme = createRoot(() => createDocumentTheme(root));
  expect(theme()).toBe("lounge");

  root.dataset.theme = "ne";
  await flushMutations();
  expect(theme()).toBe("ne");

  root.dataset.messageDensity = "compact";
  delete root.dataset.theme;
  await flushMutations();
  expect(theme()).toBeUndefined();
});

it("stops following the document once its owner is disposed", async () => {
  const root = rootWithTheme("ne");
  const theme = createRoot((dispose) => {
    const accessor = createDocumentTheme(root);
    dispose();
    return accessor;
  });

  root.dataset.theme = "black";
  await flushMutations();
  expect(theme()).toBe("ne");
});
