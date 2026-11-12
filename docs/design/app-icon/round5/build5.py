#!/usr/bin/env python3
"""Round 5: the Pidgin idea -- a frontal, glossy bird with a messenger bubble beside it.

Everything here hangs off one problem: the bill. Rounds 1-4 drew it as two hand-guessed Bezier
edges, and it came out either a stick (round 1) or a sash with an up-hooked tip (round 4, V7/V8)
-- a curlew's bill does the opposite, it leaves the face almost straight and bends further down
the nearer the tip. So the bill is not drawn here, it is BUILT: one centreline curve, one width
profile along it, and the outline is the centreline offset by half that width to each side. The
same machinery then cuts the lower mandible, the dark tip and the gloss out of the same
centreline, so those three can never drift off the shaft.

The bubble is not drawn either: the block below is round 4's, traced from Fractal and Flare, so
the bubble still lines up with theirs in a sidebar. New here is that it may be scaled down and
parked at the upper right the way Pidgin's is, where its tail -- bottom left in the shared
geometry -- happens to point straight at the bird's head.
"""
import math
import pathlib

OUT = pathlib.Path(__file__).resolve().parent

# --------------------------------------------------------------------------------- the palette
BUFF = ("#f8e8c8", "#e2c091", "#b0804f")        # breast and head, light -> shadow
WING = ("#dcb988", "#c49a68", "#a0743f")        # folded wings: sandy, only a shade under
                                                # the breast -- a dark wing swallows the bill
CROWN = "#7a5130"                               # the dark crown stripes
SUPER = "#fbf0d8"                               # the pale stripe over the eye
BILL = ("#7a5533", "#4a3420", "#33230f")        # upper mandible, base -> tip
BILL_LOW = "#a8835c"                            # the paler lower mandible
BILL_TIP = "#2a1c10"
EYE = "#241f31"
LEG = "#8d94a0"                                 # a curlew's legs are blue-grey, not brown

HUES = {
    "orange": ("#e66100", "#ff7800", "#ffa348"),
    "red": ("#c01c28", "#e01b24", "#f66151"),
    # light neutral: the wall tone has to stay darker than the page (#f6f5f4) or the bubble
    # loses its edge on a light theme
    "neutral": ("#9a9996", "#deddda", "#ffffff"),
}

# ------------------------------------------------------------------- the shared GNOME bubble
# Verbatim from round4/build.py: face rect x8..120 / y24..108 r=16, the wall rect 4 px lower,
# the swoop tail bottom left and the 2 px lip above it.

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
  <use href="#lip" fill="@MID@"/>
