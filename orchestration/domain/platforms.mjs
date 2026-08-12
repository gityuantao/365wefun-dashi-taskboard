function platformTokens(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => (
    typeof entry === "string" ? entry.split(/[、,，;；/\s]+/) : []
  ));
}

export function normalizePlatforms(value) {
  return [...new Set(
    platformTokens(value)
      .map((platform) => {
        const normalized = platform.trim().toLowerCase();
        if (["服务端", "server", "backend"].includes(normalized)) return "api";
        if (["小程序", "mini-program", "mini_program", "mp-weixin"].includes(normalized)) return "mini_program";
        return normalized;
      })
      .filter(Boolean),
  )];
}

export function inferPlatformsFromText(value) {
  const text = String(value ?? "").toLowerCase();
  const clauses = text.split(/[；;。！!？?\n]/).map((clause) => clause.trim()).filter(Boolean);
  const platforms = [];
  const excluded = /不在.*范围|不涉及|无需|不用|排除|不修改/;
  const mentionedInScope = (pattern) => clauses.some((clause) => (
    pattern.test(clause) && !excluded.test(clause)
  ));
  if (mentionedInScope(/\b(?:ios|iphone|ipad)\b|苹果端|苹果 app/)) platforms.push("ios");
  if (mentionedInScope(/\bandroid\b|安卓/)) platforms.push("android");
  if (mentionedInScope(/\bweb\b|网页|前台页面/)) platforms.push("web");
  if (mentionedInScope(/小程序|mini[-_ ]?program|mp-weixin/)) platforms.push("mini_program");
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
