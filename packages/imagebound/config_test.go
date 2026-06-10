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