"""


def bubble_block(hue):
    dark, mid, light = HUES[hue]
    sub = lambda s: s.replace("@DARK@", dark).replace("@MID@", mid).replace("@LIGHT@", light)
    return sub(BUBBLE_DEFS), sub(BUBBLE_DRAW)


def small_bubble(hue, scale, x, y):
    """The shared bubble shrunk and parked, Pidgin-fashion, at the upper right.

    Placed by its face rect: (x, y) is the top left corner of the face, so the caller can think
    in canvas pixels instead of in the tail's coordinates.
    """
    defs, draw = bubble_block(hue)
    tx = x - 8 * scale
    ty = y - 24 * scale
    return defs, (f'  <g transform="translate({tx:.2f},{ty:.2f}) scale({scale})">\n'
                  + draw + "  </g>\n")


# ------------------------------------------------------------------------------------ the bill
#
# A cubic centreline plus a width profile. The profile is deliberately NOT linear: a curlew's
# bill keeps most of its depth through the first half and loses it in the outer third, which is
# what makes it read as a bill rather than as a cone.


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
    """One bill. Every piece of it is an offset band of the same centreline."""

    def __init__(self, ctrl, w_base, w_tip=1.3, taper=2.0, flip=1, samples=26):
        self.c = ctrl
        self.wb, self.wt, self.taper = w_base, w_tip, taper
        self.flip = flip          # +1: normal is the upper edge (bill sweeping right)
        self.n = samples

    def width(self, t):
        return self.wt + (self.wb - self.wt) * (1 - t ** self.taper)

    def edge(self, t, frac):
        """A point offset from the centreline by `frac` of the half width (+1 = upper edge)."""
        x, y = _pt(self.c, t)
        dx, dy = _tan(self.c, t)
        nx, ny = dy * self.flip, -dx * self.flip
        o = self.width(t) * 0.5 * frac
        return x + nx * o, y + ny * o

    def band(self, a, b, t0=0.0, t1=1.0):
        """Closed path between offset `a` and offset `b`, from t0 to t1."""
        n = max(6, int(self.n * (t1 - t0)) + 3)
        up = [self.edge(t0 + (t1 - t0) * i / n, a) for i in range(n + 1)]
        dn = [self.edge(t0 + (t1 - t0) * i / n, b) for i in range(n, -1, -1)]
        d = "M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in up)
        d += " L" + " L".join(f"{x:.2f} {y:.2f}" for x, y in dn) + " Z"
        return d

    def grad(self, gid):
        (x0, y0), (x1, y1) = _pt(self.c, 0.0), _pt(self.c, 1.0)
        return (f'    <linearGradient id="{gid}" x1="{x0:.1f}" y1="{y0:.1f}" '
                f'x2="{x1:.1f}" y2="{y1:.1f}" gradientUnits="userSpaceOnUse">\n'
                f'      <stop offset="0" stop-color="{BILL[0]}"/>\n'
                f'      <stop offset="0.45" stop-color="{BILL[1]}"/>\n'
                f'      <stop offset="1" stop-color="{BILL[2]}"/>\n'
                '    </linearGradient>\n')

    def draw(self, gid="bill", tip=0.74, gloss=True, halo=None):
        s = f'  <!-- bill: one centreline, offset. {self.wb:g} px at the base, tapering over the outer third -->\n'
        outline = self.band(1, -1)
        if halo:
            # where the bill crosses the bird's own dark flank it would otherwise be swallowed;
            # the rim is drawn under the fill, so only about a pixel of it shows
            s += (f'  <path fill="none" stroke="{halo}" stroke-width="3" stroke-opacity="0.5" '
                  f'stroke-linejoin="round" d="{outline}"/>\n')
        s += f'  <path fill="url(#{gid})" d="{outline}"/>\n'
        # the lower mandible: a paler sliver under the shaft, stopping short of the tip
        s += f'  <path fill="{BILL_LOW}" opacity="0.75" d="{self.band(-0.3, -1, 0.06, 0.72)}"/>\n'
        # the dark tip, cut from the same outline so it can never step off the shaft
        s += f'  <path fill="{BILL_TIP}" d="{self.band(1, -1, tip, 1.0)}"/>\n'
        if gloss:
            s += f'  <path fill="#ffffff" opacity="0.17" d="{self.band(0.35, 0.95, 0.04, 0.62)}"/>\n'
        return s


# ------------------------------------------------------------------------------- bird plumbing


def buff(x1, y1, x2, y2, name="buff", ramp=BUFF):
    return (f'    <linearGradient id="{name}" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" '
            'gradientUnits="userSpaceOnUse">\n'
            f'      <stop offset="0" stop-color="{ramp[0]}"/>\n'
            f'      <stop offset="0.55" stop-color="{ramp[1]}"/>\n'
            f'      <stop offset="1" stop-color="{ramp[2]}"/>\n'
            '    </linearGradient>\n')


GLOSS_DEF = """    <radialGradient id="gloss" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.55"/>
      <stop offset="0.65" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
