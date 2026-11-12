#!/usr/bin/env python3
"""Round 5b: the Adium idea -- a chunky, fluffy, full-body mascot whose bill is the hero shape.

Round 5 took its layout from Pidgin and kept losing the bill: head-on it had nowhere to go but
across the breast, where it reads as a sash. Adium's answer to the same problem is a different
one -- the body is a soft chunky blob with a feathered fringe, and the BILL is the one big,
glossy, saturated shape on it. So here the head is turned about 30 degrees, the bill leaves the
face SIDEWAYS and the whole sickle hangs beside the body against the background, where nothing
can swallow it.

Only the idea is taken: fringe, chunk, big eyes, bill as hero. The drawing and the palette are
the curlew's own.

The bill machinery, the palette, the shared Fractal/Flare bubble and `write` all come from
build5; importing it re-emits v1-v9 unchanged, which is wanted -- one command builds the folder.
"""
import math

from build5 import (BILL_LOW, BILL_TIP, BUFF, CROWN, EYE, GLOSS_DEF, SUPER, WING,
                    Bill, buff, bubble_block, small_bubble, write)

# --------------------------------------------------------------------------------- the fringe
#
# A fluffy silhouette is an outline whose every segment bulges outward and leans the same way,
# so the eye reads the bumps as feather tips lying over each other rather than as a cloud. One
# cubic per segment: the first control point is pushed far out, the second barely, which puts
# the peak of each bump near its start and lets it fall back into the next feather.


def _rand(i, seed):
    """Deterministic jitter in 0..1 -- the fringe has to be identical on every build."""
    return (math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453) % 1.0


def fluff(cx, cy, rx, ry, n=20, amp=3.6, lean=0.55, jitter=0.5, seed=1.0, rot=0.0):
    """Closed path around an ellipse, every segment a feather tip leaning clockwise."""
    pts = []
    for i in range(n):
        a = rot + 2 * math.pi * i / n
        pts.append((cx + rx * math.cos(a), cy + ry * math.sin(a), a))
    d = f"M{pts[0][0]:.2f} {pts[0][1]:.2f}"
    for i in range(n):
        x0, y0, a0 = pts[i]
        x1, y1, a1 = pts[(i + 1) % n]
        # how far this feather sticks out; jitter keeps the fringe from looking machined
        e = amp * (1.0 - jitter * 0.5 + jitter * _rand(i, seed))
        # outward normals at both ends of the segment, scaled by the ellipse's own proportions
        n0 = (math.cos(a0) * (rx + e) / rx, math.sin(a0) * (ry + e) / ry)
        n1 = (math.cos(a1) * (rx + e) / rx, math.sin(a1) * (ry + e) / ry)
        c1 = (x0 + n0[0] * e * 1.9, y0 + n0[1] * e * 1.9)
        c2 = (x1 + n1[0] * e * lean, y1 + n1[1] * e * lean)
        d += (f" C{c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {x1:.2f} {y1:.2f}")
    return d + " Z"


def scallops(rows, color="#b08a5e", op=0.33, w=1.7):
    """Rows of shallow U curves: breast feathering, the flat way an icon can carry texture."""
    s = f'  <g fill="none" stroke="{color}" stroke-opacity="{op}" stroke-width="{w}" stroke-linecap="round">\n'
    for x, y, span, depth, count, step in rows:
        for k in range(count):
            px = x + k * span
            s += f'    <path d="M{px:.1f} {y:.1f} q{span / 2:.1f} {depth:.1f} {span:.1f} 0"/>\n'
        y += step
    return s + "  </g>\n"


