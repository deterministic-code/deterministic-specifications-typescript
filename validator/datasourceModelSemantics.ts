import { asRecord } from "./yamlPositions.ts";
import type { SpecValidationResult } from "./types.ts";
import type { ParsedYaml } from "./SpecValidator.ts";
import { pushUnique, singleKey, specErr } from "./semanticsUtil.ts";
import { indexTypeFields } from "./typeModelSemantics.ts";

type TableInfo = {
  path: string;
  fields: Map<string, string>;
};

function collectTables(
  parsed: ParsedYaml,
): { tables: Map<string, TableInfo>; errors: SpecValidationResult["errors"] } {
  const errors: SpecValidationResult["errors"] = [];
  const tables = new Map<string, TableInfo>();
  const types = asRecord(parsed.data)?.types;
  if (!Array.isArray(types)) return { tables, errors };

  const seen = new Set<string>();
  types.forEach((entry, ti) => {
    const pair = singleKey(entry);
    if (!pair) return;
    const tablePath = `/types/${ti}/${pair.key}`;
    if (
      !pushUnique(
        seen,
        pair.key,
        errors,
        parsed,
        tablePath,
        `duplicate type '${pair.key}'`,
      )
    ) {
      return;
    }
    const def = asRecord(pair.body) ?? {};
    const fields = new Map<string, string>();
    const fieldList = def.fields;
    if (Array.isArray(fieldList)) {
      const seenFields = new Set<string>();
      fieldList.forEach((field, fi) => {
        const fp = singleKey(field);
        if (!fp) return;
        const fieldPath = `${tablePath}/fields/${fi}/${fp.key}`;
        if (
          !pushUnique(
            seenFields,
            fp.key,
            errors,
            parsed,
            fieldPath,
            `duplicate field '${fp.key}' on ${pair.key}`,
          )
        ) {
          return;
        }
        const fdef = asRecord(fp.body) ?? {};
        if (fdef.is_fixed_id === true && fdef.is_readonly !== true) {
          errors.push(
            specErr(
              parsed,
              `${fieldPath}/is_fixed_id`,
              `is_fixed_id on '${fp.key}' requires is_readonly: true`,
            ),
          );
        }
        fields.set(fp.key, fieldPath);
      });
    }
    tables.set(pair.key, { path: tablePath, fields });
  });
  return { tables, errors };
}

function checkIndexes(
  parsed: ParsedYaml,
  tables: Map<string, TableInfo>,
  companionFields?: Map<string, Map<string, Record<string, unknown>>>,
): SpecValidationResult["errors"] {
  const errors: SpecValidationResult["errors"] = [];
  const types = asRecord(parsed.data)?.types;
  if (!Array.isArray(types)) return errors;

  types.forEach((entry, ti) => {
    const pair = singleKey(entry);
    if (!pair) return;
    const def = asRecord(pair.body);
    const indexes = def?.indexes;
    if (!Array.isArray(indexes)) return;
    const tablePath = `/types/${ti}/${pair.key}`;
    const local = tables.get(pair.key);
    const known = new Set<string>(local?.fields.keys() ?? []);
    const companion = companionFields?.get(pair.key);
    if (companion) {
      for (const name of companion.keys()) known.add(name);
    }
    const seenIndexes = new Set<string>();
    indexes.forEach((index, ii) => {
      const ip = singleKey(index);
      if (!ip) return;
      const indexPath = `${tablePath}/indexes/${ii}/${ip.key}`;
      if (
        !pushUnique(
          seenIndexes,
          ip.key,
          errors,
          parsed,
          indexPath,
          `duplicate index '${ip.key}' on ${pair.key}`,
        )
      ) {
        return;
      }
      const cols = asRecord(ip.body)?.fields;
      if (!Array.isArray(cols)) return;
      cols.forEach((col, ci) => {
        if (typeof col !== "string") return;
        if (known.has(col)) return;
        errors.push(
          specErr(
            parsed,
            `${indexPath}/fields/${ci}`,
            `unknown field '${col}' on ${pair.key} in index '${ip.key}'`,
          ),
        );
      });
    });
  });
  return errors;
}

function checkCompanionTypes(
  parsed: ParsedYaml,
  companion: unknown,
): SpecValidationResult["errors"] {
  const errors: SpecValidationResult["errors"] = [];
  const typeFields = indexTypeFields(companion);
  const types = asRecord(parsed.data)?.types;
  if (!Array.isArray(types)) return errors;
  types.forEach((entry, ti) => {
    const pair = singleKey(entry);
    if (!pair) return;
    const tablePath = `/types/${ti}/${pair.key}`;
    if (!typeFields.has(pair.key)) {
      errors.push(
        specErr(
          parsed,
          tablePath,
          `unknown type '${pair.key}' (not in types.yaml)`,
        ),
      );
      return;
    }
    const known = typeFields.get(pair.key)!;
    const fields = asRecord(pair.body)?.fields;
    if (!Array.isArray(fields)) return;
    fields.forEach((field, fi) => {
      const fp = singleKey(field);
      if (!fp) return;
      if (known.has(fp.key)) return;
      errors.push(
        specErr(
          parsed,
          `${tablePath}/fields/${fi}/${fp.key}`,
          `unknown field '${fp.key}' on ${pair.key} (not in types.yaml)`,
        ),
      );
    });
  });
  return errors;
}

export function checkDatasourceModel(
  parsed: ParsedYaml,
  companionTypes?: unknown,
): SpecValidationResult {
  const { tables, errors } = collectTables(parsed);
  const companionFields =
    companionTypes !== undefined ? indexTypeFields(companionTypes) : undefined;
  errors.push(...checkIndexes(parsed, tables, companionFields));
  if (companionTypes !== undefined) {
    errors.push(...checkCompanionTypes(parsed, companionTypes));
  }
  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}
