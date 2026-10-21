import { appendFile } from "node:fs/promises";

/** Serialize bounded per-request snapshots, including starts, before a supervisor can stop the run. */
export function requestJournal(path: string, redact: (value: string) => string) {
  let pending = Promise.resolve();
  return (record: { index: number; [key: string]: unknown }) => {
    const line = redact(JSON.stringify(record)) + "\n";
    const write = pending.then(() => appendFile(path, line));
    pending = write.catch(() => {});
    return write;
  };
}

/** Ignore only a torn final append; a malformed completed line remains an error. */
export function requestsFromJournal(contents: string): any[] {
  const records = new Map<number, any>();
  const lines = contents.split("\n");
  lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (!Number.isInteger(record.index)) throw new Error("Request journal record has no numeric index");
    records.set(record.index, record);
  }
  return [...records.values()].sort((a, b) => a.index - b.index);
}
