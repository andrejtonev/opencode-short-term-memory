import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type {
  RuntimeContract,
  RuntimeDisposer,
  RuntimeMutation,
  RuntimeNamedRegistration,
  RuntimeSessionMetadata,
} from "../src/runtime-contract";
import { unsupportedRuntimeOperation } from "../src/runtime-contract";

type V1Client = PluginInput["client"];
type V1Session = V1Client["session"];
type V1PromptOptions = NonNullable<Parameters<V1Session["prompt"]>[0]>;
type V1Prompt = NonNullable<V1PromptOptions["body"]>;
type V1CreateOptions = NonNullable<NonNullable<Parameters<V1Session["create"]>[0]>["body"]>;
type V1Message = Awaited<ReturnType<V1Session["messages"]>> extends { data?: readonly (infer T)[] } ? T : unknown;
type V1Tool = NonNullable<Hooks["tool"]>[string];

type V1SystemMutation = RuntimeMutation<unknown, unknown>;
type V1CompactionMutation = RuntimeMutation<unknown, unknown>;
type V1Command = unknown;

export interface V1RegistrationCollector {
  readonly systemContextMutations: readonly V1SystemMutation[];
  readonly compactionMutations: readonly V1CompactionMutation[];
  readonly tools: readonly RuntimeNamedRegistration<V1Tool>[];
  readonly commands: readonly RuntimeNamedRegistration<V1Command>[];
}

export type V1RuntimeContractFixture = RuntimeContract<
  V1Message,
  V1Prompt,
  V1Prompt,
  Omit<V1CreateOptions, "parentID">,
  unknown,
  unknown,
  unknown,
  unknown,
  V1Tool,
  V1Command,
  undefined
> & {
  readonly registrations: V1RegistrationCollector;
};

type V1Response<T> = {
  readonly data?: T;
  readonly error?: unknown;
};

type V1SessionRow = {
  readonly id: string;
  readonly parentID?: string;
  readonly title?: string;
  readonly [key: string]: unknown;
};

const capabilities = Object.freeze({
  readSessionMetadata: true,
  readSessionHistory: true,
  readSessionContext: false,
  deliverGeneratedPrompt: true,
  deliverContextNoReply: true,
  createTemporarySession: true,
  abortTemporarySession: true,
  deleteTemporarySession: true,
  listTemporarySessions: true,
  getTemporarySession: true,
  registerSystemContextMutation: true,
  registerCompactionMutation: true,
  registerTool: true,
  registerCommand: true,
  dispose: true,
} as const);

function unwrapV1Response<T>(response: unknown, operation: string): T {
  const envelope = response as V1Response<T>;
  if (envelope.error !== undefined) throw envelope.error;
  if (envelope.data === undefined) throw new Error(`V1 operation "${operation}" returned no data.`);
  return envelope.data;
}

function assertV1Response(response: unknown): void {
  const envelope = response as V1Response<unknown>;
  if (envelope.error !== undefined) throw envelope.error;
}

function normalizeSession(session: V1SessionRow): RuntimeSessionMetadata {
  const { parentID, ...metadata } = session;
  return Object.freeze({ ...metadata, ...(parentID === undefined ? {} : { parentId: parentID }) });
}

export function createV1RuntimeContractFixture(input: PluginInput): V1RuntimeContractFixture {
  const systemContextMutations: V1SystemMutation[] = [];
  const compactionMutations: V1CompactionMutation[] = [];
  const tools: RuntimeNamedRegistration<V1Tool>[] = [];
  const commands: RuntimeNamedRegistration<V1Command>[] = [];

  const registrationCollector: V1RegistrationCollector = Object.freeze({
    get systemContextMutations() {
      return Object.freeze([...systemContextMutations]);
    },
    get compactionMutations() {
      return Object.freeze([...compactionMutations]);
    },
    get tools() {
      return Object.freeze([...tools]);
    },
    get commands() {
      return Object.freeze([...commands]);
    },
  });

  function register<T>(collection: T[], registration: T): RuntimeDisposer {
    collection.push(registration);
    let active = true;
    return Object.freeze({
      dispose() {
        if (!active) return;
        active = false;
        const index = collection.indexOf(registration);
        if (index !== -1) collection.splice(index, 1);
      },
    });
  }

  async function readSessionMetadata(sessionId: string): Promise<RuntimeSessionMetadata> {
    const response = await input.client.session.get({ path: { id: sessionId } });
    return normalizeSession(unwrapV1Response<V1SessionRow>(response, "session.get"));
  }

  return {
    identity: Object.freeze({
      generation: "v1",
      location: Object.freeze({
        directory: input.directory || undefined,
        worktree: input.worktree || undefined,
        serverUrl: input.serverUrl?.toString() || undefined,
      }),
    }),
    capabilities,
    config: Object.freeze({ options: undefined }),
    registrations: registrationCollector,

    readSessionMetadata,
    async readSessionHistory(sessionId) {
      const [session, response] = await Promise.all([
        readSessionMetadata(sessionId),
        input.client.session.messages({ path: { id: sessionId } }),
      ]);
      return Object.freeze({
        session,
        messages: Object.freeze([...unwrapV1Response<readonly V1Message[]>(response, "session.messages")]),
      });
    },
    async readSessionContext() {
      unsupportedRuntimeOperation("readSessionContext", "session.context");
    },
    async deliverGeneratedPrompt({ sessionId, prompt }) {
      const response = await input.client.session.prompt({ path: { id: sessionId }, body: prompt });
      assertV1Response(response);
    },
    async deliverContextNoReply({ sessionId, context }) {
      const response = await input.client.session.prompt({
        path: { id: sessionId },
        body: { ...context, noReply: true },
      });
      assertV1Response(response);
    },
    async createTemporarySession({ parentId, options }) {
      const response = await input.client.session.create({
        body: { ...options, ...(parentId === undefined ? {} : { parentID: parentId }) },
      });
      return normalizeSession(unwrapV1Response<V1SessionRow>(response, "session.create"));
    },
    async abortTemporarySession({ id }) {
      const response = await input.client.session.abort({ path: { id } });
      assertV1Response(response);
    },
    async deleteTemporarySession({ id }) {
      const response = await input.client.session.delete({ path: { id } });
      assertV1Response(response);
    },
    async listTemporarySessions({ parentId }) {
      const response = await input.client.session.list();
      return Object.freeze(
        unwrapV1Response<readonly V1SessionRow[]>(response, "session.list")
          .filter((session) => parentId === undefined || session.parentID === parentId)
          .map(normalizeSession),
      );
    },
    async getTemporarySession({ id }) {
      const response = await input.client.session.get({ path: { id } });
      return normalizeSession(unwrapV1Response<V1SessionRow>(response, "session.get"));
    },
    registerSystemContextMutation(mutation) {
      return register(systemContextMutations, mutation);
    },
    registerCompactionMutation(mutation) {
      return register(compactionMutations, mutation);
    },
    registerTool(registration) {
      return register(tools, Object.freeze({ ...registration }));
    },
    registerCommand(registration) {
      return register(commands, Object.freeze({ ...registration }));
    },
    dispose() {
      systemContextMutations.length = 0;
      compactionMutations.length = 0;
      tools.length = 0;
      commands.length = 0;
    },
  };
}
