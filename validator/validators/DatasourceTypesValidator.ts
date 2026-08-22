import { SpecValidator } from "../SpecValidator.ts";
import { LIVE_VERSION } from "../specVersion.ts";
import { checkFieldDefaultSemantics } from "../fieldDefaultSemantics.ts";
import { checkDatasourceModel } from "../datasourceModelSemantics.ts";
import {
  checkIncludeCycles,
  withIncludeFilePath,
} from "../includeSemantics.ts";

/**
 * Live engine for `datasource_types.yaml`: JSON Schema first, then
 * default_value tokens/ranges from `backend/types.yaml`, then uniqueness /
 * primary_key / references / index / decimal checks, then a walk of
 * `file:` includes that rejects cycles, missing files, and unreadable
 * targets. Pinned to {@link LIVE_VERSION}.
 */
export class DatasourceTypesValidator extends SpecValidator {
  constructor() {
    super(
      {
        subdir: "backend",
        name: "datasource-types.spec.yaml",
        version: LIVE_VERSION,
      },
      [checkFieldDefaultSemantics, checkDatasourceModel, checkIncludeCycles],
      withIncludeFilePath,
    );
  }
}
