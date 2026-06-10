# Cross-Platform Screenshot Sizing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the macOS screenshot size/byte control (`OPEN_COMPUTER_USE_IMAGE_*`) to the Windows and Linux runtimes, preserving `x/y` click accuracy.

**Architecture:** All new logic lives in the Go layer; the PowerShell/Python capture scripts are untouched. A new shared Go module `packages/imagebound` ports `boundedScreenshotPNGData` + env parsing; both app modules reference it via a local `replace` directive. After the capture script returns a native-size PNG, Go downsamples it and records the applied `scale` on the cached `appSnapshot`; `click`/`drag` divide model-supplied `x/y` by that scale before sending to the script (whose existing `windowOrigin + (x,y)` then lands correctly).

**Tech Stack:** Go 1.22, `golang.org/x/image/draw` (ApproxBiLinear resize), stdlib `image/png`.

**Prerequisites (execution environment):**
- `go` 1.22+ on `PATH` (verify `go version`).
- Network access for `go get golang.org/x/image` (not yet in the module cache).
- Spec: `docs/superpowers/specs/2026-06-10-cross-platform-screenshot-sizing-design.md`.

---

## File Structure

- **Create** `packages/imagebound/go.mod` — new shared module.
- **Create** `packages/imagebound/config.go` — `Config`, `Defaults()`, `FromEnv()` + parsers.
- **Create** `packages/imagebound/config_test.go` — env-parsing tests.
- **Create** `packages/imagebound/bound.go` — `BoundedPNG()` + resize.
- **Create** `packages/imagebound/bound_test.go` — downsample tests + PNG helpers.
- **Modify** `apps/OpenComputerUseWindows/go.mod` — add `require` + `replace` for imagebound.
- **Modify** `apps/OpenComputerUseWindows/main.go` — `appSnapshot.ScreenshotScale`; `applyImageBounds`; `scaleCoord`; wire into `refreshSnapshot`, `click`, `drag`.
- **Modify** `apps/OpenComputerUseWindows/main_test.go` — `scaleCoord` + `applyImageBounds` tests.
- **Modify** `apps/OpenComputerUseLinux/{go.mod,main.go,main_test.go}` — identical changes (`linuxRequest`/`runPython` instead of `psRequest`/`runPowerShell`).
- **Modify** `docs/IMAGE_CAPTURE.md` — platform table + correct the "no downsample" note.

Capture scripts (`runtime.ps1`, `runtime.py`): **no changes.**

---

## Task 1: Shared `imagebound` module — Config + FromEnv

**Files:**
- Create: `packages/imagebound/go.mod`
- Create: `packages/imagebound/config.go`
- Create: `packages/imagebound/config_test.go`

- [ ] **Step 1: Init the module**

Run (module path matches the upstream base path the app modules already use):
```bash
cd packages/imagebound
go mod init github.com/iFurySt/open-codex-computer-use/packages/imagebound
go mod edit -go=1.22
```
Expected: `go.mod` created with `module github.com/iFurySt/open-codex-computer-use/packages/imagebound` and `go 1.22`.

- [ ] **Step 2: Write the failing config test**

