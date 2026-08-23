import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DeterministicParser } from "../parser/specification-parser.ts";
import { memoryReader } from "../deterministic-reader.ts";

const parse = (files: Record<string, string>) =>
  DeterministicParser(memoryReader(files)).parse({});

describe("parse types.yaml", () => {
  it("reads inherit, union, one_of, mapping, and remove_fields", async () => {
    const det = await parse({
      "types.yaml": `types:
  - user:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - email:
            type: string
            size: 256
        - bio:
            type: string
  - role:
      tags: [datasource_type]
      inherits: dictionary
      fields:
        - code:
            type: string
  - person:
      tags: [view_type]
      inherits: user
      remove_fields: [bio]
      fields:
        - display_name:
            type: string
        - role:
            type: role
  - phone_contact:
      tags: [view_type]
      union: [user, role]
      mapping:
        name: role_name
      remove_fields: [id]
      fields:
        - phone:
            type: string
  - result:
      tags: [view_type]
      one_of: [person, phone_contact]
`,
    });
    const user = det.expandedTypes.find((t) => t.name === "user");
    assert.deepEqual(user?.fields.map((f) => f.name), ["id", "email", "bio"]);
    const role = det.expandedTypes.find((t) => t.name === "role");
    assert.deepEqual(role?.fields.map((f) => f.name), ["name", "value", "code"]);
    const person = det.expandedTypes.find((t) => t.name === "person");
    assert.deepEqual(person?.fields.map((f) => f.name), [
      "id",
      "email",
      "display_name",
      "role",
    ]);
    const phone = det.expandedTypes.find((t) => t.name === "phone_contact");
    assert.ok(phone?.fields.some((f) => f.name === "role_name"));
    assert.ok(!phone?.fields.some((f) => f.name === "id"));
    const result = det.types.find((t) => t.name === "result");
    assert.equal(result?.kind, "one_of");
    assert.deepEqual(result?.oneOf, ["person", "phone_contact"]);
  });

  it("reads is_id and ids and skips injected id", async () => {
    const det = await parse({
      "types.yaml": `types:
  - person:
      tags: [datasource_type]
      inherits: set
      fields:
        - code:
            type: integer
            is_id: true
        - email:
            type: string
  - link:
      tags: [datasource_type]
      inherits: set
      ids: [left_id, right_id]
      fields:
        - left_id:
            type: integer
        - right_id:
            type: integer
  - user:
      tags: [datasource_type]
      inherits: set
      fields:
        - email:
            type: string
`,
    });
    const person = det.expandedTypes.find((t) => t.name === "person");
    assert.deepEqual(person?.fields.map((f) => f.name), ["code", "email"]);
    assert.equal(person?.fields[0]?.isId, true);
    const link = det.expandedTypes.find((t) => t.name === "link");
    assert.deepEqual(link?.ids, ["left_id", "right_id"]);
    assert.deepEqual(link?.fields.map((f) => f.name), ["left_id", "right_id"]);
    const user = det.expandedTypes.find((t) => t.name === "user");
    assert.deepEqual(user?.fields.map((f) => f.name), ["id", "email"]);
  });

  it("parses composite references", async () => {
    const det = await parse({
      "types.yaml": `types:
  - link:
      tags: [datasource_type, many_to_many]
      fields:
        - left_id:
            type: integer
            references: user.id
        - right_id:
            type: integer
            references: role.id
        - pair:
            references: [link.left_id, link.right_id]
`,
    });
    const pair = det.types[0]?.fields.find((f) => f.name === "pair");
    assert.deepEqual(pair?.references, ["link.left_id", "link.right_id"]);
  });
});
