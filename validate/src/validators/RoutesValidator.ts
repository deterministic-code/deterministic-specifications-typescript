import { SpecValidator, type ParsedYaml } from "../SpecValidator.ts";
import { LIVE_VERSION } from "../specVersion.ts";
import type { SpecValidationResult, ValidateOptions } from "../types.ts";
import {
  checkIncludeCycles,
  withIncludeFilePath,
} from "../includeSemantics.ts";
import { checkRouteModel } from "../routeModelSemantics.ts";
import { checkIncludeFilters } from "../includeFilter.ts";

/**
 * Live engine for `routes.yaml`: JSON Schema first, then unique route names
 * and exclusive custom-route dispatch, then a walk of `file:` includes.
 * Pinned to {@link LIVE_VERSION}.
 */
export class RoutesValidator extends SpecValidator {
  constructor() {
    super({
      subdir: "backend",
      name: "routes.spec.yaml",
      version: LIVE_VERSION,
    });
  }

  protected async optionsForFile(
    path: string,
    options?: ValidateOptions,
  ): Promise<ValidateOptions | undefined> {
    return withIncludeFilePath(path, options);
  }

  protected async check(
    parsed: ParsedYaml,
    text: string,
    options?: ValidateOptions,
  ): Promise<SpecValidationResult> {
    const schema = await super.check(parsed, text, options);
    if (!schema.valid) return schema;
    const model = checkRouteModel(parsed);
    if (!model.valid) return model;
    const filters = checkIncludeFilters(parsed);
    if (!filters.valid) return filters;
    return checkIncludeCycles(parsed, options);
  }
}
