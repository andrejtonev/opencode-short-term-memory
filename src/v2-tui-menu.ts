import { redactDiagnostic } from "./diagnostics";
import type { StatusActionRequest, StatusLocation } from "./v2-status-output";
import { MEMORY_MENU_OPTIONS } from "./memory-menu";

type Action = StatusActionRequest["action"];
type Scope = StatusLocation & { sessionID: string };

export const V2_TUI_MENU_OPTIONS: readonly { readonly title: string; readonly value: Action }[] = MEMORY_MENU_OPTIONS;

type ActionRpc = (
  input: StatusActionRequest,
  options?: { location?: StatusLocation; signal?: AbortSignal },
) => Promise<unknown>;

export type V2TuiMenuHost = {
  keymap: {
    layer(
      input: () => {
        mode?: string;
        enabled: () => boolean;
        commands: {
          id: string;
          bind: false;
          title: string;
          description: string;
          group: string;
          palette: true;
          slash: { name: "stm" };
          run: () => Promise<void>;
        }[];
      },
    ): void;
  };
  location?: StatusLocation;
  ui: {
    router: { current(): { type: string; sessionID?: string } };
    dialog: {
      select<Value>(options: {
        title: string;
        options: readonly { readonly title: string; readonly value: Value }[];
      }): Promise<Value | undefined>;
      confirm(options: {
        title: string;
        message: string;
        label?: { confirm?: string; cancel?: string };
      }): Promise<boolean | undefined>;
      alert(options: { title: string; message: string }): Promise<void>;
    };
  };
};

function scopeOf(host: V2TuiMenuHost): Scope | undefined {
  const location = host.location;
  const route = host.ui.router.current();
  if (
    !location?.directory ||
    route.type !== "session" ||
    typeof route.sessionID !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(route.sessionID)
  )
    return undefined;
  return {
    directory: location.directory,
    ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }),
    sessionID: route.sessionID,
  };
}

function isSameScope(host: V2TuiMenuHost, expected: Scope): boolean {
  const current = scopeOf(host);
  return (
    current?.directory === expected.directory &&
    current.workspaceID === expected.workspaceID &&
    current.sessionID === expected.sessionID
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error) return redactDiagnostic(error.message);
  if (error !== null && typeof error === "object" && typeof (error as { message?: unknown }).message === "string")
    return redactDiagnostic((error as { message: string }).message);
  return redactDiagnostic(String(error));
}

/** Register one native V2 `/stm` picker. Server actions remain admission-controlled by RPC. */
export function registerV2TuiMenu(host: V2TuiMenuHost, invoke: ActionRpc, signal: AbortSignal): void {
  const alertIfCurrent = async (title: string, message: string, scope?: Scope) => {
    if (signal.aborted || (scope && !isSameScope(host, scope))) return;
    await host.ui.dialog.alert({ title, message });
  };

  const openMenu = async () => {
    if (signal.aborted) return;
    const scope = scopeOf(host);
    if (!scope) {
      await alertIfCurrent("STM", "Open a session before using short-term memory actions.");
      return;
    }

    let action: Action | undefined;
    try {
      action = await host.ui.dialog.select({ title: "STM session memory", options: V2_TUI_MENU_OPTIONS });
    } catch (error) {
      await alertIfCurrent("STM menu error", errorText(error), scope);
      return;
    }
    if (!action || signal.aborted || !isSameScope(host, scope)) return;

    let confirm: true | undefined;
    if (action === "reset" || action === "setup") {
      const message =
        action === "reset"
          ? "Reset this session's saved memory and checkpoint? Future memory updates use only conversation after the saved reset boundary. Conversation history remains."
          : "Create an optional project-local .opencode/stm.jsonc example? Existing STM configuration is preserved. Installation already creates the minimal config.";
      try {
        if (
          (await host.ui.dialog.confirm({
            title: `STM ${action}`,
            message,
            label: { confirm: action === "reset" ? "Reset memory" : "Create example", cancel: "Cancel" },
          })) !== true
        )
          return;
      } catch (error) {
        await alertIfCurrent(`STM ${action} confirmation error`, errorText(error), scope);
        return;
      }
      confirm = true;
    }

    if (signal.aborted || !isSameScope(host, scope)) return;
    try {
      const result = await invoke(
        {
          requestID: crypto.randomUUID(),
          sessionID: scope.sessionID,
          action,
          ...(confirm === undefined ? {} : { confirm }),
        },
        {
          location: {
            directory: scope.directory,
            ...(scope.workspaceID === undefined ? {} : { workspaceID: scope.workspaceID }),
          },
          signal,
        },
      );
      if (!(result as { accepted?: boolean } | undefined)?.accepted) {
        await alertIfCurrent(
          `STM ${action}`,
          "This request was already handled or could not be admitted. No action was run.",
          scope,
        );
      }
    } catch (error) {
      await alertIfCurrent(`STM ${action} delivery error`, errorText(error), scope);
    }
  };

  host.keymap.layer(() => ({
    // Autocomplete enters its own keymap mode. Keep the slash command
    // reachable there, matching OpenCode's native plugin menu commands.
    mode: "global",
    enabled: () => !signal.aborted,
    commands: [
      {
        id: "stm.menu",
        bind: false,
        title: "STM session memory",
        description: "Show, update, or reset short-term memory",
        group: "Plugin",
        palette: true,
        slash: { name: "stm" },
        run: openMenu,
      },
    ],
  }));
}
