import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { cleanupCleanToolsRun } from "../scripts/clean-tools-cleanup.mjs";

test("clean-tools cleanup records signal exit without signalling a terminal PID", async () => {
  let kills = 0;
  const evidence = { verdict: "PASS", hostExited: false };
  const cleanup = await cleanupCleanToolsRun(
    {
      host: { pid: 12001, exitCode: null, signalCode: "SIGKILL" },
      evidence,
      platform: "linux",
      endpoint: "http://127.0.0.1:1000",
    },
    {
      killTree: async () => {
        kills++;
        return { succeeded: true, error: null };
      },
      portIsClosed: async () => true,
    },
  );
  expect(kills).toBe(0);
  expect(cleanup.complete).toBe(true);
  expect(evidence.hostExited).toBe(true);
  expect(evidence.verdict).toBe("PASS");
});

test("clean-tools cleanup fails a stuck mock independently of functional success", async () => {
  const evidence = { verdict: "PASS", hostExited: false };
  const cleanup = await cleanupCleanToolsRun(
    { evidence, mock: { close() {}, closeAllConnections() {} } },
    { mockTimeoutMs: 10 },
  );
  expect(cleanup.complete).toBe(false);
  expect(cleanup.mock.closed).toBe(false);
  expect(evidence).toMatchObject({ functionalVerdict: "PASS", cleanupVerdict: "FAIL", verdict: "FAIL" });
});

test("clean-tools runner finalization persists failed containment and sets a failing exit code", async () => {
  const source = await readFile(join(import.meta.dir, "../scripts/v1-clean-tools-acceptance.mjs"), "utf8");
  const marker = "} finally {";
  const start = source.lastIndexOf(marker) + marker.length;
  const end = source.lastIndexOf("}");
  expect(start).toBeGreaterThan(marker.length);
  const written: { path: string; text: string }[] = [];
  const simulatedProcess = { exitCode: undefined as number | undefined };
  const evidence = { verdict: "PASS", hostExited: false };
  const context = {
    primaryID: undefined,
    host: { pid: 12001, exitCode: null, signalCode: null },
    mock: undefined,
    base: "http://127.0.0.1:1000",
    evidence,
    cleanupCleanToolsRun: (input: unknown) =>
      cleanupCleanToolsRun(input, {
        timeoutMs: 30,
        killTree: async () => ({ succeeded: false, error: "denied" }),
        waitForExit: async () => false,
        portIsClosed: async () => false,
      }),
    process: simulatedProcess,
    api: async () => {},
    writeFile: async (path: string, text: string) => {
      written.push({ path, text });
    },
    join: (...parts: string[]) => parts.join("/"),
    root: "/simulated/owned",
    hostLog: "",
    live: false,
    console: { log() {} },
  };
  await runInNewContext(`(async () => { ${source.slice(start, end)} })()`, context);
  expect(simulatedProcess.exitCode).toBe(1);
  expect(evidence.hostExited).toBe(false);
  expect(JSON.parse(written.find((item) => item.path.endsWith("evidence.json"))!.text)).toMatchObject({
    functionalVerdict: "PASS",
    cleanupVerdict: "FAIL",
    verdict: "FAIL",
  });
});
