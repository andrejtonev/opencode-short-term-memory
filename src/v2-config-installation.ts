import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import {
  bootstrapInstalledConfig,
  readConfigDiagnostics,
  resolveProjectOpencodeDir,
  type ConfigBootstrapResult,
} from "./memory-utils";

const STM_PACKAGE = "@atonev/opencode-short-term-memory";
const STM_PACKAGE_PATTERN = /^@atonev\/opencode-short-term-memory(?:@[^\s/]+)?$/;
const CONFIG_NAMES = ["opencode.json", "opencode.jsonc"] as const;
const PLUGIN_SOURCE_DIR_NAMES = ["plugin", "plugins"] as const;

type Failure = { readonly ok: false; readonly message: string };
type Result<T> = { readonly ok: true; readonly value: T } | Failure;
type Scope = "global" | "local";
type Document = { readonly path: string; readonly scope: Scope };
type Operation = { readonly type: "add" | "remove"; readonly target: string; readonly document: Document };
type Declaration = { readonly target: string; readonly scope: Scope; readonly source: string };

const installations = new WeakMap<object, ConfigBootstrapResult>();

/** Replay the supported file-backed subset of native V2 plugin declarations. */
export async function bootstrapV2InstalledConfig(context: Context): Promise<ConfigBootstrapResult> {
  let result: ConfigBootstrapResult;
  try {
    const replay = await replayInstallation(context.location.directory);
    if (!replay.ok) {
      result = { status: "skipped", message: replay.message };
    } else {
      const { declaration, configDirectory } = replay.value;
      const origin =
        declaration.scope === "global"
          ? { spec: declaration.target, source: configDirectory, scope: "global" }
          : { spec: declaration.target, source: declaration.source, scope: "local" };
      result = await bootstrapInstalledConfig([origin]);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    result = {
      status: "error",
      message: `Could not verify the native STM config origin (${detail}); existing settings and defaults remain available.`,
    };
  }
  installations.set(context, result);
  return result;
}

/** Return the bootstrap result recorded for a V2 setup context. */
export function getV2ConfigInstallation(context: Context): ConfigBootstrapResult | undefined {
  return installations.get(context);
}

async function replayInstallation(locationDirectory: string): Promise<
  Result<{
    declaration: Declaration;
    configDirectory: string;
  }>
> {
  if (configDiscoveryDisabled("OPENCODE_CONFIG_PROJECT_DISABLE")) {
    return fail("Native project config discovery is disabled; no config file created.");
  }
  if (configDiscoveryDisabled("OPENCODE_CONFIG_GLOBAL_DISABLE")) {
    return fail("Native global config discovery is disabled; no config file created.");
  }
  const override = explicitConfigOverride();
  if (override) return fail(override);
  if (!isAbsolutePath(locationDirectory))
    return fail("The native V2 location is not absolute; no config file created.");

  const location = resolve(locationDirectory);
  const globalDirectory = nativeGlobalConfigDirectory();
  if ((await pathHasSymlinkComponent(location)) || (await pathHasSymlinkComponent(globalDirectory))) {
    return fail("A symlinked native config root prevents safe origin matching; no config file created.");
  }

  // Native config entries are ordered: global directory, explicit file,
  // direct ancestor files, project .opencode directories, then virtual content.
  // Explicit and virtual sources were rejected above because V2 has no origin API.
  const discovered = await discoverDocuments(location, globalDirectory);
  if (!discovered.ok) return discovered;
  if (await hasPluginSourceDirectory(discovered.value.directoryEntries)) {
    return fail("A native plugin source directory is present, so STM provenance is ambiguous; no config file created.");
  }

  const operations: Operation[] = [];
  for (const document of discovered.value.documents) {
    const parsed = await parseDocument(document.path);
    if (!parsed.ok) return parsed;
    if (!Object.hasOwn(parsed.value, "plugins")) continue;
    if (!Array.isArray(parsed.value.plugins)) {
      return fail(`Native plugin declarations in ${document.path} are not a static array; no config file created.`);
    }
    for (const entry of parsed.value.plugins) {
      const operation = parsePluginEntry(entry, document);
      if (!operation.ok) return operation;
      if (operation.value) operations.push(operation.value);
    }
  }

  const active: Declaration[] = [];
  for (const operation of operations) {
    if (operation.type === "remove") {
      for (let index = active.length - 1; index >= 0; index--) {
        if (active[index]!.target === operation.target) active.splice(index, 1);
      }
    } else if (isStmPackage(operation.target)) {
      active.push({ target: operation.target, scope: operation.document.scope, source: operation.document.path });
    }
  }

  if (active.length === 0)
    return fail("No active file-backed STM package declaration was found; no config file created.");
  if (active.length !== 1) {
    return fail(
      "More than one active STM package declaration remains after native add/remove ordering; no config file created.",
    );
  }

  const declaration = active[0]!;
  const configDirectory = declaration.scope === "global" ? globalDirectory : localConfigDestination(declaration.source);
  const diagnostics = await readConfigDiagnostics(location);
  let isSearchTarget = false;
  for (const source of diagnostics.configSources) {
    const expectedScope =
      declaration.scope === "global"
        ? source.scope === "global" || source.scope === "environment"
        : source.scope === "project";
    if (expectedScope && (await samePath(source.directory, configDirectory))) {
      isSearchTarget = true;
      break;
    }
  }
  if (!isSearchTarget) {
    return fail(
      "The active STM declaration does not map to a directory read by STM config discovery; no config file created.",
    );
  }
  if (await pathHasSymlinkComponent(configDirectory)) {
    return fail("The selected STM settings directory contains a symlink; no config file created.");
  }
  return ok({ declaration, configDirectory });
}

function configDiscoveryDisabled(name: "OPENCODE_CONFIG_PROJECT_DISABLE" | "OPENCODE_CONFIG_GLOBAL_DISABLE"): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

function explicitConfigOverride(): string | undefined {
  if (process.env.OPENCODE_CONFIG !== undefined) {
    return "OPENCODE_CONFIG is an explicit source whose origin is unavailable in V2 setup; no config file created.";
  }
  if (process.env.OPENCODE_CONFIG_CONTENT !== undefined) {
    return "OPENCODE_CONFIG_CONTENT is virtual and has no installation directory; no config file created.";
  }
  const args = process.argv.slice(2);
  if (args.some((argument) => argument === "-c" || argument.startsWith("-c=") || argument.startsWith("--config"))) {
    return "An explicit native config CLI option has no V2 origin metadata; no config file created.";
  }
  return undefined;
}

function nativeGlobalConfigDirectory(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return resolve(process.env.OPENCODE_CONFIG_DIR);
  return resolve(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
}

async function discoverDocuments(
  location: string,
  globalDirectory: string,
): Promise<
  Result<{
    documents: Document[];
    directoryEntries: string[];
  }>
> {
  const globalDocuments: Document[] = [];
  for (const name of CONFIG_NAMES) {
    const path = join(globalDirectory, name);
    const existing = await configFileExists(path);
    if (!existing.ok) return existing;
    if (existing.value) globalDocuments.push({ path, scope: "global" });
  }

  const ancestors: string[] = [];
  for (let current = location; ; ) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const globalReal = await realpathIfExists(globalDirectory);
  const direct: Document[] = [];
  const projectDirectories: string[] = [];
  for (const directory of ancestors) {
    // ConfigDiscovery emits jsonc then json per ancestor, then reverses the
    // flattened direct list, producing outer-to-inner json/jsonc order.
    for (const name of ["opencode.jsonc", "opencode.json"] as const) {
      const path = join(directory, name);
      const existing = await configFileExists(path);
      if (!existing.ok) return existing;
      if (!existing.value) continue;
      const actual = await realpathIfExists(path);
      if (actual && globalReal && (await samePath(actual, join(globalReal, name)))) continue;
      direct.push({ path, scope: "local" });
    }

    const opencodeDirectory = join(directory, ".opencode");
    const existing = await configDirectoryExists(opencodeDirectory);
    if (!existing.ok) return existing;
    if (!existing.value) continue;
    const actual = await realpathIfExists(opencodeDirectory);
    if (actual && globalReal && (await samePath(actual, globalReal))) continue;
    projectDirectories.push(opencodeDirectory);
  }

  const directDocuments = direct.reverse();
  const projectDocuments: Document[] = [];
  const orderedProjectDirectories = projectDirectories.reverse();
  for (const directory of orderedProjectDirectories) {
    for (const name of CONFIG_NAMES) {
      const path = join(directory, name);
      const existing = await configFileExists(path);
      if (!existing.ok) return existing;
      if (existing.value) projectDocuments.push({ path, scope: "local" });
    }
  }
  return ok({
    documents: [...globalDocuments, ...directDocuments, ...projectDocuments],
    directoryEntries: [globalDirectory, ...orderedProjectDirectories],
  });
}

async function configFileExists(path: string): Promise<Result<boolean>> {
  const state = await lstatIfExists(path);
  if (!state.ok) return state;
  if (!state.value) return ok(false);
  if (state.value.isSymbolicLink() || (await pathHasSymlinkComponent(path))) {
    return fail(`Native config ${path} is symlinked; no config file created.`);
  }
  if (!state.value.isFile()) return fail(`Native config ${path} is not a regular file; no config file created.`);
  return ok(true);
}

async function configDirectoryExists(path: string): Promise<Result<boolean>> {
  const state = await lstatIfExists(path);
  if (!state.ok) return state;
  if (!state.value) return ok(false);
  if (state.value.isSymbolicLink() || (await pathHasSymlinkComponent(path))) {
    return fail(`Native config directory ${path} is symlinked; no config file created.`);
  }
  return ok(state.value.isDirectory());
}

async function parseDocument(path: string): Promise<Result<Record<string, unknown>>> {
  const text = await readFile(path, "utf8");
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) {
    return fail(`Native config ${path} is malformed or unsupported; no config file created.`);
  }
  return ok(value as Record<string, unknown>);
}

function parsePluginEntry(value: unknown, document: Document): Result<Operation | undefined> {
  let target: unknown;
  let type: Operation["type"] = "add";
  if (typeof value === "string") {
    if (value.startsWith("-")) {
      type = "remove";
      target = value.slice(1);
    } else {
      target = value;
    }
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    target = (value as { package?: unknown }).package;
    const options = (value as { options?: unknown }).options;
    if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options))) {
      return fail(`Native plugin options in ${document.path} are unsupported; no config file created.`);
    }
  } else {
    return fail(`A native plugin declaration in ${document.path} is unsupported; no config file created.`);
  }

  if (typeof target !== "string" || !target) {
    return fail(
      `A native plugin declaration in ${document.path} has no static package target; no config file created.`,
    );
  }
  if (hasSubstitution(target)) {
    return fail(`A native plugin target in ${document.path} uses substitution; no config file created.`);
  }
  if (isUnsupportedTarget(target)) {
    return fail(
      `A path, URL, or alias plugin target in ${document.path} cannot be classified safely; no config file created.`,
    );
  }
  if (type === "add" && !isStaticPackageTarget(target)) {
    return fail(`A non-package plugin target in ${document.path} cannot be classified safely; no config file created.`);
  }
  if (type === "remove" && !isStaticPackageTarget(target)) {
    return fail(
      `A non-package plugin removal in ${document.path} cannot be classified safely; no config file created.`,
    );
  }
  return ok(isStmPackage(target) ? { type, target, document } : undefined);
}