Create `packages/imagebound/config_test.go`:
```go
package imagebound

import "testing"

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestDefaults(t *testing.T) {
	d := Defaults()
	if d.CaptureTimeout != 5 || d.MaxPNGBytes != 900_000 || d.MaxDimension != 1280 || d.MinScale != 0.25 {
		t.Fatalf("unexpected defaults: %+v", d)
	}
}

func TestFromEnvEmptyReturnsDefaults(t *testing.T) {
	if got := FromEnv(env(nil)); got != Defaults() {
		t.Fatalf("empty env should equal defaults, got %+v", got)
	}
}

func TestFromEnvReadsAllFour(t *testing.T) {
	got := FromEnv(env(map[string]string{
		"OPEN_COMPUTER_USE_IMAGE_CAPTURE_TIMEOUT": "3",
		"OPEN_COMPUTER_USE_IMAGE_MAX_BYTES":       "120000",
		"OPEN_COMPUTER_USE_IMAGE_MAX_DIMENSION":   "640",
		"OPEN_COMPUTER_USE_IMAGE_MIN_SCALE":       "0.1",
	}))
	want := Config{CaptureTimeout: 3, MaxPNGBytes: 120000, MaxDimension: 640, MinScale: 0.1}
	if got != want {
		t.Fatalf("got %+v want %+v", got, want)
	}
}

func TestFromEnvPartialOverrideKeepsOtherDefaults(t *testing.T) {
	got := FromEnv(env(map[string]string{"OPEN_COMPUTER_USE_IMAGE_MAX_DIMENSION": "480"}))
	if got.MaxDimension != 480 || got.MaxPNGBytes != 900_000 || got.MinScale != 0.25 || got.CaptureTimeout != 5 {
		t.Fatalf("partial override wrong: %+v", got)
	}
}

func TestFromEnvIgnoresNonNumeric(t *testing.T) {
	got := FromEnv(env(map[string]string{
		"OPEN_COMPUTER_USE_IMAGE_MAX_BYTES":     "abc",
		"OPEN_COMPUTER_USE_IMAGE_MAX_DIMENSION": "  ",
	}))
	if got != Defaults() {
		t.Fatalf("non-numeric should fall back to defaults, got %+v", got)
	}
}

func TestFromEnvIgnoresZeroAndNegative(t *testing.T) {
	got := FromEnv(env(map[string]string{
		"OPEN_COMPUTER_USE_IMAGE_MAX_BYTES":     "0",
		"OPEN_COMPUTER_USE_IMAGE_MAX_DIMENSION": "-10",
		"OPEN_COMPUTER_USE_IMAGE_MIN_SCALE":     "0",
	}))
	if got != Defaults() {
		t.Fatalf("zero/negative should fall back, got %+v", got)
	}
}

func TestFromEnvMinScaleOutOfRangeIgnored(t *testing.T) {
	if got := FromEnv(env(map[string]string{"OPEN_COMPUTER_USE_IMAGE_MIN_SCALE": "1.5"})); got.MinScale != 0.25 {
		t.Fatalf("minScale > 1 should be ignored, got %v", got.MinScale)
	}
	if got := FromEnv(env(map[string]string{"OPEN_COMPUTER_USE_IMAGE_MIN_SCALE": "1"})); got.MinScale != 1 {
		t.Fatalf("minScale == 1 should be accepted, got %v", got.MinScale)
	}
}
```

- [ ] **Step 3: Run the test, verify it fails to compile**

Run: `cd packages/imagebound && go test ./...`
Expected: FAIL — `undefined: FromEnv`, `undefined: Defaults`, `undefined: Config`.

- [ ] **Step 4: Implement config.go**

Create `packages/imagebound/config.go`:
```go
// Package imagebound ports the macOS boundedScreenshotPNGData screenshot
// size/byte control to the cross-platform Go runtimes (Windows, Linux).
// It is the single source of truth shared by both app modules via a local
// replace directive — see their go.mod files.
package imagebound

import (
	"math"
	"strconv"
	"strings"
)

// Config mirrors the macOS ImageCaptureConfig.
type Config struct {
	CaptureTimeout float64 // seconds; capture-wait knob (see docs/IMAGE_CAPTURE.md)
	MaxPNGBytes    int     // PNG byte budget after encoding
	MaxDimension   float64 // long-edge pixel cap
	MinScale       float64 // downscale floor, in (0,1]
}

// Defaults matches the macOS hardcoded fallback (ImageCaptureConfig.defaults).
func Defaults() Config {
	return Config{
		CaptureTimeout: 5,
		MaxPNGBytes:    900_000,
		MaxDimension:   1280,
		MinScale:       0.25,
	}
}

// FromEnv reads OPEN_COMPUTER_USE_IMAGE_* overrides via getenv. Any unset,
// non-numeric, or out-of-range value falls back to the corresponding default.
// Parsing rules mirror the Swift implementation (trim whitespace; positive
// int for MAX_BYTES; positive finite float for TIMEOUT/MAX_DIMENSION;
// MIN_SCALE a finite float in (0,1]).
func FromEnv(getenv func(string) string) Config {
	cfg := Defaults()
	if v, ok := parsePositiveFloat(getenv("OPEN_COMPUTER_USE_IMAGE_CAPTURE_TIMEOUT")); ok {
		cfg.CaptureTimeout = v
	}
	if v, ok := parsePositiveInt(getenv("OPEN_COMPUTER_USE_IMAGE_MAX_BYTES")); ok {
		cfg.MaxPNGBytes = v
	}
	if v, ok := parsePositiveFloat(getenv("OPEN_COMPUTER_USE_IMAGE_MAX_DIMENSION")); ok {
		cfg.MaxDimension = v
	}
	if v, ok := parseUnitInterval(getenv("OPEN_COMPUTER_USE_IMAGE_MIN_SCALE")); ok {
		cfg.MinScale = v
	}
	return cfg
}

func parsePositiveInt(raw string) (int, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return 0, false
	}
	v, err := strconv.Atoi(s)
	if err != nil || v <= 0 {
		return 0, false
	}
	return v, true
}

func parsePositiveFloat(raw string) (float64, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || v <= 0 || math.IsInf(v, 0) || math.IsNaN(v) {
		return 0, false
	}
	return v, true
}

func parseUnitInterval(raw string) (float64, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || v <= 0 || v > 1 || math.IsInf(v, 0) || math.IsNaN(v) {
		return 0, false
	}
	return v, true
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `cd packages/imagebound && go test ./...`
Expected: PASS (all config tests).

- [ ] **Step 6: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
git add packages/imagebound/go.mod packages/imagebound/config.go packages/imagebound/config_test.go
git commit -m "feat(imagebound): add Config + FromEnv env parsing (shared Go module)"
```

