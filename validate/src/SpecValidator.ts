import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { parseDocument } from "yaml";
import type {
  AjvError,
  AjvLike,
  SpecValidationError,
  SpecValidationResult,
  ValidateFn,
  ValidateOptions,
} from "./types.ts";
import { parseYamlWithPositions, positionFor } from "./yamlPositions.ts";
import { resolveSpecPath } from "./resolveSpecPath.ts";
import {
  isSpecRef,
  mapEngines,
  parseSpecVersion,
  type EngineName,
  type SpecRef,
} from "./specVersion.ts";

type SpecPathFn = () => Promise<string>;
type SpecPathSource = string | SpecPathFn | SpecRef;
type AjvCtorType = new (opts: unknown) => AjvLike;
type YamlDoc = ReturnType<typeof parseYamlWithPositions>["doc"];
type YamlLines = ReturnType<typeof parseYamlWithPositions>["lineCounter"];

export type ParsedYaml = {
  doc: YamlDoc;
  lineCounter: YamlLines;
  data: unknown;
};

export function yamlErrorOffset(
  pos: readonly number[] | undefined | null,
): number {
  return pos ? pos[0] : 0;
}

function yamlParseErrors(
  doc: YamlDoc,
  lineCounter: YamlLines,
): SpecValidationError[] {
  return doc.errors.map((e): SpecValidationError => {
    const { line, col } = lineCounter.linePos(yamlErrorOffset(e.pos));
    return { line, col, instancePath: "", message: e.message };
  });
}

function specError(
  doc: YamlDoc,
  lineCounter: YamlLines,
  instancePath: string,
  message: string,
): SpecValidationError {
  const { line, col } = positionFor(doc, lineCounter, instancePath);
  return { line, col, instancePath, message };
}

export function versionFail(
  doc: YamlDoc,
  lineCounter: YamlLines,
  message: string,
): SpecValidationResult {
  return {
    valid: false,
    errors: [specError(doc, lineCounter, "/version", message)],
  };
}

function readYaml(text: string): ParsedYaml & {
  errors: SpecValidationError[];
} {
  const { doc, lineCounter } = parseYamlWithPositions(text);
  return {
    doc,
    lineCounter,
    errors: yamlParseErrors(doc, lineCounter),
    data: doc.toJS(),
  };
}

/** CJS/ESM interop: `ajv/dist/2020.js` may be the class or `{ default: class }`. */
export function resolveAjvCtor(mod: unknown): AjvCtorType {
  const withDefault = mod as { default?: AjvCtorType };
  return (withDefault.default ?? (mod as AjvCtorType)) as AjvCtorType;
}

function newAjv(): AjvLike {
  return new (resolveAjvCtor(Ajv2020))({ allErrors: true, strict: false });
}

const AJV_PARAM_SUFFIX: Array<[string, (v: unknown) => string]> = [
  ["additionalProperty", (v) => `(property: ${String(v)})`],
  ["missingProperty", (v) => `(missing: ${String(v)})`],
  ["allowedValues", (v) => `(allowed: ${(v as unknown[]).join(", ")})`],
];

function ajvParamSuffix(params?: Record<string, unknown>): string {
  if (!params) return "";
  for (const [key, fmt] of AJV_PARAM_SUFFIX) {
    if (params[key]) return ` ${fmt(params[key])}`;
  }
  return "";
}

export function formatAjvError(e: AjvError): string {
  const where = e.instancePath || "(root)";
  return `${where} ${e.message}${ajvParamSuffix(e.params)}`;
}

export function errorFromUnknown(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Shared parse + file entry: YAML syntax errors are mapped here; subclasses
 * implement {@link check} against the parsed document.
 */
export abstract class FileValidator {
  async validate(
    text: string,
    options?: ValidateOptions,
  ): Promise<SpecValidationResult> {
    const { doc, lineCounter, errors, data } = readYaml(text);
    if (errors.length > 0) return { valid: false, errors };
    return this.check({ doc, lineCounter, data }, text, options);
  }

  protected abstract check(
    parsed: ParsedYaml,
    text: string,
    options?: ValidateOptions,
  ): Promise<SpecValidationResult>;

  protected async optionsForFile(
    _path: string,
    options?: ValidateOptions,
  ): Promise<ValidateOptions | undefined> {
    return options;
  }

  async validateFile(
    path: string,
    options?: ValidateOptions,
  ): Promise<SpecValidationResult> {
    return this.validate(
      await readFile(path, "utf8"),
      await this.optionsForFile(path, options),
    );
  }
}

/**
 * Validates a `deterministic/*.yaml` document against one strict JSON Schema
 * (draft 2020-12, authored in YAML). The base class carries AJV compilation
 * and source-position mapping so every error reports `{ line, col }`.
 *
 * Pass a `{ subdir, name, version }` ref to pin this engine to one contract
 * version. The document's `version` must match; the matching snapshot is
 * loaded and nothing else. Pass an absolute path (or path thunk) to validate
 * against a spec that lives outside this package — the pin check is skipped.
 */
export class SpecValidator extends FileValidator {
  readonly #specRef: SpecRef | null;
  readonly #resolveFixedPath: SpecPathFn | null;
  readonly #compiled = new Map<string, ValidateFn>();

  constructor(specPath: SpecPathSource) {
    super();
    if (isSpecRef(specPath)) {
      this.#specRef = specPath;
      this.#resolveFixedPath = null;
    } else {
      this.#specRef = null;
      this.#resolveFixedPath =
        typeof specPath === "string" ? async () => specPath : specPath;
    }
  }

  protected async check(
    { doc, lineCounter, data }: ParsedYaml,
    _text: string,
    _options?: ValidateOptions,
  ): Promise<SpecValidationResult> {
    const resolved = await this.#resolvePath(data, doc, lineCounter);
    if (!("path" in resolved)) return resolved;

    const validate = await this.#compiledSpec(resolved.path);
    if (validate(data)) return { valid: true, errors: [] };

    return {
      valid: false,
      errors: validate.errors!.map((e) =>
        specError(doc, lineCounter, e.instancePath, formatAjvError(e)),
      ),
    };
  }

  async #resolvePath(
    data: unknown,
    doc: YamlDoc,
    lineCounter: YamlLines,
  ): Promise<{ path: string } | SpecValidationResult> {
    if (this.#resolveFixedPath) {
      return { path: await this.#resolveFixedPath() };
    }
    const ref = this.#specRef!;
    const parsed = parseSpecVersion(data);
    if (!parsed.ok) return versionFail(doc, lineCounter, parsed.message);
    if (parsed.version !== ref.version) {
      return versionFail(
        doc,
        lineCounter,
        `version must be ${ref.version} (this engine is pinned to ${ref.version})`,
      );
    }
    try {
      return {
        path: await resolveSpecPath(ref.subdir, ref.name, ref.version),
      };
    } catch (err) {
      return versionFail(doc, lineCounter, errorFromUnknown(err));
    }
  }

  static pinned(ref: SpecRef): new () => SpecValidator {
    return class extends SpecValidator {
      constructor() {
        super(ref);
      }
    };
  }

  static pinnedEngines(
    version: string,
  ): Record<EngineName, new () => SpecValidator> {
    return mapEngines(({ subdir, name }) =>
      SpecValidator.pinned({ subdir, name, version }),
    );
  }

  async #compiledSpec(specPath: string): Promise<ValidateFn> {
    const hit = this.#compiled.get(specPath);
    if (hit) return hit;
    const specText = await readFile(specPath, "utf8");
    const compiled = newAjv().compile(parseDocument(specText).toJS());
    this.#compiled.set(specPath, compiled);
    return compiled;
  }
}
