// Stamps dist/sw.js with a hash of the built assets after `vite build`.
// Each deploy therefore gets a new service-worker cache name, so the old
// shell is evicted on activate and installed users receive updates.
// (Done as a post-build step rather than a vite plugin: Vite's public-dir
// copy races with plugin hooks, and this must run after the build is done.)
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const file = "dist/sw.js";
if (!existsSync(file)) {
  console.log("stamp-sw: no dist/sw.js, skipping");
  process.exit(0);
}
const src = readFileSync(file, "utf8");
if (!src.includes("__SW_VERSION__")) {
  console.log("stamp-sw: no version token, skipping");
  process.exit(0);
}
const html = readFileSync("dist/index.html", "utf8");
const assets = [...html.matchAll(/assets\/[\w.-]+/g)].map((m) => m[0]).join(",");
const version = createHash("sha256").update(assets).digest("hex").slice(0, 10);
writeFileSync(file, src.replace("__SW_VERSION__", version));
console.log(`stamp-sw: cache version ${version}`);
