#!/usr/bin/env python3
"""Round 7: the fluffy chick, the thin sickle bill, a blue bubble.

Pascal's hand edit of round 5's v11 set the direction: a young bird made of rounded, scalloped
feathers, big dark eyes, a pale head band under a darker crown tuft, round 6's thin bill with
its pale outline, and a larger bubble behind the bird -- now in GNOME blue. This round takes
that further and tests how much feather texture is right: every bird is drawn by one function
with a feather LEVEL (0 smooth, 1 fluffed outline, 2 fluffed outline plus shingled breast).

Three flaws of the hand edit are fixed in the generator: the feet are whole toes inside the
canvas; the bill's pale rim is one even stroke under the bill instead of a second shape; and
the breast feathers are overlapping shingles with a shadow under each tip, not rows of thin
arcs, which read as smiles.

Self-contained on purpose (python3 stdlib): build5/build6 write their folders on import. The
bubble block is round 4's trace of Fractal and Flare, verbatim; the Bill class is round 6's.
"""
import math
import pathlib

OUT = pathlib.Path(__file__).resolve().parent

# --------------------------------------------------------------------------------- the palette
BUFF = ("#fbeed6", "#e8c999", "#b98850")
WING = ("#d9b583", "#c0945f", "#98693a")
CROWN = "#6b4428"
SUPER = "#fdf4e2"
RIM = "#5a3a20"
BILL = ("#6e4a2b", "#432d18", "#2b1c0d")
BILL_LOW = "#b8946c"
BILL_TIP = "#1e130a"
EYE = "#241f31"
LEG = "#8a909c"
LEG_RIM = "#4d525c"
BLUE = ("#1a5fb4", "#3584e4", "#78aeed")        # Adwaita blue 4, blue 3, between blue 2 and 1

# ------------------------------------------------------------------- the shared GNOME bubble

BUBBLE_DEFS = """    <linearGradient id="face" x1="48" y1="100" x2="80" y2="32" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="@MID@"/>
      <stop offset="1" stop-color="@LIGHT@"/>
    </linearGradient>
    <linearGradient id="wall" x1="8" y1="70" x2="120" y2="70" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="@DARK@"/>
      <stop offset="0.0714286" stop-color="@LIGHT@"/>
      <stop offset="0.142857" stop-color="@DARK@"/>
      <stop offset="0.857143" stop-color="@DARK@"/>
      <stop offset="0.928571" stop-color="@LIGHT@"/>
      <stop offset="1" stop-color="@DARK@"/>
    </linearGradient>
    <linearGradient id="fold" x1="31.462524" y1="114" x2="39" y2="114" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="@DARK@"/>
      <stop offset="0.469318" stop-color="@LIGHT@"/>
      <stop offset="1" stop-color="@DARK@"/>
    </linearGradient>
    <linearGradient id="sheen" x1="64" y1="24" x2="64" y2="60" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.32"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <path id="tail" fill-rule="evenodd"
          d="M24 100 V112 H28 C30.210938 112 32 113.789062 32 116 V123
             C32 124.992188 33.183594 126.792969 35.011719 127.585938
             C36.839844 128.375 38.964844 128.003906 40.417969 126.640625
             L53.941406 113.933594 C55.265625 112.691406 57.011719 112 58.824219 112
             H68 V100 Z"/>
    <path id="lip" fill-rule="evenodd"
          d="M24 106 V108 H28 C30.210938 108 32 109.789062 32 112 V119
             C32 120.992188 33.183594 122.792969 35.011719 123.585938
             C36.839844 124.375 38.964844 124.003906 40.417969 122.640625
             L53.941406 109.933594 C55.265625 108.691406 57.011719 108 58.824219 108
             H68 V106 Z"/>
    <path id="wallrect"
          d="M24 28 H104 C112.835938 28 120 35.164062 120 44 V96
             C120 104.835938 112.835938 112 104 112 H24
             C15.164062 112 8 104.835938 8 96 V44 C8 35.164062 15.164062 28 24 28 Z"/>
    <path id="facerect"
          d="M24 24 H104 C112.835938 24 120 31.164062 120 40 V92
             C120 100.835938 112.835938 108 104 108 H24
             C15.164062 108 8 100.835938 8 92 V40 C8 31.164062 15.164062 24 24 24 Z"/>
    <clipPath id="face-clip"><use href="#facerect"/></clipPath>
"""

