# Cursor Motion

这个目录用于实现一个可独立演进、后续可单独开源的软件 cursor motion demo。

当前目标不是替换仓库主线的 `SoftwareCursorOverlay`，而是先把“轨迹几何 + 时序弹性 + 候选路径可视化”从主产品代码里拆出来，做成一个更适合试验和对比的视频 lab。

## 为什么单独放这里

- 主线 `packages/OpenComputerUseKit/.../SoftwareCursorOverlay.swift` 已经承担产品行为，不适合继续塞大量实验代码。
- 用户提供的视频和官方字符串都说明 cursor motion 有独立参数模型，适合先做一个 lab。
- 这块后续可能单独开源，先在目录边界上收口更干净。

## 当前模块边界

- `Sources/CursorMotionModel.swift`
  - heading-driven 的 `direct` / `turn` / `brake` / `orbit` candidate 族
  - 官方风格 `VelocityVerlet` spring progress
  - 独立 visual dynamics，用 visible tip/velocity/angle/fog 来驱动姿态
- `Sources/CursorLabRootView.swift`
  - 本地 demo UI、slider 调参面板、候选路径 overlay 与点击交互
- `Sources/SynthesizedCursorGlyphView.swift`
  - 参考 `scripts/render-synthesized-software-cursor.swift` 的 baseline/procedural cursor renderer

## 当前参考

- `docs/exec-plans/active/20260418-standalone-cursor-lab.md`

## 当前状态

当前已经有一个可运行的 SwiftUI demo target：

```bash
swift run CursorMotion
```

现阶段支持：

- 点击画布任意位置，先预览当前 heading-driven candidate 族，再自动选一路径并驱动 cursor 过去。
- 左上角保留 `START HANDLE`、`END HANDLE`、`ARC SIZE`、`ARC FLOW`、`SPRING` 5 个 slider，面板本身不再附带 `REPLAY` / `RESET` 按钮或额外指标文案，便于直接对照当前轨迹和画面观感。
- 右上角现在只保留 `DEBUG` 一个 switch；`MAIL` / `CLICK` 已移除，click pulse 默认始终跟随当前 move 状态显示，不再单独暴露测试开关。
- 左右两个角上的 panel 现在已经收成同一套更实的灰白卡片容器：相同的内边距、圆角、描边和阴影，并且降低了底层背景渐变透出来的程度，避免浅色区域里卡片边界发虚。
- slider 调参时会重算当前 session 的整条 reference path，同时保持 cursor 本体停在当前位置；因此 `DEBUG` 开着时，settled 后继续拖 slider 也还能看到完整曲线反馈，不会退化成零长度路径。
- `START HANDLE` 现在优先改变起步段的 guide / reach / normal 偏置，`END HANDLE` 则优先改变收尾段的 guide / reach / normal 偏置；两者不再只是一起放大整条曲线。
- `ARC SIZE` 现在明确表示轨迹弧度本身，不是 cursor glyph 的尺寸；它会同时改变弧高/控制点侧向偏移，以及 chooser 对更直路径和更宽弧线路径的偏好。
- `ARC FLOW` 现在明确表示“最宽弧段沿 start→end 主轴更靠前还是更靠后”；它不负责把弧变大，而是优先改单段 cubic 控制点的前后相位偏置。
- `SPRING` 现在明确表示 progress spring 本身的快慢与阻尼，不再叠加额外 distance-based duration fudge；`0.5` 档会精确回到官方 `response=1.4`、`damping=0.9`、`343/240` endpoint-lock 时间，往左更快，往右更慢。
- debug overlay 会显示控制点、arc handle 和当前选中的 candidate id / score。
- 关闭 `DEBUG` 后不会展示任何轨迹线或目标点，只保留 cursor 本体，便于单独观察最终运动观感。
- `DEBUG` switch 的开启态现在直接复用左侧 slider 的 accent 渐变，关闭态则收成浅灰底，避免开关两档的底色过近、肉眼不容易分辨。
- lab 主线不再直接复用 raw binary lift 的 `20` 条 candidate + score；当前改为 reverse-engineering 约束下的 heading-driven chooser，把起始朝向和最终 resting pose 一起喂给路径选择器，让默认曲线更稳定收敛到单侧 C 形或近直线。
- 主路径进度不再用 speculative `easeInOut` 或 terminal settle；现在直接复用官方风格 spring progress。
- 默认档的 wall-clock move 时长现在直接对齐 reverse-engineered 官方 endpoint-lock 时间 `343 / 240 = 1.4291667s`；不再额外按路径距离压缩时长。
- 可见 cursor 不再直接贴在 path sample 上，而是经过独立 visual dynamics 状态，再输出 `rotation + cursorBodyOffset + fogOffset + fogScale`。
- 候选路径现在显式约束“先顺车头方向掉头，再沿主轴推进，再按 resting pose 收尾”；因此大多数跨向移动会呈现单侧 C 形，需要直接切入时才会退化为近直线，而不会再出现两侧乱甩的 S 形扭曲。
- 箭头的可见角度现在重新对齐官方抽帧与逆向证据：moving 阶段持续跟随当前 move heading，接近停住后再平滑回到默认 resting pose，并继续做原地小摆角。
- cursor glyph 不再走之前那套亮白 asset；当前优先直接显示仓库里的官方 `252x252` runtime baseline 图，缺失时才退回脚本同款 procedural pointer/fog。
- settle 态不再做 XY 漂移；现在改成和参考脚本一致的中心固定小摆角，让“停住以后原地轻微转动”的观感先对齐。

后续实现应优先保持：

- 不要再把未验证的 slider 参数语义伪装成“官方实现”。
- slider 可以作为本地调参入口保留，但要明确它们是 heading-driven lab 的测试旋钮，不是已经 binary-confirmed 的一一字段映射。
- 为了避免默认样例里 `END HANDLE` 被过紧的 corridor bounds 提前裁掉，lab 现在直接以画布内缩后的实际 canvas bounds 做选路和 control clipping。
- 当前 `ARC SIZE` 的实现边界是“局部 heading-driven path 的弧高和 arched family 倾向”；它不是在调 cursor 资源尺寸，也不宣称已经和 release binary 的 `tableA/tableB/arcExtent` 一一对上。
- 当前 `ARC FLOW` 的实现边界是“单段 cubic 的前后相位偏置”；它更接近 reverse-engineering 里 `arcAnchorBias` 这类几何前后偏置，不宣称已经和 release binary 内部某个独立 `flow` 字段一一对应。
- 当前 `SPRING` 的实现边界是“围绕官方 `1.4 / 0.9` 的 centered spring remap”；它直接改变 progress spring 的 `response / damping` 与 endpoint-lock 时间，但不宣称已经恢复出 release app 内部 debug slider 的精确 remap helper。
- 路径层、progress 层和 visible pose 层继续保持分离。
- 没有真实 target window 的场景里，要明确区分 `StandaloneCursor` 的 raw reverse-engineered pool 和 `CursorMotion` 的 heading-driven 主线实现。
- demo host 可以替换，但 motion model 和 visual dynamics 应保持可单独复用。
