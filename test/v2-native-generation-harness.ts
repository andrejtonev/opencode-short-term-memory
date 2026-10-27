import type { V2Context, V2SessionContext } from "../src/v2-adapter";

type LegacyModel = { readonly providerID: string; readonly id: string; readonly variant?: string };
type CleanProvider = (
  input: { readonly prompt: string; readonly model?: unknown },
  signal?: AbortSignal,
  generation?: V2SessionContext,
) => Promise<{ text: string }>;
type ActiveProvider = (
  input: { readonly sessionID: string; readonly prompt: string },
  signal?: AbortSignal,
  generation?: V2SessionContext,
) => Promise<{ text: string }>;

export interface V2NativeGenerationHarnessOptions {
  readonly clean?: CleanProvider;
  readonly active?: ActiveProvider;
  readonly defaultModel?: LegacyModel;
  readonly cleanSystem?: V2SessionContext["system"];
  readonly createdSessionID?: string;
  readonly activeRequest?: (input: NativeGenerateInput) => V2SessionContext;
  readonly dispatchHooks?: boolean;
  readonly remove?: (sessionID: string) => Promise<void>;
  readonly beforeCreate?: (sessionID: string) => void;
}

type NativeSessionRecord = {
  readonly id: string;
  readonly parentID: null;
  readonly title?: string;
  readonly agent: string;
  readonly model: LegacyModel;
  readonly explicitModel?: LegacyModel;
  readonly location: { readonly directory: string };
  readonly metadata: Record<string, unknown>;
};
type NativeCreateInput = {
  readonly id?: string;
  readonly title?: string;
  readonly agent?: string;
  readonly model?: LegacyModel;
  readonly location?: { readonly directory: string };
  readonly metadata?: Record<string, unknown>;
};
type NativeGenerateInput = { readonly sessionID: string; readonly prompt: string };
type Registration = { dispose: () => Promise<void> };
type Hook = (request: V2SessionContext) => void | Promise<void>;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function finalText(request: V2SessionContext): string {
  const message = request.messages.at(-1);
  if (!message || message.role !== "user") return "";
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function setValue(target: object, key: string, value: unknown): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    writable: true,
    value,
  });
  return descriptor;
}

/**
 * Adapt native session generation to the older Generate.text/session.generate callbacks in unit
 * tests. Production never imports this adapter; hooks, owned session lifetime, and model routing
 * still run through the production native-generation helpers.
 */
