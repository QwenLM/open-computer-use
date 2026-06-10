# 设计:Windows / Linux 截图尺寸·体积控制(对齐 macOS)

> 状态:设计稿(待评审) · 日期:2026-06-10 · 分支:`lazzy/cross-platform-image-sizing`

## 1. 目标

让 Windows 和 Linux runtime 支持与 macOS **同样的截图尺寸/体积控制能力**——即通过 `OPEN_COMPUTER_USE_IMAGE_*` 环境变量控制返回给模型的截图长边像素上限、PNG 字节预算、缩放下限,**且不破坏 `x/y` 像素坐标点击的精度**。

## 2. 现状(已核实)

| 平台 | 编排层 | 采集后端 | 捕获分辨率 | 降采样 | `x/y` 坐标点击 |
|---|---|---|---|---|---|
| **macOS** | Swift (`OpenComputerUseKit`) | ScreenCaptureKit | **native(Retina 2×)** | ✅ `boundedScreenshotPNGData` | ✅ 读回 PNG 像素尺寸重映射 |
| **Windows** | Go (`apps/OpenComputerUseWindows/main.go`) | PowerShell (`runtime.ps1`, `System.Drawing.CopyFromScreen`) | **logical 窗口尺寸** | ❌ 透传 | ✅ 但按 **1:1 + windowOrigin** |
| **Linux** | Go (`apps/OpenComputerUseLinux/main.go`) | Python/GDK (`runtime.py`, `pixbuf_get_from_window`) | **logical 窗口尺寸** | ❌ 透传 | ✅ 但按 **1:1 + windowOrigin** |

关键事实:

- Windows / Linux 是**两个独立的零依赖 Go module**(不同 `go.mod`,无 `go.work`,不 import 任何图像库;base64 PNG 从脚本**原样透传**给 MCP client)。
- 两边 Go 层**已有 per-app 会话状态**:`service.snapshots map[string]*appSnapshot`(get_app_state 时缓存),`appSnapshot` 同时带 `WindowBounds`(logical 尺寸)和 `ScreenshotPNGBase64`。
- `click()` 已经把模型的 `X, Y` 和 `WindowBounds` 一起塞进发往脚本的请求;脚本做 `windowOrigin + (x, y)`(Linux `runtime.py:546`;Windows `Get-ScreenPoint`)。当前截图是 logical 尺寸,故 `截图像素 == window-logical 像素`,1:1 成立。
- `scroll` / `perform_secondary_action` / `set_value` 走 `element_index`(AX frame),**与截图像素无关**,不受降采样影响。

> 注:旧 `docs/IMAGE_CAPTURE.md` 的「平台差异」表把 Windows 写成 `System.Drawing.CopyFromScreen` 是对的,但把 runtime 结构和"无坐标影响"的描述简化得不准确——本设计会一并订正。

## 3. macOS 参考行为(要复刻的语义)

`packages/OpenComputerUseKit/.../AccessibilitySnapshot.swift`:

- `ImageCaptureConfig.fromEnvironment`:读 4 个 env var,默认 `captureTimeout=5, maxPNGBytes=900_000, maxDimension=1280, minScale=0.25`;解析规则:`trim` 空白、`maxBytes` 正整数、`timeout/maxDimension` 正浮点、`minScale` 浮点且 `∈(0,1]`;非法/缺失回落默认。
- `boundedScreenshotPNGData`:
  ```
  scale = max(min(1, maxDimension / longEdge), minScale)   // 夹在 [minScale, 1]
  if scale >= 1 && originalBytes <= maxBytes: return original
  while scale >= minScale:
      data = encode(resize(image, scale))
      best = data
      if data.count <= maxBytes: return data
      scale *= 0.85
  return best
  ```
- 坐标重映射(`ComputerUseService.swift:144`):`scale = pngPixelSize / windowBounds.size`;`windowPoint = screenshotPoint / scale`。

## 4. 设计

**总原则:全部逻辑放 Go 层,PowerShell / Python 采集脚本零改动。**

### 4.1 新建共享 Go module `packages/imagebound`

独立 `go.mod`,依赖 `golang.org/x/image/draw`。模块路径沿用仓库现有 Go module 命名约定——注意现有两个 app module 仍用的是**上游** `github.com/iFurySt/open-codex-computer-use/apps/...`(fork 只重命名了 npm 包与 bundle id,未改 Go module path),新 module 路径与之保持一致即可。Windows / Linux 两个 module 各自在 `go.mod` 加 **`replace` 指令**指向本地相对路径(自包含,保持各 app 仍可独立 `go build`,不引入 `go.work`)。单一真源,改一处两端生效,共用同一套单测。

导出 API(草案):

```go
package imagebound

// Config 对应 macOS ImageCaptureConfig。
type Config struct {
    CaptureTimeout float64 // 秒;Win/Linux 见 4.4
    MaxPNGBytes    int
    MaxDimension   float64 // 长边像素上限
    MinScale       float64 // (0,1]
}

func Defaults() Config // {5, 900_000, 1280, 0.25}

// FromEnv 读 OPEN_COMPUTER_USE_IMAGE_* ,解析规则同 Swift,非法回落默认。
func FromEnv(getenv func(string) string) Config

// BoundedPNG 复刻 boundedScreenshotPNGData。
// 返回降采样后的 PNG 字节 + 实际生效的 scale(returnedLongEdge / originalLongEdge,∈[minScale,1])。
// 解码失败时返回原始字节 + scale=1(降级:绝不让缩图功能弄坏截图本身)。
func BoundedPNG(pngBytes []byte, cfg Config) (out []byte, scale float64)
```

