import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DatasourceValidator } from "./index.ts";
import {
  checkDatasourceModel,
  withSiblingTypes,
} from "./datasourceModelSemantics.ts";
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

  test("companion types.yaml rejects an overlay field missing from the type", () => {
    const result = checkDatasourceModel(
      parsed(`version: 1.0.0
types:
  - user:
      fields:
        - extra:
            is_unique: true
        - []
`),
      {
        types: [
          { user: { inherits: "set", fields: [{ email: { type: "string" } }] } },
        ],
      },
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => /unknown field 'extra' on user/.test(e.message)),
    ).toBe(true);
  });

  test("accepts an empty table overlay", async () => {
    expect(await validator().validate(doc("types:\n  - note: {}\n"))).toEqual({
      valid: true,
      errors: [],
    });
  });

  test("withSiblingTypes reads typesPath and ignores a missing sibling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ds-path-"));
    try {
      const typesPath = join(dir, "t.yaml");
      await writeFile(typesPath, "version: 1.0.0\ntypes: []\n");
      const fromPath = await withSiblingTypes(join(dir, "datasource.yaml"), {
        typesPath,
      });
      expect(fromPath.types).toContain("types: []");
      const missing = await withSiblingTypes(join(dir, "datasource.yaml"));
      expect(missing.types).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("validateFile loads a sibling types.yaml for index columns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ds-sibling-"));
    try {
      await writeFile(
        join(dir, "types.yaml"),
        `version: 1.0.0
types:
  - user:
      inherits: set
      fields:
        - score:
            type: integer
`,
      );
      const path = join(dir, "datasource.yaml");
      await writeFile(
        path,
        `version: 1.0.0
types:
  - user:
      indexes:
        - score_idx:
            fields: [score]
            is_unique: false
`,
      );
      expect((await validator().validateFile(path)).valid).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("collects a non-mapping table body and field body", () => {
    expect(
      checkDatasourceModel(
        parsed(`version: 1.0.0
types:
  - user: 1
  - note:
      fields:
        - email: 1
        - []
      indexes:
        - []
        - {}
        - ok:
            fields: [email]
            is_unique: false
`),
      ).valid,
    ).toBe(true);
  });

  test("indexes on a duplicate table still resolve the first overlay", () => {
    const result = checkDatasourceModel(
      parsed(`version: 1.0.0
types:
  - user:
      fields:
        - email:
            is_unique: true
  - user:
      indexes:
        - email_idx:
            fields: [email]
            is_unique: false
`),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /duplicate type/.test(e.message))).toBe(
      true,
    );
  });

  test("model checks skip missing entries", () => {
    expect(checkDatasourceModel(parsed("version: 1.0.0\n")).valid).toBe(true);
    expect(
      checkDatasourceModel(parsed("version: 1.0.0\ntypes:\n  - []\n  - {}\n"))
        .valid,
    ).toBe(true);
    expect(
      checkDatasourceModel(
        parsed(`version: 1.0.0
types:
  - user:
      indexes:
        - skip:
            fields: 1
        - mixed:
            fields: [1, email]
            is_unique: false
`),
      ).valid,
    ).toBe(false);
    expect(
      checkDatasourceModel(parsed("version: 1.0.0\n"), { types: [] }).valid,
    ).toBe(true);
    expect(
      checkDatasourceModel(
        parsed("version: 1.0.0\ntypes:\n  - []\n  - {}\n"),
        { types: [] },
      ).valid,
    ).toBe(true);
  });
});
