import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const cloudCollaborationGuide = readFileSync(new URL("../docs/cloud-collaboration.md", import.meta.url), "utf8");

test("pnpm is the only documented and locked package manager", () => {
  assert.match(pkg.packageManager, /^pnpm@/);
  assert.equal(existsSync(new URL("../pnpm-lock.yaml", import.meta.url)), true);
  assert.equal(existsSync(new URL("../package-lock.json", import.meta.url)), false);
  assert.equal(pkg.scripts.check, "pnpm typecheck && pnpm build && pnpm test");
});

test("active cloud collaboration commands use pnpm", () => {
  assert.doesNotMatch(cloudCollaborationGuide, /\bnpm(?:\s|$)/);
});
