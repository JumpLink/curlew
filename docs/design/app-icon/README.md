# App icon — how it came about

The icon follows the [GNOME HIG for app icons](https://developer.gnome.org/hig/guidelines/app-icons.html):
GNOME palette, 128 px canvas, recognisable at 32 and 16 px, a matching symbolic icon. Every round
is hand-written SVG, rendered with `rsvg-convert` and compared beside Fractal, Flare, Dino and
Tuba. This folder keeps each round's overview, the contact sheets and the source SVGs, so the
decisions can be followed later.

The name: the curlew (*Numenius arquata*) follows the bird-named multi-messengers Pidgin and
Adium. Its one feature everybody recognises is the long, downcurved bill.

## Round 1 — two colour variants

![Variant A beside GNOME apps](round1/variant-a-contact-sheet.png)
![Variant B beside GNOME apps](round1/variant-b-contact-sheet.png)

- **A, natural** (`round1/eu.jumplink.curlew-variant-a.svg`): a curlew wading in a tide pool, real
  plumage colours.
- **B, colourful** (`round1/eu.jumplink.curlew-variant-b.svg`): the same bird as a flat orange
  graphic.
- Symbolic: `round1/symbolic-strip.png`.

Feedback: the bird was too small next to icons that fill the canvas; the posture was hunched with
short legs, where a real curlew stands upright on long legs; the plumage was flat; the symbolic
read as a hook, not a bird. Asked for: new concepts that differ in composition and view, not only
in colour — including ones that carry the messenger idea (the call, speech bubbles).

## Round 2 — eight concepts

![Round 2 overview](round2/overview.png)

| # | File | Idea |
|---|---|---|
| 1 | `c1-standing.svg` | whole bird standing on a mudflat, side view |
| 2 | `c2-probing.svg` | the bird probing the sand with its bill |
| 3 | `c3-portrait.svg` | head and neck, the bill as the dominant diagonal |
| 4 | `c4-bubble.svg`, `c4b-bubble-c.svg` | the head on a speech bubble, sand / orange |
| 5 | `c5-call.svg`, `c5b-call-bub.svg` | the call: sound arcs / a bubble from the bill |
| 6 | `c6-bubbles.svg`, `c6b-bubbles-c.svg` | three bubbles for the combined networks |
| 7 | `c7-dusk.svg` | silhouette against a dusk disc |
| 8 | `c8-bill-tail.svg` | bubble and bird in one shape |

Strongest: 3 as the bird, 4b as the messenger icon (contact sheets in `round2/`). Symbolic:
`sym-head.svg` (head with eye) clearly beat `sym-bubble.svg` (`round2/symbolic-strip.png`).

Feedback: combine them — the light, streaked head of 3 on the orange bubble of 4b, since 4b's
dark silhouette read as a penguin or an ibis. Also keep the calling idea of 5 and 6 with the bill
held up, but with a larger head and one natural curve of neck and bill instead of a kink, and
fewer, larger bubbles so it stays calm at 32 px.

## Round 3

In progress: combinations of 3 and 4b, and calling variants with the bill up.
