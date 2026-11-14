import { describe, expect, it } from "vitest";
import { inlineImageUrl } from "./inline-image-url";

const filehost = "https://files.example.test";

describe("inlineImageUrl", () => {
  it.each([
    ["png", "look https://files.example.test/aZ09_-x.png", "/aZ09_-x.png"],
    ["jpg", "https://files.example.test/a.jpg", "/a.jpg"],
    ["jpeg", "https://files.example.test/a.JPEG", "/a.JPEG"],
    ["gif", "https://files.example.test/a.gif", "/a.gif"],
    ["webp", "https://files.example.test/a.webp", "/a.webp"],
    ["trailing punctuation", "(https://files.example.test/a.png).", "/a.png"],
    ["host case", "https://FILES.example.test/a.png", "/a.png"],
  ])("picks a file host %s", (_label, text, path) => {
    expect(inlineImageUrl(text, filehost)).toBe(`${filehost}${path}`);
  });

  it("keeps a query and honours a non-default file host port", () => {
    expect(
      inlineImageUrl("https://files.example.test/a.png?v=2#top", filehost),
    ).toBe("https://files.example.test/a.png?v=2#top");
    expect(
      inlineImageUrl(
        "https://files.example.test:8443/a.png",
        "https://files.example.test:8443",
      ),
    ).toBe("https://files.example.test:8443/a.png");
  });

  it("returns the first eligible image of several", () => {
    expect(
      inlineImageUrl(
        "https://files.example.test/upload https://files.example.test/one.gif https://files.example.test/two.png",
        filehost,
      ),
    ).toBe(`${filehost}/one.gif`);
  });

  it.each([
    ["another site", "https://images.example.test/a.png"],
    ["a look-alike host", "https://files.example.test.evil.test/a.png"],
    ["plain http", "http://files.example.test/a.png"],
    ["a different port", "https://files.example.test:8443/a.png"],
    ["svg", "https://files.example.test/a.svg"],
    ["a non-image path", "https://files.example.test/upload"],
    ["an extension in the query", "https://files.example.test/a?x.png"],
    ["no link", "files.example.test/a.png is down"],
    ["empty text", ""],
  ])("ignores %s", (_label, text) => {
    expect(inlineImageUrl(text, filehost)).toBeUndefined();
  });

  it("inlines nothing on a network without a file host", () => {
    expect(
      inlineImageUrl("https://files.example.test/a.png", undefined),
    ).toBeUndefined();
  });
});
