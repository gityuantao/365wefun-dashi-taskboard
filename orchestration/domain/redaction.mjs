export function redactCredentials(value) {
  return String(value ?? "")
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@([^\s/?#]+)/gi,
      "$1[REDACTED]@$2",
    )
    .replace(/\b((?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(
      /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      "[REDACTED]",
    )
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

export function sanitizeObservedEvidenceString(value) {
  if (typeof value !== "string") return null;
  if (value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) return "[REDACTED]";
  return redactCredentials(value);
}
