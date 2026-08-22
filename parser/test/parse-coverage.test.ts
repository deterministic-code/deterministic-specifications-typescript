import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { memoryReader } from "../deterministic-reader.ts";
import {
  DATASOURCE_SEEDS_YAML,
  DATASOURCE_TYPES_YAML,
  ROUTES_YAML,
  SERVICES_YAML,
  VIEW_TYPES_YAML,
} from "../specification.ts";
import { DeterministicParser } from "../parser/specification-parser.ts";

describe("empty documents", () => {
  it("returns empty collections when no YAML files exist", async () => {
    const spec = await parse({}, {});
    assert.deepEqual(spec.datasourceTypes, []);
    assert.equal(spec.datasourceSeeds.size, 0);
    assert.deepEqual(spec.viewTypes, []);
    assert.deepEqual(spec.services.generics, []);
    assert.equal(spec.routes.candidates.length, 0);
    assert.equal(spec.routes.customs[0]?.name, "getHealth");
  });
});

const parse = (
  files: Record<string, string>,
  settings: Record<string, string> = { "datasource.id_type": "integer" },
) => DeterministicParser(memoryReader(files)).parse(settings);

describe("datasource field and index edge cases", () => {
  it("defaults a type-less field to string and keeps default_value", async () => {
    const spec = await parse({
      [DATASOURCE_TYPES_YAML]: `types:
  - user:
      target: api
      fields:
        - label:
            default_value: none
        - count:
            type: integer
            min_size: 0
            size: 10
            default_value: 0
`,
    });
    const user = spec.datasourceTypes[0];
    assert.equal(user?.target, "api");
    assert.equal(user?.fields[0]?.name, "label");
    assert.equal(user?.fields[0]?.type, "string");
    assert.equal(user?.fields[0]?.hasDefault, true);
    assert.equal(user?.fields[0]?.defaultValue, "none");
    assert.equal(user?.fields[1]?.minSize, 0);
    assert.equal(user?.fields[1]?.size, 10);
    assert.equal(user?.fields[1]?.defaultValue, 0);
  });

  it("reads unique indexes, skips non-string fields, and ignores empty unique columns", async () => {
    const spec = await parse({
      [DATASOURCE_TYPES_YAML]: `types:
  - user:
      fields:
        - email:
            type: string
      indexes:
        - by_email:
            fields: [email]
            is_unique: true
        - by_email_again:
            fields: [email]
            is_unique: true
        - mixed:
            fields: [1, role_id]
        - scalar:
            fields: email
        - empty:
            fields: [""]
            is_unique: true
`,
    });
    assert.deepEqual(spec.datasourceTypes[0]?.uniqueIndexFields, ["email"]);
    assert.deepEqual(
      spec.datasourceTypes[0]?.indexes.map((i) => i.name),
      ["by_email", "by_email_again", "mixed", "scalar", "empty"],
    );
    assert.deepEqual(spec.datasourceTypes[0]?.indexes[2]?.fields, ["role_id"]);
    assert.deepEqual(spec.datasourceTypes[0]?.indexes[3]?.fields, []);
  });

  it("rejects a type-less reference whose parent PK column does not match", async () => {
    await assert.rejects(
      () =>
        parse({
          [DATASOURCE_TYPES_YAML]: `types:
  - child:
      fields:
        - parent_id:
            references: parent.id
  - parent:
      fields:
        - code:
            type: string
            primary_key: true
`,
        }),
      /type-less reference "parent_id"/,
    );
  });

  it("rejects a type-less reference with extra path segments", async () => {
    await assert.rejects(
      () =>
        parse({
          [DATASOURCE_TYPES_YAML]: `types:
  - user:
      fields:
        - role_id:
            references: role.id.extra
  - role:
      fields:
        - name:
            type: string
`,
        }),
      /type-less reference "role_id"/,
    );
  });

  it("reads an empty seed row mapping", async () => {
    const spec = await parse({
      [DATASOURCE_SEEDS_YAML]: `seeds:
  - user:
      - id1: {}
`,
    });
    assert.deepEqual(spec.datasourceSeeds.get("user"), [{ id: 1, row: {} }]);
  });

  it("treats a scalar seed body as an empty row and a null target as null", async () => {
    const spec = await parse({
      [DATASOURCE_TYPES_YAML]: `types:
  - sink:
      target: null
      fields:
        - label:
            type: string
`,
      [DATASOURCE_SEEDS_YAML]: `seeds:
  - user:
      - id1: hello
`,
    });
    assert.equal(spec.datasourceTypes[0]?.target, null);
    assert.deepEqual(spec.datasourceSeeds.get("user"), [{ id: 1, row: {} }]);
  });

  it("rejects a type-less reference to a non-id column when the parent has no PK", async () => {
    await assert.rejects(
      () =>
        parse({
          [DATASOURCE_TYPES_YAML]: `types:
  - child:
      fields:
        - parent_code:
            references: parent.code
  - parent:
      fields:
        - name:
            type: string
`,
        }),
      /type-less reference "parent_code"/,
    );
  });

  it("ignores a composite unique index for uniqueIndexFields", async () => {
    const spec = await parse({
      [DATASOURCE_TYPES_YAML]: `types:
  - user:
      fields:
        - email:
            type: string
      indexes:
        - pair:
            fields: [email, name]
            is_unique: true
`,
    });
    assert.deepEqual(spec.datasourceTypes[0]?.uniqueIndexFields, []);
  });
});

