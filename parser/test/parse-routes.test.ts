import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { memoryReader } from "../deterministic-reader.ts";
import { DeterministicParser } from "../parser/specification-parser.ts";

const parse = (files: Record<string, string>) =>
  DeterministicParser(memoryReader(files)).parse({});

const TYPES = `types:
  - user:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - email:
            type: string
        - reports:
            type: person[]
            references: person.user_id
  - person:
      tags: [view_type]
      inherits: user
      fields:
        - user_id:
            references: user.id
            type: integer
  - link:
      tags: [datasource_type, many_to_many]
      fields:
        - left_id:
            references: user.id
            type: integer
        - right_id:
            references: role.id
            type: integer
  - role:
      tags: [datasource_type]
      inherits: dictionary
      fields: []
`;

describe("parse routes.yaml", () => {
  it("filters candidates, attaches eager overlays, and reads function", async () => {
    const spec = await parse({
      "types.yaml": TYPES,
      "datasource.yaml": `types:
  - user:
      fields:
        - email:
            is_unique: true
`,
      "routes.yaml": `includes:
  - types:
      filter: tag == "view_type"
combined_routes:
  - user:
      route: /api/users
      combines:
        - person:
            via: link
            target: role
            route: /api/users/:id/roles
routes:
  - user:
      eager_read_path:
        - reports
      eager_update_path:
        - reports
      eager_read_member_only:
        - reports
  - get_users_by_email
  - custom_post:
      path: /api/people
      method: POST
      service: PersonService
      function: create
`,
    });
    const user = spec.routes.candidates.find((c) => c.name === "user");
    assert.ok(user);
    assert.deepEqual(user?.eagerReadPath, ["reports"]);
    assert.ok(user?.byFields.some((f) => f.byField === "email"));
    assert.equal(spec.routes.customs.some((c) => c.path === "/api/people"), true);
    assert.equal(spec.routes.nested[0]?.kind, "m2m");
  });

  it("detects a direct FK child", async () => {
    const spec = await parse({
      "types.yaml": TYPES,
      "routes.yaml": `includes:
  - types:
      filter: tag == "view_type"
combined_routes:
  - user:
      route: /api/users
      combines:
        - person
routes: []
`,
    });
    assert.equal(spec.routes.nested[0]?.kind, "direct-fk");
    assert.ok(spec.routes.childrenOnly.has("person"));
  });
});