BUBBLE_DRAW = """  <use href="#tail" fill="url(#fold)"/>
  <use href="#wallrect" fill="url(#wall)"/>
  <use href="#facerect" fill="url(#face)"/>
  <rect x="14" y="27" width="100" height="30" rx="12" fill="url(#sheen)"/>
  <use href="#lip" fill="@MID@"/>
"""


def bubble(scale, x, y, hue=BLUE):
    """The shared bubble, glossy, its face rect's top left at (x, y). Face is 112s x 84s, the
    tail reaches 104s below y."""
    dark, mid, light = hue
    sub = lambda s: s.replace("@DARK@", dark).replace("@MID@", mid).replace("@LIGHT@", light)
    tx, ty = x - 8 * scale, y - 24 * scale
    return sub(BUBBLE_DEFS), (f'  <g transform="translate({tx:.2f},{ty:.2f}) scale({scale})">\n'
                              + sub(BUBBLE_DRAW) + "  </g>\n")


# ------------------------------------------------------------------------------------ the bill


def _pt(c, t):
    m = 1 - t
    return (m * m * m * c[0][0] + 3 * m * m * t * c[1][0] + 3 * m * t * t * c[2][0] + t ** 3 * c[3][0],
            m * m * m * c[0][1] + 3 * m * m * t * c[1][1] + 3 * m * t * t * c[2][1] + t ** 3 * c[3][1])


def _tan(c, t):
    m = 1 - t
    dx = 3 * m * m * (c[1][0] - c[0][0]) + 6 * m * t * (c[2][0] - c[1][0]) + 3 * t * t * (c[3][0] - c[2][0])
    dy = 3 * m * m * (c[1][1] - c[0][1]) + 6 * m * t * (c[2][1] - c[1][1]) + 3 * t * t * (c[3][1] - c[2][1])
    n = math.hypot(dx, dy) or 1.0
    return dx / n, dy / n


