import { diagnosticErrorMessage, redactDiagnostic } from "./diagnostics";

type ErrorRow = Record<string, unknown>;

function row(value: unknown): ErrorRow | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ErrorRow) : undefined;
}

export type GenerationFailureKind = "model_restricted" | "authentication_failed" | "provider_error";

/** Safe, structured generation diagnostics; response bodies and headers are never retained. */
export class MemoryGenerationError extends Error {
  constructor(
    message: string,
    readonly kind: GenerationFailureKind,
    readonly statusCode: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MemoryGenerationError";
  }
}

export function providerGenerationError(error: unknown): MemoryGenerationError | undefined {
  return classifyProviderGenerationError(error, 0);
}

function classifyProviderGenerationError(error: unknown, depth: number): MemoryGenerationError | undefined {
  if (error instanceof MemoryGenerationError) return error;
  const outer = row(error);
  if (!outer) return undefined;
  const data = row(outer.data) ?? outer;
  let remote = row(data.error);
  if (typeof data.responseBody === "string" && data.responseBody.length <= 16_384) {
    try {
      remote = row(row(JSON.parse(data.responseBody))?.error) ?? remote;
    } catch {
      // Non-JSON response text is not a trusted diagnostic or classification source.
    }
  }
  const statusCode = typeof data.statusCode === "number" ? data.statusCode : undefined;
  const codes = [remote?.code, remote?.type, data.code, data.type, outer.name];
  if (statusCode === 403 && codes.includes("FreeTierError")) {
    return new MemoryGenerationError(
      "OpenCode rejected this memory request with FreeTierError (403). Select an accessible memoryModel explicitly in STM config, or wait for OpenCode to support isolated summarization with this model.",
      "model_restricted",
      statusCode,
      false,
    );
  }
  if (statusCode === 401 || codes.includes("api_key_expired")) {
    const expired = codes.includes("api_key_expired");
    return new MemoryGenerationError(
      expired
        ? "The provider rejected an expired API key (api_key_expired). For OpenCode V1, run opencode console login, select an organization, and restart OpenCode. If you intentionally use a legacy API key, replace that key in OpenCode Console."
        : "Provider authentication failed (401). For OpenCode V1 models, run opencode console login, select an organization, and restart OpenCode. For other providers, check their configured credentials.",
      "authentication_failed",
      statusCode,
      false,
    );
  }
  if (typeof data.isRetryable !== "boolean" && statusCode === undefined)
    return depth < 3 ? classifyProviderGenerationError(outer.cause, depth + 1) : undefined;
  const retryable = data.isRetryable === true && statusCode !== 401 && statusCode !== 403;
  return new MemoryGenerationError(
    `Memory generation failed${statusCode === undefined ? "" : ` (provider HTTP ${statusCode})`}. Check the selected memoryModel and provider configuration.`,
    "provider_error",
    statusCode,
    retryable,
  );
}

export function generationErrorMessage(error: unknown): string {
  const classified = providerGenerationError(error);
  return classified ? redactDiagnostic(classified.message) : diagnosticErrorMessage(error);
}

export function isPermanentGenerationError(error: unknown): boolean {
  const classified = providerGenerationError(error);
  return classified !== undefined && !classified.retryable;
}
