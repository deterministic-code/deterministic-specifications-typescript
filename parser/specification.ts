export const DATASOURCE_TYPES_YAML = "datasource_types.yaml";
export const DATASOURCE_SEEDS_YAML = "datasource_seeds.yaml";
export const VIEW_TYPES_YAML = "view_types.yaml";
export const SERVICES_YAML = "services.yaml";
export const ROUTES_YAML = "routes.yaml";

export type SeedValue = string | number | boolean | null;

export type SeedRow = {
  id: number;
  row: Record<string, SeedValue>;
};

export type DatasourceField = {
  name: string;
  type: string;
  isNullable: boolean;
  references?: string;
  isPrimaryKey?: boolean;
  isUnique?: boolean;
  minSize?: number;
  size?: number;
  /** Present when the YAML author set `default_value` (including `null`). */
  hasDefault?: boolean;
  defaultValue?: string | number | boolean | null;
};

export type DatasourceIndex = {
  name: string;
  fields: string[];
  isUnique: boolean;
};

export type DatasourceType = {
  name: string;
  datasourceType: string;
  fields: DatasourceField[];
  /** Single-column unique index field names (from `indexes:`). */
  uniqueIndexFields: string[];
  indexes: DatasourceIndex[];
  skipMigrations: boolean;
  target?: string | null;
  optimisticConcurrency?: boolean;
};

export type ViewFieldKind = "primitive" | "datasource" | "view";

export type ViewField = {
  name: string;
  type: string;
  kind: ViewFieldKind;
  base: string;
  isArray: boolean;
  isNullable: boolean;
  size?: number;
  minSize?: number;
};

export type ViewEnrichment = {
  fkColumn: string;
  prefix: string;
  targetTable: string;
  newField: string;
  targetIsReadonlyLookup: boolean;
  isNullable: boolean;
};

export type ShapedView = {
  kind: "shaped";
  name: string;
  inherits: string | null;
  fields: ViewField[];
  enrichments: ViewEnrichment[];
  omit: string[];
};

export type UnionView = {
  kind: "union";
  name: string;
  members: string[];
};

export type ViewType = ShapedView | UnionView;

export type ServiceByField = {
  field: string;
  type: string;
  size?: number;
};

export type ServiceCandidate = {
  name: string;
  kind: "datasource_type" | "view_type";
  inheritsNamespace: string;
  datasourceType: string | null;
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
  kind: "datasource_type" | "view_type";
  inheritsNamespace: string;
  datasourceType: string;
  target: string | null;
  optimisticConcurrency?: boolean;
  byFields: RouteByField[];
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
  datasources: DatasourceType[];
};

const PRIMITIVES = new Set([
  "string",
  "character",
  "number",
  "integer",
  "smallinteger",
  "biginteger",
  "float",
  "decimal",
  "boolean",
  "datetime",
  "binary",
  "uuid",
  "reference",
]);
const DS_PREFIX = "datasource_types.";

export const parseFieldType = (
  raw: string,
): { kind: ViewFieldKind; base: string; isArray: boolean } => {
  const isArray = raw.endsWith("[]");
  const base = isArray ? raw.slice(0, -2) : raw;
  if (PRIMITIVES.has(base)) return { kind: "primitive", base, isArray };
  if (base.startsWith(DS_PREFIX)) {
    return { kind: "datasource", base: base.slice(DS_PREFIX.length), isArray };
  }
  return { kind: "view", base, isArray };
};

const PROJECT_ID_TYPES = new Set(["integer", "biginteger", "uuid", "string"]);

/** Project `datasource.id_type`, or `integer` when the setting is missing/unknown. */
export const resolvedProjectIdType = (raw: string): string =>
  PROJECT_ID_TYPES.has(raw) ? raw : "integer";

/** Declared `primary_key` column, otherwise `id`. */
export const primaryKeyColumn = (
  type: DatasourceType | undefined,
): string => type?.fields.find((f) => f.isPrimaryKey === true)?.name ?? "id";

/** Unique lookup columns: `is_unique` fields plus single-column unique indexes. */
export const uniqueLookupFields = (
  type: DatasourceType,
): ServiceByField[] => {
  const out: ServiceByField[] = [];
  const add = (name: string) => {
    if (out.some((e) => e.field === name)) return;
    const f = type.fields.find((x) => x.name === name);
    out.push({
      field: name,
      type: f?.type ?? "string",
      ...(f?.size !== undefined ? { size: f.size } : {}),
    });
  };
  for (const f of type.fields) {
    if (f.isUnique) add(f.name);
  }
  for (const name of type.uniqueIndexFields) add(name);
  return out;
};

