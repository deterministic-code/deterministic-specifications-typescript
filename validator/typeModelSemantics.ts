import { asRecord } from "./yamlPositions.ts";
import type { SpecValidationResult } from "./types.ts";
import type { ParsedYaml } from "./SpecValidator.ts";
import { pushUnique, singleKey, specErr } from "./semanticsUtil.ts";

const BUILT_IN: Record<string, readonly string[]> = {
  set: ["id"],
  dictionary: ["name", "value"],
};

/** Primary label. `inherit` may also carry `union` — those members compose. */
type TypeKind = "inherit" | "union" | "shaped";

type TypeInfo = {
  path: string;
  kind: TypeKind;
  inherits?: string;
  union?: string[];
  mapping?: Record<string, string>;
  mappingPath?: string;
  removeFields?: string[];
  removeFieldsPath?: string;
  ids?: string[];
  idFields: string[];
  fields: Map<string, string>;
};

const hasAuthoredIdentity = (info: TypeInfo): boolean =>
  (info.ids !== undefined && info.ids.length > 0) || info.idFields.length > 0;

function typeKind(def: Record<string, unknown>): TypeKind {
  if (typeof def.inherits === "string") return "inherit";
  if (Array.isArray(def.union)) return "union";
  return "shaped";
}

function mappingOf(
  def: Record<string, unknown>,
): Record<string, string> | undefined {
  const rec = asRecord(def.mapping);
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}

/** Bare `id` or qualified `contact_source.id`. */
function splitRemoveField(entry: string): { source?: string; name: string } {
  const dot = entry.indexOf(".");
  if (dot === -1) return { name: entry };
  return { source: entry.slice(0, dot), name: entry.slice(dot + 1) };
}

function collectTypes(
  parsed: ParsedYaml,
): { types: Map<string, TypeInfo>; errors: SpecValidationResult["errors"] } {
  const errors: SpecValidationResult["errors"] = [];
  const types = new Map<string, TypeInfo>();
  const list = asRecord(parsed.data)?.types;
  if (!Array.isArray(list)) return { types, errors };

  const seen = new Set<string>();
  list.forEach((entry, ti) => {
    const pair = singleKey(entry);
    if (!pair) return;
    const path = `/types/${ti}/${pair.key}`;
    if (!pushUnique(seen, pair.key, errors, parsed, path, `duplicate type '${pair.key}'`)) {
      return;
    }
    const def = asRecord(pair.body);
    if (!def) return;
    const fields = new Map<string, string>();
    const idFields: string[] = [];
    const fieldList = def.fields;
    if (Array.isArray(fieldList)) {
      const seenFields = new Set<string>();
      fieldList.forEach((field, fi) => {
        const fp = singleKey(field);
        if (!fp) return;
        const fieldPath = `${path}/fields/${fi}/${fp.key}`;
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
        fields.set(fp.key, fieldPath);
        if (asRecord(fp.body)?.is_id === true) idFields.push(fp.key);
      });
    }
    types.set(pair.key, {
      path,
      kind: typeKind(def),
      inherits: typeof def.inherits === "string" ? def.inherits : undefined,
      union: stringList(def.union),
      mapping: mappingOf(def),
      mappingPath: def.mapping !== undefined ? `${path}/mapping` : undefined,
      removeFields: stringList(def.remove_fields),
      removeFieldsPath:
        def.remove_fields !== undefined ? `${path}/remove_fields` : undefined,
      ids: stringList(def.ids),
      idFields,
      fields,
    });
  });
  return { types, errors };
}

function inheritedNames(
  name: string,
  types: Map<string, TypeInfo>,
  stack: Set<string>,
): Set<string> | { cycle: string } {
  if (BUILT_IN[name]) return new Set(BUILT_IN[name]);
  if (stack.has(name)) return { cycle: name };
  const info = types.get(name);
  /* v8 ignore next -- callers only pass built-ins or collected type names */
  if (!info) return new Set();
  stack.add(name);
  const names = new Set<string>();
  if (info.inherits) {
    if (!(info.inherits === "set" && hasAuthoredIdentity(info))) {
      const parent = inheritedNames(info.inherits, types, stack);
      if ("cycle" in parent) return parent;
      for (const n of parent) names.add(n);
    }
  }
  for (const member of info.union ?? []) {
    const part = inheritedNames(member, types, stack);
    if ("cycle" in part) return part;
    for (const n of part) names.add(n);
  }
  stack.delete(name);
  if (info.mapping) {
    for (const [from, to] of Object.entries(info.mapping)) {
      if (names.delete(from)) names.add(to);
    }
  }
  for (const drop of info.removeFields ?? []) {
    names.delete(splitRemoveField(drop).name);
  }
  for (const local of info.fields.keys()) names.add(local);
  return names;
}

