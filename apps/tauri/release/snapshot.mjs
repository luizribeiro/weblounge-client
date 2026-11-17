import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const unchanged = (path, contents) => existsSync(path) && readFileSync(path).equals(contents);

export function snapshotFiles(paths) {
  const saved = paths.map((path) => [path, readFileSync(path)]);
  return () => {
    for (const [path, contents] of saved) {
      if (unchanged(path, contents)) continue;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
  };
}
