import { isAbsolute } from "node:path";
import { openTextReader, type ReaderHost } from "./tui-text-reader";
import {
  decodeV1Response,
  newV1Request,
  V1_REQUEST_PREFIX,
  V1_ACTION_TIMEOUT_MS,
  type V1Action,
  type V1Request,
} from "./v1-native-protocol";

export const V1_VIEW_MAX_CHARS = 16_384;
export type V1LocalTarget = { directory: string; sessionID?: string };
export type V1MenuOption = { title: string; value: V1Action };
/** Structural native V1 API subset, keeping the packaged TUI declaration closure portable. */
export type V1TuiContext<Node = unknown> = {
  renderer: ReaderHost<Node>["renderer"];
  event: { on(type: "tui.command.execute", handler: (event: { properties: { command: string } }) => void): () => void };
  state: { ready: boolean; path: { directory: string } };
  route: { current: { name: string; params?: Record<string, unknown> } };
  command: {
    register(
      callback: () => { title: string; value: string; category: string; slash: { name: string }; onSelect(): void }[],
    ): () => void;
  };
  lifecycle: { onDispose(callback: () => void): unknown };
  client: {
    tui: {
      publish(
        input: { directory: string; body: { type: "tui.command.execute"; properties: { command: string } } },
        options?: { signal: AbortSignal },
      ): Promise<{ error?: unknown }>;
    };
    path: {
      get(
        input: { directory: string },
        options?: { signal: AbortSignal },
      ): Promise<{ data?: { directory: string }; error?: unknown; request: Request }>;
    };
  };
  ui: {
    DialogAlert(input: { title: string; message: string }): Node;
    DialogConfirm(input: { title: string; message: string; onConfirm(): void; onCancel?(): void }): Node;
    DialogSelect(input: { title: string; options: V1MenuOption[]; onSelect(option: V1MenuOption): void }): Node;
    dialog: { replace(render: () => Node, onClose?: () => void): void; setSize(size: "large"): void };
  };
};

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

export async function setupV1Tui<Node>(api: V1TuiContext<Node>, _options?: unknown, _meta?: unknown): Promise<void> {
  let generation = 0;
  let disposed = false;
  let replacing = false;
  let closeReader = () => {};
  let pending: { request: V1Request; generation: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const cancelView = () => {
    generation++;
    pending = undefined;
    clearTimeout(timer);
    closeReader();
  };
  const alert = (title: string, message: string, location?: V1LocalTarget) => {
    closeReader();
    const currentGeneration = generation;
    replacing = true;
    try {
      closeReader = openTextReader(
        api,
        title,
        limitV1View(message),
        () => !disposed && generation === currentGeneration && (!location || sameTarget(api, location)),
      );
    } finally {
      replacing = false;
    }
  };
  const off = api.event.on("tui.command.execute", (event) => {
    const response = decodeV1Response(event.properties.command);
    const current = pending;
    if (
      !response ||
      !current ||
      disposed ||
      current.generation !== generation ||
      response.requestID !== current.request.requestID ||
      response.directory !== current.request.directory ||
      response.sessionID !== current.request.sessionID ||
      !sameTarget(api, current.request)
    )
      return;
    pending = undefined;
    clearTimeout(timer);
    alert(`STM ${current.request.action}`, response.message, current.request);
  });
  const show = async (action: V1Action, location: V1LocalTarget, confirm?: boolean) => {
    if (disposed || !sameTarget(api, location)) return;
    cancelView();
    // Dismissing the waiting dialog abandons display only; an admitted action may finish.
    api.ui.dialog.replace(
      () =>
        api.ui.DialogAlert({
          title: `STM ${action}`,
          message: action === "update" ? "Updating memory with the memory model..." : "Running STM action...",
        }),
      () => {
        if (!replacing) cancelView();
      },
    );
    api.ui.dialog.setSize("large");
    const currentGeneration = ++generation;
    const request = newV1Request(location, action, confirm);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
      const paths = await api.client.path.get({ directory: location.directory }, { signal });
      if (paths.error || paths.data?.directory !== location.directory)
        throw new Error("The selected project does not match the server. No action was requested.");
      if (disposed || currentGeneration !== generation || !sameTarget(api, location)) return;
      // Publish travels to the attached server; never read a remote server's files locally.
      pending = { request, generation: currentGeneration };
      timer = setTimeout(() => {
        if (pending?.request.requestID !== request.requestID) return;
        pending = undefined;
        if (disposed || currentGeneration !== generation || !sameTarget(api, location)) return;
        alert(
          `STM ${action}`,
          "No STM result arrived. Verify the server plugin is enabled. An admitted action may still finish; inspect status before retrying.",
          location,
        );
      }, V1_ACTION_TIMEOUT_MS);
      const result = await api.client.tui.publish(
        {
          directory: location.directory,
          body: { type: "tui.command.execute", properties: { command: V1_REQUEST_PREFIX + JSON.stringify(request) } },
        },
        { signal },
      );
      if (result.error)
        throw new Error("The native STM request could not be delivered. An admitted action may still finish.");
    } catch (error) {
      if (disposed || generation !== currentGeneration || !sameTarget(api, location)) return;
      pending = undefined;
      clearTimeout(timer);
      alert(`STM ${action} error`, error instanceof Error ? error.message : String(error), location);
    }
  };
  const select = (action: V1Action) => {
    const location = target(api);
    if (!location) return alert("STM", "The current project is not ready. No action ran.");
    if (!["reset", "setup"].includes(action)) return void show(action, location);
    cancelView();
    api.ui.dialog.replace(() =>
      api.ui.DialogConfirm({
        title: `STM ${action}`,
        message:
          action === "reset"
            ? "Reset this session's saved memory and checkpoint? V1's next update can summarize earlier conversation again."
            : "Create an optional project-local .opencode/stm.jsonc example? Existing STM configuration is preserved. Installation already creates the minimal config.",
        // Host DialogConfirm clears its dialog after this callback returns.
        onConfirm: () =>
          queueMicrotask(() => {
            if (!disposed && sameTarget(api, location)) void show(action, location, true);
          }),
      }),
    );
    api.ui.dialog.setSize("large");
  };
  const menu = () => {
    cancelView();
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect({
        title: "STM session memory",
        options: [
          { title: "Show memory", value: "show" },
          { title: "Show log file path", value: "logs" },
          { title: "Show settings and config paths", value: "settings" },
          { title: "Show status and live counters", value: "status" },
          { title: "Update memory (uses memory model)", value: "update" },
          { title: "Reset saved memory...", value: "reset" },
          { title: "Create optional example config...", value: "setup" },
        ],
        onSelect: (option) => select(option.value),
      }),
    );
    api.ui.dialog.setSize("large");
  };
  const unregister = api.command.register(() => [
    { title: "STM session memory", value: "stm.menu", category: "Plugin", slash: { name: "stm" }, onSelect: menu },
  ]);
  api.lifecycle.onDispose(() => {
    disposed = true;
    cancelView();
    controller.abort();
    off();
    unregister();
  });
}
