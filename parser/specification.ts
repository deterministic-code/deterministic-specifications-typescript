export const TYPES_YAML = "types.yaml";
export const DATASOURCE_YAML = "datasource.yaml";
export const DATASOURCE_SEEDS_YAML = "datasource_seeds.yaml";
export const SERVICES_YAML = "services.yaml";
export const ROUTES_YAML = "routes.yaml";

export type SeedValue = string | number | boolean | null;

export type SeedRow = {
  id: number;
  row: Record<string, SeedValue>;
};

export type FieldKind = "primitive" | "type";

export type TypeField = {
  name: string;
  type: string;
  kind: FieldKind;
  base: string;
  isArray: boolean;
  isNullable: boolean;
  size?: number | [number, number] | "unlimited";
  minSize?: number;
  references?: string | [string, string];
  hasDefault?: boolean;
  defaultValue?: string | number | boolean | null;
};

export type TypeKind = "inherit" | "union" | "one_of" | "shaped";

export type Type = {
  name: string;
  tags: string[];
  kind: TypeKind;
  inherits?: string;
  union?: string[];
  oneOf?: string[];
  mapping?: Record<string, string>;
  removeFields?: string[];
  fields: TypeField[];
};

export type DatasourceFieldOverlay = {
  name: string;
  isReadonly?: boolean;
  isUnique?: boolean;
  mapping?: string;
  isFixedId?: boolean;
};

export type DatasourceIndex = {
  name: string;
  fields: string[];
  isUnique: boolean;
};

export type DatasourceTable = {
  name: string;
  mapping?: string;
  useOptimisticConcurrency?: boolean;
  fields: DatasourceFieldOverlay[];
  indexes: DatasourceIndex[];
  uniqueIndexFields: string[];
};

export type ServiceByField = {
  field: string;
  type: string;
  size?: number;
};

export type ServiceCandidate = {
  name: string;
  tags: string[];
  inherits?: string;
  byFields: ServiceByField[];
};

export type CustomServiceEntry = {
  name: string;
  module?: string;
  methods: string[];
};

export type ParsedServices = {
  generics: ServiceCandidate[];
  customs: CustomServiceEntry[];
};

export type RouteByField = {
  byField: string;
  methods?: string[];
  byFieldUnique: boolean;
};

export type RouteCandidate = {
  name: string;
  tags: string[];
  inherits?: string;
  byFields: RouteByField[];
  eagerReadPath?: string[];
  eagerUpdatePath?: string[];
  eagerReadMemberOnly?: string[];
};

export type CustomRouteEntry = {
  name: string;
  path?: string;
  method?: string;
  entity: string | null;
  request?: string;
  response?: string;
  module?: string;
  routeClass?: string;
};

export type DirectFkDescriptor = {
  kind: "direct-fk";
  parent: string;
  parentParam: string;
  parentBasePath: string;
  child: { name: string };
  fkColumn: string;
  segment: string;
  segmentTail: string;
};

export type M2mDescriptor = {
  kind: "m2m";
  parent: string;
  parentParam: string;
  parentBasePath: string;
  junction: string;
  target: string;
  targetParam: string;
  parentFkField: string;
  childFkField: string;
  segment: string;
  segmentTail: string;
};

export type NestedRouteDescriptor = DirectFkDescriptor | M2mDescriptor;

export type ParsedRoutes = {
  candidates: RouteCandidate[];
  customs: CustomRouteEntry[];
  nested: NestedRouteDescriptor[];
  childrenOnly: Set<string>;
  datasource: DatasourceTable[];
};

const PRIMITIVES = new Set([
  "string",
  "character",
  "number",
  "integer",
  "unsignedinteger",
  "biginteger",
  "unsignedbiginteger",
  "smallinteger",
  "unsignedsmallinteger",
  "float",
  "decimal",
  "boolean",
  "datetime",
  "binary",
  "uuid",
  "reference",
]);

export const parseFieldType = (
  raw: string,
): { kind: FieldKind; base: string; isArray: boolean } => {
  const isArray = raw.endsWith("[]");
  const base = isArray ? raw.slice(0, -2) : raw;
  if (PRIMITIVES.has(base)) return { kind: "primitive", base, isArray };
  return { kind: "type", base, isArray };
};