class Bill:
    """Round 6's bill: one cubic centreline, one width profile, every part an offset band.
    `root` is the parameter where the bill leaves the feathers; widths are measured there."""

    def __init__(self, ctrl, w_base, w_tip=1.4, taper=1.5, root=0.1, samples=30):
        self.c = ctrl
        self.wb, self.wt, self.taper, self.root = w_base, w_tip, taper, root
        self.n = samples

    def width(self, t):
        return self.wt + (self.wb - self.wt) * (1 - t ** self.taper)

    def edge(self, t, frac):
        x, y = _pt(self.c, t)
        dx, dy = _tan(self.c, t)
        o = self.width(t) * 0.5 * frac
        return x + dy * o, y - dx * o

    def length(self, n=200):
        pts = [_pt(self.c, self.root + (1 - self.root) * i / n) for i in range(n + 1)]
        return sum(math.dist(a, b) for a, b in zip(pts, pts[1:]))

    def band(self, a, b, t0=0.0, t1=1.0):
        n = max(6, int(self.n * (t1 - t0)) + 3)
        up = [self.edge(t0 + (t1 - t0) * i / n, a) for i in range(n + 1)]
        dn = [self.edge(t0 + (t1 - t0) * i / n, b) for i in range(n, -1, -1)]
        return ("M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in up)
                + " L" + " L".join(f"{x:.2f} {y:.2f}" for x, y in dn) + " Z")

    def line(self, frac, t0, t1):
        n = max(6, int(self.n * (t1 - t0)) + 3)
        pts = [self.edge(t0 + (t1 - t0) * i / n, frac) for i in range(n + 1)]
        return "M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in pts)

    def grad(self, gid="bill"):
        (x0, y0), (x1, y1) = _pt(self.c, self.root), _pt(self.c, 1.0)
        return (f'    <linearGradient id="{gid}" x1="{x0:.1f}" y1="{y0:.1f}" '
                f'x2="{x1:.1f}" y2="{y1:.1f}" gradientUnits="userSpaceOnUse">\n'
                f'      <stop offset="0" stop-color="{BILL[0]}"/>\n'
                f'      <stop offset="0.5" stop-color="{BILL[1]}"/>\n'
                f'      <stop offset="1" stop-color="{BILL[2]}"/>\n'
                '    </linearGradient>\n')

    def draw(self, t0=0.0, cap=False, halo=SUPER, gid="bill"):
        """Pale rim as ONE even stroke under the shaft (so it cannot wobble against the fill),
        the shaft, the faint lower mandible, the gape hairline, the dark tip, a thin gloss.
        `cap` rounds the root off for bills that start on the face instead of under feathers."""
        outline = self.band(1, -1, t0, 1.0)
        cx, cy = _pt(self.c, t0)
        cr = self.width(t0) * 0.5
        s = (f'  <!-- bill: {self.width(self.root):.1f} px wide where it leaves the face, '
             f'{self.length():.0f} px long -->\n')
        s += (f'  <path fill="{halo}" stroke="{halo}" stroke-width="2.2" stroke-opacity="0.9" '
              f'stroke-linejoin="round" d="{outline}"/>\n')
        if cap:
            s += f'  <circle cx="{cx:.2f}" cy="{cy:.2f}" r="{cr + 1.1:.2f}" fill="{halo}" opacity="0.9"/>\n'
            s += f'  <circle cx="{cx:.2f}" cy="{cy:.2f}" r="{cr:.2f}" fill="{BILL[0]}"/>\n'
        s += f'  <path fill="url(#{gid})" d="{outline}"/>\n'
        r0 = max(t0, self.root)
        s += f'  <path fill="{BILL_LOW}" opacity="0.55" d="{self.band(-0.35, -1, r0, 0.7)}"/>\n'
        s += (f'  <path fill="none" stroke="{BILL_TIP}" stroke-width="0.7" stroke-opacity="0.6" '
              f'd="{self.line(-0.3, r0, 0.74)}"/>\n')
        s += f'  <path fill="{BILL_TIP}" d="{self.band(1, -1, 0.8, 1.0)}"/>\n'
        s += f'  <path fill="#ffffff" opacity="0.28" d="{self.band(0.3, 0.8, r0, 0.55)}"/>\n'
        return s


# --------------------------------------------------------------------------------- the feathers


def _rand(i, seed):
    return math.sin(i * 12.9898 + seed * 78.233) * 0.5 + 0.5


def fluff(cx, cy, rx, ry, n=18, amp=3.4, lean=0.3, seed=1.0, rot=0.0):
    """A closed outline of n rounded feather tips, all leaning the same way round. amp=0 is
    the plain ellipse."""
    if amp <= 0:
        return (f"M{cx - rx:.2f} {cy:.2f} a{rx} {ry} 0 1 0 {2 * rx} 0 "
                f"a{rx} {ry} 0 1 0 {-2 * rx} 0 Z")

    def p(a, k=0.0):
        return cx + (rx + k) * math.cos(a), cy + (ry + k) * math.sin(a)

    da = 2 * math.pi / n
    d = "M%.2f %.2f" % p(rot)
    for i in range(n):
        a = rot + i * da
        k = amp * (0.8 + 0.4 * _rand(i, seed)) * 1.35
        (x1, y1), (x2, y2), (x3, y3) = p(a + da * (0.1 + lean), k), p(a + da * (0.85 + lean * 0.5), k), p(a + da)
        d += f" C{x1:.2f} {y1:.2f} {x2:.2f} {y2:.2f} {x3:.2f} {y3:.2f}"
    return d + " Z"


