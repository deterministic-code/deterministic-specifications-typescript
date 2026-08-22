import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { memoryReader } from "../src/deterministic-reader.ts";
import {
  DATASOURCE_TYPES_YAML,
  ROUTES_YAML,
  VIEW_TYPES_YAML,
} from "../src/parser/specification.ts";
import { DeterministicParser } from "../src/parser/specification-parser.ts";

const DS_YAML = `types:
  - user:
      fields:
        - email:
            type: string
            is_unique: true
        - role_id:
            type: number
            references: role.id
  - role:
      datasource_type: readonly-lookup
      fields:
        - name:
            type: string
            is_unique: true
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
  - internal_sink:
      target: None
      fields:
        - label:
            type: string
  - widget:
      datasource_type: many-to-many
      use_optimistic_concurrency: true
      fields:
        - name:
            type: string
  - app:
      use_optimistic_concurrency: false
      fields:
        - name:
            type: string
`;

const VIEW_YAML = `includes:
  - datasource_types:
      include: "*"
types:
  - user_summary:
      inherits: datasource_types.user
      omit:
        - role_id
  - search_result:
      one_of:
        - user
        - role
`;

const parseFromFiles = (files: Record<string, string>) =>
  DeterministicParser(memoryReader(files)).parse({
    "datasource.id_type": "integer",
  });

const parseFixture = async (routesYaml: string) =>
  (
    await parseFromFiles({
      [DATASOURCE_TYPES_YAML]: DS_YAML,
      [VIEW_TYPES_YAML]: VIEW_YAML,
      [ROUTES_YAML]: routesYaml,
    })
  ).routes;

describe("parseRoutes", () => {
  it("seeds GET /api/health as the first custom route when missing", async () => {
    const parsed = await parseFixture(`includes:
  - view_type_routes:
      filter: 'type inherits datasource_types'
routes: []`);

    assert.equal(parsed.customs[0]?.name, "getHealth");
    assert.equal(parsed.customs[0]?.path, "/api/health");
    assert.equal(parsed.customs[0]?.method, "GET");
  });

  it("returns empty candidates when view_type_routes is absent", async () => {
    const parsed = await parseFixture(`routes:
  - getReport:
      method: GET
      path: /api/report
      service: ReportService
      serviceMethod: run`);

    assert.equal(parsed.candidates.length, 0);
    assert.ok(parsed.customs.some((c) => c.name === "getReport"));
  });

  it("filters survivors by view_type_routes and drops target None", async () => {
    const parsed = await parseFixture(`includes:
  - view_type_routes:
      filter: 'type inherits datasource_types'
routes: []`);

    assert.deepEqual(
      parsed.candidates.map((c) => c.name),
      [
        "role",
        "user",
        "user_summary",
        "project",
        "project_setting",
        "widget",
        "app",
      ],
    );
    assert.ok(!parsed.candidates.some((c) => c.name === "internal_sink"));
    assert.ok(!parsed.candidates.some((c) => c.name === "search_result"));
  });

  it("attaches byField routes from shorthand and verbose entries", async () => {
    const parsed = await parseFixture(`includes:
  - view_type_routes:
      filter: 'type == "user"'
routes:
  - get_users_by_email:
  - users_by_slug:
      entity: user
      byField: slug
      methods:
        - GET
  - getReport:
      method: GET
      path: /api/report
      service: ReportService
      serviceMethod: run`);

    const user = parsed.candidates.find((c) => c.name === "user");
    assert.ok(user);
    assert.deepEqual(
      user.byFields.map((b) => b.byField).sort(),
      ["email", "slug"],
    );
    assert.equal(user.byFields.find((b) => b.byField === "email")?.byFieldUnique, true);
    assert.deepEqual(
      user.byFields.find((b) => b.byField === "email")?.methods,
      ["GET"],
    );
    assert.deepEqual(
      user.byFields.find((b) => b.byField === "slug")?.methods,
      ["GET"],
    );
  });

  it("splits custom routes from by-field entries", async () => {
    const parsed = await parseFixture(`includes:
  - view_type_routes:
      filter: 'type inherits datasource_types'
routes:
  - get_users_by_email:
  - getReport:
      method: GET
      path: /api/report
      service: ReportService
      serviceMethod: run`);

    assert.ok(parsed.customs.some((c) => c.name === "getHealth"));
    assert.ok(parsed.customs.some((c) => c.name === "getReport"));
    assert.ok(!parsed.customs.some((c) => c.name === "get_users_by_email"));
  });

  it("excludes direct-FK combined children from top-level candidates", async () => {
    const parsed = await parseFixture(`includes:
  - view_type_routes:
      filter: 'type inherits datasource_types'
combined_routes:
  - project:
      combined_types:
        - project_setting
routes: []`);

    assert.ok(parsed.childrenOnly.has("project_setting"));
    assert.ok(!parsed.candidates.some((c) => c.name === "project_setting"));
    assert.ok(parsed.candidates.some((c) => c.name === "project"));
  });

  it("collects direct-fk nested descriptors with default parent paths", async () => {
    const parsed = await parseFixture(`includes:
  - view_type_routes:
      filter: 'type inherits datasource_types'
combined_routes:
  - project:
      combined_types:
        - project_setting
routes: []`);

    assert.equal(parsed.nested.length, 1);
    const desc = parsed.nested[0];
    assert.equal(desc?.kind, "direct-fk");
    if (desc?.kind !== "direct-fk") return;
    assert.equal(desc.parent, "project");
    assert.equal(desc.parentParam, "project");
    assert.equal(desc.parentBasePath, "/api/projects/{id}");
    assert.equal(desc.child.name, "project_setting");
    assert.equal(desc.fkColumn, "project_id");
    assert.equal(desc.segment, "/project_settings");
    assert.equal(desc.segmentTail, "project_settings");
  });

  it("does not mark m2m via/target children as childrenOnly", async () => {
    const m2mDs = `types:
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
`;
    const parsed = (
      await parseFromFiles({
        [DATASOURCE_TYPES_YAML]: m2mDs,
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
        - tag:
            via: org_tag
            target: tag
routes: []`,
      })
    ).routes;

    assert.ok(!parsed.childrenOnly.has("tag"));
  });
});

describe("parseDatasourceTypes target and optimisticConcurrency", () => {
  it("parses target and use_optimistic_concurrency onto DatasourceType", async () => {
    const types = (
      await parseFromFiles({
        [DATASOURCE_TYPES_YAML]: `types:
  - sink:
      target: None
      fields:
        - label:
            type: string
  - app:
      use_optimistic_concurrency: false
      fields:
        - name:
            type: string
`,
      })
    ).datasourceTypes;
    assert.equal(types[0]?.target, "None");
    assert.equal(types[1]?.optimisticConcurrency, false);
  });
});

