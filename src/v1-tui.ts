import { open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { logPath, memoryPathFor, readConfig, readConfigDiagnostics } from "./memory-utils";

export const V1_VIEW_MAX_CHARS = 16_384;
const FILE_MAX_BYTES = 65_536;
export type V1ReadAction = "show" | "logs" | "settings" | "status";
export type V1LocalTarget = { directory: string; sessionID?: string };
export type V1MenuOption = { title: string; value: V1ReadAction };
/** Structural native V1 API subset, keeping the packaged TUI declaration closure portable. */
export type V1TuiContext<Node = unknown> = {
  state: { ready: boolean; path: { directory: string } };
  route: { current: { name: string; params?: Record<string, unknown> } };
  command: {
    register(
      callback: () => { title: string; value: string; category: string; slash: { name: string }; onSelect(): void }[],
    ): () => void;
  };
  lifecycle: { onDispose(callback: () => void): unknown };
  client: {
    path: {
      get(
        input: { directory: string },
        options?: { signal: AbortSignal },
      ): Promise<{ data?: { directory: string }; error?: unknown; request: Request }>;
    };
    session: {
      get(
        input: { sessionID: string; directory: string },
        options?: { signal: AbortSignal },
      ): Promise<{ data?: { id: string; directory: string }; error?: unknown }>;
    };
  };
  ui: {
    DialogAlert(input: { title: string; message: string }): Node;
    DialogSelect(input: { title: string; options: V1MenuOption[]; onSelect(option: V1MenuOption): void }): Node;
    dialog: { replace(render: () => Node, onClose?: () => void): void; setSize(size: "large"): void };
  };
};

export function isLocalV1Transport(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      ["localhost", "127.0.0.1", "[::1]", "opencode.internal"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function target<Node>(api: V1TuiContext<Node>): V1LocalTarget | undefined {
  const directory = api.state.path.directory;
  if (!api.state.ready || !directory || !isAbsolute(directory)) return;
  const route = api.route.current;
  const sessionID = route.name === "session" ? route.params?.sessionID : undefined;
  if (sessionID !== undefined && (typeof sessionID !== "string" || !/^[a-zA-Z0-9_-]+$/.test(sessionID))) return;
  return { directory, sessionID: sessionID as string | undefined };
}

function sameTarget<Node>(api: V1TuiContext<Node>, expected: V1LocalTarget) {
  const current = target(api);
  return current?.directory === expected.directory && current?.sessionID === expected.sessionID;
}

export function limitV1View(text: string): string {
  if (text.length <= V1_VIEW_MAX_CHARS) return text;
  const suffix = "\n[Display truncated; inspect the file for the full contents.]";
  return text.slice(0, V1_VIEW_MAX_CHARS - suffix.length) + suffix;
}

async function readBounded(path: string, tail: boolean) {
  try {
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error("The requested path is not a regular file.");
      const size = Math.min(info.size, FILE_MAX_BYTES);
      const buffer = Buffer.alloc(size);
      const result = await file.read(buffer, 0, size, tail ? Math.max(0, info.size - size) : 0);
      let text = buffer.subarray(0, result.bytesRead).toString("utf8");
      if (tail) {
        if (info.size > size) text = text.slice(text.indexOf("\n") + 1);
        text = text.split("\n").slice(-120).join("\n");
      }
      if (info.size > size) text += "\n[File read limited to 65,536 bytes.]";
      return text || "The file is empty.";
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return "No local file exists yet.";
    throw error;
  }
}

/** A local file view, deliberately not a claim about an attached server's disk or runtime state. */
export async function readV1LocalView(action: V1ReadAction, location: V1LocalTarget): Promise<string> {
  const directory = await realpath(location.directory);
  if (location.sessionID && !/^[a-zA-Z0-9_-]+$/.test(location.sessionID)) throw new Error("Invalid session identity.");
  const config = await readConfig(undefined, directory);
  const memoryDir = resolve(directory, config.memoryDir);
  const diagnostics = await readConfigDiagnostics(directory);
  const scope = `Local files in ${directory}\nAttached remote servers may use different files. Live server counters are unavailable.\n`;
  if (action === "settings")
    return limitV1View(scope + JSON.stringify({ ...config, memoryDir, ...diagnostics }, null, 2));
  if (action === "status")
    return limitV1View(
      scope +
        JSON.stringify(
          { sessionID: location.sessionID ?? null, memoryDir, logPath: logPath(memoryDir), ...diagnostics },
          null,
          2,
        ),
    );
  if (action === "show" && !location.sessionID) return scope + "Open a session to view its local memory file.";
  const path = action === "logs" ? logPath(memoryDir) : memoryPathFor(location.sessionID!, memoryDir);
  const content = await readBounded(path, action === "logs");
  const prefix = `${scope}\nFile: ${path}\n\n`;
  if (action === "logs" && prefix.length + content.length > V1_VIEW_MAX_CHARS) {
    const notice = "[Earlier log text omitted; inspect the file for the full contents.]\n";
    const budget = Math.max(0, V1_VIEW_MAX_CHARS - prefix.length - notice.length);
    return limitV1View(prefix + notice + (budget ? content.slice(-budget) : ""));
  }
  return limitV1View(prefix + content);
}

export async function setupV1Tui<Node>(api: V1TuiContext<Node>, _options?: unknown, _meta?: unknown): Promise<void> {
  let generation = 0;
  let disposed = false;
  const controller = new AbortController();
  api.lifecycle.onDispose(() => {
    disposed = true;
    generation++;
    controller.abort();
  });
  const alert = (title: string, message: string) => {
    api.ui.dialog.replace(() => api.ui.DialogAlert({ title, message: limitV1View(message) }));
    api.ui.dialog.setSize("large");
  };
  const show = async (action: V1ReadAction) => {
    const location = target(api);
    if (!location) return alert("STM local files", "The current project is not ready. No files were read.");
    api.ui.dialog.replace(
      () => api.ui.DialogAlert({ title: `STM ${action}`, message: "Reading local files…" }),
      () => {
        generation++;
      },
    );
    const request = ++generation;
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
      const paths = await api.client.path.get({ directory: location.directory }, { signal });
      if (paths.error || paths.data?.directory !== location.directory || !isLocalV1Transport(paths.request.url))
        throw new Error(
          "Local STM file views are unavailable for this remote or mismatched workspace. View STM files on the machine running the server. No local files were read.",
        );
      if (disposed || generation !== request || !sameTarget(api, location)) return;
      if (location.sessionID) {
        const result = await api.client.session.get(
          { sessionID: location.sessionID, directory: location.directory },
          { signal },
        );
        if (result.error || result.data?.id !== location.sessionID || result.data.directory !== location.directory)
          throw new Error("The server session does not match the selected project. No local files were read.");
      }
      if (disposed || generation !== request || !sameTarget(api, location)) return;
      const output = await readV1LocalView(action, location);
      if (disposed || generation !== request || !sameTarget(api, location)) return;
      alert(`STM ${action} — local files`, output);
    } catch (error) {
      if (disposed || generation !== request || !sameTarget(api, location)) return;
      alert(`STM ${action} error`, error instanceof Error ? error.message : String(error));
    }
  };
  const menu = () => {
    generation++;
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect({
        title: "STM — view local files (remote server files may differ)",
        options: [
          { title: "Show local memory", value: "show" },
          { title: "Show local logs", value: "logs" },
          { title: "Show local settings and config paths", value: "settings" },
          { title: "Show local paths and session", value: "status" },
        ],
        onSelect: (option) => {
          void show(option.value);
        },
      }),
    );
  };
  // Both pinned 1.14.25 and 1.18.35 support this API. Native slash callbacks
  // receive no arguments: /stm opens a menu; typed server subcommands remain legacy.
  api.command.register(() => [
    { title: "STM local files", value: "stm.local-files", category: "Plugin", slash: { name: "stm" }, onSelect: menu },
    ...(["show", "logs", "settings", "status"] as const).map((action) => ({
      title: `STM ${action} — local files`,
      value: `stm.local-${action}`,
      category: "Plugin",
      slash: { name: `stm-${action}` },
      onSelect: () => {
        void show(action);
      },
    })),
  ]);
}
