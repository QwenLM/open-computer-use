# @qwen-code/chrome-bridge

A Chrome extension maintained in [Open Computer Use](https://github.com/QwenLM/open-computer-use).
It provides the Chrome side of Browser Use and optional integration with an
external [`qwen serve`](https://github.com/QwenLM/qwen-code/blob/main/docs/users/qwen-serve.md)
daemon. Its public package name, Chrome identity, and independent 0.26.7 version
are preserved.

It provides:

- **Side panel** — frames the daemon's Web Shell (chat + tools), the same UI the
  daemon serves to the browser. The panel has no UI of its own.
- **Service worker** — a CDP-tunnel pipe. It connects to the daemon's `/acp`
  WebSocket and bridges `cdp_*` frames into `chrome.debugger`, so the agent can
  drive the real browser when an external CDP MCP adapter is configured.
- **Browser Use bridge** — connects to the local `com.qwen.browser_use` Native
  Messaging host, lists open HTTP(S) tabs, and forwards Playwright CDP traffic
  for tabs claimed by Browser Use.
- **Readiness warning** — the framed Web Shell stays usable for chat while a
  small status message distinguishes a disabled CDP tunnel from a missing
  browser automation adapter.

## Build

To use the extension, install it from the
[Chrome Web Store](https://chromewebstore.google.com/detail/qwen-code/hdhmmjclhibojdddmancfgbkleahfaph).
The steps below build it from source, for development or where the listing is
not available.

```bash
npm run build        # -> dist/extension (static assets + bundled service worker)
```

Then load it: `chrome://extensions` → enable Developer mode → **Load unpacked**
→ pick `dist/extension`.

## Optional Qwen Code integration

The extension is a client; the daemon does the work and must be started
separately (an extension cannot spawn a local process). Open the side panel and
it will tell you exactly what to run — it generates the command with this
extension's own id:

```bash
qwen serve --allow-origin chrome-extension://<this-extension-id>
```

`--allow-origin chrome-extension://<id>` is required: it lets the daemon's Web
Shell be framed by the extension (the `frame-ancestors` CSP) and accepts the
extension's requests. The side panel reads the id at runtime via
`chrome.runtime.id`, so you never have to look it up.

Do not replace this command with `--open-with-auth`. That mode delivers its generated bearer only to the tab it opens; the extension cannot discover it. To protect a daemon used by the extension, set `QWEN_SERVER_TOKEN` explicitly and configure the same stable token in every authorized client.

Once the daemon is reachable and permits framing, the side panel swaps the
welcome screen for the chat UI automatically.

## Browser Use

Browser Use runs through the standalone [Node REPL MCP server](../node-repl/README.md)
or [Browser Use SDK](../browser-use/README.md). Install this Chrome extension in
the profile to control. The Qwen daemon and Web Shell are optional clients.
On macOS and Linux, the first browser task automatically registers the shared
Native Messaging host in the user's installation directory. The SDK can finish
this local setup before the extension connects; it verifies the live connection
and protocol instead of reading Chrome's extension preferences. If it cannot
connect, open Chrome and install or enable the extension in the intended profile,
then retry. Later sessions reuse an installed Host of the same protocol, and a
Host installed by a newer SDK is never downgraded. In a built checkout, run
`node packages/browser-use/dist/scripts/native-host-setup.js status` from the
repository root to inspect the installation, `install` to switch it to this
SDK's Host from the next Host start, or `uninstall` to remove files owned by
Browser Use. A later Browser Use initialization can register the Host again.

The Chrome-launched Host serves multiple independent SDK sessions per profile.
Each session controls its own tabs and groups; claiming another session's tab
returns `TAB_OWNERSHIP_CONFLICT`. A CLI exit leaves other sessions and the Host
running. Host files persist in the user's installation directory independently
of individual CLI checkouts. Updating the launcher takes effect on the next
Host start. Browser Use does not require `qwen serve` or a Chrome debugging port.

Installing the Chrome extension authorizes Browser Use to list and claim open
top-level HTTP(S) tabs. Its declared `history` permission supports explicit,
bounded history queries. The existing toolbar action and side panel continue to
open the Qwen UI.

## Web Shell CDP tunnel

The `qwen serve` command above only makes the side panel and Web Shell
available. Browser automation through the Web Shell's older CDP tunnel still
requires an explicit external MCP adapter command:

```bash
QWEN_CDP_MCP_COMMAND=/path/to/cdp-mcp-adapter \
qwen serve --allow-origin chrome-extension://<this-extension-id>
```

No adapter for this older CDP tunnel is bundled with `@qwen-code/qwen-code`.
When `QWEN_CDP_MCP_COMMAND` is unset, the extension can still open the
Web Shell, but the daemon will not register browser automation MCP tools.
Install the adapter separately and point the daemon at its executable:

The pinned adapter requires Node.js 22.12 or newer.

```bash
npm install -g chrome-devtools-mcp@1.5.0
QWEN_CDP_MCP_COMMAND=chrome-devtools-mcp \
  qwen serve --allow-origin chrome-extension://<this-extension-id>
```

The separately installed adapter is not included in the Qwen Code npm package
or Chrome extension zip.
Clients can distinguish the states through `/capabilities`:

- `allow_origin` means the extension may frame and call the daemon.
- `cdp_tunnel_over_ws` means the daemon exposes the reverse CDP tunnel.
- `browser_automation_mcp` means the external adapter command is configured and
  browser automation MCP tools can be registered when the CDP bridge connects.

When browser automation is configured, the panel also checks `/workspace/mcp`.
It warns when the adapter has not connected or when an existing user-defined
`chrome-devtools` server takes precedence over the extension tunnel.

## Onboarding states

The side panel probes `GET /health` and `GET /capabilities` and shows one of:

| State                    | Meaning                                   | Shown                            |
| ------------------------ | ----------------------------------------- | -------------------------------- |
| `down`                   | no daemon reachable                       | "Start qwen serve" + command     |
| `needs-allow-origin`     | daemon up but `--allow-origin` not set    | "Allow this extension" + command |
| `chat-only`              | Web Shell ready, CDP tunnel disabled      | chat + bridge warning            |
| `tunnel-only`            | CDP tunnel ready, adapter missing         | chat + adapter warning           |
| `automation-unavailable` | adapter status could not be read          | chat + status warning            |
| `automation-pending`     | adapter not connected                     | chat + connection warning        |
| `automation-shadowed`    | an existing MCP config takes precedence   | chat + migration warning         |
| `automation-configured`  | adapter configured, discovery not started | the Web Shell                    |
| `automation-connected`   | extension-backed MCP connected            | the Web Shell                    |

## Automated real-Chrome acceptance

The standalone acceptance runner starts Chromium or Chrome for Testing with an
isolated profile and this extension. It checks Native Messaging identity,
snapshots, trusted pointer/keyboard input, screenshot clipping, downloads,
history, tab finalization and a 65-second idle interval. No model or Qwen daemon
is needed. Set `QWEN_BROWSER_USE_CHROME` to the browser executable:

```bash
QWEN_BROWSER_USE_CHROME=/path/to/chrome-for-testing \
  npm -w packages/chrome-extension run test:e2e:chrome
```

The command prints a JSON result with `ok: true` after every check passes.
The Qwen daemon's separate CDP-tunnel acceptance runner remains in the
[Qwen Code consumer repository](https://github.com/QwenLM/qwen-code/tree/main/packages/cli/src/serve/cdp-tunnel/acceptance).

## Packaging for the Chrome Web Store

Packaging (`npm run package`) and the release test require the POSIX `zip`
utility.

```bash
npm run package        # -> chrome-extension.zip (manifest at the zip root)
npm run package:store  # -> chrome-extension-store.zip, without the manifest key
```

Run the extension release check from the repository root. It runs package tests
and typecheck, packages the zip, and scans the extension files, esbuild provenance
and archive for external Chrome DevTools MCP source signatures:

```bash
npm run test:release --workspace=@qwen-code/chrome-bridge
```

The generated manifest version follows this package's own version. These
commands only build and validate artifacts; store publication requires separate
authorization and credentials. See [release operations](../../docs/CICD.md).
The `debugger` permission requires justification in the store listing.

**Extension id note:** the manifest's `key` fixes the id of an unpacked build.
The store rejected that key on the first upload and assigned the listing its
own id, so the two builds carry different ids. `npm run package` zips the built
manifest verbatim, for side-loading; `npm run package:store` stages a copy
without the key for a store upload. Browser Use treats
the id as a set (`CHROME_EXTENSION_IDS` in the Browser Use package): the Native
Messaging registration lists every known origin and the handshake accepts any
of them, so both builds reach the same Host. Adding an id there also means
bumping the Host revision, so installed Hosts are replaced rather than reused.

**Version note:** the manifest version is derived from this package's semver
(e.g. `0.21.2.65535`), which is lower than the legacy side-loaded `1.0.0`
alpha. Chrome refuses to update an extension to a lower version, so testers
upgrading from the `1.0.0` build must remove it in `chrome://extensions`
before loading this package.
