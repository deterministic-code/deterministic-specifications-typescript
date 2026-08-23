import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { memoryReader } from "../deterministic-reader.ts";
import { DeterministicParser } from "../parser/specification-parser.ts";

const parse = (files: Record<string, string>) =>
  DeterministicParser(memoryReader(files)).parse({});

describe("parser coverage", () => {
  it("returns empty collections when no YAML is present", async () => {
    const spec = await parse({});
    assert.deepEqual(spec.types, []);
    assert.deepEqual(spec.datasource, []);
    assert.deepEqual(spec.expandedTypes, []);
  });

  it("parses seeds and empty custom lists", async () => {
    const spec = await parse({
      "types.yaml": `types:
  - user:
      tags: [datasource_type]
      fields:
        - email:
            type: string
`,
      "datasource.yaml": `types:
  - user: {}
`,
      "datasource_seeds.yaml": `seeds:
  - user:
      - id1:
          email: a@b.c
`,
      "services.yaml": `services: []`,
      "routes.yaml": `routes: []`,
    });
    assert.equal(spec.datasourceSeeds.get("user")?.[0]?.id, 1);
    assert.deepEqual(spec.services.generics, []);
    assert.deepEqual(spec.routes.candidates, []);
  });

  it("throws on an invalid seed row key", async () => {
    await assert.rejects(
      () =>
        parse({
          "datasource_seeds.yaml": `seeds:
  - user:
      - row1:
          email: a
`,
        }),
      /Invalid seed row key/,
    );
  });
});