def big_eye(cx, cy, r=7.4, brow=False, look=1):
    """Adium's eyes are big and have an opinion; here that is a pale ring, a wide dark iris
    offset in the direction of the turn, and two highlights. The attitude comes from the eye
    itself -- drawn brows on top of the dark crown turned the bird into a grumpy man in a wig."""
    s = (f'    <circle cx="{cx}" cy="{cy}" r="{r + 1.6:.1f}" fill="{SUPER}" opacity="0.85"/>\n'
         f'    <circle cx="{cx}" cy="{cy}" r="{r}" fill="{EYE}"/>\n'
         f'    <circle cx="{cx + r * 0.33 * look:.1f}" cy="{cy - r * 0.36:.1f}" r="{r * 0.34:.1f}" '
         'fill="#ffffff" opacity="0.92"/>\n'
         f'    <circle cx="{cx - r * 0.30 * look:.1f}" cy="{cy + r * 0.34:.1f}" r="{r * 0.16:.1f}" '
         'fill="#ffffff" opacity="0.45"/>\n')
    if brow:
        s += (f'    <path fill="none" stroke="{CROWN}" stroke-width="{r * 0.42:.1f}" '
              f'stroke-linecap="round" d="M{cx - r * 0.95:.1f} {cy - r * 1.5:.1f} '
              f'Q{cx:.1f} {cy - r * 2.0:.1f} {cx + r * 0.95:.1f} {cy - r * 1.35:.1f}"/>\n')
    return s


# ------------------------------------------------------------------------------ the hero bill
#
# Adium's beak is the one big saturated shape on the bird: a single broad form, a hard highlight
# along its top, a paler lower mandible, a dark tip. Built from the same centreline bands as
# round 5 so the parts still cannot drift, only painted louder.


def hero_grad(bill, gid="bill", warm=False):
    (x0, y0) = bill.edge(0.0, 1.0)
    (x1, y1) = bill.edge(1.0, -1.0)
    ramp = ("#8a6038", "#5a3f26", "#2f2010") if not warm else ("#c98a3e", "#8a5a2a", "#3a2612")
    return (f'    <linearGradient id="{gid}" x1="{x0:.1f}" y1="{y0:.1f}" x2="{x1:.1f}" y2="{y1:.1f}" '
            'gradientUnits="userSpaceOnUse">\n'
            f'      <stop offset="0" stop-color="{ramp[0]}"/>\n'
            f'      <stop offset="0.5" stop-color="{ramp[1]}"/>\n'
            f'      <stop offset="1" stop-color="{ramp[2]}"/>\n'
            '    </linearGradient>\n')


def hero_bill(bill, gid="bill", rim=True, tip=0.76, t0=0.0):
    """Thick and glossy: a pale rim so it never merges with the bird, a hard highlight band
    along the upper mandible, a wide pale lower mandible, a dark tip.

    `t0` cuts the root off, for the tile variant where the same bill is drawn twice: once under
    the head inside the clip, once over the tile's edge outside it.
    """
    outline = bill.band(1, -1, t0, 1.0)
    s = '  <!-- the hero bill: one centreline, offset; rim, gloss, lower mandible and tip are bands of it -->\n'
    if rim:
        s += (f'  <path fill="none" stroke="{SUPER}" stroke-width="2.6" stroke-opacity="0.55" '
              f'stroke-linejoin="round" d="{outline}"/>\n')
    s += f'  <path fill="url(#{gid})" d="{outline}"/>\n'
    s += f'  <path fill="{BILL_LOW}" opacity="0.85" d="{bill.band(-0.25, -1, max(t0, 0.04), 0.74)}"/>\n'
    s += f'  <path fill="{BILL_TIP}" d="{bill.band(1, -1, tip, 1.0)}"/>\n'
    # the hard highlight: a narrow band just under the upper edge, fading out before the tip
    s += f'  <path fill="#ffffff" opacity="0.38" d="{bill.band(0.52, 0.92, max(t0, 0.05), 0.46)}"/>\n'
    s += f'  <path fill="#ffffff" opacity="0.16" d="{bill.band(0.20, 0.60, max(t0, 0.40), 0.68)}"/>\n'
    return s


# ------------------------------------------------------------------------- the chunky fluff bird
#
# Body and head are two fluff ellipses that overlap, the way Adium's mascot has no neck to speak
# of: the silhouette is one soft mass and the bill is the only hard shape on it.

