import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { Service, headers as serviceHeaders, type Endpoint } from "@opencode/client/service";
import { fileURLToPath } from "node:url";

import { PROBE_MODEL_ID, PROBE_PROVIDER_ID } from "./index.js";

export const PROBE_MODEL_REF = {
  providerID: PROBE_PROVIDER_ID,
  id: PROBE_MODEL_ID,
} as const;

export const PROBE_SERVICE_VERSION = "2.0.12";
export const PROBE_SERVICE_BINARY = fileURLToPath(
  new URL("./node_modules/@opencode/cli-linux-x64/bin/opencode", import.meta.url),
);
export const PROBE_HOST_TIMEOUT_MS = 10_000;
export const PROBE_MESSAGE_PAGE_SIZE = 100;

export interface IsolatedServiceOptions {
  readonly cwd: string;
  readonly serviceFile: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface IsolatedServiceState {
  readonly options: IsolatedServiceOptions;
  readonly endpoint: Endpoint;
  readonly client: OpenCodeClient;
}

type SessionContext = Awaited<ReturnType<OpenCodeClient["session"]["context"]>>;
type MessagePage = Awaited<ReturnType<OpenCodeClient["message"]["list"]>>;
type Message = MessagePage["data"][number];
type SessionLog = ReturnType<OpenCodeClient["session"]["log"]> extends AsyncIterable<infer Item> ? Item : never;

export interface ExternalSessionObservations {
  readonly context: SessionContext;
  readonly messagePages: readonly MessagePage[];
  readonly messages: readonly Message[];
  readonly log: readonly SessionLog[];
}

export function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = PROBE_HOST_TIMEOUT_MS,
): Promise<T> {
  return operation(AbortSignal.timeout(timeoutMs));
}

export async function startIsolatedService(options: IsolatedServiceOptions): Promise<IsolatedServiceState> {
  const previousCwd = process.cwd();
  let endpoint: Endpoint;
  process.chdir(options.cwd);
  try {
    endpoint = await Service.ensure({
      file: options.serviceFile,
      version: PROBE_SERVICE_VERSION,
      command: [PROBE_SERVICE_BINARY, "serve", "--service"],
      env: options.env,
    });
  } finally {
    process.chdir(previousCwd);
  }

  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: serviceHeaders(endpoint),
  });
  return { options, endpoint, client };
}

export function stopIsolatedService(service: Pick<IsolatedServiceState, "options">): Promise<void> {
  return Service.stop({ file: service.options.serviceFile, pty: "clear" });
}

export function createModeledSession(
  client: OpenCodeClient,
  projectDirectory: string,
  timeoutMs = PROBE_HOST_TIMEOUT_MS,
) {
  return bounded(
    (signal) =>
      client.session.create(
        {
          model: PROBE_MODEL_REF,
          location: { directory: projectDirectory },
        },
        { signal },
      ),
    timeoutMs,
  );
}

export async function observeSession(
  client: OpenCodeClient,
  sessionID: string,
  timeoutMs = PROBE_HOST_TIMEOUT_MS,
): Promise<ExternalSessionObservations> {
  const context = await bounded((signal) => client.session.context({ sessionID }, { signal }), timeoutMs);
  const messagePages: MessagePage[] = [];
  const messages: Message[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const page = await bounded(
      (signal) =>
        client.message.list(
          {
            sessionID,
            limit: PROBE_MESSAGE_PAGE_SIZE,
            ...(cursor === undefined ? { order: "asc" as const } : { cursor }),
          },
          { signal },
        ),
      timeoutMs,
    );
    messagePages.push(page);
    messages.push(...page.data);
    const next = page.cursor.next ?? undefined;
    if (next !== undefined && cursors.has(next)) {
      throw new Error(`message.list repeated cursor ${next}`);
    }
    if (next !== undefined) cursors.add(next);
    cursor = next;
  } while (cursor !== undefined);

  const log: SessionLog[] = [];
  const signal = AbortSignal.timeout(timeoutMs);
  for await (const item of client.session.log({ sessionID, follow: false }, { signal })) {
    log.push(item);
  }

  return { context, messagePages, messages, log };
}

export async function submitOrdinaryPrompt(
  client: OpenCodeClient,
  sessionID: string,
  text: string,
  timeoutMs = PROBE_HOST_TIMEOUT_MS,
) {
  const prompt = await bounded((signal) => client.session.prompt({ sessionID, text }, { signal }), timeoutMs);
  await bounded((signal) => client.session.wait({ sessionID }, { signal }), timeoutMs);
  return prompt;
}

export const SETUP_BOOTSTRAP_PROMPT =
  "Initialize the isolated setup fixture with one ordinary response; do not call tools.";

export async function captureInitializedSetupSnapshot<T>(
  client: OpenCodeClient,
  sessionID: string,
  snapshot: () => Promise<T>,
  timeoutMs = PROBE_HOST_TIMEOUT_MS,
): Promise<T> {
  // Service/session creation and observation do not initialize lazy project plugins.
  await submitOrdinaryPrompt(client, sessionID, SETUP_BOOTSTRAP_PROMPT, timeoutMs);
  return snapshot();
}

export function invokeSessionGenerate(
  client: OpenCodeClient,
  sessionID: string,
  prompt: string,
  timeoutMs = PROBE_HOST_TIMEOUT_MS,
) {
  return bounded((signal) => client.session.generate({ sessionID, prompt }, { signal }), timeoutMs);
}

export function invokeStandaloneGenerate(client: OpenCodeClient, prompt: string, timeoutMs = PROBE_HOST_TIMEOUT_MS) {
  return bounded((signal) => client.generate.text({ prompt, model: PROBE_MODEL_REF }, { signal }), timeoutMs);
}

export async function compactSession(client: OpenCodeClient, sessionID: string, timeoutMs = PROBE_HOST_TIMEOUT_MS) {
  const compaction = await bounded((signal) => client.session.compact({ sessionID }, { signal }), timeoutMs);
  await bounded((signal) => client.session.wait({ sessionID }, { signal }), timeoutMs);
  return compaction;
}
