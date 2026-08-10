import { DomainError } from "../domain/errors.mjs";

const SUPPORTED_BUILD_NUMBER_SOURCES = new Set(["app-store-connect"]);
const REQUIRED_FIELDS = [
  "id",
  "name",
  "enabled",
  "scheme",
  "testScheme",
  "testTarget",
  "bundleId",
  "testFlightGroup",
  "buildNumberSource",
];

function invalid(field, message) {
  throw new DomainError("INVALID_IOS_APP_CONFIG", message, { field });
}

function assertPlainObject(value, field) {
  const prototype = value === null || typeof value !== "object" ? null : Object.getPrototypeOf(value);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (prototype !== Object.prototype && prototype !== null)
  ) {
    invalid(field, `iOS app config field "${field}" must be a plain object`);
  }
}

function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(field, `iOS app config field "${field}" must be a non-empty string`);
  }
}

function assertUnique(value, seen, field) {
  if (seen.has(value)) {
    invalid(field, `iOS app config field "${field}" must be unique`);
  }
  seen.add(value);
}

function freezeApp(app) {
  return Object.freeze({ ...app });
}

export function loadIosApps(value) {
  if (!Array.isArray(value)) {
    invalid("iosApps", "iOS app config field \"iosApps\" must be an array");
  }

  const ids = new Set();
  const schemes = new Set();
  const bundleIds = new Set();
  let enabledCount = 0;

  const apps = value.map((app, index) => {
    const prefix = `iosApps[${index}]`;
    assertPlainObject(app, prefix);
    for (const field of REQUIRED_FIELDS) {
      if (!Object.hasOwn(app, field)) {
        invalid(`${prefix}.${field}`, `iOS app config field "${prefix}.${field}" is required`);
      }
    }

    for (const field of ["id", "name", "scheme", "testScheme", "testTarget", "bundleId", "testFlightGroup", "buildNumberSource"]) {
      assertNonEmptyString(app[field], `${prefix}.${field}`);
    }
    if (typeof app.enabled !== "boolean") {
      invalid(`${prefix}.enabled`, `iOS app config field "${prefix}.enabled" must be a boolean`);
    }
    if (!SUPPORTED_BUILD_NUMBER_SOURCES.has(app.buildNumberSource)) {
      invalid(
        `${prefix}.buildNumberSource`,
        `iOS app config field "${prefix}.buildNumberSource" has an unsupported build number source`,
      );
    }

    assertUnique(app.id, ids, `${prefix}.id`);
    assertUnique(app.scheme, schemes, `${prefix}.scheme`);
    assertUnique(app.bundleId, bundleIds, `${prefix}.bundleId`);
    if (app.enabled) enabledCount += 1;

    return freezeApp({
      id: app.id,
      name: app.name,
      enabled: app.enabled,
      scheme: app.scheme,
      testScheme: app.testScheme,
      testTarget: app.testTarget,
      bundleId: app.bundleId,
      testFlightGroup: app.testFlightGroup,
      buildNumberSource: app.buildNumberSource,
    });
  });

  if (enabledCount === 0) {
    invalid("iosApps", "iOS app config must include at least one enabled app");
  }
  return Object.freeze(apps);
}

export function enabledIosApps(registry) {
  return Object.freeze(registry.filter((app) => app.enabled));
}