---

## Task 2: `imagebound.BoundedPNG` — bounded downsample

**Files:**
- Modify: `packages/imagebound/go.mod` (adds `golang.org/x/image` dep)
- Create: `packages/imagebound/bound.go`
- Create: `packages/imagebound/bound_test.go`

- [ ] **Step 1: Add the resize dependency**

Run:
```bash
cd packages/imagebound
go get golang.org/x/image/draw
```
Expected: `go.mod` gains `require golang.org/x/image vX.Y.Z`; `go.sum` created.

- [ ] **Step 2: Write the failing downsample test**

Create `packages/imagebound/bound_test.go`:
```go
package imagebound

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

// makeTestPNG builds a w×h gradient PNG (enough entropy that byte-budget
// shrinking is meaningful).
func makeTestPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x % 256), uint8(y % 256), uint8((x + y) % 256), 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode test png: %v", err)
	}
	return buf.Bytes()
}

func pngLongEdge(t *testing.T, data []byte) int {
	t.Helper()
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decode config: %v", err)
	}
	if cfg.Width > cfg.Height {
		return cfg.Width
	}
	return cfg.Height
}

func TestBoundedPNGKeepsSmallImages(t *testing.T) {
	in := makeTestPNG(t, 32, 32)
	out, scale := BoundedPNG(in, Config{MaxPNGBytes: 1_000_000, MaxDimension: 320, MinScale: 0.25})
	if scale != 1 {
		t.Fatalf("small image should keep scale 1, got %v", scale)
	}
	if pngLongEdge(t, out) != 32 {
		t.Fatalf("small image should stay 32px, got %d", pngLongEdge(t, out))
	}
}

func TestBoundedPNGShrinksToMaxDimension(t *testing.T) {
	in := makeTestPNG(t, 1000, 1000)
	out, scale := BoundedPNG(in, Config{MaxPNGBytes: 10_000_000, MaxDimension: 320, MinScale: 0.05})
	if le := pngLongEdge(t, out); le > 320 {
		t.Fatalf("long edge should be <= 320, got %d", le)
	}
	if scale >= 1 || scale < 0.05 {
		t.Fatalf("scale should be in [0.05,1), got %v", scale)
	}
}

func TestBoundedPNGClampsToMinScaleInsteadOfReturningOriginal(t *testing.T) {
	// maxDimension 120 against 1000px demands scale 0.12 < minScale 0.25, so
	// it must clamp UP to 0.25 (long edge 250) — NOT return the 1000px original.
	in := makeTestPNG(t, 1000, 1000)
	out, scale := BoundedPNG(in, Config{MaxPNGBytes: 10_000_000, MaxDimension: 120, MinScale: 0.25})
	if le := pngLongEdge(t, out); le != 250 {
		t.Fatalf("expected long edge clamped to 250 (minScale floor), got %d", le)
	}
	if scale < 0.24 || scale > 0.26 {
		t.Fatalf("expected scale ~0.25, got %v", scale)
	}
}

func TestBoundedPNGLowerMinScaleAllowsSmaller(t *testing.T) {
	in := makeTestPNG(t, 1000, 1000)
	out, _ := BoundedPNG(in, Config{MaxPNGBytes: 10_000_000, MaxDimension: 120, MinScale: 0.05})
	if le := pngLongEdge(t, out); le > 120 {
		t.Fatalf("lower minScale should allow long edge ~120, got %d", le)
	}
}

func TestBoundedPNGByteBudgetShrinksFurther(t *testing.T) {
	in := makeTestPNG(t, 1000, 1000)
	out, scale := BoundedPNG(in, Config{MaxPNGBytes: 50_000, MaxDimension: 1280, MinScale: 0.05})
	if len(out) > 50_000 {
		t.Fatalf("byte budget not honored: %d bytes", len(out))
	}
	if scale >= 1 {
		t.Fatalf("byte budget should force scale < 1, got %v", scale)
	}
}

func TestBoundedPNGInvalidInputReturnsOriginal(t *testing.T) {
	in := []byte("not a png")
	out, scale := BoundedPNG(in, Defaults())
	if scale != 1 || !bytes.Equal(out, in) {
		t.Fatalf("invalid input should be returned unchanged with scale 1")
	}
}

func TestBoundedPNGEmptyInputReturnsOriginal(t *testing.T) {
	out, scale := BoundedPNG(nil, Defaults())
	if scale != 1 || out != nil {
		t.Fatalf("nil input should return nil, scale 1")
	}
}
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `cd packages/imagebound && go test ./...`
Expected: FAIL — `undefined: BoundedPNG`.

- [ ] **Step 4: Implement bound.go**

Create `packages/imagebound/bound.go`:
```go
package imagebound

