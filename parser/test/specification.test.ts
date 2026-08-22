import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  expandDatasourceTypes,
  expandViewTypes,
  inheritedIdType,
  parseFieldType,
  primaryKeyColumn,
  resolvedProjectIdType,
  uniqueLookupFields,
  type DatasourceType,
  type ViewType,
} from "../specification.ts";

const ds = (
  name: string,
  fields: DatasourceType["fields"],
  extra: Partial<DatasourceType> = {},
): DatasourceType => ({
  name,
  datasourceType: "standard",
  uniqueIndexFields: [],
  indexes: [],
  skipMigrations: false,
  fields,
  ...extra,
});

describe("specification helpers", () => {
  it("parses primitive, datasource, and view field types", () => {
    assert.deepEqual(parseFieldType("string"), {
      kind: "primitive",
      base: "string",
      isArray: false,
    });
    assert.deepEqual(parseFieldType("datasource_types.tag[]"), {
      kind: "datasource",
      base: "tag",
      isArray: true,
    });
    assert.deepEqual(parseFieldType("user_summary"), {
      kind: "view",
      base: "user_summary",
      isArray: false,
    });
  });

  it("falls back to integer for an unknown project id type", () => {
    assert.equal(resolvedProjectIdType("integer"), "integer");
    assert.equal(resolvedProjectIdType("float"), "integer");
  });

  it("defaults primaryKeyColumn to id when the type is missing or has no PK", () => {
    assert.equal(primaryKeyColumn(undefined), "id");
    assert.equal(primaryKeyColumn(ds("user", [{ name: "email", type: "string", isNullable: false }])), "id");
  });

  it("dedupes unique lookup fields and copies size", () => {
    const type = ds(
      "user",
      [
        { name: "email", type: "string", isNullable: false, isUnique: true, size: 256 },
        { name: "code", type: "string", isNullable: false },
      ],
      { uniqueIndexFields: ["email", "code"] },
    );
    assert.deepEqual(uniqueLookupFields(type), [
      { field: "email", type: "string", size: 256 },
      { field: "code", type: "string" },
    ]);
    assert.deepEqual(
      uniqueLookupFields(ds("empty", [], { uniqueIndexFields: ["ghost"] })),
      [{ field: "ghost", type: "string" }],
    );
  });

  it("maps an unknown inherited id type to number", () => {
    assert.equal(inheritedIdType("integer"), "integer");
    assert.equal(inheritedIdType("float"), "number");
  });

  it("skips audit columns for a many-to-many table with a custom PK", () => {
    const types = expandDatasourceTypes(
      [
        ds(
          "link",
          [{ name: "code", type: "string", isNullable: false, isPrimaryKey: true }],
          { datasourceType: "many-to-many" },
        ),
      ],
      "integer",
    );
    assert.deepEqual(types[0]?.fields.map((f) => f.name), ["code"]);
    const withOcc = expandDatasourceTypes(
      [
        ds(
          "keyed",
          [{ name: "code", type: "string", isNullable: false, isPrimaryKey: true }],
          { optimisticConcurrency: true },
        ),
      ],
      "integer",
      false,
    );
    assert.ok(withOcc[0]?.fields.some((f) => f.name === "created"));
    const withoutOcc = expandDatasourceTypes(
      [
        ds("keyed", [
          { name: "code", type: "string", isNullable: false, isPrimaryKey: true },
        ]),
      ],
      "integer",
      false,
    );
    assert.deepEqual(withoutOcc[0]?.fields.map((f) => f.name), ["code"]);
  });

  it("copies size and minSize onto inherited view fields and leaves unions/null inherits", () => {
    const parent = ds("user", [
      { name: "email", type: "string", isNullable: false, size: 64, minSize: 3 },
    ]);
    const views: ViewType[] = [
      {
        kind: "shaped",
        name: "user_summary",
        inherits: "user",
        fields: [],
        enrichments: [],
        omit: [],
      },
      {
        kind: "shaped",
        name: "standalone",
        inherits: null,
        fields: [{ name: "label", type: "string", kind: "primitive", base: "string", isArray: false, isNullable: false }],
        enrichments: [],
        omit: [],
      },
      { kind: "union", name: "payment", members: ["a"] },
    ];
    const expanded = expandViewTypes(views, [parent]);
    const summary = expanded[0];
    assert.equal(summary?.kind, "shaped");
    if (summary?.kind !== "shaped") return;
    assert.deepEqual(summary.fields[0], {
      name: "email",
      type: "string",
      kind: "primitive",
      base: "string",
      isArray: false,
      isNullable: false,
      size: 64,
      minSize: 3,
    });
    assert.equal(expanded[1]?.kind, "shaped");
    assert.equal(expanded[2]?.kind, "union");
  });
});
