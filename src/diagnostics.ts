/** Presentation-only protection. Never apply this to prompts, conversation or memory storage. */
const credentialField =
  /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|(?:.*[-_])?(?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|secret|password|credential|key|sig)|apiKey|accessToken|refreshToken|clientSecret)$/i;
const rawProviderField = /^(?:requestBody|responseBody|requestHeaders|responseHeaders)$/i;

export function redactDiagnostic(text: string): string {
  // Large remote diagnostics are discarded whole, avoiding both excessive scanning
  // and retaining a credential fragment at a truncation boundary.
  if (text.length > 16_384) return `Diagnostic text omitted (${text.length} characters).`;
  let safe = text;
  // Read inherited credentials only; never retrieve or persist authentication material.
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && credentialField.test(name)) safe = safe.split(value).join("[REDACTED]");
  }
  return safe
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g, "[REDACTED]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g,
      "[REDACTED]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "$1 [REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/(^|\n)([ \t]*(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]*/gi, "$1$2[REDACTED]")
    .replace(
      /(["']?(?:requestBody|responseBody|requestHeaders|responseHeaders)["']?\s*[:=]\s*)[\s\S]*/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(["']?(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|api[-_]?key|token|key|sig|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|credential|secret)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)/gi,
      "$1[REDACTED]",
    );
}

export function diagnosticErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return redactDiagnostic(message);
}

/** A replacer preserves normal JSON serialization and does not mutate the input. */
export function diagnosticJson(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => {
    if (credentialField.test(key) || rawProviderField.test(key)) return "[REDACTED]";
    return typeof item === "string" ? redactDiagnostic(item) : item;
  });
}
