# Architecture

Open Computer Use owns four independently buildable JavaScript workspaces and
one native Rust workspace. Public package names remain under `@qwen-code` for
compatibility; none requires Qwen Code core, CLI or Web Shell source.

| Layer                         | Location                         | Responsibility                                                                                           |
| ----------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Agent-facing JavaScript MCP   | `packages/node-repl`             | Persistent isolated JavaScript kernel, `js`/`js_reset`, output and lifecycle management                  |
| Computer Use API and bindings | `packages/cua-driver/typescript` | Preloaded `cua`, typed SDK, native loading and browser facade                                            |
| Browser runtime               | `packages/browser-use`           | Browser sessions, browser SDK, native messaging host and pinned Playwright integration                   |
| Browser extension             | `packages/chrome-extension`      | Chrome bridge, native messaging and optional external Qwen daemon integration                            |
| Native runtime                | `packages/cua-driver/rust`       | Tool contracts, session lifecycle, permissions, observations, platform actions, CLI/MCP and embedded SDK |
| Python bindings               | `packages/cua-driver/python`     | Generated native SDK and Python entrypoints                                                              |

JavaScript build order is Browser Use → CUA SDK → Node REPL; the Chrome extension
builds independently. Native binaries and the SDK library are built within the
Rust workspace, then `stage:uniffi` stages the library and its N-API adapter for
local SDK use. Published SDK installations download the matching native release
and verify archive checksums.

The native core owns the Computer Use contract. Platform implementations remain
inside their macOS, Windows and Linux crates. The SDK, embedded hosts and native
MCP share that contract. Keep observation tokens, action validation, permission
decisions and shutdown ownership in their existing layers.

The Windows UIAccess worker is an optional authenticated internal hop; ordinary
Windows input does not require it. It is not a public client transport. macOS UI
surfaces require their main-thread host. Browser native messaging registration
is currently available on macOS/Linux; native Linux desktop support requires
X11 or XWayland.

The extension retains its existing sidepanel and optional Qwen daemon protocol.
Those are external integrations, not a dependency on Qwen source. Optional Qwen
consumer smoke tests receive an explicit external CLI path. Default tests check
the module's protocol boundaries within this repository.

The [source snapshot](source-snapshot.json) records the initial import, before
migration-only metadata, documentation and integration changes. See the
[design](design/standalone-cu-bu.md) for the extraction boundary and
[release operations](CICD.md) for build, signing and publication responsibilities.
