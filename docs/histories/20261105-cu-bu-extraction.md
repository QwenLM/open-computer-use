# CU/BU extraction — 2026-11-05

Replaced the previous Open Computer Use working tree with the CU/BU 0.28
development snapshot from Qwen Code. The former implementation is retained in
the parent history at `f238d1bc85b53bd785d2618d4fbb5d2402207c7a`.

The [source inventory](../source-snapshot.json) records all 880 imported files and
their SHA256 values before migration adjustments. It includes uncommitted 0.28
changes and the Windows fixes; it is not equivalent to the source base commit
alone. All files and executable modes were retained. Native platform behavior
was preserved; native operational URLs now point to this repository.

## Independent repository

- Four JavaScript workspaces, their lockfile and native Rust workspace build
  without Qwen Code core, CLI or Web Shell source.
- Public package names, native executable/archive/tag names and extension
  identity remain compatible. CU/BU/Node use 0.28.0; the extension and Python
  SDK retain their independent versions.
- Default extension tests assert the external daemon protocol. The optional
  Qwen consumer smoke takes an explicit external CLI entrypoint.
- Native installers, updates, package metadata and release workflow target
  Open Computer Use. The workflow pins Actions, requires explicit target signing
  configuration and retains license notices in native archives.
- Four publication conditions now require a `push` event for tag publication.
  A manual dry run on a native tag cannot create a release or publish npm packages.
  The regression was reproduced before the fix and the event/ref/dry-run matrix
  passed afterward.
- Inherited native harness documents identify absent upstream wrappers;
  the optional Lume browser runner requires an explicit external runner.

## Local validation

Validated with Node 22.23.1, pnpm 11.24.0 and Rust 1.97.1 on macOS arm64.

| Check                                                 | Result                                                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Frozen independent install, workspace build and types | Passed                                                                                                    |
| Browser Use                                           | 612 passed, including three built-kernel checks                                                           |
| Node REPL                                             | 277 passed, including compiled N-API loading                                                              |
| Chrome extension                                      | 144 passed; ordinary/store ZIP packaging and scans passed                                                 |
| CUA SDK after local native staging                    | 82 passed; one Electron-host test skipped                                                                 |
| Rust contract/core/SDK library tests                  | 774 passed                                                                                                |
| Native release build and Node adapter staging         | Passed for local arm64                                                                                    |
| Generated contract and UniFFI bindings                | Matched checked-in outputs                                                                                |
| Standalone/release contracts                          | 3 Node tests and 10 Vitest tests passed                                                                   |
| Installer and Lume tests                              | 112 passed; five PowerShell tests skipped                                                                 |
| Workflow syntax and Linux/macOS archive assembly      | Passed; eight fixture archives retained required notices                                                  |
| Three packed npm packages in a clean consumer         | Installed together from local tarballs; all exports/dependency edges resolved locally                     |
| Workspace and packed MCP                              | Persistent state, reset, default timeout, documentation and EOF cleanup passed                            |
| Packed native installation                            | Localhost download/checksum, isolated cache, actual library loading, 20-tool metadata and shutdown passed |
| Explicit empty native override                        | Failed closed without fallback                                                                            |

All self-owned MCP, kernel, native metadata and HTTP fixture processes exited.
The final SDK tarball differed from the first tested one only in its notice;
runtime code, declarations and package metadata were unchanged.

## Limits

This is a source migration, not a stable 0.28 release. The inherited macOS native
crash investigation remains unresolved. Local arm64 libraries do not establish
universal macOS, Windows or Linux runtime acceptance. Hosted CI, Electron-host,
PowerShell, interactive desktop/Chrome, code signing/notarization, npm publication
and extension-store submission are separate evidence. Repository signing and npm
trusted-publisher settings must be configured before release operations.

Qwen Code's consumers and benchmark jobs are unchanged. Removing its embedded
CU/BU copies and switching it to independently published packages is the next
stage.
