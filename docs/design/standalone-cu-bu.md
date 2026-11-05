# Standalone CU and BU

[中文](standalone-cu-bu.zh-CN.md)

Open Computer Use becomes the source repository for the CU/BU development version
0.28 extracted from Qwen Code. The source base and every imported file's checksum
are recorded in [source-snapshot.json](../source-snapshot.json). The snapshot
includes uncommitted development changes, including the Windows placeholder-window
fix. It is not equivalent to the source base commit alone.

## Scope

| Component              | Source and destination      | Role                                                                                              |
| ---------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| Native driver and SDKs | `packages/cua-driver`       | Rust runtime, platform implementations, TypeScript/Python SDKs, installers, fixtures and licenses |
| Browser Use            | `packages/browser-use`      | Browser runtime, native messaging host, SDK and tests                                             |
| Node REPL              | `packages/node-repl`        | Persistent JavaScript runtime and standalone MCP server                                           |
| Chrome extension       | `packages/chrome-extension` | Browser bridge and optional Qwen host integrations                                                |

The four package directories retain their paths and public names. This preserves
relative imports, package consumers, extension identity and native artifact names.
The Chrome extension keeps its independently versioned 0.26.7 package. The Python
SDK keeps its existing version and is not added to the coordinated npm release.

The former Swift/Go Open Computer Use implementation is replaced in the working
tree. Its history remains reachable through the parent Git commit. No history
rewrite is necessary. Qwen Code consumers and their vendored source are unchanged
in this stage; consumer removal and dependency switching are a subsequent change.

## Changes

The root workspace contains only these four packages and their build/test tools.
Build order follows Browser Use → CUA SDK → Node REPL, plus the Chrome extension.
The Rust workspace remains within `packages/cua-driver/rust`.

Repository, download, installation and release destinations move to
`QwenLM/open-computer-use`. Historical upstream attribution remains intact.
Tests that read Qwen Code consumer source must be replaced with assertions at the
external protocol boundary or remain documented as consumer tests in Qwen Code.
No Qwen Code core, CLI or Web Shell implementation is copied to satisfy a test.

CI must install, build and test this checkout independently. Native release
packaging retains checksums and the existing artifact contract. Publishing is a
separate authorized operation: this migration does not create tags or publish
new npm/native artifacts, and does not copy signing credentials across repositories.

## Validation and limitations

Validate clean workspace installation, builds/types, package tests, standalone MCP
execution and package contents; check the native Rust workspace and installer and
release paths. Keep source inventory checks and migration checks executable.

The macOS native SIGSEGV investigation in the 0.28 development version remains
unresolved. Moving the code does not establish a fix or a stable release. Existing
benchmark jobs and their immutable bundles are outside this change.

Release signing secrets and npm trusted-publisher configuration are repository
settings. Document the necessary configuration; source checks do not prove it is
configured or that a release is available at the new download location.