describe("view pass-through and enrichment edge cases", () => {
  it("includes a comma-separated include list and skips already-named types", async () => {
    const spec = await parse({
      [DATASOURCE_TYPES_YAML]: `types:
  - user:
      fields:
        - email:
            type: string
  - role:
      fields:
        - name:
            type: string
  - tag:
      fields:
        - label:
            type: string
`,
      [VIEW_TYPES_YAML]: `includes:
  - datasource_types:
      include: user, tag
types:
  - user:
      inherits: datasource_types.user
`,
    });
    assert.deepEqual(
      spec.viewTypes.map((v) => v.name),
      ["tag", "update_tag", "user", "update_user"],
    );
  });

  it("auto-enriches a unique name field that is not a readonly-lookup", async () => {
    const spec = await parse({
      [DATASOURCE_TYPES_YAML]: `types:
  - user:
      fields:
        - status_id:
            type: number
            references: status.id
            is_nullable: true
        - email:
            type: string
            references: status.id
  - status:
      fields:
        - name:
            type: string
            is_unique: true
`,
      [VIEW_TYPES_YAML]: `includes:
  - datasource_types:
      include: user
      auto_enrich: true
types: []
`,
    });
    const user = spec.viewTypes.find((v) => v.name === "user");
    assert.equal(user?.kind, "shaped");
    if (user?.kind !== "shaped") return;
    assert.deepEqual(
      user.enrichments.map((e) => ({
        fkColumn: e.fkColumn,
        newField: e.newField,
        targetIsReadonlyLookup: e.targetIsReadonlyLookup,
        isNullable: e.isNullable,
      })),
      [
        {
          fkColumn: "status_id",
          newField: "status_name",
          targetIsReadonlyLookup: false,
          isNullable: true,
        },
      ],
    );
  });

  it("does not derive variants for an eager-body name", async () => {
    const spec = await parse({
      [DATASOURCE_TYPES_YAML]: `types:
  - user:
      fields:
        - email:
            type: string
`,
      [VIEW_TYPES_YAML]: `types:
  - user_eager_body:
      inherits: datasource_types.user
`,
    });
    assert.deepEqual(
      spec.viewTypes.map((v) => v.name),
      ["user_eager_body"],
    );
  });

  it("copies size and minSize from authored view fields", async () => {
    const spec = await parse({
      [VIEW_TYPES_YAML]: `types:
  - card:
      fields:
        - title:
            type: string
            size: 80
            min_size: 2
`,
    });
    const card = spec.viewTypes[0];
    assert.equal(card?.kind, "shaped");
    if (card?.kind !== "shaped") return;
    assert.equal(card.fields[0]?.size, 80);
    assert.equal(card.fields[0]?.minSize, 2);
  });

  it("defaults a typeless view field and ignores unrelated includes", async () => {
    const spec = await parse({
      [DATASOURCE_TYPES_YAML]: `types:
  - user:
      fields:
        - email:
            type: string
`,
      [VIEW_TYPES_YAML]: `includes:
  - extra:
      include: "*"
  - datasource_types:
      include: "*"
types:
  - card:
      fields:
        - title: {}
`,
    });
    const card = spec.viewTypes.find((v) => v.name === "card");
    assert.equal(card?.kind, "shaped");
    if (card?.kind !== "shaped") return;
    assert.equal(card.fields[0]?.type, "string");
    assert.equal(card.inherits, null);
  });

  it("skips auto-enrich when inherits is missing or the FK is not enrichable", async () => {
    const spec = await parse({
      [DATASOURCE_TYPES_YAML]: `types:
  - user:
      fields:
        - role_id:
            type: number
            references: role.code
        - label_id:
            type: string
            references: role.id
        - status_id:
            type: number
            references: missing.id
        - team_id:
            type: number
            references: team.id
  - team:
      fields:
        - label:
            type: string
`,
      [VIEW_TYPES_YAML]: `includes:
  - datasource_types:
      include: user
      auto_enrich: true
types:
  - loose:
      fields:
        - label:
            type: string
  - ghost:
      inherits: datasource_types.missing
`,
    });
    const user = spec.viewTypes.find((v) => v.name === "user");
    assert.equal(user?.kind, "shaped");
    if (user?.kind !== "shaped") return;
    assert.deepEqual(user.enrichments, []);
    const loose = spec.viewTypes.find((v) => v.name === "loose");
    assert.equal(loose?.kind, "shaped");
    if (loose?.kind !== "shaped") return;
    assert.deepEqual(loose.enrichments, []);
  });
});

