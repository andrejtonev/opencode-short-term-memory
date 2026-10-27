import { expect, test } from "bun:test";
import { terminalScreen } from "../scripts/native-terminal-screen.cjs";

test("terminal replay retains the prefix when OpenTUI redraws only changed scroll cells", () => {
  const initial = "\x1b[2J\x1b[2;3HNATIVE_STM_LINE_000";
  const bottom = initial + "\x1b[2;19H119";
  expect(terminalScreen(bottom, 4, 40)).toContain("NATIVE_STM_LINE_119");
  expect(terminalScreen(bottom + "\x1b[2;19H000", 4, 40)).toContain("NATIVE_STM_LINE_000");
});

test("terminal replay removes dismissed dialogs rather than retaining historical matches", () => {
  expect(terminalScreen("\x1b[2;1HSTM show\x1b[2;1H\x1b[2K", 4, 20).trim()).toBe("");
});
