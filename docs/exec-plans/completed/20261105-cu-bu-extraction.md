# CU/BU extraction

## Objective

Replace the repository content with the complete CU/BU 0.28 development snapshot,
make it independently buildable and testable, and preserve the repository history.
Qwen Code consumer switching, public releases, and benchmark changes are excluded.

## Progress

- [x] Confirm source version and staged consumer migration with the user.
- [x] Inspect both repositories and identify package/runtime boundaries.
- [x] Freeze imported source checksums and retain the target's parent commit.
- [x] Import four package directories into an isolated branch.
- [x] Adapt standalone workspace, consumer tests, installers and release workflow.
- [x] Install, build, typecheck, test and verify packaged entrypoints.
- [x] Audit final changes and record validation and remaining release prerequisites.
- [x] Synchronize remote main and prepare the authorized history-preserving replacement.

Remote delivery is verified against the resulting commit by the invoking task.
See the [validation history](../../histories/20261105-cu-bu-extraction.md).

## Decisions

Preserve public package names, executable names, extension identity and directory
paths. Preserve all package license notices. Keep optional Qwen extension
integrations but do not import their host implementation. Use the standard Git
parent relationship to retain the replaced implementation; no forced push.

See the [design](../../design/standalone-cu-bu.md) for boundaries and known risks.
