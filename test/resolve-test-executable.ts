import { access } from "node:fs/promises";
import { join } from "node:path";

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveTestExecutable() {
  const fromEnv = process.env.OPENCODE_EXECUTABLE_FOR_TESTS?.trim();
  if (fromEnv) return fromEnv;

  const candidates = ["opencode"];
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    const userProfile = process.env.USERPROFILE;
    candidates.push(
      localAppData ? join(localAppData, "OpenCode", "opencode-cli") : "",
      localAppData ? join(localAppData, "OpenCode", "opencode-cli.exe") : "",
      userProfile ? join(userProfile, "AppData", "Local", "OpenCode", "opencode-cli") : "",
      userProfile ? join(userProfile, "AppData", "Local", "OpenCode", "opencode-cli.exe") : "",
    );
  }

  for (const candidate of candidates.filter(Boolean)) {
    if (candidate === "opencode") continue;
    if (await exists(candidate)) return candidate;
  }

  return "opencode";
}

export async function preflightCleanSummarizerExecutable(
  executable: string,
): Promise<{ ok: boolean; reason?: string }> {
  const trimmed = String(executable || "").trim();
  if (!trimmed) {
    return { ok: false, reason: "No executable configured." };
  }

  try {
    const proc = Bun.spawn({
      cmd: [trimmed, "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });

    const timedOut = await Promise.race([
      proc.exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 4000)),
    ]);

    if (timedOut) {
      proc.kill();
    }

    return { ok: true };
  } catch (error) {
    const message = (error as Error).message || String(error || "");
    return { ok: false, reason: `Cannot spawn '${trimmed}': ${message}` };
  }
}
