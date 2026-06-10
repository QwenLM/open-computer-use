package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
)

func TestToolDefinitionCount(t *testing.T) {
	if got := len(toolDefinitions()); got != 9 {
		t.Fatalf("toolDefinitions() count = %d, want 9", got)
	}
}

func TestCallSequenceStopsAfterFirstToolError(t *testing.T) {
	output, hasError, err := runCallCommand([]string{
		"--calls",
		`[{"tool":"not_a_tool"},{"tool":"list_apps"}]`,
	}, newService())
	if err != nil {
		t.Fatal(err)
	}
	if !hasError {
		t.Fatal("expected hasError")
	}
	items, ok := output.([]map[string]any)
	if !ok {
		t.Fatalf("output type = %T", output)
	}
	if len(items) != 1 {
		t.Fatalf("sequence output count = %d, want 1", len(items))
	}
}

func TestReadArgumentsAcceptsJSONObject(t *testing.T) {
	args, err := readArguments(`{"app":"Notepad","pages":2}`, "")
	if err != nil {
		t.Fatal(err)
	}
	if args["app"] != "Notepad" {
		t.Fatalf("app = %v", args["app"])
	}
	if args["pages"].(json.Number).String() != "2" {
		t.Fatalf("pages = %v", args["pages"])
	}
}

func TestMCPInitializeResponseContainsToolsCapability(t *testing.T) {
	request := map[string]any{
		"jsonrpc": "2.0",
		"id":      float64(1),
		"method":  "initialize",
		"params":  map[string]any{},
	}
	response := handleMCPRequest(request, newService())
	result, ok := response["result"].(map[string]any)
	if !ok {
		t.Fatalf("missing result: %#v", response)
	}
	capabilities := result["capabilities"].(map[string]any)
	if _, ok := capabilities["tools"]; !ok {
		t.Fatalf("missing tools capability: %#v", capabilities)
	}
}

func TestCLIHelpMentionsWindowsRuntime(t *testing.T) {
	var out bytes.Buffer
	if err := runCLI([]string{"--help"}, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Open Computer Use for Windows") {
		t.Fatalf("help text did not mention Windows runtime:\n%s", out.String())
	}
}

func TestWindowsRuntimeForegroundActionsRequireOptIn(t *testing.T) {
	if !strings.Contains(windowsRuntimeScript, "OPEN_COMPUTER_USE_WINDOWS_ALLOW_APP_LAUNCH") {
		t.Fatal("Windows app launch fallback must remain opt-in")
	}
	if !strings.Contains(windowsRuntimeScript, "OPEN_COMPUTER_USE_WINDOWS_ALLOW_FOCUS_ACTIONS") {
		t.Fatal("Windows SetFocus action must remain opt-in")
	}
	if !strings.Contains(windowsRuntimeScript, "OPEN_COMPUTER_USE_WINDOWS_ALLOW_UIA_TEXT_FALLBACK") {
		t.Fatal("Windows UIA text fallback must remain opt-in")
	}
	if !strings.Contains(serverInstructions, "does not auto-launch apps, perform SetFocus, or use UIA text fallback by default") {
		t.Fatal("MCP instructions must document the Windows background-focus policy")
	}
}

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
