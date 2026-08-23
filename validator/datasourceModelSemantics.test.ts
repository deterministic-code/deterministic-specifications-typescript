import { describe, expect, test } from "vitest";
import { DatasourceValidator } from "./VersionedValidator.ts";
import { checkDatasourceModel } from "./datasourceModelSemantics.ts";
import { parseYamlWithPositions } from "./yamlPositions.ts";
import type { ParsedYaml } from "./SpecValidator.ts";

function parsed(text: string): ParsedYaml {
  const { doc, lineCounter } = parseYamlWithPositions(text);
  return { doc, lineCounter, data: doc.toJS() };
}

const validator = () => new DatasourceValidator();

function doc(body: string): string {
  return `version: 1.0.0\n${body}`;
}

describe("datasource model semantics", () => {
  test("rejects duplicate type, field, and index names", async () => {
    const result = await validator().validate(doc(`types:
  - user:
      fields:
        - email:
            is_unique: true
        - email:
            is_unique: true
      indexes:
        - email_idx:
            fields: [email]
            is_unique: true
        - email_idx:
            fields: [email]
            is_unique: false
  - user:
      fields:
        - name:
            is_unique: true
`));
    expect(result.valid).toBe(false);
    const messages = result.errors.map((e) => e.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        "duplicate type 'user'",
        "duplicate field 'email' on user",
        "duplicate index 'email_idx' on user",
      ]),
    );
  });

  test("rejects is_fixed_id without is_readonly", async () => {
    const result = await validator().validate(doc(`types:
  - item:
      fields:
        - key:
            is_fixed_id: true
`));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/is_fixed_id.*is_readonly/);
  });

  test("accepts is_fixed_id with is_readonly", async () => {
    const result = await validator().validate(doc(`types:
  - item:
      fields:
        - key:
            is_fixed_id: true
            is_readonly: true
`));
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("rejects an index column that is not on the table", async () => {
    const result = await validator().validate(doc(`types:
  - user:
      fields:
        - email:
            is_unique: true
      indexes:
        - missing_idx:
            fields: [nope]
            is_unique: false
`));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/unknown field 'nope'/);
  });

  test("companion types.yaml rejects an unknown table and field", () => {
    const result = checkDatasourceModel(
      parsed(`version: 1.0.0
types:
  - ghost:
      fields:
        - extra:
            is_unique: true
`),
      {
        types: [
          { user: { inherits: "set", fields: [{ email: { type: "string" } }] } },
        ],
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /not in types.yaml/.test(e.message))).toBe(
      true,
    );
  });

  test("accepts an empty table overlay", async () => {
    expect(await validator().validate(doc("types:\n  - note: {}\n"))).toEqual({
      valid: true,
      errors: [],
    });
  });

  test("model checks skip missing entries", () => {
    expect(checkDatasourceModel(parsed("version: 1.0.0\n")).valid).toBe(true);
    expect(
      checkDatasourceModel(parsed("version: 1.0.0\ntypes:\n  - []\n  - {}\n"))
        .valid,
    ).toBe(true);
  });
});