"""


def eye(cx, cy, r=6.0):
    return (f'    <circle cx="{cx}" cy="{cy}" r="{r}" fill="{EYE}"/>\n'
            f'    <circle cx="{cx + r * 0.34:.1f}" cy="{cy - r * 0.34:.1f}" r="{r * 0.31:.1f}" '
            'fill="#ffffff" opacity="0.9"/>\n')


def streaks(spec, op=0.34):
    s = f'  <g fill="#9a6c42" opacity="{op}">\n'
    for x, y, dx, h in spec:
        s += f'    <path d="M{x} {y} l3 1 l{dx} {h} l-3 -1 Z"/>\n'
    return s + "  </g>\n"


def write(name, comment, defs, body):
    comment = comment.replace("--", "\u2013")
    svg = (f'<?xml version="1.0" encoding="UTF-8"?>\n<!--\n{comment}\n-->\n'
           '<svg width="128" height="128" viewBox="0 0 128 128" version="1.1"\n'
           '     xmlns="http://www.w3.org/2000/svg">\n'
           f'  <defs>\n{defs}  </defs>\n\n{body}</svg>\n')
    (OUT / f"{name}.svg").write_text(svg)


# ================================================================================ the front bird
#
# Head-on, the bill points at the viewer and foreshortens to nothing, so the head is turned a
# few degrees and the bill leaves the face under the chin, crosses the breast on a shallow slope
# and then bends down until the tip hangs clear of the body against the background. Round 4 ran
# that curve the other way round -- shaft down the breast, tip swinging up and out -- and the
# result read as a sash with a hook. Down at the tip is what says curlew.

# The bill starts between the eyes, in front of the face -- the way Pidgin's beak sits on its
# pigeon -- descends across the breast and leaves the silhouette before the tip, so the last
# fifth, where the curve is tightest, is free against the background.
# The last control point sits almost straight below the one before it, so the tip runs DOWN and
# not out: a bill that ends on a diagonal reads as a dagger, and every bird has one of those.
# The curve crosses the BREAST, well inside the silhouette, and only the tip hangs past the
# bottom edge. Routed any further right it ran along the body's own outline and stopped reading
# as a separate shape; routed any further left it cut the bird in half.
# taper 2.4 rather than the side bird's 1.9: the width is held most of the way down and spent in
# the last fifth, so the shaft still has a pixel or two to show at 32 px instead of fading out.
FRONT_BILL = Bill(ctrl=[(57, 43), (78, 60), (92, 85), (90, 117)], w_base=11.5, w_tip=1.6, taper=2.4)


def front_defs(bill):
    return (buff(32, 20, 92, 112) + buff(38, 46, 88, 106, "breast")
            + buff(20, 52, 100, 106, "wing", WING) + GLOSS_DEF + bill.grad("bill"))


FRONT_LEGS = f"""  <g stroke="{LEG}" stroke-width="5" stroke-linecap="round" fill="none">
    <path d="M51 98 V112"/>
    <path d="M69 98 V112"/>
  </g>
  <g stroke="{LEG}" stroke-width="3.6" stroke-linecap="round" fill="none">
    <path d="M51 112 L42 119"/>
    <path d="M51 112 V120"/>
    <path d="M51 112 L60 119"/>
    <path d="M69 112 L60 119"/>
    <path d="M69 112 V120"/>
    <path d="M69 112 L78 119"/>
  </g>
"""

BODY_DEF = ('    <path id="bodyshape" d="M60 46 C86 46 98 67 98 86 C98 100 89 108 74 108 H46'
            ' C31 108 22 100 22 86 C22 67 34 46 60 46 Z"/>\n'
            '    <clipPath id="body-clip"><use href="#bodyshape"/></clipPath>\n')

FRONT_BODY = """  <!-- folded wings: the darker flanks a standing curlew shows either side of the breast -->
  <use href="#bodyshape" fill="url(#wing)"/>
  <path fill="url(#breast)" d="M60 53 C79 53 88 70 88 86 C88 97 81 103 70 103 H50
                               C39 103 32 97 32 86 C32 70 41 53 60 53 Z"/>
"""

FRONT_STREAKS = streaks([(40, 68, -3, 24), (50, 61, -3, 34), (69, 61, -2, 34), (79, 68, -1, 22)])

FRONT_GLOSS = """  <!-- the top-lit sheen, clipped to the body: Pidgin's gloss, kept flat enough for GNOME -->
  <g clip-path="url(#body-clip)">
    <ellipse cx="54" cy="56" rx="32" ry="24" fill="url(#gloss)"/>
  </g>
