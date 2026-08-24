import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { TypesValidator } from "./index.ts";
import { checkTypeModel, indexTypeFields } from "./typeModelSemantics.ts";
import { parseYamlWithPositions } from "./yamlPositions.ts";
import type { ParsedYaml } from "./SpecValidator.ts";

const CONTACTS_TYPES = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "test/fixtures/contacts.types.yaml"),
  "utf8",
);

function parsed(text: string): ParsedYaml {
  const { doc, lineCounter } = parseYamlWithPositions(text);
  return { doc, lineCounter, data: doc.toJS() };
}

const validator = () => new TypesValidator();

function doc(body: string): string {
  return `version: 1.0.0\n${body}`;
}

describe("type model semantics", () => {
  test("rejects duplicate type and field names", async () => {
    const result = await validator().validate(doc(`types:
  - user:
      fields:
        - email:
            type: string
        - email:
            type: string
  - user:
      fields:
        - name:
            type: string
`));
    expect(result.valid).toBe(false);
    const messages = result.errors.map((e) => e.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        "duplicate type 'user'",
        "duplicate field 'email' on user",
      ]),
    );
  });

  test("rejects a circular union and a built-in reference miss", () => {
    const result = checkTypeModel(
      parsed(`version: 1.0.0
types:
  - a:
      union: [b]
      fields:
        - ref:
            references: set.missing
  - b:
      union: [a]
      fields:
        - loop:
            references: a.ghost
        - broken:
            references: "."
`),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /circular inherit/.test(e.message))).toBe(
      true,
    );
    expect(result.errors.some((e) => /set/.test(e.message))).toBe(true);
  });

  test("skips a type whose body is not a mapping", () => {
    expect(
      checkTypeModel(parsed("version: 1.0.0\ntypes:\n  - user: 1\n")).valid,
    ).toBe(true);
  });

  test("rejects a circular inherit chain", async () => {
    const result = await validator().validate(doc(`types:
  - a:
      inherits: b
      fields: []
  - b:
      inherits: a
      fields: []
`));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /circular inherit/.test(e.message))).toBe(
      true,
    );
  });

  test("rejects an unknown inherit target", async () => {
    const result = await validator().validate(doc(`types:
  - person:
      inherits: missing
      fields: []
`));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/unknown inherit target 'missing'/);
  });

  test("accepts inherits set and dictionary", async () => {
    const result = await validator().validate(doc(`types:
  - user:
      inherits: set
      fields:
        - email:
            type: string
  - role:
      inherits: dictionary
      fields:
        - code:
            type: string
`));
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("rejects mapping and remove_fields that are not on the parent", async () => {
    const result = await validator().validate(doc(`types:
  - user:
      inherits: set
      mapping:
        nope: other
      remove_fields: [ghost]
      fields: []
`));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /mapping 'nope'/.test(e.message))).toBe(
      true,
    );
    expect(result.errors.some((e) => /remove_fields 'ghost'/.test(e.message))).toBe(
      true,
    );
  });

  test("accepts the contacts inherit+union view", () => {
    const doc = parsed(CONTACTS_TYPES);
    expect(checkTypeModel(doc)).toEqual({ valid: true, errors: [] });
    const fields = indexTypeFields(doc.data).get("contact");
    expect([...fields?.keys() ?? []]).toEqual([
      "contact_source_id",
      "first_name",
      "last_name",
      "email",
      "notes",
      "description",
      "contact_source_name",
      "addresses",
      "phones",
    ]);
  });

  test("rejects mapping and remove_fields that miss the composed inherit+union shape", () => {
    const result = checkTypeModel(
      parsed(`version: 1.0.0
types:
  - contacts_base:
      inherits: set
      fields:
        - email:
            type: string
  - contact_source:
      fields:
        - name:
            type: string
  - contact:
      inherits: contacts_base
      union: [contact_source]
      mapping:
        ghost: other
      remove_fields: [missing]
      fields: []
`),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /mapping 'ghost'/.test(e.message))).toBe(
      true,
    );
    expect(result.errors.some((e) => /remove_fields 'missing'/.test(e.message))).toBe(
      true,
    );
  });

  test("rejects unknown union and one_of members", async () => {
    const result = await validator().validate(doc(`types:
  - result:
      one_of: [person, empty]
  - mix:
      union: [person, empty]
      fields: []
`));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /unknown type 'person'/.test(e.message))).toBe(
      true,
    );
  });

  test("rejects unknown references and composite targets", async () => {
    const result = await validator().validate(doc(`types:
  - link:
      fields:
        - left_id:
            references: user.id
        - pair:
            references: [link.left_id, link.right_id]
`));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /unknown type 'user'/.test(e.message))).toBe(
      true,
    );
    expect(result.errors.some((e) => /right_id/.test(e.message))).toBe(true);
  });

  test("rejects two is_id fields and ids mixed with is_id", async () => {
    const two = await validator().validate(doc(`types:
  - person:
      inherits: set
      fields:
        - id:
            type: integer
            is_id: true
        - i2:
            type: integer
            is_id: true
`));
    expect(two.valid).toBe(false);
    expect(two.errors.some((e) => /at most one/.test(e.message))).toBe(true);

    const mixed = checkTypeModel(
      parsed(`version: 1.0.0
types:
  - link:
      ids: [left_id, right_id]
      fields:
        - left_id:
            type: integer
            is_id: true
        - right_id:
            type: integer
`),
    );
    expect(mixed.valid).toBe(false);
    expect(mixed.errors.some((e) => /mutually exclusive/.test(e.message))).toBe(
      true,
    );
  });

  test("does not treat injected id as present when a set authors identity", async () => {
    const byId = await validator().validate(doc(`types:
  - person:
      inherits: set
      fields:
        - code:
            type: integer
            is_id: true
      remove_fields: [id]
`));
    expect(byId.valid).toBe(false);
    expect(byId.errors.some((e) => /remove_fields 'id'/.test(e.message))).toBe(
      true,
    );

    const byIds = await validator().validate(doc(`types:
  - link:
      inherits: set
      ids: [left_id, right_id]
      fields:
        - left_id:
            type: integer
        - right_id:
            type: integer
      remove_fields: [id]
`));
    expect(byIds.valid).toBe(false);
    expect(byIds.errors.some((e) => /remove_fields 'id'/.test(e.message))).toBe(
      true,
    );
  });

  test("rejects ids that are not fields on the type", async () => {
    const result = await validator().validate(doc(`types:
  - link:
      ids: [left_id, ghost]
      fields:
        - left_id:
            type: integer
        - right_id:
            type: integer
`));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/ids 'ghost' is not a field/);
  });

  test("rejects decimal scale greater than precision", async () => {
    const result = await validator().validate(doc(`types:
  - item:
      fields:
        - price:
            type: decimal
            size: [2, 4]
`));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/scale must be <= precision/);
  });

  test("model checks skip missing entries", () => {
    expect(checkTypeModel(parsed("version: 1.0.0\n")).valid).toBe(true);
    expect(
      checkTypeModel(parsed("version: 1.0.0\ntypes:\n  - []\n  - {}\n")).valid,
    ).toBe(true);
    const skipped = checkTypeModel(
      parsed(`version: 1.0.0
types:
  - role:
      fields: []
  - user:
      mapping:
        id: 1
      fields:
        - []
        - email:
            type: decimal
            size: [1, true]
            references: 1
        - role:
            type: role
            references: [1]
        - skip:
            type: integer
            is_id: false
      ids: [1, email]
`),
    );
    expect(skipped.valid).toBe(true);
  });
});
