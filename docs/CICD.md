# CI and release operations

This repository builds the extracted CU/BU development version independently of
Qwen Code. Version 0.28.0 still has an unresolved macOS native SIGSEGV. Migration,
successful compilation, package tests, and signing do not establish a fix or a
stable release. No public release is part of the extraction.

## Local checks

Install the locked root workspace without running package install hooks, then use
the root build, typecheck and test scripts. Package install hooks normally fetch
published native binaries; use an explicitly built local payload for native SDK
tests of this development version.

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
npm run build
npm run typecheck
npm test
npm run test:contracts
```

Run Rust commands from `packages/cua-driver/rust` so rustup selects the checked-in
1.97.1 toolchain and Cargo applies its local configuration. A complete native
release builds `cua-driver`, `cua-driver-sdk`, `cursor-theme-cli`, and, on Windows,
`cua-driver-uia`. The last package is a no-op executable on other hosts. Linux
builds need `build-essential pkg-config libx11-dev libxi-dev libxtst-dev libxext-dev`.
Actual GUI tests additionally need the correct logged-in desktop and fixtures;
headless checks do not provide that evidence.

## Coordinated native and npm release

[cd-cua-driver.yml](../.github/workflows/cd-cua-driver.yml) preserves the native tag
prefix `cua-driver-rs-v`, binary names, ABI, and archive names. It validates a
single version across the root, Rust, installers, driver skill, CUA SDK, Browser
Use and Node REPL. The three npm names remain:

- `@qwen-code/browser-use`
- `@qwen-code/cua-sdk`
- `@qwen-code/node-repl-mcp`

The Chrome extension and Python SDK keep their independent versions. This
workflow does not publish them. It does not run Qwen Code release scripts or
switch Qwen Code consumers.

The workflow builds Linux x64/arm64, Windows x64/arm64, and macOS universal
payloads. It checks all 12 native archives, verifies local npm tarballs and clean
installs, creates the GitHub Release, then publishes Browser Use, CUA SDK and Node
REPL in dependency order. A production dispatch requires protected `main` and
macOS notarization; a native release tag must point to a commit reachable from
`main`. Existing release assets and npm versions are immutable.

`workflow_dispatch` defaults to `dry_run=true`. An unsigned build can set
`notarize=false`; it cannot become a production dispatch. Windows test signing
is separately opt-in with `test_sign_windows=true` and only applies to dry runs.
Without it, Windows validates ordinary installation of the unsigned SDK payload
and does not claim signed-UIAccess installation coverage. No workflow is dispatched
automatically by local validation commands.

Production publication is a separately authorized action. The source workflow
marks GitHub releases as prereleases, but a numeric npm version such as 0.28.0
uses `latest`; prerelease npm versions use `next`. Do not trigger production
publication merely to validate this migration. New download URLs are source
configuration, not proof that assets have been published there.

## Repository settings

Repository administrators must provision settings directly in the target
repository. Do not read, copy or reuse source-repository secrets as part of a
code migration. Source inspection cannot establish whether any setting below is
already configured.

| Setting                  | Required configuration                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actions and runners      | Enable the hosted Linux x64/arm64, Windows and macOS runners used by the workflow. All actions are pinned to commit SHAs. Build jobs have read-only contents permissions; the GitHub Release job needs contents write.                                                                                                                   |
| Protected release source | Protect `main` and configure the target's release/tag policy. Create the `production-release` environment with the desired reviewers and branch restrictions.                                                                                                                                                                            |
| macOS certificate        | `OPEN_COMPUTER_USE_CODESIGN_P12_BASE64` contains the base64 Developer ID Application P12 and `OPEN_COMPUTER_USE_CODESIGN_P12_PASSWORD` its password. The workflow discovers the signing identity from that certificate.                                                                                                                                                              |
| Apple notarization       | `APPLE_NOTARY_API_KEY_P8_BASE64`, `APPLE_NOTARY_KEY_ID`, and `APPLE_NOTARY_ISSUER_ID`. The build signs, notarizes, staples and checks Gatekeeper acceptance.                                                                                                                                                                             |
| SignPath secret          | `SIGNPATH_API_TOKEN`, required only for the explicitly enabled Windows test-signing lane.                                                                                                                                                                                                                                                |
| SignPath variables       | `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG`, `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`, and `SIGNPATH_TEST_CERT_THUMBPRINT`. These must describe a project and test certificate authorized for this repository; there are no source-project defaults. Missing values fail before a signing request. |
| npm trusted publishers   | Configure each of the three package records for organization `QwenLM`, repository `open-computer-use`, workflow `cd-cua-driver.yml`, and environment `production-release`. Publish jobs have `id-token: write` and use npm 11.19.0 with provenance; there is no npm-token fallback.                                                      |

The macOS and Windows build jobs do not select `production-release`. Their
signing secrets/variables must be repository settings or organization settings
explicitly available to this repository. Secrets stored only in the npm release
environment will not be visible to those build jobs. Never substitute another
repository's project or certificate to make a dry run pass.

Windows release archives contain the unsigned UIAccess worker. Ordinary SDK
installation must not deploy it to Program Files. Deployments that deliberately
enable UIAccess need their own trusted signature and secure installation; the
test-signing lane imports its configured test certificate only on the disposable
hosted runner.

## Distribution and licensing

Installers, SDK downloads, native update checks and driver skill downloads point
to `QwenLM/open-computer-use`. The SDK's release-base override is useful for local
artifact tests; its fallback also points to this repository. Local tests should
use their own `QWEN_CUA_SDK_NATIVE_DIR` / `QWEN_CUA_SDK_CACHE_DIR` and must not
replace an existing Qwen Code runtime or alter system trust.

Retain the Cua MIT copyright, Qwen Apache-2.0 notices, and the MPL-2.0 license and
corresponding-source notice for the modified UBRN Node runtime. Each native
archive carries these notices alongside its payload. The source for that runtime
is the pinned UBRN npm dependency plus this repository's deterministic build
script and AppKit pump at the matching release tag.
