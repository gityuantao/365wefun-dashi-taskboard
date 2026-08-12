import { DomainError } from "../domain/errors.mjs";

const REQUIRED_FIELDS = Object.freeze([
  "id", "name", "enabled", "appId", "sourceDirectory", "buildCommand",
  "artifactDirectory", "uploadCommand", "reviewCommand", "releaseCommand",
  "readbackCommand", "credentialsPath", "reviewConfigurationRef",
]);
const COMMAND_FIELDS = new Set([
  "buildCommand", "uploadCommand", "reviewCommand", "releaseCommand", "readbackCommand",
]);
const REFERENCE_FIELDS = new Set(["credentialsPath", "reviewConfigurationRef"]);

function invalid(field, message) {
  throw new DomainError("INVALID_MINI_PROGRAM_APP_CONFIG", message, { field });
}

function plain(value, field) {
  const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : null;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)) {
    invalid(field, `mini-program app config field "${field}" must be a plain object`);
  }
}

function string(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(field, `mini-program app config field "${field}" must be a non-empty string`);
  }
}

function command(value, field) {
  if (!Array.isArray(value) || value.length === 0) invalid(field, `mini-program app config field "${field}" must be a non-empty command array`);
  value.forEach((part) => string(part, field));
}

function reference(value, field) {
  string(value, field);
  if (/\b(?:token|secret|password|private[_-]?key)\s*=/i.test(value)) {
    invalid(field, `mini-program app config field "${field}" must be a non-secret reference`);
  }
}

function unique(value, seen, field) {
  if (seen.has(value)) invalid(field, `mini-program app config field "${field}" must be unique`);
  seen.add(value);
}

export function loadMiniProgramApps(config) {
  if (!Array.isArray(config)) invalid("miniProgramApps", "mini-program app config must be an array");
  const ids = new Set();
  const appIds = new Set();
  let enabled = 0;
  const apps = config.map((app, index) => {
    const prefix = `miniProgramApps[${index}]`;
    if (!app || typeof app !== "object" || Array.isArray(app)) plain(app, prefix);
    for (const field of REQUIRED_FIELDS) {
      if (!Object.hasOwn(app, field)) invalid(`${prefix}.${field}`, `mini-program app config field "${prefix}.${field}" is required as an own property`);
    }
    plain(app, prefix);
    const unsupported = Object.keys(app).filter((field) => !REQUIRED_FIELDS.includes(field));
    if (unsupported.length > 0) invalid(prefix, `mini-program app config has unsupported field "${unsupported[0]}"`);
    for (const field of REQUIRED_FIELDS) {
      if (field === "enabled") {
        if (typeof app[field] !== "boolean") invalid(`${prefix}.${field}`, `mini-program app config field "${prefix}.${field}" must be a boolean`);
      } else if (COMMAND_FIELDS.has(field)) command(app[field], `${prefix}.${field}`);
      else if (REFERENCE_FIELDS.has(field)) reference(app[field], `${prefix}.${field}`);
      else string(app[field], `${prefix}.${field}`);
    }
    unique(app.id, ids, `${prefix}.id`);
    unique(app.appId, appIds, `${prefix}.appId`);
    if (app.enabled) enabled += 1;
    return Object.freeze(Object.fromEntries(REQUIRED_FIELDS.map((field) => [
      field,
      COMMAND_FIELDS.has(field) ? Object.freeze([...app[field]]) : app[field],
    ])));
  });
  if (enabled === 0) invalid("miniProgramApps", "mini-program app config must include at least one enabled app");
  return Object.freeze(apps);
}

export function enabledMiniProgramApps(registry) {
  return Object.freeze(registry.filter((app) => app.enabled));
}
