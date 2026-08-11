const SUPPORTED_PLATFORMS = new Set(["web", "api", "ios"]);

export function resolveProductionPlatforms(taskSnapshots) {
  const resolved = { web: false, api: false, ios: false, unsupported: [] };
  const unsupported = new Set();

  for (const snapshot of taskSnapshots) {
    for (const value of snapshot.platforms) {
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
