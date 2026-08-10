export function redactCredentials(value) {
  return String(value ?? "")
    .replace(
      /(["'](?:api[_-]?key|key|token|password|secret|authorization)["']\s*:\s*)(["'])(.*?)\2/gi,
      "$1$2[REDACTED]$2",
    )
    .replace(
      /(authorization\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\s,;}\]]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b((?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|key|token|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|pk_[A-Za-z0-9_-]{8,})\b/g,
      "[REDACTED]",
    );
}
