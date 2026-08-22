import type {
  DatasourceType,
  ParsedRoutes,
  ParsedServices,
  SeedRow,
  ViewType,
} from "./specification.ts";

/** Parsed deterministic YAML. One parse, then properties for each document. */
export type IDeterministic = {
  datasourceTypes: DatasourceType[];
  datasourceSeeds: Map<string, SeedRow[]>;
  viewTypes: ViewType[];
  expandedDatasourceTypes: DatasourceType[];
  expandedViewTypes: ViewType[];
  services: ParsedServices;
  routes: ParsedRoutes;
};

export class Deterministic implements IDeterministic {
  readonly datasourceTypes: DatasourceType[];
  readonly datasourceSeeds: Map<string, SeedRow[]>;
  readonly viewTypes: ViewType[];
  readonly expandedDatasourceTypes: DatasourceType[];
  readonly expandedViewTypes: ViewType[];
  readonly services: ParsedServices;
  readonly routes: ParsedRoutes;

  constructor(args: IDeterministic) {
    this.datasourceTypes = args.datasourceTypes;
    this.datasourceSeeds = args.datasourceSeeds;
    this.viewTypes = args.viewTypes;
    this.expandedDatasourceTypes = args.expandedDatasourceTypes;
    this.expandedViewTypes = args.expandedViewTypes;
    this.services = args.services;
    this.routes = args.routes;
  }
}