describe("service candidate and custom entry edge cases", () => {
  it("skips generated modules, nameless entries, and includes union views", async () => {
    const spec = await parse({
      [DATASOURCE_TYPES_YAML]: `types:
  - user:
      fields:
        - email:
            type: string
            is_unique: true
`,
      [VIEW_TYPES_YAML]: `includes:
  - datasource_types:
      include: "*"
types:
  - search_result:
      one_of:
        - user
`,
      [SERVICES_YAML]: `includes:
  - view_type_services:
      filter: 'type is view_type || type is datasource_type'
services:
  - module: ./services/custom/orphan
  - name: GeneratedUser
    module: ./services/generated/user
  - name: ReportService
    module: ./services/custom/report
`,
      [ROUTES_YAML]: `routes:
  - getReport:
      method: GET
      path: /api/report
      service: ReportService
      serviceMethod: run
  - extra:
      - nested:
          service: ReportService
          serviceMethod: extra
`,
    });
    assert.ok(spec.services.generics.some((g) => g.name === "search_result"));
    const union = spec.services.generics.find((g) => g.name === "search_result");
    assert.equal(union?.kind, "view_type");
    assert.equal(union?.datasourceType, null);
    assert.ok(!spec.services.customs.some((c) => c.name === "GeneratedUser"));
    assert.ok(spec.services.customs.some((c) => c.name === "ReportService"));
    assert.deepEqual(
      spec.services.customs.find((c) => c.name === "ReportService")?.methods,
      ["extra", "run"],
    );
  });

  it("builds a generic for a standalone view and a missing inherit", async () => {
    const spec = await parse({
      [SERVICES_YAML]: `includes:
  - view_type_services:
      filter: 'type is view_type'
services: []
`,
      [VIEW_TYPES_YAML]: `types:
  - card:
      fields:
        - title:
            type: string
  - ghost:
      inherits: datasource_types.missing
`,
    });
    const card = spec.services.generics.find((g) => g.name === "card");
    assert.equal(card?.inheritsNamespace, "");
    assert.equal(card?.datasourceType, null);
    const ghost = spec.services.generics.find((g) => g.name === "ghost");
    assert.equal(ghost?.inheritsNamespace, "datasource_types");
    assert.equal(ghost?.datasourceType, null);
    assert.deepEqual(ghost?.byFields, []);
  });
});

