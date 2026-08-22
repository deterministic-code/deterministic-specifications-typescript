import { SpecValidator, type ParsedYaml } from "../SpecValidator.ts";
import { LIVE_VERSION } from "../specVersion.ts";
import type { SpecValidationResult, ValidateOptions } from "../types.ts";
import { parseYamlWithPositions } from "../yamlPositions.ts";
import {
  checkSeedSemantics,
  companionTypesError,
  seedsNeedTypes,
  withSiblingDatasourceTypes,
} from "../seedSemantics.ts";

const MISSING_TYPES =
  "datasource_types is required to validate seeds (pass datasourceTypes, or place datasource_types.yaml next to the seeds file)";

/**
 * Live engine for `datasource_seeds.yaml`: JSON Schema first, then
 * semantic checks against the companion `datasource_types.yaml`.
 * Pinned to {@link LIVE_VERSION}.
 */
export class DatasourceSeedsValidator extends SpecValidator {
  constructor() {
    super({
      subdir: "backend",
      name: "datasource-seeds.spec.yaml",
      version: LIVE_VERSION,
    });
  }

  protected async optionsForFile(
    path: string,
    options?: ValidateOptions,
  ): Promise<ValidateOptions | undefined> {
    return withSiblingDatasourceTypes(path, options);
  }

  protected async check(
    parsed: ParsedYaml,
    text: string,
    options?: ValidateOptions,
  ): Promise<SpecValidationResult> {
    const schema = await super.check(parsed, text, options);
    if (!schema.valid) return schema;

    const typesText = options?.datasourceTypes;
    if (typesText === undefined) {
      if (!seedsNeedTypes(parsed.data)) return { valid: true, errors: [] };
      return companionTypesError(parsed, MISSING_TYPES);
    }

    const typesValidator = new SpecValidator({
      subdir: "backend",
      name: "datasource-types.spec.yaml",
      version: LIVE_VERSION,
    });
    const typesResult = await typesValidator.validate(typesText);
    if (!typesResult.valid) {
      return companionTypesError(
        parsed,
        `companion datasource_types.yaml is invalid: ${typesResult.errors[0]?.message}`,
      );
    }

    const typesParsed = parseYamlWithPositions(typesText);
    return checkSeedSemantics(parsed, typesParsed.doc.toJS());
  }
}
