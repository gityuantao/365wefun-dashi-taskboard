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

export function inferPlatformsFromText(value) {
  const text = String(value ?? "").toLowerCase();
  const platforms = [];
  if (/\b(?:ios|iphone|ipad)\b|苹果端|苹果 app/.test(text)) platforms.push("ios");
  if (/\bandroid\b|安卓/.test(text)) platforms.push("android");
  if (/\bweb\b|网页|前台页面/.test(text)) platforms.push("web");
  if (/小程序|mini[- ]?program/.test(text)) platforms.push("mini-program");
  return platforms;
}

function resolveSelectedOption(field, selected) {
  const options = field?.type_config?.options ?? [];
  const option = options.find((candidate) => (
    String(candidate?.id ?? "") === String(
      selected !== null && typeof selected === "object" ? selected.id : selected,
    )
  ));
  if (option) return option.name ?? option.label ?? option.id;
  if (selected !== null && typeof selected === "object") {
    return selected.name ?? selected.label ?? selected.id;
  }
  return selected;
}

export function resolveTaskPlatforms(task) {
  const field = task?.custom_fields?.find(
    (candidate) => candidate.name === "影响平台" || candidate.id === "field-platforms",
  );
  const selected = Array.isArray(field?.value) ? field.value : [field?.value];
  return normalizePlatforms(selected.map((value) => resolveSelectedOption(field, value)));
}

export function requiresIosStaging(platforms) {
  return normalizePlatforms(platforms).includes("ios");
}