describe("route by-field and combined_routes edge cases", () => {
  const ds = `types:
  - user:
      fields:
        - email:
            type: string
            is_unique: true
        - slug:
            type: string
  - project:
      fields:
        - name:
            type: string
  - project_setting:
      fields:
        - project_id:
            type: number
            references: project.id
        - key:
            type: string
  - organization:
      fields: []
  - tag:
      fields:
        - name:
            type: string
  - org_tag:
      datasource_type: many-to-many
      fields:
        - organization_id:
            type: number
            references: organization.id
        - tag_id:
            type: number
            references: tag.id
  - org_tag_alt:
      datasource_type: many-to-many
      fields:
        - organization_id:
            type: number
            references: organization.id
        - tag_id:
            type: number
            references: tag.id
`;

  const views = `includes:
  - datasource_types:
      include: "*"
types:
  - search_result:
      one_of:
        - user
        - tag
`;

  const parseRoutes = (routesYaml: string) =>
    parse({
      [DATASOURCE_TYPES_YAML]: ds,
      [VIEW_TYPES_YAML]: views,
      [ROUTES_YAML]: routesYaml,
    }).then((spec) => spec.routes);

  it("unions by-field methods and accepts a null-body shorthand key", async () => {
    const routes = await parseRoutes(`includes:
  - view_type_routes:
      filter: 'type == "user"'
routes:
  - get_users_by_email
  - get_users_by_email:
  - put_users_by_email:
  - users_by_slug:
  - get_users_by_slug:
  - get_users_by_id:
  - users_by_email:
      entity: user
      byField: email
  - ghost_by_x:
      entity: ghost
      byField: x
      methods:
        - GET
  - ~
`);
    const user = routes.candidates.find((c) => c.name === "user");
    const email = user?.byFields.find((b) => b.byField === "email");
    assert.equal(email?.methods, undefined);
    const slug = user?.byFields.find((b) => b.byField === "slug");
    assert.equal(slug?.methods, undefined);
    const id = user?.byFields.find((b) => b.byField === "id");
    assert.equal(id?.byFieldUnique, true);
    const ghost = routes.candidates.find((c) => c.name === "ghost");
    assert.equal(ghost, undefined);
  });

  it("rejects malformed by-field tokens", async () => {
    await assert.rejects(
      () =>
        parseRoutes(`routes:
  - get_users:
`),
      /missing `_by_` separator/,
    );
    await assert.rejects(
      () =>
        parseRoutes(`routes:
  - get__by_:
`),
      /empty entity or field around `_by_`/,
    );
    await assert.rejects(
      () =>
        parseRoutes(`routes:
  - get_widgets_by_email:
`),
      /unknown entity `widget`/,
    );
    await assert.rejects(
      () =>
        parseRoutes(`routes:
  - get_users_by_missing:
`),
      /field `missing` not found/,
    );
    await assert.rejects(
      () =>
        parseRoutes(`routes:
  - "":
`),
      /expected non-empty string token/,
    );
    await assert.rejects(
      () =>
        parseRoutes(`routes:
  - custom:
      entity: 1
      byField: email
`),
      /non-string entity\/byField/,
    );
  });

  it("skips non-by-field route shapes and empty maps", async () => {
    const routes = await parseRoutes(`includes:
  - view_type_routes:
      filter: 'type is view_type'
routes:
  - 12
  - []
  - {}
  - note: hello
  - getReport:
      method: GET
      path: /api/report
`);
    assert.ok(routes.customs.some((c) => c.name === "getReport"));
    assert.ok(routes.candidates.some((c) => c.name === "search_result"));
    const standalone = await parse({
      [VIEW_TYPES_YAML]: `types:
  - card:
      fields:
        - title:
            type: string
`,
      [ROUTES_YAML]: `includes:
  - view_type_routes:
      filter: 'type is view_type'
routes: []`,
    });
    const card = standalone.routes.candidates.find((c) => c.name === "card");
    assert.equal(card?.kind, "view_type");
    assert.equal(card?.inheritsNamespace, "");
    assert.equal(card?.target, null);
  });

  it("collects a mapped combined child with a custom parent route", async () => {
    const routes = await parseRoutes(`includes:
  - view_type_routes:
      filter: 'type inherits datasource_types'
combined_routes:
  - project:
      route: /api/v2/projects/{id}
      combined_types:
        - project_setting:
            route: /settings
routes: []`);
    assert.ok(routes.childrenOnly.has("project_setting"));
    const desc = routes.nested[0];
    assert.equal(desc?.kind, "direct-fk");
    if (desc?.kind !== "direct-fk") return;
    assert.equal(desc.parentBasePath, "/api/v2/projects/{id}");
    assert.equal(desc.segment, "/settings");
    assert.equal(desc.segmentTail, "settings");
    const slash = await parseRoutes(`includes:
  - view_type_routes:
      filter: 'type inherits datasource_types'
combined_routes:
  - project:
      combined_types:
        - project_setting:
            route: /
  - dangling:
routes: []`);
    const slashDesc = slash.nested.find((d) => d.kind === "direct-fk");
    assert.equal(slashDesc?.kind, "direct-fk");
    if (slashDesc?.kind !== "direct-fk") return;
    assert.equal(slashDesc.segmentTail, "");
    assert.ok(!slash.childrenOnly.has("project"));
    const nestedParent = await parseRoutes(`includes:
  - view_type_routes:
      filter: 'type inherits datasource_types'
combined_routes:
  - project:
      combined_types:
        - project_setting
  - project_setting:
      combined_types: []
routes: []`);
    assert.ok(!nestedParent.childrenOnly.has("project_setting"));
  });

  it("builds an explicit M2M descriptor and auto-detects a single junction", async () => {
    const explicit = await parseRoutes(`includes:
  - view_type_routes:
      filter: 'type inherits datasource_types'
combined_routes:
  - organization:
      combined_types:
        - tag:
            via: org_tag
            target: tag
            route: /labels
routes: []`);
    const m2m = explicit.nested[0];
    assert.equal(m2m?.kind, "m2m");
    if (m2m?.kind !== "m2m") return;
    assert.equal(m2m.junction, "org_tag");
    assert.equal(m2m.target, "tag");
    assert.equal(m2m.segment, "/labels");

    const detected = await parse({
      [DATASOURCE_TYPES_YAML]: `types:
  - organization:
      fields: []
  - tag:
      fields:
        - name:
            type: string
  - org_tag:
      fields:
        - organization_id:
            type: number
            references: organization.id
        - tag_id:
            type: number
            references: tag.id
`,
      [VIEW_TYPES_YAML]: `includes:
  - datasource_types:
      include: "*"
types: []`,
      [ROUTES_YAML]: `includes:
  - view_type_routes:
      filter: 'type inherits datasource_types'
combined_routes:
  - organization:
      combined_types:
        - tag
routes: []`,
    });
    const auto = detected.routes.nested[0];
    assert.equal(auto?.kind, "m2m");
    if (auto?.kind !== "m2m") return;
    assert.equal(auto.junction, "org_tag");
    assert.equal(auto.segment, "/tags");
  });

  it("throws on ambiguous or incomplete combined_routes", async () => {
    await assert.rejects(
      () =>
        parseRoutes(`combined_routes:
  - organization:
      combined_types:
        - tag:
            via: org_tag
routes: []`),
      /M2M child must declare both via: and target:/,
    );
    await assert.rejects(
      () =>
        parseRoutes(`combined_routes:
  - organization:
      combined_types:
        - tag:
            via: missing_junction
            target: tag
routes: []`),
      /junction "missing_junction" not found/,
    );
    await assert.rejects(
      () =>
        parseRoutes(`combined_routes:
  - organization:
      combined_types:
        - tag:
            via: user
            target: tag
routes: []`),
      /junction "user" missing FK/,
    );
    await assert.rejects(
      () =>
        parseRoutes(`combined_routes:
  - organization:
      combined_types:
        - missing_child
routes: []`),
      /child "missing_child" not found/,
    );
    await assert.rejects(
      () =>
        parseRoutes(`combined_routes:
  - organization:
      combined_types:
        - user
routes: []`),
      /has no FK to parent "organization" and no detectable junction/,
    );
    await assert.rejects(
      () =>
        parseRoutes(`combined_routes:
  - organization:
      combined_types:
        - tag
routes: []`),
      /ambiguous junction between "organization" and "tag"/,
    );
  });
});