function isUnsupportedTarget(target: string): boolean {
  return (
    target.startsWith("./") ||
    target.startsWith("../") ||
    target.startsWith("/") ||
    target.startsWith("\\\\") ||
    /^[a-z]:[\\/]/i.test(target) ||
    /^[a-z][a-z0-9+.-]*:/i.test(target)
  );
}

function isStaticPackageTarget(target: string): boolean {
  return /^[a-zA-Z0-9@._/-]+$/.test(target) && !target.endsWith("/") && !target.includes("//");
}

function hasSubstitution(target: string): boolean {
  return /\$\{[^}]*\}|\{\s*env\s*:/i.test(target);
}

function isStmPackage(target: string): boolean {
  return STM_PACKAGE_PATTERN.test(target);
}

function localConfigDestination(source: string): string {
  const directory = dirname(source);
  return basename(directory) === ".opencode" ? directory : join(directory, ".opencode");
}

function isAbsolutePath(path: string): boolean {
  return parse(path).root.length > 0;
}

async function samePath(left: string, right: string): Promise<boolean> {
  const [leftReal, rightReal] = await Promise.all([realpathIfExists(left), realpathIfExists(right)]);
  const normalizedLeft = resolve(leftReal ?? left);
  const normalizedRight = resolve(rightReal ?? right);
  // Keep case-sensitive Windows directories distinct. If a directory does
  // not exist yet, only exact lexical equality is enough to create into it.
  return normalizedLeft === normalizedRight;
}

async function hasPluginSourceDirectory(directories: readonly string[]): Promise<boolean> {
  for (const directory of directories) {
    for (const name of PLUGIN_SOURCE_DIR_NAMES) {
      const state = await lstatIfExists(join(directory, name));
      if (!state.ok || (state.value && (state.value.isDirectory() || state.value.isSymbolicLink()))) return true;
    }
  }
  return false;
}

async function pathHasSymlinkComponent(path: string): Promise<boolean> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const state = await lstatIfExists(current);
    if (!state.ok || state.value?.isSymbolicLink()) return true;
  }
  return false;
}

async function lstatIfExists(path: string): Promise<Result<Awaited<ReturnType<typeof lstat>> | undefined>> {
  try {
    return ok(await lstat(path));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return ok(undefined);
    return fail(`Could not inspect ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function realpathIfExists(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail(message: string): Failure {
  return { ok: false, message };
}