"""


def front_head(turn=-10, e1=48, e2=69, ey=38, r=6.2):
    return (f'  <g transform="rotate({turn} 60 38)">\n'
            '    <!-- the same ellipse 3 px lower, a crescent of shade that lifts the head off the back -->\n'
            f'    <ellipse cx="60" cy="39" rx="24" ry="22" fill="#8a5f3a" opacity="0.4"/>\n'
            '    <ellipse cx="60" cy="36" rx="24" ry="22" fill="url(#buff)"/>\n'
            '    <!-- dark crown with the pale central stripe a curlew has, and the supercilium\n'
            '         over each eye: the marks that still say curlew when the bill foreshortens -->\n'
            f'    <path fill="{CROWN}" d="M60 14 C74 14 83 23 84 36 C77 24 69 21 60 21 '
            'C51 21 43 24 36 36 C37 23 46 14 60 14 Z"/>\n'
            f'    <path fill="{SUPER}" opacity="0.38" d="M37 38 C42 29 51 25 60 25 C69 25 78 29 83 38 '
            'L81 41 C76 33 69 30 60 30 C51 30 44 33 39 41 Z"/>\n'
            '    <ellipse cx="56" cy="27" rx="15" ry="8" fill="url(#gloss)" opacity="0.5"/>\n'
            + eye(e1, ey, r) + eye(e2, ey, r)
            + "  </g>\n")


def front_bird(bill=FRONT_BILL, turn=-10, scale=1.0, dx=0.0, dy=0.0, legs=True, cy=72.0):
    g = f'  <g transform="translate({dx},{dy}) translate(64,{cy}) scale({scale}) translate(-64,-72)">\n'
    return (g + (FRONT_LEGS if legs else "") + FRONT_BODY + FRONT_STREAKS + FRONT_GLOSS
            + (bill.draw("bill", halo=BUFF[0]) if bill else "") + front_head(turn) + "  </g>\n")


FRONT_CLIP = BODY_DEF


# ================================================================================== the side bird
#
# In profile nothing has to be implied: the bill is at its full length and its full curve, so the
# whole composition is built around that one diagonal. Head and breast sit lower left, the bill
# takes the rest of the canvas.

SIDE_BILL = Bill(ctrl=[(56, 40), (92, 44), (110, 60), (113, 102)], w_base=12.5, w_tip=1.7, taper=1.9)


def side_defs(bill):
    # the head is an egg, not a circle: the forehead has to run down into the base of the bill,
    # or the bill looks stuck on to a ball
    return (buff(14, 14, 70, 120) + buff(10, 56, 80, 124, "breast")
            + buff(8, 70, 60, 126, "wing", WING) + GLOSS_DEF
            + bill.grad("bill")
            + '    <path id="head" d="M70 44 C69 30 58 18 42 18 C26 18 13 29 13 43'
            ' C13 57 26 67 42 67 C56 67 68 57 70 44 Z"/>\n'
            '    <clipPath id="head-clip"><use href="#head"/></clipPath>\n')


SIDE_BODY = """  <!-- neck and breast, running off the bottom edge so the head reads as a crop; the
       neck is narrower than the head, which is what gives the bird a jaw instead of a sock -->
  <path fill="url(#breast)" d="M30 56 C19 80 15 104 18 128 L76 128 C70 104 66 80 60 56 Z"/>
  <!-- the folded wing behind the breast: a rounded shoulder that falls away into the flank.
       A straight-topped patch read as a second body edge standing beside the breast. -->
  <path fill="url(#wing)" d="M26 78 C16 94 13 110 16 128 L46 128 C41 108 43 92 51 79
                             C44 70 32 70 26 78 Z"/>
