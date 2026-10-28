"""Nested-squares exploration for Lede.

    python3 gen.py 1        # writes round-1/
    python3 gen.py final    # writes final/

Each set writes its SVGs, a contact-sheet.png, and a small-sizes.png strip
(16 and 32px on light and dark tab colours, plus 4x nearest-neighbour blow-ups).

Every mark is drawn on a 512 canvas. A "step" is a square anchored at one
corner of the canvas; steps are listed outer to inner as fractions of 512.
"""
import glob
import os
import shutil
import subprocess
import sys
import tempfile

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

HERE = os.path.dirname(os.path.abspath(__file__))
N = 512
TILE_R = 0.225 * N  # app-icon corner, roughly the iOS/macOS proportion
GOLD = 0.618
INTER_TIGHT = os.path.expanduser("~/Library/Fonts/InterTight[wght].ttf")
LABEL_FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"

WARM3 = ["#E10602", "#FF7300", "#FCD000"]
WARM2 = ["#E10602", "#FCB900"]
WARM4 = ["#E10602", "#FF4A00", "#FF8F00", "#FCD000"]
WARM5 = ["#D90016", "#F23A00", "#FF7300", "#FFA800", "#FCD800"]
INDIGO = ["#4800FF", "#B400FF", "#FF2E9A"]
DARK_BG = "#120A08"


def rrect(x, y, s, r=(0, 0, 0, 0), fill="#000"):
    """Square at (x, y) side s; r = radii (top-left, top-right, bottom-right, bottom-left)."""
    tl, tr, br, bl = r
    d = (f"M{x + tl:g} {y:g}H{x + s - tr:g}"
         + (f"A{tr:g} {tr:g} 0 0 1 {x + s:g} {y + tr:g}" if tr else "")
         + f"V{y + s - br:g}"
         + (f"A{br:g} {br:g} 0 0 1 {x + s - br:g} {y + s:g}" if br else "")
         + f"H{x + bl:g}"
         + (f"A{bl:g} {bl:g} 0 0 1 {x:g} {y + s - bl:g}" if bl else "")
         + f"V{y + tl:g}"
         + (f"A{tl:g} {tl:g} 0 0 1 {x + tl:g} {y:g}" if tl else "")
         + "Z")
    return f'<path d="{d}" fill="{fill}"/>'


def smooth_rect(x, y, size, r, smoothing):
    """Square with continuous-curvature corners, the way Apple draws icon masks.

    Same construction as Figma's corner smoothing: each corner is a short
    circular arc eased into the straight sides by two cubic Béziers, so the
    curvature ramps up instead of jumping from 0 to 1/r. smoothing=0 is a plain
    rounded square; about 0.6 matches iOS. The corner spans p = (1 + smoothing) * r
    along each side.
    """
    import math
    rad = math.radians
    p = min((1 + smoothing) * r, size / 2)
    smoothing = min(smoothing, p / r - 1)
    arc_measure = 90 * (1 - smoothing)
    arc = math.sin(rad(arc_measure / 2)) * r * math.sqrt(2)
    alpha = (90 - arc_measure) / 2
    p3_p4 = r * math.tan(rad(alpha / 2))
    beta = 45 * smoothing
    c = p3_p4 * math.cos(rad(beta))
    d = c * math.tan(rad(beta))
    b = (p - arc - c - d) / 3
    a = 2 * b
    f = lambda *v: " ".join(f"{n:.3f}".rstrip("0").rstrip(".") for n in v)
    w = h = size
    return (f"M{f(x + w - p, y)}"
            f"c{f(a, 0, a + b, 0, a + b + c, d)}a{f(r, r)} 0 0 1 {f(arc, arc)}c{f(d, c, d, b + c, d, a + b + c)}"
            f"L{f(x + w, y + h - p)}"
            f"c{f(0, a, 0, a + b, -d, a + b + c)}a{f(r, r)} 0 0 1 {f(-arc, arc)}c{f(-c, d, -(b + c), d, -(a + b + c), d)}"
            f"L{f(x + p, y + h)}"
            f"c{f(-a, 0, -(a + b), 0, -(a + b + c), -d)}a{f(r, r)} 0 0 1 {f(-arc, -arc)}c{f(-d, -c, -d, -(b + c), -d, -(a + b + c))}"
            f"L{f(x, y + p)}"
            f"c{f(0, -a, 0, -(a + b), d, -(a + b + c))}a{f(r, r)} 0 0 1 {f(arc, -arc)}c{f(c, -d, b + c, -d, a + b + c, -d)}Z")


