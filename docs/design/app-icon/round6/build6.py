#!/usr/bin/env python3
"""Round 6: the bill redrawn from the bird up.

Round 5's verdict was one sentence: the bill is far too thick. So this round does not iterate
on it, it starts from the measurements of the real bird. A curlew's bill is about as long as
head and neck together (in an icon: 1.0-1.3 head diameters), at the base no wider than a fifth
or a sixth of the head, and it leaves the face nearly straight and bends most in the outer
third. Every bill here is built from one centreline and one width profile, as in round 5, and
the generator PRINTS the numbers for every variant -- head diameter, width at the base, length
-- so the thickness is measured, not guessed.

The other round-5 weak points are answered here too: a dark crown with the supercilium and the
eye-stripe for contrast, a soft dark outline round the silhouette so the bird holds its edge on
both themes, big eyes, and no texture at all that would turn to mush below 48 px.

The bubble block below is round 4's, traced from Fractal and Flare, verbatim, so the bubble
still lines up with theirs in a sidebar.
"""
import math
import pathlib

OUT = pathlib.Path(__file__).resolve().parent

# --------------------------------------------------------------------------------- the palette
BUFF = ("#fbeed6", "#e6c597", "#b8864f")        # breast and head, light -> shadow
WING = ("#dcb988", "#c49a68", "#a0743f")        # folded wing: a shade under the breast
CROWN = "#6b4428"                               # dark crown and eye-stripe
SUPER = "#fdf4e2"                               # the pale supercilium
RIM = "#5e3d22"                                 # the soft outline round the silhouette
BILL = ("#6e4a2b", "#432d18", "#2b1c0d")        # upper mandible, base -> tip
BILL_LOW = "#b8946c"                            # the lower mandible, barely there
BILL_TIP = "#1e130a"
EYE = "#241f31"
LEG = "#8d94a0"                                 # a curlew's legs are blue-grey

