import { describe, expect, test } from "vitest";
import {
  checkIncludeFilters,
  parseIncludeFilter,
} from "./includeFilter.ts";
import { parseYamlWithPositions } from "./yamlPositions.ts";
import { TypesValidator } from "./VersionedValidator.ts";
import { RoutesValidator } from "./VersionedValidator.ts";
import { ServicesValidator } from "./VersionedValidator.ts";

describe("parseIncludeFilter", () => {
  test.each([
    'type != "link"',
    'type == "person" || tag == "datasource_type"',
    'tag == "view_type"',
    'tag != "many_to_many"',
    'inherits == "set"',
    'inherits != "dictionary"',
    '(type == "person" && inherits == "set")',
    'tag == "datasource_type" || tag == "view_type"',
    'type == "say \\"hi\\""',
  ])("accepts %s", (expr) => {
    expect(parseIncludeFilter(expr)).toEqual({ ok: true });
  });

  test.each([
    ["type is datasource_type", "expected == or != after type"],
    ['foo == "bar"', "unexpected identifier 'foo'"],
    ["type == person", "unquoted 'person'"],
    ["type", "expected == or != after type"],
    ["type ==", "expected a quoted string after type"],
    ["", "unexpected end of filter"],
    ["@@@", "unexpected character '@'"],
    ['type == "unterminated', "unterminated string literal"],
    ['type == "person" extra', "unexpected identifier 'extra'"],
    ['(tag == "datasource_type"', "expected ')'"],
    ['"person"', 'unexpected string "person"'],
    ["&&", "unexpected '&&'"],
    ["inherits ==", "expected a quoted string after inherits"],
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
  - types:
      filter: type == person
`);
    const result = checkIncludeFilters({ doc, lineCounter, data: doc.toJS() });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.instancePath).toBe("/includes/0/types/filter");
  });
});

describe("validators reject a bad include filter", () => {
  test("TypesValidator", async () => {
    const result = await new TypesValidator().validate(`version: 1.0.0
includes:
  - types:
      filter: type == person
types: []
`);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/invalid include filter/);
  });

  test("RoutesValidator", async () => {
    const result = await new RoutesValidator().validate(`version: 1.0.0
includes:
  - types:
      filter: type inherits set
routes: []
`);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/invalid include filter/);
  });

  test("ServicesValidator", async () => {
    const result = await new ServicesValidator().validate(`version: 1.0.0
includes:
  - types:
      filter: type is service
services: []
`);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/invalid include filter/);
  });
});
