# 截图捕获与尺寸约束

本文档说明 Open Computer Use 在 macOS 上**如何捕获截图、如何对截图做尺寸与体积约束**，以及新增的 `OPEN_COMPUTER_USE_IMAGE_*` 环境变量逐项的作用与生效逻辑。

> 适用范围：截图的尺寸约束逻辑**目前仅在 macOS runtime 生效**。Windows / Linux runtime 返回原生尺寸 PNG，不做降采样（见末尾「平台差异」）。

---

## 1. 截图什么时候产生

截图由 `get_app_state` 以及所有 **action 类工具**（`click` / `drag` / `scroll` / `type_text` / `press_key` / `perform_secondary_action` / `set_value`）在执行后产生，作为 MCP result 里的 `image` content block（base64 PNG）返回给模型。`list_apps` 不产生截图。

每次都是「现拍」——动作执行后重新捕获目标 window，反映动作执行**之后**的状态。

实现入口：`AccessibilitySnapshot.swift` 的 `WindowCapture` / `boundedScreenshotPNGData`，统一出口在 `ComputerUseService.swift` 的 `snapshotResult`。

---

## 2. 捕获 → 降采样 → 编码 三段式管线

```
①捕获 (ScreenCaptureKit)         ②降采样 (boundedScreenshotPNGData)        ③编码
目标 window 的 native 像素图   →   按 env 约束缩放到尺寸/体积上限      →   PNG → base64
(Retina = 2x backing scale)        (maxDimension / maxBytes / minScale)      返回 MCP image block
```

### ① 捕获（native 分辨率）

`captureImage`（`AccessibilitySnapshot.swift`）用 `SCScreenshotManager.captureImage` 只捕获**目标 window**（非全屏）：

```swift
let scaleFactor = bestEffortScaleFactor(for: bounds)   // 屏幕 backingScaleFactor，Retina = 2
configuration.width  = max(1, Int(ceil(captureSize.width  * scaleFactor)))
configuration.height = max(1, Int(ceil(captureSize.height * scaleFactor)))
configuration.showsCursor = false
configuration.ignoreShadowsSingleWindow = true
```

所以 Retina 屏上拿到的是 **native 像素图**（例如一个 920×304 logical 的窗口 → 1840×608 native pixels）。捕获有超时保护（`OPEN_COMPUTER_USE_IMAGE_CAPTURE_TIMEOUT`，默认 5 秒）；超时则省略 image block，a11y tree 仍正常返回。

### ② 降采样（尺寸/体积约束）

`boundedScreenshotPNGData` 决定最终 PNG 的尺寸与字节数。算法（含修复后的 clamp 逻辑）：

```swift
let largestDimension = max(image.width, image.height)            // native 长边
var scale = max(min(1, maxDimension / largestDimension), minScale)  // ← 关键：夹在 [minScale, 1]

if scale >= 1 && originalPNG.count <= maxBytes {
    return originalPNG                                            // 原图已经够小，直接用
}

var best = originalPNG
while scale >= minScale {
    let data = pngEncode(resize(image, scale))
    best = data
    if data.count <= maxBytes { return data }                    // 满足字节预算，返回
    scale *= 0.85                                                // 否则继续缩 15%
}
return best                                                       // 触及 minScale 下限，返回当前最优
```

三个约束的协作关系：

1. **`maxDimension`（长边像素上限）** 决定**初始** scale = `maxDimension / native长边`。
2. **`minScale`（缩放下限）** 是 scale 的**地板**。初始 scale 会被 `max(scale, minScale)` 夹住——即使 `maxDimension` 要求缩得更狠，也不会低于 `minScale`。
3. **`maxBytes`（PNG 字节预算）** 在初始 scale 之后继续把图**逐步缩小**（每轮 ×0.85）直到 PNG 字节数达标，但同样**不会突破 `minScale` 下限**。

> **`minScale` 地板的意义**：防止图被缩到无法辨认。代价是：当 `maxDimension` 或 `maxBytes` 要求的缩放比例低于 `minScale` 时，**结果会停在 `minScale` 处**（返回 `minScale × native` 的尺寸），而不是更小。若要更激进地缩小，**同时调低 `minScale`**。

### ③ 编码

缩放后的 `CGImage` 用 `NSBitmapImageRep` 编码为 PNG，再 base64 包进 MCP `image` content block。

---

## 3. 环境变量逐项说明

所有变量**可选**、在每次截图捕获时**实时读取**（改了无需重启）。缺失 / 非数字 / 越界的值会**回落到默认值**。前后空格 / tab / 换行会被忽略。

| 变量 | 默认 | 类型 / 取值 | 作用 |
|---|---|---|---|
| `OPEN_COMPUTER_USE_IMAGE_CAPTURE_TIMEOUT` | `5` | 正浮点（秒） | `SCScreenshotManager.captureImage` 的等待上限。超时后**省略 image block**（a11y tree 仍返回），不会卡住整个 `get_app_state`。 |
| `OPEN_COMPUTER_USE_IMAGE_MAX_DIMENSION` | `1280` | 正浮点（像素） | 返回 PNG 的**长边像素上限**。初始缩放 = `min(1, maxDimension / native长边)`，再被 `minScale` 夹住。设大于 native 长边则不缩放。 |
| `OPEN_COMPUTER_USE_IMAGE_MAX_BYTES` | `900000` | 正整数（字节） | PNG 编码后的**字节预算**。降采样以 ×0.85 迭代直到字节数 ≤ 此值，或触及 `minScale` 下限为止（best-effort，达不到时返回最接近的）。 |
| `OPEN_COMPUTER_USE_IMAGE_MIN_SCALE` | `0.25` | `(0, 1]` 浮点 | 缩放比例的**下限地板**。`maxDimension` / `maxBytes` 都不能把图缩到低于 `minScale × native`。想更激进缩小就调低它。 |

