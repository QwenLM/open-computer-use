# Open Computer Use

[English](README.md)

面向 AI Agent 的 Computer Use 与 Browser Use 运行时。本仓库包含原生桌面驱动、
TypeScript/Python SDK、持久 JavaScript MCP 服务和 Chrome 扩展，可独立于 Qwen Code 使用。

当前源码来自 Qwen Code 的 **0.28 开发快照**，包含 Windows 修复，不代表新的稳定发布。
迁移范围见[设计记录](docs/design/standalone-cu-bu.zh-CN.md)，原始文件校验和见
[源码清单](docs/source-snapshot.json)。被替换的实现仍保留在
[Git 历史](https://github.com/QwenLM/open-computer-use/tree/f238d1bc85b53bd785d2618d4fbb5d2402207c7a)中。

## 组件

| 组件                                     | 入口                                                            | 版本   |
| ---------------------------------------- | --------------------------------------------------------------- | ------ |
| 原生桌面运行时、CLI 与 MCP               | [cua-driver](packages/cua-driver/README.md)                     | 0.28.0 |
| TypeScript Computer Use SDK              | [@qwen-code/cua-sdk](packages/cua-driver/typescript/README.md)  | 0.28.0 |
| Browser Use SDK 与 Native Messaging Host | [@qwen-code/browser-use](packages/browser-use/README.md)        | 0.28.0 |
| 持久 JavaScript MCP 服务                 | [@qwen-code/node-repl-mcp](packages/node-repl/README.md)        | 0.28.0 |
| Chrome 扩展                              | [@qwen-code/chrome-bridge](packages/chrome-extension/README.md) | 0.26.7 |
| Python SDK                               | [cua-driver Python](packages/cua-driver/python/README.md)       | 0.20.0 |

保留既有包名、可执行文件名和扩展身份。Qwen Code 的依赖切换在后续单独完成。

## 从源码构建

需要 Node.js 22 或更新版本、Corepack、Rustup、Python 3 和原生 C/C++ 编译器。
macOS 使用 Xcode Command Line Tools；Linux 安装 `build-essential`、`pkg-config`、
`libx11-dev`、`libxi-dev`、`libxtst-dev`、`libxext-dev`；Windows 使用
Visual Studio C++ build tools 与 Windows SDK。

```sh
git clone https://github.com/QwenLM/open-computer-use.git
cd open-computer-use
corepack pnpm install --frozen-lockfile
npm run build
npm run build:native
npm run stage:uniffi --workspace=@qwen-code/cua-sdk
```

工作区固定 pnpm 与 Rust 版本。SDK 识别源码目录后会跳过发布包下载；`stage:uniffi`
会复制本地原生库并编译 Node 适配器。macOS 本地构建只覆盖当前架构，不是通用发布包。

## 接入 MCP 客户端

构建后，在支持 stdio MCP 的客户端中填写 Node 与服务入口的绝对路径：

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

服务提供 `js`、`js_reset`，JavaScript 会话预加载 `cua` 并提供 API 文档。
桌面访问使用操作系统的正常权限；Browser Use 还需完成
[扩展与 Native Host 配置](packages/chrome-extension/README.md)。直接使用原生 MCP
或 SDK 的方式见各组件文档。

## 开发与验证

```sh
npm run typecheck
npm test
npm run test:contracts
npm run smoke:mcp
npm run check:native
```

另见[贡献指南](CONTRIBUTING.md)、[架构](docs/ARCHITECTURE.md)和[发布流程](docs/CICD.md)。

## 平台与发布状态

桌面自动化支持 macOS、Windows 和 Linux X11/XWayland，不支持原生 Wayland。
Browser Use 的 Native Host 注册目前支持 macOS/Linux，尚未实现 Windows 注册。

0.28 开发快照中的 macOS 原生崩溃问题仍在调查，迁移验证不代表该问题已修复。
使用发布安装命令前，需先配置新仓库的签名与 npm trusted publisher，并实际发布
配套 npm 包及原生 0.28 资产。本次仓库内容迁移不执行这些发布操作。

## 许可证

仓库采用 [Apache-2.0](LICENSE)，保留各组件的 MIT 与 MPL-2.0 声明。
详见 [NOTICE](NOTICE) 与各包许可证文件。