FEET = """  <g fill="#8d94a0">
    <path d="M38 112 q-9 2 -11 8 h22 q1 -6 -5 -8 Z"/>
    <path d="M62 112 q9 2 11 8 h-22 q-1 -6 5 -8 Z"/>
  </g>
"""


def fluff_defs(bill, body=(50, 86, 36, 31), head=(48, 42, 27, 25)):
    bx, by, brx, bry = body
    hx, hy, hrx, hry = head
    return (buff(bx - brx, by - bry, bx + brx, by + bry)
            + buff(bx - brx * 0.6, by - bry * 0.8, bx + brx * 0.8, by + bry, "breast")
            + buff(bx - brx, by, bx + brx, by + bry, "wing", WING)
            + GLOSS_DEF
            + f'    <path id="bodyfluff" d="{fluff(bx, by, brx, bry, 22, 3.8, seed=2.0)}"/>\n'
            # a finer fringe on the head than on the body: at 3.4 px the dark crown's own clipped
            # edge turned into curls and the bird wore a wig
            + f'    <path id="headfluff" d="{fluff(hx, hy, hrx, hry, 20, 2.4, seed=5.0, rot=0.3)}"/>\n'
            + '    <clipPath id="body-clip"><use href="#bodyfluff"/></clipPath>\n'
            + '    <clipPath id="head-clip"><use href="#headfluff"/></clipPath>\n')


def fluff_body(body=(50, 86, 36, 31), feet=True):
    bx, by, brx, bry = body
    s = FEET if feet else ""
    s += '  <!-- the chunky body: one fluffed mass, the wing only a shade under the breast -->\n'
    s += '  <use href="#bodyfluff" fill="url(#wing)"/>\n'
    s += (f'  <path fill="url(#breast)" d="'
          f'{fluff(bx + 1, by + 2, brx * 0.78, bry * 0.82, 18, 2.6, seed=9.0, rot=0.6)}"/>\n')
    s += scallops([(bx - 24, by - 14, 11, 5.5, 5, 0), (bx - 19, by - 3, 11, 5.5, 4, 0),
                   (bx - 24, by + 8, 11, 5.5, 5, 0), (bx - 19, by + 19, 11, 5.5, 4, 0)])
    s += ('  <g clip-path="url(#body-clip)">\n'
          f'    <ellipse cx="{bx - 6}" cy="{by - 14}" rx="{brx * 0.8:.0f}" ry="{bry * 0.6:.0f}" '
          'fill="url(#gloss)"/>\n  </g>\n')
    return s


def fluff_head(head=(48, 42, 27, 25), e1=36, e2=60, ey=42, er=7.4, turn=0.0, look=1):
    hx, hy, hrx, hry = head
    s = f'  <g transform="rotate({turn} {hx} {hy})">\n'
    s += '  <use href="#headfluff" fill="url(#buff)"/>\n'
    s += '  <g clip-path="url(#head-clip)">\n'
    # The dark crown: a CAP over the top third. The first version ran down the sides to eye
    # level and the fringe turned it into a head of curly hair.
    s += (f'    <path fill="{CROWN}" d="M{hx - hrx - 6:.1f} {hy - hry * 0.50:.1f} '
          f'C{hx - hrx * 0.9:.1f} {hy - hry * 1.5:.1f} {hx + hrx * 0.9:.1f} {hy - hry * 1.5:.1f} '
          f'{hx + hrx + 6:.1f} {hy - hry * 0.55:.1f} '
          f'C{hx + hrx * 0.55:.1f} {hy - hry * 0.92:.1f} {hx - hrx * 0.55:.1f} {hy - hry * 0.92:.1f} '
          f'{hx - hrx - 6:.1f} {hy - hry * 0.50:.1f} Z"/>\n')
    # the pale supercilium under it, the band a curlew wears over both eyes
    s += (f'    <path fill="{SUPER}" opacity="0.65" d="M{hx - hrx - 5:.1f} {hy - hry * 0.42:.1f} '
          f'C{hx - hrx * 0.55:.1f} {hy - hry * 0.84:.1f} {hx + hrx * 0.55:.1f} {hy - hry * 0.84:.1f} '
          f'{hx + hrx + 5:.1f} {hy - hry * 0.47:.1f} L{hx + hrx + 5:.1f} {hy - hry * 0.27:.1f} '
          f'C{hx + hrx * 0.55:.1f} {hy - hry * 0.64:.1f} {hx - hrx * 0.55:.1f} {hy - hry * 0.64:.1f} '
          f'{hx - hrx - 5:.1f} {hy - hry * 0.22:.1f} Z"/>\n')
    s += (f'    <ellipse cx="{hx - 5}" cy="{hy - hry * 0.52:.0f}" rx="{hrx * 0.62:.0f}" '
          f'ry="{hry * 0.40:.0f}" fill="url(#gloss)" opacity="0.5"/>\n')
    s += '  </g>\n'
    s += big_eye(e1, ey, er, look=look)
    if e2 is not None:
        s += big_eye(e2, ey, er, look=look)
    return s + "  </g>\n"