def steps(fracs, colors, corner="tr", size=N, ox=0, oy=0, tile_r=0, inner_r=0, clip=False, smooth=0):
    """Nested squares sharing one corner.

    tile_r rounds the outermost square. With clip=True every inner square is
    clipped to that tile, so the shared corner follows the tile's own curve;
    without it the shared corner gets its own radius (min(tile_r, s/2)), which
    pokes outside the tile curve once a square is smaller than 2 * tile_r.
    inner_r (a fraction of each square's side) rounds the corner of each inner
    square that faces inward.
    """
    out = []
    shared = {"tl": 0, "tr": 1, "br": 2, "bl": 3}[corner]
    for i, (f, c) in enumerate(zip(fracs, colors)):
        s = size * f
        x = ox + (size - s if corner in ("tr", "br") else 0)
        y = oy + (size - s if corner in ("bl", "br") else 0)
        if i == 0:
            r = [tile_r] * 4
        else:
            r = [0, 0, 0, 0]
            if not clip:
                r[shared] = min(tile_r, s / 2)
            r[(shared + 2) % 4] = inner_r * s
        if c:
            out.append(rrect(x, y, s, tuple(r), c))
    if clip:
        cid = f"t{abs(hash((ox, oy, size))) % 10**6}"
        if smooth:
            tile = f'<path d="{smooth_rect(ox, oy, size, tile_r, smooth)}"/>'
        else:
            tile = rrect(ox, oy, size, (tile_r,) * 4).replace(' fill="#000"', "")
        return (f'<defs><clipPath id="{cid}">{tile}</clipPath></defs>'
                f'<g clip-path="url(#{cid})">{"".join(out)}</g>')
    return "".join(out)


def tile(fracs, colors, **kw):
    return steps(fracs, colors, tile_r=TILE_R, clip=True, **kw)


def squircle_path(size=N, n=5.0, pts=360):
    """Superellipse |x|^n + |y|^n = 1, the continuous-curvature icon outline."""
    import math
    h = size / 2
    out = []
    for i in range(pts):
        t = 2 * math.pi * i / pts
        c, s = math.cos(t), math.sin(t)
        x = h + h * math.copysign(abs(c) ** (2 / n), c)
        y = h + h * math.copysign(abs(s) ** (2 / n), s)
        out.append(f"{'M' if i == 0 else 'L'}{x:.2f} {y:.2f}")
    return "".join(out) + "Z"


def sq_tile(fracs, colors, n=5.0, **kw):
    """Steps as plain squares, clipped to a squircle."""
    body = steps(fracs, colors, **kw)
    return (f'<defs><clipPath id="sq"><path d="{squircle_path(n=n)}"/></clipPath></defs>'
            f'<g clip-path="url(#sq)">{body}</g>')


def word(text, wght, height_px, x, y_base, fill, track=0.0, font_path=INTER_TIGHT):
    """Outline `text` from a variable font at `wght`; the 'l' ascender scaled to height_px.

    Returns the path and the x where the text ends.
    """
    font = TTFont(font_path)
    if "fvar" in font:
        font = instantiateVariableFont(font, {"wght": wght}, inplace=False)
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    bp = BoundsPen(gs)
    gs[cmap[ord("l")]].draw(bp)
    k = height_px / bp.bounds[3]
    paths, cx = [], x
    for ch in text:
        g = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[g].draw(TransformPen(pen, (k, 0, 0, -k, cx, y_base)))
        paths.append(pen.getCommands())
        cx += gs[g].width * k + track * height_px
    return f'<path d="{" ".join(paths)}" fill="{fill}"/>', cx - track * height_px


