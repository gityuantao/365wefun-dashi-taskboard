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

test("busy dialog with no enabled controls keeps focus inside the modal", () => {
  assert.match(source, /tabIndex=\{-1\}/);
  assert.match(source, /document\.addEventListener\("keydown", handleDocumentKeyDown, true\)/);
  assert.match(source, /document\.addEventListener\("focusin", containFocus, true\)/);
  assert.match(source, /if \(busy \|\| closeDisabled\)[\s\S]*?dialogRef\.current\?\.focus\(\)/);
});