HUES = {
    "orange": ("#e66100", "#ff7800", "#ffa348"),
    "red": ("#c01c28", "#e01b24", "#f66151"),
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
    """The shared bubble shrunk and parked at the upper right; (x, y) is the face rect's top left."""
    defs, draw = bubble_block(hue)
    tx = x - 8 * scale
    ty = y - 24 * scale
    return defs, (f'  <g transform="translate({tx:.2f},{ty:.2f}) scale({scale})">\n'
                  + draw + "  </g>\n")


# ------------------------------------------------------------------------------------ the bill
#
# One cubic centreline, one width profile, everything else an offset band of it. The profile
# here is close to linear (taper 1.5): round 5 held the width through the first half, which is
# exactly what made the shaft look like a sash. A real bill thins steadily and the last fifth
# comes to a point.


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
    """One bill. `root` is the parameter where it leaves the feathers: the centreline starts
    inside the skull so the head can be painted over the root, and all measurements are taken
    from `root` outwards."""

    def __init__(self, ctrl, w_base, w_tip=1.2, taper=1.5, root=0.1, samples=30):
        self.c = ctrl
        self.wb, self.wt, self.taper, self.root = w_base, w_tip, taper, root
        self.n = samples

    def width(self, t):
        return self.wt + (self.wb - self.wt) * (1 - t ** self.taper)

    def point(self, t):
        return _pt(self.c, t)

    def edge(self, t, frac):
        x, y = _pt(self.c, t)
        dx, dy = _tan(self.c, t)
        nx, ny = dy, -dx
        o = self.width(t) * 0.5 * frac
        return x + nx * o, y + ny * o

    def length(self, t0=None, t1=1.0, n=200):
        t0 = self.root if t0 is None else t0
        pts = [_pt(self.c, t0 + (t1 - t0) * i / n) for i in range(n + 1)]
        return sum(math.dist(a, b) for a, b in zip(pts, pts[1:]))

    def band(self, a, b, t0=0.0, t1=1.0):
        n = max(6, int(self.n * (t1 - t0)) + 3)
        up = [self.edge(t0 + (t1 - t0) * i / n, a) for i in range(n + 1)]
        dn = [self.edge(t0 + (t1 - t0) * i / n, b) for i in range(n, -1, -1)]
        d = "M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in up)
        d += " L" + " L".join(f"{x:.2f} {y:.2f}" for x, y in dn) + " Z"
        return d

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

    def draw(self, gid="bill", tip=0.8, halo=None, t0=0.0):
        """The whole bill: optional pale rim (only where it crosses the bird's own body), the
        shaft, a hairline gape, the barely-there lower mandible, the dark tip, a thin gloss."""
        s = (f'  <!-- bill: one centreline, offset; {self.width(self.root):.1f} px wide where it '
             f'leaves the face, {self.length():.0f} px long -->\n')
        outline = self.band(1, -1, t0, 1.0)
        if halo:
            s += (f'  <path fill="none" stroke="{halo}" stroke-width="2.4" stroke-opacity="0.7" '
                  f'stroke-linejoin="round" d="{outline}"/>\n')
        s += f'  <path fill="url(#{gid})" d="{outline}"/>\n'
        s += f'  <path fill="{BILL_LOW}" opacity="0.55" d="{self.band(-0.35, -1, max(t0, self.root), 0.7)}"/>\n'
        s += (f'  <path fill="none" stroke="{BILL_TIP}" stroke-width="0.7" stroke-opacity="0.6" '
              f'd="{self.line(-0.3, max(t0, self.root), 0.74)}"/>\n')
        s += f'  <path fill="{BILL_TIP}" d="{self.band(1, -1, tip, 1.0)}"/>\n'
        s += f'  <path fill="#ffffff" opacity="0.26" d="{self.band(0.3, 0.8, max(t0, self.root), 0.55)}"/>\n'
        return s


# ------------------------------------------------------------------------------- bird plumbing


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


def egg(cx, cy, rx, ry, front=0.8):
    """A head that is an egg, pointed end forward: the forehead runs down into the bill instead
    of the bill being stuck on a ball."""
    k = 0.5523
    return (f"M{cx:.1f} {cy - ry:.1f} "
            f"C{cx + rx * k * 1.05:.1f} {cy - ry:.1f} {cx + rx:.1f} {cy - ry * k * front:.1f} {cx + rx:.1f} {cy:.1f} "
            f"C{cx + rx:.1f} {cy + ry * k * front:.1f} {cx + rx * k * 1.05:.1f} {cy + ry:.1f} {cx:.1f} {cy + ry:.1f} "
            f"C{cx - rx * k:.1f} {cy + ry:.1f} {cx - rx:.1f} {cy + ry * k:.1f} {cx - rx:.1f} {cy:.1f} "
            f"C{cx - rx:.1f} {cy - ry * k:.1f} {cx - rx * k:.1f} {cy - ry:.1f} {cx:.1f} {cy - ry:.1f} Z")


def outlined(href, fill, w=3.0, op=0.55):
    """A shape with a soft dark rim: the stroke goes under the fill, so half its width shows."""
    return (f'  <use href="#{href}" fill="none" stroke="{RIM}" stroke-width="{w}" '
            f'stroke-opacity="{op}" stroke-linejoin="round"/>\n'
            f'  <use href="#{href}" fill="{fill}"/>\n')


def big_eye(cx, cy, r, look=1):
    """Big and with an opinion: a pale ring, a wide dark iris, two highlights."""
    return (f'    <circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r + 1.5:.1f}" fill="{SUPER}"/>\n'
            f'    <circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="{EYE}"/>\n'
            f'    <circle cx="{cx + r * 0.34 * look:.1f}" cy="{cy - r * 0.36:.1f}" r="{r * 0.36:.1f}" '
            'fill="#ffffff" opacity="0.92"/>\n'
            f'    <circle cx="{cx - r * 0.3 * look:.1f}" cy="{cy + r * 0.36:.1f}" r="{r * 0.15:.1f}" '
            'fill="#ffffff" opacity="0.45"/>\n')


def fillet(bill, cx, cy, rx, ry, t=None, top=0.8):
    """The patch of face between the egg and the bill's root, same gradient as the head, so
    the forehead and the chin run smoothly into the two edges of the bill. `top` is how high
    up the forehead it reaches; on the frontal heads it must stay under the crown or it cuts
    a pale notch into the cap."""
    t = bill.root if t is None else t
    ax, ay = bill.edge(t, 1)
    bx, by = bill.edge(t, -1)
    return (f'  <path fill="url(#buff)" d="M{cx + rx * 0.35:.1f} {cy - ry * top:.1f} '
            f'C{cx + rx * 0.92:.1f} {cy - ry * top * 0.7:.1f} {ax - 5:.1f} {ay - 1.5:.1f} {ax:.1f} {ay:.1f} '
            f'L{bx:.1f} {by:.1f} C{bx - 5:.1f} {by + 1.5:.1f} {cx + rx * 0.92:.1f} {cy + ry * 0.55:.1f} '
            f'{cx + rx * 0.35:.1f} {cy + ry * 0.8:.1f} Z"/>\n')


def profile_head(cx, cy, rx, ry, bill, ex=None, ey=None, er=None, hid="head"):
    """Egg head in profile with the crown, the supercilium, the eye-stripe and one big eye on
    the bill's side."""
    ex = cx + rx * 0.42 if ex is None else ex
    ey = cy - ry * 0.1 if ey is None else ey
    er = ry * 0.32 if er is None else er
    defs = (f'    <path id="{hid}" d="{egg(cx, cy, rx, ry)}"/>\n'
            f'    <clipPath id="{hid}-clip"><use href="#{hid}"/></clipPath>\n')
    body = outlined(hid, "url(#buff)") + fillet(bill, cx, cy, rx, ry)
    body += f'  <g clip-path="url(#{hid}-clip)">\n'
    # the crown: a cap over the top third, its lower edge running from the nape forward to
    # above the eye, where the pale supercilium separates it from the eye-stripe
    body += (f'    <path fill="{CROWN}" d="M{cx - rx - 4:.1f} {cy - ry * 0.25:.1f} '
             f'C{cx - rx * 0.6:.1f} {cy - ry * 1.45:.1f} {cx + rx * 0.7:.1f} {cy - ry * 1.4:.1f} '
             f'{cx + rx + 4:.1f} {cy - ry * 0.5:.1f} '
             f'C{cx + rx * 0.5:.1f} {cy - ry * 0.74:.1f} {cx - rx * 0.4:.1f} {cy - ry * 0.68:.1f} '
             f'{cx - rx - 4:.1f} {cy - ry * 0.25:.1f} Z"/>\n')
    # the supercilium: a pale stripe over the eye only, tapering to nothing at the nape. Run
    # edge to edge at full opacity it read as a bandage round the head.
    body += (f'    <path fill="{SUPER}" opacity="0.55" d="M{cx - rx * 0.7:.1f} {cy - ry * 0.3:.1f} '
             f'C{cx - rx * 0.2:.1f} {cy - ry * 0.62:.1f} {cx + rx * 0.5:.1f} {cy - ry * 0.7:.1f} '
             f'{cx + rx + 4:.1f} {cy - ry * 0.48:.1f} L{cx + rx + 4:.1f} {cy - ry * 0.3:.1f} '
             f'C{cx + rx * 0.5:.1f} {cy - ry * 0.52:.1f} {cx - rx * 0.2:.1f} {cy - ry * 0.48:.1f} '
             f'{cx - rx * 0.7:.1f} {cy - ry * 0.3:.1f} Z"/>\n')
    # the eye-stripe: only the lore, from the bill's root to the eye. Run on through the eye to
    # the nape it joined the supercilium into a headband.
    body += (f'    <path fill="none" stroke="{CROWN}" stroke-width="{ry * 0.1:.1f}" stroke-opacity="0.45" '
             f'stroke-linecap="round" d="M{cx + rx * 0.95:.1f} {cy - ry * 0.02:.1f} '
             f'Q{cx + rx * 0.7:.1f} {cy - ry * 0.1:.1f} {ex + er + 1:.1f} {ey - er * 0.2:.1f}"/>\n')
    body += (f'    <ellipse cx="{cx - rx * 0.2:.0f}" cy="{cy - ry * 0.55:.0f}" rx="{rx * 0.6:.0f}" '
             f'ry="{ry * 0.35:.0f}" fill="url(#gloss)" opacity="0.55"/>\n')
    body += '  </g>\n'
    body += big_eye(ex, ey, er)
    return defs, body


def front_head(cx, cy, r, bill, er, eyes=None, hid="head", stripe=True, look=1):
    """Round head facing the viewer: the cap with the pale median stripe a curlew wears, the
    supercilium over both eyes, two big eyes close to the bill's root."""
    e1, e2 = eyes if eyes else (cx - r * 0.44, cx + r * 0.44)
    ey = cy + r * 0.05
    defs = (f'    <circle id="{hid}" cx="{cx}" cy="{cy}" r="{r}"/>\n'
            f'    <clipPath id="{hid}-clip"><use href="#{hid}"/></clipPath>\n')
    body = outlined(hid, "url(#buff)")
    body += f'  <g clip-path="url(#{hid}-clip)">\n'
    body += (f'    <path fill="{CROWN}" d="M{cx - r - 4:.1f} {cy - r * 0.3:.1f} '
             f'C{cx - r * 0.7:.1f} {cy - r * 1.45:.1f} {cx + r * 0.7:.1f} {cy - r * 1.45:.1f} '
             f'{cx + r + 4:.1f} {cy - r * 0.3:.1f} '
             f'C{cx + r * 0.55:.1f} {cy - r * 0.78:.1f} {cx - r * 0.55:.1f} {cy - r * 0.78:.1f} '
             f'{cx - r - 4:.1f} {cy - r * 0.3:.1f} Z"/>\n')
    if stripe:
        body += (f'    <path fill="{SUPER}" opacity="0.7" d="M{cx - r * 0.07:.1f} {cy - r * 1.1:.1f} '
                 f'H{cx + r * 0.07:.1f} L{cx + r * 0.1:.1f} {cy - r * 0.76:.1f} H{cx - r * 0.1:.1f} Z"/>\n')
    body += (f'    <path fill="{SUPER}" opacity="0.8" d="M{cx - r - 4:.1f} {cy - r * 0.22:.1f} '
             f'C{cx - r * 0.55:.1f} {cy - r * 0.72:.1f} {cx + r * 0.55:.1f} {cy - r * 0.72:.1f} '
             f'{cx + r + 4:.1f} {cy - r * 0.22:.1f} L{cx + r + 4:.1f} {cy - r * 0.02:.1f} '
             f'C{cx + r * 0.55:.1f} {cy - r * 0.5:.1f} {cx - r * 0.55:.1f} {cy - r * 0.5:.1f} '
             f'{cx - r - 4:.1f} {cy - r * 0.02:.1f} Z"/>\n')
    body += (f'    <ellipse cx="{cx - r * 0.15:.0f}" cy="{cy - r * 0.6:.0f}" rx="{r * 0.6:.0f}" '
             f'ry="{r * 0.32:.0f}" fill="url(#gloss)" opacity="0.5"/>\n')
    body += '  </g>\n'
    return defs, body, (e1, e2, ey)


def chunky_body(cx, cy, rx, ry, bid="body", feet=True, dark_feet_x=(0.42, 0.42)):
    defs = (f'    <ellipse id="{bid}" cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}"/>\n'
            f'    <clipPath id="{bid}-clip"><use href="#{bid}"/></clipPath>\n')
    body = ""
    if feet:
        l, r = dark_feet_x
        body += (f'  <g fill="{LEG}">\n'
                 f'    <path d="M{cx - rx * l:.1f} {cy + ry * 0.8:.1f} q-9 3 -10 9 h20 q1 -6 -5 -9 Z"/>\n'
                 f'    <path d="M{cx + rx * r:.1f} {cy + ry * 0.8:.1f} q9 3 10 9 h-20 q-1 -6 5 -9 Z"/>\n'
                 '  </g>\n')
    body += outlined(bid, "url(#wing)")
    # the breast, a lighter inner ellipse; the gloss clipped to the body
    body += (f'  <ellipse cx="{cx + 1}" cy="{cy + 2}" rx="{rx * 0.74:.0f}" ry="{ry * 0.8:.0f}" '
             'fill="url(#breast)"/>\n'
             f'  <g clip-path="url(#{bid}-clip)">\n'
             f'    <ellipse cx="{cx - rx * 0.15:.0f}" cy="{cy - ry * 0.45:.0f}" rx="{rx * 0.8:.0f}" '
             f'ry="{ry * 0.55:.0f}" fill="url(#gloss)"/>\n  </g>\n')
    return defs, body


def write(name, comment, defs, body):
    comment = comment.replace("--", "\u2013")
    svg = (f'<?xml version="1.0" encoding="UTF-8"?>\n<!--\n{comment}\n-->\n'
           '<svg width="128" height="128" viewBox="0 0 128 128" version="1.1"\n'
           '     xmlns="http://www.w3.org/2000/svg">\n'
           f'  <defs>\n{defs}  </defs>\n\n{body}</svg>\n')
    (OUT / f"{name}.svg").write_text(svg)


MEASURE = []


def measure(name, bill, head_d):
    wb = bill.width(bill.root)
    ln = bill.length()
    MEASURE.append((name, head_d, wb, wb / head_d, ln, ln / head_d))


# ================================================================================ the profile bird
#
# Head centre (44,46), an egg 46 x 42. The bill leaves the face at mid height and runs out
# almost level -- the second control point continues the first's direction -- and only the
# last control point pulls it down, so the sickle bends where a real one bends: at the tip.

P_HEAD = (44, 46, 23, 21)
P_BILL = Bill(ctrl=[(60, 47), (88, 50), (105, 57), (108, 86)], w_base=7.6, w_tip=1.2, taper=1.5)
P_D = (P_HEAD[2] + P_HEAD[3])        # mean diameter of the egg


def profile_defs(bill):
    return (grad("buff", 20, 25, 70, 110) + grad("breast", 10, 56, 80, 128)
            + grad("wing", 8, 70, 60, 128, WING) + GLOSS_DEF + bill.grad()
            + '    <path id="breast-shape" d="M28 58 C17 82 13 106 16 128 L74 128 C70 104 66 84 60 58 Z"/>\n'
            + '    <path id="wing-shape" d="M24 82 C14 98 11 112 14 128 L44 128 C39 108 41 94 49 82 '
              'C42 73 30 73 24 82 Z"/>\n')


def profile_bird(bill=P_BILL, scale=1.0, dx=0.0, dy=0.0):
    hdefs, head = profile_head(*P_HEAD, bill)
    g = f'  <g transform="translate({dx},{dy}) translate(64,64) scale({scale}) translate(-64,-64)">\n'
    body = (g + outlined("breast-shape", "url(#breast)") + outlined("wing-shape", "url(#wing)", 2.4, 0.35)
            + bill.draw() + head + "  </g>\n")
    return hdefs, body


# ------------------------------------------------------------------------------------- v1 / v2

hd, bd = profile_bird(scale=0.86, dx=-12, dy=10)
sdefs, sdraw = small_bubble("orange", 0.38, 86.0, 2.0)
write("v1-profile-bubble",
      "V1 -- the bird in profile, where the bill needs no excuse: an egg head lower left, the\n"
      "bill leaving the face level and bending down only in its outer third, the shared bubble\n"
      "shrunk to a badge at the upper right. Bill width at the root: a sixth of the head.",
      profile_defs(P_BILL) + hd + sdefs, sdraw + bd)
measure("v1-profile-bubble", P_BILL, P_D)

hd, bd = profile_bird(scale=1.0)
write("v2-profile-alone",
      "V2 -- V1's bird alone, at full size: the reference drawing of this round's bill.",
      profile_defs(P_BILL) + hd, bd)
measure("v2-profile-alone", P_BILL, P_D)

# ================================================================================ three quarters
#
# Head a circle, both eyes, the near one larger; the bill leaves the right cheek and hangs
# beside the body against the background, where nothing can swallow it.

Q_HEAD = (46, 44, 24)
Q_BODY = (48, 90, 33, 28)
Q_BILL = Bill(ctrl=[(60, 51), (88, 55), (104, 63), (106, 92)], w_base=8.0, w_tip=1.2, taper=1.5)


def quarter_defs(bill):
    return (grad("buff", 22, 20, 70, 68) + grad("breast", 20, 62, 80, 118)
            + grad("wing", 15, 62, 81, 118, WING) + GLOSS_DEF + bill.grad())


def quarter_bird(bill=Q_BILL, scale=1.0, dx=0.0, dy=0.0):
    cx, cy, r = Q_HEAD
    bdefs, body = chunky_body(*Q_BODY)
    hdefs, head, _ = front_head(cx, cy, r, bill, 0, hid="head", stripe=False)
    # the fillet, drawn in circle terms: the cheek runs out into the bill's root
    head += fillet(bill, cx, cy, r, r, top=0.25)
    head += big_eye(cx + r * 0.42, cy + r * 0.08, 8.4) + big_eye(cx - r * 0.5, cy + r * 0.08, 6.4)
    g = f'  <g transform="translate({dx},{dy}) translate(64,64) scale({scale}) translate(-64,-64)">\n'
    return bdefs + hdefs, g + body + bill.draw() + head + "  </g>\n"


hd, bd = quarter_bird(scale=0.88, dx=-8, dy=8)
qdefs, qdraw = small_bubble("orange", 0.36, 88.0, 2.0)
write("v3-quarter-bubble",
      "V3 -- three quarters: a chunky glossy bird with both eyes showing, the near one bigger,\n"
      "the bill leaving the cheek and hanging beside the body on the right. Badge bubble.",
      quarter_defs(Q_BILL) + hd + qdefs, qdraw + bd)
measure("v3-quarter-bubble", Q_BILL, 2 * Q_HEAD[2])

hd, bd = quarter_bird(scale=1.0, dx=0, dy=-2)
write("v4-quarter-alone",
      "V4 -- V3's bird alone, filling the tile.",
      quarter_defs(Q_BILL) + hd, bd)
measure("v4-quarter-alone", Q_BILL, 2 * Q_HEAD[2])

# ====================================================================================== frontal
#
# Square to the viewer, the way Pidgin's pigeon sits. Head-on the bill would foreshorten to a
# dot, so the head is turned a few degrees and the bill drops from under the face, crosses the
# breast and curves down past the body. A pale rim keeps it off the buff.

F_HEAD = (60, 42, 25)
F_BODY = (60, 90, 36, 30)
# The bill leaves under the chin on a diagonal and clears the body's right edge (x=96) before
# it bends down, so the tip hangs against the background. Routed straight down the breast it
# read as a crack in the bird, not as a bill.
F_BILL = Bill(ctrl=[(58, 46), (80, 60), (98, 76), (102, 108)], w_base=8.4, w_tip=1.2, taper=1.5)


def front_defs(bill):
    return (grad("buff", 35, 18, 85, 67) + grad("breast", 30, 62, 92, 120)
            + grad("wing", 24, 62, 96, 120, WING) + GLOSS_DEF + bill.grad())


def front_bird(bill=F_BILL, scale=1.0, dx=0.0, dy=0.0):
    cx, cy, r = F_HEAD
    bdefs, body = chunky_body(*F_BODY)
    hdefs, head, (e1, e2, ey) = front_head(cx, cy, r, bill, 0)
    head += big_eye(e1, ey, 7.6) + big_eye(e2, ey, 7.6)
    g = f'  <g transform="translate({dx},{dy}) translate(64,64) scale({scale}) translate(-64,-64)">\n'
    # the bill goes OVER the head: it starts under the chin, so the root must show
    return bdefs + hdefs, g + body + head + bill.draw(halo=SUPER, t0=bill.root) + "  </g>\n"


hd, bd = front_bird(scale=0.9, dx=-8, dy=6)
fdefs, fdraw = small_bubble("red", 0.36, 88.0, 2.0)
write("v5-front-bubble",
      "V5 -- frontal, the Pidgin layout: the bird square to the viewer with big eyes and the\n"
      "pale median crown stripe, the bill dropping from under the chin and curving down past the\n"
      "breast; the badge bubble in the red of the shipped icon.",
      front_defs(F_BILL) + hd + fdefs, fdraw + bd)
measure("v5-front-bubble", F_BILL, 2 * F_HEAD[2])

# ============================================================ the bubble as the main shape
#
# V6: the shipped icon's layout -- the full-size red bubble as the tile, the head inside it,
# the bill rising out at the top right the way the shipped bill does, but curved.

T_HEAD = (46, 74, 24, 22)
T_BILL = Bill(ctrl=[(62, 68), (88, 58), (108, 48), (124, 62)], w_base=7.6, w_tip=1.2, taper=1.5)
tdefs, tdraw = bubble_block("red")
hdefs, head = profile_head(*T_HEAD, T_BILL, hid="head")
write("v6-in-tile-red",
      "V6 -- continuity with the shipped icon: the full-size shared bubble as the tile, the\n"
      "profile head inside it calling, the bill rising to the top right and breaking out over the\n"
      "bubble's edge with its tip curving down. The breast is clipped to the bubble face.",
      tdefs + grad("buff", 22, 52, 70, 100) + grad("breast", 20, 90, 80, 128)
      + GLOSS_DEF + T_BILL.grad() + hdefs
      + '    <path id="breast-shape" d="M30 86 C22 100 20 114 22 128 L72 128 C70 112 66 100 60 86 Z"/>\n',
      tdraw + '  <g clip-path="url(#face-clip)">\n'
      + outlined("breast-shape", "url(#breast)") + '  </g>\n'
      + T_BILL.draw(halo="#ffffff") + head)
measure("v6-in-tile-red", T_BILL, T_HEAD[2] + T_HEAD[3])

# V7: the bird looking over the rim of a bigger bubble, its bill reaching down across the face.

R_S = 0.78
R_HEAD = (44, 30, 22, 20)
R_BILL = Bill(ctrl=[(60, 32), (86, 35), (103, 42), (107, 70)], w_base=7.2, w_tip=1.2, taper=1.5)
rdefs, rdraw = small_bubble("orange", R_S, 16.0, 44.0)
hdefs, head = profile_head(*R_HEAD, R_BILL, hid="head")
write("v7-peek-rim",
      "V7 -- the bubble is the shape and the bird looks out over its top rim: head and shoulders\n"
      "above the orange bubble, the bill reaching out across its face. Body behind the bubble.",
      grad("buff", 22, 10, 66, 50) + grad("breast", 20, 44, 70, 70) + GLOSS_DEF + R_BILL.grad()
      + rdefs + hdefs
      + '    <path id="breast-shape" d="M28 44 C22 52 20 60 20 70 L70 70 C68 60 64 52 58 44 Z"/>\n',
      outlined("breast-shape", "url(#breast)") + rdraw + R_BILL.draw(halo="#ffffff") + head)
measure("v7-peek-rim", R_BILL, R_HEAD[2] + R_HEAD[3])

# ================================================================================ head and bill
#
# The crop: the head fills the tile and the neck runs off the bottom. The most bill per pixel,
# built for 32 and 16 px: at 16 px the bill is still a one-pixel dark line 12 px long.

C_HEAD = (46, 58, 35, 32)
C_BILL = Bill(ctrl=[(72, 62), (104, 66), (121, 76), (118, 112)], w_base=11.4, w_tip=1.4, taper=1.5)


def crop_defs(bill):
    return (grad("buff", 10, 26, 80, 92) + grad("breast", 10, 84, 80, 128) + GLOSS_DEF + bill.grad()
            + '    <path id="breast-shape" d="M16 84 C10 100 8 116 10 128 L84 128 C82 110 76 96 70 84 Z"/>\n')


def crop_bird(bill=C_BILL):
    hdefs, head = profile_head(*C_HEAD, bill, hid="head")
    return hdefs, outlined("breast-shape", "url(#breast)") + bill.draw() + head


hd, bd = crop_bird()
write("v8-head-crop",
      "V8 -- head and bill only: the egg head fills the tile, the neck runs off the bottom edge,\n"
      "the bill at the largest scale the canvas holds. Built for 32 and 16 px.",
      crop_defs(C_BILL) + hd, bd)
measure("v8-head-crop", C_BILL, C_HEAD[2] + C_HEAD[3])

cdefs, cdraw = small_bubble("orange", 0.32, 90.0, 2.0)
hd, bd = crop_bird()
write("v9-head-crop-bubble",
      "V9 -- V8 with the badge bubble tucked into the corner above the bill.",
      crop_defs(C_BILL) + hd + cdefs, cdraw + bd)
measure("v9-head-crop-bubble", C_BILL, C_HEAD[2] + C_HEAD[3])

# ====================================================================================== symbolic
#
# The head alone, eye punched out, the bill a one-pixel line curving down: GNOME symbolic style,
# a single colour on the 16 px grid, no gradients.

S_BILL = Bill(ctrl=[(8.0, 7.2), (11.8, 7.5), (13.6, 8.4), (14.2, 13.6)], w_base=1.9, w_tip=1.0,
              taper=1.2, root=0.05)
sym = ('<?xml version="1.0" encoding="UTF-8"?>\n'
       '<!--\nSymbolic: the profile head with the eye punched out and the thin downcurved bill.\n'
       'One colour, 16 px grid, no gradients.\n-->\n'
       '<svg width="16" height="16" viewBox="0 0 16 16" version="1.1" xmlns="http://www.w3.org/2000/svg">\n'
       '  <g fill="#2e3436">\n'
       f'    <path fill-rule="evenodd" d="{egg(5.6, 7.4, 4.6, 4.4, 0.7)} '
       'M7.2 6.2 a1.25 1.25 0 1 0 0.01 0 Z"/>\n'
       f'    <path d="M3 11.5 C2.4 12.8 2.2 14.3 2.4 16 H9 C8.8 14.3 8.4 12.8 7.8 11.5 Z"/>\n'
       f'    <path d="{S_BILL.band(1, -1, 0.0, 1.0)}"/>\n'
       '  </g>\n</svg>\n')
(OUT / "symbolic.svg").write_text(sym)

print(f"wrote {len(list(OUT.glob('v*.svg')))} variants + symbolic.svg\n")
print(f"{'variant':24} {'head D':>7} {'bill@root':>10} {'w/D':>6} {'length':>7} {'L/D':>6}")
for name, d, wb, r, ln, lr in MEASURE:
    print(f"{name:24} {d:7.1f} {wb:10.1f} {r:6.3f} {ln:7.1f} {lr:6.2f}")
