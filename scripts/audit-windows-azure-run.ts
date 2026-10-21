import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { requestsFromJournal } from "./request-evidence";
const auth = JSON.parse(await readFile(join(homedir(), ".local/share/opencode/auth.json"), "utf8").catch(() => "{}"));
const key = auth.azure?.key || process.env.AZURE_OPENAI_API_KEY;
if (!key) throw new Error("Azure credential is required to audit for accidental persistence");
const secret = Buffer.from(key);
for (const root of process.argv.slice(2)) {
  const evidence = JSON.parse(await readFile(join(root, "evidence.json"), "utf8"));
  let inspectedFiles = 0;
  const exposedFiles: string[] = [];
  async function walk(dir: string) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (["node_modules", "bun_install_cache_dir", "xdg_cache_home", "_cacache", ".git"].includes(item.name)) continue;
      const path = join(dir, item.name);
      if (item.isDirectory()) await walk(path);
      else if (item.isFile()) {
        const bytes = await readFile(path).catch(() => Buffer.alloc(0));
        inspectedFiles++;
        if (bytes.includes(secret)) exposedFiles.push(path);
      }
    }
  }
  await walk(root);
  const logs = await readFile(join(root, "host.log"), "utf8");
  const personalHomeConfig = logs
    .split("\n")
    .filter(
      (line) =>
        /(?:loading|watcher|instruction|skill)/i.test(line) &&
        (line.includes(homedir().replaceAll("\\", "\\\\") + "\\\\.opencode") ||
          line.includes(homedir().replaceAll("\\", "\\\\") + "\\\\.config\\\\opencode")),
    );
  const requestFile = await readFile(join(root, "requests.json"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const journal =
    requestFile === undefined
      ? await readFile(join(root, "requests.jsonl"), "utf8").catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        })
      : undefined;
  const requests = requestFile !== undefined ? JSON.parse(requestFile) : requestsFromJournal(journal ?? "");
  const requestsAvailable = requestFile !== undefined || journal !== undefined;
  const toolOutput = requests
    .flatMap((r: any) => r.messages.filter((m: any) => m.role === "tool").map((m: any) => JSON.stringify(m.content)))
    .join("\n");
  const summaries = requests.filter((request: any) => {
    const content = JSON.stringify(request.messages.findLast((message: any) => message.role === "user")?.content) ?? "";
    return content.includes("<conversation_update>") && content.includes("<existing_memory>");
  });
  const memory = join(root, "project/.opencode/memory");
  const events = (await readFile(join(memory, "session-memory.log"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const sideIDs = events.filter((event) => event.event === "side_session_created").map((event) => event.sessionID);
  const memoryFiles = await readdir(memory);
  const tracking = JSON.parse(await readFile(join(memory, "side-sessions.json"), "utf8").catch(() => "[]"));
  const audit = {
    case: basename(root),
    inspectedFiles,
    azureKeyFound: exposedFiles.length > 0,
    personalHomeConfigReferences: personalHomeConfig.length,
    settingsOutputContainsCaseRoot: toolOutput.includes(basename(root)),
    recordedHostExited: evidence.hostExited ?? null,
    candidateSha256: evidence.candidateSha256,
    requestsEvidenceAvailable: requestsAvailable,
    requestEvidenceSource: requestFile !== undefined ? "snapshot" : journal !== undefined ? "journal" : "missing",
    summaryRequests: requestsAvailable ? summaries.length : null,
    summaryToolsAbsent: !requestsAvailable
      ? null
      : summaries.length > 0 && summaries.every((request: any) => request.tools.length === 0),
    summaryToolCallOutputs: summaries
      .filter((request: any) => (request.response?.message?.tool_calls?.length ?? 0) > 0)
      .map((request: any) => ({
        index: request.index,
        tools: request.response.message.tool_calls.map((call: any) => call.function?.name),
      })),
    incompleteRequests: !requestsAvailable ? null : requests.filter((request: any) => !request.finished).length,
    transportErrors: !requestsAvailable
      ? null
      : requests.filter((request: any) => request.error || (request.status && request.status !== 200)).length,
    injectedFaults: !requestsAvailable ? null : requests.filter((request: any) => request.injectedFault).length,
    sideSessionMemories: sideIDs.filter((id: string) => memoryFiles.includes(`session_${id}.md`)),
    trackedSideSessions: tracking,
    historyReadErrors: events.filter((event) => event.event === "collect_recent_messages_error").length,
  };
  await writeFile(join(root, "isolation-audit.json"), JSON.stringify(audit, null, 2));
  console.log(JSON.stringify(audit));
}
