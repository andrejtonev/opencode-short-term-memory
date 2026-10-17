import { describe, expect, test } from "bun:test";
import {
  extractComposer,
  type OrdinaryTypingEvidence,
  type ScreenshotSaver,
  type TmuxExecutor,
  typeAndSubmitOrdinary,
} from "../scripts/rc-keyboard-driver";

const PANE = "stm-pane";
const LABEL = "ordinary";
const WIDTH = 40;

function screenFor(text: string, footer?: string): string {
  const content = text.split("\n");
  const rows = content.map((line) => `  ┃${line.padEnd(WIDTH - 1)}┃ right`);
  if (footer !== undefined) rows.push(`  ┃${footer.padEnd(WIDTH - 1)}┃ right`);
  rows.push(`  ╹${"▀".repeat(WIDTH - 1)} right`);
  return ["indented header", ...rows, "cropped footer"].join("\n");
}

function emptyScreen(): string {
  return screenFor("");
}

function futureDeadline(): number {
  return Date.now() + 2_000;
}

describe("RC keyboard driver", () => {
  test("extracts an indented, cropped composer and removes only a final footer", () => {
    const message = "Build Plan text  with  spaces\nsecond  line";
    const geometry = extractComposer(screenFor(message, "Build · Plan"));

    expect(geometry.text).toBe(message);
    expect(geometry.startColumn).toBe(2);
    expect(geometry.endColumn).toBe(2 + WIDTH);
    expect(geometry.rows).toEqual(["Build Plan text  with  spaces", "second  line"]);
  });

  test("preserves multiline geometry and internal double spaces", () => {
    const geometry = extractComposer(screenFor("first  line\nsecond   line"));
    const footerLikeMessage = extractComposer(screenFor("Build · ordinary text\nsecond line"));

    expect(geometry.text).toBe("first  line\nsecond   line");
    expect(geometry.rows).toEqual(["first  line", "second   line"]);
    expect(footerLikeMessage.text).toBe("Build · ordinary text\nsecond line");
  });

  test("rejects a missing bottom border and missing contiguous vertical rows", () => {
    expect(() => extractComposer("no composer here")).toThrow("bottom border was not present");
    expect(() => extractComposer(`  ╹${"▀".repeat(WIDTH - 1)}`)).toThrow("composer vertical rows were not present");
  });

  test("types literally, captures ordered protocol evidence, and submits once", async () => {
    const literal = "ordinary  text";
    const screens = [emptyScreen(), screenFor(literal), screenFor(literal)];
    const calls: string[][] = [];
    const saves: Array<[string, string]> = [];
    let captureIndex = 0;
    const tmux: TmuxExecutor = async (args) => {
      calls.push(args);
      if (args[0] === "capture-pane") {
        return { stdout: screens[captureIndex++] ?? screens.at(-1)! };
      }
      return { stdout: "" };
    };
    const save: ScreenshotSaver = (label, screen) => {
      saves.push([label, screen]);
    };

    const evidence: OrdinaryTypingEvidence = await typeAndSubmitOrdinary({
      pane: PANE,
      text: literal,
      tmux,
      save,
      label: LABEL,
      deadlineAt: futureDeadline(),
    });

    expect(calls).toEqual([
      ["capture-pane", "-p", "-t", PANE],
      ["send-keys", "-t", PANE, "-l", literal],
      ["capture-pane", "-p", "-t", PANE],
      ["capture-pane", "-p", "-t", PANE],
      ["send-keys", "-t", PANE, "Enter"],
    ]);
    expect(saves).toEqual([
      [`${LABEL}-baseline`, screens[0]],
      [`${LABEL}-typed`, screens[1]],
      [`${LABEL}-pre-enter`, screens[2]],
    ]);
    expect(evidence.literalSent).toBe(literal);
    expect(evidence.actualComposer).toBe(literal);
    expect(evidence.baseline).toBe(screens[0]);
    expect(evidence.typed).toBe(screens[1]);
    expect(evidence.preEnter).toBe(screens[2]);
    expect(evidence.geometry.text).toBe(literal);
    expect(Number.isFinite(evidence.submittedAt)).toBe(true);
  });

  test("fails closed when the baseline composer is not empty", async () => {
    const calls: string[][] = [];
    const tmux: TmuxExecutor = async (args) => {
      calls.push(args);
      return { stdout: screenFor("already typed") };
    };

    await expect(
      typeAndSubmitOrdinary({
        pane: PANE,
        text: "new text",
        tmux,
        save: () => {},
        label: LABEL,
        deadlineAt: futureDeadline(),
      }),
    ).rejects.toThrow("composer is not empty");
    expect(calls).toEqual([["capture-pane", "-p", "-t", PANE]]);
    expect(calls.some((args) => args[0] === "send-keys")).toBe(false);
    expect(calls.some((args) => args.at(-1) === "Enter")).toBe(false);
  });

  test("fails closed when baseline geometry is missing", async () => {
    const calls: string[][] = [];
    const tmux: TmuxExecutor = async (args) => {
      calls.push(args);
      return { stdout: "malformed baseline" };
    };

    await expect(
      typeAndSubmitOrdinary({
        pane: PANE,
        text: "valid",
        tmux,
        save: () => {},
        label: LABEL,
        deadlineAt: futureDeadline(),
      }),
    ).rejects.toThrow("composer bottom border was not present");
    expect(calls).toEqual([["capture-pane", "-p", "-t", PANE]]);
    expect(calls.some((args) => args[0] === "send-keys")).toBe(false);
  });

  test("refuses Enter if the pre-Enter composer changed", async () => {
    const calls: string[][] = [];
    const screens = [emptyScreen(), screenFor("new text"), screenFor("changed")];
    let captureIndex = 0;
    const tmux: TmuxExecutor = async (args) => {
      calls.push(args);
      return args[0] === "capture-pane" ? { stdout: screens[captureIndex++]! } : { stdout: "" };
    };

    await expect(
      typeAndSubmitOrdinary({
        pane: PANE,
        text: "new text",
        tmux,
        save: () => {},
        label: LABEL,
        deadlineAt: futureDeadline(),
      }),
    ).rejects.toThrow("changed before Enter");
    expect(calls).toEqual([
      ["capture-pane", "-p", "-t", PANE],
      ["send-keys", "-t", PANE, "-l", "new text"],
      ["capture-pane", "-p", "-t", PANE],
      ["capture-pane", "-p", "-t", PANE],
    ]);
    expect(calls.some((args) => args.at(-1) === "Enter")).toBe(false);
  });

  test("rejects invalid text and deadlines before invoking tmux", async () => {
    const invalid = ["", " leading", "trailing ", "/command", "line\nbreak", "caf\u00e9", "x".repeat(101)];
    for (const text of invalid) {
      const calls: string[][] = [];
      const tmux: TmuxExecutor = async (args) => {
        calls.push(args);
        return { stdout: emptyScreen() };
      };
      await expect(
        typeAndSubmitOrdinary({
          pane: PANE,
          text,
          tmux,
          save: () => {},
          label: LABEL,
          deadlineAt: futureDeadline(),
        }),
      ).rejects.toThrow();
      expect(calls).toHaveLength(0);
    }

    for (const deadlineAt of [Date.now() - 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const calls: string[][] = [];
      const tmux: TmuxExecutor = async (args) => {
        calls.push(args);
        return { stdout: emptyScreen() };
      };
      await expect(
        typeAndSubmitOrdinary({
          pane: PANE,
          text: "valid",
          tmux,
          save: () => {},
          label: LABEL,
          deadlineAt,
        }),
      ).rejects.toThrow();
      expect(calls).toHaveLength(0);
    }
  });
});
