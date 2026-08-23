import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  engineRelPath,
  findAncestorPath,
  findEngineDir,
  findSpecPath,
  listPublishedVersions,
  listSpecVersions,
  resolveEngineDir,
  resolveEngineModulePath,
  resolveSpecPath,
  specRelPath,
} from "./resolveSpecPath.ts";
import { LIVE_VERSION, SPEC_FILES, VALIDATOR_ENGINE_FILE } from "./specVersion.ts";

describe("specRelPath", () => {
  test("the live version is the live root; any other semver is under versions/", () => {
    expect(specRelPath("backend", "routes.spec.yaml", LIVE_VERSION)).toBe(
      join("backend", "routes.spec.yaml"),
    );
    expect(specRelPath("backend", "routes.spec.yaml", "1.0.0")).toBe(
      join("backend", "routes.spec.yaml"),
    );
    expect(specRelPath("backend", "routes.spec.yaml", "2.0.0")).toBe(
      join("versions", "2.0.0", "backend", "routes.spec.yaml"),
    );
  });
});

describe("findSpecPath", () => {
  test("resolves a bundled backend spec to a readable file", async () => {
    const path = await findSpecPath("backend", "routes.spec.yaml", LIVE_VERSION);
    expect(path).not.toBeNull();
    const text = await readFile(path!, "utf8");
    expect(text).toContain("$schema");
  });

  test("resolves a bundled frontend spec", async () => {
    const path = await findSpecPath("frontend", "bindings.spec.yaml", LIVE_VERSION);
    expect(path).not.toBeNull();
  });

  test("resolves the live version to the root specs", async () => {
    const path = await findSpecPath(
      "backend",
      "types.spec.yaml",
      "1.0.0",
    );
    expect(path).not.toBeNull();
    expect(path).not.toContain(join("versions", "1.0.0"));
    const text = await readFile(path!, "utf8");
    expect(text).toContain("version: 1.0.0");
  });

  test("returns null for an unknown spec", async () => {
    expect(
      await findSpecPath("backend", "does-not-exist.spec.yaml", LIVE_VERSION),
    ).toBeNull();
  });

  test("returns null when walking from a tree that has no specs", async () => {
    expect(
      await findSpecPath("backend", "routes.spec.yaml", LIVE_VERSION, tmpdir()),
    ).toBeNull();
  });
});

describe("findAncestorPath", () => {
  test("returns null when the relative path is never found", async () => {
    expect(await findAncestorPath("no-such-rel-path-xyz", tmpdir())).toBeNull();
  });
});

describe("resolveSpecPath", () => {
  test("returns the path for a known spec", async () => {
    await expect(
      resolveSpecPath("backend", "services.spec.yaml", LIVE_VERSION),
    ).resolves.toContain("services.spec.yaml");
  });

  test("throws for an unknown spec on the live version", async () => {
    await expect(
      resolveSpecPath("backend", "nope.spec.yaml", LIVE_VERSION),
    ).rejects.toThrow(/spec file not found: backend[/\\]nope\.spec\.yaml/);
  });

  test("throws for an unknown published version", async () => {
    await expect(
      resolveSpecPath("backend", "routes.spec.yaml", "9.9.9"),
    ).rejects.toThrow(/unknown spec version: 9.9.9 \(published: 1\.0\.0\)/);
  });
});

describe("listSpecVersions", () => {
  test("live version plus every other published folder", async () => {
    await expect(listSpecVersions()).resolves.toEqual(["1.0.0"]);
    await expect(listPublishedVersions()).resolves.toEqual(["1.0.0"]);
  });
});

describe("published version completeness", () => {
  test("the live version ships every catalogued spec", async () => {
    for (const spec of SPEC_FILES) {
      await expect(
        resolveSpecPath(spec.subdir, spec.name, LIVE_VERSION),
      ).resolves.toContain(spec.name);
    }
  });

  test("every published version ships its spec set and engines.js", async () => {
    const published = await listPublishedVersions();
    expect(published.length).toBeGreaterThan(0);
    const versionsDir = await findAncestorPath("versions");
    expect(versionsDir).not.toBeNull();
    for (const version of published) {
      const archiveRoot = join(versionsDir!, version);
      for (const subdir of ["backend", "frontend"] as const) {
        const names = (await readdir(join(archiveRoot, subdir))).filter((f) =>
          f.endsWith(".spec.yaml"),
        );
        expect(names.length, `${version}/${subdir}`).toBeGreaterThan(0);
        for (const name of names) {
          await access(join(archiveRoot, subdir, name));
        }
      }
    }
  });

  test("the live version has a live validator engine", async () => {
    const engineDir = await findEngineDir(LIVE_VERSION);
    expect(engineDir).not.toBeNull();
    const js = join(engineDir!, VALIDATOR_ENGINE_FILE);
    const ts = js.replace(/\.js$/, ".ts");
    await expect(
      access(js).then(
        () => js,
        () => access(ts).then(() => ts),
      ),
    ).resolves.toMatch(/engines\.(js|ts)$/);
  });
});