### 默认行为速记

- 默认把长边压到 ≤ **1280px**，且 PNG ≤ **900KB**，但**不缩到低于原图 25%**。
- 对绝大多数窗口截图，默认值在「模型看得清」和「token/体积可控」之间取了平衡。

---

## 4. 降采样不破坏点击精度

降采样**不会**让坐标点击失准。坐标类工具（`click` / `drag` / `scroll`）的 `x/y` 是**截图像素坐标**；服务端在执行动作时，从**返回的 PNG 实际像素尺寸**反算回 window 坐标：

```
screenshot pixel (x, y)
   ↓ ÷ scale   (scale = 实际PNG像素尺寸 / window logical 尺寸，从 PNG 字节实时读出)
window-relative point
   ↓ + window.origin
global screen point  → 投递鼠标事件
```

实现：`ComputerUseService.swift` 的 `screenshotPixelToWindowPoint` / `screenshotPixelSize`（后者用 `CGImageSourceCopyPropertiesAtIndex` 从返回的 PNG 字节读 `kCGImagePropertyPixelWidth/Height`）。因此无论 `OPEN_COMPUTER_USE_IMAGE_*` 把图缩到多大，模型在缩小后的图上给的坐标都能正确映射回真实窗口位置。

> 注意：a11y tree 里元素的 `frame.x/y/w/h` 是 **window logical points**，和截图像素是不同 scale。坐标点击才需要在意截图像素空间；用 `element_index` 的 element-targeted 动作不需要算坐标。

---

## 5. 实测示例

对一个 native 长边 ≈1840px 的 Finder 窗口（同一窗口、仅改 env）：

| 配置 | 返回 PNG | 说明 |
|---|---|---|
| 默认 | `1280×607`，~258KB | 长边夹到 1280 |
| `OPEN_COMPUTER_USE_IMAGE_MAX_DIMENSION=480` | `480×227`，~52KB | 长边夹到 480 |
| `OPEN_COMPUTER_USE_IMAGE_MAX_DIMENSION=240` | `460×218`，~46KB | 240/1840=0.13 < minScale 0.25 → **夹到 minScale**（0.25×1840≈460），不会缩到 240 |
| `…MAX_DIMENSION=240` + `…MIN_SCALE=0.05` | `240×114`，~17KB | 调低 minScale 后突破下限，真正缩到 240 |
| `OPEN_COMPUTER_USE_IMAGE_MAX_BYTES=20000` + `…MIN_SCALE=0.05` | `214×102`，~17KB | 字节预算驱动，缩到 ≤20KB |

第三行是 `minScale` 地板的典型表现：**要求的尺寸低于地板时，停在地板，而不是返回更大/原图**。

---

## 6. 通过 Qwen Code 使用

Qwen Code 把 Open Computer Use 作为内置 MCP server（`npx ... mcp`）spawn，并透传整个 `process.env`。因此**在启动 qwen-code 之前** export 这些变量即可控制模型收到的截图：

```bash
export OPEN_COMPUTER_USE_IMAGE_MAX_DIMENSION=640
export OPEN_COMPUTER_USE_IMAGE_MAX_BYTES=120000
# 需要更小的图时再加：
# export OPEN_COMPUTER_USE_IMAGE_MIN_SCALE=0.1
qwen   # 之后所有 computer_use__get_app_state / action 工具的截图都按此约束
```

直接用 CLI 验证（不经过模型）：

```bash
OPEN_COMPUTER_USE_IMAGE_MAX_DIMENSION=480 \
  npx -y @qwen-code/open-computer-use call get_app_state --args '{"app":"Finder"}'
```

---

## 7. 平台差异

| 平台 | 捕获 | 降采样 / 字节约束 |
|---|---|---|
| **macOS** | ScreenCaptureKit，native（Retina 2x） | ✅ 本文所述全部生效 |
| **Windows**（实验） | `System.Drawing.CopyFromScreen`，logical 尺寸 | ❌ 无降采样，原生尺寸 PNG |
| **Linux**（实验） | GDK `pixbuf_get_from_window`，logical 尺寸 | ❌ 无降采样，原生尺寸 PNG（Wayland 全黑则省略 image） |

`OPEN_COMPUTER_USE_IMAGE_*` 目前只影响 macOS runtime。Windows / Linux 若要同等能力，需要分别在各自的 capture 路径里实现降采样并同步修正坐标映射（属于后续 TODO）。

---

## 附：版本说明

- `OPEN_COMPUTER_USE_IMAGE_*` 四个环境变量在 `@qwen-code/open-computer-use` fork 中引入。
- `minScale` 夹取修复（小 `MAX_DIMENSION` 不再退回原图，而是夹到 `minScale`）自 **0.2.3** 起生效。0.2.3 之前，`MAX_DIMENSION` 要求的缩放低于 `MIN_SCALE` 时会错误地返回**全尺寸原图**。
