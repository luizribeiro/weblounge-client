import { beforeEach, describe, expect, it } from "vitest";
import { createTabIndicatorWriter } from "./tab-indicator-writer";

function iconHrefs(): (string | null)[] {
  return [...document.querySelectorAll('link[rel="icon"]')].map((link) =>
    link.getAttribute("href"),
  );
}

describe("createTabIndicatorWriter", () => {
  beforeEach(() => {
    document.head.innerHTML = `
      <link rel="icon" href="/icons/favicon.svg" type="image/svg+xml" />
      <link rel="icon" href="/icons/favicon-32.png" type="image/png" sizes="32x32" />
      <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
      <title>weblounge</title>`;
  });

  it("swaps both favicon links and the title, leaving the touch icon", () => {
    const write = createTabIndicatorWriter(document);

    write({ icon: "unread", title: "(2) weblounge" });

    expect(iconHrefs()).toEqual([
      "/icons/favicon-unread.svg",
      "/icons/favicon-32-unread.png",
    ]);
    expect(document.title).toBe("(2) weblounge");
    expect(
      document
        .querySelector('link[rel="apple-touch-icon"]')
        ?.getAttribute("href"),
    ).toBe("/icons/apple-touch-icon.png");

    write({ icon: "disconnected", title: "weblounge" });
    expect(iconHrefs()).toEqual([
      "/icons/favicon-disconnected.svg",
      "/icons/favicon-32-disconnected.png",
    ]);
    expect(document.title).toBe("weblounge");

    write({ icon: "connected", title: "weblounge" });
    expect(iconHrefs()).toEqual([
      "/icons/favicon.svg",
      "/icons/favicon-32.png",
    ]);
  });

  it("writes nothing while the state is unchanged", () => {
    const write = createTabIndicatorWriter(document);
    const observer = new MutationObserver(() => undefined);
    observer.observe(document.head, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });

    write({ icon: "connected", title: "weblounge" });
    const atLoad = observer.takeRecords();
    write({ icon: "unread", title: "(1) weblounge" });
    const onChange = observer.takeRecords();
    write({ icon: "unread", title: "(1) weblounge" });
    const repeated = observer.takeRecords();
    observer.disconnect();

    expect(atLoad).toHaveLength(0);
    expect(onChange.length).toBeGreaterThan(0);
    expect(repeated).toHaveLength(0);
  });
});
