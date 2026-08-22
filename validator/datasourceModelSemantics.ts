import { asRecord } from "./yamlPositions.ts";
import type { SpecValidationResult } from "./types.ts";
import type { ParsedYaml } from "./SpecValidator.ts";
import { pushUnique, singleKey, specErr } from "./semanticsUtil.ts";

type Target = "StandardCrud" | "Crud" | "None";

type TableInfo = {
  path: string;
  target: Target;
  fields: Map<string, string>;
};

const IMPLICIT = ["id", "created", "updated"] as const;

function effectiveTarget(def: Record<string, unknown>): Target {
  const raw = def.target;
  if (raw === "Crud" || raw === "None" || raw === "StandardCrud") return raw;
  return "StandardCrud";
}

function collectTables(
  parsed: ParsedYaml,
): { tables: Map<string, TableInfo>; errors: SpecValidationResult["errors"] } {
  const errors: SpecValidationResult["errors"] = [];
  const tables = new Map<string, TableInfo>();
  const types = asRecord(parsed.data)?.types;
  if (!Array.isArray(types)) return { tables, errors };

  const seenTypes = new Set<string>();
  types.forEach((entry, ti) => {
    const pair = singleKey(entry);
    if (!pair) return;
    const tablePath = `/types/${ti}/${pair.key}`;
    if (!pushUnique(
      seenTypes,
      pair.key,
      errors,
      parsed,
      tablePath,
      `duplicate type '${pair.key}'`,
    )) {
      return;
    }
    const def = asRecord(pair.body);
    if (!def) return;
    const target = effectiveTarget(def);
    const fields = new Map<string, string>();
    const fieldList = def.fields;
    if (Array.isArray(fieldList)) {
      const seenFields = new Set<string>();
      fieldList.forEach((field, fi) => {
        const fp = singleKey(field);
        if (!fp) return;
        const fieldPath = `${tablePath}/fields/${fi}/${fp.key}`;
        if (!pushUnique(
          seenFields,
          fp.key,
          errors,
          parsed,
          fieldPath,
          `duplicate field '${fp.key}' on ${pair.key}`,
        )) {
          return;
        }
        fields.set(fp.key, fieldPath);
      });
    }
    if (target === "StandardCrud") {
      for (const name of IMPLICIT) {
        if (!fields.has(name)) fields.set(name, tablePath);
      }
    }
    tables.set(pair.key, { path: tablePath, target, fields });
  });
  return { tables, errors };
}

function checkPrimaryKeys(parsed: ParsedYaml): SpecValidationResult["errors"] {
  const errors: SpecValidationResult["errors"] = [];
  const types = asRecord(parsed.data)?.types;
  if (!Array.isArray(types)) return errors;

  types.forEach((entry, ti) => {
    const pair = singleKey(entry);
    if (!pair) return;
    const def = asRecord(pair.body);
    if (!def) return;
    const target = effectiveTarget(def);
    const fieldList = def.fields;
    if (!Array.isArray(fieldList)) return;

    const pks: string[] = [];
    fieldList.forEach((field, fi) => {
      const fp = singleKey(field);
      if (!fp) return;
      const fdef = asRecord(fp.body);
      if (fdef?.primary_key === true) {
        pks.push(`/types/${ti}/${pair.key}/fields/${fi}/${fp.key}/primary_key`);
      }
    });
    const tablePath = `/types/${ti}/${pair.key}`;
    if (pks.length > 1) {
      errors.push(
        specErr(
          parsed,
          pks[1]!,
          `type '${pair.key}' declares more than one primary_key`,
        ),
      );
    }
    if (target === "StandardCrud" && pks.length > 0) {
      errors.push(
        specErr(
          parsed,
          pks[0]!,
          `target StandardCrud cannot declare primary_key (implicit id) on '${pair.key}'`,
        ),
      );
    }
    if (target === "Crud" && pks.length !== 1) {
      errors.push(
        specErr(
          parsed,
          tablePath,
          `target Crud requires exactly one primary_key field on '${pair.key}'`,
        ),
      );
    }
  });
  return errors;
}

