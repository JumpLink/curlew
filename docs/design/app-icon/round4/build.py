#!/usr/bin/env python3
"""Round 4: emit every variant SVG from one canonical bubble block.

The bubble is not drawn here, it is traced: face rect x8..120 / y24..108 with r=16 corners, a
wall rect of the same shape 4 px lower so the bubble has a lit side, the swoop tail at the
bottom left and the 2 px lip above it -- the exact geometry Fractal and Flare share. Keeping it
in one string is the only way the six bubble variants stay pixel-identical to each other and to
the two references they have to line up with in a sidebar.
"""
import pathlib

OUT = pathlib.Path(__file__).resolve().parent

HUES = {
    "orange": ("#e66100", "#ff7800", "#ffa348"),
    "red": ("#c01c28", "#e01b24", "#f66151"),
}

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


def buff(x1, y1, x2, y2, name="buff"):
    return f"""    <linearGradient id="{name}" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#f8e8c8"/>
      <stop offset="0.55" stop-color="#e2c091"/>
      <stop offset="1" stop-color="#b0804f"/>
    </linearGradient>
"""


def billgrad(x1, y1, x2, y2, name="bill"):
    return f"""    <linearGradient id="{name}" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#6f4d2e"/>
      <stop offset="0.5" stop-color="#4a3420"/>
      <stop offset="1" stop-color="#332315"/>
    </linearGradient>
"""


def eye(cx, cy, r=6.6):
    return (f'  <circle cx="{cx}" cy="{cy}" r="{r}" fill="#241f31"/>\n'
            f'  <circle cx="{cx + r * 0.33:.1f}" cy="{cy - r * 0.33:.1f}" r="{r * 0.3:.1f}" '
            f'fill="#ffffff" opacity="0.85"/>\n')


def write(name, comment, defs, body):
    # "--" is not allowed inside an XML comment; the en dash reads the same and parses
    comment = comment.replace("--", "\u2013")
    svg = (f'<?xml version="1.0" encoding="UTF-8"?>\n<!--\n{comment}\n-->\n'
           '<svg width="128" height="128" viewBox="0 0 128 128" version="1.1"\n'
           '     xmlns="http://www.w3.org/2000/svg">\n'
           f'  <defs>\n{defs}  </defs>\n\n{body}</svg>\n')
    (OUT / f"{name}.svg").write_text(svg)


def bubble(name, hue, comment, defs, body):
    dark, mid, light = HUES[hue]
    sub = lambda s: s.replace("@DARK@", dark).replace("@MID@", mid).replace("@LIGHT@", light)
    write(name, comment, sub(BUBBLE_DEFS) + defs, sub(BUBBLE_DRAW) + "\n" + body)


# --------------------------------------------------------------------------- portrait (V1, V3)

PORTRAIT_DEFS = (buff(14, 34, 62, 120) + billgrad(70, 48, 120, 104) +
                 '    <ellipse id="head" cx="44" cy="62" rx="32" ry="28"/>\n'
                 '    <clipPath id="head-clip"><use href="#head"/></clipPath>\n')

PORTRAIT_BODY = """  <g clip-path="url(#face-clip)">
    <!-- neck running out of the bubble's bottom edge, so the head reads as a crop not a blob -->
    <path fill="url(#buff)" d="M32 84 C27 96 26 104 27 112 L66 112 C64 102 66 92 72 82 Z"/>
    <g fill="#9a6c42" opacity="0.3">
      <path d="M35 88 l3 1 -4 14 -3 -1 Z"/>
      <path d="M45 89 l3 1 -4 14 -3 -1 Z"/>
      <path d="M55 89 l3 1 -4 14 -3 -1 Z"/>
    </g>

    <use href="#head" fill="url(#buff)"/>
    <g clip-path="url(#head-clip)">
      <!-- dark crown and pale supercilium: the two marks that say curlew -->
      <path fill="#8a5f3a" d="M10 56 C14 40 28 32 45 32 C61 32 72 39 76 50 C56 38 25 41 10 56 Z"/>
      <path fill="#fbf0d8" opacity="0.5" d="M12 61 C29 49 58 49 74 55 L74 59 C56 52 27 55 13 66 Z"/>
    </g>
  </g>

  <!-- the bill leaves the face at eye level and breaks out over the bubble's right edge -->
  <path fill="url(#bill)" d="M58 51 C86 50 109 59 125 81 L120 82 C103 65 83 63 58 63 Z"/>
""" + eye(60, 55)