def shingles(cx, top, bottom, half, w=8.5, depth=4.2, step=8.0, fill="url(#breast)"):
    """Breast feathers as overlapping shingles: each row is a band with a scalloped lower edge,
    painted in the breast's own gradient over a soft shadow of itself. Rows are drawn bottom
    up, so every row overlaps the one below. What shows is a crescent of shadow under each
    feather tip with a cusp between tips, which reads as plumage; open thin arcs read as
    smiles."""
    rows = []
    y, k = top, 0
    while y <= bottom:
        rows.append((y, k))
        y += step
        k += 1
    s = ""
    for y, k in reversed(rows):
        n = int(2 * half / w) + 3
        x1 = cx + half + w + (w / 2 if k % 2 else 0)
        d = f"M{x1 - n * w:.2f} {y - step - 2:.2f} H{x1:.2f} V{y:.2f}"
        d += "".join(f" q{-w / 2:.2f} {2 * depth:.2f} {-w:.2f} 0" for _ in range(n)) + " Z"
        s += (f'    <path fill="{RIM}" opacity="0.26" transform="translate(0,1.5)" d="{d}"/>\n'
              f'    <path fill="{fill}" d="{d}"/>\n')
    return s


# --------------------------------------------------------------------------------- bird plumbing


def grad(name, x1, y1, x2, y2, ramp=BUFF):
    return (f'    <linearGradient id="{name}" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" '
            'gradientUnits="userSpaceOnUse">\n'
            f'      <stop offset="0" stop-color="{ramp[0]}"/>\n'
            f'      <stop offset="0.55" stop-color="{ramp[1]}"/>\n'
            f'      <stop offset="1" stop-color="{ramp[2]}"/>\n'
            '    </linearGradient>\n')


GLOSS_DEF = """    <radialGradient id="gloss" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.6"/>
      <stop offset="0.6" stop-color="#ffffff" stop-opacity="0.18"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
"""


def outlined(href, fill, w=2.8, op=0.6):
    return (f'  <use href="#{href}" fill="none" stroke="{RIM}" stroke-width="{w}" '
            f'stroke-opacity="{op}" stroke-linejoin="round"/>\n'
            f'  <use href="#{href}" fill="{fill}"/>\n')


def big_eye(cx, cy, r, look=1):
    return (f'  <circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r + 1.5:.1f}" fill="{SUPER}"/>\n'
            f'  <circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="{EYE}"/>\n'
            f'  <circle cx="{cx + r * 0.34 * look:.1f}" cy="{cy - r * 0.36:.1f}" r="{r * 0.36:.1f}" '
            'fill="#ffffff" opacity="0.94"/>\n'
            f'  <circle cx="{cx - r * 0.3 * look:.1f}" cy="{cy + r * 0.36:.1f}" r="{r * 0.16:.1f}" '
            'fill="#ffffff" opacity="0.5"/>\n')


def foot(fx, y0=109.0, y1=121.0):
    """Three whole toes, drawn as round-capped strokes over a darker underlay."""
    d = f"M{fx} {y0} V{y1} M{fx} {y1 - 6} L{fx - 6.5} {y1 - 0.6} M{fx} {y1 - 6} L{fx + 6.5} {y1 - 0.6}"
    return (f'  <path fill="none" stroke="{LEG_RIM}" stroke-width="4.6" stroke-linecap="round" '
            f'stroke-linejoin="round" d="{d}"/>\n'
            f'  <path fill="none" stroke="{LEG}" stroke-width="3" stroke-linecap="round" '
            f'stroke-linejoin="round" d="{d}"/>\n')


def place(content, scale=1.0, dx=0.0, dy=0.0, clip=None):
    g = f'  <g transform="translate({dx},{dy}) scale({scale})">\n{content}  </g>\n'
    if clip:
        g = f'  <g clip-path="url(#{clip})">\n{g}  </g>\n'
    return g


