import {
  LIVE_VERSION,
  VALIDATOR_ENGINE_FILE,
  VALIDATOR_ENGINES,
  isLiveVersion,
  isPublishedVersion,
  isSpecRef,
  isSpecVersion,
  parseSpecVersion,
} from "./specVersion.ts";
import { describe, expect, test } from "vitest";

describe("catalog", () => {
  test("engine module is engines.js and named engines are listed", () => {
    expect(VALIDATOR_ENGINE_FILE).toBe("engines.js");
    expect(VALIDATOR_ENGINES.map(([className]) => className)).toEqual([
      "DatasourceTypesValidator",
      "DatasourceSeedsValidator",
      "ViewTypesValidator",
      "RoutesValidator",
      "RoutesApiValidator",
      "ServicesValidator",
      "FrontendBindingsValidator",
    ]);
  });
});

describe("isPublishedVersion / isSpecVersion / isLiveVersion", () => {
  test("accepts X.Y.Z only", () => {
    expect(isPublishedVersion("1.0.0")).toBe(true);
    expect(isPublishedVersion("0.3.0")).toBe(true);
    expect(isPublishedVersion("CURRENT")).toBe(false);
    expect(isPublishedVersion("1.0")).toBe(false);
    expect(isPublishedVersion("v1.0.0")).toBe(false);
    expect(isSpecVersion("1.0.0")).toBe(true);
    expect(isSpecVersion(LIVE_VERSION)).toBe(true);
    expect(isSpecVersion("latest")).toBe(false);
    expect(isSpecVersion("CURRENT")).toBe(false);
    expect(isLiveVersion(LIVE_VERSION)).toBe(true);
    expect(isLiveVersion("2.0.0")).toBe(false);
  });
});

describe("isSpecRef", () => {
  test("requires string subdir, name, and version", () => {
    expect(
      isSpecRef({ subdir: "backend", name: "x.spec.yaml", version: "1.0.0" }),
    ).toBe(true);
    expect(isSpecRef(null)).toBe(false);
    expect(isSpecRef("backend")).toBe(false);
    expect(isSpecRef({ subdir: 1, name: "x", version: "1.0.0" })).toBe(false);
    expect(isSpecRef({ subdir: "backend", name: 1, version: "1.0.0" })).toBe(
      false,
    );
    expect(isSpecRef({ subdir: "backend", name: "x.spec.yaml" })).toBe(false);
  });
});

describe("parseSpecVersion", () => {
  test("reads a semver from a mapping", () => {
    expect(parseSpecVersion({ version: "1.0.0", types: [] })).toEqual({
      ok: true,
      version: "1.0.0",
    });
    expect(parseSpecVersion({ version: "2.1.0" })).toEqual({
      ok: true,
      version: "2.1.0",
    });
  });

  test("rejects non-mappings, missing version, and bad tokens", () => {
    expect(parseSpecVersion(null).ok).toBe(false);
    expect(parseSpecVersion(["x"]).ok).toBe(false);
    expect(parseSpecVersion({ types: [] })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/missing required property version/),
    });
    expect(parseSpecVersion({ version: 1 })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/must be a semver/),
    });
    expect(parseSpecVersion({ version: "1.0" })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/must be a semver/),
    });
    expect(parseSpecVersion({ version: "CURRENT" })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/must be a semver/),
    });
  });
});
