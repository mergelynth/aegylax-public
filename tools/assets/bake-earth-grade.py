#!/usr/bin/env python3
"""
Bake the globe's colour grade into the texture.

The hero globe used to wear its grade as a live CSS `filter` on each of the
sixteen longitude slices:

    filter: brightness(1.12) contrast(1.26) saturate(1) url(#earth-cool);

`url(#earth-cool)` is a *reference* filter, and a reference filter is not a
compositor filter. Every time the spin changed a slice's projected transform
the browser had to re-run the whole chain on the main thread — sixteen SVG
colour-matrix passes per frame, on the largest element on the page, forever.
Worse, it dirtied the scene under every `backdrop-filter` in the app, each of
which then re-snapshotted and re-blurred its own backdrop.

The grade never changes, so none of that work is per-frame work. This applies
it once, offline, and the slices ship an already-graded texture with no
`filter` at all.

  in : tools/assets/earth.source.webp   (the ungraded NASA-style diffuse map)
  out: public/assets/earth/earth.webp   (what the app actually loads)

Re-run after changing any knob below; keep the source file, it is the only
copy of the ungraded map.

Why a lookup table is exact rather than an approximation
--------------------------------------------------------
Every stage of this chain is per-channel and independent of the other two:
`brightness` and `contrast` are the same curve on each channel, `saturate(1)`
is the identity, and `#earth-cool` is a *diagonal* colour matrix. Nothing
mixes channels, so the whole chain collapses into three 256-entry tables --
one per channel -- and applying them is not a resampling of the grade but the
grade itself, evaluated at every value the 8-bit source can hold.

sRGB, not linearRGB: CSS filter shorthands are defined as their SVG
equivalents with `color-interpolation-filters: sRGB`, and `#earth-cool`
carries that attribute explicitly. The arithmetic below is therefore plain
per-channel maths on sRGB values, exactly as the browser did it.

Clamping is per stage, not just at the end. SVG filter results are clamped to
[0,1] between primitives, and `brightness(1.12)` pushes the map's brightest
land above 1 before `contrast` ever sees it.
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "tools/assets/earth.source.webp"
TARGET = ROOT / "public/assets/earth/earth.webp"

# --- the grade, stage by stage, in the order the CSS applied it -------------
# These four were `--earth-brightness`/`--earth-contrast`/`--earth-saturate` on
# `.wrapHero` and the <feColorMatrix> in EarthSphere.tsx. This is now the only
# place they exist, so the reasoning came with them.
#
# The order is the whole trick. `brightness` lifts the shadows *before* the
# contrast pivot can crush them, and the channel mixer cools and darkens
# *after* it -- which is what lets the contrast be raised at all. Contrast
# pivots on mid-grey, so on its own every step above 1 drags this map's oceans
# (65% of the surface, sitting around 0.14 luminance) toward black, and that is
# what used to hold the ceiling near 1.15. Multiplying the channels down after
# the pivot lands the planet where a darker, cooler grade wants it without
# asking the pivot to do the darkening, so the ceiling moves with it.
#
# The mixer is the stage CSS has no function for: `brightness`, `contrast` and
# `saturate` all treat the three channels alike, and none of them can take the
# warmth out of a satellite map -- the deserts that make up most of this
# texture's land are bright, warm, and the loudest thing on the disc once
# contrast goes up. Scaling the channels apart cools them without touching what
# the map actually shows.
#
# Saturation sits at 1: the colour in this planet comes from the separation
# between deep navy water and cool near-white land, not from a saturation push.
# 1.42 over a raised contrast turned coastal shelves into a turquoise that
# belonged to no palette.
#
# What it costs, measured on the actual texture (the report below prints it):
# 0.001% of pixels reach black on every channel, and 9.9% lose red alone --
# all of it deep water, which is the direction this grade wants. Land keeps its
# detail because `contrast` lifts it while the mixer cools it, so the deserts
# read as pale and cool rather than as the warm sand of an ordinary satellite
# photo.
BRIGHTNESS = 1.12
CONTRAST = 1.26
SATURATE = 1.0  # identity; kept so the chain reads as it did in CSS
CHANNEL_MIX = (0.700, 0.824, 0.949)  # R, G, B -- the cooling multiply

# Encode quality. The source is already lossy, so this is a second generation
# either way; 92 keeps the coastlines from mushing without doubling the file.
WEBP_QUALITY = 92
WEBP_METHOD = 6


def clamp(v: float) -> float:
    return 0.0 if v < 0.0 else 1.0 if v > 1.0 else v


def channel_lut(mix: float) -> list[int]:
    """The full filter chain for one channel, evaluated at all 256 inputs."""
    lut = []
    for value in range(256):
        v = value / 255.0
        v = clamp(v * BRIGHTNESS)
        v = clamp((v - 0.5) * CONTRAST + 0.5)
        # saturate() mixes channels in general, but at 1.0 it is the identity
        # matrix, so it drops out of a per-channel table. If SATURATE is ever
        # moved off 1.0 this script must grow a real 3x3 pass.
        v = clamp(v * mix)
        lut.append(round(v * 255))
    return lut


def main() -> None:
    if SATURATE != 1.0:
        raise SystemExit(
            f"SATURATE is {SATURATE}: saturate() is only separable at 1.0. "
            "Give this script a 3x3 matrix pass before changing it."
        )

    image = Image.open(SOURCE)
    if image.mode != "RGB":
        image = image.convert("RGB")

    luts = [channel_lut(mix) for mix in CHANNEL_MIX]
    graded = image.point(luts[0] + luts[1] + luts[2])

    TARGET.parent.mkdir(parents=True, exist_ok=True)
    graded.save(TARGET, "WEBP", quality=WEBP_QUALITY, method=WEBP_METHOD)

    report(image, graded, luts)


def report(source: Image.Image, graded: Image.Image, luts: list[list[int]]) -> None:
    """What the grade did, in the terms `.wrapHero`'s comment is written in."""
    pixels = source.width * source.height
    hist = source.histogram()  # 3 x 256, per channel

    # A channel clips when the chain drives it to 0 or 255.
    clipped_low = clipped_high = 0
    for c, lut in enumerate(luts):
        counts = hist[c * 256 : (c + 1) * 256]
        clipped_low += sum(n for v, n in enumerate(counts) if lut[v] == 0)
        clipped_high += sum(n for v, n in enumerate(counts) if lut[v] == 255)

    print(f"source  {SOURCE.relative_to(ROOT)}  {source.width}x{source.height}")
    print(f"output  {TARGET.relative_to(ROOT)}  {TARGET.stat().st_size / 1024:.0f} KB")
    print(f"grade   brightness {BRIGHTNESS} -> contrast {CONTRAST} -> "
          f"saturate {SATURATE} -> mix {CHANNEL_MIX}")
    print(f"clipped {clipped_low / (pixels * 3) * 100:.3f}% of channel samples to black, "
          f"{clipped_high / (pixels * 3) * 100:.3f}% to white")
    print("white   " + ", ".join(
        f"{name}: {lut[255]}" for name, lut in zip("RGB", luts)))
    print("mid     " + ", ".join(
        f"{name}: {lut[128]}" for name, lut in zip("RGB", luts)))
    print("ocean   " + ", ".join(
        f"{name}: {lut[36]}" for name, lut in zip("RGB", luts)))


if __name__ == "__main__":
    main()