def lockup(mark, ink, wght=700, ratio=0.74, track=-0.03, bg=None, gap=0.17):
    """Mark on the left, 'lede' to its right with the ascender at `ratio` of the mark height."""
    h = ratio * N
    base = N / 2 + h / 2
    text, end = word("lede", wght, h, N + gap * N, base, ink, track)
    w = end + 0.04 * N
    if not bg:
        return mark + text, w
    # on a background, inset the lockup so the tile never touches the edge
    pad = 0.14 * N
    k = (N - 2 * pad) / N
    w = (end * k) + 2 * pad
    return (f'<rect width="{w:g}" height="{N}" fill="{bg}"/>'
            f'<g transform="translate({pad:g} {pad:g}) scale({k:.4f})">{mark}{text}</g>'), w


# ---------- rounds ----------

def round_1():
    yield "01-start", steps([1, 125 / 175, 67 / 175], WARM3)
    yield "02-two-step", steps([1, 0.58], WARM2)
    yield "03-golden-four", steps([1, GOLD, GOLD ** 2, GOLD ** 3], WARM4)
    yield "04-halving-five", steps([1, 0.5, 0.25, 0.125, 0.0625], WARM5)
    yield "05-data-share", steps([1, 0.82, 0.31], WARM3)
    yield "06-L", steps([1, 0.64, 0.30], WARM3)
    yield "07-rising", steps([1, 0.70, 0.40], WARM3[::-1], corner="bl")
    yield "08-tile", steps([1, 0.66, 0.36], WARM3, tile_r=TILE_R)
    yield "09-soft-corner", steps([1, 0.66, 0.36], WARM3, tile_r=TILE_R, inner_r=0.5)
    yield "10-indigo", steps([1, 0.66, 0.36], INDIGO, tile_r=TILE_R)
    yield "11-dark", steps([1, 0.80, 0.52, 0.26], [DARK_BG] + WARM3, tile_r=TILE_R)
    body, w = lockup(steps([1, 0.66, 0.36], WARM3, tile_r=TILE_R), "#160604", wght=800, ratio=0.88)
    yield "12-lockup", body, w


def g(*sixteenths):
    """Fractions on a 1/16 grid so every seam lands on a pixel at 16 and 32px."""
    return [1] + [s / 16 for s in sixteenths]


def round_2():
    yield "01-start", steps([1, 125 / 175, 67 / 175], WARM3)
    yield "02-two-step", steps(g(10), WARM2, tile_r=TILE_R)
    yield "03-three", steps(g(10, 5), WARM3, tile_r=TILE_R)
    yield "04-even-four", steps(g(12, 8, 4), WARM4, tile_r=TILE_R)
    yield "05-dot", steps(g(12, 4), WARM3, tile_r=TILE_R)
    yield "06-soft", steps(g(10, 5), WARM3, tile_r=TILE_R, inner_r=0.5)
    yield "07-indigo", steps(g(10, 5), INDIGO, tile_r=TILE_R)
    yield "08-dark", steps(g(12, 8, 4), [DARK_BG] + WARM3, tile_r=TILE_R)
    body, w = lockup(steps(g(10, 5), WARM3, tile_r=TILE_R), "#160604")
    yield "09-lockup", body, w
    body, w = lockup(steps(g(12, 8, 4), [DARK_BG] + WARM3, tile_r=TILE_R), "#FFFFFF", bg=DARK_BG)
    yield "10-lockup-dark", body, w


WARM4_CLEAN = ["#E10602", "#FF5A00", "#FF9A00", "#FCD000"]


