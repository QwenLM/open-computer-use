# open-computer-use

> **This is a [QwenLM](https://github.com/QwenLM) fork** of [`iFurySt/open-codex-computer-use`](https://github.com/iFurySt/open-codex-computer-use), maintained for integration with [Qwen Code](https://github.com/QwenLM/qwen-code). For the original project, please see upstream.

[![English](https://img.shields.io/badge/English-Click-yellow)](./README.md)
[![简体中文](https://img.shields.io/badge/简体中文-点击查看-orange)](./README.zh-CN.md)

---

`open-computer-use` is an open-source `Computer Use` service wrapped as `MCP`. Any AI agent or MCP client can use it to run Computer Use on macOS, Linux, and Windows.

Originally inspired by reverse-engineering work on macOS's accessibility-driven computer-use patterns. This QwenLM fork is maintained for the Qwen Code agent's built-in desktop automation, and is published to npm as [`@qwen-code/open-computer-use`](https://www.npmjs.com/package/@qwen-code/open-computer-use).

## Demos

### Gemini CLI

https://github.com/user-attachments/assets/eacb3b15-f939-46c7-b3b3-6f876977a58d

<sub><em>Gemini CLI connects to `open-computer-use` through MCP and runs full Computer Use actions.</em></sub>

### Linux

https://github.com/user-attachments/assets/e036b1c8-2200-4896-abd4-19225915cf66

<sub><em>`open-computer-use` running on Linux.</em></sub>

## Quick Start

```bash
npm i -g @qwen-code/open-computer-use
```

**On macOS, run it once and grant `Accessibility` and `Screen Recording`. Windows and Linux do not need this step.**

```bash
open-computer-use
```

Before using it, install it into your agent:

```bash
# Install into Claude Code by writing to ~/.claude.json
open-computer-use install-claude-mcp
```

Or add it to your own client manually:

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

### Skill

Install the skill directly:

Install for Claude Code:

```bash
npx skills add QwenLM/open-computer-use -g -a claude-code --skill open-computer-use -y
```

Update an existing global install:

```bash
npx skills update open-computer-use -g -y
```

You can also manually download and install the
[`open-computer-use` skill](./skills/open-computer-use).

## More

Besides the MCP JSON config above, you can also use the built-in commands:

```bash
# Install into Claude Code by writing to ~/.claude.json
open-computer-use install-claude-mcp

# Install into Gemini CLI for the current project by writing to ./.gemini/settings.json
open-computer-use install-gemini-mcp

# Install into Gemini CLI user config instead
open-computer-use install-gemini-mcp --scope user

# Install into opencode by writing to ~/.config/opencode/opencode.json (or the active config file)
open-computer-use install-opencode-mcp

# Call a single Computer Use tool and print the MCP-style JSON result
open-computer-use call list_apps
open-computer-use call get_app_state --args '{"app":"TextEdit"}'

# Run a sequence in one process so element_index state can be reused
# Sequence runs sleep 1s between successful operations by default
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
| `OPEN_COMPUTER_USE_IMAGE_MAX_DIMENSION` | `1280` | Long-edge pixel cap for the returned PNG. The initial scale is `min(1, OPEN_COMPUTER_USE_IMAGE_MAX_DIMENSION / largestNativeDimension)`. Positive float. |
| `OPEN_COMPUTER_USE_IMAGE_MIN_SCALE` | `0.25` | Lower bound on the downsample ratio. Once the iterative loop drops below this, the largest in-budget result so far is returned even if it exceeds `OPEN_COMPUTER_USE_IMAGE_MAX_BYTES`. Float in `(0, 1]`. |

Coordinate accuracy is preserved across any downsampling — coordinate tools (`click`, `drag`, `scroll`) read the actual pixel dimensions back from the returned PNG and rescale model-supplied coordinates against the live window bounds.

These variables only affect macOS today. The Windows and Linux runtimes return native-size PNGs without downsampling.

## Cursor Motion

Cursor Motion is an experimental macOS cursor-motion lab retained from upstream. This QwenLM fork does not build or release the Cursor Motion DMG in CI; build it from source with `swift run CursorMotion` if you want to experiment with it.

## Star History

<a href="https://www.star-history.com/?repos=QwenLM%2Fopen-computer-use&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=QwenLM/open-computer-use&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=QwenLM/open-computer-use&type=date&legend=top-left" />
    <img alt="Star History Chart for open-computer-use" src="https://api.star-history.com/chart?repos=QwenLM/open-computer-use&type=date&legend=top-left" />
  </picture>
</a>

## License

[MIT](./LICENSE)
