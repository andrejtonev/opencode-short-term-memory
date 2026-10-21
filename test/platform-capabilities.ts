import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Windows file symlinks require Developer Mode or a token privilege. Probe
// instead of dropping these assertions on Windows installations that support them.
export const supportsFileSymlinks = (() => {
  const root = mkdtempSync(join(tmpdir(), "stm-file-symlink-capability-"));
  try {
    writeFileSync(join(root, "source"), "sentinel");
    symlinkSync(join(root, "source"), join(root, "link"), "file");
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();