const PROJECT_ID_TYPES = new Set(["integer", "biginteger", "uuid", "string"]);

export const resolvedProjectIdType = (raw: string): string =>
  PROJECT_ID_TYPES.has(raw) ? raw : "integer";

const ID_FIELD_TYPE: Record<string, string> = {
  integer: "integer",
  biginteger: "biginteger",
  uuid: "uuid",
  string: "string",
};

export const inheritedIdType = (idType: string): string =>
  ID_FIELD_TYPE[idType] ?? "number";

export const primaryKeyColumn = (
  table: DatasourceTable | undefined,
  type?: Type,
): string => {
  const fixed = table?.fields.find((f) => f.isFixedId);
  if (fixed) return fixed.name;
  if (type?.inherits === "set") return "id";
  return "id";
};

export const uniqueLookupFields = (
  type: Type,
  table?: DatasourceTable,
): ServiceByField[] => {
  const out: ServiceByField[] = [];
  const add = (name: string) => {
    if (out.some((e) => e.field === name)) return;
    const f = type.fields.find((x) => x.name === name);
    out.push({
      field: name,
      type: typeof f?.type === "string" ? f.type : "string",
      ...(typeof f?.size === "number" ? { size: f.size } : {}),
    });
  };
  if (type.inherits === "set" || table?.fields.some((f) => f.isFixedId)) {
    add(primaryKeyColumn(table, type));
  }
  for (const overlay of table?.fields ?? []) {
    if (overlay.isUnique) add(overlay.name);
  }
  for (const name of table?.uniqueIndexFields ?? []) add(name);
  return out;
};

const field = (
  name: string,
  type: string,
  extras: Partial<TypeField> = {},
): TypeField => {
  const parsed = parseFieldType(type);
  return {
    name,
    type,
    kind: parsed.kind,
    base: parsed.base,
    isArray: parsed.isArray,
    isNullable: false,
    ...extras,
  };
};

const builtInFields = (name: string, idType: string): TypeField[] | undefined => {
  if (name === "set") {
    return [field("id", inheritedIdType(idType))];
  }
  if (name === "dictionary") {
    return [field("name", "string"), field("value", "string")];
  }
  return undefined;
};

const renameFields = (
  fields: TypeField[],
  mapping?: Record<string, string>,
): TypeField[] => {
  if (!mapping) return fields;
  return fields.map((f) =>
    mapping[f.name] ? { ...f, name: mapping[f.name]! } : f,
  );
};

const dropFields = (fields: TypeField[], remove?: string[]): TypeField[] => {
  if (!remove?.length) return fields;
  const drop = new Set(remove);
  return fields.filter((f) => !drop.has(f.name));
};

export const expandTypes = (types: Type[], idType: string): Type[] => {
  const projectIdType = resolvedProjectIdType(idType);
  const byName = new Map(types.map((t) => [t.name, t]));
  const cache = new Map<string, TypeField[]>();

  const resolve = (name: string, stack: Set<string>): TypeField[] => {
    const hit = cache.get(name);
    if (hit) return hit;
    const builtin = builtInFields(name, projectIdType);
    if (builtin) {
      cache.set(name, builtin);
      return builtin;
    }
    if (stack.has(name)) {
      throw new Error(`circular inherit/union involving "${name}"`);
    }
    const type = byName.get(name);
    if (!type) return [];
    stack.add(name);
    let inherited: TypeField[] = [];
    if (type.kind === "inherit" && type.inherits) {
      inherited = resolve(type.inherits, stack);
    } else if (type.kind === "union") {
      for (const member of type.union ?? []) {
        inherited = [...inherited, ...resolve(member, stack)];
      }
    }
    stack.delete(name);
    const merged = [
      ...dropFields(renameFields(inherited, type.mapping), type.removeFields),
      ...type.fields,
    ];
    cache.set(name, merged);
    return merged;
  };

  return types.map((type) => ({
    ...type,
    fields:
      type.kind === "one_of" ? type.fields : resolve(type.name, new Set()),
  }));
};

export const typeHasTag = (type: Type, tag: string): boolean =>
  type.tags.includes(tag);