# The canonical chick, in its own coordinates: head centre (50,44), 54 x 50; body centre
# (50,88), 68 x 54; toes down to y=122. Everything is placed with place().
HX, HY, HRX, HRY = 50, 44, 27, 25
BX, BY, BRX, BRY = 50, 88, 34, 27
HEAD_D = HRX + HRY

# front: the bill starts on the face just under the gap between the eyes, crosses the flank
# and hangs free beside the body. quarter: it comes out from under the cheek feathers nearly
# level and bends only in its outer third.
FRONT_BILL = [(51.5, 55), (68, 63), (88, 80), (94, 112)]
QUARTER_BILL = [(60, 51), (86, 54), (104, 62), (107, 92)]

LEVELS = {0: dict(amp=0.0, n=16), 1: dict(amp=2.4, n=16), 2: dict(amp=3.6, n=19)}


def bird(pose="quarter", level=1, tilt=0.0, feet=True, bill_ctrl=None, w_base=None):
    """Returns (defs, body, head, bill). `body` and `head` are SVG in bird coordinates; `head`
    carries the tuft, the bill, the face and the eyes, rotated by `tilt` about the head centre."""
    lv = LEVELS[level]
    front = pose == "front"
    ctrl = bill_ctrl or (FRONT_BILL if front else QUARTER_BILL)
    bill = Bill(ctrl, w_base or (7.4 if front else 8.4), root=0.0 if front else 0.22)

    defs = (grad("buff", 28, 20, 76, 70) + grad("breast", 30, 64, 78, 116)
            + grad("wing", 16, 62, 84, 116, WING) + GLOSS_DEF + bill.grad())
    defs += (f'    <path id="bodyshape" d="{fluff(BX, BY, BRX, BRY, lv["n"] + 3, lv["amp"], seed=2.0, rot=0.3)}"/>\n'
             f'    <path id="breastshape" d="{fluff(BX + 1, BY + 3, BRX * 0.72, BRY * 0.8, lv["n"], lv["amp"] * 0.75, seed=3.0)}"/>\n'
             f'    <path id="headshape" d="{fluff(HX, HY, HRX, HRY, lv["n"], lv["amp"] * 0.85, seed=1.0, rot=0.2)}"/>\n'
             f'    <path id="tuft" d="{fluff(HX - 1, HY - HRY + 1.5, 9, 5, 7, 3.2, lean=0.2, seed=5.0, rot=math.pi)}"/>\n'
             '    <clipPath id="body-clip"><use href="#bodyshape"/></clipPath>\n'
             '    <clipPath id="breast-clip"><use href="#breastshape"/></clipPath>\n'
             '    <clipPath id="head-clip"><use href="#headshape"/></clipPath>\n')

    body = ""
    if feet:
        body += foot(BX - 12) + foot(BX + 13)
    body += outlined("bodyshape", "url(#wing)")
    body += '  <use href="#breastshape" fill="url(#breast)"/>\n'
    if level == 2:
        body += ('  <g clip-path="url(#breast-clip)">\n'
                 + shingles(BX + 1, BY - BRY * 0.8 + 16, BY + BRY * 0.8 + 6, BRX * 0.72)
                 + '  </g>\n')
    body += ('  <g clip-path="url(#body-clip)">\n'
             f'    <ellipse cx="{BX - 6}" cy="{BY - 13}" rx="26" ry="15" fill="url(#gloss)" opacity="0.8"/>\n'
             '  </g>\n')

    face = outlined("headshape", "url(#buff)")
    face += '  <g clip-path="url(#head-clip)">\n'
    # the dark crown, then the pale band under it
    face += (f'    <path fill="{CROWN}" d="M{HX - HRX - 6} {HY - HRY * 0.5:.1f} '
             f'C{HX - HRX * 0.75:.1f} {HY - HRY * 1.55:.1f} {HX + HRX * 0.75:.1f} {HY - HRY * 1.55:.1f} '
             f'{HX + HRX + 6} {HY - HRY * 0.5:.1f} '
             f'C{HX + HRX * 0.55:.1f} {HY - HRY * 0.92:.1f} {HX - HRX * 0.55:.1f} {HY - HRY * 0.92:.1f} '
             f'{HX - HRX - 6} {HY - HRY * 0.5:.1f} Z"/>\n')
    face += (f'    <path fill="{SUPER}" opacity="0.8" d="M{HX - HRX - 6} {HY - HRY * 0.46:.1f} '
             f'C{HX - HRX * 0.55:.1f} {HY - HRY * 0.9:.1f} {HX + HRX * 0.55:.1f} {HY - HRY * 0.9:.1f} '
             f'{HX + HRX + 6} {HY - HRY * 0.46:.1f} L{HX + HRX + 6} {HY - HRY * 0.22:.1f} '
             f'C{HX + HRX * 0.55:.1f} {HY - HRY * 0.68:.1f} {HX - HRX * 0.55:.1f} {HY - HRY * 0.68:.1f} '
             f'{HX - HRX - 6} {HY - HRY * 0.22:.1f} Z"/>\n')
    face += (f'    <ellipse cx="{HX - 5}" cy="{HY - 13}" rx="17" ry="9" fill="url(#gloss)" opacity="0.5"/>\n'
             '  </g>\n')
    if front:
        eyes = big_eye(HX - 10.5, HY + 3, 7.4) + big_eye(HX + 9.5, HY + 3, 7.4)
        billsvg = bill.draw(t0=0.0, cap=True)
        inner = outlined("tuft", CROWN, 2.4) + face + eyes + billsvg
    else:
        eyes = big_eye(HX + 8, HY + 1, 7.8) + big_eye(HX - 11, HY + 1, 6.6)
        billsvg = bill.draw(t0=0.0)
        inner = outlined("tuft", CROWN, 2.4) + billsvg + face + eyes
    head = f'  <g transform="rotate({tilt} {HX} {HY})">\n{inner}  </g>\n'
    return defs, body, head, bill


