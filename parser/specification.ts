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
  isId?: boolean;
  size?: number | [number, number] | "unlimited";
  minSize?: number;
  references?: string | [string, string];
  hasDefault?: boolean;
  defaultValue?: string | number | boolean | null;
};

/** Primary label. `inherit` may also carry `union` — those members compose. */
export type TypeKind = "inherit" | "union" | "shaped";

export type Type = {
  name: string;
  tags: string[];
  kind: TypeKind;
  inherits?: string;
  union?: string[];
  mapping?: Record<string, string>;
  removeFields?: string[];
  ids?: string[];
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

type IdentityType = Pick<Type, "inherits" | "fields" | "ids">;

export const hasAuthoredIdentity = (type: IdentityType): boolean =>
  (type.ids !== undefined && type.ids.length > 0) ||
  type.fields.some((f) => f.isId === true);

export const identityColumns = (type?: IdentityType): string[] => {
  if (!type) return ["id"];
  if (type.ids !== undefined && type.ids.length > 0) return [...type.ids];
  const marked = type.fields.filter((f) => f.isId === true).map((f) => f.name);
  if (marked.length > 0) return marked;
  if (type.inherits === "set") return ["id"];
  return [];
};

export const primaryKeyColumn = (
  _table: DatasourceTable | undefined,
  type?: Type,
): string => identityColumns(type)[0] ?? "id";

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
  for (const name of identityColumns(type)) add(name);
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

const builtInFields = (name: string): TypeField[] | undefined => {
  if (name === "set") {
    return [field("id", "integer")];
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

type SourcedField = TypeField & { source?: string };

const withSource = (fields: TypeField[], source: string): SourcedField[] =>
  fields.map((f) => ({ ...f, source }));

const publicField = (field: SourcedField): TypeField => {
  const { source: _source, ...rest } = field;
  return rest;
};

/** Bare `id` drops every field named `id`. Qualified `contact_source.id` drops `id` only from that source. */
const shouldDrop = (field: SourcedField, remove: string[]): boolean => {
  for (const item of remove) {
    const dot = item.indexOf(".");
    if (dot === -1) {
      if (field.name === item) return true;
      continue;
    }
    if (
      field.name === item.slice(dot + 1) &&
      field.source === item.slice(0, dot)
    ) {
      return true;
    }
  }
  return false;
};

const dropFields = (
  fields: SourcedField[],
  remove?: string[],
): TypeField[] => {
  const kept = !remove?.length
    ? fields
    : fields.filter((f) => !shouldDrop(f, remove));
  return kept.map(publicField);
};

export const expandTypes = (types: Type[]): Type[] => {
  const byName = new Map(types.map((t) => [t.name, t]));
  const cache = new Map<string, TypeField[]>();

  const resolve = (name: string, stack: Set<string>): TypeField[] => {
    const hit = cache.get(name);
    if (hit) return hit;
    const builtin = builtInFields(name);
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
    let inherited: SourcedField[] = [];
    if (type.inherits) {
      inherited =
        type.inherits === "set" && hasAuthoredIdentity(type)
          ? []
          : withSource(resolve(type.inherits, stack), type.inherits);
    }
    for (const member of type.union ?? []) {
      inherited = [
        ...inherited,
        ...withSource(resolve(member, stack), member),
      ];
    }
    stack.delete(name);
    const merged = [
      ...dropFields(renameFields(inherited, type.mapping), type.removeFields),
      ...type.fields,
    ];
    cache.set(name, merged);
    return merged;
  };

  const resolveIds = (name: string, stack: Set<string>): string[] | undefined => {
    if (stack.has(name)) return undefined;
    const type = byName.get(name);
    if (!type) return undefined;
    if (type.ids !== undefined && type.ids.length > 0) return type.ids;
    if (type.fields.some((f) => f.isId === true)) return undefined;
    if (
      type.inherits &&
      type.inherits !== "set" &&
      type.inherits !== "dictionary"
    ) {
      stack.add(name);
      const ids = resolveIds(type.inherits, stack);
      stack.delete(name);
      return ids;
    }
    return undefined;
  };

  return types.map((type) => {
    const ids = type.ids ?? resolveIds(type.name, new Set());
    return {
      ...type,
      ...(ids !== undefined && ids.length > 0 ? { ids } : {}),
      fields: resolve(type.name, new Set()),
    };
  });
};

export const typeHasTag = (type: Type, tag: string): boolean =>
  type.tags.includes(tag);
