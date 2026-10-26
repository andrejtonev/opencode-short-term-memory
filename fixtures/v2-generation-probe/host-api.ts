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
  new URL(
    process.platform === "win32"
      ? "./node_modules/@opencode/cli-windows-x64/bin/opencode.exe"
      : "./node_modules/@opencode/cli-linux-x64/bin/opencode",
    import.meta.url,
  ),
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
  onLateSuccess?: (value: T) => Promise<unknown>,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let expired = false;
    const timer = setTimeout(() => {
      settled = true;
      expired = true;
      controller.abort();
      reject(new Error(`Probe operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => {
          if (settled) {
            if (expired && onLateSuccess) {
              // A failed startup can still create a service later. Retain ownership of that completion.
              Promise.resolve()
                .then(() => onLateSuccess(value))
                .catch(() => {
                  console.error("Late probe service cleanup failed; lifecycle remains incomplete.");
                });
            }
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

export function isolatedServiceCommand(
  env: IsolatedServiceOptions["env"],
  command: readonly string[] = [PROBE_SERVICE_BINARY, "serve", "--service"],
  cwd?: string,
): string[] {
  const assignments = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
    return `${key}=${value}`;
  });
  // Service.ensure merges parent variables; clear them at the actual server exec boundary.
  if (process.platform === "win32" || cwd !== undefined) {
    const childEnv = {
      ...env,
      PATH: process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : "/usr/bin:/bin",
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}),
    };
    const wrapper = `
      const p=JSON.parse(process.argv.at(-1));
      const c=require('node:child_process').spawn(p.command[0],p.command.slice(1),{env:p.env,cwd:p.cwd,stdio:'inherit',windowsHide:true});
      let exited=false;
      let forwarded;
      for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{
        forwarded=signal;
        if(!exited) c.kill(signal);
      });
      process.on('exit',()=>{if(!exited) c.kill(forwarded??'SIGTERM');});
      c.on('error',()=>{exited=true;process.exit(1);});
      c.on('exit',code=>{exited=true;process.exit(code??(forwarded==='SIGINT'?130:143));});
    `;
    return [process.execPath, "-e", wrapper, "--", JSON.stringify({ command, env: childEnv, cwd })];
  }
  return ["/usr/bin/env", "-i", ...assignments, "PATH=/usr/bin:/bin", ...command];
}

type ServiceLifecycle = Pick<typeof Service, "ensure" | "stop">;

export async function startIsolatedService(
  options: IsolatedServiceOptions,
  timeoutMs = PROBE_HOST_TIMEOUT_MS,
  lifecycle: ServiceLifecycle = Service,
): Promise<IsolatedServiceState> {
  const endpoint = await bounded(
    () =>
      lifecycle.ensure({
        file: options.serviceFile,
        version: PROBE_SERVICE_VERSION,
        command: isolatedServiceCommand(options.env, undefined, options.cwd),
        env: options.env,
      }),
    timeoutMs,
    () => stopIsolatedService({ options }, timeoutMs, lifecycle),
  );

  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: serviceHeaders(endpoint),
  });
  return { options, endpoint, client };
}

export function stopIsolatedService(
  service: Pick<IsolatedServiceState, "options">,
  timeoutMs = PROBE_HOST_TIMEOUT_MS,
  lifecycle: ServiceLifecycle = Service,
): Promise<void> {
  return bounded(() => lifecycle.stop({ file: service.options.serviceFile, pty: "clear" }), timeoutMs);
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
