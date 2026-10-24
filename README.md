# Rage

Build JavaScript/TypeScript projects and npm workspaces. Requires Node.js 22.17+
and npm. Version 1.2 adds dependency-aware workspace builds.

```sh
rage build
rage build --all --log --jobs 2
rage build --dry-run
```

The existing `rage --build --all --log` syntax also works.

## npm workspaces

Rage reads `package.json#workspaces` (an array or `{ "packages": [...] }`). Globs,
nested package directories, scoped names and `!` exclusions are supported. The
workspace root is never built as a package, so a root `build` script may safely
invoke Rage.

Packages without a nonempty `scripts.build` are reported as `SKIP (no build
script)`, not invoked and not treated as failures. Private workspaces are built
normally. A package with a real build script still fails the command on a
nonzero exit, launch error or timeout: compiler failures are never hidden as
"missing script" warnings.

Local dependencies, devDependencies, optionalDependencies and peerDependencies
are ordered before their consumers when the local version satisfies the
declared range. Source-only dependencies are retained in this graph. Cycles and
duplicate package names are rejected before any scripts run. Independent builds
run concurrently, bounded by `--jobs` (default: available CPU parallelism).

Without a workspace declaration, the legacy `rage.config.js` root is supported.
A standalone package is also supported. `priority` names/paths only break ties;
they never override dependency ordering. Version/publish commands retain their
existing behavior; this release changes build discovery and caching only.

## Incremental builds

Successful builds are recorded atomically in `.builder-cache/build-v2.json`.
Older build caches are not trusted. A failed/aborted build never records success,
and a forced rebuild revokes any previous success before starting.

Fingerprints include file names and contents, added/deleted files, manifests,
transitive local dependency inputs, root lockfiles/configuration, shared
`scripts/`, `builder/`, `tools/`, and the Node/platform/Rage version. Dependency or
lock/config changes invalidate the affected graph rather than reusing stale
artifacts. Missing known output files also invalidate a cached build.
This is build caching, not package-manifest validation: legacy export/type paths
that the build never produced are not recorded as generated artifacts.

Generated `exports/`, `dist/`, `www/`, `coverage/` and the configured `exports`
directory are excluded from source hashing, along with `node_modules/`, `.git/`
and `.builder-cache/`. Do not keep build inputs in these output directories.
Linked input trees conservatively invalidate their package on every invocation.
Undeclared inputs outside this project tree or environment-variable changes
require `--all`; Rage does not promise a hermetic build sandbox. Avoid simultaneous
Rage invocations in the same checkout.

`--dry-run` shows the graph and cache decisions without running scripts or writing
cache files. `RAGE_BUILD_TIMEOUT_MS` sets a positive per-package timeout (default
10 minutes). Timed-out process trees are terminated before reporting failure.

```js
// Optional rage.config.js for a legacy layout
export default {
  root: 'packages',
  monorepo: true,
  priority: ['core'],
  exports: 'exports'
}
```

## Development

```sh
npm ci
npm test
npm run test:package
```

Tests use temporary workspaces and real child build processes. `npm pack` and
`npm publish` build the distributable through `prepack`; runtime installs do not
need the TypeScript compiler.
 
