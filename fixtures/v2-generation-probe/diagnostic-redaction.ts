const sensitiveKey = /authorization|cookie|password|secret|token|api[-_]?key|credential/i;

export function redactDiagnostic(text: string, secrets: readonly string[]) {
  for (const secret of secrets.filter(Boolean)) text = text.replaceAll(secret, "[redacted]");
  return text
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/.=_-]+/gi, "$1 [redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:api[-_]?key|token|access_token|password|secret|sig)=)[^\s&#"'<>]*/gi, "$1[redacted]")
    .replace(
      /(\b(?:authorization|cookie|password|secret|token|access_token|api[-_]?key|credential(?:s)?|sig)\b["']?\s*[:=]\s*)(?:\[redacted\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)/gi,
      "$1[redacted]",
    );
}

export function serializeFailure(value: unknown, secrets: readonly string[] = []): unknown {
  const seen = new WeakSet<object>();
  let remaining = 400;
  const visit = (value: unknown, depth: number): unknown => {
    if (--remaining < 0) return "[node limit]";
    if (typeof value === "string") {
      const text = redactDiagnostic(value, secrets);
      return text.length > 4_096 ? `${text.slice(0, 4_096)}[truncated]` : text;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (typeof value !== "object")
      return typeof value === "bigint" || value === undefined ? String(value) : `[${typeof value}]`;
    if (seen.has(value)) return "[circular]";
    if (depth >= 6) return "[depth limit]";
    seen.add(value);
    if (Array.isArray(value)) {
      const result = value.slice(0, 40).map((item) => visit(item, depth + 1));
      if (value.length > 40) result.push("[entry limit]");
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    // Error diagnostics are non-enumerable; inspect descriptors without invoking getters/toJSON.
    const keys = [
      ...new Set([
        "_tag",
        "message",
        "command",
        ...(value instanceof Error ? ["name", "stack", "cause"] : []),
        ...Object.keys(value),
      ]),
    ];
    for (const key of keys.slice(0, 40)) {
      const descriptor =
        Object.getOwnPropertyDescriptor(value, key) ??
        (value instanceof Error && key === "name"
          ? (Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), key) ??
            Object.getOwnPropertyDescriptor(Error.prototype, key))
          : undefined);
      if (!descriptor && !(value instanceof Error && key === "name")) continue;
      const name = redactDiagnostic(key, secrets).slice(0, 4_096);
      result[name] = sensitiveKey.test(key)
        ? "[redacted]"
        : descriptor && !("value" in descriptor)
          ? "[accessor]"
          : visit(descriptor?.value, depth + 1);
    }
    if (keys.length > 40) result["[entry limit]"] = true;
    return result;
  };
  try {
    return visit(value, 0);
  } catch {
    return "[uninspectable diagnostic]";
  }
}

// Evidence is plain parsed JSON fixture data, not Errors/accessors/toJSON objects; retain every record without limits.
export function serializeEvidence(value: unknown, secrets: readonly string[] = []): string {
  return JSON.stringify(
    value,
    (key, value) =>
      sensitiveKey.test(key) ? "[redacted]" : typeof value === "string" ? redactDiagnostic(value, secrets) : value,
    2,
  );
}