def round_3():
    yield "01-two-step", steps(g(10), WARM2, tile_r=TILE_R)
    yield "02-three", steps(g(10, 5), WARM3, tile_r=TILE_R)
    yield "03-even-four", steps(g(12, 8, 4), WARM4_CLEAN, tile_r=TILE_R)
    yield "04-corner", steps(g(6), WARM2, tile_r=TILE_R)
    yield "05-soft", steps(g(10, 5), WARM3, tile_r=TILE_R, inner_r=0.35)
    yield "06-indigo", steps(g(10, 5), INDIGO, tile_r=TILE_R)
    yield "07-dark-a", steps(g(10, 6, 3), [DARK_BG] + WARM3, tile_r=TILE_R)
    yield "08-dark-b", steps(g(13, 9, 5), [DARK_BG] + WARM3, tile_r=TILE_R)
    body, w = lockup(steps(g(10, 5), WARM3, tile_r=TILE_R), "#160604", ratio=0.68)
    yield "09-lockup", body, w
    body, w = lockup(steps(g(10, 5), WARM3, tile_r=TILE_R), "#FFFFFF", ratio=0.68, bg=DARK_BG)
    yield "10-lockup-dark", body, w


def round_4():
    yield "01-two-step", tile(g(10), WARM2)
    yield "02-three", tile(g(10, 5), WARM3)
    yield "03-three-yellow-hero", tile(g(11, 6), WARM3)
    yield "04-even-four", tile(g(12, 8, 4), WARM4_CLEAN)
    yield "05-soft", tile(g(10, 5), WARM3, inner_r=0.35)
    yield "06-indigo", tile(g(11, 6), INDIGO)
    yield "07-dark", tile(g(10, 7, 4), [DARK_BG] + WARM3)
    body, w = lockup(tile(g(11, 6), WARM3), "#160604", ratio=0.68, gap=0.14, track=-0.02)
    yield "08-lockup", body, w
    body, w = lockup(tile(g(11, 6), WARM3), "#FFFFFF", ratio=0.68, gap=0.14, track=-0.02, bg=DARK_BG)
    yield "09-lockup-dark", body, w


COOL = ["#4800FF", "#0A6CFF", "#00C8FF"]


def round_5():
    yield "01-two-step", sq_tile(g(10), WARM2)
    yield "02-three-round", tile(g(11, 6), WARM3)
    yield "03-three-squircle", sq_tile(g(11, 6), WARM3)
    yield "04-even-four", sq_tile(g(12, 8, 4), WARM4_CLEAN)
    yield "05-indigo-pink", sq_tile(g(11, 6), INDIGO)
    yield "06-indigo-cyan", sq_tile(g(11, 6), COOL)
    yield "07-dark", sq_tile(g(10, 7, 4), [DARK_BG] + WARM3)
    body, w = lockup(sq_tile(g(11, 6), WARM3), "#160604", ratio=0.68, gap=0.14, track=-0.02)
    yield "08-lockup", body, w
    body, w = lockup(sq_tile(g(10), WARM2), "#160604", ratio=0.68, gap=0.14, track=-0.02)
    yield "09-lockup-two-step", body, w
    body, w = lockup(sq_tile(g(11, 6), WARM3), "#FFFFFF", ratio=0.68, gap=0.14, track=-0.02, bg=DARK_BG)
    yield "10-lockup-dark", body, w


def round_6():
    yield "01-round-rect", tile(g(11, 6), WARM3)
    yield "02-squircle-4", sq_tile(g(11, 6), WARM3, n=4)
    yield "03-two-step-round", tile(g(10), WARM2)
    yield "04-two-step-squircle-4", sq_tile(g(10), WARM2, n=4)
    yield "05-even-four", tile(g(12, 8, 4), WARM4_CLEAN)
    yield "06-indigo-cyan", tile(g(11, 6), COOL)
    yield "07-indigo-pink", tile(g(11, 6), INDIGO)
    yield "08-dark", tile(g(10, 7, 4), [DARK_BG] + WARM3)


def final():
    yield "1-warm-three", tile(g(11, 6), WARM3)
    yield "2-warm-two", tile(g(10), WARM2)
    yield "3-warm-four", tile(g(12, 8, 4), WARM4_CLEAN)
    yield "4-indigo-cyan", tile(g(11, 6), COOL)
    yield "5-dark", tile(g(10, 7, 4), [DARK_BG] + WARM3)
    kw = dict(ratio=0.68, gap=0.14, track=-0.02)
    body, w = lockup(tile(g(11, 6), WARM3), "#160604", **kw)
    yield "6-lockup", body, w
    body, w = lockup(tile(g(11, 6), WARM3), "#FFFFFF", bg=DARK_BG, **kw)
    yield "6-lockup-dark", body, w


