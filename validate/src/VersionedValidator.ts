import { pathToFileURL } from "node:url";
import { parseSpecVersion, VALIDATOR_ENGINE_FILE } from "./specVersion.ts";
import { resolveEngineModulePath } from "./resolveSpecPath.ts";
import {
  errorFromUnknown,
  FileValidator,
  versionFail,
  type ParsedYaml,
} from "./SpecValidator.ts";
import type { SpecValidationResult, ValidateOptions } from "./types.ts";
import { withSiblingDatasourceTypes } from "./seedSemantics.ts";
import { withIncludeFilePath } from "./includeSemantics.ts";

type Engine = {
  validate(
    text: string,
    options?: ValidateOptions,
  ): Promise<SpecValidationResult>;
};

export function engineConstructor(
  mod: Record<string, unknown>,
  exportName: string,
): new () => Engine {
  const Ctor = mod[exportName];
  if (typeof Ctor !== "function") {
    throw new Error(
      `validator engine missing export ${exportName} in ${VALIDATOR_ENGINE_FILE}`,
    );
  }
  return Ctor as new () => Engine;
}

async function loadEngine(exportName: string, version: string): Promise<Engine> {
  const href = pathToFileURL(await resolveEngineModulePath(version)).href;
  return new (engineConstructor(
    (await import(href)) as Record<string, unknown>,
    exportName,
  ))();
}

/**
 * Public facade: read `version` from the document (required semver), load
 * that version's engine (`src/validators/` for the live version, or
 * `versions/<semver>/validators/`), and delegate. Missing or unknown
 * versions fail before an engine is constructed.
 */
export class VersionedValidator extends FileValidator {
  readonly #exportName: string;

  constructor(exportName: string) {
    super();
    this.#exportName = exportName;
  }

  protected async check(
    { doc, lineCounter, data }: ParsedYaml,
    text: string,
    options?: ValidateOptions,
  ): Promise<SpecValidationResult> {
    const parsed = parseSpecVersion(data);
    if (!parsed.ok) return versionFail(doc, lineCounter, parsed.message);
    try {
      return (await loadEngine(this.#exportName, parsed.version)).validate(
        text,
        options,
      );
    } catch (err) {
      return versionFail(doc, lineCounter, errorFromUnknown(err));
    }
  }
}

export class DatasourceTypesValidator extends VersionedValidator {
  constructor() {
    super("DatasourceTypesValidator");
  }

  protected async optionsForFile(
    path: string,
    options?: ValidateOptions,
  ): Promise<ValidateOptions | undefined> {
    return withIncludeFilePath(path, options);
  }
}

export class ViewTypesValidator extends VersionedValidator {
  constructor() {
    super("ViewTypesValidator");
  }

  protected async optionsForFile(
    path: string,
    options?: ValidateOptions,
  ): Promise<ValidateOptions | undefined> {
    return withIncludeFilePath(path, options);
  }
}

export class RoutesValidator extends VersionedValidator {
  constructor() {
    super("RoutesValidator");
  }

  protected async optionsForFile(
    path: string,
    options?: ValidateOptions,
  ): Promise<ValidateOptions | undefined> {
    return withIncludeFilePath(path, options);
  }
}

export class RoutesApiValidator extends VersionedValidator {
  constructor() {
    super("RoutesApiValidator");
  }
}

export class ServicesValidator extends VersionedValidator {
  constructor() {
    super("ServicesValidator");
  }

  protected async optionsForFile(
    path: string,
    options?: ValidateOptions,
  ): Promise<ValidateOptions | undefined> {
    return withIncludeFilePath(path, options);
  }
}

export class FrontendBindingsValidator extends VersionedValidator {
  constructor() {
    super("FrontendBindingsValidator");
  }
}

export class DatasourceSeedsValidator extends VersionedValidator {
  constructor() {
    super("DatasourceSeedsValidator");
  }

  protected async optionsForFile(
    path: string,
    options?: ValidateOptions,
  ): Promise<ValidateOptions | undefined> {
    return withSiblingDatasourceTypes(path, options);
  }
}
