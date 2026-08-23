import { describe, expect, test } from "vitest";
import { TypesValidator } from "./VersionedValidator.ts";
import { checkTypeModel } from "./typeModelSemantics.ts";
import { parseYamlWithPositions } from "./yamlPositions.ts";
import type { ParsedYaml } from "./SpecValidator.ts";

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
  });
});
