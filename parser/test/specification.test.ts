import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  expandTypes,
  inheritedIdType,
  parseFieldType,
  primaryKeyColumn,
  resolvedProjectIdType,
  uniqueLookupFields,
  type Type,
} from "../specification.ts";

const shaped = (
  name: string,
  fields: Type["fields"],
  extra: Partial<Type> = {},
): Type => ({
  name,
  tags: extra.tags ?? ["datasource_type"],
  kind: extra.kind ?? "shaped",
  fields,
  ...extra,
});

describe("specification helpers", () => {
  it("parses primitive and type-name field types", () => {
    assert.deepEqual(parseFieldType("string"), {
      kind: "primitive",
      base: "string",
      isArray: false,
    });
    assert.deepEqual(parseFieldType("role[]"), {
      kind: "type",
      base: "role",
      isArray: true,
    });
    assert.deepEqual(parseFieldType("user_summary"), {
      kind: "type",
      base: "user_summary",
      isArray: false,
    });
  });

  it("falls back to integer for an unknown project id type", () => {
    assert.equal(resolvedProjectIdType("integer"), "integer");
    assert.equal(resolvedProjectIdType("float"), "integer");
  });

  it("defaults primaryKeyColumn to id", () => {
    assert.equal(primaryKeyColumn(undefined), "id");
    assert.equal(
      primaryKeyColumn(undefined, shaped("user", [], { inherits: "set" })),
      "id",
    );
  });

  it("falls back to id when a type has no identity", () => {
    assert.equal(
      primaryKeyColumn(
        undefined,
        shaped("note", [
          {
            name: "body",
            type: "string",
            kind: "primitive",
            base: "string",
            isArray: false,
            isNullable: false,
          },
        ]),
      ),
      "id",
    );
  });

  it("takes primaryKeyColumn from is_id or ids", () => {
    assert.equal(
      primaryKeyColumn(
        undefined,
        shaped(
          "person",
          [
            {
              name: "code",
              type: "integer",
              kind: "primitive",
              base: "integer",
              isArray: false,
              isNullable: false,
              isId: true,
            },
          ],
          { inherits: "set" },
        ),
      ),
      "code",
    );
    assert.equal(
      primaryKeyColumn(
        undefined,
        shaped(
          "link",
          [
            {
              name: "left_id",
              type: "integer",
              kind: "primitive",
              base: "integer",
              isArray: false,
              isNullable: false,
            },
            {
              name: "right_id",
              type: "integer",
              kind: "primitive",
              base: "integer",
              isArray: false,
              isNullable: false,
            },
          ],
          { ids: ["left_id", "right_id"] },
        ),
      ),
      "left_id",
    );
  });

  it("includes authored identity fields in unique lookups", () => {
    const type = shaped(
      "person",
      [
        {
          name: "code",
          type: "integer",
          kind: "primitive",
          base: "integer",
          isArray: false,
          isNullable: false,
          isId: true,
        },
        {
          name: "email",
          type: "string",
          kind: "primitive",
          base: "string",
          isArray: false,
          isNullable: false,
          size: 256,
        },
      ],
      { inherits: "set" },
    );
    assert.deepEqual(
      uniqueLookupFields(type, {
        name: "person",
        fields: [{ name: "email", isUnique: true }],
        indexes: [],
        uniqueIndexFields: [],
      }),
      [
        { field: "code", type: "integer" },
        { field: "email", type: "string", size: 256 },
      ],
    );
  });

  it("collects unique lookup fields from the datasource overlay", () => {
    const type = shaped("user", [
      {
        name: "email",
        type: "string",
        kind: "primitive",
        base: "string",
        isArray: false,
        isNullable: false,
        size: 256,
      },
      {
        name: "code",
        type: "string",
        kind: "primitive",
        base: "string",
        isArray: false,
        isNullable: false,
      },
    ]);
    assert.deepEqual(
      uniqueLookupFields(type, {
        name: "user",
        fields: [{ name: "email", isUnique: true }],
        indexes: [],
        uniqueIndexFields: ["code"],
      }),
      [
        { field: "email", type: "string", size: 256 },
        { field: "code", type: "string" },
      ],
    );
  });

  it("skips a duplicate lookup field and defaults type when the field is missing", () => {
    const type = shaped("user", [
      {
        name: "email",
        type: "string",
        kind: "primitive",
        base: "string",
        isArray: false,
        isNullable: false,
        size: 256,
      },
    ]);
    assert.deepEqual(
      uniqueLookupFields(type, {
        name: "user",
        fields: [
          { name: "email", isUnique: true },
          { name: "missing", isUnique: true },
        ],
        indexes: [],
        uniqueIndexFields: ["email"],
      }),
      [
        { field: "email", type: "string", size: 256 },
        { field: "missing", type: "string" },
      ],
    );
  });

  it("expands a union with no member list", () => {
    const expanded = expandTypes(
      [shaped("combo", [], { kind: "union" })],
      "integer",
    );
    assert.deepEqual(expanded[0]?.fields, []);
  });

  it("expands a union of unknown members to local fields only", () => {
    const expanded = expandTypes(
      [
        shaped("combo", [], {
          kind: "union",
          union: ["ghost"],
          fields: [
            {
              name: "extra",
              type: "string",
              kind: "primitive",
              base: "string",
              isArray: false,
              isNullable: false,
            },
          ],
        }),
      ],
      "integer",
    );
    assert.deepEqual(
      expanded[0]?.fields.map((f) => f.name),
      ["extra"],
    );
  });

  it("maps an unknown inherited id type to number", () => {
    assert.equal(inheritedIdType("integer"), "integer");
    assert.equal(inheritedIdType("float"), "number");
  });

  it("expands set/dictionary inherit, mapping, and remove_fields", () => {
    const expanded = expandTypes(
      [
        shaped(
          "user",
          [
            {
              name: "email",
              type: "string",
              kind: "primitive",
              base: "string",
              isArray: false,
              isNullable: false,
            },
            {
              name: "bio",
              type: "string",
              kind: "primitive",
              base: "string",
              isArray: false,
              isNullable: true,
            },
          ],
          { kind: "inherit", inherits: "set" },
        ),
        shaped(
          "person",
          [
            {
              name: "display_name",
              type: "string",
              kind: "primitive",
              base: "string",
              isArray: false,
              isNullable: false,
            },
          ],
          {
            kind: "inherit",
            inherits: "user",
            tags: ["view_type"],
            removeFields: ["bio"],
          },
        ),
      ],
      "integer",
    );
    assert.deepEqual(
      expanded[0]?.fields.map((f) => f.name),
      ["id", "email", "bio"],
    );
    assert.deepEqual(
      expanded[1]?.fields.map((f) => f.name),
      ["id", "email", "display_name"],
    );
  });

  it("does not inject id when a set authors is_id or ids", () => {
    const expanded = expandTypes(
      [
        shaped(
          "person",
          [
            {
              name: "code",
              type: "integer",
              kind: "primitive",
              base: "integer",
              isArray: false,
              isNullable: false,
              isId: true,
            },
            {
              name: "email",
              type: "string",
              kind: "primitive",
              base: "string",
              isArray: false,
              isNullable: false,
            },
          ],
          { kind: "inherit", inherits: "set" },
        ),
        shaped(
          "link",
          [
            {
              name: "left_id",
              type: "integer",
              kind: "primitive",
              base: "integer",
              isArray: false,
              isNullable: false,
            },
            {
              name: "right_id",
              type: "integer",
              kind: "primitive",
              base: "integer",
              isArray: false,
              isNullable: false,
            },
          ],
          { kind: "inherit", inherits: "set", ids: ["left_id", "right_id"] },
        ),
      ],
      "integer",
    );
    assert.deepEqual(
      expanded[0]?.fields.map((f) => f.name),
      ["code", "email"],
    );
    assert.equal(expanded[0]?.fields[0]?.isId, true);
    assert.deepEqual(
      expanded[1]?.fields.map((f) => f.name),
      ["left_id", "right_id"],
    );
    assert.deepEqual(expanded[1]?.ids, ["left_id", "right_id"]);
  });

  it("does not copy ids from an unknown parent or an is_id parent", () => {
    const expanded = expandTypes(
      [
        shaped(
          "person",
          [
            {
              name: "code",
              type: "integer",
              kind: "primitive",
              base: "integer",
              isArray: false,
              isNullable: false,
              isId: true,
            },
          ],
          { kind: "inherit", inherits: "set" },
        ),
        shaped(
          "alias",
          [],
          { kind: "inherit", inherits: "person" },
        ),
        shaped("orphan", [], { kind: "inherit", inherits: "ghost" }),
      ],
      "integer",
    );
    assert.equal(expanded.find((t) => t.name === "alias")?.ids, undefined);
    assert.equal(expanded.find((t) => t.name === "orphan")?.ids, undefined);
  });

  it("inherits composite ids from the parent type", () => {
    const expanded = expandTypes(
      [
        shaped(
          "link",
          [
            {
              name: "left_id",
              type: "integer",
              kind: "primitive",
              base: "integer",
              isArray: false,
              isNullable: false,
            },
            {
              name: "right_id",
              type: "integer",
              kind: "primitive",
              base: "integer",
              isArray: false,
              isNullable: false,
            },
          ],
          { kind: "inherit", inherits: "set", ids: ["left_id", "right_id"] },
        ),
        shaped(
          "tagged_link",
          [
            {
              name: "tag",
              type: "string",
              kind: "primitive",
              base: "string",
              isArray: false,
              isNullable: false,
            },
          ],
          { kind: "inherit", inherits: "link" },
        ),
      ],
      "integer",
    );
    const tagged = expanded.find((t) => t.name === "tagged_link");
    assert.deepEqual(tagged?.ids, ["left_id", "right_id"]);
    assert.deepEqual(tagged?.fields.map((f) => f.name), [
      "left_id",
      "right_id",
      "tag",
    ]);
  });

  it("leaves one_of types without merged fields", () => {
    const expanded = expandTypes(
      [
        shaped("a", [], { tags: ["view_type"] }),
        shaped("b", [], { tags: ["view_type"] }),
        shaped("result", [], {
          kind: "one_of",
          oneOf: ["a", "b"],
          tags: ["view_type"],
        }),
      ],
      "integer",
    );
    const result = expanded.find((t) => t.name === "result");
    assert.equal(result?.kind, "one_of");
    assert.deepEqual(result?.fields, []);
  });
});
