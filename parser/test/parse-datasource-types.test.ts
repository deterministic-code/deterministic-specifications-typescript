import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { memoryReader } from "../src/deterministic-reader.ts";
import {
  DATASOURCE_SEEDS_YAML,
  DATASOURCE_TYPES_YAML,
  primaryKeyColumn,
} from "../src/parser/specification.ts";
import { DeterministicParser } from "../src/parser/specification-parser.ts";

const parseSpec = (
  files: Record<string, string>,
  idType = "integer",
) =>
  DeterministicParser(memoryReader(files)).parse({
    "datasource.id_type": idType,
  });

describe("parseDatasourceTypes", () => {
  it("reads types: and inherits a type-less references: parent.id", async () => {
    const types = (
      await parseSpec({
        [DATASOURCE_TYPES_YAML]: `types:
  - user:
      fields:
        - role_id:
            references: role.id
  - role:
      fields:
        - name:
            type: string
`,
      })
    ).datasourceTypes;
    assert.deepEqual(
      types.map((t) => t.name),
      ["user", "role"],
    );
    assert.equal(types[0]?.datasourceType, "standard");
    assert.deepEqual(types[0]?.fields, [
      {
        name: "role_id",
        type: "integer",
        isNullable: false,
        references: "role.id",
      },
    ]);
  });

  it("uses an explicit primary_key type when the reference targets that column", async () => {
    const types = (
      await parseSpec({
        [DATASOURCE_TYPES_YAML]: `types:
  - child:
      fields:
        - parent_code:
            references: parent.code
  - parent:
      fields:
        - code:
            type: string
            primary_key: true
`,
      })
    ).datasourceTypes;
    assert.equal(types[0]?.fields[0]?.type, "string");
  });

  it("reads skip_migrations and indexes", async () => {
    const types = (
      await parseSpec({
        [DATASOURCE_TYPES_YAML]: `types:
  - user:
      skip_migrations: true
      fields:
        - email:
            type: string
            is_unique: true
      indexes:
        - by_role:
            fields: [role_id]
            is_unique: false
`,
      })
    ).datasourceTypes;
    assert.equal(types[0]?.skipMigrations, true);
    assert.deepEqual(types[0]?.indexes, [
      { name: "by_role", fields: ["role_id"], isUnique: false },
    ]);
  });

  it("throws when a type-less reference cannot be resolved", async () => {
    await assert.rejects(
      () =>
        parseSpec({
          [DATASOURCE_TYPES_YAML]: `types:
  - user:
      fields:
        - role_id:
            references: missing.id
`,
        }),
      /type-less reference "role_id"/,
    );
  });
});

describe("expanded datasource primary key", () => {
  it("defaults to id and the project idType", async () => {
    const spec = await parseSpec(
      {
        [DATASOURCE_TYPES_YAML]: `types:
  - user:
      fields:
        - email:
            type: string
`,
      },
      "uuid",
    );
    const user = spec.expandedDatasourceTypes.find((t) => t.name === "user");
    assert.equal(primaryKeyColumn(user), "id");
    assert.equal(user?.fields.find((f) => f.name === "id")?.type, "uuid");
  });

  it("uses a custom non-id primary_key field", async () => {
    const spec = await parseSpec({
      [DATASOURCE_TYPES_YAML]: `types:
  - parent:
      fields:
        - code:
            type: string
            primary_key: true
`,
    });
    const parent = spec.expandedDatasourceTypes.find((t) => t.name === "parent");
    assert.equal(primaryKeyColumn(parent), "code");
    assert.equal(parent?.fields.find((f) => f.name === "code")?.type, "string");
  });
});

describe("parseDatasourceSeeds", () => {
  it("reads named seed rows keyed by idN", async () => {
    const seeds = (
      await parseSpec({
        [DATASOURCE_SEEDS_YAML]: `seeds:
  - user:
      - id1:
          email: a@example.com
      - id2:
          email: b@example.com
`,
      })
    ).datasourceSeeds;
    assert.deepEqual(seeds.get("user"), [
      { id: 1, row: { email: "a@example.com" } },
      { id: 2, row: { email: "b@example.com" } },
    ]);
  });

  it("returns empty when seeds: is missing", async () => {
    const seeds = (
      await parseSpec({ [DATASOURCE_TYPES_YAML]: "types: []\n" })
    ).datasourceSeeds;
    assert.equal(seeds.size, 0);
  });

  it("throws on a row key that is not idN", async () => {
    await assert.rejects(
      () =>
        parseSpec({
          [DATASOURCE_SEEDS_YAML]: `seeds:
  - user:
      - row1:
          email: a@example.com
`,
        }),
      /Invalid seed row key "row1"/,
    );
  });
});

describe("expandedDatasourceTypes", () => {
  it("injects StandardTable columns and keeps references", async () => {
    const spec = await parseSpec({
      [DATASOURCE_TYPES_YAML]: `types:
  - user:
      fields:
        - email:
            type: string
        - role_id:
            references: role.id
  - role:
      fields:
        - name:
            type: string
`,
    });
    const user = spec.expandedDatasourceTypes.find((t) => t.name === "user");
    assert.deepEqual(
      user?.fields.map((f) => ({
        name: f.name,
        type: f.type,
        ...(f.references !== undefined ? { references: f.references } : {}),
        ...(f.isPrimaryKey === true ? { isPrimaryKey: true } : {}),
      })),
      [
        { name: "id", type: "integer", isPrimaryKey: true },
        { name: "uuid", type: "uuid" },
        { name: "created", type: "datetime" },
        { name: "updated", type: "datetime" },
        { name: "email", type: "string" },
        { name: "role_id", type: "integer", references: "role.id" },
      ],
    );
    assert.deepEqual(
      spec.datasourceTypes.find((t) => t.name === "user")?.fields.map((f) => f.name),
      ["email", "role_id"],
    );
  });

  it("omits the uuid column when id_type is uuid", async () => {
    const spec = await parseSpec(
      {
        [DATASOURCE_TYPES_YAML]: `types:
  - user:
      fields:
        - email:
            type: string
`,
      },
      "uuid",
    );
    assert.deepEqual(
      spec.expandedDatasourceTypes[0]?.fields.map((f) => ({
        name: f.name,
        type: f.type,
      })),
      [
        { name: "id", type: "uuid" },
        { name: "created", type: "datetime" },
        { name: "updated", type: "datetime" },
        { name: "email", type: "string" },
      ],
    );
  });

  it("injects id but not audit columns for readonly-lookup", async () => {
    const spec = await parseSpec({
      [DATASOURCE_TYPES_YAML]: `types:
  - role:
      datasource_type: readonly-lookup
      fields:
        - name:
            type: string
`,
    });
    assert.deepEqual(
      spec.expandedDatasourceTypes[0]?.fields.map((f) => f.name),
      ["id", "name"],
    );
  });

  it("throws when a field is named id, created, or updated", async () => {
    await assert.rejects(
      () =>
        parseSpec({
          [DATASOURCE_TYPES_YAML]: `types:
  - user:
      fields:
        - id:
            type: string
`,
        }),
      /datasource type "user" field "id" collides with a StandardTable column/,
    );
    await assert.rejects(
      () =>
        parseSpec({
          [DATASOURCE_TYPES_YAML]: `types:
  - user:
      fields:
        - created:
            type: string
`,
        }),
      /field "created" collides with a StandardTable column/,
    );
    await assert.rejects(
      () =>
        parseSpec({
          [DATASOURCE_TYPES_YAML]: `types:
  - user:
      fields:
        - updated:
            type: string
`,
        }),
      /field "updated" collides with a StandardTable column/,
    );
  });
});
