import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(
  new URL("../web/src/components/dashboard/DashboardDialog.tsx", import.meta.url),
  "utf8",
).catch(() => "");

test("dashboard dialog is an accessible modal portal", () => {
  assert.match(source, /createPortal/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /event\.key === "Escape"/);
});

test("dashboard dialog traps focus and returns it to the exact trigger", () => {
  assert.match(source, /querySelectorAll<HTMLElement>/);
  assert.match(source, /event\.key === "Tab"/);
  assert.match(source, /triggerRef\.current\?\.focus\(\)/);
});
