export type V2ResetBoundary = { readonly version: 1; readonly anchorID: string | null };

export function parseV2ResetBoundary(raw: Buffer): V2ResetBoundary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("malformed_reset_boundary");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 2 ||
    (parsed as Record<string, unknown>).version !== 1 ||
    ((parsed as Record<string, unknown>).anchorID !== null &&
      (typeof (parsed as Record<string, unknown>).anchorID !== "string" ||
        !(parsed as Record<string, string>).anchorID.trim()))
  ) {
    throw new Error("malformed_reset_boundary");
  }
  return parsed as V2ResetBoundary;
}