function checkComposition(
  parsed: ParsedYaml,
  types: Map<string, TypeInfo>,
): SpecValidationResult["errors"] {
  const errors: SpecValidationResult["errors"] = [];
  for (const [name, info] of types) {
    const sources: string[] = [];
    if (info.inherits) {
      if (!BUILT_IN[info.inherits] && !types.has(info.inherits)) {
        errors.push(
          specErr(
            parsed,
            `${info.path}/inherits`,
            `unknown inherit target '${info.inherits}' on ${name}`,
          ),
        );
      } else {
        sources.push(info.inherits);
      }
    }
    info.union?.forEach((member, i) => {
      if (BUILT_IN[member] || types.has(member)) {
        sources.push(member);
        return;
      }
      errors.push(
        specErr(
          parsed,
          `${info.path}/union/${i}`,
          `unknown type '${member}' in union on ${name}`,
        ),
      );
    });

    const available = new Set<string>();
    for (const src of sources) {
      if (src === "set" && hasAuthoredIdentity(info)) continue;
      const part = inheritedNames(src, types, new Set([name]));
      if ("cycle" in part) {
        errors.push(
          specErr(
            parsed,
            info.path,
            `circular inherit/union involving '${part.cycle}'`,
          ),
        );
        continue;
      }
      for (const n of part) available.add(n);
    }

    if (info.mapping) {
      Object.keys(info.mapping).forEach((from) => {
        if (available.has(from)) return;
        errors.push(
          specErr(
            parsed,
            `${info.mappingPath}/${from}`,
            `mapping '${from}' is not a field on the inherited or unioned shape of ${name}`,
          ),
        );
      });
    }
    const composeSources = new Set<string>();
    if (info.inherits) composeSources.add(info.inherits);
    for (const member of info.union ?? []) composeSources.add(member);

    info.removeFields?.forEach((field, i) => {
      const path = `${info.removeFieldsPath}/${i}`;
      const ref = splitRemoveField(field);
      if (ref.source === undefined) {
        if (available.has(ref.name)) return;
        errors.push(
          specErr(
            parsed,
            path,
            `remove_fields '${field}' is not a field on the inherited or unioned shape of ${name}`,
          ),
        );
        return;
      }
      if (!BUILT_IN[ref.source] && !types.has(ref.source)) {
        errors.push(
          specErr(
            parsed,
            path,
            `unknown type '${ref.source}' in remove_fields on ${name}`,
          ),
        );
        return;
      }
      if (!composeSources.has(ref.source)) {
        errors.push(
          specErr(
            parsed,
            path,
            `remove_fields '${field}' is not from an inherit or union source of ${name}`,
          ),
        );
        return;
      }
      const part = inheritedNames(ref.source, types, new Set([name]));
      if ("cycle" in part) return;
      if (part.has(ref.name)) return;
      errors.push(
        specErr(
          parsed,
          path,
          `remove_fields '${field}' is not a field on ${ref.source}`,
        ),
      );
    });
  }
  return errors;
}

function fieldNamesOf(
  name: string,
  types: Map<string, TypeInfo>,
): Set<string> {
  if (BUILT_IN[name]) return new Set(BUILT_IN[name]);
  const resolved = inheritedNames(name, types, new Set());
  return "cycle" in resolved ? new Set() : resolved;
}

function checkReferences(
  parsed: ParsedYaml,
  types: Map<string, TypeInfo>,
): SpecValidationResult["errors"] {
  const errors: SpecValidationResult["errors"] = [];
  const list = asRecord(parsed.data)?.types;
  if (!Array.isArray(list)) return errors;

  const checkRef = (ref: string, refPath: string, checkField: boolean) => {
    const [refType, refCol] = ref.split(".");
    if (!refType || !refCol) return;
    if (!types.has(refType) && !BUILT_IN[refType]) {
      errors.push(
        specErr(parsed, refPath, `unknown type '${refType}' in references`),
      );
      return;
    }
    if (
      checkField &&
      refCol !== "id" &&
      !fieldNamesOf(refType, types).has(refCol)
    ) {
      errors.push(
        specErr(
          parsed,
          refPath,
          `unknown field '${refCol}' on ${refType} in references`,
        ),
      );
    }
  };

  const isTypeName = (raw: unknown): boolean => {
    if (typeof raw !== "string") return false;
    const base = raw.endsWith("[]") ? raw.slice(0, -2) : raw;
    return types.has(base);
  };

  list.forEach((entry, ti) => {
    const pair = singleKey(entry);
    if (!pair) return;
    const fields = asRecord(pair.body)?.fields;
    if (!Array.isArray(fields)) return;
    fields.forEach((field, fi) => {
      const fp = singleKey(field);
      if (!fp) return;
      const body = asRecord(fp.body);
      const ref = body?.references;
      const refPath = `/types/${ti}/${pair.key}/fields/${fi}/${fp.key}/references`;
      const checkField = !isTypeName(body?.type);
      if (typeof ref === "string") {
        checkRef(ref, refPath, checkField);
        return;
      }
      if (!Array.isArray(ref)) return;
      ref.forEach((item, i) => {
        if (typeof item === "string") checkRef(item, `${refPath}/${i}`, checkField);
      });
    });
  });
  return errors;
}

