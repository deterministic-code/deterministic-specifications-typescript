import { asRecord } from "./yamlPositions.ts";
import type { SpecValidationResult } from "./types.ts";
import type { ParsedYaml } from "./SpecValidator.ts";
import { pushUnique, singleKey } from "./semanticsUtil.ts";

export function checkViewModel(parsed: ParsedYaml): SpecValidationResult {
  const errors: SpecValidationResult["errors"] = [];
  const types = asRecord(parsed.data)?.types;
  if (!Array.isArray(types)) return { valid: true, errors: [] };

  const seen = new Set<string>();
  types.forEach((entry, i) => {
    const pair = singleKey(entry);
    if (!pair) return;
    pushUnique(
      seen,
      pair.key,
      errors,
      parsed,
      `/types/${i}/${pair.key}`,
      `duplicate view '${pair.key}'`,
    );
  });
  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}