""" + streaks([(34, 74, -4, 16), (46, 76, -4, 16),
               (30, 96, -4, 16), (44, 98, -4, 16),
               (28, 118, -3, 10), (42, 120, -3, 8)], 0.3)

SIDE_HEAD = (f'  <use href="#head" fill="url(#buff)"/>\n'
             '  <g clip-path="url(#head-clip)">\n'
             '    <!-- the dark crown, low enough on the head to actually show: the earlier cap\n'
             '         sat above the skull line and clipped away to nothing -->\n'
             f'    <path fill="{CROWN}" d="M4 46 C8 26 22 12 42 12 C62 12 76 22 80 34 '
             'C62 24 40 26 24 32 C14 36 7 41 4 46 Z"/>\n'
             '    <!-- the pale supercilium, running under the crown and over the eye -->\n'
             f'    <path fill="{SUPER}" opacity="0.5" d="M10 42 C26 30 56 27 76 33 L76 37 '
             'C56 31 27 34 12 48 Z"/>\n'
             '    <ellipse cx="34" cy="24" rx="16" ry="8" fill="url(#gloss)" opacity="0.55"/>\n'
             '  </g>\n')


def side_bird(bill=SIDE_BILL, scale=1.0, dx=0.0, dy=0.0, ex=52, ey=35):
    g = f'  <g transform="translate({dx},{dy}) translate(64,64) scale({scale}) translate(-64,-64)">\n'
    return (g + SIDE_BODY + SIDE_HEAD + bill.draw("bill") + eye(ex, ey, 6.4) + "  </g>\n")


# ======================================================================================= variants

BUB_S, BUB_X, BUB_Y = 0.42, 78.0, 3.0     # the small bubble: scale and the face rect's top left

# ---------------------------------------------------------------------------- 1/2 frontal bird

fdefs, fdraw = small_bubble("orange", BUB_S, BUB_X, BUB_Y)
write("v1-front-bubble",
      "V1 -- the Pidgin idea in curlew: the bird square to the viewer, big eyes, and the shared\n"
      "GNOME bubble shrunk and parked at the upper right, where its tail points back at the head.\n"
      "The bill leaves the face under the chin, crosses the breast flat and bends down until the\n"
      "tip hangs free against the background.",
      front_defs(FRONT_BILL) + FRONT_CLIP + fdefs,
      fdraw + front_bird(scale=0.86, dx=-7, dy=6))

write("v2-front-nobubble",
      "V2 -- V1's bird alone, filling the canvas: no bubble, so the bill gets the whole width.",
      front_defs(FRONT_BILL) + FRONT_CLIP,
      front_bird(scale=1.04, dx=-2, dy=-1))

# ------------------------------------------------------------------------------- 3/4 side bird

sdefs, sdraw = small_bubble("orange", 0.40, 84.0, 2.0)
write("v3-side-bubble",
      "V3 -- the same bird in profile, where the bill needs no excuse: head and breast lower left,\n"
      "the sickle taking the whole diagonal, the shared bubble small at the upper right.",
      side_defs(SIDE_BILL) + sdefs,
      sdraw + side_bird(scale=0.84, dx=-10, dy=10))

write("v4-side-nobubble",
      "V4 -- V3's bird alone: the longest, most legible version of the bill in the set.",
      side_defs(SIDE_BILL),
      side_bird(scale=1.0))

# -------------------------------------------------------------- 5/6 the bubble in light neutral

ndefs, ndraw = small_bubble("neutral", BUB_S, BUB_X, BUB_Y)
write("v5-front-bubble-neutral",
      "V5 -- V1 with the bubble in light neutral instead of orange, so the bird's own buff and\n"
      "brown carry the icon and the bubble is only the badge that says messenger.",
      front_defs(FRONT_BILL) + FRONT_CLIP + ndefs,
      ndraw + front_bird(scale=0.86, dx=-7, dy=6))

n2defs, n2draw = small_bubble("neutral", 0.40, 84.0, 2.0)
write("v6-side-bubble-neutral",
      "V6 -- V3 with the neutral bubble.",
      side_defs(SIDE_BILL) + n2defs,
      n2draw + side_bird(scale=0.84, dx=-10, dy=10))

# ------------------------------------------------------- 7 frontal, turned further, red bubble

QUARTER_BILL = Bill(ctrl=[(55, 43), (76, 59), (90, 84), (89, 116)], w_base=11.5, w_tip=1.6, taper=2.4)
rdefs, rdraw = small_bubble("red", BUB_S, BUB_X, BUB_Y)
write("v7-front-quarter-red",
      "V7 -- the frontal bird turned a few degrees further, so the bill crosses more of the breast\n"
      "and its curve shows at a glance; the bubble in the red of the shipped icon.",
      front_defs(QUARTER_BILL) + FRONT_CLIP + rdefs,
      rdraw + front_bird(bill=QUARTER_BILL, turn=-16, scale=0.86, dx=-7, dy=6))

# ------------------------------------------------------------- 8 the whole bird, side, no bubble

STAND_BILL = Bill(ctrl=[(82, 26), (108, 31), (120, 48), (121, 84)], w_base=9.0, w_tip=1.3, taper=1.9)
write("v8-side-standing",
      "V8 -- the whole bird in profile on its long legs, the way a curlew is actually seen on a\n"
      "mudflat. The test is 32 px: a whole bird has to survive losing its legs.",
      buff(16, 48, 90, 104) + buff(56, 10, 92, 60, "neck")
      + buff(18, 58, 84, 100, "wing", WING) + GLOSS_DEF + STAND_BILL.grad("bill")
      + '    <path id="head" d="M94 27 C93 18 86 11 76 11 C65 11 57 18 57 28 C57 37 65 43 76 43'
      ' C87 43 94 36 94 27 Z"/>\n'
      '    <clipPath id="head-clip"><use href="#head"/></clipPath>\n'
      '    <ellipse id="standbody" cx="50" cy="74" rx="33" ry="23"/>\n'
      '    <clipPath id="body-clip"><use href="#standbody"/></clipPath>\n',
      f"""  <g stroke="{LEG}" stroke-width="5" stroke-linecap="round" fill="none">
    <path d="M44 90 L40 114"/>
    <path d="M60 90 L62 114"/>
  </g>
  <g stroke="{LEG}" stroke-width="3.8" stroke-linecap="round" fill="none">
    <path d="M40 114 L31 120"/>
    <path d="M40 114 L45 121"/>
    <path d="M62 114 L53 120"/>
    <path d="M62 114 L67 121"/>
  </g>
  <!-- the short tail, pointing back and a little up: blunt, the way a wader's is. A pointed
       one read as a fin stuck on the body. -->
  <path fill="url(#wing)" d="M32 62 C22 57 13 55 7 58 C6 63 7 68 10 72 C17 76 25 78 32 79 Z"/>
  <use href="#standbody" fill="url(#buff)"/>
  <!-- the folded wing: a shallow crescent lying along the flank, its top edge following the
       body's curve, so it reads as a folded wing and not as a dark blob dropped on the bird -->
  <path fill="url(#wing)" opacity="0.78" d="M27 68 C42 59 62 61 74 72 C70 84 54 90 38 86
                                            C29 83 24 76 27 68 Z"/>
  <g clip-path="url(#body-clip)">
    <ellipse cx="44" cy="60" rx="30" ry="14" fill="url(#gloss)"/>
  </g>
