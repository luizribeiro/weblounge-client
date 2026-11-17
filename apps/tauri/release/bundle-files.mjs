import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

// App Store Connect rejects a bundle holding an empty directory as having no executable (90207).
export function findEmptyDirectories(root, dir = root) {
  const entries = readdirSync(dir, { withFileTypes: true });
  if (entries.length === 0) return [relative(root, dir)];
  return entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => findEmptyDirectories(root, join(dir, entry.name)));
}