import (
	"bytes"
	"image"
	"image/png"
	"math"

	xdraw "golang.org/x/image/draw"
)

// BoundedPNG mirrors macOS boundedScreenshotPNGData: shrink the PNG to honor
// MaxDimension (long-edge cap) and MaxPNGBytes (byte budget), never below the
// MinScale floor. Returns the (possibly re-encoded) PNG and the scale that was
// applied (returnedLongEdge / originalLongEdge, in [MinScale, 1]).
//
// On empty input or PNG decode failure it returns the original bytes and
// scale 1 — the size policy must never corrupt the screenshot itself.
func BoundedPNG(pngBytes []byte, cfg Config) ([]byte, float64) {
	if len(pngBytes) == 0 || cfg.MaxPNGBytes <= 0 {
		return pngBytes, 1
	}
	img, err := png.Decode(bytes.NewReader(pngBytes))
	if err != nil {
		return pngBytes, 1
	}
	w := img.Bounds().Dx()
	h := img.Bounds().Dy()
	if w <= 0 || h <= 0 {
		return pngBytes, 1
	}

	longEdge := float64(w)
	if h > w {
		longEdge = float64(h)
	}
	minScale := cfg.MinScale
	if minScale <= 0 || minScale > 1 {
		minScale = Defaults().MinScale
	}

	// Honor MaxDimension, but never shrink below the minScale floor.
	scale := math.Min(1, cfg.MaxDimension/longEdge)
	if scale < minScale {
		scale = minScale
	}

	if scale >= 1 && len(pngBytes) <= cfg.MaxPNGBytes {
		return pngBytes, 1
	}

	best := pngBytes
	bestScale := 1.0
	for scale >= minScale {
		data, applied, ok := encodeResized(img, scale)
		if !ok {
			break
		}
		best = data
		bestScale = applied
		if len(data) <= cfg.MaxPNGBytes {
			return data, applied
		}
		scale *= 0.85
	}
	return best, bestScale
}

// encodeResized resizes img by scale and PNG-encodes it. Returns the encoded
// bytes and the actual long-edge ratio after integer rounding (the value used
// for coordinate remapping), or ok=false on failure.
func encodeResized(img image.Image, scale float64) ([]byte, float64, bool) {
	w := img.Bounds().Dx()
	h := img.Bounds().Dy()
	newW := int(math.Round(float64(w) * scale))
	newH := int(math.Round(float64(h) * scale))
	if newW < 1 {
		newW = 1
	}
	if newH < 1 {
		newH = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, newW, newH))
	xdraw.ApproxBiLinear.Scale(dst, dst.Bounds(), img, img.Bounds(), xdraw.Over, nil)
	var buf bytes.Buffer
	if err := png.Encode(&buf, dst); err != nil {
		return nil, 0, false
	}
	origLong, newLong := w, newW
	if h > w {
		origLong, newLong = h, newH
	}
	return buf.Bytes(), float64(newLong) / float64(origLong), true
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `cd packages/imagebound && go test ./...`
Expected: PASS (all config + bound tests).

- [ ] **Step 6: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
git add packages/imagebound/go.mod packages/imagebound/go.sum packages/imagebound/bound.go packages/imagebound/bound_test.go
git commit -m "feat(imagebound): add BoundedPNG bounded downsample"
```

---

## Task 3: Wire the Windows runtime

**Files:**
- Modify: `apps/OpenComputerUseWindows/go.mod` (require + replace)
- Modify: `apps/OpenComputerUseWindows/main.go` (struct field + 2 helpers + 3 call sites)
- Modify: `apps/OpenComputerUseWindows/main_test.go`

- [ ] **Step 1: Add the imagebound dependency via replace**

Run:
```bash
cd apps/OpenComputerUseWindows
go mod edit -require=github.com/iFurySt/open-codex-computer-use/packages/imagebound@v0.0.0
go mod edit -replace=github.com/iFurySt/open-codex-computer-use/packages/imagebound=../../packages/imagebound
go mod tidy
```
Expected: `go.mod` has the `require` + `replace`; `go.sum` gains `golang.org/x/image` (transitive). `go mod tidy` succeeds.

- [ ] **Step 2: Write the failing helper tests**

Add to `apps/OpenComputerUseWindows/main_test.go` (keep existing tests; append these + the import block at top if not present):
```go
import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func mkPNGBase64(t *testing.T, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x % 256), uint8(y % 256), uint8((x + y) % 256), 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode: %v", err)
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

