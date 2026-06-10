package imagebound

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

// makeTestPNG builds a w×h PNG filled with a deterministic high-entropy
// (effectively incompressible) pattern, so the byte-budget path is meaningful:
// a smooth gradient would deflate to a few KB and never exercise MaxPNGBytes.
// The LCG is seeded with a constant so the bytes are reproducible across runs.
func makeTestPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var s uint32 = 0x12345678
	next := func() uint8 {
		s = s*1664525 + 1013904223
		return uint8(s >> 24)
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{next(), next(), next(), 255})
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