bubble("v1-bubble-orange", "orange",
       "V1 -- shared GNOME messenger bubble in orange, C3 portrait head, bill breaking out right.",
       PORTRAIT_DEFS, PORTRAIT_BODY)

bubble("v3-bubble-red", "red",
       "V3 -- V1 exactly, in the GNOME red. Same bubble, same bird, different hue only.",
       PORTRAIT_DEFS, PORTRAIT_BODY)

# ------------------------------------------------------------------- head from lower left (V2)

bubble("v2-bubble-lowleft", "orange",
       "V2 -- the head enters from the bubble's lower left corner and the bill sweeps up across\n"
       "the whole face, so the diagonal fills the bubble instead of sitting in the middle of it.",
       buff(6, 52, 70, 124) + billgrad(62, 60, 126, 36) +
       '    <ellipse id="head" cx="40" cy="80" rx="34" ry="29"/>\n'
       '    <clipPath id="head-clip"><use href="#head"/></clipPath>\n',
       """  <g clip-path="url(#face-clip)">
    <path fill="url(#buff)" d="M6 86 C4 106 16 118 36 118 L94 118 C72 110 58 96 58 78 Z"/>
    <g fill="#9a6c42" opacity="0.3">
      <path d="M30 94 l3 1 -3 14 -3 -1 Z"/>
      <path d="M41 97 l3 1 -3 14 -3 -1 Z"/>
      <path d="M52 99 l3 1 -3 13 -3 -1 Z"/>
    </g>

    <use href="#head" fill="url(#buff)"/>
    <g clip-path="url(#head-clip)">
      <path fill="#8a5f3a" d="M4 76 C6 60 20 50 39 50 C56 50 68 57 72 68 C52 56 19 60 4 76 Z"/>
      <path fill="#fbf0d8" opacity="0.5" d="M6 81 C24 69 54 68 70 74 L70 78 C52 71 22 74 7 86 Z"/>
    </g>
  </g>

  <!-- bill leaves at eye level, climbs across the face and decurves over the outer half -->
  <path fill="url(#bill)" d="M60 62 C84 48 104 38 126 33 L127 42 C104 47 84 57 62 74 Z"/>
""" + eye(58, 70))

# ------------------------------------------------------------------- calling inside the bubble
#
# Not a new drawing: the round-3 calling bird, rotated 15 degrees so the long axis of the pose
# matches the long axis of the bubble, and shifted until the head sits low left and the bill
# leaves over the top right. Re-posing it flatter is the only way a tall bird fits a wide bubble
# without being squashed, and the neck has to stay visible or the thrown-back head turns into an
# egg.

CALL_POSE = "translate(22,-18) rotate(15 28 92)"

CALL_DEFS = (buff(10, 40, 74, 124) + billgrad(50, 70, 112, 24) +
             '    <ellipse id="head" cx="28" cy="92" rx="29" ry="25"/>\n'
             '    <clipPath id="head-clip"><use href="#head"/></clipPath>\n')

