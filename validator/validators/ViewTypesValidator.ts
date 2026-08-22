import { SpecValidator } from "../SpecValidator.ts";
import { LIVE_VERSION } from "../specVersion.ts";
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
    super(
      {
        subdir: "backend",
        name: "view-types.spec.yaml",
        version: LIVE_VERSION,
      },
      [checkViewModel, checkIncludeFilters, checkIncludeCycles],
      withIncludeFilePath,
    );
  }
}
