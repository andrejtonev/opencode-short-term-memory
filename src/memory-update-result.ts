/** An invocation result, distinct from the memory file left on disk. */
export type MemoryUpdateResult =
  | { readonly status: "updated" }
  | { readonly status: "deferred" }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "error"; readonly detail: string; readonly partial?: boolean };

/** Older embedders returned void or the deferred sentinel. */
export type MemoryUpdateDisposition = MemoryUpdateResult | void | "deferred";
