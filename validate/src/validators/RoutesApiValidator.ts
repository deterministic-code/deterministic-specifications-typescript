import { SpecValidator, type ParsedYaml } from "../SpecValidator.ts";
import { LIVE_VERSION } from "../specVersion.ts";
import type { SpecValidationResult, ValidateOptions } from "../types.ts";
import { checkRouteModel } from "../routeModelSemantics.ts";

/**
 * Live engine for the routes-api IR: JSON Schema first, then unique
 * route names. Pinned to {@link LIVE_VERSION}.
 */
export class RoutesApiValidator extends SpecValidator {
  constructor() {
    super({
      subdir: "backend",
      name: "routes-api.spec.yaml",
      version: LIVE_VERSION,
    });
  }

  protected async check(
    parsed: ParsedYaml,
    text: string,
    options?: ValidateOptions,
  ): Promise<SpecValidationResult> {
    const schema = await super.check(parsed, text, options);
    if (!schema.valid) return schema;
    return checkRouteModel(parsed);
  }
}
