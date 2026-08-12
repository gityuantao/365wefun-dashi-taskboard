const PATH_RULES = Object.freeze([
  ["apps/android-web-wrapper/", "android_twa"],
  ["apps/android/", "android_native", true],
  ["apps/ios/", "ios"],
  ["apps/mp/", "mini_program"],
  ["apps/web/", "web"],
  ["apps/api/", "api"],
  ["api/", "api"],
  ["database/", "api"],
  ["db/", "api"],
  ["services/api/", "api"],
]);

export function classifyChangedPaths(changedPaths) {
  const platforms = new Set();
  const unsupported = new Set();
  for (const changedPath of [...new Set((changedPaths ?? [])
    .filter((value) => typeof value === "string" && value.trim() !== ""))].sort()) {
    const rule = PATH_RULES.find(([prefix]) => changedPath.startsWith(prefix));
    if (!rule) continue;
    const [, platform, unsupportedPlatform = false] = rule;
    if (unsupportedPlatform) unsupported.add(platform);
    else platforms.add(platform);
  }
  return { platforms: [...platforms].sort(), unsupported: [...unsupported].sort() };
}
