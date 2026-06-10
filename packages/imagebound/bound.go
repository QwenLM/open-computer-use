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
