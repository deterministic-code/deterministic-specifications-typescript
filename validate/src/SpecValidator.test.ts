import { describe, expect, test } from "vitest";
import { LIVE_VERSION, SpecValidator, resolveSpecPath } from "./index.ts";
import {
  errorFromUnknown,
  formatAjvError,
  resolveAjvCtor,
  yamlErrorOffset,
} from "./SpecValidator.ts";

const VALID = `version: 1.0.0
types:
  - user:
      fields:
        - id:
            type: integer
      target: StandardCrud
`;

describe("yamlErrorOffset / resolveAjvCtor / formatAjvError / errorFromUnknown", () => {
  class FakeAjv {
    opts: unknown;
    constructor(opts: unknown) {
      this.opts = opts;
    }
    compile(): () => boolean {
      return () => true;
    }
  }

  test("yamlErrorOffset uses the first pos entry or 0", () => {
    expect(yamlErrorOffset([12, 15])).toBe(12);
    expect(yamlErrorOffset(undefined)).toBe(0);
    expect(yamlErrorOffset(null)).toBe(0);
  });

  test("resolveAjvCtor prefers a default export, else the module itself", () => {
    expect(resolveAjvCtor({ default: FakeAjv })).toBe(FakeAjv);
    expect(resolveAjvCtor(FakeAjv)).toBe(FakeAjv);
  });

  test.each([
    [
      { keyword: "type", instancePath: "", message: "must be string" },
      "(root) must be string",
    ],
    [
      {
        keyword: "additionalProperties",
        instancePath: "/x",
        message: "must NOT have additional properties",
        params: { additionalProperty: "bogus" },
      },
      "/x must NOT have additional properties (property: bogus)",
    ],
    [
      {
        keyword: "required",
        instancePath: "/x",
        message: "must have required property 'fields'",
        params: { missingProperty: "fields" },
      },
      "/x must have required property 'fields' (missing: fields)",
    ],
    [
      {
        keyword: "enum",
        instancePath: "/x",
        message: "must be equal to one of the allowed values",
        params: { allowedValues: ["a", "b"] },
      },
      "/x must be equal to one of the allowed values (allowed: a, b)",
    ],
    [
      {
        keyword: "type",
        instancePath: "/x",
        message: "must be string",
        params: {},
      },
      "/x must be string",
    ],
    [
      {
        keyword: "additionalProperties",
        instancePath: "/x",
        message: "must NOT have additional properties",
        params: { additionalProperty: "" },
      },
      "/x must NOT have additional properties",
    ],
  ] as const)("formatAjvError %#", (error, expected) => {
    expect(formatAjvError(error)).toBe(expected);
  });

  test("errorFromUnknown uses Error.message or String() for other values", () => {
    expect(errorFromUnknown(new Error("boom"))).toBe("boom");
    expect(errorFromUnknown("nope")).toBe("nope");
  });
});

describe("SpecValidator constructed with an absolute spec path", () => {
  test("validates against that spec and reuses the compiled schema", async () => {
    const specPath = await resolveSpecPath(
      "backend",
      "datasource-types.spec.yaml",
      LIVE_VERSION,
    );
    const validator = new SpecValidator(specPath);
    const first = await validator.validate(VALID);
    const second = await validator.validate(VALID);
    expect(first).toEqual({ valid: true, errors: [] });
    expect(second).toEqual({ valid: true, errors: [] });
  });

  test("accepts a path thunk", async () => {
    const specPath = await resolveSpecPath(
      "backend",
      "datasource-types.spec.yaml",
      LIVE_VERSION,
    );
    const validator = new SpecValidator(async () => specPath);
    expect(await validator.validate(VALID)).toEqual({
      valid: true,
      errors: [],
    });
  });
});

describe("SpecValidator pinned to a version", () => {
  test("pinnedEngines returns a constructor per catalogued engine", async () => {
    const engines = SpecValidator.pinnedEngines(LIVE_VERSION);
    expect(Object.keys(engines)).toEqual([
      "DatasourceTypesValidator",
      "DatasourceSeedsValidator",
      "ViewTypesValidator",
      "RoutesValidator",
      "RoutesApiValidator",
      "ServicesValidator",
      "FrontendBindingsValidator",
    ]);
    const result = await new engines.DatasourceTypesValidator().validate(VALID);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("rejects a document for a different version", async () => {
    const result = await new SpecValidator({
      subdir: "backend",
      name: "datasource-types.spec.yaml",
      version: LIVE_VERSION,
    }).validate(VALID.replace("1.0.0", "2.0.0"));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/pinned to 1\.0\.0/);
  });

  test("surfaces a missing spec file as a version-path error", async () => {
    const result = await new SpecValidator({
      subdir: "backend",
      name: "does-not-exist.spec.yaml",
      version: "1.0.0",
    }).validate("version: 1.0.0\ntypes: []\n");
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/spec file not found/);
  });
});
