import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requestJournal, requestsFromJournal } from "../scripts/request-evidence";

test("request journal preserves completed and in-flight calls across a torn final append", async () => {
  const root = await mkdtemp(join(tmpdir(), "stm-journal-test-"));
  try {
    const file = join(root, "requests.jsonl");
    const write = requestJournal(file, (value) => value.replaceAll("secret-value", "[REDACTED]"));
    const first = { index: 0, started: "first", text: "secret-value" };
    const pending = write(first);
    first.text = "changed after enqueue";
    await Promise.all([
      pending,
      write({ index: 1, started: "second" }),
      write({ index: 0, finished: "done", status: 200 }),
    ]);
    const contents = await readFile(file, "utf8");
    expect(contents).not.toContain("secret-value");
    expect(contents).not.toContain("changed after enqueue");
    expect(requestsFromJournal(contents + '{"index":1,"finished":')).toEqual([
      { index: 0, finished: "done", status: 200 },
      { index: 1, started: "second" },
    ]);
    expect(() => requestsFromJournal(contents + "broken complete line\n")).toThrow();
    expect(requestsFromJournal("")).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
