import { access, readdir } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIVE_VERSION,
  isLiveVersion,
  isPublishedVersion,
  VALIDATOR_ENGINE_FILE,
} from "./specVersion.ts";

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * Walk ancestor directories of `start` (default: this module) for the first
 * `<ancestor>/<relPath>` that exists.
 */
export async function findAncestorPath(
  relPath: string,
  start?: string,
): Promise<string | null> {
  let current = start ?? dirname(fileURLToPath(import.meta.url));
  const { root } = parse(current);
  for (;;) {
    const candidate = join(current, relPath);
    if (await fileExists(candidate)) return candidate;
    if (current === root) return null;
    current = dirname(current);
  }
}

export function specRelPath(
  subdir: string,
  name: string,
  version: string,
): string {
  return isLiveVersion(version)
    ? join(subdir, name)
    : join("versions", version, subdir, name);
}

function archiveSpecRelPath(
  subdir: string,
  name: string,
  version: string,
): string {
  return join("versions", version, subdir, name);
}

/**
 * Locate a bundled spec YAML by walking ancestor directories of THIS module
 * for the first match. The live version resolves to the root
 * `<ancestor>/<subdir>/<name>` (falling back to `versions/<semver>/` if the
 * live tree is gone). Any other semver resolves to
 * `<ancestor>/versions/<semver>/<subdir>/<name>`.
 */
export async function findSpecPath(
  subdir: string,
  name: string,
  version: string,
  start?: string,
): Promise<string | null> {
  if (isLiveVersion(version)) {
    const live = await findAncestorPath(join(subdir, name), start);
    if (live !== null) return live;
  }
  return findAncestorPath(archiveSpecRelPath(subdir, name, version), start);
}

export async function listPublishedVersions(
  start?: string,
): Promise<string[]> {
  const dir = await findAncestorPath("versions", start);
  if (dir === null) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && isPublishedVersion(e.name))
    .map((e) => e.name)
    .sort();
}

export async function listSpecVersions(start?: string): Promise<string[]> {
  const published = await listPublishedVersions(start);
  return [LIVE_VERSION, ...published.filter((v) => v !== LIVE_VERSION)];
}

/** {@link findSpecPath}, but throws when the spec cannot be located rather than returning a path that later fails to read. */
async function assertKnownVersion(
  version: string,
  start?: string,
): Promise<void> {
  if (isLiveVersion(version)) return;
  const published = await listPublishedVersions(start);
  if (published.includes(version)) return;
  const hint = published.length ? published.join(", ") : "none";
  throw new Error(`unknown spec version: ${version} (published: ${hint})`);
}

async function resolveExisting(
  found: string | null,
  version: string,
  missing: string,
  start?: string,
): Promise<string> {
  if (found !== null) return found;
  await assertKnownVersion(version, start);
  throw new Error(missing);
}

export async function resolveSpecPath(
  subdir: string,
  name: string,
  version: string,
  start?: string,
): Promise<string> {
  return resolveExisting(
    await findSpecPath(subdir, name, version, start),
    version,
    `spec file not found: ${specRelPath(subdir, name, version)}`,
    start,
  );
}

export function engineRelPath(version: string): string {
  return isLiveVersion(version)
    ? join("validator", "validators")
    : join("versions", version, "validators");
}

const LIVE_ENGINE_FILE = join(
  "validator",
  "validators",
  VALIDATOR_ENGINE_FILE,
);

export async function findEngineDir(
  version: string,
  start?: string,
): Promise<string | null> {
  if (isLiveVersion(version)) {
    const engineFile = await findAncestorPath(LIVE_ENGINE_FILE, start);
    if (engineFile !== null) return dirname(engineFile);
  }
  return findAncestorPath(join("versions", version, "validators"), start);
}

export async function resolveEngineDir(
  version: string,
  start?: string,
): Promise<string> {
  return resolveExisting(
    await findEngineDir(version, start),
    version,
    `validator engine not found: ${engineRelPath(version)}`,
    start,
  );
}

/** Runtime module is `engines.js`. Under Vitest, load sibling `engines.ts` so coverage maps to source. */
export async function resolveEngineModulePath(
  version: string,
  start?: string,
): Promise<string> {
  const js = join(await resolveEngineDir(version, start), VALIDATOR_ENGINE_FILE);
  if (process.env.VITEST) {
    const ts = js.replace(/\.js$/, ".ts");
    if (await fileExists(ts)) return ts;
  }
  return js;
}
