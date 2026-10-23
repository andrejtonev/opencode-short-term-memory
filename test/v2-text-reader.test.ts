import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { renderV2TextReader, type ReaderRuntime, type V2ReaderHost } from "../src/v2-text-reader";

test("V2 long results retain all text in a bounded scroll area with scoped navigation and resize cleanup", () => {
  const renderer = Object.assign(new EventEmitter(), { height: 45, width: 140 });
  const cleanups: (() => void)[] = [];
  const moves: number[] = [];
  const positions: number[] = [];
  const area = {
    scrollHeight: 500,
    scrollBy: (n: number) => {
      moves.push(n);
    },
    scrollTo: (n: number) => {
      positions.push(n);
    },
  };
  let layer!: ReturnType<Parameters<V2ReaderHost["keymap"]["layer"]>[0]>;
  let current = true;
  let ready = 0;
  const runtime: ReaderRuntime = {
    jsx: (type, props) => {
      if (type === "scrollbox") (props.ref as (area: unknown) => void)(area);
      return { type, props };
    },
    createSignal: (initial) => {
      let value = initial;
      return [
        () => value,
        (next) => {
          value = next;
        },
      ];
    },
    onCleanup: (cleanup) => {
      cleanups.push(cleanup);
    },
  };
  const host = {
    renderer,
    keymap: {
      layer: (read: () => typeof layer) => {
        layer = read();
      },
    },
    ui: { dialog: {} },
  } as V2ReaderHost;
  const text = Array.from({ length: 300 }, (_, i) => `LINE_${i} \u65e5\u672c\u8a9e`).join("\n");
  const view = renderV2TextReader(
    host,
    runtime,
    "STM show",
    text,
    () => current,
    () => {
      ready++;
    },
  );
  const [header, body, footer] = view.props.children;
  expect(header.props.children[0].props.children).toBe("STM show");
  expect(body.type).toBe("scrollbox");
  expect(body.props.height).toBe(24);
  expect(body.props.scrollbarOptions.visible).toBe(false);
  expect(body.props.verticalScrollbarOptions.visible).toBe(true);
  expect(body.props.children.props.children).toBe(text);
  expect(footer.props.children).toContain("PgUp/PgDn");
  expect(ready).toBe(1);
  const press = (key: string) => layer.commands.find((command) => command.bind === key)!.run();
  for (const key of ["up", "down", "pageup", "pagedown", "home", "end"]) press(key);
  expect(moves).toEqual([-1, 1, -24, 24]);
  expect(positions).toEqual([0, 500]);
  renderer.height = 20;
  renderer.emit("resize");
  expect(body.props.height).toBe(7);
  press("pagedown");
  expect(moves.at(-1)).toBe(7);
  current = false;
  expect(layer.enabled()).toBe(false);
  press("down");
  expect(moves).toHaveLength(5);
  current = true;
  cleanups.forEach((cleanup) => cleanup());
  expect(renderer.listenerCount("resize")).toBe(0);
  expect(layer.enabled()).toBe(false);
  press("end");
  expect(positions).toEqual([0, 500]);
});