func pngLongEdgeB64(t *testing.T, b64 string) int {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatalf("decode b64: %v", err)
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("decode cfg: %v", err)
	}
	if cfg.Width > cfg.Height {
		return cfg.Width
	}
	return cfg.Height
}

func ptr(v float64) *float64 { return &v }

func TestScaleCoordDividesByScale(t *testing.T) {
	got := scaleCoord(ptr(250), 0.5)
	if got == nil || *got != 500 {
		t.Fatalf("250 / 0.5 should be 500, got %v", got)
	}
}

func TestScaleCoordNilReturnsNil(t *testing.T) {
	if scaleCoord(nil, 0.5) != nil {
		t.Fatalf("nil input should return nil")
	}
}

func TestScaleCoordNonPositiveScaleIsIdentity(t *testing.T) {
	if got := scaleCoord(ptr(250), 0); got == nil || *got != 250 {
		t.Fatalf("scale 0 should be identity, got %v", got)
	}
	if got := scaleCoord(ptr(250), 1); got == nil || *got != 250 {
		t.Fatalf("scale 1 should be identity, got %v", got)
	}
}

func TestApplyImageBoundsShrinksAndSetsScale(t *testing.T) {
	t.Setenv("OPEN_COMPUTER_USE_IMAGE_MAX_DIMENSION", "320")
	t.Setenv("OPEN_COMPUTER_USE_IMAGE_MAX_BYTES", "10000000")
	t.Setenv("OPEN_COMPUTER_USE_IMAGE_MIN_SCALE", "0.05")
	snap := &appSnapshot{ScreenshotPNGBase64: mkPNGBase64(t, 1000, 1000)}
	applyImageBounds(snap)
	if snap.ScreenshotScale >= 1 || snap.ScreenshotScale <= 0 {
		t.Fatalf("scale should be in (0,1), got %v", snap.ScreenshotScale)
	}
	if le := pngLongEdgeB64(t, snap.ScreenshotPNGBase64); le > 320 {
		t.Fatalf("downsampled long edge should be <= 320, got %d", le)
	}
}

func TestApplyImageBoundsEmptyScreenshotKeepsScaleOne(t *testing.T) {
	snap := &appSnapshot{}
	applyImageBounds(snap)
	if snap.ScreenshotScale != 1 {
		t.Fatalf("empty screenshot should keep scale 1, got %v", snap.ScreenshotScale)
	}
}

func TestApplyImageBoundsInvalidBase64KeepsScaleOne(t *testing.T) {
	snap := &appSnapshot{ScreenshotPNGBase64: "!!not-base64!!"}
	applyImageBounds(snap)
	if snap.ScreenshotScale != 1 || snap.ScreenshotPNGBase64 != "!!not-base64!!" {
		t.Fatalf("invalid base64 should be left unchanged with scale 1")
	}
}
```
> If `main_test.go` already has an `import (...)` block, merge these imports into it instead of adding a second block.

- [ ] **Step 3: Run the tests, verify they fail**

Run: `cd apps/OpenComputerUseWindows && go test ./...`
Expected: FAIL — `undefined: scaleCoord`, `undefined: applyImageBounds`, `appSnapshot has no field ScreenshotScale`.

- [ ] **Step 4: Add the `ScreenshotScale` field**

In `apps/OpenComputerUseWindows/main.go`, `type appSnapshot struct` (around line 80), add the field (note `json:"-"` — internal only, never (de)serialized):
```go
type appSnapshot struct {
	App                 appDescriptor   `json:"app"`
	WindowTitle         string          `json:"windowTitle,omitempty"`
	WindowBounds        *frame          `json:"windowBounds,omitempty"`
	ScreenshotPNGBase64 string          `json:"screenshotPngBase64,omitempty"`
	ScreenshotScale     float64         `json:"-"`
	TreeLines           []string        `json:"treeLines,omitempty"`
	FocusedSummary      string          `json:"focusedSummary,omitempty"`
	SelectedText        string          `json:"selectedText,omitempty"`
	Elements            []elementRecord `json:"elements,omitempty"`
}
```

- [ ] **Step 5: Add `applyImageBounds` + `scaleCoord` helpers**

In `apps/OpenComputerUseWindows/main.go`, add these two functions (e.g., just after `rememberSnapshot`), plus the imports `encoding/base64`, `os`, and `github.com/iFurySt/open-codex-computer-use/packages/imagebound`:
```go
// applyImageBounds downsamples the snapshot's screenshot per the
// OPEN_COMPUTER_USE_IMAGE_* env vars and records the applied scale so that
// click/drag can remap screenshot-pixel coordinates back to window-logical
// space. Empty / undecodable screenshots are left unchanged with scale 1.
func applyImageBounds(snapshot *appSnapshot) {
	snapshot.ScreenshotScale = 1
	if snapshot.ScreenshotPNGBase64 == "" {
		return
	}
	raw, err := base64.StdEncoding.DecodeString(snapshot.ScreenshotPNGBase64)
	if err != nil {
		return
	}
	bounded, scale := imagebound.BoundedPNG(raw, imagebound.FromEnv(os.Getenv))
	snapshot.ScreenshotScale = scale
	snapshot.ScreenshotPNGBase64 = base64.StdEncoding.EncodeToString(bounded)
}

