# @qwen-code/browser-use

Browser Use SDK and Chrome Native Messaging host, maintained in
[Open Computer Use](https://github.com/QwenLM/open-computer-use). The public npm
name remains `@qwen-code/browser-use`; this checkout contains version 0.28.0.

The SDK runs with Node.js 22 or later on macOS/Linux and the
[Chrome extension](../chrome-extension/README.md). It uses the exact
`playwright-core` version pinned in this package. Native Host registration is
not implemented on Windows.

Most MCP hosts use the preloaded `cua` browser API through the
[Node REPL server](../node-repl/README.md). Direct SDK consumers can import
`setupBrowserRuntime()` and `closeBrowserRuntime()` from this package. Browser
automation does not require a Qwen Code installation or daemon.

## Build and test

Install dependencies and build from the repository root first, then run the
package checks:

```bash
npm run build
npm run typecheck --workspace=@qwen-code/browser-use
npm test --workspace=@qwen-code/browser-use
```

For real Chrome acceptance, use Chromium or Chrome for Testing with an isolated
profile. This check uses a local fixture and does not call an AI model:

```bash
QWEN_BROWSER_USE_CHROME=/path/to/chrome-for-testing \
  npm run smoke:managed-chrome-preflight --workspace=@qwen-code/browser-use
```

## Optional Qwen Code consumer smoke

The SauceDemo scenario tests an external Qwen Code JavaScript CLI entry using
this checkout's Node REPL and SDK packages. Build or install that consumer
separately; this repository does not contain its CLI, core, or Web Shell.

Set `QWEN_BROWSER_USE_QWEN_ENTRY` to the absolute path of that JavaScript entry
(for example, `/path/to/qwen-code/dist/cli.js`),
`QWEN_BROWSER_USE_CHROME` to a supported Chrome executable, and configure
`DASHSCOPE_API_KEY`, `DASHSCOPE_BASE_URL` and `QWEN_BROWSER_USE_MODEL`. Then run:

```bash
npm run smoke:qwen-saucedemo --workspace=@qwen-code/browser-use
```

This optional scenario calls the configured model and visits SauceDemo. It is
not part of the default test suite. Results are written under
`.qwen/e2e-tests/browser-use` in this checkout.