实现要点:`image/png` 解码 → 算 `scale = max(min(1, maxDim/longEdge), minScale)` → 若 `scale>=1 && len<=maxBytes` 原样返回(scale=1)→ 否则 `golang.org/x/image/draw.ApproxBiLinear`(≈ macOS `.medium`)resize + 重编码,`×0.85` 迭代到 `<=maxBytes` 或触 `minScale` 下限,返回 best。`scale` = 最终图长边 / 原图长边。

### 4.2 get_app_state 接入(各 Go main.go)

收到脚本返回的 native base64 PNG 后:`decode base64 → imagebound.BoundedPNG → re-encode base64` 替换 `appSnapshot.ScreenshotPNGBase64`;把返回的 `scale` 存到 `appSnapshot` 新增字段 `ScreenshotScale float64`(缓存进 `service.snapshots`)。空截图 / 解码失败时 `scale=1`,行为同今天。

### 4.3 坐标重映射(各 Go main.go 的 click / drag)

`x/y` 路径下,在构造发往脚本的请求前:

```
logicalXY = modelXY / snapshot.ScreenshotScale
```

把 `logicalXY` 塞进 `psRequest.X/Y`(脚本现有 `windowOrigin + (x,y)` 不变)。`scale==0`(无快照/异常)按 `1` 处理。`element_index` / `scroll` 路径不动。

> 数学:截图像素 = window-logical × scale ⇒ window-logical = 截图像素 / scale。模型在缩小后的图上给的 `x/y` 是截图像素,÷scale 还原成 window-logical,脚本再 + windowOrigin 落到真实位置。drag 的 `from_*/to_*` 同样处理。

### 4.4 `CAPTURE_TIMEOUT` 的处理

三个尺寸/体积变量(`MAX_DIMENSION` / `MAX_BYTES` / `MIN_SCALE`)是本需求的核心,直接生效。`CAPTURE_TIMEOUT` 在 macOS 是 `SCScreenshotManager` 的异步等待上限;Win/Linux 的捕获在脚本里同步完成。处理:**若 Go 对 get_app_state 的脚本调用已有/可加超时 hook,则把 `CAPTURE_TIMEOUT` 映射过去**;否则保持 macOS-only 并在文档注明(它是捕获等待旋钮,不属于"尺寸控制")。实现期确认,不阻塞本设计。

## 5. 测试

- **`packages/imagebound` 单测(共享、平台无关)**:用 Go 合成纯色/渐变 PNG。覆盖:原图够小直接返回(scale=1)、`MAX_DIMENSION` 长边夹取、`MIN_SCALE` 地板(要求缩得比 minScale 更狠时停在 minScale,**不退回原图**——对应 macOS 0.2.3 修过的 clamp bug)、`MAX_BYTES` 预算迭代、`FromEnv` 的解析与回落、返回 `scale` 的正确性。尽量复刻 Swift 测试里的实测数值语义(如长边 1840 → 1280 / 480 / 夹到 minScale)。
- **Win/Linux `main.go` 单测**:注入带 `ScreenshotScale` 的 fake snapshot,断言 click/drag 的 `x/y` 被正确 `÷scale` 后传给脚本(脚本调用可 mock)。
- 不需要真实抓屏/真实窗口的端到端测试进 CI(平台依赖);真机 e2e 由人工在 macOS/Win/Linux 各验一次(与既有流程一致)。

## 6. 文档

- 更新 `docs/IMAGE_CAPTURE.md`:平台表改为 Win/Linux **已支持**降采样 + 坐标保真;订正旧的"无降采样/平台差异"描述;补充 `packages/imagebound` 与 Go 层接入说明。
- 新 module 加最小 `README` 或包注释,指明它是 macOS `boundedScreenshotPNGData` 的 Go 移植、是 Win/Linux 的单一真源。

## 7. 非目标

- 不改采集脚本的**捕获方式**(仍 native/logical 抓屏);只在 Go 层后处理。
- 不动 macOS 实现。
- 不引入 GUI / 新工具 / 新 MCP 能力。
- 不改 `scroll` / `element_index` / `set_value` 语义。

## 8. 风险与边界

- **HiDPI / 缩放**:Win/Linux 当前捕获与 click 都在 logical 空间(1:1),本设计只在 logical 之下做缩放,scale 自洽,不引入新的 DPI 问题。
- **窗口在 get_app_state 与 click 之间 resize/move**:与 macOS 同样的固有局限(模型在"上一张截图"上操作);用 capture-time 的 `scale`。窗口移动只影响 origin(脚本侧既有行为),不因本改动恶化。
- **给零依赖 module 加 `golang.org/x/image/draw`**:标准库扩展,体量小、维护良好,可接受。
- **降级**:解码失败 / 空图一律 `scale=1` 原样返回,缩图功能绝不弄坏截图本身。

## 9. 改动面清单(预估)

- 新增 `packages/imagebound/`(`go.mod` + `bound.go` + `config.go` + `*_test.go`)。
- `apps/OpenComputerUseWindows/`:`go.mod`(加 require+replace)、`main.go`(get_app_state 后处理 + `appSnapshot.ScreenshotScale` + click/drag ÷scale)、`main_test.go`。
- `apps/OpenComputerUseLinux/`:同上。
- `docs/IMAGE_CAPTURE.md` 订正。
- 采集脚本(`runtime.ps1` / `runtime.py`):**零改动**。
