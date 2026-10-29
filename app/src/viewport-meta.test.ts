import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("lets iOS report safe-area insets so the shell clears the home indicator", () => {
  const html = readFileSync("index.html", "utf8");
  const viewport = html.match(/name="viewport"\s+content="([^"]+)"/)?.[1];

  expect(viewport?.split(",").map((part) => part.trim())).toContain(
    "viewport-fit=cover",
  );
});