def group(scale=1.0, dx=0.0, dy=0.0, cx=64.0, cy=64.0):
    return (f'  <g transform="translate({dx},{dy}) translate({cx},{cy}) '
            f'scale({scale}) translate({-cx},{-cy})">\n')


# ===================================================================================== variants

BODY = (50, 86, 35, 30)
HEAD = (47, 43, 27, 25)

# The eyes sit on the BILL's side of the head, not opposite it: with both eyes pushed away from
# the bill the face reads as turned away from it and the sickle becomes a handle stuck on the
# back of the skull. The first control point is pulled far to the RIGHT so the bill
# leaves the cheek nearly horizontal and only decurves out past the body -- a centreline that
# starts bending at the head makes a droopy handle hanging off the jaw, not a curlew. The whole
# sickle then stands against the background, which is the one thing round 5's frontal bird
# could not manage.
SICKLE = Bill(ctrl=[(46, 54), (106, 58), (118, 82), (98, 108)], w_base=12.5, w_tip=1.9, taper=2.0)


def fluff_bird(bill, scale=1.0, dx=0.0, dy=0.0, feet=True, turn=0.0, hero=False,
               body=BODY, head=HEAD, eyes=(42, 61, 47, 7.2)):
    e1, e2, ey, er = eyes
    # The centreline STARTS deep inside the skull and the head is painted over it, so what the
    # eye sees is a bill growing out of the lower cheek. Drawn on top of the head instead, its
    # squared-off root sat on the face like a pipe pushed into it.
    draw = (bill.draw("bill", halo=SUPER) if not hero else hero_bill(bill)) if bill else ""
    return (group(scale, dx, dy) + fluff_body(body, feet) + draw
            + fluff_head(head, e1, e2, ey, er, turn) + "  </g>\n")


# ------------------------------------------------- 10/11 the frontal bird, bill out to the side

write("v10-front-fluff-sickle",
      "V10 -- the Adium idea in curlew: a chunky bird with a feathered fringe, big eyes, and the\n"
      "head turned far enough that the bill leaves the face sideways instead of pointing at the\n"
      "viewer. The whole sickle hangs beside the body against the background, so nothing on the\n"
      "bird can swallow it; the breast carries feather scallops instead of straight streaks.",
      fluff_defs(SICKLE) + SICKLE.grad("bill"),
      fluff_bird(SICKLE))

bdefs, bdraw = small_bubble("orange", 0.36, 86.0, 2.0)
write("v11-front-fluff-bubble",
      "V11 -- V10 with the shared Fractal/Flare bubble shrunk to a badge at the upper right, its\n"
      "tail pointing back at the bird. The bird drops a little left so the bill clears the badge.",
      fluff_defs(SICKLE) + SICKLE.grad("bill") + bdefs,
      bdraw + fluff_bird(SICKLE, scale=0.88, dx=-6, dy=7))

# --------------------------------------------- 12/13 three-quarter: the longest sickle of the set

Q_BODY = (44, 88, 32, 29)
Q_HEAD = (42, 44, 25, 24)
Q_SICKLE = Bill(ctrl=[(40, 54), (104, 56), (120, 80), (100, 110)], w_base=13.0, w_tip=1.9, taper=2.0)

