# open-computer-use

[![English](https://img.shields.io/badge/English-Click-yellow)](./README.md)
[![简体中文](https://img.shields.io/badge/简体中文-点击查看-orange)](./README.zh-CN.md)

---

面向 [Qwen Code](https://github.com/QwenLM/qwen-code) 和任意 MCP Client 的 Computer Use 服务 — 通过 accessibility API 控制 macOS、Linux 和 Windows。

以 [`@qwen-code/open-computer-use`](https://www.npmjs.com/package/@qwen-code/open-computer-use) 发布到 npm。

## 演示

https://cloud.video.taobao.com/vod/kS1Np3LUgPSg07OQ27_z63TWIU_G4nQHBJDA4wynUmk.mp4

## Quick Start

```bash
npm i -g @qwen-code/open-computer-use
```

**macOS 第一次使用前，需要授权 `Accessibility` 和 `Screen Recording` 的权限，Windows 和 Linux 无需执行。**

```bash
open-computer-use
```

添加 MCP 配置到你的客户端：

```json
{
  "mcpServers": {
    "open-computer-use": {
      "command": "open-computer-use",
      "args": ["mcp"]
    }
  }
}
```

## CLI 用法

```bash
# 直接调用单个 Computer Use tool，输出 MCP 风格的 JSON result
open-computer-use call list_apps
open-computer-use call get_app_state --args '{"app":"TextEdit"}'

# 在同一个进程里编排连续动作，复用 get_app_state 拿到的 element_index
open-computer-use call --calls '[{"tool":"get_app_state","args":{"app":"TextEdit"}},{"tool":"press_key","args":{"app":"TextEdit","key":"Return"}}]'
open-computer-use call --calls-file examples/textedit-overlay-seq.json --sleep 0.5

# 检查权限；只有缺失时才会拉起引导
open-computer-use doctor

# 查看帮助
open-computer-use -h
```

## 配置

### 截图捕获（macOS）

`get_app_state` 以及所有 action tool 跟在动作后面回带的截图，都可以通过环境变量在每次 capture 时动态读取调整。所有变量都是可选的；缺失、非数字或越界值都会回落到内置默认值。

| 变量 | 默认值 | 含义 |
|---|---|---|
| `OPEN_COMPUTER_USE_IMAGE_CAPTURE_TIMEOUT` | `5` | `SCScreenshotManager.captureImage` 的等待秒数，超时后 a11y 树仍会返回，只丢 `image` block。正浮点数。 |
| `OPEN_COMPUTER_USE_IMAGE_MAX_BYTES` | `900000` | PNG 编码后字节预算。降采样会以 `scale *= 0.85` 迭代直到字节数符合预算，或触及 `OPEN_COMPUTER_USE_IMAGE_MIN_SCALE` 下限。正整数。 |
| `OPEN_COMPUTER_USE_IMAGE_MAX_DIMENSION` | `1280` | 返回 PNG 的长边像素上限。初始 scale = `min(1, OPEN_COMPUTER_USE_IMAGE_MAX_DIMENSION / 原图最大边长度)`。正浮点数。 |
| `OPEN_COMPUTER_USE_IMAGE_MIN_SCALE` | `0.25` | 降采样比例的下限。一旦迭代低于这个值就停下，返回目前最接近预算的结果（哪怕仍超 `OPEN_COMPUTER_USE_IMAGE_MAX_BYTES`）。`(0, 1]` 区间的浮点数。 |

任何降采样都不会破坏点击精度——坐标 tool（`click` / `drag` / `scroll`）会从返回的 PNG 字节里读出实际像素尺寸，按当前窗口 bounds 比例反算模型提供的坐标。

这些变量目前只影响 macOS。Windows 和 Linux runtime 返回原生尺寸 PNG，不做降采样。

详见 [docs/IMAGE_CAPTURE.md](docs/IMAGE_CAPTURE.md)，包含完整的捕获→降采样→编码流程、约束交互说明和示例。

## 致谢

本仓库是 [QwenLM](https://github.com/QwenLM) 维护的 fork，源自 [`iFurySt/open-codex-computer-use`](https://github.com/iFurySt/open-codex-computer-use)。感谢原作者在 macOS accessibility 驱动的 computer-use 模式上的基础工作。

## 与上游的差异

- **跨平台**: 新增 Windows (Go + PowerShell UI Automation) 和 Linux (Go + Python AT-SPI) runtime
- **npm 发布**: 以 [`@qwen-code/open-computer-use`](https://www.npmjs.com/package/@qwen-code/open-computer-use) 发布，便于安装
- **MCP server**: 完整的 MCP stdio transport，包含 9 个 Computer Use tools
- **CLI 工具**: 新增 `doctor`、`call`、`snapshot`、`list-apps` 命令，用于诊断和脚本化
- **截图配置**: 支持通过环境变量控制截图尺寸/质量
- **Qwen Code skill**: 可安装的 Qwen Code agent skill
- **Cursor Motion**: 保留在 `experiments/` 目录，但不在 CI 中构建或发布
