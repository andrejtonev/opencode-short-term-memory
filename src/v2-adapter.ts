import type { PluginOptions } from "@opencode/plugin";
import type { CommandDefinition } from "@opencode/plugin/promise/command";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { SessionCompaction, SessionContext } from "@opencode/plugin/promise/session";
import type { Info as ToolDefinition } from "@opencode/plugin/promise/tool";
import type { RuntimeContract, RuntimeDisposer, RuntimeMutation, RuntimeNamedRegistration } from "./runtime-contract";
import { unsupportedRuntimeOperation } from "./runtime-contract";

export type V2Context = Context;
export type V2SessionContext = SessionContext;
export type V2SessionCompaction = SessionCompaction;
export type V2ToolDefinition = ToolDefinition;
export type V2CommandDefinition = CommandDefinition;

export type V2RuntimeContract = RuntimeContract<
  unknown,
  V2SessionContext,
  unknown,
  unknown,
  V2SessionContext,
  unknown,
  V2SessionCompaction,
  unknown,
  V2ToolDefinition,
  V2CommandDefinition,
  PluginOptions,
  unknown
>;

export interface V2Adapter {
  readonly runtime: V2RuntimeContract;
  readonly dispose: () => Promise<void>;
}

const capabilities = Object.freeze({
  readSessionMetadata: false,
  readSessionHistory: false,
  readSessionMessages: false,
  readSessionContext: false,
  deliverGeneratedPrompt: false,
  deliverContextNoReply: false,
  createTemporarySession: false,
  abortTemporarySession: false,
  deleteTemporarySession: false,
  deleteTemporarySessionForCleanup: false,
  listTemporarySessions: false,
  getTemporarySession: false,
  registerSystemContextMutation: true,
  registerCompactionMutation: true,
  registerTool: true,
  registerCommand: true,
  dispose: true,
} as const);

type HostRegistration = { readonly dispose: () => Promise<void> };
type RegistrationEntry = {
  state: "pending" | "acquired" | "disposed" | "failed";
  registration?: HostRegistration;
  promise: Promise<HostRegistration>;
};

function frozenLocation(context: V2Context) {
  const location = context.location;
  return Object.freeze({
    directory: location.directory,
    ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }),
    project: Object.freeze({
      id: location.project.id,
      directory: location.project.directory,
      canonical: location.project.canonical,
    }),
  });
}

export function createV2RuntimeContract(context: V2Context): V2RuntimeContract {
  const entries: RegistrationEntry[] = [];
  let disposing = false;
  let disposePromise: Promise<void> | undefined;

  function assertRegistrationAllowed(): void {
    if (disposing) throw new Error("V2 runtime disposal has begun.");
  }

  function register(hostCall: () => Promise<HostRegistration>): Promise<RuntimeDisposer> {
    assertRegistrationAllowed();
    const entry = {} as RegistrationEntry;
    entry.promise = hostCall().then(
      (registration) => {
        entry.registration = registration;
        entry.state = "acquired";
        return registration;
      },
      (error: unknown) => {
        entry.state = "failed";
        throw error;
      },
    );
    entry.state = "pending";
    entries.push(entry);
    const disposer: RuntimeDisposer = Object.freeze({
      async dispose() {
        if (entry.state === "disposed" || entry.state === "failed") return;
        const registration = await entry.promise;
        if (entry.state === ("disposed" as RegistrationEntry["state"])) return;
        entry.state = "disposed";
        await registration.dispose();
      },
    });
    return entry.promise.then(() => disposer);
  }

  async function dispose(): Promise<void> {
    if (disposePromise !== undefined) return disposePromise;
    disposing = true;
    disposePromise = (async () => {
      let firstFailure: unknown;
      let hasFailure = false;
      for (const entry of entries) {
        try {
          await entry.promise;
        } catch (error) {
          if (!hasFailure) {
            hasFailure = true;
            firstFailure = error;
          }
        }
      }
      for (const entry of [...entries].reverse()) {
        if (entry.state !== "acquired" || entry.registration === undefined) continue;
        entry.state = "disposed";
        try {
          await entry.registration.dispose();
        } catch (error) {
          if (!hasFailure) {
            hasFailure = true;
            firstFailure = error;
          }
        }
      }
      if (hasFailure) throw firstFailure;
    })();
    return disposePromise;
  }

  const runtime: V2RuntimeContract = {
    identity: Object.freeze({ generation: "v2", location: frozenLocation(context) }),
    capabilities,
    config: Object.freeze({ options: context.options }),

    async readSessionMetadata() {
      unsupportedRuntimeOperation("readSessionMetadata", "session.get");
    },
    async readSessionHistory() {
      unsupportedRuntimeOperation("readSessionHistory", "session.messages");
    },
    async readSessionMessages() {
      unsupportedRuntimeOperation("readSessionMessages", "session.messages");
    },
    async readSessionContext() {
      unsupportedRuntimeOperation("readSessionContext", "session.context");
    },
    async deliverGeneratedPrompt() {
      unsupportedRuntimeOperation("deliverGeneratedPrompt", "session.prompt");
    },
    async deliverContextNoReply() {
      unsupportedRuntimeOperation("deliverContextNoReply", "session.prompt.noReply");
    },
    async createTemporarySession() {
      unsupportedRuntimeOperation("createTemporarySession", "session.create.parent");
    },
    async abortTemporarySession() {
      unsupportedRuntimeOperation("abortTemporarySession", "session.interrupt");
    },
    async deleteTemporarySession() {
      unsupportedRuntimeOperation("deleteTemporarySession", "session.remove");
    },
    async deleteTemporarySessionForCleanup() {
      unsupportedRuntimeOperation("deleteTemporarySessionForCleanup", "session.remove.cleanup");
    },
    async listTemporarySessions() {
      unsupportedRuntimeOperation("listTemporarySessions", "session.list");
    },
    async getTemporarySession() {
      unsupportedRuntimeOperation("getTemporarySession", "session.get");
    },
    registerSystemContextMutation(mutation: RuntimeMutation<V2SessionContext, unknown>) {
      return register(() => context.session.hook("context", (input) => mutation(input)));
    },
    registerCompactionMutation(mutation: RuntimeMutation<V2SessionCompaction, unknown>) {
      return register(() => context.session.hook("compaction", (input) => mutation(input)));
    },
    registerTool(registration: RuntimeNamedRegistration<V2ToolDefinition>) {
      if (registration.name !== registration.definition.name) {
        throw new Error(`V2 tool registration name mismatch: "${registration.name}".`);
      }
      return register(() => context.tool.transform((editor) => editor.add(registration.definition)));
    },
    registerCommand(registration: RuntimeNamedRegistration<V2CommandDefinition>) {
      if (registration.name !== registration.definition.name) {
        throw new Error(`V2 command registration name mismatch: "${registration.name}".`);
      }
      return register(() => context.command.transform((editor) => editor.add(registration.definition)));
    },
    dispose,
  };

  return runtime;
}

export function createV2Adapter(context: V2Context): V2Adapter {
  const runtime = createV2RuntimeContract(context);
  return Object.freeze({ runtime, dispose: () => Promise.resolve(runtime.dispose()) });
}