def write(name, comment, defs, body):
    comment = comment.replace("--", "\u2013")
    svg = (f'<?xml version="1.0" encoding="UTF-8"?>\n<!--\n{comment}\n-->\n'
           '<svg width="128" height="128" viewBox="0 0 128 128" version="1.1"\n'
           '     xmlns="http://www.w3.org/2000/svg">\n'
           f'  <defs>\n{defs}  </defs>\n\n{body}</svg>\n')
    (OUT / f"{name}.svg").write_text(svg)


MEASURE = []


def measure(name, bill, scale):
    wb = bill.width(bill.root)
    MEASURE.append((name, wb / HEAD_D, bill.length() / HEAD_D, wb * scale * 48 / 128))


# =========================================================================================== v1
d, body, head, bill = bird("front", level=2)
bd, bg = bubble(0.66, 50, 2)
write("v1-front-full-fluff",
      "V1 -- Pascal's edit, redrawn: frontal chick with the full fluff, shingled breast, pale\n"
      "band and dark crown tuft, the thin bill crossing the flank with one even pale rim, whole\n"
      "toes, and the enlarged bubble behind the bird in GNOME blue.",
      d + bd, bg + place(body + head, 0.9, -6, 10))
measure("v1-front-full-fluff", bill, 0.9)

# =========================================================================================== v2
d, body, head, bill = bird("front", level=1, tilt=-9)
bd, bg = bubble(0.8, 30, 2)
write("v2-front-tilt-medium",
      "V2 -- the same frontal chick with its head tilted, medium feathers: fluffed outlines but a\n"
      "plain breast. The bubble is bigger still and sits behind the bird like a backdrop.",
      d + bd, bg + place(body + head, 0.9, -8, 12))
measure("v2-front-tilt-medium", bill, 0.9)

