import { asRecord } from "./yamlPositions.ts";

/** Live unpublished contract at the repo root. Documents must pin this exact semver. */
export const LIVE_VERSION = "1.0.0";

export const VALIDATOR_ENGINES = [
  ["DatasourceTypesValidator", "backend", "datasource-types.spec.yaml"],
  ["DatasourceSeedsValidator", "backend", "datasource-seeds.spec.yaml"],
  ["ViewTypesValidator", "backend", "view-types.spec.yaml"],
  ["RoutesValidator", "backend", "routes.spec.yaml"],
  ["RoutesApiValidator", "backend", "routes-api.spec.yaml"],
  ["ServicesValidator", "backend", "services.spec.yaml"],
  ["FrontendBindingsValidator", "frontend", "bindings.spec.yaml"],
] as const;

export type EngineName = (typeof VALIDATOR_ENGINES)[number][0];

export type EngineDef = {
  className: EngineName;
  subdir: string;
  name: string;
};

export function mapEngines<T>(fn: (engine: EngineDef) => T): Record<EngineName, T> {
  return Object.fromEntries(
    VALIDATOR_ENGINES.map(([className, subdir, name]) => [
      className,
      fn({ className, subdir, name }),
    ]),
  ) as Record<EngineName, T>;
}

export const SPEC_FILES = [
  ...VALIDATOR_ENGINES.map(([, subdir, name]) => ({ subdir, name })),
  { subdir: "backend", name: "app.spec.yaml" },
  { subdir: "backend", name: "types.spec.yaml" },
];

export const VALIDATOR_ENGINE_FILE = "engines.js";

export type SpecRef = {
  subdir: string;
  name: string;
  version: string;
};

export type ParseSpecVersionResult =
  | { ok: true; version: string }
  | { ok: false; message: string };

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export function isPublishedVersion(value: string): boolean {
  return SEMVER.test(value);
}

export function isSpecVersion(value: string): boolean {
  return isPublishedVersion(value);
}

export function isLiveVersion(value: string): boolean {
  return value === LIVE_VERSION;
}

export function isSpecRef(value: unknown): value is SpecRef {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.subdir === "string" &&
    typeof rec.name === "string" &&
    typeof rec.version === "string"
  );
}

export function parseSpecVersion(data: unknown): ParseSpecVersionResult {
  const rec = asRecord(data);
  if (!rec || Array.isArray(data)) {
    return {
      ok: false,
      message: "document must be a mapping with a version field",
    };
  }
  if (!("version" in rec)) {
    return {
      ok: false,
      message: "missing required property version (set a semver such as 1.0.0)",
    };
  }
  const version = rec.version;
  if (typeof version !== "string" || !isSpecVersion(version)) {
    return {
      ok: false,
      message: "version must be a semver (e.g. 1.0.0)",
    };
  }
  return { ok: true, version };
}
