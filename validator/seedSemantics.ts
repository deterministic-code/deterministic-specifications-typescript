import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { asRecord, positionFor } from "./yamlPositions.ts";
import type {
  SpecValidationError,
  SpecValidationResult,
  ValidateOptions,
} from "./types.ts";
import type { ParsedYaml } from "./SpecValidator.ts";

const AUTO_COLUMNS = new Set(["id", "created", "updated"]);

type FieldDef = Record<string, unknown>;

type TableIndex = Map<string, Map<string, FieldDef>>;

const STRING_TYPES = new Set([
  "string",
  "character",
  "datetime",
  "uuid",
  "binary",
]);
const NUMBER_TYPES = new Set([
  "number",
  "integer",
  "unsignedinteger",
  "smallinteger",
  "unsignedsmallinteger",
  "float",
]);
const STRING_OR_NUMBER_TYPES = new Set([
  "biginteger",
  "unsignedbiginteger",
  "decimal",
]);
const INTEGER_TYPES = new Set([
  "integer",
  "unsignedinteger",
  "smallinteger",
  "unsignedsmallinteger",
]);
const UNSIGNED_TYPES = new Set([
  "unsignedinteger",
  "unsignedbiginteger",
  "unsignedsmallinteger",
]);

export async function withSiblingDatasourceTypes(
  seedsPath: string,
  options?: ValidateOptions,
): Promise<ValidateOptions> {
  if (options?.datasourceTypes !== undefined) return { ...options };
  if (options?.datasourceTypesPath) {
    return {
      ...options,
      datasourceTypes: await readFile(options.datasourceTypesPath, "utf8"),
    };
  }
  const sibling = join(dirname(seedsPath), "datasource_types.yaml");
  try {
    return { ...options, datasourceTypes: await readFile(sibling, "utf8") };
  } catch {
    return { ...options };
  }
}

function err(
  parsed: ParsedYaml,
  instancePath: string,
  message: string,
): SpecValidationError {
  const { line, col } = positionFor(parsed.doc, parsed.lineCounter, instancePath);
  return { line, col, instancePath, message };
}

function indexTypes(data: unknown): TableIndex {
  const out: TableIndex = new Map();
  const types = asRecord(data)?.types;
  if (!Array.isArray(types)) return out;
  for (const entry of types) {
    const obj = asRecord(entry);
    if (!obj) continue;
    const name = Object.keys(obj)[0];
    if (!name) continue;
    const def = asRecord(obj[name]);
    const fields = new Map<string, FieldDef>();
    if (Array.isArray(def?.fields)) {
      for (const field of def.fields) {
        const fo = asRecord(field);
        if (!fo) continue;
        const fname = Object.keys(fo)[0];
        if (!fname) continue;
        fields.set(fname, asRecord(fo[fname]) ?? {});
      }
    }
    out.set(name, fields);
  }
  return out;
}

function isOmittable(def: FieldDef): boolean {
  return def.is_nullable === true || "default_value" in def;
}

function fieldType(def: FieldDef, tables: TableIndex): string | undefined {
  if (typeof def.type === "string") return def.type;
  if (typeof def.references !== "string") return undefined;
  const [table, column] = def.references.split(".");
  if (!table || !column) return undefined;
  if (column === "id") return "number";
  const parent = tables.get(table)?.get(column);
  if (parent && typeof parent.type === "string") return parent.type;
  return "number";
}

function typeMessage(fieldTypeName: string): string {
  if (STRING_TYPES.has(fieldTypeName)) return "string";
  if (fieldTypeName === "boolean") return "boolean";
  if (STRING_OR_NUMBER_TYPES.has(fieldTypeName)) return "string or number";
  if (INTEGER_TYPES.has(fieldTypeName)) return "integer";
  return "number";
}