# =========================================================================================== v3
d, body, head, bill = bird("quarter", level=0)
bd, bg = bubble(0.5, 66, 4)
write("v3-quarter-minimal",
      "V3 -- three quarters, minimal feathers: smooth glossy body and head, only the crown tuft\n"
      "is feathered. The bill leaves the cheek level and hangs beside the body; bubble beside.",
      d + bd, bg + place(body + head, 0.88, -8, 12))
measure("v3-quarter-minimal", bill, 0.88)

# =========================================================================================== v4
d, body, head, bill = bird("quarter", level=1, tilt=-58)
bd, bg = bubble(0.45, 72, 58)
write("v4-calling-medium",
      "V4 -- calling: the head thrown back, the bill pointing up and curving over at the tip,\n"
      "medium feathers. The bubble stands beside the bird, its tail towards it.",
      d + bd, bg + place(body + head, 0.8, -4, 24))
measure("v4-calling-medium", bill, 0.8)

# =========================================================================================== v5
d, body, head, bill = bird("quarter", level=2, feet=False)
bd, bg = bubble(0.72, 24, 50)
write("v5-peek-over-rim",
      "V5 -- the chick peeks over the top rim of a big bubble: only the fluffed head shows, the\n"
      "eyes just above the rim, the bill reaching down across the bubble's face.",
      d + bd, place(head, 0.9, 3, -2) + bg + place(bill.draw(t0=0.3), 0.9, 3, -2))
measure("v5-peek-over-rim", bill, 0.9)

# =========================================================================================== v6
d, body, head, bill = bird("quarter", level=1)
bd, bg = bubble(0.55, 30, 66)
write("v6-standing-on-bubble",
      "V6 -- the chick stands on the rim of the bubble, toes on its top edge, the bill hanging\n"
      "out to the side. Bird and bubble share the canvas half and half.",
      d + bd, bg + place(body + head, 0.56, 30, -1.5))
measure("v6-standing-on-bubble", bill, 0.56)

# =========================================================================================== v7
d, body, head, bill = bird("front", level=2, feet=False,
                           bill_ctrl=[(51.5, 55), (65, 61), (77, 71), (83, 88)])
bd, bg = bubble(1.0, 8, 24)
# The belly runs on into the bubble's tail, but never over the side wall: the body is clipped to
# the face rect and the tail's face (the lip), so wall and rim stay in front of the feathers.
# One path, not two shapes in the clipPath: renderers disagree on how those combine.
bd += ('    <clipPath id="belly-clip"><path d="M24 24 H104 C112.835938 24 120 31.164062 120 40 V92 '
       'C120 100.835938 112.835938 108 104 108 H58.824219 '
       'C57.011719 108 55.265625 108.691406 53.941406 109.933594 L40.6 122.2 '
       'C39.5 123.2 37.9 123.6 36.4 123 C35.1 122.3 34 120.8 34 119 V112 '
       'C34 109.789062 32.210938 108 30 108 H24 '
       'C15.164062 108 8 100.835938 8 92 V40 C8 31.164062 15.164062 24 24 24 Z"/>'
       '</clipPath>\n')
write("v7-in-bubble",
      "V7 -- the bubble is the icon: the shared Fractal/Flare shape at full size in blue, the\n"
      "fluffed chick inside it with two equal eyes and the bill in front of the face. The body\n"
      "is clipped to the bubble's face and the face of its tail, so the belly fills the tail and\\n"
      "the side wall stays in front.",
      d + bd, bg + place(body, 0.9, 5, 24, clip="belly-clip") + place(head, 0.9, 5, 24))
measure("v7-in-bubble", bill, 0.9)

# =========================================================================================== v8
d, body, head, bill = bird("front", level=2, feet=False,
                           bill_ctrl=[(51.5, 55), (65, 61), (77, 71), (83, 88)])
bd, bg = bubble(0.9, 4, 8)
write("v8-head-crop",
      "V8 -- head and fluff only, for 32 and 16 px: the fluffed head at the right, the chest\\n"
      "running off the bottom edge, the short young bill, and the bubble behind it with its\\n"
      "tail free at the lower left.",
      d + bd, bg + place(body + head, 1.2, 24, -3))
