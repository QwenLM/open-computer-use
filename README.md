# open-computer-use

[![English](https://img.shields.io/badge/English-Click-yellow)](./README.md)
[![简体中文](https://img.shields.io/badge/简体中文-点击查看-orange)](./README.zh-CN.md)

---

MCP-based Computer Use service for [Qwen Code](https://github.com/QwenLM/qwen-code) and any MCP client — controls macOS, Linux, and Windows via accessibility APIs.

Published to npm as [`@qwen-code/open-computer-use`](https://www.npmjs.com/package/@qwen-code/open-computer-use).

## Acknowledge

This project is a [QwenLM](https://github.com/QwenLM) fork of [`iFurySt/open-codex-computer-use`](https://github.com/iFurySt/open-codex-computer-use). We thank the original author for the foundational work on macOS accessibility-driven computer-use patterns.

## Differences from upstream

- **Cross-platform**: Added Windows (Go + PowerShell UI Automation) and Linux (Go + Python AT-SPI) runtimes
- **npm distribution**: Published as [`@qwen-code/open-computer-use`](https://www.npmjs.com/package/@qwen-code/open-computer-use) for easy installation
- **MCP server**: Full MCP stdio transport with 9 Computer Use tools
- **CLI tools**: Added `doctor`, `call`, `snapshot`, `list-apps` commands for diagnostics and scripting
- **Image capture tuning**: Environment variables for screenshot size/quality control
- **Qwen Code skill**: Installable skill for Qwen Code agent integration
- **Cursor Motion**: Retained in `experiments/` but not built or released in CI

## Demo

https://cloud.video.taobao.com/vod/kS1Np3LUgPSg07OQ27_z63TWIU_G4nQHBJDA4wynUmk.mp4

## Quick Start

```bash
npm i -g @qwen-code/open-computer-use
```

**On macOS, run it once and grant `Accessibility` and `Screen Recording`. Windows and Linux do not need this step.**

```bash
open-computer-use
```

Add it to your MCP client config:

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

## CLI Usage

```bash
# Call a single Computer Use tool and print the MCP-style JSON result
open-computer-use call list_apps
open-computer-use call get_app_state --args '{"app":"TextEdit"}'

# Run a sequence in one process so element_index state can be reused
open-computer-use call --calls '[{"tool":"get_app_state","args":{"app":"TextEdit"}},{"tool":"press_key","args":{"app":"TextEdit","key":"Return"}}]'
open-computer-use call --calls-file examples/textedit-overlay-seq.json --sleep 0.5

# Check permissions; onboarding only opens when something is missing
open-computer-use doctor

# Show help
open-computer-use -h
```

## Configuration

### Image capture (macOS)

The `get_app_state` screenshot and the post-action screenshots attached to every action tool can be tuned through environment variables read at capture time. All variables are optional; unset / non-numeric / out-of-range values fall back to the built-in defaults.

| Variable | Default | Meaning |
|---|---|---|
| `OPEN_COMPUTER_USE_IMAGE_CAPTURE_TIMEOUT` | `5` | Seconds to wait for `SCScreenshotManager.captureImage` before giving up. The MCP result still includes the accessibility tree on timeout; only the `image` block is dropped. Positive float. |
| `OPEN_COMPUTER_USE_IMAGE_MAX_BYTES` | `900000` | Byte budget for the encoded PNG. The downsampler iterates `scale *= 0.85` until the encoded data fits this budget OR `OPEN_COMPUTER_USE_IMAGE_MIN_SCALE` is reached. Positive integer. |
| `OPEN_COMPUTER_USE_IMAGE_MAX_DIMENSION` | `1280` | Long-edge pixel cap for the returned PNG. Initial scale is `min(1, OPEN_COMPUTER_USE_IMAGE_MAX_DIMENSION / largestNativeDimension)`, then clamped up to `OPEN_COMPUTER_USE_IMAGE_MIN_SCALE`. Positive float. |
| `OPEN_COMPUTER_USE_IMAGE_MIN_SCALE` | `0.25` | Floor on the downsample ratio. Neither `MAX_DIMENSION` nor `MAX_BYTES` will shrink below `MIN_SCALE × native`; a `MAX_DIMENSION` that would require less is clamped to this floor (it does **not** fall back to the full-size original). Lower it for more aggressive sizes. Float in `(0, 1]`. |

Coordinate accuracy is preserved across any downsampling — coordinate tools (`click`, `drag`, `scroll`) read the actual pixel dimensions back from the returned PNG and rescale model-supplied coordinates against the live window bounds.

These variables only affect macOS today. The Windows and Linux runtimes return native-size PNGs without downsampling.

See [docs/IMAGE_CAPTURE.md](docs/IMAGE_CAPTURE.md) for the full capture → downsample → encode pipeline, the constraint interaction (maxDimension / maxBytes / minScale), coordinate-mapping details, and worked examples.

## License

[MIT](./LICENSE)