// scaleCoord maps a model-supplied screenshot-pixel coordinate back to
// window-logical space by dividing out the downsample scale. Returns a new
// pointer, or nil when the input is nil. A non-positive scale is treated as 1.
func scaleCoord(v *float64, scale float64) *float64 {
	if v == nil {
		return nil
	}
	if scale <= 0 {
		scale = 1
	}
	out := *v / scale
	return &out
}
```

- [ ] **Step 6: Call `applyImageBounds` in `refreshSnapshot`**

In `apps/OpenComputerUseWindows/main.go`, `refreshSnapshot` (around line 394), insert the call after the `response.Snapshot == nil` guard and before `rememberSnapshot`:
```go
	if response.Snapshot == nil {
		return nil, textResult("Windows runtime did not return an app snapshot.", true)
	}
	applyImageBounds(response.Snapshot)
	s.rememberSnapshot(app, response.Snapshot)
	return response.Snapshot, toolCallResult{}
```

- [ ] **Step 7: Remap `x/y` in `click`**

In `click` (around line 250), replace the `X: x, Y: y` lines with scaled copies:
```go
	request := psRequest{
		Tool:         "click",
		App:          app,
		X:            scaleCoord(x, snapshot.ScreenshotScale),
		Y:            scaleCoord(y, snapshot.ScreenshotScale),
		ClickCount:   clickCount,
		MouseButton:  mouseButton,
		WindowBounds: snapshot.WindowBounds,
	}
```

- [ ] **Step 8: Remap `from_*`/`to_*` in `drag`**

In `drag` (around line 335), replace the final return with scaled copies:
```go
	return s.actionResult(app, psRequest{
		Tool:         "drag",
		App:          app,
		FromX:        scaleCoord(fromX, snapshot.ScreenshotScale),
		FromY:        scaleCoord(fromY, snapshot.ScreenshotScale),
		ToX:          scaleCoord(toX, snapshot.ScreenshotScale),
		ToY:          scaleCoord(toY, snapshot.ScreenshotScale),
		WindowBounds: snapshot.WindowBounds,
	})
```

- [ ] **Step 9: Run the tests, verify they pass**

Run: `cd apps/OpenComputerUseWindows && go test ./... && go vet ./...`
Expected: PASS (new helper tests + existing tests); vet clean.

- [ ] **Step 10: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
git add apps/OpenComputerUseWindows/go.mod apps/OpenComputerUseWindows/go.sum apps/OpenComputerUseWindows/main.go apps/OpenComputerUseWindows/main_test.go
git commit -m "feat(windows): downsample screenshots + remap click coords via imagebound"
```

---

## Task 4: Wire the Linux runtime

Identical to Task 3 but the request type is `linuxRequest` (not `psRequest`) and the runtime error string differs. The helper code (`scaleCoord`, `applyImageBounds`) is byte-identical.

**Files:**
- Modify: `apps/OpenComputerUseLinux/go.mod`
- Modify: `apps/OpenComputerUseLinux/main.go`
- Modify: `apps/OpenComputerUseLinux/main_test.go`

- [ ] **Step 1: Add the imagebound dependency via replace**

```bash
cd apps/OpenComputerUseLinux
go mod edit -require=github.com/iFurySt/open-codex-computer-use/packages/imagebound@v0.0.0
go mod edit -replace=github.com/iFurySt/open-codex-computer-use/packages/imagebound=../../packages/imagebound
go mod tidy
```

- [ ] **Step 2: Write the failing helper tests**