""" + streaks([(36, 70, -2, 14), (48, 68, -2, 16), (60, 70, -1, 14)], 0.22)
      + """  <!-- neck: narrow where it leaves the body, widening into the head -->
  <path fill="url(#neck)" d="M58 58 C56 44 60 30 72 26 L84 32 C76 38 72 46 72 62 Z"/>
  <use href="#head" fill="url(#neck)"/>
  <g clip-path="url(#head-clip)">
    <path fill="#7a5130" d="M56 26 C60 14 68 7 77 7 C88 7 95 14 96 22 C82 12 64 15 56 26 Z"/>
    <path fill="#fbf0d8" opacity="0.45" d="M58 30 C68 20 88 20 96 25 L96 28 C84 22 66 24 59 33 Z"/>
  </g>
""" + STAND_BILL.draw("bill") + eye(84, 26, 5.2))

# ------------------------------------------- 9 the frontal bird inside the full-size bubble tile

TILE_BILL = Bill(ctrl=[(54, 50), (78, 64), (94, 84), (93, 114)], w_base=10.5, w_tip=1.5, taper=2.4)
tdefs, tdraw = bubble_block("red")
write("v9-front-in-tile-red",
      "V9 -- continuity with the shipped icon: the full-size shared bubble as the tile, the frontal\n"
      "bird clipped into it and the bill, drawn outside the clip, breaking out over the right edge.\n"
      "Legs off: inside a bubble they read as cracks.",
      tdefs + buff(34, 20, 96, 112) + buff(42, 46, 92, 106, "breast")
      + buff(22, 52, 106, 106, "wing", WING) + GLOSS_DEF + TILE_BILL.grad("bill") + FRONT_CLIP,
      tdraw + '  <g clip-path="url(#face-clip)">\n'
      + front_bird(bill=None, turn=-10, scale=0.72, dx=-4, cy=74, legs=False) + "  </g>\n"
      + TILE_BILL.draw("bill", halo=BUFF[0]))

print("wrote", len(list(OUT.glob("v*.svg"))), "variants")
