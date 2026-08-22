import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  compileRoutesFilter,
  compileServicesFilter,
} from "../parser/compile-filter.ts";

const cand = (name: string, kind: string, inheritsNamespace = "") => ({
  name,
  kind,
  inheritsNamespace,
});

describe("compileServicesFilter / compileRoutesFilter", () => {
  it("treats a missing or empty filter as pass-through", () => {
    assert.equal(compileServicesFilter(undefined)(cand("user", "view_type")), true);
    assert.equal(compileRoutesFilter(null)(cand("user", "view_type")), true);
    assert.equal(compileRoutesFilter("")(cand("user", "view_type")), true);
  });

  it("rewrites type is / is not / inherits / inherits not / == / !=", () => {
    const isView = compileServicesFilter("type is view_type");
    const notRoute = compileRoutesFilter("type is not route");
    const inherits = compileRoutesFilter("type inherits datasource_types");
    const inheritsNot = compileRoutesFilter("type inherits not datasource_types");
    const eq = compileServicesFilter('type == "user"');
    const ne = compileServicesFilter('type != "user"');

    assert.equal(isView(cand("user", "view_type")), true);
    assert.equal(isView(cand("user", "datasource_type")), false);
    assert.equal(notRoute(cand("user", "view_type")), true);
    assert.equal(notRoute(cand("getHealth", "route")), false);
    assert.equal(inherits(cand("user", "view_type", "datasource_types")), true);
    assert.equal(inheritsNot(cand("search", "view_type", "")), true);
    assert.equal(eq(cand("user", "view_type")), true);
    assert.equal(ne(cand("role", "view_type")), true);
    assert.equal(ne(cand("user", "view_type")), false);
    assert.equal(compileServicesFilter("0")(cand("user", "view_type")), false);
  });

  it("rejects unknown identifiers and invalid expressions", () => {
    assert.throws(
      () => compileServicesFilter("foo == 1"),
      /view_type_services\.filter: unknown identifier or syntax near "foo"/,
    );
    assert.throws(
      () => compileRoutesFilter("type is datasource_type &&"),
      /view_type_routes\.filter is not a valid expression/,
    );
  });
});
