import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DatasourceSeedsValidator,
  DatasourceTypesValidator,
  FrontendBindingsValidator,
  RoutesApiValidator,
  RoutesValidator,
  ServicesValidator,
  ViewTypesValidator,
  VersionedValidator,
  engineConstructor,
} from "./VersionedValidator.ts";

const VALID = `version: 1.0.0
types:
  - user:
      fields:
        - id:
            type: integer
      target: StandardCrud
`;

const MINIMAL: Record<string, string> = {
  DatasourceSeedsValidator: "version: 1.0.0\nseeds: []\n",
  ViewTypesValidator: "version: 1.0.0\ntypes: []\n",
  ServicesValidator: "version: 1.0.0\nservices: []\n",
  RoutesValidator: "version: 1.0.0\nroutes: []\n",
  RoutesApiValidator: "version: 1.0.0\nroutes: []\ncomponents: {}\n",
  FrontendBindingsValidator: "version: 1.0.0\ndatasources: []\n",
};

describe("VersionedValidator dispatcher", () => {
  test("1.0.0 documents use the live engine", async () => {
    expect(await new DatasourceTypesValidator().validate(VALID)).toEqual({
      valid: true,
      errors: [],
    });
  });

  test("rejects a missing version with a positioned error", async () => {
    const result = await new DatasourceTypesValidator().validate("types: []\n");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      instancePath: "/version",
      message: expect.stringMatching(/missing required property version/),
    });
  });

  test("rejects a non-mapping document before loading an engine", async () => {
    const result = await new DatasourceTypesValidator().validate(
      "- just a list\n",
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      instancePath: "/version",
      message: expect.stringMatching(/must be a mapping/),
    });
  });

  test("rejects an unknown published version", async () => {
    const result = await new DatasourceTypesValidator().validate(
      "version: 9.9.9\ntypes: []\n",
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      instancePath: "/version",
      message: expect.stringMatching(/unknown spec version: 9.9.9/),
    });
  });

  test("rejects a malformed version token", async () => {
    const result = await new DatasourceTypesValidator().validate(
      "version: latest\ntypes: []\n",
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/must be a semver/);
  });

  test("reports YAML syntax errors without loading an engine", async () => {
    const result = await new DatasourceTypesValidator().validate(
      "foo: [unterminated\n",
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      instancePath: "",
      message: expect.any(String),
    });
  });

  test("validateFile reads from disk and dispatches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-"));
    try {
      const path = join(dir, "ok.yaml");
      await writeFile(path, VALID);
      expect(
        (await new DatasourceTypesValidator().validateFile(path)).valid,
      ).toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("engineConstructor requires the class export named after the facade", () => {
    expect(() => engineConstructor({}, "DatasourceTypesValidator")).toThrow(
      /missing export DatasourceTypesValidator/,
    );
    class Fake {
      async validate() {
        return { valid: true, errors: [] };
      }
    }
    expect(
      engineConstructor(
        { DatasourceTypesValidator: Fake },
        "DatasourceTypesValidator",
      ),
    ).toBe(Fake);
  });

  test("surfaces a missing engine export as a version-path error", async () => {
    const result = await new VersionedValidator("DoesNotExist").validate(VALID);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.instancePath).toBe("/version");
    expect(result.errors[0]?.message.length).toBeGreaterThan(0);
  });

  test("other facades dispatch 1.0.0 documents", async () => {
    expect(
      (
        await new DatasourceSeedsValidator().validate(
          MINIMAL.DatasourceSeedsValidator,
        )
      ).valid,
    ).toBe(true);
    expect(
      (await new ViewTypesValidator().validate(MINIMAL.ViewTypesValidator))
        .valid,
    ).toBe(true);
    expect(
      (await new ServicesValidator().validate(MINIMAL.ServicesValidator))
        .valid,
    ).toBe(true);
    expect(
      (await new RoutesValidator().validate(MINIMAL.RoutesValidator)).valid,
    ).toBe(true);
    expect(
      (await new RoutesApiValidator().validate(MINIMAL.RoutesApiValidator))
        .valid,
    ).toBe(true);
    expect(
      (
        await new FrontendBindingsValidator().validate(
          MINIMAL.FrontendBindingsValidator,
        )
      ).valid,
    ).toBe(true);
  });
});
