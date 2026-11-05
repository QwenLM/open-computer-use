# CU/BU 独立仓库

[English](standalone-cu-bu.md)

Open Computer Use 接收从 Qwen Code 拆出的 CU/BU 0.28 开发版本。
[source-snapshot.json](../source-snapshot.json) 记录源基线提交和所有导入文件的校验值。
快照包含尚未提交的开发改动以及 Windows 空窗口选择修复，不能仅用基线提交代表它。

## 范围

| 模块           | 保留路径                    | 职责                                                                 |
| -------------- | --------------------------- | -------------------------------------------------------------------- |
| 原生驱动与 SDK | `packages/cua-driver`       | Rust 运行时、平台实现、TypeScript/Python SDK、安装脚本、夹具与许可证 |
| Browser Use    | `packages/browser-use`      | 浏览器运行时、native messaging host、SDK 与测试                      |
| Node REPL      | `packages/node-repl`        | 持久 JavaScript 运行时与独立 MCP server                              |
| Chrome 扩展    | `packages/chrome-extension` | 浏览器桥及可选的 Qwen 宿主集成                                       |

四个目录保留原路径及公开包名，维持相对引用、消费者接口、扩展身份和原生制品命名。
Chrome 扩展保持独立版本 0.26.7；Python SDK 保持既有版本，不并入三个 npm 包的联合发布。

工作树中的旧 Swift/Go 实现被替换，历史仍保留在父提交中，无需改写 Git 历史。
本阶段不修改 Qwen Code 中的消费者和内置源码，随后再处理消费者依赖切换与源码删除。

## 修改方式

根 workspace 只包含四个模块和必要构建、测试工具。
构建顺序是 Browser Use → CUA SDK → Node REPL，另行构建 Chrome 扩展。
Rust workspace 继续位于 `packages/cua-driver/rust`。

仓库、下载、安装及发布地址迁往 `QwenLM/open-computer-use`，保留历史上游来源声明。
读取 Qwen Code 消费者源码的测试改为验证外部协议边界，或作为消费者测试留在 Qwen Code。
不为满足测试复制 core、CLI 或 Web Shell 实现。

CI 从独立 checkout 完成安装、构建与测试。原生发布保留校验和及既有制品约定。
公开发布需要独立授权：本次迁移不打 tag、不发布 npm/native 制品，也不跨仓复制签名凭据。

## 验证与限制

验证干净安装、构建与类型检查、包内测试、独立 MCP 运行和打包内容；检查 Rust workspace、
安装脚本及发布路径，并把迁移边界和来源清单做成可执行检查。

0.28 开发版本的 macOS native SIGSEGV 问题尚未解决；迁移不代表修复，也不代表稳定发布。
既有 benchmark 任务及其冻结运行包不属于本次改动。

签名 secrets 和 npm trusted publisher 属于仓库设置。本次记录所需配置；源码检查不能证明
这些设置已配置，也不能证明新下载地址已有可安装的公开制品。
