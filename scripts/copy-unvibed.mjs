/*global console process */
// Graph mode (prototype): copy unvibed's graph format and its guide to writing
// a graph into the service bundle output, `packages/service/dist/unvibed/`.
//
// The graph-writing agent reads them, and the service hashes the format as a
// graph's schema. unvibed is a devDependency, so an install has only this
// copy; the files keep their places (shared/, docs/) so the guide's paths to
// the format still hold.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = path.join(ROOT, "packages/service/dist/unvibed");
const FILES = ["shared/graph.ts", "docs/writing-graphs.md"];

const unvibed = path.dirname(createRequire(import.meta.url).resolve("unvibed/package.json"));
rmSync(DEST, { recursive: true, force: true });
for (const file of FILES) {
  mkdirSync(path.dirname(path.join(DEST, file)), { recursive: true });
  cpSync(path.join(unvibed, file), path.join(DEST, file));
}
console.log(`copy-unvibed: ${FILES.length} files from ${unvibed} → ${path.relative(ROOT, DEST)}`);
process.exitCode = 0;
