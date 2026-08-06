import { mkdtemp, rename, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_CONTROL = { enabled: true, updatedAt: null };

function normalize(raw) {
  if (raw && typeof raw === "object" && typeof raw.enabled === "boolean") {
    const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : null;
    return { enabled: raw.enabled, updatedAt };
  }
  return { ...DEFAULT_CONTROL };
}

export async function readControl(controlPath) {
  let raw;
  try {
    raw = JSON.parse(await readFile(controlPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { ...DEFAULT_CONTROL };
    return { enabled: false, updatedAt: null };
  }
  return normalize(raw);
}

export function shouldProcess(control) {
  return control?.enabled === true;
}

export async function writeControl(controlPath, { enabled }) {
  if (typeof enabled !== "boolean") {
    throw new TypeError("enabled must be a boolean");
  }
  const updatedAt = new Date().toISOString();
  const value = { enabled, updatedAt };
  const dir = path.dirname(controlPath);
  const temp = await mkdtemp(path.join(dir, ".control-"));
  const tempFile = path.join(temp, "control.json");
  await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempFile, controlPath);
  await rm(temp, { recursive: true, force: true });
  return value;
}
