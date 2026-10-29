import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

if (process.env.WEBLOUNGE_E2E_HARNESS !== "1") {
  const files = await descendants(resolve(import.meta.dirname, "../dist"));
  const sourceMaps = files.filter((file) => file.endsWith(".map"));
  if (sourceMaps.length > 0)
    throw new Error("production build contains source maps");
  let workerConstructorCount = 0;
  const workerUrls = [];
  for (const file of files) {
    const content = await readFile(file);
    const text = content.toString("utf8");
    if (text.includes("irc-password") || text.includes("WEBLOUNGE_IRC_")) {
      throw new Error(
        `production build contains debug IRC configuration: ${file}`,
      );
    }
    if (!file.endsWith(".js")) continue;
    workerConstructorCount += [
      ...text.matchAll(/new\s+(?:SharedWorker|Worker)\s*\(/gu),
    ].length;
    for (const match of text.matchAll(
      /new\s+(?:SharedWorker|Worker)\s*\(\s*new\s+URL\(\s*([`'"])([^`'"]+)\1/gu,
    )) {
      workerUrls.push(match[2]);
    }
    if (text.includes("URL.createObjectURL(")) {
      throw new Error(`production bundle creates a blob URL: ${file}`);
    }
  }
  if (workerConstructorCount !== 2 || workerUrls.length !== 2) {
    throw new Error(
      `expected two statically emitted worker URLs, found ${workerUrls.length} of ${workerConstructorCount} constructors`,
    );
  }
  for (const workerUrl of workerUrls) {
    if (!/^\/assets\/[^/]+\.js$/u.test(workerUrl)) {
      throw new Error(
        `production bundle contains an unsafe worker URL: ${workerUrl}`,
      );
    }
  }
}

async function descendants(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await descendants(path)));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}
