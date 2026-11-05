# Open Computer Use

Read [architecture](docs/ARCHITECTURE.md), [contributing](CONTRIBUTING.md), and
[release operations](docs/CICD.md) before changing their respective areas.

- Keep CU, BU, the Node REPL, and the Chrome extension independent of Qwen Code
  source. Qwen Code is a consumer, alongside other MCP and SDK hosts.
- Preserve the native ownership, observation, permission, and cleanup contracts.
- Run package tests from their package directory, or use the root workspace scripts.
- Record cross-package design decisions in `docs/design/` and completed changes in
  `docs/histories/`. Keep English and Chinese top-level documentation synchronized.
- Read the entire changed surface and its callers before editing. Reuse existing
  code; do not add speculative abstractions.
- Verify the final diff and synchronize the remote branch before pushing.
- Never create a PR, publish packages, or change system trust without explicit
  authorization. Never add AI attribution trailers to commits or remote artifacts.
