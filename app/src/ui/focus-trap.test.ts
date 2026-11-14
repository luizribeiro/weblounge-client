import { afterEach, expect, it } from "vitest";
import { trapTab } from "./focus-trap";

afterEach(() => document.body.replaceChildren());

function dialog(): HTMLElement {
  const root = document.createElement("div");
  root.tabIndex = -1;
  root.innerHTML = `
    <button type="button">Close</button>
    <a href="https://files.example/a.png">Open original</a>
    <button type="button" disabled>Disabled</button>
    <div tabindex="-1">Skipped</div>`;
  document.body.append(root);
  return root;
}

function press(root: HTMLElement, key: string, shiftKey = false) {
  const event = new KeyboardEvent("keydown", {
    cancelable: true,
    key,
    shiftKey,
  });
  trapTab(event, root);
  return event;
}

it("wraps Tab from the last focusable element to the first", () => {
  const root = dialog();
  root.querySelector("a")?.focus();
  expect(press(root, "Tab").defaultPrevented).toBe(true);
  expect(document.activeElement?.textContent).toBe("Close");
});

it("wraps Shift+Tab from the first focusable element to the last", () => {
  const root = dialog();
  root.querySelector("button")?.focus();
  expect(press(root, "Tab", true).defaultPrevented).toBe(true);
  expect(document.activeElement?.textContent).toBe("Open original");
});

it("moves focus from the dialog itself into its controls", () => {
  const root = dialog();
  root.focus();
  expect(press(root, "Tab").defaultPrevented).toBe(true);
  expect(document.activeElement?.textContent).toBe("Close");
});

it("moves Shift+Tab from the dialog itself to its last control", () => {
  const root = dialog();
  root.focus();
  expect(press(root, "Tab", true).defaultPrevented).toBe(true);
  expect(document.activeElement?.textContent).toBe("Open original");
});

it("leaves Tab alone in a dialog without focusable controls", () => {
  const root = document.createElement("div");
  root.tabIndex = -1;
  document.body.append(root);
  root.focus();
  expect(press(root, "Tab").defaultPrevented).toBe(false);
});

it("leaves Tab between inner controls and other keys to the browser", () => {
  const root = dialog();
  root.querySelector("button")?.focus();
  expect(press(root, "Tab").defaultPrevented).toBe(false);
  expect(press(root, "Escape").defaultPrevented).toBe(false);
});

it("treats only the checked radio of a group as a tab stop", () => {
  const root = document.createElement("div");
  root.tabIndex = -1;
  root.innerHTML = `
    <button type="button">Close</button>
    <input type="radio" name="density" value="compact" />
    <input type="radio" name="density" value="cozy" checked />
    <input type="radio" name="density" value="comfortable" />`;
  document.body.append(root);
  root.focus();

  expect(press(root, "Tab", true).defaultPrevented).toBe(true);
  expect((document.activeElement as HTMLInputElement).value).toBe("cozy");
  expect(press(root, "Tab").defaultPrevented).toBe(true);
  expect(document.activeElement?.textContent).toBe("Close");
});