write("v12-quarter-fluff-nobubble",
      "V12 -- the same fluffed bird turned to three quarters: one eye only, the body narrower, and\n"
      "the bill given the whole diagonal of the canvas. The most bill the tile can hold.",
      fluff_defs(Q_SICKLE, Q_BODY, Q_HEAD) + Q_SICKLE.grad("bill"),
      fluff_bird(Q_SICKLE, body=Q_BODY, head=Q_HEAD, eyes=(52, None, 46, 8.4)))

q2defs, q2draw = small_bubble("orange", 0.34, 90.0, 2.0)
write("v13-quarter-fluff-bubble",
      "V13 -- V12 with the badge bubble, kept small and tight into the corner because the bill is\n"
      "already using the diagonal.",
      fluff_defs(Q_SICKLE, Q_BODY, Q_HEAD) + Q_SICKLE.grad("bill") + q2defs,
      q2draw + fluff_bird(Q_SICKLE, body=Q_BODY, head=Q_HEAD, eyes=(52, None, 46, 8.4),
                          scale=0.86, dx=-8, dy=8))

# ------------------------------------------------------------------- 14 the bill painted loudest

HERO = Bill(ctrl=[(44, 54), (108, 58), (122, 82), (100, 114)], w_base=15.5, w_tip=2.2, taper=2.2)
write("v14-front-hero-bill",
      "V14 -- V10 with the bill painted the way Adium paints its beak: thicker than life, a pale\n"
      "rim so it never merges with the bird, a hard highlight along the upper mandible, a wide\n"
      "pale lower mandible and a dark tip. Longer than a real curlew's, on purpose: at 32 px the\n"
      "only question is whether the sickle is still a sickle.",
      fluff_defs(HERO) + hero_grad(HERO),
      fluff_bird(HERO, hero=True))

# ------------------------------------------------- 15 head, neck and chest cropped into the tile

C_BODY = (48, 118, 48, 40)
C_HEAD = (44, 48, 38, 35)
C_BILL = Bill(ctrl=[(46, 60), (116, 62), (134, 90), (106, 124)], w_base=17.0, w_tip=2.6, taper=2.2)
write("v15-head-crop-arc",
      "V15 -- the crop: head, neck and chest fill the tile and run off the bottom edge, so the bill\n"
      "is drawn at the largest scale the canvas allows and arcs out and down across the corner.\n"
      "Maximum bill per pixel -- this is the one built for 32 px.",
      fluff_defs(C_BILL, C_BODY, C_HEAD) + hero_grad(C_BILL),
      fluff_bird(C_BILL, body=C_BODY, head=C_HEAD, eyes=(38, 70, 52, 10.0), feet=False, hero=True))

# ------------------------------------------- 16 the fluffed head on the shipped icon's red tile

T_BODY = (52, 108, 36, 30)
T_HEAD = (48, 58, 28, 26)
T_BILL = Bill(ctrl=[(46, 68), (102, 70), (118, 92), (102, 120)], w_base=13.0, w_tip=1.9, taper=2.0)
tdefs, tdraw = bubble_block("red")
write("v16-head-in-tile-red",
      "V16 -- continuity with the shipped icon: the full-size shared bubble as the tile, the new\n"
      "fluffed head and chest clipped into it, and the bill -- drawn outside the clip -- breaking\n"
      "out over the right edge, which is what keeps the sickle readable inside a filled tile.",
      tdefs + fluff_defs(T_BILL, T_BODY, T_HEAD) + hero_grad(T_BILL),
      tdraw + '  <g clip-path="url(#face-clip)">\n'
      + fluff_body(T_BODY, feet=False) + hero_bill(T_BILL)
      + fluff_head(T_HEAD, 43, 61, 61, 7.0) + '  </g>\n'
      # the same bill once more, outside the clip, from halfway out: identical geometry, so the
      # two halves join invisibly and the sickle carries on past the tile's edge
      + hero_bill(T_BILL, t0=0.5))

print("round 5b: wrote 7 variants")