describe("version discovery from an isolated tree", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "spec-versions-"));
    await mkdir(join(dir, "versions", "0.0.0"), { recursive: true });
    await mkdir(join(dir, "versions", "1.0.0"), { recursive: true });
    await mkdir(join(dir, "versions", "not-a-version"), { recursive: true });
    await writeFile(join(dir, "versions", "readme.txt"), "skip\n");
  });
  afterAll(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  test("lists only semver directories and reports a missing spec in a known version", async () => {
    await expect(listPublishedVersions(dir)).resolves.toEqual(["0.0.0", "1.0.0"]);
    await expect(listPublishedVersions(tmpdir())).resolves.toEqual([]);
    await expect(listSpecVersions(tmpdir())).resolves.toEqual([LIVE_VERSION]);
    await expect(
      resolveSpecPath("backend", "routes.spec.yaml", "1.0.0", dir),
    ).rejects.toThrow(
      /spec file not found: backend[/\\]routes\.spec\.yaml/,
    );
    await expect(
      resolveSpecPath("backend", "routes.spec.yaml", "0.0.0", dir),
    ).rejects.toThrow(
      /spec file not found: versions[/\\]0\.0\.0[/\\]backend[/\\]routes\.spec\.yaml/,
    );
    await expect(
      resolveSpecPath("backend", "routes.spec.yaml", "9.9.9", dir),
    ).rejects.toThrow(/unknown spec version: 9.9.9 \(published: 0\.0\.0, 1\.0\.0\)/);
    await expect(
      resolveSpecPath("backend", "routes.spec.yaml", "8.8.8", tmpdir()),
    ).rejects.toThrow(/unknown spec version: 8\.8\.8 \(published: none\)/);
  });
});

describe("engineRelPath / resolveEngineDir", () => {
  test("the live version is validator/validators/; any other semver is under versions/<semver>/validators/", () => {
    expect(engineRelPath(LIVE_VERSION)).toBe(
      join("validator", "validators"),
    );
    expect(engineRelPath("2.0.0")).toBe(join("versions", "2.0.0", "validators"));
  });

  test("resolves the live engine directory", async () => {
    await expect(findEngineDir(LIVE_VERSION)).resolves.toContain(
      join("validator", "validators"),
    );
    await expect(resolveEngineDir("1.0.0")).resolves.toContain(
      join("validator", "validators"),
    );
  });

  test("throws for an unknown published version", async () => {
    await expect(resolveEngineDir("9.9.9")).rejects.toThrow(
      /unknown spec version: 9.9.9/,
    );
    await expect(resolveEngineDir("8.8.8", tmpdir())).rejects.toThrow(
      /unknown spec version: 8\.8\.8 \(published: none\)/,
    );
  });

  test("throws when a known version has no validator engine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "engine-missing-"));
    try {
      await mkdir(join(dir, "versions", "1.0.0"), { recursive: true });
      await expect(resolveEngineDir("1.0.0", dir)).rejects.toThrow(
        /validator engine not found: validator[/\\]validators/,
      );
      await expect(resolveEngineDir("2.0.0", dir)).rejects.toThrow(
        /unknown spec version: 2\.0\.0/,
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("finds the live engine when only engines.ts exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "engine-ts-only-"));
    try {
      const validators = join(dir, "validator", "validators");
      const ts = join(validators, "engines.ts");
      await mkdir(validators, { recursive: true });
      await writeFile(ts, "export {}\n");
      await expect(findEngineDir(LIVE_VERSION, dir)).resolves.toBe(validators);
      await expect(resolveEngineModulePath(LIVE_VERSION, dir)).resolves.toBe(ts);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("prefers engines.js when present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "engine-js-preferred-"));
    try {
      const validators = join(dir, "validator", "validators");
      const js = join(validators, VALIDATOR_ENGINE_FILE);
      await mkdir(validators, { recursive: true });
      await writeFile(js, "export {}\n");
      await writeFile(join(validators, "engines.ts"), "export {}\n");
      await expect(resolveEngineModulePath(LIVE_VERSION, dir)).resolves.toBe(js);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("falls back to engines.js when no sibling .ts exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "engine-js-only-"));
    try {
      const js = join(dir, "versions", "2.0.0", "validators", VALIDATOR_ENGINE_FILE);
      await mkdir(join(dir, "versions", "2.0.0", "validators"), { recursive: true });
      await writeFile(js, "export {}\n");
      await expect(resolveEngineModulePath("2.0.0", dir)).resolves.toBe(js);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("runtime engines.js exports catalogued engines", async () => {
    const dir = await findEngineDir(LIVE_VERSION);
    const runtime = (await import(
      pathToFileURL(join(dir!, VALIDATOR_ENGINE_FILE)).href
    )) as Record<string, unknown>;
    expect(typeof runtime.TypesValidator).toBe("function");
    expect(typeof runtime.DatasourceSeedsValidator).toBe("function");
    expect(typeof runtime.RoutesApiValidator).toBe("function");
  });
});