export function installV2NativeGenerationHarness(context: V2Context, options: V2NativeGenerationHarnessOptions = {}) {
  const session = context.session as unknown as Record<string, unknown>;
  const callbacks = new Set<Hook>();
  const sessions = new Map<string, NativeSessionRecord>();
  const calls = {
    create: [] as Array<{ input: NativeCreateInput; session: NativeSessionRecord }>,
    get: [] as Array<{ sessionID: string }>,
    remove: [] as Array<{ sessionID: string }>,
    generate: [] as Array<{ input: NativeGenerateInput; request: V2SessionContext; mode: string; model: LegacyModel }>,
    clean: [] as Array<{ input: { prompt: string; model?: unknown }; request: V2SessionContext }>,
    active: [] as Array<{ input: { sessionID: string; prompt: string }; request: V2SessionContext }>,
  };
  const defaultModel = options.defaultModel ?? { providerID: "provider", id: "model" };
  const previousGet = session.get as
    | ((input: { sessionID: string }, request?: unknown) => Promise<unknown>)
    | undefined;
  const previousHook = session.hook as
    | ((name: string, callback: Hook, ...rest: unknown[]) => Promise<Registration>)
    | undefined;
  let activeCaptureSessionID: string | undefined;
  let generatedID = 0;

  const get = async ({ sessionID }: { sessionID: string }, request?: unknown): Promise<unknown> => {
    calls.get.push({ sessionID });
    const owned = sessions.get(sessionID);
    if (owned) return owned;
    if (previousGet) return previousGet.call(session, { sessionID }, request);
    throw new Error(`session_not_found:${sessionID}`);
  };

  const create = async (input: NativeCreateInput): Promise<NativeSessionRecord> => {
    const requestedID = input.id ?? `ses_test_${++generatedID}`;
    options.beforeCreate?.(requestedID);
    const id = options.createdSessionID ?? requestedID;
    if (sessions.has(id)) throw new Error(`session_already_exists:${id}`);
    const sessionRecord: NativeSessionRecord = {
      id,
      parentID: null,
      ...(input.title ? { title: input.title } : {}),
      agent: input.agent ?? "build",
      model: input.model ?? defaultModel,
      ...(input.model ? { explicitModel: input.model } : {}),
      location: input.location ?? { directory: context.location.directory },
      metadata: input.metadata ?? {},
    };
    sessions.set(id, sessionRecord);
    calls.create.push({ input, session: sessionRecord });
    return sessionRecord;
  };

  const remove = async ({ sessionID }: { sessionID: string }): Promise<void> => {
    calls.remove.push({ sessionID });
    if (options.remove) await options.remove(sessionID);
    sessions.delete(sessionID);
  };

  const hook = async (name: string, callback: Hook, ...rest: unknown[]): Promise<Registration> => {
    const delegate = previousHook ? await previousHook.call(session, name, callback, ...rest) : undefined;
    if (name === "generate") callbacks.add(callback);
    let disposed = false;
    return {
      async dispose() {
        if (disposed) return;
        disposed = true;
        callbacks.delete(callback);
        await delegate?.dispose();
      },
    };
  };

  const generate = async (
    input: NativeGenerateInput,
    requestOptions?: { readonly signal?: AbortSignal },
  ): Promise<{ text: string }> => {
    requestOptions?.signal?.throwIfAborted();
    const sessionRecord = sessions.get(input.sessionID);
    const activeSeed =
      !sessionRecord && input.prompt.includes("[STM_ACTIVE_CAPTURE:") ? options.activeRequest?.(input) : undefined;
    const sessionInfo = sessionRecord ?? (activeSeed ? {} : record(await get({ sessionID: input.sessionID })));
    const model = (record(sessionInfo).model as LegacyModel | undefined) ?? defaultModel;
    const metadata = record(record(sessionInfo).metadata);
    const mode = typeof metadata.stmSummaryMode === "string" ? metadata.stmSummaryMode : "active";
    const request =
      activeSeed ??
      ({
        sessionID: input.sessionID,
        agent: typeof record(sessionInfo).agent === "string" ? (record(sessionInfo).agent as string) : "build",
        model,
        system: structuredClone(options.cleanSystem ?? [{ type: "text", text: "native OpenCode agent identity" }]),
        messages: [{ role: "user", content: [{ type: "text", text: input.prompt }] }],
        options: {} as V2SessionContext["options"],
        tools: { stm_memory_update: { description: "Update memory", input: {} } },
      } as V2SessionContext);
    if (input.prompt.includes("[STM_ACTIVE_CAPTURE:")) activeCaptureSessionID = input.sessionID;
    calls.generate.push({ input, request, mode, model });
    if (options.dispatchHooks !== false) {
      for (const callback of [...callbacks]) await callback(request);
    }
    requestOptions?.signal?.throwIfAborted();
    const prompt = finalText(request);
    if (mode === "clean") {
      const providerInput = {
        prompt,
        ...(sessionRecord?.explicitModel ? { model: sessionRecord.explicitModel } : {}),
      };
      calls.clean.push({ input: providerInput, request });
      return options.clean ? options.clean(providerInput, requestOptions?.signal, request) : { text: "" };
    }
    const providerInput = {
      sessionID: mode === "active_override" ? (activeCaptureSessionID ?? input.sessionID) : input.sessionID,
      prompt,
    };
    calls.active.push({ input: providerInput, request });
    return options.active ? options.active(providerInput, requestOptions?.signal, request) : { text: "" };
  };

  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ create, get, remove, generate, hook }))
    originals.set(key, setValue(session, key, value));

  let disposed = false;
  return {
    calls,
    sessions,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      callbacks.clear();
      for (const [key, descriptor] of originals) {
        const current = Object.getOwnPropertyDescriptor(session, key);
        if (!current || current.value !== ({ create, get, remove, generate, hook } as Record<string, unknown>)[key])
          continue;
        if (descriptor) Object.defineProperty(session, key, descriptor);
        else delete session[key];
      }
    },
  };
}