CALL_INSIDE = '''  <g clip-path="url(#face-clip)">
    <g transform="@POSE@">
      <!-- neck and breast, run well past the clip so the bubble floor never shows a cut edge -->
      <path fill="url(#buff)" d="M4 98 C0 120 8 152 24 152 L150 152 C112 146 62 122 44 92 Z"/>
      <g fill="#9a6c42" opacity="0.3">
        <path d="M18 104 l3 -1 7 22 -3 1 Z"/>
        <path d="M31 110 l3 -2 9 20 -3 1 Z"/>
        <path d="M45 118 l3 -2 10 18 -3 1 Z"/>
      </g>
      <g transform="rotate(-24 28 92)">
        <use href="#head" fill="url(#buff)"/>
        <g clip-path="url(#head-clip)">
          <path fill="#8a5f3a" d="M2 88 C4 74 14 68 28 68 C42 68 52 74 55 84 C38 74 14 76 2 88 Z"/>
          <path fill="#fbf0d8" opacity="0.5" d="M4 94 C18 83 42 83 55 89 L55 93 C40 86 17 88 5 98 Z"/>
        </g>
      </g>
    </g>
  </g>

'''.replace("@POSE@", CALL_POSE)


def call_outside(bill, extra=""):
    # bill and eye ride outside the clip, so the bill may break the bubble's edge
    return ('  <g transform="' + CALL_POSE + '">\n' + bill + extra +
            '    <circle cx="46" cy="84" r="6.6" fill="#241f31"/>\n'
            '    <circle cx="48.2" cy="81.8" r="2" fill="#ffffff" opacity="0.85"/>\n'
            '  </g>\n')


LONG_BILL = ('    <path fill="url(#bill)" '
             'd="M47 68 C59 54 71 42 88 30 C80 42 70 52 55 75 Z"/>\n')

bubble("v4-call-orange", "orange",
       "V4 -- the round-3 calling posture inside the shared bubble: head low left and tipped back,\n"
       "neck filling the floor, bill rising and breaking out over the top right corner.",
       CALL_DEFS, CALL_INSIDE + call_outside(LONG_BILL))

bubble("v5-call-red", "red",
       "V5 -- V4 in the GNOME red.",
       CALL_DEFS, CALL_INSIDE + call_outside(LONG_BILL))

bubble("v6-call-sound", "orange",
       "V6 -- the same call with the bill stopping inside the bubble and two sound arcs off the\n"
       "tip. The arcs are the test: if they mush at 32 px the bill alone has to carry the call.",
       CALL_DEFS,
       CALL_INSIDE + call_outside(
           '    <path fill="url(#bill)" '
           'd="M47 68 C56 59 66 52 80 43 C71 53 64 61 55 75 Z"/>\n',
           ) +
       # the arcs sit in plain canvas coordinates: inside the rotated pose they land off-canvas
       '''  <g fill="none" stroke="#4a3420" stroke-linecap="round" opacity="0.9">
    <path stroke-width="7" d="M114 30 C120 29 124 33 125 39"/>
    <path stroke-width="6" d="M110 17 C120 16 126 22 127 31"/>
  </g>
''')

# ------------------------------------------------------------------------- frontal bird (V7/V8)
#
# Head-on, the one feature that names the species is the hardest to show: a bill pointing at the
# viewer foreshortens to nothing. So the bird stands square but the bill, after leaving the face
# between the eyes, swings down and out until its tip clears the body outline against the
# background -- the sickle reads, and the two eyes keep the frontal pose.

FRONT_DEFS = (buff(34, 24, 96, 112) +
              buff(44, 48, 90, 104, "breast") +
              billgrad(56, 46, 104, 108) +
              """    <linearGradient id="wing" x1="22" y1="52" x2="106" y2="106" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#b98e5c"/>
      <stop offset="0.5" stop-color="#9a6c42"/>
      <stop offset="1" stop-color="#7d5633"/>
    </linearGradient>
""")

FILL = '  <g transform="translate(64,72) scale(1.12) translate(-64,-72)">\n'

LEGS = """  <!-- legs first, so the body sits on top of them -->
  <g stroke="#6f4d2e" stroke-width="4.5" stroke-linecap="round" fill="none">
    <path d="M55 96 V114"/>
    <path d="M75 96 V114"/>
  </g>
  <g stroke="#6f4d2e" stroke-width="3.5" stroke-linecap="round" fill="none">
    <path d="M55 114 L46 121"/>
    <path d="M55 114 L55 122"/>
    <path d="M55 114 L64 121"/>
    <path d="M75 114 L66 121"/>
    <path d="M75 114 L75 122"/>
    <path d="M75 114 L84 121"/>
  </g>
"""

