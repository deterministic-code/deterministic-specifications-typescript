import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { memoryReader } from "../deterministic-reader.ts";
import { DATASOURCE_TYPES_YAML, VIEW_TYPES_YAML } from "../specification.ts";
import { DeterministicParser } from "../parser/specification-parser.ts";

const DS = `types:
  - user:
      datasource_type: audit
      fields:
        - email:
            type: string
        - role_id:
            type: number
            references: role.id
  - role:
      datasource_type: readonly-lookup
      fields:
        - name:
            type: string
            is_unique: true
  - tag:
      fields:
        - label:
            type: string
  - code_entity:
      fields:
        - code:
            type: string
            primary_key: true
        - title:
            type: string
`;

const parseViews = (viewYaml: string, datasourceYaml?: string) =>
  DeterministicParser(
    memoryReader({
      [VIEW_TYPES_YAML]: viewYaml,
      ...(datasourceYaml !== undefined
        ? { [DATASOURCE_TYPES_YAML]: datasourceYaml }
        : {}),
    }),
  )
    .parse({ "datasource.id_type": "integer" })
    .then((spec) => spec.viewTypes);

const parseExpandedViews = (viewYaml: string, datasourceYaml?: string) =>
  DeterministicParser(
    memoryReader({
      [VIEW_TYPES_YAML]: viewYaml,
      ...(datasourceYaml !== undefined
        ? { [DATASOURCE_TYPES_YAML]: datasourceYaml }
        : {}),
    }),
  )
    .parse({ "datasource.id_type": "integer" })
    .then((spec) => spec.expandedViewTypes);

