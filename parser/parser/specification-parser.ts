import pluralize from "pluralize";
import type { IDeterministicReader } from "../deterministic-reader.ts";
import { ensureHealth } from "../ensure-health.ts";
import { fromSettings } from "../settings.ts";
import { compileRoutesFilter, compileServicesFilter } from "./compile-filter.ts";
import { Deterministic, type IDeterministic } from "../deterministic.ts";
import {
  DATASOURCE_SEEDS_YAML,
  DATASOURCE_TYPES_YAML,
  expandDatasourceTypes,
  expandViewTypes,
  inheritedIdType,
  parseFieldType,
  resolvedProjectIdType,
  ROUTES_YAML,
  SERVICES_YAML,
  uniqueLookupFields,
  VIEW_TYPES_YAML,
  type CustomRouteEntry,
  type CustomServiceEntry,
  type DatasourceField,
  type DatasourceIndex,
  type DatasourceType,
  type DirectFkDescriptor,
  type M2mDescriptor,
  type NestedRouteDescriptor,
  type ParsedRoutes,
  type ParsedServices,
  type RouteByField,
  type RouteCandidate,
  type SeedRow,
  type SeedValue,
  type ServiceByField,
  type ServiceCandidate,
  type ViewEnrichment,
  type ViewType,
} from "../specification.ts";
import { compareByDatasourceTypeOrder } from "../datasource-type-tree.ts";
import { YamlNode } from "../yaml-node.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type { IDeterministic } from "../deterministic.ts";

type RawDatasourceField = {
  name: string;
  type: string | undefined;
  isNullable: boolean;
  references: string | undefined;
  isPrimaryKey: boolean;
  isUnique: boolean;
  minSize: number | undefined;
  size: number | undefined;
  hasDefault: boolean;
  defaultValue: string | number | boolean | null | undefined;
};

type RawDatasourceType = {
  name: string;
  datasourceType: string | undefined;
  target: string | null | undefined;
  optimisticConcurrency: boolean | undefined;
  fields: RawDatasourceField[];
  uniqueIndexFields: string[];
  indexes: DatasourceIndex[];
  skipMigrations: boolean;
};

type RawViewField = {
  name: string;
  type: string;
  isNullable: boolean;
  size: number | undefined;
  minSize: number | undefined;
};

type RawView = {
  name: string;
  inherits: string | undefined;
  oneOf: string[] | undefined;
  omit: string[];
  fields: RawViewField[];
  enrichments: ViewEnrichment[];
};

type DsDirective = {
  include: string | undefined;
  filter: string | undefined;
  autoEnrich: boolean;
};

type CombinedChildDef = { via?: string; target?: string; route?: string };
type CombinedRouteDef = {
  route?: string;
  combined_types?: Array<string | Record<string, CombinedChildDef>>;
};
type ByFieldParsed = {
  entity: string;
  byField: string;
  methods: string[] | null;
};
type NormalizedChild = {
  name: string;
  via: string | null;
  target: string | null;
  route: string | null;
};
type JunctionMatch = { name: string; parentFk: string; childFk: string };

const DS_PREFIX = "datasource_types.";
const NON_DERIVABLE = [
  "_eager_body",
  "_eager_create_body",
  "_eager_patch_body",
  "_eager_row",
  "_eager_create_row",
] as const;
const SHORTHAND_VERB_RE = /^(get|put|delete)_/i;
const VERB_TO_METHODS: Record<string, string[]> = {
  get: ["GET"],
  put: ["PUT"],
  delete: ["DELETE"],
};

const specName = (raw: string): string => raw.replace(/-/g, "_");

const shorthandField = (raw: string): string =>
  specName(raw)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();

const specPlural = (name: string): string => {
  const parts = specName(name).split("_");
  parts[parts.length - 1] = pluralize.plural(parts[parts.length - 1]!);
  return parts.join("_");
};

const parseSeedKey = (rowKey: string): number => {
  const m = /^id(\d+)$/.exec(rowKey);
  if (!m) {
    throw new Error(
      `Invalid seed row key "${rowKey}": expected pattern /^id\\d+$/`,
    );
  }
  return Number(m[1]);
};

const seedCells = (node: YamlNode): Record<string, SeedValue> => {
  const rec = node.record;
  if (rec === undefined) return {};
  const out: Record<string, SeedValue> = {};
  for (const key of Object.keys(rec)) {
    const value = node.literal(key);
    if (value !== undefined) out[key] = value;
  }
  return out;
};

/** Parses deterministic YAML into `IDeterministic`. */
export const DeterministicParser = (reader: IDeterministicReader) => {
  const parser = new Parser(reader);
  return {
    parse: (
      settings: Record<string, string>,
      opts?: { serviceClassName?: (entity: string) => string },
    ): Promise<IDeterministic> => parser.parse(settings, opts),
  };
};

class Parser {
  readonly #reader: IDeterministicReader;

  constructor(reader: IDeterministicReader) {
    this.#reader = reader;
  }