function checkReferencesAndIndexes(
  parsed: ParsedYaml,
  tables: Map<string, TableInfo>,
): SpecValidationResult["errors"] {
  const errors: SpecValidationResult["errors"] = [];
  const types = asRecord(parsed.data)?.types;
  if (!Array.isArray(types)) return errors;

  types.forEach((entry, ti) => {
    const pair = singleKey(entry);
    if (!pair) return;
    const def = asRecord(pair.body);
    if (!def) return;
    const tablePath = `/types/${ti}/${pair.key}`;
    const fieldList = def.fields;
    if (Array.isArray(fieldList)) {
      fieldList.forEach((field, fi) => {
        const fp = singleKey(field);
        if (!fp) return;
        const fdef = asRecord(fp.body);
        const ref = fdef?.references;
        if (typeof ref !== "string") return;
        const [refTable, refCol] = ref.split(".");
        if (!refTable || !refCol) return;
        const refPath = `${tablePath}/fields/${fi}/${fp.key}/references`;
        const target = tables.get(refTable);
        if (!target) {
          errors.push(
            specErr(
              parsed,
              refPath,
              `unknown type '${refTable}' in references`,
            ),
          );
          return;
        }
        if (!target.fields.has(refCol)) {
          errors.push(
            specErr(
              parsed,
              refPath,
              `unknown field '${refCol}' on ${refTable} in references`,
            ),
          );
        }
      });
    }

    const indexes = def.indexes;
    if (!Array.isArray(indexes)) return;
    const seenIndexes = new Set<string>();
    const local = tables.get(pair.key);
    indexes.forEach((index, ii) => {
      const ip = singleKey(index);
      if (!ip) return;
      const indexPath = `${tablePath}/indexes/${ii}/${ip.key}`;
      if (!pushUnique(
        seenIndexes,
        ip.key,
        errors,
        parsed,
        indexPath,
        `duplicate index '${ip.key}' on ${pair.key}`,
      )) {
        return;
      }
      const idef = asRecord(ip.body);
      const cols = idef?.fields;
      if (!Array.isArray(cols) || !local) return;
      cols.forEach((col, ci) => {
        if (typeof col !== "string") return;
        if (local.fields.has(col)) return;
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

function checkDecimalSizes(parsed: ParsedYaml): SpecValidationResult["errors"] {
  const errors: SpecValidationResult["errors"] = [];
  const types = asRecord(parsed.data)?.types;
  if (!Array.isArray(types)) return errors;
  types.forEach((entry, ti) => {
    const pair = singleKey(entry);
    if (!pair) return;
    const fields = asRecord(pair.body)?.fields;
    if (!Array.isArray(fields)) return;
    fields.forEach((field, fi) => {
      const fp = singleKey(field);
      if (!fp) return;
      const fdef = asRecord(fp.body);
      if (fdef?.type !== "decimal") return;
      const size = fdef.size;
      if (!Array.isArray(size) || size.length !== 2) return;
      const precision = size[0];
      const scale = size[1];
      if (typeof precision !== "number" || typeof scale !== "number") return;
      const path = `/types/${ti}/${pair.key}/fields/${fi}/${fp.key}/size`;
      if (precision < 1) {
        errors.push(
          specErr(parsed, path, "decimal size precision must be >= 1"),
        );
      }
      if (scale > precision) {
        errors.push(
          specErr(
            parsed,
            path,
            `decimal size scale must be <= precision (${precision})`,
          ),
        );
      }
    });
  });
  return errors;
}

export function checkDatasourceModel(parsed: ParsedYaml): SpecValidationResult {
  const { tables, errors } = collectTables(parsed);
  errors.push(...checkPrimaryKeys(parsed));
  errors.push(...checkReferencesAndIndexes(parsed, tables));
  errors.push(...checkDecimalSizes(parsed));
  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}
