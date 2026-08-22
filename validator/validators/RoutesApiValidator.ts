import { SpecValidator } from "../SpecValidator.ts";
import { LIVE_VERSION } from "../specVersion.ts";
import { checkRouteModel } from "../routeModelSemantics.ts";

/**
 * Live engine for the routes-api IR: JSON Schema first, then unique
 * route names. Pinned to {@link LIVE_VERSION}.
 */
export class RoutesApiValidator extends SpecValidator {
  constructor() {
    super(
      {
        subdir: "backend",
        name: "routes-api.spec.yaml",
        version: LIVE_VERSION,
      },
      checkRouteModel,
    );
  }
}
