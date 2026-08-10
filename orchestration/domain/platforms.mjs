function platformTokens(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => (
    typeof entry === "string" ? entry.split(/[、,，;；/\s]+/) : []
  ));
}

export function normalizePlatforms(value) {
  return [...new Set(
    platformTokens(value)
      .map((platform) => platform.trim().toLowerCase())
      .filter(Boolean),
  )];
}

export function resolveTaskPlatforms(task) {
  const field = task?.custom_fields?.find(
    (candidate) => candidate.name === "影响平台" || candidate.id === "field-platforms",
  );
  return normalizePlatforms(field?.value);
}

export function requiresIosStaging(platforms) {
  return normalizePlatforms(platforms).includes("ios");
}
