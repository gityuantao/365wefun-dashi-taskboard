export function parseVersion(name) {
  const match = String(name ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

export function bumpVersion(name) {
  const parts = parseVersion(name);
  if (!parts) return "1.0.1";
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

export function maxVersionName(names) {
  const parsed = names
    .map((name) => ({ name, parts: parseVersion(name) }))
    .filter((entry) => entry.parts !== null);
  if (parsed.length === 0) return "1.0.0";
  parsed.sort((left, right) => {
    for (let index = 0; index < 3; index += 1) {
      if (left.parts[index] !== right.parts[index]) {
        return left.parts[index] - right.parts[index];
      }
    }
    return 0;
  });
  return parsed[parsed.length - 1].name;
}
