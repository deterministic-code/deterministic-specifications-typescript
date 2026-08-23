import { SpecValidator, type ParsedYaml } from "../SpecValidator.ts";
import { LIVE_VERSION } from "../specVersion.ts";
import type { SpecValidationResult, ValidateOptions } from "../types.ts";
import { parseYamlWithPositions } from "../yamlPositions.ts";
import {
  checkIncludeCycles,
  withIncludeFilePath,
} from "../includeSemantics.ts";
import { checkIncludeFilters } from "../includeFilter.ts";
import { checkDatasourceModel } from "../datasourceModelSemantics.ts";

async function checkDatasource(
  parsed: ParsedYaml,
  options?: ValidateOptions,
): Promise<SpecValidationResult> {
  const typesText = options?.types;
  const companion =
    typesText === undefined
      ? undefined
      : parseYamlWithPositions(typesText).doc.toJS();
  return checkDatasourceModel(parsed, companion);
}

/**
 * Live engine for `datasource.yaml`: JSON Schema first, then uniqueness /
 * identity / index checks, optional companion `types.yaml`, then include
 * filters and `file:` cycles. Pinned to {@link LIVE_VERSION}.
 */
export class DatasourceValidator extends SpecValidator {
  constructor() {
    super(
      {
        subdir: "backend",
        name: "datasource.spec.yaml",
        version: LIVE_VERSION,
      },
      [checkDatasource, checkIncludeFilters, checkIncludeCycles],
      withIncludeFilePath,
    );
  }
}