# ---------- refinement of the picks: 1-warm-three, 4-indigo-cyan, 6-lockup ----------

INK = "#1A1D2E"  # the app's own ink, from public/index.html
RUNS = {
    "warm": WARM3,
    "indigo-cyan": COOL,
    # anchored on the app's palette: blue #2F5BEA, violet #8B5CF6, red #D7263D,
    # amber #FFAA00, green #12974A, ink #1A1D2E
    "app-red-amber": ["#D7263D", "#FF6A1F", "#FFAA00"],
    "app-green-lime": ["#12974A", "#3CC23A", "#C8F03C"],
    "app-blue-violet": ["#2F5BEA", "#8B5CF6", "#E879F9"],
    "app-ink-blue-amber": [INK, "#2F5BEA", "#FFAA00"],
    "app-violet-pink": ["#8B5CF6", "#E14FD0", "#FF8FB0"],
}
PICK = g(11, 6)


def refine_1():
    for k, run in RUNS.items():
        yield f"b-{k}", tile(PICK, run)
    yield "c-warm-fat6", tile(g(10, 5), WARM3)
    yield "c-warm-fat7", tile(g(9, 5), WARM3)
    yield "c-cyan-fat6", tile(g(10, 5), COOL)
    yield "c-cyan-fat7", tile(g(9, 5), COOL)
    for wt in (700, 800, 900):
        body, w = lockup(tile(PICK, WARM3), INK, wght=wt, ratio=0.68, gap=0.14, track=-0.02)
        yield f"lockup-a-warm-w{wt}", body, w
    for ratio in (0.60, 0.76):
        body, w = lockup(tile(PICK, WARM3), INK, wght=800, ratio=ratio, gap=0.14, track=-0.02)
        yield f"lockup-b-warm-r{int(ratio * 100)}", body, w
    for gap in (0.10, 0.20):
        body, w = lockup(tile(PICK, WARM3), INK, wght=800, ratio=0.68, gap=gap, track=-0.02)
        yield f"lockup-c-warm-gap{int(gap * 100)}", body, w
    body, w = lockup(tile(PICK, COOL), INK, wght=800, ratio=0.68, gap=0.14, track=-0.02)
    yield "lockup-d-cyan", body, w
    body, w = lockup(tile(PICK, COOL), "#FFFFFF", wght=800, ratio=0.68, gap=0.14, track=-0.02, bg=INK)
    yield "lockup-d-cyan-dark", body, w
    body, w = lockup(tile(PICK, WARM3), "#FFFFFF", wght=800, ratio=0.68, gap=0.14, track=-0.02, bg=INK)
    yield "lockup-d-warm-dark", body, w


FAMILY = {
    "1-warm": WARM3,
    "2-indigo-cyan": COOL,
    "3-green-lime": ["#12974A", "#3CC23A", "#C8F03C"],
    "4-blue-violet-pink": ["#2F5BEA", "#8B5CF6", "#FF6FD8"],
    "5-ink-blue-amber": [INK, "#2F5BEA", "#FFAA00"],
}
LK = dict(wght=800, ratio=0.70, gap=0.14, track=-0.02)


def refine_2():
    for k, run in FAMILY.items():
        yield f"b{k}", tile(PICK, run)
    for k, run in (("warm", WARM3), ("cyan", COOL)):
        yield f"c-{k}-fat6", tile(g(10, 5), run)
        yield f"c-{k}-fat7", tile(g(9, 5), run)
    for k, run in (("warm", WARM3), ("cyan", COOL)):
        body, w = lockup(tile(PICK, run), INK, **LK)
        yield f"lockup-{k}", body, w
        body, w = lockup(tile(PICK, run), "#FFFFFF", bg=INK, **LK)
        yield f"lockup-{k}-dark", body, w
        body, w = lockup(tile(g(9, 5), run), INK, **LK)
        yield f"lockup-{k}-fat7", body, w


