/** Load a compiled contract artifact by name. */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const buildDir = join(dirname(fileURLToPath(import.meta.url)), "..", "build");
const cache = new Map();

export function artifact(name) {
  if (!cache.has(name)) {
    cache.set(name, JSON.parse(readFileSync(join(buildDir, `${name}.json`), "utf8")));
  }
  return cache.get(name);
}
