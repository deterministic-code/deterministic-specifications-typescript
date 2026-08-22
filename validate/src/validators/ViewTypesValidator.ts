import { SpecValidator, type ParsedYaml } from "../SpecValidator.ts";
import { LIVE_VERSION } from "../specVersion.ts";
import type { SpecValidationResult, ValidateOptions } from "../types.ts";
import {
  checkIncludeCycles,
  withIncludeFilePath,
} from "../includeSemantics.ts";
import { checkViewModel } from "../viewModelSemantics.ts";
import { checkIncludeFilters } from "../includeFilter.ts";

/**
 * Live engine for `view_types.yaml`: JSON Schema first, then unique view
 * names, then a walk of `file:` includes. Pinned to {@link LIVE_VERSION}.
 */
export class ViewTypesValidator extends SpecValidator {
  constructor() {
    super({
      subdir: "backend",
      name: "view-types.spec.yaml",
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
    const model = checkViewModel(parsed);
    if (!model.valid) return model;
    const filters = checkIncludeFilters(parsed);
    if (!filters.valid) return filters;
    return checkIncludeCycles(parsed, options);
  }
}
