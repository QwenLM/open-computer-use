# Open Computer Use

[中文](README.zh-CN.md)

Computer Use and Browser Use runtimes for AI agents. This repository contains
the native desktop driver, TypeScript and Python SDKs, a persistent JavaScript
MCP server, and the Chrome extension. They can run independently of Qwen Code.

This is the **0.28 development snapshot** extracted from Qwen Code, including
the Windows fixes. It is not a new stable release. See the
[migration record](docs/design/standalone-cu-bu.md) and
[source inventory](docs/source-snapshot.json). The former implementation remains
in [Git history](https://github.com/QwenLM/open-computer-use/tree/f238d1bc85b53bd785d2618d4fbb5d2402207c7a).

## Components

| Component                                 | Entry point                                                     | Version |
| ----------------------------------------- | --------------------------------------------------------------- | ------- |
| Native desktop runtime, CLI and MCP       | [cua-driver](packages/cua-driver/README.md)                     | 0.28.0  |
| TypeScript Computer Use SDK               | [@qwen-code/cua-sdk](packages/cua-driver/typescript/README.md)  | 0.28.0  |
| Browser Use SDK and native messaging host | [@qwen-code/browser-use](packages/browser-use/README.md)        | 0.28.0  |
| Persistent JavaScript MCP server          | [@qwen-code/node-repl-mcp](packages/node-repl/README.md)        | 0.28.0  |
| Chrome extension                          | [@qwen-code/chrome-bridge](packages/chrome-extension/README.md) | 0.26.7  |
| Python SDK                                | [cua-driver Python](packages/cua-driver/python/README.md)       | 0.20.0  |

Package names, executable names and extension identity are preserved for existing
consumers. Qwen Code's own dependency switch is a separate change.

## Build from source

Use Node.js 22 or later with Corepack, Rustup, Python 3 and a native C/C++ compiler.
On macOS, install Xcode Command Line Tools. On Linux, install `build-essential`,
`pkg-config`, `libx11-dev`, `libxi-dev`, `libxtst-dev` and `libxext-dev`.
On Windows, use the Visual Studio C++ build tools and Windows SDK.

```sh
git clone https://github.com/QwenLM/open-computer-use.git
cd open-computer-use
corepack pnpm install --frozen-lockfile
npm run build
npm run build:native
npm run stage:uniffi --workspace=@qwen-code/cua-sdk
```

The workspace pins pnpm and Rust versions. The source SDK install skips release
downloads; `stage:uniffi` stages the locally built library and builds its Node
adapter. A local macOS build is for the host architecture, not a universal release.

## Connect an MCP host

After building, configure any stdio MCP client with the absolute Node executable
and server path:

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/open-computer-use/packages/node-repl/dist/index.js"
      ]
    }
  }
}
```

The server provides `js` and `js_reset`. Its JavaScript session preloads `cua`
and supplies the API documentation. Desktop access uses the operating system's
normal permissions. Browser Use additionally needs the
[extension and native host setup](packages/chrome-extension/README.md).
For direct native MCP or SDK usage, follow the component documentation above.

## Develop and verify

```sh
npm run typecheck
npm test
npm run test:contracts
npm run smoke:mcp
npm run check:native
```

See [contributing](CONTRIBUTING.md), [architecture](docs/ARCHITECTURE.md) and
[release operations](docs/CICD.md).

## Platform and release status

Desktop automation supports macOS, Windows and Linux X11/XWayland. Native Wayland
is not supported. Browser Use native-host registration currently supports macOS
and Linux; Windows Browser Use registration is not implemented.

The 0.28 development snapshot has an unresolved macOS native crash investigation.
Migration validation does not establish that this crash is fixed. Public npm
packages and native 0.28 release assets must be published and their repository
signing/trusted-publisher settings configured before release-install commands can
be used. This content migration does not publish those artifacts.

## License

The repository uses [Apache-2.0](LICENSE), with component-specific MIT and MPL-2.0
notices retained. See [NOTICE](NOTICE) and each package's license files.