  async parse(
    settings: Record<string, string>,
    opts?: { serviceClassName?: (entity: string) => string },
  ): Promise<IDeterministic> {
    const reader = this.#reader;
    const idType = resolvedProjectIdType(
      settings["datasource.id_type"] ?? "integer",
    );
    const serviceClassName = opts?.serviceClassName ?? ((entity) => entity);
    const [hasDs, hasSeeds, hasViews, hasServices, hasRoutes] =
      await Promise.all([
        reader.exists(DATASOURCE_TYPES_YAML),
        reader.exists(DATASOURCE_SEEDS_YAML),
        reader.exists(VIEW_TYPES_YAML),
        reader.exists(SERVICES_YAML),
        reader.exists(ROUTES_YAML),
      ]);
    const [datasourceYaml, seedsYaml, viewYaml, servicesYaml, routesYaml] =
      await Promise.all([
        hasDs ? reader.read(DATASOURCE_TYPES_YAML) : Promise.resolve(undefined),
        hasSeeds
          ? reader.read(DATASOURCE_SEEDS_YAML)
          : Promise.resolve(undefined),
        hasViews ? reader.read(VIEW_TYPES_YAML) : Promise.resolve(undefined),
        hasServices ? reader.read(SERVICES_YAML) : Promise.resolve(undefined),
        hasRoutes ? reader.read(ROUTES_YAML) : Promise.resolve(undefined),
      ]);
    const datasources =
      datasourceYaml !== undefined
        ? this.#parseDatasourceTypes({ yaml: datasourceYaml, idType })
        : [];
    const seeds =
      seedsYaml !== undefined
        ? this.#parseDatasourceSeeds(seedsYaml)
        : new Map();
    const views =
      viewYaml !== undefined
        ? this.#parseViewTypes({ viewYaml, datasourceYaml })
        : [];
    const services =
      servicesYaml !== undefined
        ? this.#parseServices({
            servicesYaml,
            views,
            datasources,
            routesYaml,
            serviceClassName,
          })
        : { generics: [], customs: [] };
    const routes =
      routesYaml !== undefined
        ? this.#parseRoutes({ routesYaml, views, datasources })
        : {
            candidates: [],
            customs: [],
            nested: [],
            childrenOnly: new Set<string>(),
            datasources,
          };
    const expandedDatasourceTypes = expandDatasourceTypes(
      datasources,
      idType,
      fromSettings(settings).usesOptimisticConcurrency({}),
    );
    return ensureHealth(
      new Deterministic({
        datasourceTypes: datasources,
        datasourceSeeds: seeds,
        viewTypes: views,
        expandedDatasourceTypes,
        expandedViewTypes: expandViewTypes(views, expandedDatasourceTypes),
        services,
        routes,
      }),
    );
  }

  #parseDatasourceTypes(args: { yaml: string; idType: string }): DatasourceType[] {
    const types = this.#readDatasourceTypes(YamlNode.fromYaml(args.yaml));
    const byName = new Map(types.map((t) => [t.name, t]));
    return types.map((t) => ({
      name: t.name,
      datasourceType: t.datasourceType ?? "standard",
      uniqueIndexFields: t.uniqueIndexFields,
      indexes: t.indexes,
      skipMigrations: t.skipMigrations,
      ...(t.target !== undefined ? { target: t.target } : {}),
      ...(t.optimisticConcurrency !== undefined
        ? { optimisticConcurrency: t.optimisticConcurrency }
        : {}),
      fields: t.fields.map((field) => this.#resolvedField(field, byName, args.idType)),
    }));
  }

  #parseDatasourceSeeds(yaml: string): Map<string, SeedRow[]> {
    const byTable = new Map<string, SeedRow[]>();
    for (const { name, node } of YamlNode.fromYaml(yaml).namedList("seeds")) {
      byTable.set(
        name,
        node.namedItems().map(({ name: rowKey, node: row }) => ({
          id: parseSeedKey(rowKey),
          row: seedCells(row),
        })),
      );
    }
    return byTable;
  }

  #parseViewTypes(args: {
    viewYaml: string;
    datasourceYaml?: string;
  }): ViewType[] {
    const viewRoot = YamlNode.fromYaml(args.viewYaml);
    const directive = this.#datasourceDirective(viewRoot);
    if (directive !== undefined && args.datasourceYaml === undefined) {
      throw new Error(
        "view_types.yaml declares an includes datasource_types directive but no datasource_types.yaml was provided.",
      );
    }
    const explicit = this.#readRawViews(viewRoot);
    const dsTypes =
      args.datasourceYaml !== undefined
        ? this.#readDatasourceTypes(YamlNode.fromYaml(args.datasourceYaml))
        : [];
    const byName = new Map(dsTypes.map((t) => [t.name, t]));
    const names = new Set(explicit.map((v) => v.name));
    let views = directive
      ? [...this.#passThroughs(dsTypes, directive, names), ...explicit]
      : explicit;
    if (byName.size > 0) {
      const explicitNames = new Set(views.map((v) => v.name));
      views = views.flatMap((v) => [
        v,
        ...this.#updateVariantsFor(v, byName, explicitNames),
      ]);
    }
    if (directive?.autoEnrich) views = this.#applyAutoEnrich(views, byName);
    return views.map((view) => this.#normalizeView(view));
  }

  #parseServices(args: {
    servicesYaml: string;
    views: ViewType[];
    datasources: DatasourceType[];
    routesYaml?: string;
    serviceClassName: (entity: string) => string;
  }): ParsedServices {
    const root = YamlNode.fromYaml(args.servicesYaml);
    const rawServices = root.child("services").items().flatMap((entry) => {
      const name = entry.str("name");
      if (name === undefined) return [];
      return [{ name, module: entry.str("module") }];
    });
    const customEntries = rawServices.filter(
      (s) =>
        !(
          typeof s.module === "string" &&
          s.module.startsWith("./services/generated/")
        ),
    );
    const explicitCustomNames = new Set(customEntries.map((s) => s.name));
    const methodsByService = this.#collectRouteServiceMethods(args.routesYaml);

    const block = this.#includeBlock(root, "view_type_services");
    let generics: ServiceCandidate[] = [];
    if (block !== undefined) {
      const predicate = compileServicesFilter(block.str("filter"));
      const inheritByName = new Map(
        args.views.flatMap((view) =>
          view.kind === "shaped" ? [[view.name, view.inherits] as const] : [],
        ),
      );
      const compare = compareByDatasourceTypeOrder(
        args.datasources,
        (name) => inheritByName.get(name),
      );
      generics = this.#serviceCandidates(args.views, args.datasources)
        .filter(predicate)
        .filter((c) => !explicitCustomNames.has(args.serviceClassName(c.name)))
        .sort((a, b) => compare(a.name, b.name));
    }

    const customs: CustomServiceEntry[] = customEntries.map((entry) => ({
      name: entry.name,
      module: entry.module,
      methods: [...(methodsByService.get(entry.name) ?? [])].sort(),
    }));

    return { generics, customs };
  }

  #parseRoutes(args: {
    routesYaml: string;
    views: ViewType[];
    datasources: DatasourceType[];
  }): ParsedRoutes {
    const root = YamlNode.fromYaml(args.routesYaml);
    const dsByName = new Map(args.datasources.map((d) => [d.name, d] as const));
    const allCandidates = this.#routeCandidates(args.views, dsByName);
    const childrenOnly = this.#collectCombinedChildNames(root, dsByName);
    this.#attachByFields(allCandidates, root, dsByName);
    const customs = this.#extractCustomRoutes(root, dsByName);
    const nested = this.#collectNestedDescriptors(root, dsByName);

    const block = this.#includeBlock(root, "view_type_routes");
    let candidates: RouteCandidate[] = [];
    if (block !== undefined) {
      const predicate = compileRoutesFilter(block.str("filter"));
      const inheritByName = new Map(
        args.views.flatMap((view) =>
          view.kind === "shaped" ? [[view.name, view.inherits] as const] : [],
        ),
      );
      const compare = compareByDatasourceTypeOrder(
        args.datasources,
        (name) => inheritByName.get(name),
      );
      candidates = allCandidates
        .filter((c) => c.target !== "None")
        .filter(predicate)
        .filter((c) => !childrenOnly.has(c.name))
        .sort((a, b) => compare(a.name, b.name));
    }

    return {
      candidates,
      customs,
      nested,
      childrenOnly,
      datasources: args.datasources,
    };
  }

  #readDatasourceTypes(root: YamlNode): RawDatasourceType[] {
    return root.namedList("types").map(({ name, node }) => {
      const uniqueIndexFields: string[] = [];
      const indexes: DatasourceIndex[] = [];
      for (const { name: indexName, node: indexBody } of node.namedList(
        "indexes",
      )) {
        const rawFields = indexBody.child("fields").value;
        const fields = Array.isArray(rawFields)
          ? rawFields.filter((f): f is string => typeof f === "string")
          : [];
        indexes.push({
          name: indexName,
          fields,
          isUnique: indexBody.bool("is_unique"),
        });
        const field = this.#singleColumnUniqueIndexField(indexBody);
        if (field !== undefined && !uniqueIndexFields.includes(field)) {
          uniqueIndexFields.push(field);
        }
      }
      return {
        name,
        datasourceType: node.str("datasource_type"),
        target: node.child("target").value === null ? null : node.str("target"),
        optimisticConcurrency: node.has("use_optimistic_concurrency")
          ? node.bool("use_optimistic_concurrency")
          : undefined,
        uniqueIndexFields,
        indexes,
        skipMigrations: node.bool("skip_migrations"),
        fields: node.namedList("fields").map(({ name: fname, node: fnode }) => ({
          name: fname,
          type: fnode.str("type"),
          isNullable: fnode.bool("is_nullable"),
          references: fnode.str("references"),
          isPrimaryKey: fnode.bool("primary_key"),
          isUnique: fnode.bool("is_unique"),
          minSize: fnode.finiteNumber("min_size"),
          size: fnode.finiteNumber("size"),
          hasDefault: fnode.has("default_value"),
          defaultValue: fnode.has("default_value")
            ? fnode.literal("default_value")
            : undefined,
        })),
      };
    });
  }

  #singleColumnUniqueIndexField(body: YamlNode): string | undefined {
    if (!body.bool("is_unique")) return undefined;
    const fields = body.child("fields").value;
    if (!Array.isArray(fields) || fields.length !== 1) return undefined;
    const only = fields[0];
    return typeof only === "string" && only.length > 0 ? only : undefined;
  }

  #inheritedType(
    references: string,
    byName: Map<string, RawDatasourceType>,
    idType: string,
  ): string | undefined {
    const [parentName, column, extra] = references.split(".");
    if (extra !== undefined || !parentName || !column) return undefined;
    const parent = byName.get(parentName);
    if (parent === undefined) return undefined;
    const pk = parent.fields.find((f) => f.isPrimaryKey);
    if (pk !== undefined) return pk.name === column ? pk.type : undefined;
    return column === "id" ? inheritedIdType(idType) : undefined;
  }

  #resolvedField(
    field: RawDatasourceField,
    byName: Map<string, RawDatasourceType>,
    idType: string,
  ): DatasourceField {
    let type = field.type;
    if (type === undefined) {
      if (field.references === undefined) {
        type = "string";
      } else {
        const inherited = this.#inheritedType(field.references, byName, idType);
        if (inherited === undefined) {
          throw new Error(
            `invariant: type-less reference "${field.name}" -> "${field.references}" has no resolvable parent primary key`,
          );
        }
        type = inherited;
      }
    }
    return {
      name: field.name,
      type,
      isNullable: field.isNullable,
      references: field.references,
      ...(field.isPrimaryKey ? { isPrimaryKey: true } : {}),
      ...(field.isUnique ? { isUnique: true } : {}),
      ...(field.minSize !== undefined ? { minSize: field.minSize } : {}),
      ...(field.size !== undefined ? { size: field.size } : {}),
      ...(field.hasDefault
        ? { hasDefault: true, defaultValue: field.defaultValue }
        : {}),
    };
  }

  #datasourceDirective(viewRoot: YamlNode): DsDirective | undefined {
    for (const { name, node } of viewRoot.namedList("includes")) {
      if (name !== "datasource_types") continue;
      return {
        include: node.str("include"),
        filter: node.str("filter"),
        autoEnrich: node.bool("auto_enrich"),
      };
    }
    return undefined;
  }

  #readRawViews(viewRoot: YamlNode): RawView[] {
    return viewRoot.namedList("types").map(({ name, node }) => ({
      name,
      inherits: node.str("inherits"),
      oneOf: Array.isArray(node.child("one_of").value)
        ? node.strings("one_of")
        : undefined,
      omit: node.strings("omit"),
      fields: node.namedList("fields").map(({ name: fname, node: fnode }) => ({
        name: fname,
        type: fnode.str("type") ?? "string",
        isNullable: fnode.bool("is_nullable"),
        size: fnode.finiteInt("size"),
        minSize: fnode.finiteInt("min_size"),
      })),
      enrichments: [],
    }));
  }

  #includeMatches(include: string | undefined, name: string): boolean {
    return (
      include === undefined ||
      include === "*" ||
      include
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .includes(name)
    );
  }

  #compileDsFilter(
    filterExpr: string | undefined,
  ): (t: { name: string; datasource_type: string | null }) => boolean {
    if (filterExpr === undefined) return () => true;
    try {
      const fn = new Function("type", `return (${filterExpr});`);
      return (t) => Boolean(fn(t));
    } catch (e) {
      throw new Error(
        `datasource_types.filter is not a valid expression: ${(e as Error).message}`,
      );
    }
  }

  #inheritedTable(inherits: string | undefined): string | undefined {
    return inherits?.startsWith(DS_PREFIX)
      ? inherits.slice(DS_PREFIX.length)
      : undefined;
  }

  #parseFk(field: RawDatasourceField): string | undefined {
    if (field.type !== "number" || field.references === undefined) {
      return undefined;
    }
    const [table, column] = field.references.split(".");
    return column === "id" ? table : undefined;
  }

  #targetIsEnrichable(
    target: RawDatasourceType | undefined,
  ): target is RawDatasourceType {
    if (target === undefined) return false;
    if (target.datasourceType === "readonly-lookup") return true;
    const name = target.fields.find((f) => f.name === "name");
    return (
      name !== undefined &&
      name.type === "string" &&
      name.isUnique &&
      !name.isNullable
    );
  }

  #enrichmentsFor(
    tableName: string,
    byName: Map<string, RawDatasourceType>,
  ): ViewEnrichment[] {
    const inherited = byName.get(tableName);
    if (inherited === undefined) return [];
    return inherited.fields.flatMap((field) => {
      if (!field.name.endsWith("_id")) return [];
      const table = this.#parseFk(field);
      if (table === undefined) return [];
      const target = byName.get(table);
      if (!this.#targetIsEnrichable(target)) return [];
      const prefix = field.name.slice(0, -"_id".length);
      return [
        {
          fkColumn: field.name,
          prefix,
          targetTable: table,
          newField: `${prefix}_name`,
          targetIsReadonlyLookup: target.datasourceType === "readonly-lookup",
          isNullable: field.isNullable,
        },
      ];
    });
  }

  #applyAutoEnrich(
    views: RawView[],
    byName: Map<string, RawDatasourceType>,
  ): RawView[] {
    return views.map((view) => {
      const table = this.#inheritedTable(view.inherits);
      if (table === undefined) return view;
      const enrichments = this.#enrichmentsFor(table, byName);
      if (enrichments.length === 0) return view;
      return {
        ...view,
        enrichments,
        fields: [
          ...view.fields,
          ...enrichments.map((e) => ({
            name: e.newField,
            type: "string",
            isNullable: e.isNullable,
            size: undefined as number | undefined,
            minSize: undefined as number | undefined,
          })),
        ],
      };
    });
  }

  #isNonDerivable(name: string): boolean {
    return (
      NON_DERIVABLE.some((s) => name.endsWith(s)) ||
      name.startsWith("create_") ||
      name.startsWith("update_")
    );
  }

  #auditOmits(fields: RawDatasourceField[]): {
    updateBodyOmits: string[];
    auditOmits: string[];
    hasCustomPk: boolean;
  } {
    const declared = new Set(fields.map((f) => f.name));
    const missing = ["id", "uuid", "created", "updated"].filter(
      (n) => !declared.has(n),
    );
    const updateBodyOmits = [...missing];
    let hasCustomPk = false;
    for (const field of fields) {
      if (field.isPrimaryKey && field.name !== "id") {
        updateBodyOmits.push(field.name);
        hasCustomPk = true;
      }
    }
    return { updateBodyOmits, auditOmits: missing, hasCustomPk };
  }

  #emptyShaped(name: string, inherits: string, omit: string[]): RawView {
    return {
      name,
      inherits,
      oneOf: undefined,
      omit,
      fields: [],
      enrichments: [],
    };
  }

  #updateVariantsFor(
    view: RawView,
    byName: Map<string, RawDatasourceType>,
    explicit: Set<string>,
  ): RawView[] {
    const table = this.#inheritedTable(view.inherits);
    if (table === undefined) return [];
    const ds = byName.get(table);
    if (ds === undefined || ds.datasourceType === "readonly-lookup") return [];
    if (this.#isNonDerivable(view.name) || explicit.has(`update_${view.name}`)) {
      return [];
    }
    const omits = this.#auditOmits(ds.fields);
    const inherits = `${DS_PREFIX}${table}`;
    const out = [
      this.#emptyShaped(`update_${view.name}`, inherits, omits.updateBodyOmits),
    ];
    if (omits.hasCustomPk && !explicit.has(`create_${view.name}`)) {
      out.push(
        this.#emptyShaped(`create_${view.name}`, inherits, omits.auditOmits),
      );
    }
    return out;
  }

  #passThroughs(
    dsTypes: RawDatasourceType[],
    directive: DsDirective,
    explicit: Set<string>,
  ): RawView[] {
    const predicate = this.#compileDsFilter(directive.filter);
    return dsTypes
      .filter(
        (ds) =>
          !explicit.has(ds.name) &&
          this.#includeMatches(directive.include, ds.name) &&
          predicate({
            name: ds.name,
            datasource_type: ds.datasourceType ?? null,
          }),
      )
      .map((ds) =>
        this.#emptyShaped(ds.name, `${DS_PREFIX}${ds.name}`, []),
      );
  }

  #normalizeView(view: RawView): ViewType {
    if (view.oneOf !== undefined) {
      return { kind: "union", name: view.name, members: view.oneOf };
    }
    return {
      kind: "shaped",
      name: view.name,
      inherits: this.#inheritedTable(view.inherits) ?? null,
      fields: view.fields.map((f) => ({
        name: f.name,
        type: f.type,
        ...parseFieldType(f.type),
        isNullable: f.isNullable,
        ...(f.size !== undefined ? { size: f.size } : {}),
        ...(f.minSize !== undefined ? { minSize: f.minSize } : {}),
      })),
      enrichments: view.enrichments,
      omit: view.omit,
    };
  }

  #includeBlock(root: YamlNode, key: string): YamlNode | undefined {
    for (const entry of root.child("includes").items()) {
      if (entry.child(key).record !== undefined) return entry.child(key);
    }
    return undefined;
  }

  #collectRouteServiceMethods(
    routesYaml: string | undefined,
  ): Map<string, Set<string>> {
    const byService = new Map<string, Set<string>>();
    if (routesYaml === undefined) return byService;
    const root = YamlNode.fromYaml(routesYaml);
    const visit = (node: YamlNode): void => {
      if (Array.isArray(node.value)) {
        for (const item of node.items()) visit(item);
        return;
      }
      if (node.record === undefined) return;
      const service = node.str("service");
      const serviceMethod = node.str("serviceMethod");
      if (service !== undefined && serviceMethod !== undefined) {
        const set = byService.get(service) ?? new Set<string>();
        set.add(serviceMethod);
        byService.set(service, set);
      }
      for (const key of Object.keys(node.record)) visit(node.child(key));
    };
    visit(root.child("routes"));
    visit(root.child("combined_routes"));
    return byService;
  }

  #serviceCandidates(
    views: ViewType[],
    datasources: DatasourceType[],
  ): ServiceCandidate[] {
    const byName = new Map<string, ServiceCandidate>();
    const dsMap = new Map(
      datasources.map((d) => [d.name, d.datasourceType] as const),
    );
    const byFieldsByEntity = new Map(
      datasources.map((d) => [d.name, uniqueLookupFields(d)] as const),
    );

    for (const ds of datasources) {
      byName.set(ds.name, {
        name: ds.name,
        kind: "datasource_type",
        inheritsNamespace: "",
        datasourceType: ds.datasourceType,
        byFields: byFieldsByEntity.get(ds.name)!,
      });
    }

    for (const view of views) {
      if (view.name.startsWith("update_") || view.name.startsWith("create_")) {
        continue;
      }
      if (view.kind === "union") {
        byName.set(view.name, {
          name: view.name,
          kind: "view_type",
          inheritsNamespace: "",
          datasourceType: null,
          byFields: [],
        });
        continue;
      }
      const inheritsNamespace = view.inherits !== null ? "datasource_types" : "";
      const datasourceType =
        view.inherits !== null ? (dsMap.get(view.inherits) ?? null) : null;
      const byFields: ServiceByField[] =
        view.inherits !== null
          ? (byFieldsByEntity.get(view.inherits) ?? [])
          : [];
      byName.set(view.name, {
        name: view.name,
        kind: "view_type",
        inheritsNamespace,
        datasourceType,
        byFields,
      });
    }

    return [...byName.values()];
  }

  #defaultParentBasePath(parentName: string): string {
    return `/api/${specPlural(parentName)}/{id}`;
  }

  #segmentTailOf(segment: string): string {
    return segment.split("/").filter(Boolean).pop() ?? "";
  }

  #defaultChildSegment(name: string): string {
    return `/${specPlural(name)}`;
  }

  #columnIsUnique(ds: DatasourceType, columnName: string): boolean {
    if (columnName === "id") return true;
    const field = ds.fields.find((f) => f.name === columnName);
    if (field?.isPrimaryKey === true || field?.isUnique === true) return true;
    return ds.uniqueIndexFields.includes(columnName);
  }

  #singularizeLastToken(snakePlural: string): string {
    const parts = snakePlural.split("_");
    parts[parts.length - 1] = pluralize.singular(parts[parts.length - 1]!);
    return parts.join("_");
  }

  #entityHasField(ds: DatasourceType, fieldName: string): boolean {
    if (fieldName === "id") return true;
    return ds.fields.some((f) => f.name === fieldName);
  }

  #parseVerb(token: string): { methods: string[] | null; body: string } {
    const verbMatch = SHORTHAND_VERB_RE.exec(token);
    if (!verbMatch) return { methods: null, body: token };
    return {
      methods: VERB_TO_METHODS[verbMatch[1]!.toLowerCase()]!,
      body: token.slice(verbMatch[0].length),
    };
  }

  #splitEntityField(
    token: string,
    body: string,
  ): { entity: string; byField: string } {
    const splitIdx = body.lastIndexOf("_by_");
    if (splitIdx < 0) {
      throw new Error(
        `parseByFieldEntry: route key \`${token}\` is missing \`_by_\` separator`,
      );
    }
    const pluralSnake = body.slice(0, splitIdx);
    const fieldToken = body.slice(splitIdx + "_by_".length);
    if (!pluralSnake || !fieldToken) {
      throw new Error(
        `parseByFieldEntry: route key \`${token}\` has empty entity or field around \`_by_\``,
      );
    }
    return {
      entity: this.#singularizeLastToken(pluralSnake),
      byField: shorthandField(fieldToken),
    };
  }

  #parseShorthandByField(
    token: string,
    dsByName: Map<string, DatasourceType>,
  ): ByFieldParsed {
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("parseByFieldEntry: expected non-empty string token");
    }
    const { methods, body } = this.#parseVerb(token);
    const { entity, byField } = this.#splitEntityField(token, body);
    const ds = dsByName.get(entity);
    if (ds === undefined) {
      throw new Error(
        `parseByFieldEntry: unknown entity \`${entity}\` in route \`${token}\``,
      );
    }
    if (!this.#entityHasField(ds, byField)) {
      throw new Error(
        `parseByFieldEntry: field \`${byField}\` not found on entity \`${entity}\` in route \`${token}\``,
      );
    }
    return { entity, byField, methods };
  }

  #parseVerboseByField(
    key: string,
    def: Record<string, unknown>,
  ): ByFieldParsed {
    if (typeof def.entity !== "string" || typeof def.byField !== "string") {
      throw new Error(
        `parseByFieldEntry: route \`${key}\` has non-string entity/byField`,
      );
    }
    return {
      entity: def.entity,
      byField: def.byField,
      methods: Array.isArray(def.methods) ? def.methods : null,
    };
  }

  #parseByFieldEntry(
    entry: unknown,
    dsByName: Map<string, DatasourceType>,
  ): ByFieldParsed | null {
    if (entry == null) return null;
    if (typeof entry === "string") {
      return this.#parseShorthandByField(entry, dsByName);
    }
    if (!isRecord(entry)) return null;
    const pairs = Object.entries(entry);
    if (pairs.length === 0) return null;
    const [key, def] = pairs[0]!;
    if (def == null) {
      return this.#parseShorthandByField(key, dsByName);
    }
    if (!isRecord(def)) return null;
    if ("entity" in def && "byField" in def) {
      return this.#parseVerboseByField(key, def);
    }
    return null;
  }

  #findForeignKeyTo(child: DatasourceType, parentName: string): string | null {
    for (const field of child.fields) {
      if (field.references === undefined) continue;
      const [refTable] = field.references.split(".");
      if (refTable === parentName) return field.name;
    }
    return null;
  }

  #routeCandidates(
    views: ViewType[],
    dsByName: Map<string, DatasourceType>,
  ): RouteCandidate[] {
    const out: RouteCandidate[] = [];
    for (const view of views) {
      if (view.name.startsWith("update_") || view.name.startsWith("create_")) {
        continue;
      }
      if (view.kind === "union") {
        out.push({
          name: view.name,
          kind: "view_type",
          inheritsNamespace: "",
          datasourceType: "",
          target: null,
          byFields: [],
        });
        continue;
      }
      const inheritsNamespace =
        view.inherits !== null ? "datasource_types" : "";
      const kind: RouteCandidate["kind"] =
        inheritsNamespace === "datasource_types"
          ? "datasource_type"
          : "view_type";
      const parent =
        view.inherits !== null ? dsByName.get(view.inherits) : undefined;
      out.push({
        name: view.name,
        kind,
        inheritsNamespace,
        datasourceType: parent?.datasourceType ?? "",
        target: parent?.target ?? null,
        ...(parent?.optimisticConcurrency !== undefined
          ? { optimisticConcurrency: parent.optimisticConcurrency }
          : {}),
        byFields: [],
      });
    }
    return out;
  }

  #collectCombinedChildNames(
    root: YamlNode,
    dsByName: Map<string, DatasourceType>,
  ): Set<string> {
    const childrenOnly = new Set<string>();
    const parents = new Set(
      root.namedList("combined_routes").map((e) => e.name),
    );
    for (const { name: parentName, node } of root.namedList("combined_routes")) {
      const def = node.record as CombinedRouteDef | undefined;
      for (const child of def?.combined_types ?? []) {
        let childName: string;
        if (typeof child === "string") {
          childName = specName(child);
        } else {
          const [rawName, childDef] = Object.entries(child)[0]!;
          if (childDef && (childDef.via || childDef.target)) continue;
          childName = specName(rawName);
        }
        if (parents.has(childName)) continue;
        const childDs = dsByName.get(childName);
        if (
          childDs !== undefined &&
          this.#findForeignKeyTo(childDs, parentName) !== null
        ) {
          childrenOnly.add(childName);
        }
      }
    }
    return childrenOnly;
  }

  #upsertByField(
    list: RouteByField[],
    parsed: ByFieldParsed,
    dsByName: Map<string, DatasourceType>,
  ): void {
    const existing = list.find((e) => e.byField === parsed.byField);
    if (existing) {
      if (existing.methods === undefined || parsed.methods === null) {
        existing.methods = undefined;
      } else if (Array.isArray(parsed.methods)) {
        const union = [...existing.methods];
        for (const m of parsed.methods) {
          if (!union.includes(m)) union.push(m);
        }
        existing.methods = union;
      }
      return;
    }
    const ds = dsByName.get(parsed.entity);
    list.push({
      byField: parsed.byField,
      methods: Array.isArray(parsed.methods) ? parsed.methods : undefined,
      byFieldUnique: ds ? this.#columnIsUnique(ds, parsed.byField) : false,
    });
  }

  #attachByFields(
    candidates: RouteCandidate[],
    root: YamlNode,
    dsByName: Map<string, DatasourceType>,
  ): void {
    const byFieldByEntity = new Map<string, RouteByField[]>();
    for (const entry of root.child("routes").items()) {
      const parsed = this.#parseByFieldEntry(entry.value, dsByName);
      if (parsed === null) continue;
      if (!byFieldByEntity.has(parsed.entity)) {
        byFieldByEntity.set(parsed.entity, []);
      }
      this.#upsertByField(
        byFieldByEntity.get(parsed.entity)!,
        parsed,
        dsByName,
      );
    }
    for (const candidate of candidates) {
      const list = byFieldByEntity.get(candidate.name);
      if (list !== undefined && list.length > 0) {
        candidate.byFields = list;
      }
    }
  }

  #extractCustomRoutes(
    root: YamlNode,
    dsByName: Map<string, DatasourceType>,
  ): CustomRouteEntry[] {
    const customs: CustomRouteEntry[] = [];
    for (const entry of root.child("routes").items()) {
      if (entry.record === undefined) continue;
      if (this.#parseByFieldEntry(entry.value, dsByName) !== null) continue;
      const [name] = Object.keys(entry.record);
      if (name === undefined) continue;
      const node = entry.child(name);
      customs.push({
        name,
        path: node.str("path"),
        method: node.str("method"),
        entity: node.str("entity") ?? null,
        request: node.str("request"),
        response: node.str("response"),
        module: node.str("module"),
        routeClass: node.str("routeClass"),
      });
    }
    return customs;
  }

  #normalizeCombinedChild(
    child: string | Record<string, CombinedChildDef>,
  ): NormalizedChild {
    if (typeof child === "string") {
      return {
        name: specName(child),
        via: null,
        target: null,
        route: null,
      };
    }
    const [rawName, def] = Object.entries(child)[0]!;
    return {
      name: specName(rawName),
      via: def && typeof def.via === "string" ? def.via : null,
      target: def && typeof def.target === "string" ? def.target : null,
      route: def && typeof def.route === "string" ? def.route : null,
    };
  }

  #detectJunction(
    parentName: string,
    childName: string,
    dsByName: Map<string, DatasourceType>,
  ): JunctionMatch | null {
    const matches: JunctionMatch[] = [];
    for (const [name, def] of dsByName) {
      if (name === parentName || name === childName) continue;
      const parentFk = this.#findForeignKeyTo(def, parentName);
      const childFk = this.#findForeignKeyTo(def, childName);
      if (parentFk !== null && childFk !== null) {
        matches.push({ name, parentFk, childFk });
      }
    }
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      const candidates = matches.map((m) => m.name).join(", ");
      throw new Error(
        `combined_routes: ambiguous junction between "${parentName}" and "${childName}" — candidates: ${candidates}. Add via: to disambiguate.`,
      );
    }
    return matches[0]!;
  }

  #m2mDescriptor(
    parentName: string,
    parentBasePath: string,
    args: {
      junction: string;
      target: string;
      parentFkField: string;
      childFkField: string;
      route: string | null;
    },
  ): M2mDescriptor {
    const segment = args.route ?? this.#defaultChildSegment(args.target);
    return {
      kind: "m2m",
      parent: parentName,
      parentBasePath,
      parentParam: parentName,
      junction: args.junction,
      target: args.target,
      targetParam: args.target,
      parentFkField: args.parentFkField,
      childFkField: args.childFkField,
      segment,
      segmentTail: this.#segmentTailOf(segment),
    };
  }

  #directFkDescriptor(
    parentName: string,
    parentBasePath: string,
    args: { childName: string; fkColumn: string; route: string | null },
  ): DirectFkDescriptor {
    const segment = args.route ?? this.#defaultChildSegment(args.childName);
    return {
      kind: "direct-fk",
      parent: parentName,
      parentBasePath,
      parentParam: parentName,
      child: { name: args.childName },
      fkColumn: args.fkColumn,
      segment,
      segmentTail: this.#segmentTailOf(segment),
    };
  }

  #collectNestedDescriptors(
    root: YamlNode,
    dsByName: Map<string, DatasourceType>,
  ): NestedRouteDescriptor[] {
    const nested: NestedRouteDescriptor[] = [];
    for (const { name: parentName, node } of root.namedList("combined_routes")) {
      const def = (node.record ?? {}) as CombinedRouteDef;
      const parentBasePath =
        typeof def.route === "string" && def.route.length > 0
          ? def.route
          : this.#defaultParentBasePath(parentName);
      for (const rawChild of def.combined_types ?? []) {
        const child = this.#normalizeCombinedChild(rawChild);
        if (child.via || child.target) {
          const junctionName = child.via;
          const targetName = child.target;
          if (!junctionName || !targetName) {
            throw new Error(
              `combined_routes: M2M child must declare both via: and target: (parent=${parentName}, child=${child.name})`,
            );
          }
          const junctionDef = dsByName.get(junctionName);
          if (junctionDef === undefined) {
            throw new Error(
              `combined_routes: junction "${junctionName}" not found in datasource_types.yaml`,
            );
          }
          const parentFkField = this.#findForeignKeyTo(junctionDef, parentName);
          const childFkField = this.#findForeignKeyTo(junctionDef, targetName);
          if (parentFkField === null || childFkField === null) {
            throw new Error(
              `combined_routes: junction "${junctionName}" missing FK to ${parentName}/${targetName}`,
            );
          }
          nested.push(
            this.#m2mDescriptor(parentName, parentBasePath, {
              junction: junctionName,
              target: targetName,
              parentFkField,
              childFkField,
              route: child.route,
            }),
          );
          continue;
        }
        const childDef = dsByName.get(child.name);
        if (childDef === undefined) {
          throw new Error(
            `combined_routes: child "${child.name}" not found in datasource_types.yaml`,
          );
        }
        const fkColumn = this.#findForeignKeyTo(childDef, parentName);
        if (fkColumn !== null) {
          nested.push(
            this.#directFkDescriptor(parentName, parentBasePath, {
              childName: child.name,
              fkColumn,
              route: child.route,
            }),
          );
          continue;
        }
        const junction = this.#detectJunction(parentName, child.name, dsByName);
        if (junction !== null) {
          nested.push(
            this.#m2mDescriptor(parentName, parentBasePath, {
              junction: junction.name,
              target: child.name,
              parentFkField: junction.parentFk,
              childFkField: junction.childFk,
              route: child.route,
            }),
          );
          continue;
        }
        throw new Error(
          `combined_routes: child "${child.name}" has no FK to parent "${parentName}" and no detectable junction table in datasource_types.yaml`,
        );
      }
    }
    return nested;
  }
}
