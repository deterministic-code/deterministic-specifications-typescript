import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import { resolveEngineModulePath, listSpecVersions } from "../resolveSpecPath.ts";
import type { SpecValidator } from "../SpecValidator.ts";
import {
  LIVE_VERSION,
  VALIDATOR_ENGINES,
} from "../specVersion.ts";

type Engines = Record<string, new () => SpecValidator>;

async function loadEngines(version: string): Promise<Engines> {
  return (await import(
    pathToFileURL(await resolveEngineModulePath(version)).href
  )) as Engines;
}

const yaml = (version: string, body: string) => `version: ${version}\n${body}`;

const VALID_BODY = `types:
  - user:
      fields:
        - id:
            type: integer
      target: StandardCrud
`;

const MINIMAL: Record<string, string> = {
  DatasourceSeedsValidator: "seeds: []\n",
  ViewTypesValidator: "types: []\n",
  ServicesValidator: "services: []\n",
  FrontendBindingsValidator: "datasources: []\n",
  RoutesValidator: "routes: []\n",
  RoutesApiValidator: "routes: []\ncomponents: {}\n",
};

const versions = await listSpecVersions();

describe.each(versions)("%s engines", (version) => {
  let engines: Engines;
  let datasource: SpecValidator;
  const other = version === LIVE_VERSION ? "2.0.0" : LIVE_VERSION;

  beforeAll(async () => {
    engines = await loadEngines(version);
    datasource = new engines.DatasourceTypesValidator();
  });

  test("accepts a valid datasource_types document", async () => {
    expect(await datasource.validate(yaml(version, VALID_BODY))).toEqual({
      valid: true,
      errors: [],
    });
  });

  test("rejects a document pinned to a different version", async () => {
    const result = await datasource.validate(yaml(other, VALID_BODY));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toContain(`pinned to ${version}`);
  });

  test("reports a positioned error for a missing top-level required key", async () => {
    const result = await datasource.validate("not_types: 1\n");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      line: expect.any(Number),
      col: expect.any(Number),
      message: expect.any(String),
    });
  });

  test("reports an unexpected-property error (additionalProperties)", async () => {
    const result = await datasource.validate(
      yaml(
        version,
        "types:\n  - user:\n      fields:\n        - id:\n            type: integer\n      bogus_key: 1\n",
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /bogus_key/.test(e.message))).toBe(true);
  });

  test("reports a missing required property (fields)", async () => {
    const result = await datasource.validate(
      yaml(version, "types:\n  - user:\n      target: None\n"),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /fields/.test(e.message))).toBe(true);
  });

  test("reports an enum (allowed-values) violation", async () => {
    const result = await datasource.validate(
      yaml(
        version,
        "types:\n  - user:\n      fields:\n        - id:\n            type: integer\n      datasource_type: nonsense\n",
      ),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => /readonly-lookup|many-to-many/.test(e.message)),
    ).toBe(true);
  });

  test("accepts unsigned integer-family field types", async () => {
    const result = await datasource.validate(
      yaml(
        version,
        `types:
  - sample:
      fields:
        - count:
            type: unsignedinteger
            default_value: 0
        - big_count:
            type: unsignedbiginteger
            default_value: "18446744073709551615"
        - small_count:
            type: unsignedsmallinteger
            min_size: 0
`,
      ),
    );
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("rejects a negative default_value on unsignedinteger", async () => {
    const result = await datasource.validate(
      yaml(
        version,
        `types:
  - sample:
      fields:
        - count:
            type: unsignedinteger
            default_value: -1
`,
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("reports a positioned error for a field-shape mismatch", async () => {
    const result = await datasource.validate(
      yaml(
        version,
        "types:\n  - user:\n      fields:\n        - id:\n            bogus_field_key: true\n",
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      instancePath: expect.any(String),
    });
  });

  test("reports a type mismatch (scalar where an array is required)", async () => {
    const result = await datasource.validate(yaml(version, "types: not-a-list\n"));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("an empty document is invalid", async () => {
    const result = await datasource.validate("");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("reports a positioned parse error for unterminated input", async () => {
    const result = await datasource.validate("foo: [unterminated\n");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      instancePath: "",
      message: expect.any(String),
      line: expect.any(Number),
      col: expect.any(Number),
    });
  });

  test("validateFile reads a valid file from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-validate-"));
    try {
      const path = join(dir, "valid.yaml");
      await writeFile(path, yaml(version, VALID_BODY));
      expect((await datasource.validateFile(path)).valid).toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("validateFile reports positioned errors for an invalid file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-validate-"));
    try {
      const path = join(dir, "invalid.yaml");
      await writeFile(path, "not_types: 1\n");
      const result = await datasource.validateFile(path);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("other spec validators accept a minimal document", async () => {
    for (const [className, body] of Object.entries(MINIMAL)) {
      if (typeof engines[className] !== "function") continue;
      expect(
        (await new engines[className]().validate(yaml(version, body))).valid,
      ).toBe(true);
    }
  });

  test("ViewTypesValidator rejects a union vs shaped mismatch", async () => {
    const result = await new engines.ViewTypesValidator().validate(
      yaml(version, "types:\n  - foo:\n      one_of: [a]\n      fields: []\n"),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("RoutesValidator rejects a nested route-shape mismatch", async () => {
    const result = await new engines.RoutesValidator().validate(
      yaml(
        version,
        "routes:\n  - custom_route:\n      methods: [GET]\n      path: /x\n      bogus: true\n",
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("every spec validator rejects an empty document", async () => {
    for (const [className] of VALIDATOR_ENGINES) {
      if (typeof engines[className] !== "function") continue;
      const result = await new engines[className]().validate("");
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});
