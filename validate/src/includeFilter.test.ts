import { describe, expect, test } from "vitest";
import {
  checkIncludeFilters,
  parseIncludeFilter,
} from "./includeFilter.ts";
import { parseYamlWithPositions } from "./yamlPositions.ts";
import { ViewTypesValidator } from "./VersionedValidator.ts";
import { RoutesValidator } from "./VersionedValidator.ts";
import { ServicesValidator } from "./VersionedValidator.ts";

describe("parseIncludeFilter", () => {
  test.each([
    'type != "link"',
    'type == "person" || inherits == datasource_types',
    "type is datasource_type",
    "type is not view_type",
    "inherits == datasource_types",
    'inherits != "datasource_types"',
    '(type == "person" && inherits == datasource_types)',
    'type is datasource_type || inherits == datasource_types',
    'type == "say \\"hi\\""',
  ])("accepts %s", (expr) => {
    expect(parseIncludeFilter(expr)).toEqual({ ok: true });
  });

  test.each([
    ["type is service", "type is must be datasource_type or view_type"],
    ["type is route", "type is must be datasource_type or view_type"],
    [
      "type inherits datasource_types",
      "use inherits == datasource_types (not 'type inherits')",
    ],
    ['foo == "bar"', "unexpected identifier 'foo'"],
    ["type == person", "unquoted 'person'"],
    ["type", "expected == or != after type"],
    ["type ==", "expected a value after type"],
    ["", "unexpected end of filter"],
    ["@@@", "unexpected character '@'"],
    ['type == "unterminated', "unterminated string literal"],
    ['type == "person" extra', "unexpected identifier 'extra'"],
    ["(type is datasource_type", "expected ')'"],
    ['"person"', 'unexpected string "person"'],
    ["&&", "unexpected '&&'"],
    ["type is", "type is must be datasource_type or view_type"],
    ["inherits ==", "expected a value after inherits"],
    ["type is not", "type is must be datasource_type or view_type"],
    ['type == "person" )', "unexpected ')'"],
    ['type == "person" || type', "expected == or != after type"],
    ['type == "person" && type', "expected == or != after type"],
    ["(type)", "expected == or != after type"],
  ])("rejects %s", (expr, needle) => {
    const result = parseIncludeFilter(expr);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(needle);
  });
});

describe("checkIncludeFilters", () => {
  test("accepts a document with no includes", () => {
    const { doc, lineCounter } = parseYamlWithPositions("version: 1.0.0\n");
    expect(
      checkIncludeFilters({ doc, lineCounter, data: doc.toJS() }),
    ).toEqual({ valid: true, errors: [] });
  });

  test("skips include entries that are not mappings", () => {
    const { doc, lineCounter } = parseYamlWithPositions(`version: 1.0.0
includes:
  - []
  - 1
`);
    expect(
      checkIncludeFilters({ doc, lineCounter, data: doc.toJS() }),
    ).toEqual({ valid: true, errors: [] });
  });

  test("reports a bad filter with an instance path", () => {
    const { doc, lineCounter } = parseYamlWithPositions(`version: 1.0.0
includes:
  - datasource_types:
      include: "*"
      filter: type is service
`);
    const result = checkIncludeFilters({ doc, lineCounter, data: doc.toJS() });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.instancePath).toBe(
      "/includes/0/datasource_types/filter",
    );
  });
});

describe("validators reject a bad include filter", () => {
  test("ViewTypesValidator", async () => {
    const result = await new ViewTypesValidator().validate(`version: 1.0.0
includes:
  - datasource_types:
      include: "*"
      filter: type is route
types: []
`);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/invalid include filter/);
  });

  test("RoutesValidator", async () => {
    const result = await new RoutesValidator().validate(`version: 1.0.0
includes:
  - view_type_routes:
      filter: type inherits datasource_types
routes: []
`);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/inherits == datasource_types/);
  });

  test("ServicesValidator", async () => {
    const result = await new ServicesValidator().validate(`version: 1.0.0
includes:
  - view_type_services:
      filter: type is service
services: []
`);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/datasource_type or view_type/);
  });
});