describe("parseViewTypes", () => {
  it("reads shaped and union views", async () => {
    const views = await parseViews(`types:
  - user_summary:
      inherits: datasource_types.user
      omit:
        - email
      fields:
        - display_name:
            type: string
            is_nullable: true
        - tags:
            type: datasource_types.tag[]
        - owner:
            type: user_summary
  - payment:
      one_of:
        - card_payment
        - cash_payment
`);
    assert.deepEqual(
      views.map((v) => v.name),
      ["user_summary", "payment"],
    );
    const summary = views[0];
    assert.equal(summary?.kind, "shaped");
    if (summary?.kind !== "shaped") return;
    assert.equal(summary.inherits, "user");
    assert.deepEqual(summary.omit, ["email"]);
    assert.deepEqual(
      summary.fields.map((f) => ({
        name: f.name,
        kind: f.kind,
        base: f.base,
        isArray: f.isArray,
        isNullable: f.isNullable,
      })),
      [
        {
          name: "display_name",
          kind: "primitive",
          base: "string",
          isArray: false,
          isNullable: true,
        },
        {
          name: "tags",
          kind: "datasource",
          base: "tag",
          isArray: true,
          isNullable: false,
        },
        {
          name: "owner",
          kind: "view",
          base: "user_summary",
          isArray: false,
          isNullable: false,
        },
      ],
    );
    assert.deepEqual(views[1], {
      kind: "union",
      name: "payment",
      members: ["card_payment", "cash_payment"],
    });
  });

  it("pass-throughs included datasource types and derives update variants", async () => {
    const views = await parseViews(
      `includes:
  - datasource_types:
      include: "*"
types: []
`,
      DS,
    );
    assert.deepEqual(
      views.map((v) => v.name),
      ["user", "update_user", "role", "tag", "update_tag", "code_entity", "update_code_entity", "create_code_entity"],
    );
    const updateUser = views.find((v) => v.name === "update_user");
    assert.equal(updateUser?.kind, "shaped");
    if (updateUser?.kind !== "shaped") return;
    assert.equal(updateUser.inherits, "user");
    assert.deepEqual(updateUser.omit, ["id", "uuid", "created", "updated"]);
    const createCode = views.find((v) => v.name === "create_code_entity");
    assert.equal(createCode?.kind, "shaped");
    if (createCode?.kind !== "shaped") return;
    assert.deepEqual(createCode.omit, ["id", "uuid", "created", "updated"]);
    const updateCode = views.find((v) => v.name === "update_code_entity");
    assert.equal(updateCode?.kind, "shaped");
    if (updateCode?.kind !== "shaped") return;
    assert.ok(updateCode.omit.includes("code"));
  });

  it("skips update variants for readonly-lookup and already-prefixed names", async () => {
    const views = await parseViews(
      `types:
  - role:
      inherits: datasource_types.role
  - update_user:
      inherits: datasource_types.user
`,
      DS,
    );
    assert.deepEqual(
      views.map((v) => v.name),
      ["role", "update_user"],
    );
  });

  it("auto-enriches FK columns on inherited views", async () => {
    const views = await parseViews(
      `includes:
  - datasource_types:
      include: user
      auto_enrich: true
types: []
`,
      DS,
    );
    const user = views.find((v) => v.name === "user");
    assert.equal(user?.kind, "shaped");
    if (user?.kind !== "shaped") return;
    assert.deepEqual(
      user.fields.map((f) => f.name),
      ["role_name"],
    );
    assert.deepEqual(
      user.enrichments.map((e) => ({
        fkColumn: e.fkColumn,
        newField: e.newField,
        targetTable: e.targetTable,
      })),
      [{ fkColumn: "role_id", newField: "role_name", targetTable: "role" }],
    );
  });

  it("filters pass-throughs with the datasource_types.filter expression", async () => {
    const views = await parseViews(
      `includes:
  - datasource_types:
      include: "*"
      filter: type.datasource_type != "readonly-lookup"
types: []
`,
      DS,
    );
    assert.equal(
      views.some((v) => v.name === "role"),
      false,
    );
    assert.equal(
      views.some((v) => v.name === "user"),
      true,
    );
  });

  it("throws when a datasource_types include is present without datasource YAML", async () => {
    await assert.rejects(
      () =>
        parseViews(`includes:
  - datasource_types:
      include: "*"
types: []
`),
      /no datasource_types\.yaml was provided/,
    );
  });

  it("rejects an invalid datasource_types.filter expression", async () => {
    await assert.rejects(
      () =>
        parseViews(
          `includes:
  - datasource_types:
      include: "*"
      filter: type.datasource_type ===
types: []
`,
          DS,
        ),
      /datasource_types.filter is not a valid expression/,
    );
  });
});

describe("expandedViewTypes", () => {
  it("inlines inherited StandardTable columns and drops omitted and enriched FKs", async () => {
    const views = await parseExpandedViews(
      `includes:
  - datasource_types:
      include: user
      auto_enrich: true
types:
  - user_summary:
      inherits: datasource_types.user
      omit:
        - email
      fields:
        - display_name:
            type: string
`,
      DS,
    );
    const user = views.find((v) => v.name === "user");
    assert.equal(user?.kind, "shaped");
    if (user?.kind !== "shaped") return;
    assert.deepEqual(
      user.fields.map((f) => f.name),
      ["id", "uuid", "created", "updated", "email", "role_name"],
    );
    assert.equal(user.fields.find((f) => f.name === "id")?.type, "integer");
    assert.equal(user.fields.find((f) => f.name === "created")?.type, "datetime");
    const summary = views.find((v) => v.name === "user_summary");
    assert.equal(summary?.kind, "shaped");
    if (summary?.kind !== "shaped") return;
    assert.deepEqual(
      summary.fields.map((f) => f.name),
      ["id", "uuid", "created", "updated", "display_name", "role_name"],
    );
  });

  it("leaves union views unchanged", async () => {
    const views = await parseExpandedViews(`types:
  - payment:
      one_of:
        - card_payment
        - cash_payment
`);
    assert.deepEqual(views[0], {
      kind: "union",
      name: "payment",
      members: ["card_payment", "cash_payment"],
    });
  });
});