Append to `apps/OpenComputerUseLinux/main_test.go` (merge imports if a block already exists):
```go
import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func mkPNGBase64(t *testing.T, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x % 256), uint8(y % 256), uint8((x + y) % 256), 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode: %v", err)
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

func pngLongEdgeB64(t *testing.T, b64 string) int {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatalf("decode b64: %v", err)
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("decode cfg: %v", err)
	}
	if cfg.Width > cfg.Height {
		return cfg.Width
	}
	return cfg.Height
}

func ptr(v float64) *float64 { return &v }

func TestScaleCoordDividesByScale(t *testing.T) {
	got := scaleCoord(ptr(250), 0.5)
	if got == nil || *got != 500 {
		t.Fatalf("250 / 0.5 should be 500, got %v", got)
	}
}

func TestScaleCoordNilReturnsNil(t *testing.T) {
	if scaleCoord(nil, 0.5) != nil {
		t.Fatalf("nil input should return nil")
	}
}

func TestScaleCoordNonPositiveScaleIsIdentity(t *testing.T) {
	if got := scaleCoord(ptr(250), 0); got == nil || *got != 250 {
		t.Fatalf("scale 0 should be identity, got %v", got)
	}
	if got := scaleCoord(ptr(250), 1); got == nil || *got != 250 {
		t.Fatalf("scale 1 should be identity, got %v", got)
	}
}

func TestApplyImageBoundsShrinksAndSetsScale(t *testing.T) {
	t.Setenv("OPEN_COMPUTER_USE_IMAGE_MAX_DIMENSION", "320")
	t.Setenv("OPEN_COMPUTER_USE_IMAGE_MAX_BYTES", "10000000")
	t.Setenv("OPEN_COMPUTER_USE_IMAGE_MIN_SCALE", "0.05")
	snap := &appSnapshot{ScreenshotPNGBase64: mkPNGBase64(t, 1000, 1000)}
	applyImageBounds(snap)
	if snap.ScreenshotScale >= 1 || snap.ScreenshotScale <= 0 {
		t.Fatalf("scale should be in (0,1), got %v", snap.ScreenshotScale)
	}
	if le := pngLongEdgeB64(t, snap.ScreenshotPNGBase64); le > 320 {
		t.Fatalf("downsampled long edge should be <= 320, got %d", le)
	}
}

func TestApplyImageBoundsEmptyScreenshotKeepsScaleOne(t *testing.T) {
	snap := &appSnapshot{}
	applyImageBounds(snap)
	if snap.ScreenshotScale != 1 {
		t.Fatalf("empty screenshot should keep scale 1, got %v", snap.ScreenshotScale)
	}
}

func TestApplyImageBoundsInvalidBase64KeepsScaleOne(t *testing.T) {
	snap := &appSnapshot{ScreenshotPNGBase64: "!!not-base64!!"}
	applyImageBounds(snap)
	if snap.ScreenshotScale != 1 || snap.ScreenshotPNGBase64 != "!!not-base64!!" {
		t.Fatalf("invalid base64 should be left unchanged with scale 1")
	}
}
```

- [ ] **Step 3: Run the tests, verify they fail**

Run: `cd apps/OpenComputerUseLinux && go test ./...`
Expected: FAIL — `undefined: scaleCoord`, `undefined: applyImageBounds`, `appSnapshot has no field ScreenshotScale`.

- [ ] **Step 4: Add the `ScreenshotScale` field**

In `apps/OpenComputerUseLinux/main.go`, `type appSnapshot struct` (around line 83), add `ScreenshotScale float64 ` with tag `json:"-"` immediately after `ScreenshotPNGBase64`:
```go
	ScreenshotPNGBase64 string          `json:"screenshotPngBase64,omitempty"`
	ScreenshotScale     float64         `json:"-"`
```

- [ ] **Step 5: Add `applyImageBounds` + `scaleCoord` helpers**

In `apps/OpenComputerUseLinux/main.go`, add (just after `rememberSnapshot`), plus imports `encoding/base64`, `os`, `github.com/iFurySt/open-codex-computer-use/packages/imagebound`:
```go
// applyImageBounds downsamples the snapshot's screenshot per the
// OPEN_COMPUTER_USE_IMAGE_* env vars and records the applied scale so that
// click/drag can remap screenshot-pixel coordinates back to window-logical
// space. Empty / undecodable screenshots are left unchanged with scale 1.
func applyImageBounds(snapshot *appSnapshot) {
	snapshot.ScreenshotScale = 1
	if snapshot.ScreenshotPNGBase64 == "" {
		return
	}
	raw, err := base64.StdEncoding.DecodeString(snapshot.ScreenshotPNGBase64)
	if err != nil {
		return
	}
	bounded, scale := imagebound.BoundedPNG(raw, imagebound.FromEnv(os.Getenv))
	snapshot.ScreenshotScale = scale
	snapshot.ScreenshotPNGBase64 = base64.StdEncoding.EncodeToString(bounded)
}

// scaleCoord maps a model-supplied screenshot-pixel coordinate back to
// window-logical space by dividing out the downsample scale. Returns a new
// pointer, or nil when the input is nil. A non-positive scale is treated as 1.
func scaleCoord(v *float64, scale float64) *float64 {
	if v == nil {
		return nil
	}
	if scale <= 0 {
		scale = 1
	}
	out := *v / scale
	return &out
}
```