measure("v8-head-crop", bill, 1.2)

# ================================================================================ v9, v10 (tilt)
# The slight head tilt of v2, on the two fixed compositions.
d, body, head, bill = bird("front", level=2, tilt=-9, feet=False,
                           bill_ctrl=[(51.5, 55), (65, 61), (77, 71), (83, 88)])
bd, bg = bubble(1.0, 8, 24)
bd += ('    <clipPath id="belly-clip"><path d="M24 24 H104 C112.835938 24 120 31.164062 120 40 V92 '
       'C120 100.835938 112.835938 108 104 108 H58.824219 '
       'C57.011719 108 55.265625 108.691406 53.941406 109.933594 L40.6 122.2 '
       'C39.5 123.2 37.9 123.6 36.4 123 C35.1 122.3 34 120.8 34 119 V112 '
       'C34 109.789062 32.210938 108 30 108 H24 '
       'C15.164062 108 8 100.835938 8 92 V40 C8 31.164062 15.164062 24 24 24 Z"/>'
       '</clipPath>\n')
write("v9-in-bubble-tilt",
      "V9 -- v7 with the head tilted slightly, as in v2: the belly fills the tail, the wall\n"
      "stays in front of the feathers.",
      d + bd, bg + place(body, 0.9, 5, 24, clip="belly-clip") + place(head, 0.9, 5, 24))
measure("v9-in-bubble-tilt", bill, 0.9)

bd, bg = bubble(0.9, 4, 8)
write("v10-head-crop-tilt",
      "V10 -- v8 with the head tilted slightly, as in v2: the tail of the bubble stays free.",
      d + bd, bg + place(body + head, 1.2, 17, -3))
measure("v10-head-crop-tilt", bill, 1.2)

# ====================================================================================== symbolic
#
# The pick (the three-quarter chick) reduced to one colour on the 16 px grid: round head with
# the crown tuft, one eye punched out, the fluffed chest, the bill a thin downcurved line.

S_BILL = Bill(ctrl=[(8.4, 7.6), (11.8, 7.8), (13.8, 8.8), (14.3, 13.8)], w_base=1.9, w_tip=1.0,
              taper=1.2, root=0.05)
sym = ('<?xml version="1.0" encoding="UTF-8"?>\n'
       '<!--\nSymbolic: the chick\'s head with crown tuft and punched-out eye, the fluffed chest and\n'
       'the thin downcurved bill. One colour, 16 px grid, no gradients.\n-->\n'
       '<svg width="16" height="16" viewBox="0 0 16 16" version="1.1" xmlns="http://www.w3.org/2000/svg">\n'
       '  <g fill="#2e3436">\n'
       '    <path d="M3.6 3.6 C3 1.6 4.6 1.2 5 2.4 C5.2 0.6 7 0.8 6.8 2.4 C7.6 1.2 9 2 8 3.6 Z"/>\n'
       '    <path fill-rule="evenodd" d="M5.8 2.8 a4.6 4.5 0 1 0 0.01 0 Z '
       'M7.3 5.7 a1.3 1.3 0 1 0 0.01 0 Z"/>\n'
       '    <path d="M2.6 11 C1.4 12.4 1.2 14.2 1.6 16 H10 C10.4 14.2 10.2 12.4 9 11 Z"/>\n'
       f'    <path d="{S_BILL.band(1, -1, 0.0, 1.0)}"/>\n'
       '  </g>\n</svg>\n')
(OUT / "symbolic.svg").write_text(sym)

print(f"wrote {len(list(OUT.glob('v*.svg')))} variants + symbolic.svg\n")
print(f"{'variant':24} {'w/D':>6} {'L/D':>6} {'px@48':>6}")
for name, r, lr, px in MEASURE:
    print(f"{name:24} {r:6.3f} {lr:6.2f} {px:6.2f}")
