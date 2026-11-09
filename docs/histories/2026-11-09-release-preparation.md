# 0.28.0 release preparation

The imported CU/BU source remains at version 0.28.0. This preparation preserves
its native implementation, public package names, and archive conventions.

- Preserve LF line endings on every host so source-extraction tests and generated
  contract checks see the same bytes on Windows as on Linux and macOS.
- Await the existing asynchronous kernel disposal before deleting the MCP test
  directory, and before the direct kernel smoke script exits.
- Map the macOS signing inputs to this repository's existing
  `OPEN_COMPUTER_USE_CODESIGN_P12_BASE64` and
  `OPEN_COMPUTER_USE_CODESIGN_P12_PASSWORD` secrets. The signing/notarization
  steps stay unchanged; no secret values were read or copied.

Local frozen installation, workspace build, types, package tests, release
contracts, MCP smoke and direct kernel smoke passed on macOS. Windows hosted
verification passed in the hosted six-job Standalone checks run 42610403262,
including both Windows jobs. The native/npm release dry run is separate from
these checks; the subsequent signing-name mapping is configuration only.

No native or npm version has been published by this preparation. The previously
reported macOS SIGSEGV remains unresolved; no GUI or system-trust changes were
part of these checks.
