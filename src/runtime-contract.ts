export type RuntimeGeneration = "v1" | "v2" | (string & {});

export interface RuntimeLocation {
  readonly directory?: string;
  readonly worktree?: string;
  readonly serverUrl?: string;
  readonly [key: string]: unknown;
}

export interface RuntimeIdentity {
  readonly generation: RuntimeGeneration;
  readonly location: RuntimeLocation;
}

export interface RuntimeSessionMetadata {
  readonly id: string;
  readonly parentId?: string;
  readonly title?: string;
  readonly [key: string]: unknown;
}

export interface RuntimeSessionHistory<TMessage = unknown> {
  readonly session: RuntimeSessionMetadata;
  readonly messages: readonly TMessage[];
}

export interface RuntimeSessionMessagesOptions {
  readonly limit?: number;
}

export interface RuntimeSessionContext<TContext = unknown> {
  readonly session: RuntimeSessionMetadata;
  readonly context: TContext;
}

export interface RuntimeGeneratedPrompt<TPrompt = unknown> {
  readonly sessionId: string;
  readonly prompt: TPrompt;
  readonly signal?: AbortSignal;
}

export interface RuntimeContextDelivery<TContext = unknown> {
  readonly sessionId: string;
  readonly context: TContext;
  readonly noReply: true;
}

export interface RuntimeTemporarySessionCreate<TOptions = unknown> {
  readonly parentId?: string;
  readonly options?: TOptions;
}

export interface RuntimeTemporarySessionQuery {
  readonly id: string;
}

export type RuntimeTemporarySessionCleanupDeleteResult =
  | { readonly deleted: true }
  | { readonly deleted: false; readonly error: unknown };

export interface RuntimeTemporarySessionList {
  readonly parentId?: string;
}

export interface RuntimeMutation<TInput = unknown, TOutput = unknown> {
  (input: TInput, output: TOutput): void | Promise<void>;
}

export interface RuntimeNamedRegistration<TDefinition = unknown> {
  readonly name: string;
  readonly definition: TDefinition;
}

export interface RuntimeDisposer {
  dispose(): void | Promise<void>;
}

export interface RuntimeConfig<TOptions = unknown> {
  readonly options?: TOptions;
}

export interface RuntimeCapabilities {
  readonly readSessionMetadata: boolean;
  readonly readSessionHistory: boolean;
  readonly readSessionMessages: boolean;
  readonly readSessionContext: boolean;
  readonly deliverGeneratedPrompt: boolean;
  readonly deliverContextNoReply: boolean;
  readonly createTemporarySession: boolean;
  readonly abortTemporarySession: boolean;
  readonly deleteTemporarySession: boolean;
  readonly deleteTemporarySessionForCleanup: boolean;
  readonly listTemporarySessions: boolean;
  readonly getTemporarySession: boolean;
  readonly registerSystemContextMutation: boolean;
  readonly registerCompactionMutation: boolean;
  readonly registerTool: boolean;
  readonly registerCommand: boolean;
  readonly dispose: boolean;
}

export type RuntimeCapability = keyof RuntimeCapabilities;

export class RuntimeCapabilityError extends Error {
  readonly capability: RuntimeCapability;
  readonly operation: string;

  constructor(capability: RuntimeCapability, operation: string) {
    super(`Runtime capability "${capability}" does not support operation "${operation}".`);
    this.name = "RuntimeCapabilityError";
    this.capability = capability;
    this.operation = operation;
  }
}

export function unsupportedRuntimeOperation(capability: RuntimeCapability, operation: string): never {
  throw new RuntimeCapabilityError(capability, operation);
}

export interface RuntimeContract<
  TMessage = unknown,
  TContext = unknown,
  TPrompt = unknown,
  TTemporarySessionOptions = unknown,
  TSystemInput = unknown,
  TSystemOutput = unknown,
  TCompactionInput = unknown,
  TCompactionOutput = unknown,
  TTool = unknown,
  TCommand = unknown,
  TRuntimeOptions = unknown,
  TGeneratedPromptResult = unknown,
> {
  readonly identity: RuntimeIdentity;
  readonly capabilities: Readonly<RuntimeCapabilities>;
  readonly config: RuntimeConfig<TRuntimeOptions>;

  readSessionMetadata(sessionId: string): Promise<RuntimeSessionMetadata>;
  readSessionHistory(sessionId: string): Promise<RuntimeSessionHistory<TMessage>>;
  readSessionMessages(sessionId: string, options?: RuntimeSessionMessagesOptions): Promise<readonly TMessage[]>;
  readSessionContext(sessionId: string): Promise<RuntimeSessionContext<TContext>>;
  deliverGeneratedPrompt(request: RuntimeGeneratedPrompt<TPrompt>): Promise<TGeneratedPromptResult>;
  deliverContextNoReply(request: RuntimeContextDelivery<TContext>): Promise<void>;
  createTemporarySession(
    request: RuntimeTemporarySessionCreate<TTemporarySessionOptions>,
  ): Promise<RuntimeSessionMetadata>;
  abortTemporarySession(request: RuntimeTemporarySessionQuery): Promise<void>;
  deleteTemporarySession(request: RuntimeTemporarySessionQuery): Promise<void>;
  deleteTemporarySessionForCleanup(
    request: RuntimeTemporarySessionQuery,
  ): Promise<RuntimeTemporarySessionCleanupDeleteResult>;
  listTemporarySessions(request: RuntimeTemporarySessionList): Promise<readonly RuntimeSessionMetadata[]>;
  getTemporarySession(request: RuntimeTemporarySessionQuery): Promise<RuntimeSessionMetadata>;
  registerSystemContextMutation(
    mutation: RuntimeMutation<TSystemInput, TSystemOutput>,
  ): RuntimeDisposer | Promise<RuntimeDisposer>;
  registerCompactionMutation(
    mutation: RuntimeMutation<TCompactionInput, TCompactionOutput>,
  ): RuntimeDisposer | Promise<RuntimeDisposer>;
  registerTool(registration: RuntimeNamedRegistration<TTool>): RuntimeDisposer | Promise<RuntimeDisposer>;
  registerCommand(registration: RuntimeNamedRegistration<TCommand>): RuntimeDisposer | Promise<RuntimeDisposer>;
  dispose(): void | Promise<void>;
}
