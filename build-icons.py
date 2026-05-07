#!/usr/bin/env python3
"""Generates iFocus PWA icons. Run: python3 build-icons.py

Design philosophy: a mature, restrained app icon — single focused subject
(an iris/aperture mark), considered gradient background, subtle specular
highlight for depth. No grids, no scanlines, no glow halos.
"""
from PIL import Image, ImageDraw, ImageFilter, ImageChops
import os, math

OUT = os.path.dirname(os.path.abspath(__file__))
ICONS_DIR = os.path.join(OUT, "icons")
os.makedirs(ICONS_DIR, exist_ok=True)

# Palette — refined, slightly warm-teal accents on a deep ink background.
INK_TOP   = (16, 26, 36)     # subtle slate-teal
INK_BOT   = (6, 10, 14)      # near-black
TEAL_HI   = (94, 234, 212)   # lighter teal for highlight
TEAL      = (45, 212, 191)   # primary brand teal (refined)
TEAL_LO   = (17, 148, 135)   # deeper teal for shading
PUPIL_HI  = (180, 252, 240)
PUPIL_LO  = (45, 212, 191)


def lerp(a, b, t):
    return tuple(int(a[i] * (1 - t) + b[i] * t) for i in range(len(a)))


def radial_gradient(size, inner, outer, center=(0.5, 0.5), inner_r=0.0, outer_r=0.78):
    """Smooth radial gradient with floating-point falloff."""
    img = Image.new("RGB", (size, size))
    px = img.load()
    cx, cy = center[0] * size, center[1] * size
    ir = inner_r * size
    orad = outer_r * size
    span = max(1.0, orad - ir)
    for y in range(size):
        dy = y - cy
        for x in range(size):
            dx = x - cx
            d = math.sqrt(dx * dx + dy * dy)
            t = (d - ir) / span
            t = 0.0 if t < 0 else (1.0 if t > 1 else t)
            # smoothstep for nicer falloff
            t = t * t * (3 - 2 * t)
            px[x, y] = lerp(inner, outer, t)
    return img.convert("RGBA")


def add_vignette(img, strength=0.35):
    size = img.size[0]
    v = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(v)
    # Lighter at center, darker at corners
    steps = 64
    for i in range(steps):
        t = i / steps
        r = int(size * (0.55 + 0.50 * t))
        alpha = int(255 * t * strength)
        d.ellipse(
            [size / 2 - r, size / 2 - r, size / 2 + r, size / 2 + r],
            outline=alpha,
        )
    v = v.filter(ImageFilter.GaussianBlur(radius=size * 0.06))
    overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    overlay.putalpha(v)
    return Image.alpha_composite(img, overlay)


