import { SpecValidator } from "../SpecValidator.ts";
import { LIVE_VERSION } from "../specVersion.ts";
import { checkFieldDefaultSemantics } from "../fieldDefaultSemantics.ts";
import { checkTypeModel } from "../typeModelSemantics.ts";
import {
  checkIncludeCycles,
  withIncludeFilePath,
} from "../includeSemantics.ts";
import { checkIncludeFilters } from "../includeFilter.ts";

/**
 * Live engine for `types.yaml`: JSON Schema first, then default_value
 * tokens/ranges, then inherit/union/one_of/reference checks, then include
 * filters and `file:` cycles. Pinned to {@link LIVE_VERSION}.
 */
export class TypesValidator extends SpecValidator {
  constructor() {
    super(
      {
        subdir: "backend",
        name: "types.spec.yaml",
        version: LIVE_VERSION,
      },
      [
        checkFieldDefaultSemantics,
        checkTypeModel,
        checkIncludeFilters,
        checkIncludeCycles,
      ],
      withIncludeFilePath,
    );
  }
}
