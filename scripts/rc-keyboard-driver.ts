export type ComposerGeometry = {
  text: string;
  startColumn: number;
  endColumn: number;
  rows: string[];
};

export type TmuxExecutor = (args: string[]) => Promise<{ stdout?: string } | string>;
export type ScreenshotSaver = (label: string, screen: string) => Promise<void> | void;

export type OrdinaryTypingEvidence = {
  literalSent: string;
  actualComposer: string;
  baseline: string;
  typed: string;
  preEnter: string;
  geometry: ComposerGeometry;
  submittedAt: number;
};

const MAX_TEXT_LENGTH = 100;
const POLL_INTERVAL_MS = 100;
const INVOCATION_LIMIT_MS = 10_000;
const FOOTER = /(?:Build|Plan)\b[^\n]*[·•][^\n]*$/i;

function stdout(result: Awaited<ReturnType<TmuxExecutor>>): string {
  return typeof result === "string" ? result : (result.stdout ?? "");
}

function rowsOf(screen: string): string[] {
  return screen.split(/\r?\n/);
}

export function extractComposer(screen: string): ComposerGeometry {
  const rows = rowsOf(screen);
  const borderIndex = rows.findLastIndex((row) => /^\s*╹▀+/.test(row));
  if (borderIndex < 0) throw new Error("composer bottom border was not present");

  const border = /╹▀+/.exec(rows[borderIndex]!);
  if (!border) throw new Error("composer bottom border was not measurable");
  const startColumn = border.index;
  const endColumn = startColumn + border[0].length;
  const composerRows: string[] = [];
  for (let index = borderIndex - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row[startColumn] !== "┃") break;
    composerRows.push(
      row
        .slice(startColumn + 1, endColumn)
        .replace(/^[ \t]+/, "")
        .replace(/[ \t]+$/, ""),
    );
  }
  if (composerRows.length === 0) throw new Error("composer vertical rows were not present");
  composerRows.reverse();
  if (composerRows.length > 0 && FOOTER.test(composerRows.at(-1)!)) composerRows.pop();

  const firstContent = composerRows.findIndex((row) => row !== "");
  const lastContent = composerRows.findLastIndex((row) => row !== "");
  const contentRows = firstContent < 0 ? [] : composerRows.slice(firstContent, lastContent + 1);
  return {
    text: contentRows.join("\n"),
    startColumn,
    endColumn,
    rows: composerRows,
  };
}

function validateText(text: string): void {
  if (
    text.length === 0 ||
    text.length > MAX_TEXT_LENGTH ||
    text.trim() !== text ||
    text.trimStart().startsWith("/") ||
    !/^[\x20-\x7e]+$/.test(text)
  ) {
    throw new Error(
      "ordinary keyboard text must be a trimmed, non-empty, single-line ASCII string of at most 100 characters and not a command",
    );
  }
}

async function capture(tmux: TmuxExecutor, pane: string): Promise<string> {
  return stdout(await tmux(["capture-pane", "-p", "-t", pane]));
}

export async function typeAndSubmitOrdinary({
  pane,
  text,
  tmux,
  save,
  label,
  deadlineAt,
}: {
  pane: string;
  text: string;
  tmux: TmuxExecutor;
  save: ScreenshotSaver;
  label: string;
  deadlineAt: number;
}): Promise<OrdinaryTypingEvidence> {
  validateText(text);
  if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) {
    throw new Error("ordinary keyboard deadline must be finite and in the future");
  }
  const stopAt = Math.min(deadlineAt, Date.now() + INVOCATION_LIMIT_MS);
  const baseline = await capture(tmux, pane);
  await save(`${label}-baseline`, baseline);
  const baselineGeometry = extractComposer(baseline);
  if (baselineGeometry.startColumn < 0) throw new Error("ordinary keyboard baseline has no composer geometry");
  if (baselineGeometry.text !== "") throw new Error("ordinary keyboard baseline composer is not empty");
  if (Date.now() >= stopAt) throw new Error("ordinary keyboard deadline reached before typing");

  await tmux(["send-keys", "-t", pane, "-l", text]);
  let typed = baseline;
  let typedGeometry = baselineGeometry;
  while (Date.now() < stopAt) {
    typed = await capture(tmux, pane);
    typedGeometry = extractComposer(typed);
    if (typedGeometry.text === text) break;
    await Bun.sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, stopAt - Date.now())));
  }
  if (typedGeometry.text !== text)
    throw new Error(`composer did not contain the literal text before deadline: ${JSON.stringify(text)}`);
  await save(`${label}-typed`, typed);

  const preEnter = await capture(tmux, pane);
  const preEnterGeometry = extractComposer(preEnter);
  if (preEnterGeometry.text !== text) throw new Error("composer changed before Enter");
  await save(`${label}-pre-enter`, preEnter);
  if (Date.now() >= stopAt) throw new Error("ordinary keyboard deadline reached before Enter");
  await tmux(["send-keys", "-t", pane, "Enter"]);
  return {
    literalSent: text,
    actualComposer: preEnterGeometry.text,
    baseline,
    typed,
    preEnter,
    geometry: preEnterGeometry,
    submittedAt: Date.now(),
  };
}