def draw_ring_with_gradient(size, cx, cy, radius, thickness, top_color, bot_color):
    """Anti-aliased ring whose color shifts vertically (top→bottom) for subtle depth."""
    # Render at 4x for AA
    s = 4
    big = Image.new("RGBA", (size * s, size * s), (0, 0, 0, 0))
    bd = ImageDraw.Draw(big)
    # Outer disk in top color
    R = (radius + thickness / 2) * s
    r = (radius - thickness / 2) * s
    # paint a vertical-gradient disk, then mask out the inside
    grad = Image.new("RGBA", (size * s, size * s), (0, 0, 0, 0))
    gp = grad.load()
    top = (cy - radius - thickness / 2) * s
    bot = (cy + radius + thickness / 2) * s
    span = max(1.0, bot - top)
    for y in range(int(top), int(bot) + 1):
        if y < 0 or y >= size * s:
            continue
        t = (y - top) / span
        t = t * t * (3 - 2 * t)
        col = lerp(top_color, bot_color, t)
        for x in range(size * s):
            gp[x, y] = (*col, 255)
    # ring mask
    mask = Image.new("L", (size * s, size * s), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse([cx * s - R, cy * s - R, cx * s + R, cy * s + R], fill=255)
    md.ellipse([cx * s - r, cy * s - r, cx * s + r, cy * s + r], fill=0)
    grad.putalpha(ImageChops.multiply(grad.split()[3], mask))
    return grad.resize((size, size), Image.LANCZOS)


def draw_specular(size, cx, cy, radius, thickness):
    """A short, soft highlight arc at the upper-left of the ring — a single light source cue."""
    s = 4
    big = Image.new("RGBA", (size * s, size * s), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    bbox = [
        cx * s - (radius + thickness / 2) * s,
        cy * s - (radius + thickness / 2) * s,
        cx * s + (radius + thickness / 2) * s,
        cy * s + (radius + thickness / 2) * s,
    ]
    # Arc from ~205° to ~265° (upper-left quadrant). PIL angles: 0 = 3 o'clock, clockwise.
    d.arc(bbox, start=205, end=265, fill=(220, 255, 245, 160), width=int(thickness * s * 0.55))
    big = big.filter(ImageFilter.GaussianBlur(radius=s * thickness * 0.18))
    return big.resize((size, size), Image.LANCZOS)


def draw_pupil(size, cx, cy, r, hi, lo):
    """Filled circle with a vertical gradient (lighter at top) for a soft 3D feel."""
    s = 4
    img = Image.new("RGBA", (size * s, size * s), (0, 0, 0, 0))
    px = img.load()
    top = (cy - r) * s
    bot = (cy + r) * s
    span = max(1.0, bot - top)
    R = r * s
    for y in range(int(top), int(bot) + 1):
        if y < 0 or y >= size * s:
            continue
        t = (y - top) / span
        t = t * t * (3 - 2 * t)
        col = lerp(hi, lo, t)
        # horizontal slice within the circle
        dy = y - cy * s
        half = math.sqrt(max(0.0, R * R - dy * dy))
        x0, x1 = int(cx * s - half), int(cx * s + half)
        for x in range(x0, x1 + 1):
            if 0 <= x < size * s:
                px[x, y] = (*col, 255)
    return img.resize((size, size), Image.LANCZOS)


def make_icon(size, mask_safe=False, transparent_bg=False):
    """Render the iFocus icon at `size`. iOS adds its own corner mask, so leave square+opaque."""
    # Background — refined radial gradient
    if transparent_bg:
        bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    else:
        bg = radial_gradient(size, INK_TOP, INK_BOT, center=(0.5, 0.42), inner_r=0.05, outer_r=0.85)

    # Subject geometry. For maskable icons, scale content to ~78% (Android safe zone).
    cx = cy = size / 2
    safe = 0.78 if mask_safe else 1.0
    R = size * 0.31 * safe
    thickness = max(2.0, size * 0.052 * safe)
    pupil_r = size * 0.085 * safe

    # Layers
    ring = draw_ring_with_gradient(size, cx, cy, R, thickness, TEAL_HI, TEAL_LO)
    spec = draw_specular(size, cx, cy, R, thickness)
    pupil = draw_pupil(size, cx, cy, pupil_r, PUPIL_HI, PUPIL_LO)

    # Composite
    img = bg
    img = Image.alpha_composite(img, ring)
    img = Image.alpha_composite(img, spec)
    img = Image.alpha_composite(img, pupil)

    # Subtle vignette to add depth (skip on tiny sizes, would just look muddy)
    if size >= 96 and not transparent_bg:
        img = add_vignette(img, strength=0.30)

    return img


def make_rounded(size, radius_ratio=0.225):
    """For favicon use: same icon clipped to an iOS-style rounded square."""
    img = make_icon(size)
    radius = int(size * radius_ratio)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask=mask)
    return out


# ── Generate the full icon set ──
make_icon(180).save(os.path.join(OUT, "apple-touch-icon.png"))
make_icon(180).save(os.path.join(ICONS_DIR, "apple-touch-icon-180.png"))
make_icon(167).save(os.path.join(ICONS_DIR, "apple-touch-icon-167.png"))
make_icon(152).save(os.path.join(ICONS_DIR, "apple-touch-icon-152.png"))
make_icon(120).save(os.path.join(ICONS_DIR, "apple-touch-icon-120.png"))

make_icon(512).save(os.path.join(ICONS_DIR, "icon-512.png"))
make_icon(384).save(os.path.join(ICONS_DIR, "icon-384.png"))
make_icon(192).save(os.path.join(ICONS_DIR, "icon-192.png"))
make_icon(144).save(os.path.join(ICONS_DIR, "icon-144.png"))
make_icon(96).save(os.path.join(ICONS_DIR, "icon-96.png"))
make_icon(72).save(os.path.join(ICONS_DIR, "icon-72.png"))

make_icon(512, mask_safe=True).save(os.path.join(ICONS_DIR, "icon-maskable-512.png"))
make_icon(192, mask_safe=True).save(os.path.join(ICONS_DIR, "icon-maskable-192.png"))

make_rounded(32).save(os.path.join(OUT, "favicon-32.png"))
make_rounded(16).save(os.path.join(OUT, "favicon-16.png"))

ico_sizes = [(16, 16), (32, 32), (48, 48)]
ico_imgs = [make_rounded(s[0]) for s in ico_sizes]
ico_imgs[0].save(os.path.join(OUT, "favicon.ico"), sizes=ico_sizes, format="ICO")

# A nice high-res preview for review
make_icon(1024).save(os.path.join(OUT, "icon-preview-1024.png"))

print("Generated icons in", OUT, "and", ICONS_DIR)