FAMILY3 = {
    "1-warm": WARM3,
    "2-indigo-cyan": COOL,
    "3-green-lime": ["#12974A", "#3CC23A", "#C8F03C"],
    "4-ink-blue-amber": [INK, "#2F5BEA", "#FFAA00"],
    "5-ink-violet-pink": [INK, "#8B5CF6", "#FF6FD8"],
}


def refine_3():
    for k, run in FAMILY3.items():
        yield f"b{k}", tile(PICK, run)
    for k, run in FAMILY3.items():
        yield f"c{k}-fat6", tile(g(10, 5), run)


def refine():
    for k, run in FAMILY3.items():
        yield f"a{k}", tile(PICK, run)
    for k, run in (("warm", WARM3), ("cyan", COOL)):
        yield f"b-{k}-fat6", tile(g(10, 5), run)
        yield f"b-{k}-fat7", tile(g(9, 5), run)
    for k, run in (("warm", WARM3), ("cyan", COOL)):
        body, w = lockup(tile(PICK, run), INK, **LK)
        yield f"lockup-1-{k}", body, w
        body, w = lockup(tile(PICK, run), "#FFFFFF", bg=INK, **LK)
        yield f"lockup-1-{k}-dark", body, w
        body, w = lockup(tile(g(10, 5), run), INK, **LK)
        yield f"lockup-2-{k}-fat6", body, w
    body, w = lockup(tile(PICK, WARM3), INK, **dict(LK, wght=900))
    yield "lockup-3-warm-black900", body, w
    body, w = lockup(tile(PICK, WARM3), INK, **dict(LK, wght=700))
    yield "lockup-3-warm-bold700", body, w


def chosen():
    """The three colourways the user picked, each as icon, lockup and dark lockup."""
    for k in ("1-warm", "2-indigo-cyan", "3-green-lime"):
        run = FAMILY3[k]
        yield f"{k}-icon", tile(PICK, run, smooth=SMOOTH)
        body, w = lockup(tile(PICK, run, smooth=SMOOTH), INK, **LK)
        yield f"{k}-lockup", body, w
        body, w = lockup(tile(PICK, run, smooth=SMOOTH), "#FFFFFF", bg=INK, **LK)
        yield f"{k}-lockup-dark", body, w


# The whole family. Rule: the L is the darkest colour and the steps brighten toward the corner.
SMOOTH = 0.6  # iOS-like continuous corners for everything that ships

FAMILY_ALL = {
    "01-warm": WARM3,
    "02-indigo-cyan": COOL,
    "03-green-lime": ["#12974A", "#3CC23A", "#C8F03C"],
    "04-sunset": ["#5B10E8", "#F0157A", "#FF9A1F"],
    "05-magenta-peach": ["#B8005C", "#FF3D7F", "#FFB08A"],
    "06-teal-mint": ["#00706E", "#00BFA8", "#6FF0C6"],
    "07-cobalt-sky": ["#0033CC", "#2F8BFF", "#6FC8FF"],
    "08-plum-lilac": ["#4A0E7A", "#9B4DFF", "#D99BFF"],
    "09-ocean-lime": ["#0040B8", "#00A3A3", "#B8F000"],
}


def family():
    for k, run in FAMILY_ALL.items():
        yield f"{k}-icon", tile(PICK, run, smooth=SMOOTH)


def family_lockups():
    for k, run in FAMILY_ALL.items():
        body, w = lockup(tile(PICK, run, smooth=SMOOTH), INK, **LK)
        yield f"{k}-lockup", body, w
        body, w = lockup(tile(PICK, run, smooth=SMOOTH), "#FFFFFF", bg=INK, **LK)
        yield f"{k}-lockup-dark", body, w


