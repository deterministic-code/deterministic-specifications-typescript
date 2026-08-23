# @deterministic-code/deterministic-specifications

Shared TypeScript validation engine for the deterministic YAML contract. AJV
(draft 2020-12) compilation and source-position mapping live here so every
error reports `{ line, col }`. Live (`1.0.0`) engines live in [`validators/engines.ts`](./validators/engines.ts);
frozen engines live under [`versions/<semver>/validators/engines.ts`](https://github.com/deterministic-code/deterministic-specifications/tree/main/versions).

```ts
import { TypesValidator } from "@deterministic-code/deterministic-specifications";

const validator = new TypesValidator();

const fromText = await validator.validate(yamlString);
const fromFile = await validator.validateFile("deterministic/types.yaml");

// { valid: boolean, errors: [{ line, col, instancePath, message }] }
```

The exported classes are facades: they require a semver `version` on the
document and load that version's engine. `1.0.0` (live) uses
`validators/engines.ts`; any other published semver uses
`versions/<semver>/validators/engines.ts`. A missing, non-semver, or unknown
version is a validation error. Each engine is pinned — a `1.0.0` engine
rejects `version: 2.0.0` and vice versa.

Live tests under `validators/validator.test.ts` load every archived engine
by version. That is the proof that a published snapshot is still supported.

Integration samples live in the [deterministic-specifications](https://github.com/deterministic-code/deterministic-specifications) repo under [`samples/`](https://github.com/deterministic-code/deterministic-specifications/tree/main/samples). Valid
kitchen-sink documents must exercise every spec property, enum, const, oneOf
branch, and pattern. Invalid documents (regenerated with
`npm run generate:invalid-samples`) must fail `validate()` and together hit
every independently observable schema constraint. Readable apps and a small
error gallery live under [`examples/`](https://github.com/deterministic-code/deterministic-specifications/tree/main/examples).

## Validators

| Class                       | Contract file                  |
| --------------------------- | ------------------------------ |
| `TypesValidator`            | `backend/types.spec.yaml` |
| `DatasourceValidator`       | `backend/datasource.spec.yaml` |
| `DatasourceSeedsValidator`  | `backend/datasource-seeds.spec.yaml` |
| `RoutesValidator`           | `backend/routes.spec.yaml`     |
| `RoutesApiValidator`        | `backend/routes-api.spec.yaml` |
| `ServicesValidator`         | `backend/services.spec.yaml`   |
| `FrontendBindingsValidator` | `frontend/bindings.spec.yaml`  |

Each exposes two methods:

- `validate(text: string)` — validate an in-memory YAML string.
- `validateFile(path: string)` — read a file from disk, then validate it.

Construct `SpecValidator` with `{ subdir, name, version }` to pin an engine
to one snapshot, or with an absolute path to validate against a spec that
lives outside this package (the pin check is skipped).

Archive a new version (moves `backend/`, `frontend/`, and this package's engine files):

```sh
npm run bump-version -- 1.1.0
```

This package validates **schema shape** first. `TypesValidator` then
checks `default_value` tokens and integer ranges against
[`backend/types.yaml`](https://github.com/deterministic-code/deterministic-specifications/blob/main/backend/types.yaml). `DatasourceSeedsValidator`
checks seed rows against companion `types.yaml` (field types) and
`datasource.yaml` (which types are tables). Other
cross-document rules (foreign-key resolution, merged includes) stay in the
consuming generator.
