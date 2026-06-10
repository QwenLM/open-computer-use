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
