import { wrapReaderText } from "./tui-text-reader";
/** Host-owned Solid/OpenTUI runtime; loaded only when V2 displays a result. */
export type ReaderRuntime = {
  jsx(type: string, props: Record<string, unknown>): any;
  createSignal<T>(value: T): [() => T, (value: T) => unknown];
  onCleanup(cleanup: () => void): void;
};
export async function loadReaderRuntime(): Promise<ReaderRuntime> {
  const [jsx, solid] = await Promise.all([import("@opentui/solid/jsx-runtime"), import("solid-js")]);
  return { jsx: jsx.jsx, createSignal: solid.createSignal, onCleanup: solid.onCleanup };
}
type ScrollArea = { scrollBy(amount: number): void; scrollTo(amount: number): void; scrollHeight: number };
export type V2ReaderHost = {
  renderer: {
    height: number;
    width: number;
    on(event: "resize", handler: () => void): unknown;
    off(event: "resize", handler: () => void): unknown;
  };
  keymap: {
    layer(
      input: () => {
        mode: string;
        enabled: () => boolean;
        commands: { bind: string; title: string; group: string; run: () => void }[];
      },
    ): void;
  };
  ui: {
    dialog: {
      show(render: () => any, onClose?: () => void): void;
      set(options: { size: "large"; centered: boolean }): void;
    };
  };
};

/** Render under dialog.show's component owner so key bindings have the same lifetime as the dialog. */
export function renderV2TextReader(
  host: V2ReaderHost,
  runtime: ReaderRuntime,
  title: string,
  message: string,
  isCurrent: () => boolean,
  onReady: () => void,
) {
  const heightFor = () =>
    Math.max(
      1,
      Math.min(
        24,
        Math.floor(host.renderer.height * 0.75) - 8,
        wrapReaderText(message, Math.max(4, Math.min(88, host.renderer.width - 2) - 5)).length,
      ),
    );
  const [height, setHeight] = runtime.createSignal(heightFor());
  let scroll: ScrollArea | undefined;
  let alive = true;
  const resize = () => setHeight(heightFor());
  host.renderer.on("resize", resize);
  runtime.onCleanup(() => {
    alive = false;
    scroll = undefined;
    host.renderer.off("resize", resize);
  });
  const move = (operation: (area: ScrollArea) => void) => () => {
    if (alive && isCurrent() && scroll) operation(scroll);
  };
  host.keymap.layer(() => ({
    mode: "modal",
    enabled: () => alive && isCurrent(),
    commands: [
      { bind: "up", title: "Scroll STM up", group: "STM", run: move((area) => area.scrollBy(-1)) },
      { bind: "down", title: "Scroll STM down", group: "STM", run: move((area) => area.scrollBy(1)) },
      { bind: "pageup", title: "Previous STM page", group: "STM", run: move((area) => area.scrollBy(-height())) },
      { bind: "pagedown", title: "Next STM page", group: "STM", run: move((area) => area.scrollBy(height())) },
      { bind: "home", title: "First STM line", group: "STM", run: move((area) => area.scrollTo(0)) },
      { bind: "end", title: "Last STM line", group: "STM", run: move((area) => area.scrollTo(area.scrollHeight)) },
    ],
  }));
  const { jsx } = runtime;
  const view = jsx("box", {
    paddingLeft: 2,
    paddingRight: 2,
    paddingBottom: 1,
    gap: 1,
    children: [
      jsx("box", {
        flexDirection: "row",
        justifyContent: "space-between",
        children: [jsx("text", { children: title }), jsx("text", { children: "esc" })],
      }),
      jsx("scrollbox", {
        ref: (value: ScrollArea) => {
          scroll = value;
        },
        get height() {
          return height();
        },
        contentOptions: { minHeight: 0 },
        scrollbarOptions: { visible: false },
        verticalScrollbarOptions: { visible: true },
        children: jsx("text", { wrapMode: "word", children: message }),
      }),
      jsx("text", { children: "Up/Down, PgUp/PgDn, Home/End; Esc closes" }),
    ],
  });
  onReady();
  return view;
}