const ID_FIELD_TYPE: Record<string, string> = {
  integer: "integer",
  biginteger: "biginteger",
  uuid: "uuid",
  string: "string",
};

/** Spec type a type-less `references: X.id` inherits from `datasource.id_type`. */
export const inheritedIdType = (idType: string): string =>
  ID_FIELD_TYPE[idType] ?? "number";

export type SystemColumn = {
  name: string;
  type: string;
  isNullable: boolean;
};

const systemColumns = (idType: string): SystemColumn[] => [
  { name: "id", type: inheritedIdType(idType), isNullable: false },
  ...(idType !== "uuid"
    ? [{ name: "uuid", type: "uuid", isNullable: false }]
    : []),
  { name: "created", type: "datetime", isNullable: false },
  { name: "updated", type: "datetime", isNullable: false },
];

const declaredFields = <T extends { name: string }>(
  fields: T[],
  idType: string,
): T[] => (idType === "uuid" ? fields.filter((f) => f.name !== "uuid") : fields);

const STANDARD_TABLE_FIELD_NAMES = ["id", "created", "updated"] as const;

const isStandardTableFieldName = (name: string): boolean =>
  (STANDARD_TABLE_FIELD_NAMES as readonly string[]).includes(name);

const injectedDatasourceFields = (idType: string): DatasourceField[] =>
  systemColumns(idType).map((col) => ({
    name: col.name,
    type: col.type,
    isNullable: col.isNullable,
    ...(col.name === "id" ? { isPrimaryKey: true } : {}),
  }));

const hasCustomPrimaryKey = (type: DatasourceType): boolean =>
  type.fields.some((f) => f.isPrimaryKey === true && f.name !== "id");

const hasAnyPrimaryKey = (type: DatasourceType): boolean =>
  type.fields.some((f) => f.isPrimaryKey === true);

/** Audit columns (`uuid` / `created` / `updated`) follow SQL DDL rules. */
const tableGetsAuditColumns = (
  type: DatasourceType,
  useOptimisticConcurrency: boolean,
): boolean => {
  if (type.datasourceType === "readonly-lookup") return false;
  if (!hasCustomPrimaryKey(type)) return true;
  if (type.datasourceType === "many-to-many") return false;
  return type.optimisticConcurrency ?? useOptimisticConcurrency;
};

/** Full column list: StandardTable columns plus declared fields (including references). */
export const expandDatasourceTypes = (
  types: DatasourceType[],
  idType: string,
  useOptimisticConcurrency = true,
): DatasourceType[] => {
  const projectIdType = resolvedProjectIdType(idType);
  for (const type of types) {
    const collision = type.fields.find((f) => isStandardTableFieldName(f.name));
    if (collision !== undefined) {
      throw new Error(
        `datasource type "${type.name}" field "${collision.name}" collides with a StandardTable column (id, created, updated)`,
      );
    }
  }
  return types.map((type) => {
    const standard = injectedDatasourceFields(projectIdType);
    const injected: DatasourceField[] = [];
    if (!hasAnyPrimaryKey(type)) {
      injected.push(...standard.filter((f) => f.name === "id"));
    }
    if (tableGetsAuditColumns(type, useOptimisticConcurrency)) {
      injected.push(...standard.filter((f) => f.name !== "id"));
    }
    const seen = new Set(injected.map((f) => f.name));
    return {
      ...type,
      fields: [
        ...injected,
        ...declaredFields(type.fields, projectIdType).filter((f) => !seen.has(f.name)),
      ],
    };
  });
};

const asViewField = (field: DatasourceField): ViewField => ({
  name: field.name,
  type: field.type,
  kind: "primitive",
  base: field.type,
  isArray: false,
  isNullable: field.isNullable,
  ...(field.size !== undefined ? { size: field.size } : {}),
  ...(field.minSize !== undefined ? { minSize: field.minSize } : {}),
});

/** Inherited columns inlined; enrichment FK columns omitted. */
export const expandViewTypes = (
  views: ViewType[],
  datasources: DatasourceType[],
): ViewType[] => {
  const byName = new Map(datasources.map((t) => [t.name, t]));
  return views.map((view) => {
    if (view.kind !== "shaped") return view;
    const parent =
      view.inherits !== null ? byName.get(view.inherits) : undefined;
    const omit = new Set([
      ...view.omit,
      ...view.enrichments.map((e) => e.fkColumn),
    ]);
    const inherited =
      parent === undefined
        ? []
        : parent.fields.filter((f) => !omit.has(f.name)).map(asViewField);
    return {
      ...view,
      fields: [...inherited, ...view.fields],
    };
  });
};
