import { DomainError } from "../domain/errors.mjs";

const SUPPORTED_PLATFORMS = new Set(["web", "api", "ios"]);

function invalid(message) {
  throw new DomainError("INVALID_PRODUCTION_PLATFORM_SCOPE", message);
}

function assertPlatforms(snapshot, index) {
  if (
    snapshot === null
    || typeof snapshot !== "object"
    || Array.isArray(snapshot)
    || !Object.hasOwn(snapshot, "platforms")
    || !Array.isArray(snapshot.platforms)
    || snapshot.platforms.length === 0
  ) {
    invalid(`production task snapshot ${index} must contain a non-empty platforms array`);
  }
  return snapshot.platforms;
}

export function resolveProductionPlatforms(taskSnapshots) {
  if (!Array.isArray(taskSnapshots) || taskSnapshots.length === 0) {
    invalid("production task snapshots must be a non-empty array");
  }
  const resolved = { web: false, api: false, ios: false, unsupported: [] };
  const unsupported = new Set();

  for (const [index, snapshot] of taskSnapshots.entries()) {
    for (const value of assertPlatforms(snapshot, index)) {
      if (typeof value !== "string" || value.trim() === "") {
        invalid(`production task snapshot ${index} has an invalid platform value`);
      }
      const platform = value.trim().toLowerCase();
      if (SUPPORTED_PLATFORMS.has(platform)) {
        resolved[platform] = true;
      } else if (platform !== "") {
        unsupported.add(platform);
      }
    }
  }

  resolved.unsupported = [...unsupported];
  return resolved;
}

export function assertProductionPlatformsSupported(taskSnapshots) {
  const platforms = resolveProductionPlatforms(taskSnapshots);
  if (platforms.unsupported.length > 0) {
    throw new DomainError(
      "UNSUPPORTED_PRODUCTION_PLATFORM",
      `production release does not support: ${platforms.unsupported.join(", ")}`,
      { unsupported: platforms.unsupported },
    );
  }
  return platforms;
}