function checkDecimalSizes(parsed: ParsedYaml): SpecValidationResult["errors"] {
  const errors: SpecValidationResult["errors"] = [];
  const list = asRecord(parsed.data)?.types;
  if (!Array.isArray(list)) return errors;
  list.forEach((entry, ti) => {
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

function checkIdentity(
  parsed: ParsedYaml,
  types: Map<string, TypeInfo>,
): SpecValidationResult["errors"] {
  const errors: SpecValidationResult["errors"] = [];
  const list = asRecord(parsed.data)?.types;
  if (!Array.isArray(list)) return errors;

  list.forEach((entry, ti) => {
    const pair = singleKey(entry);
    if (!pair) return;
    const def = asRecord(pair.body);
    if (!def) return;
    const path = `/types/${ti}/${pair.key}`;
    const idFields: string[] = [];
    const fields = def.fields;
    if (Array.isArray(fields)) {
      fields.forEach((field, fi) => {
        const fp = singleKey(field);
        if (!fp) return;
        if (asRecord(fp.body)?.is_id !== true) return;
        const fieldPath = `${path}/fields/${fi}/${fp.key}/is_id`;
        if (idFields.length > 0) {
          errors.push(
            specErr(
              parsed,
              fieldPath,
              `is_id: true may appear on at most one field on ${pair.key}`,
            ),
          );
        }
        idFields.push(fieldPath);
      });
    }
    if (Array.isArray(def.ids) && idFields.length > 0) {
      errors.push(
        specErr(
          parsed,
          `${path}/ids`,
          `ids and is_id are mutually exclusive on ${pair.key}`,
        ),
      );
    }
    if (!Array.isArray(def.ids)) return;
    const known = fieldNamesOf(pair.key, types);
    def.ids.forEach((name, i) => {
      if (typeof name !== "string") return;
      if (known.has(name)) return;
      errors.push(
        specErr(
          parsed,
          `${path}/ids/${i}`,
          `ids '${name}' is not a field on ${pair.key}`,
        ),
      );
    });
  });
  return errors;
}

export function checkTypeModel(parsed: ParsedYaml): SpecValidationResult {
  const { types, errors } = collectTypes(parsed);
  errors.push(...checkComposition(parsed, types));
  errors.push(...checkReferences(parsed, types));
  errors.push(...checkDecimalSizes(parsed));
  errors.push(...checkIdentity(parsed, types));
  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}

function typeInfoFromEntry(entry: unknown): { name: string; info: TypeInfo } | null {
  const pair = singleKey(entry);
  if (!pair) return null;
  const def = asRecord(pair.body);
  if (!def) return null;
  const fields = new Map<string, string>();
  if (Array.isArray(def.fields)) {
    def.fields.forEach((field, fi) => {
      const fp = singleKey(field);
      if (fp) fields.set(fp.key, `/types/${fp.key}/fields/${fi}`);
    });
  }
  return {
    name: pair.key,
    info: {
      path: `/types/${pair.key}`,
      kind: typeKind(def),
      inherits: typeof def.inherits === "string" ? def.inherits : undefined,
      union: stringList(def.union),
      mapping: mappingOf(def),
      removeFields: stringList(def.remove_fields),
      ids: stringList(def.ids),
      idFields: Array.isArray(def.fields)
        ? def.fields.flatMap((field) => {
            const fp = singleKey(field);
            return fp && asRecord(fp.body)?.is_id === true ? [fp.key] : [];
          })
        : [],
      fields,
    },
  };
}

export function indexTypeFields(
  data: unknown,
): Map<string, Map<string, Record<string, unknown>>> {
  const out = new Map<string, Map<string, Record<string, unknown>>>();
  const list = asRecord(data)?.types;
  if (!Array.isArray(list)) return out;
  const infos = new Map<string, TypeInfo>();
  for (const entry of list) {
    const parsed = typeInfoFromEntry(entry);
    if (parsed) infos.set(parsed.name, parsed.info);
  }
  for (const entry of list) {
    const pair = singleKey(entry);
    if (!pair) continue;
    const def = asRecord(pair.body);
    const fields = new Map<string, Record<string, unknown>>();
    for (const name of fieldNamesOf(pair.key, infos)) {
      fields.set(name, {});
    }
    if (Array.isArray(def?.fields)) {
      for (const field of def.fields) {
        const fp = singleKey(field);
        if (!fp) continue;
        fields.set(fp.key, asRecord(fp.body) ?? {});
      }
    }
    out.set(pair.key, fields);
  }
  return out;
}