- [ ] **Step 6: Call `applyImageBounds` in `refreshSnapshot`**

In `apps/OpenComputerUseLinux/main.go`, `refreshSnapshot` (around line 397), after the `response.Snapshot == nil` guard:
```go
	if response.Snapshot == nil {
		return nil, textResult("Linux runtime did not return an app snapshot.", true)
	}
	applyImageBounds(response.Snapshot)
	s.rememberSnapshot(app, response.Snapshot)
	return response.Snapshot, toolCallResult{}
```

- [ ] **Step 7: Remap `x/y` in `click`**

In `click` (around line 253):
```go
	request := linuxRequest{
		Tool:         "click",
		App:          app,
		X:            scaleCoord(x, snapshot.ScreenshotScale),
		Y:            scaleCoord(y, snapshot.ScreenshotScale),
		ClickCount:   clickCount,
		MouseButton:  mouseButton,
		WindowBounds: snapshot.WindowBounds,
	}
```

- [ ] **Step 8: Remap `from_*`/`to_*` in `drag`**

In `drag` (around line 338):
```go
	return s.actionResult(app, linuxRequest{
		Tool:         "drag",
		App:          app,
		FromX:        scaleCoord(fromX, snapshot.ScreenshotScale),
		FromY:        scaleCoord(fromY, snapshot.ScreenshotScale),
		ToX:          scaleCoord(toX, snapshot.ScreenshotScale),
		ToY:          scaleCoord(toY, snapshot.ScreenshotScale),
		WindowBounds: snapshot.WindowBounds,
	})
```

- [ ] **Step 9: Run the tests, verify they pass**

Run: `cd apps/OpenComputerUseLinux && go test ./... && go vet ./...`
Expected: PASS; vet clean.

- [ ] **Step 10: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
git add apps/OpenComputerUseLinux/go.mod apps/OpenComputerUseLinux/go.sum apps/OpenComputerUseLinux/main.go apps/OpenComputerUseLinux/main_test.go
git commit -m "feat(linux): downsample screenshots + remap click coords via imagebound"
```

---

## Task 5: Update documentation

**Files:**
- Modify: `docs/IMAGE_CAPTURE.md`

- [ ] **Step 1: Update the platform table + notes**

In `docs/IMAGE_CAPTURE.md`, update the「平台差异」section so Windows and Linux are marked as supporting downsampling + coordinate-preservation (no longer "❌ 无降采样"). Add a short subsection noting:
- The size control on Win/Linux is implemented in the Go layer (shared `packages/imagebound` module), applied after the PowerShell/Python capture script returns the native-size PNG; the capture scripts are unchanged.
- Win/Linux capture at **logical** window size (not Retina 2×), so `MAX_DIMENSION` below the logical window size shrinks below it (floored by `MIN_SCALE`); the three size/byte vars behave identically to macOS.
- Note on `CAPTURE_TIMEOUT`: state whether it was wired to the script-call timeout or left macOS-only (match whatever Task 3/4 implemented — by default macOS-only; see Open Question below).

- [ ] **Step 2: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
git add docs/IMAGE_CAPTURE.md
git commit -m "docs: mark Windows/Linux screenshot size control as supported"
```

---

## Open question deferred to implementation

**`CAPTURE_TIMEOUT` on Win/Linux:** the three size/byte vars are fully covered. `CAPTURE_TIMEOUT` maps to the get_app_state script-call timeout *only if* `runPowerShell`/`runPython` already impose (or can cheaply accept) a timeout. During Task 3 Step 1, inspect `runPowerShell` (`main.go:433`) / `runPython` (`main.go:436`): if there's an existing `exec.CommandContext`/timeout, wire `imagebound.FromEnv(...).CaptureTimeout` into it (a small extra step + test); otherwise leave `CaptureTimeout` parsed-but-unused and document it as macOS-only in Task 5. Do **not** add a new subprocess-timeout mechanism just for this — out of scope.

---

## Self-Review (completed during planning)

- **Spec coverage:** ✅ downsample (Task 2), env vars (Task 1), coordinate remap (Tasks 3/4 `scaleCoord`), shared module + replace (Tasks 1/3/4), scripts-untouched (no script tasks), tests (Tasks 1–4), docs (Task 5). `CAPTURE_TIMEOUT` nuance captured as an explicit deferred question.
- **Placeholder scan:** no TBD/TODO; every code step shows complete code; commands have expected output.
- **Type consistency:** `appSnapshot.ScreenshotScale float64`, `scaleCoord(*float64, float64) *float64`, `applyImageBounds(*appSnapshot)`, `imagebound.BoundedPNG([]byte, Config) ([]byte, float64)`, `imagebound.FromEnv(func(string) string) Config` — names consistent across all tasks and between the two app modules.
