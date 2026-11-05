# Contributing

Start with the [architecture](docs/ARCHITECTURE.md) and the source-build commands
in the [README](README.md). Keep changes within the affected runtime; Qwen Code
is an external consumer, not a build dependency.

Use the pinned pnpm lockfile and Rust toolchain. Build the workspace before its
tests so Browser Use kernel tests exercise the built assets. Run the affected
package's tests and types; for cross-package changes run `npm run build`,
`npm run typecheck`, `npm test`, `npm run test:contracts` and `npm run smoke:mcp`.
The Node N-API fixture needs Python and a C++ compiler; a skipped fixture is not
evidence of working native loading.

Run `npm run check:native` for native changes. Native library tests can be run
from `packages/cua-driver/rust` with `cargo test --locked -p cua-driver-contract
-p cua-driver-core -p cua-driver-sdk --lib`. Desktop/browser integration checks
require a suitable interactive test machine; distinguish them from compile or
mock tests. Never change system trust to make a test pass.

Use strict TypeScript, ESM and Prettier. Preserve generated bindings and their
ownership metadata; use the SDK's `generate:uniffi:check` command to verify them.
Keep package names, extension identity, native asset naming and versions aligned
with the [release contract](docs/CICD.md).

Record cross-package designs in `docs/design/`, active execution plans in
`docs/exec-plans/active/`, and completed changes with validation and limitations
in `docs/histories/`. Use repository-relative links and keep top-level English
and Chinese documentation synchronized. Never include credentials or local
machine paths in tracked reports.

Before submitting changes, review the complete diff, inspect connected callers,
and synchronize with the remote branch. Publishing npm/native/extension artifacts
is a separate operation; see [release operations](docs/CICD.md).
