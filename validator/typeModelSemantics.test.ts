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
      remove_fields: [b.id]
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
      "id",
      "uuid",
      "created",
      "updated",
      "version",
      "contact_source_id",
      "first_name",
      "last_name",
      "email",
      "notes",
      "contact_source_name",
      "description",
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

  test("accepts qualified remove_fields on a contact inherit+union", () => {
    const result = checkTypeModel(
      parsed(`version: 1.0.0
types:
  - contacts_base:
      inherits: set
      fields:
        - email:
            type: string
  - contact_source:
      inherits: set
      fields:
        - name:
            type: string
  - contact:
      inherits: contacts_base
      union: [contact_source]
      mapping:
        name: contact_source_name
      remove_fields: [contact_source.id]
      fields: []
`),
    );
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("rejects qualified remove_fields that miss the inherit+union source", () => {
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
  - other:
      fields:
        - id:
            type: integer
  - contact:
      inherits: contacts_base
      union: [contact_source]
      remove_fields: [ghost.id, contacts_base.missing, missing, other.id]
      fields: []
`),
    );
    expect(result.valid).toBe(false);
    const messages = result.errors.map((e) => e.message);
    expect(messages.some((m) => /unknown type 'ghost' in remove_fields/.test(m))).toBe(
      true,
    );
    expect(
      messages.some((m) =>
        /remove_fields 'contacts_base.missing' is not a field on contacts_base/.test(
          m,
        ),
      ),
    ).toBe(true);
    expect(
      messages.some((m) =>
        /remove_fields 'missing' is not a field on the inherited or unioned shape/.test(
          m,
        ),
      ),
    ).toBe(true);
    expect(
      messages.some((m) =>
        /remove_fields 'other.id' is not from an inherit or union source/.test(m),
      ),
    ).toBe(true);
  });

  test("accepts extract and qualified mapping on a multi-union contact", () => {
    const doc = parsed(`version: 1.0.0
types:
  - contacts_base:
      inherits: set
      fields:
        - email:
            type: string
  - contact_source:
      inherits: set
      fields:
        - name:
            type: string
  - contact_type:
      inherits: set
      fields:
        - name:
            type: string
  - contact:
      inherits: contacts_base
      union: [contact_source, contact_type]
      extract: [contact_source.name, contact_type.name]
      mapping:
        contact_source.name: contact_source_name
        contact_type.name: contact_type_name
      fields: []
`);
    expect(checkTypeModel(doc)).toEqual({ valid: true, errors: [] });
    expect([...indexTypeFields(doc.data).get("contact")?.keys() ?? []]).toEqual([
      "id",
      "email",
      "contact_source_name",
      "contact_type_name",
    ]);
  });

  test("rejects a bare extract entry", () => {
    const result = checkTypeModel(
      parsed(`version: 1.0.0
types:
  - user:
      inherits: set
      fields:
        - email:
            type: string
  - person:
      inherits: user
      extract: [email]
      fields: []
`),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) =>
        /extract 'email' is not a field on the inherited or unioned shape/.test(
          e.message,
        ),
      ),
    ).toBe(true);
  });

  test("rejects extract that misses the inherit or union source", () => {
    const result = checkTypeModel(
      parsed(`version: 1.0.0
types:
  - contacts_base:
      inherits: set
      fields:
        - email:
            type: string
  - contact_source:
      inherits: set
      fields:
        - name:
            type: string
  - other:
      fields:
        - name:
            type: string
  - contact:
      inherits: contacts_base
      union: [contact_source]
      extract: [ghost.name, contacts_base.missing, other.name, contact_source.missing]
      fields: []
`),
    );
    expect(result.valid).toBe(false);
    const messages = result.errors.map((e) => e.message);
    expect(messages.some((m) => /unknown type 'ghost' in extract/.test(m))).toBe(
      true,
    );
    expect(
      messages.some((m) =>
        /extract 'contacts_base.missing' is not a field on contacts_base/.test(m),
      ),
    ).toBe(true);
    expect(
      messages.some((m) =>
        /extract 'other.name' is not from an inherit or union source/.test(m),
      ),
    ).toBe(true);
    expect(
      messages.some((m) =>
        /extract 'contact_source.missing' is not a field on contact_source/.test(m),
      ),
    ).toBe(true);
  });

  test("rejects a bare mapping that matches more than one source", () => {
    const result = checkTypeModel(
      parsed(`version: 1.0.0
types:
  - contact_source:
      inherits: set
      fields:
        - name:
            type: string
  - contact_type:
      inherits: set
      fields:
        - name:
            type: string
  - contact:
      union: [contact_source, contact_type]
      mapping:
        name: contact_name
      fields: []
`),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) =>
        /mapping 'name' matches more than one source/.test(e.message),
      ),
    ).toBe(true);
  });

  test("rejects duplicate field names on the composed shape", () => {
    const result = checkTypeModel(
      parsed(`version: 1.0.0
types:
  - contact_source:
      inherits: set
      fields:
        - name:
            type: string
  - contact_type:
      inherits: set
      fields:
        - name:
            type: string
  - contact:
      union: [contact_source, contact_type]
      fields: []
`),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) =>
        /duplicate field 'id' on the composed shape of contact/.test(e.message),
      ),
    ).toBe(true);
    expect(
      result.errors.some((e) =>
        /duplicate field 'name' on the composed shape of contact/.test(e.message),
      ),
    ).toBe(true);
  });

  test("rejects unknown union members", () => {
    const result = checkTypeModel(
      parsed(`version: 1.0.0
types:
  - mix:
      union: [person, empty]
      fields: []
`),
    );
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
