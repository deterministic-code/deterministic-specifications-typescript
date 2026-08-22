import { describe, expect, test } from "vitest";
import { DatasourceTypesValidator } from "./VersionedValidator.ts";
import { checkDatasourceModel } from "./datasourceModelSemantics.ts";
import { parseYamlWithPositions } from "./yamlPositions.ts";
import type { ParsedYaml } from "./SpecValidator.ts";

function parsed(text: string): ParsedYaml {
  const { doc, lineCounter } = parseYamlWithPositions(text);
  return { doc, lineCounter, data: doc.toJS() };
}

const validator = () => new DatasourceTypesValidator();

function doc(body: string): string {
  return `version: 1.0.0\n${body}`;
}

describe("datasource model semantics", () => {
  test("rejects duplicate type, field, and index names", async () => {
    const result = await validator().validate(doc(`types:
  - user:
      fields:
        - email:
            type: string
            size: 8
        - email:
            type: string
            size: 8
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
            type: string
            size: 8
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

  test("rejects several primary_key fields", async () => {
    const result = await validator().validate(doc(`types:
  - item:
      target: Crud
      fields:
        - a:
            type: integer
            primary_key: true
        - b:
            type: integer
            primary_key: true
`));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/more than one primary_key/);
  });

  test("rejects StandardCrud with an authored primary_key", async () => {
    const result = await validator().validate(doc(`types:
  - user:
      target: StandardCrud
      fields:
        - email:
            type: string
            size: 8
            primary_key: true
`));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(
      /StandardCrud cannot declare primary_key/,
    );
  });

  test("rejects Crud with no primary_key", async () => {
    const result = await validator().validate(doc(`types:
  - link:
      target: Crud
      fields:
        - left_id:
            type: integer
`));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(
      /Crud requires exactly one primary_key/,
    );
  });

  test("accepts Crud with one primary_key and StandardCrud without", async () => {
    const result = await validator().validate(doc(`types:
  - user:
      fields:
        - email:
            type: string
            size: 8
  - link:
      target: Crud
      fields:
        - left_id:
            type: integer
            primary_key: true
            references: user.id
`));
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("rejects references to an unknown type or column", async () => {
    const missingType = await validator().validate(doc(`types:
  - task:
      fields:
        - owner_id:
            type: integer
            references: user.id
`));
    expect(missingType.valid).toBe(false);
    expect(missingType.errors[0]?.message).toBe(
      "unknown type 'user' in references",
    );

    const missingCol = await validator().validate(doc(`types:
  - user:
      fields:
        - email:
            type: string
            size: 8
  - task:
      fields:
        - owner_id:
            type: integer
            references: user.nope
`));
    expect(missingCol.valid).toBe(false);
    expect(missingCol.errors[0]?.message).toBe(
      "unknown field 'nope' on user in references",
    );
  });

  test("rejects index fields that are not on the table", async () => {
    const result = await validator().validate(doc(`types:
  - user:
      fields:
        - email:
            type: string
            size: 8
      indexes:
        - missing_idx:
            fields: [nope]
            is_unique: false
`));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toBe(
      "unknown field 'nope' on user in index 'missing_idx'",
    );
  });

  test("rejects decimal size [0, 0] and scale greater than precision", async () => {
    const zero = await validator().validate(doc(`types:
  - item:
      fields:
        - price:
            type: decimal
            size: [0, 0]
`));
    expect(zero.valid).toBe(false);

    const scale = await validator().validate(doc(`types:
  - item:
      fields:
        - price:
            type: decimal
            size: [2, 5]
`));
    expect(scale.valid).toBe(false);
    expect(scale.errors[0]?.message).toBe(
      "decimal size scale must be <= precision (2)",
    );
  });

  test("rejects a character default whose length does not match size", async () => {
    const result = await validator().validate(doc(`types:
  - item:
      fields:
        - code:
            type: character
            size: 4
            default_value: X
`));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toBe(
      "character default_value length must equal size (4)",
    );
  });

  test("accepts a character default whose length equals size", async () => {
    const result = await validator().validate(doc(`types:
  - item:
      fields:
        - code:
            type: character
            size: 4
            default_value: ABCD
`));
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("accepts an index on the implicit id column", async () => {
    const result = await validator().validate(doc(`types:
  - user:
      fields:
        - email:
            type: string
            size: 8
      indexes:
        - id_idx:
            fields: [id]
            is_unique: true
`));
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("skips malformed entries when called directly", () => {
    const result = checkDatasourceModel(
      parsed(`version: 1.0.0
types: not-a-list
`),
    );
    expect(result).toEqual({ valid: true, errors: [] });

    const messy = checkDatasourceModel(
      parsed(`version: 1.0.0
types:
  - []
  - {}
  - user: not-a-map
  - keyed:
      target: StandardCrud
      fields:
        - id:
            type: integer
  - note:
      target: None
      fields: nope
  - item:
      fields:
        - []
        - {}
        - price:
            type: decimal
            size: [10]
        - amount:
            type: decimal
            size: [0, "2"]
        - other:
            type: integer
            references: 1
        - parent_id:
            type: integer
            references: "."
      indexes:
        - []
        - {}
        - ok:
            fields: nope
        - mixed:
            fields: [1]
`),
    );
    expect(messy.valid).toBe(true);
  });

  test("reports precision < 1 when schema is bypassed", () => {
    const result = checkDatasourceModel(
      parsed(`version: 1.0.0
types:
  - item:
      fields:
        - price:
            type: decimal
            size: [0, 0]
`),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.message)).toEqual(
      expect.arrayContaining(["decimal size precision must be >= 1"]),
    );
  });
});