BODY = """  <!-- folded wings: the darker flanks a standing curlew shows either side of the breast -->
  <path fill="url(#wing)" d="M64 48 C92 48 105 68 105 87 C105 100 95 108 80 108 H48
                             C33 108 23 100 23 87 C23 68 36 48 64 48 Z"/>
  <!-- pale streaked breast, narrower than the wings so the flanks stay visible -->
  <path fill="url(#breast)" d="M64 54 C84 54 94 71 94 86 C94 97 86 103 75 103 H53
                               C42 103 34 97 34 86 C34 71 44 54 64 54 Z"/>
  <g fill="#9a6c42" opacity="0.36">
    <path d="M44 70 l3 1 -3 24 -3 -1 Z"/>
    <path d="M54 63 l3 1 -3 34 -3 -1 Z"/>
    <path d="M74 63 l3 1 -2 34 -3 -1 Z"/>
    <path d="M84 70 l3 1 -1 24 -3 -1 Z"/>
  </g>
"""


def front_head(rot, ex1, ex2):
    """The small head that sits clear above the shoulders, optionally turned."""
    g = f'  <g transform="rotate({rot} 64 38)">\n' if rot else "  <g>\n"
    return (g + """    <!-- the same ellipse 3 px lower, as a crescent of shade that lifts the head off the back -->
    <ellipse cx="64" cy="39" rx="23" ry="21" fill="#8a5f3a" opacity="0.4"/>
    <ellipse cx="64" cy="36" rx="23" ry="21" fill="url(#buff)"/>
    <!-- the dark cap and the pale supercilium carry the species when the bill foreshortens -->
    <path fill="#8a5f3a" d="M64 15 C77 15 86 24 87 36 C80 25 72 22 64 22 C56 22 48 25 41 36
                            C42 24 51 15 64 15 Z"/>
    <path fill="#fbf0d8" opacity="0.5" d="M42 39 C47 30 55 26 64 26 C73 26 81 30 86 39
                                          L83 43 C78 35 71 32 64 32 C57 32 50 35 45 43 Z"/>
"""
            + f'    <circle cx="{ex1}" cy="40" r="5.6" fill="#241f31"/>\n'
            + f'    <circle cx="{ex1 + 1.9}" cy="38.1" r="1.8" fill="#ffffff" opacity="0.85"/>\n'
            + f'    <circle cx="{ex2}" cy="40" r="5.6" fill="#241f31"/>\n'
            + f'    <circle cx="{ex2 + 1.9}" cy="38.1" r="1.8" fill="#ffffff" opacity="0.85"/>\n'
            + "  </g>\n")


write("v7-front-straight",
      "V7 -- Pidgin-style frontal curlew, square on: small head clear of the shoulders, both eyes,\n"
      "streaked breast between darker flanks, and the bill running down the breast and swinging\n"
      "out until the tip clears the body against the background, so the decurve still reads.",
      FRONT_DEFS,
      FILL + LEGS + BODY + front_head(0, 54, 74) + """
  <path fill="url(#bill)" d="M60 42 C58 68 63 89 75 99 C83 106 93 110 104 107
                             C96 101 90 96 85 90 C75 77 69 58 67 43 Z"/>
  </g>
""")

write("v8-front-quarter",
      "V8 -- the same bird a few degrees off square: the head turns, the near eye moves out and the\n"
      "bill sweeps further across, which shows more of the curve than the straight-on view does.",
      FRONT_DEFS,
      FILL + LEGS + BODY + front_head(-13, 52, 73) + """
  <path fill="url(#bill)" d="M59 43 C57 65 66 85 81 95 C91 102 103 104 114 100
                             C104 96 95 91 89 85 C77 73 69 57 66 44 Z"/>
  </g>
""")

print("wrote", len(list(OUT.glob("v*.svg"))), "variants")