function valueMatchesType(value: unknown, fieldTypeName: string): boolean {
  if (STRING_TYPES.has(fieldTypeName)) return typeof value === "string";
  if (fieldTypeName === "boolean") return typeof value === "boolean";
  if (STRING_OR_NUMBER_TYPES.has(fieldTypeName)) {
    if (typeof value === "string") return true;
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (UNSIGNED_TYPES.has(fieldTypeName) && value < 0) return false;
    return true;
  }
  if (!NUMBER_TYPES.has(fieldTypeName)) return true;
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (INTEGER_TYPES.has(fieldTypeName) && !Number.isInteger(value)) return false;
  if (UNSIGNED_TYPES.has(fieldTypeName) && value < 0) return false;
  return true;
}

function seedsAreEmpty(data: unknown): boolean {
  const seeds = asRecord(data)?.seeds;
  return !Array.isArray(seeds) || seeds.length === 0;
}

export function checkSeedSemantics(
  parsed: ParsedYaml,
  typesData: unknown,
): SpecValidationResult {
  const tables = indexTypes(typesData);
  const seeds = asRecord(parsed.data)?.seeds;
  if (!Array.isArray(seeds)) return { valid: true, errors: [] };

  const errors: SpecValidationError[] = [];
  const seenTables = new Set<string>();

  seeds.forEach((entry, tableIndex) => {
    const obj = asRecord(entry);
    if (!obj) return;
    const tableName = Object.keys(obj)[0];
    if (!tableName) return;
    const tablePath = `/seeds/${tableIndex}/${tableName}`;
    if (seenTables.has(tableName)) {
      errors.push(
        err(parsed, tablePath, `duplicate seed table '${tableName}'`),
      );
      return;
    }
    seenTables.add(tableName);

    const fields = tables.get(tableName);
    if (!fields) {
      errors.push(
        err(
          parsed,
          tablePath,
          `unknown type '${tableName}' (not in datasource_types)`,
        ),
      );
      return;
    }

    const rows = obj[tableName];
    if (!Array.isArray(rows)) return;
    const seenIds = new Set<string>();
    rows.forEach((rowWrap, rowIndex) => {
      const rowObj = asRecord(rowWrap);
      if (!rowObj) return;
      const rowId = Object.keys(rowObj)[0];
      if (!rowId) return;
      const rowPath = `${tablePath}/${rowIndex}/${rowId}`;
      if (seenIds.has(rowId)) {
        errors.push(err(parsed, rowPath, `duplicate seed id '${rowId}'`));
        return;
      }
      seenIds.add(rowId);

      const row = asRecord(rowObj[rowId]) ?? {};
      for (const key of Object.keys(row)) {
        const fieldPath = `${rowPath}/${key}`;
        if (AUTO_COLUMNS.has(key)) {
          errors.push(
            err(
              parsed,
              fieldPath,
              `'${key}' is auto-injected and is not seeded here`,
            ),
          );
          continue;
        }
        const def = fields.get(key);
        if (!def) {
          errors.push(
            err(parsed, fieldPath, `unknown field '${key}' on ${tableName}`),
          );
          continue;
        }
        const value = row[key];
        if (value === null) {
          if (def.is_nullable !== true) {
            errors.push(
              err(parsed, fieldPath, `'${key}' is not nullable`),
            );
          }
          continue;
        }
        const declared = fieldType(def, tables);
        if (declared && !valueMatchesType(value, declared)) {
          errors.push(
            err(
              parsed,
              fieldPath,
              `'${key}' must be ${typeMessage(declared)}`,
            ),
          );
        }
      }

      for (const [name, def] of fields) {
        if (name in row || isOmittable(def)) continue;
        errors.push(
          err(
            parsed,
            rowPath,
            `missing required field '${name}' on ${tableName} (not nullable and has no default)`,
          ),
        );
      }
    });
  });

  return { valid: errors.length === 0, errors };
}

export function seedsNeedTypes(data: unknown): boolean {
  return !seedsAreEmpty(data);
}

export function companionTypesError(
  parsed: ParsedYaml,
  message: string,
): SpecValidationResult {
  return {
    valid: false,
    errors: [err(parsed, "/seeds", message)],
  };
}
