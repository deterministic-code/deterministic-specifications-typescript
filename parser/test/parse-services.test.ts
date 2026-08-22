import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { memoryReader } from "../deterministic-reader.ts";
import {
  DATASOURCE_TYPES_YAML,
  ROUTES_YAML,
  SERVICES_YAML,
  VIEW_TYPES_YAML,
} from "../specification.ts";
import { DeterministicParser } from "../parser/specification-parser.ts";

const serviceClassName = (entity: string) => `${entity}_service`;

const DS_YAML = `types:
  - user:
      fields:
        - email:
            type: string
            is_unique: true
            size: 256
        - role_id:
            type: number
            references: role.id
  - role:
      datasource_type: readonly-lookup
      fields:
        - name:
            type: string
            is_unique: true
`;

const VIEW_YAML = `includes:
  - datasource_types:
      include: "*"
types:
  - user_summary:
      inherits: datasource_types.user
      omit:
        - role_id
`;

const SERVICES_YAML_DOC = `includes:
  - view_type_services:
      filter: 'type is view_type || type is datasource_type'
services:
  - name: ReportService
    module: ./services/custom/report-service
`;

const ROUTES_YAML_DOC = `routes:
  - getReport:
      method: GET
      path: /api/report
      service: ReportService
      serviceMethod: run
`;

const parseServices = (
  servicesYaml: string,
  extra: Record<string, string> = {},
) =>
  DeterministicParser(
    memoryReader({
      [DATASOURCE_TYPES_YAML]: DS_YAML,
      [VIEW_TYPES_YAML]: VIEW_YAML,
      [SERVICES_YAML]: servicesYaml,
      ...extra,
    }),
  )
    .parse({ "datasource.id_type": "integer" }, { serviceClassName })
    .then((spec) => spec.services);

describe("parseServices", () => {
  it("seeds HealthCheckService, builds generics, and wires custom methods", async () => {
    const parsed = await parseServices(SERVICES_YAML_DOC, {
      [ROUTES_YAML]: ROUTES_YAML_DOC,
    });

    assert.equal(parsed.customs[0]?.name, "HealthCheckService");
    assert.equal(parsed.customs[0]?.module, undefined);
    assert.deepEqual(parsed.customs[0]?.methods, ["check"]);
    assert.deepEqual(
      parsed.customs.map((c) => c.name),
      ["HealthCheckService", "ReportService"],
    );
    assert.deepEqual(parsed.customs[1]?.methods, ["run"]);

    assert.deepEqual(
      parsed.generics.map((g) => g.name),
      ["role", "user", "user_summary"],
    );

    const user = parsed.generics.find((g) => g.name === "user");
    assert.ok(user);
    assert.equal(user.kind, "view_type");
    assert.deepEqual(
      user.byFields.map((f) => f.field),
      ["email"],
    );
  });

  it("suppresses a generic when a custom stub uses the same class name", async () => {
    const parsed = await parseServices(`includes:
  - view_type_services:
      filter: 'type == "user"'
services:
  - name: user_service
    module: ./services/custom/user_service
`);
    assert.equal(parsed.generics.length, 0);
    assert.ok(parsed.customs.some((c) => c.name === "user_service"));
  });
});
