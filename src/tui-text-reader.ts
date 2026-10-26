/** Keyboard-scrollable text reader using only the host's public renderer and dialogs. */
export type ReaderKey = {
  name: string;
  ctrl?: boolean;
  meta?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
};
export type ReaderHost<Node> = {
  renderer: {
    width: number;
    height: number;
    on?(event: "resize", handler: () => void): unknown;
    off?(event: "resize", handler: () => void): unknown;
    keyInput: {
      prependListener(event: "keypress", handler: (key: ReaderKey) => void): unknown;
      off(event: "keypress", handler: (key: ReaderKey) => void): unknown;
    };
  };
  ui: {
    DialogAlert(input: { title: string; message: string }): Node;
    dialog: { replace(render: () => Node, onClose?: () => void): void; setSize(size: "large"): void };
  };
};
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function columns(text: string) {
  if (/^[\p{Mark}\p{Cf}]+$/u.test(text)) return 0;
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Extended_Pictographic}]/u.test(text) ? 2 : 1;
}
export function wrapReaderText(text: string, width: number): string[] {
  const result: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n")) {
    let row = "",
      count = 0;
    for (const item of segmenter.segment(line)) {
      const size = columns(item.segment);
      if (count + size > width && row) {
        result.push(row);
        row = "";
        count = 0;
      }
      row += item.segment;
      count += size;
    }
    result.push(row);
  }
  return result;
}
export function openTextReader<Node>(
  api: ReaderHost<Node>,
  title: string,
  text: string,
  isCurrent: () => boolean = () => true,
): () => void {
  let offset = 0,
    disposed = false,
    replacing = false;
  const dimensions = () => ({
    width: Math.max(4, Math.min(88, api.renderer.width - 2) - 4),
    page: Math.max(1, Math.floor(api.renderer.height * 0.75) - 12),
  });
  const close = () => {
    if (disposed) return;
    disposed = true;
    api.renderer.keyInput.off("keypress", onKey);
    api.renderer.off?.("resize", draw);
  };
  const draw = () => {
    if (disposed || !isCurrent()) {
      close();
      return;
    }
    const { width, page } = dimensions();
    const lines = wrapReaderText(text, width);
    offset = Math.min(offset, Math.max(0, lines.length - page));
    const end = Math.min(offset + page, lines.length);
    const footer = `Lines ${offset + 1}-${end} of ${lines.length}\nUp/Down, PgUp/PgDn, Home/End; Esc closes`;
    replacing = true;
    try {
      api.ui.dialog.replace(
        () => {
          // The host stores this component callback. Scope or ownership can
          // change after replace() returns and before the view is evaluated.
          if (disposed || !isCurrent()) {
            close();
            return null as Node;
          }
          return api.ui.DialogAlert({ title, message: lines.slice(offset, end).join("\n") + "\n\n" + footer });
        },
        () => {
          if (!replacing) close();
        },
      );
      api.ui.dialog.setSize("large");
    } finally {
      replacing = false;
    }
  };
  const onKey = (key: ReaderKey) => {
    if (!isCurrent()) {
      close();
      return;
    }
    if (key.ctrl || key.meta) return;
    const { width, page } = dimensions();
    const max = Math.max(0, wrapReaderText(text, width).length - page);
    switch (key.name) {
      case "up":
        offset = Math.max(0, offset - 1);
        break;
      case "down":
        offset = Math.min(max, offset + 1);
        break;
      case "pageup":
        offset = Math.max(0, offset - page);
        break;
      case "pagedown":
        offset = Math.min(max, offset + page);
        break;
      case "home":
        offset = 0;
        break;
      case "end":
        offset = max;
        break;
      default:
        return;
    }
    key.preventDefault();
    key.stopPropagation();
    draw();
  };
  // Host keymap handlers consume navigation keys before ordinary listeners.
  // Prepend only while this reader owns the dialog; dismissal removes it.
  api.renderer.keyInput.prependListener("keypress", onKey);
  api.renderer.on?.("resize", draw);
  draw();
  return close;
}
