import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { describe, expect, test } from "vitest";
import {
  loadFieldTypeCatalog,
  parseFieldTypeCatalog,
} from "./fieldTypeCatalog.ts";
import { resolveSpecPath } from "./resolveSpecPath.ts";
import { LIVE_VERSION } from "./specVersion.ts";
import { SpecValidator } from "./SpecValidator.ts";

function schemaTypeNames(schema: {
  $defs?: Record<string, { properties?: { type?: { const?: string } } }>;
}): Set<string> {
  const names = new Set<string>(["reference"]);
  for (const [key, def] of Object.entries(schema.$defs ?? {})) {
    if (!key.endsWith("Field")) continue;
    const konst = def.properties?.type?.const;
    if (typeof konst === "string") names.add(konst);
  }
  return names;
}

describe("fieldTypeCatalog", () => {
  test("parses tokens, ranges, and types with no defaults", () => {
    const catalog = parseFieldTypeCatalog(`version: 1.0.0
types:
  - integer:
      min_value: "-2"
      max_value: "2"
      defaults:
        - Literal:
            regex: '^-?\\d+$'
            description: integer literal
  - reference:
      supports_size: false
`);
    expect(catalog.get("integer")).toMatchObject({
      name: "integer",
      min_value: "-2",
      max_value: "2",
      defaults: [{ token: "Literal", regex: "^-?\\d+$" }],
    });
    expect(catalog.get("reference")?.defaults).toEqual([]);
  });

  test("every spec field type has a types.yaml row and vice versa", async () => {
    const schema = parseDocument(
      await readFile(
        await resolveSpecPath("backend", "datasource-types.spec.yaml", LIVE_VERSION),
        "utf8",
      ),
    ).toJS() as Parameters<typeof schemaTypeNames>[0];
    const catalog = await loadFieldTypeCatalog(LIVE_VERSION);
    expect([...catalog.keys()].sort()).toEqual([...schemaTypeNames(schema)].sort());
  });

  test("skips malformed entries and optional catalog fields", () => {
    expect(parseFieldTypeCatalog("[]").size).toBe(0);
    expect(parseFieldTypeCatalog("types: nope\n").size).toBe(0);
    const catalog = parseFieldTypeCatalog(`version: 1.0.0
types: not-a-list
`);
    expect(catalog.size).toBe(0);
    const mixed = parseFieldTypeCatalog(`version: 1.0.0
types:
  - null
  - {}
  - integer: null
  - onlymin:
      min_value: null
      max_value: 3
  - integer:
      supports_size: yes
      min_value: 1
      max_value: null
      defaults:
        - {}
        - Literal: {}
        - Literal:
            regex: 1
        - Literal:
            regex: "^-?\\\\d+$"
            description: 4
  - bounded:
      supports_size: false
      min_value: "0"
      max_value: "9"
      implicit_default: 0
      defaults:
        - Literal:
            regex: "^\\\\d+$"
            description: digits
`);
    expect(mixed.has("")).toBe(false);
    expect(mixed.get("onlymin")).toMatchObject({
      min_value: null,
      max_value: undefined,
    });
    expect(mixed.get("integer")).toMatchObject({
      supports_size: undefined,
      min_value: undefined,
      max_value: null,
      defaults: [{ token: "Literal", regex: "^-?\\d+$", description: undefined }],
    });
    expect(mixed.get("bounded")?.defaults[0]?.description).toBe("digits");
  });

  test("loadFieldTypeCatalog throws when the version has no catalog file", async () => {
    await expect(loadFieldTypeCatalog("9.9.9")).rejects.toThrow(
      "field type catalog not found: backend/types.yaml (version 9.9.9)",
    );
  });

  test("types.yaml is valid against types.spec.yaml", async () => {
    const specPath = await resolveSpecPath("backend", "types.spec.yaml", LIVE_VERSION);
    const catalogPath = await resolveSpecPath("backend", "types.yaml", LIVE_VERSION);
    const result = await new SpecValidator(specPath).validate(
      await readFile(catalogPath, "utf8"),
    );
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("catalog token regexes match datasource-types.spec.yaml", async () => {
    const schema = parseDocument(
      await readFile(
        await resolveSpecPath("backend", "datasource-types.spec.yaml", LIVE_VERSION),
        "utf8",
      ),
    ).toJS() as {
      $defs: {
        datetimeDefault: { oneOf: Array<{ const?: string; pattern?: string }> };
        uuidDefault: { oneOf: Array<{ const?: string; pattern?: string }> };
        hexDefault: { pattern: string };
        signedIntegerString: { pattern: string };
        unsignedIntegerString: { pattern: string };
        decimalString: { pattern: string };
        characterField: { properties: { default_value: { pattern: string } } };
      };
    };
    const catalog = await loadFieldTypeCatalog(LIVE_VERSION);
    const token = (type: string, name: string) =>
      catalog.get(type)?.defaults.find((d) => d.token === name)?.regex;
    expect(token("datetime", "Now")).toBe("^Now$");
    expect(token("datetime", "UtcNow")).toBe("^UtcNow$");
    expect(token("datetime", "DateTime")).toBe(
      schema.$defs.datetimeDefault.oneOf[2]?.pattern,
    );
    expect(token("uuid", "Uuid")).toBe(schema.$defs.uuidDefault.oneOf[2]?.pattern);
    expect(token("binary", "Hex")).toBe(schema.$defs.hexDefault.pattern);
    expect(token("biginteger", "Literal")).toBe(
      schema.$defs.signedIntegerString.pattern,
    );
    expect(token("unsignedbiginteger", "Literal")).toBe(
      schema.$defs.unsignedIntegerString.pattern,
    );
    expect(token("decimal", "Literal")).toBe(schema.$defs.decimalString.pattern);
    expect(token("character", "Literal")).toBe(
      schema.$defs.characterField.properties.default_value.pattern,
    );
  });

  test("datetime and uuid expose the symbolic default tokens", async () => {
    const catalog = await loadFieldTypeCatalog(LIVE_VERSION);
    expect(catalog.get("datetime")?.defaults.map((d) => d.token)).toEqual([
      "Now",
      "UtcNow",
      "DateTime",
    ]);
    expect(catalog.get("uuid")?.defaults.map((d) => d.token)).toEqual([
      "NewId",
      "Empty",
      "Uuid",
    ]);
    expect(catalog.get("binary")?.defaults.map((d) => d.token)).toEqual(["Hex"]);
  });
});