def corners():
    """Corner shapes compared: plain rounded square, then increasing smoothing."""
    for sm in (0, 0.6, 1.0):
        yield f"smooth-{int(sm * 100):03d}", tile(PICK, WARM3, smooth=sm)


ROUNDS = {"1": round_1, "2": round_2, "3": round_3, "4": round_4, "5": round_5, "6": round_6, "final": final, "refine-1": refine_1, "refine-2": refine_2, "refine-3": refine_3, "refine": refine, "set": chosen, "family": family, "family-lockups": family_lockups, "corners": corners}


# ---------- rendering ----------

def render(name):
    if name in ("final", "refine", "set", "family", "family-lockups", "corners"):
        out = os.path.join(HERE, name)
    elif name.startswith("refine-"):
        out = os.path.join(HERE, "refine", "round-" + name.split("-")[1])
    else:
        out = os.path.join(HERE, f"round-{name}")
    os.makedirs(out, exist_ok=True)
    for old in glob.glob(os.path.join(out, "*.svg")) + glob.glob(os.path.join(out, "*.png")):
        os.remove(old)
    for item in ROUNDS[name]():
        n, body, w = (tuple(item) + (N,))[:3]
        with open(os.path.join(out, n + ".svg"), "w") as fh:
            fh.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:g} {N}" '
                     f'width="{w:g}" height="{N}">{body}</svg>')

    tmp = tempfile.mkdtemp()

    def png(src, h, dst):
        subprocess.run(["rsvg-convert", "-h", str(h), "-o", dst, src], check=True)

    def cell(img, bg, scale, box):
        return ["(", img, "-filter", "point", "-resize", f"{scale * 100}%",
                "-background", bg, "-gravity", "center", "-extent", f"{box}x{box}", ")"]

    big, small = [], []
    for s in sorted(glob.glob(os.path.join(out, "*.svg"))):
        n = os.path.splitext(os.path.basename(s))[0]
        b = os.path.join(tmp, n + ".png")
        png(s, 300, b)
        big.append((n, b))
        if "lockup" in n:
            continue
        p16, p32 = os.path.join(tmp, n + "-16.png"), os.path.join(tmp, n + "-32.png")
        png(s, 16, p16)
        png(s, 32, p32)
        row = os.path.join(tmp, n + "-row.png")
        subprocess.run(["magick",
                        *cell(p16, "#FFFFFF", 1, 40), *cell(p16, "#202124", 1, 40),
                        *cell(p32, "#FFFFFF", 1, 48), *cell(p32, "#202124", 1, 48),
                        *cell(p16, "#FFFFFF", 4, 80), *cell(p32, "#FFFFFF", 4, 144),
                        "-background", "#FFFFFF", "-gravity", "center", "+append", row],
                       check=True)
        small.append((n, row))

    def montage(items, cols, pt, bg, dst):
        args = sum([["-label", n, p] for n, p in items], [])
        subprocess.run(["magick", "montage", "-font", LABEL_FONT, "-pointsize", str(pt), *args,
                        "-tile", f"{cols}x", "-geometry", "+28+20", "-background", bg, dst],
                       check=True)

    icons = [(n, p) for n, p in big if "lockup" not in n]
    locks = [(n, p) for n, p in big if "lockup" in n]
    sheet = os.path.join(out, "contact-sheet.png")
    lock_cols = 2 if len(locks) > 3 else 1
    if not icons:
        montage(locks, lock_cols, 16, "#F4F1EE", sheet)
    else:
        montage(icons, 4, 16, "#F4F1EE", sheet)
    if icons and locks:
        lk = os.path.join(tmp, "locks.png")
        montage(locks, lock_cols, 16, "#F4F1EE", lk)
        subprocess.run(["magick", sheet, lk, "-background", "#F4F1EE", "-gravity", "west",
                        "-append", sheet], check=True)
    if small:
        montage(small, 2, 13, "#FFFFFF", os.path.join(out, "small-sizes.png"))
    shutil.rmtree(tmp)
    print(out)


if __name__ == "__main__":
    for name in sys.argv[1:] or ROUNDS:
        render(name)
