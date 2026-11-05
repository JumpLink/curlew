#!/bin/zsh
# Round 4 preview. Renders every v*.svg at 128/64/32/16 on light and dark, one contact sheet per
# variant beside the four GNOME messengers, a reference row that puts Fractal and Flare at 128 px
# next to the bubble variants, and a strip of the symbolics.
set -e
setopt null_glob   # zsh aborts on an unmatched glob; the cleanup below runs on an empty dir too
cd "${0:A:h}"
REF=/tmp/icontest
L='#f6f5f4'
D='#241f31'

rm -f overview.png symbolic-strip.png sheet-*.png
mkdir -p .t && rm -f .t/*.png

# ---------------------------------------------------------------- overview: every variant, both themes
i=0
rows=()
for f in v*.svg; do
  i=$((i+1))
  n=${f%.svg}
  for bg mode in $L light $D dark; do
    magick montage -background $bg -tile 4x1 -gravity center -geometry 128x128+5+5 \
      \( $f -background $bg -resize 128x128 \) \
      \( $f -background $bg -resize 64x64 \) \
      \( $f -background $bg -resize 32x32 \) \
      \( $f -background $bg -resize 16x16 \) \
      .t/$mode-$n.png
  done
  magick -background '#ffffff' -fill '#241f31' -pointsize 17 \
    label:"$i  $n" +set label -gravity west -extent 300x28 .t/cap-$n.png
  magick montage -background '#ffffff' -tile 3x1 -gravity center -geometry +6+0 \
    .t/cap-$n.png .t/light-$n.png .t/dark-$n.png .t/row-$n.png
  rows+=(.t/row-$n.png)
done

# ---------------------------------------------- reference row: the two bubbles we had to match, at 128
magick -background '#ffffff' -fill '#241f31' -pointsize 17 \
  label:"ref  Fractal / Flare vs the bubble variants" +set label -gravity west -extent 300x28 .t/cap-ref.png
bubbles=()
for f in v*.svg; do
  case $f in *front*) continue;; esac
  bubbles+=(\( $f -background $L -resize 128x128 \))
done
magick montage -background $L -tile 8x1 -gravity center -geometry 128x128+5+5 \
  \( $REF/ref-org.gnome.Fractal.svg -background $L -resize 128x128 \) \
  \( $REF/ref-de.schmidhuberj.Flare.svg -background $L -resize 128x128 \) \
  "${bubbles[@]}" .t/refrow.png
magick montage -background '#ffffff' -tile 2x1 -gravity center -geometry +6+0 \
  .t/cap-ref.png .t/refrow.png .t/row-zz-ref.png

magick montage -background '#ffffff' -tile 1x -gravity west -geometry +8+4 \
  "${rows[@]}" .t/row-zz-ref.png overview.png

# ------------------------------------------------------- contact sheets: variant beside the neighbours
for f in v*.svg; do
  n=${f%.svg}
  magick montage -background $L -tile 5x1 -gravity center -geometry 128x128+6+6 \
    \( $f -background $L -resize 128x128 \) \
    \( $REF/ref-org.gnome.Fractal.svg -background $L -resize 128x128 \) \
    \( $REF/ref-de.schmidhuberj.Flare.svg -background $L -resize 128x128 \) \
    \( $REF/ref-im.dino.Dino.svg -background $L -resize 128x128 \) \
    \( $REF/ref-dev.geopjr.Tuba.svg -background $L -resize 128x128 \) .t/sheet-top.png
  magick montage -background $L -tile 5x1 -gravity center -geometry 48x48+6+6 \
    \( $f -background $L -resize 48x48 \) \
    \( $REF/ref-org.gnome.Fractal.svg -background $L -resize 48x48 \) \
    \( $REF/ref-de.schmidhuberj.Flare.svg -background $L -resize 48x48 \) \
    \( $REF/ref-im.dino.Dino.svg -background $L -resize 48x48 \) \
    \( $REF/ref-dev.geopjr.Tuba.svg -background $L -resize 48x48 \) .t/sheet-mid.png
  magick montage -background $D -tile 5x1 -gravity center -geometry 32x32+6+6 \
    \( $f -background $D -resize 32x32 \) \
    \( $REF/ref-org.gnome.Fractal.svg -background $D -resize 32x32 \) \
    \( $REF/ref-de.schmidhuberj.Flare.svg -background $D -resize 32x32 \) \
    \( $REF/ref-im.dino.Dino.svg -background $D -resize 32x32 \) \
    \( $REF/ref-dev.geopjr.Tuba.svg -background $D -resize 32x32 \) .t/sheet-bot.png
  magick montage -background '#ffffff' -tile 1x -gravity center -geometry +6+4 \
    .t/sheet-top.png .t/sheet-mid.png .t/sheet-bot.png sheet-$n.png
done

# ------------------------------------------------------------------------------- symbolic strip
syms=()
for f in sym-*.svg; do
  n=${f%.svg}
  magick montage -background '#ffffff' -tile 4x1 -gravity center -geometry 96x96+6+6 \
    \( $f -background '#ffffff' -resize 96x96 \) \
    \( $f -background '#ffffff' -resize 32x32 \) \
    \( $f -background '#ffffff' -resize 24x24 \) \
    \( $f -background '#ffffff' -resize 16x16 \) .t/s-$n.png
  magick -background '#ffffff' -fill '#241f31' -pointsize 17 \
    label:"$n" +set label -gravity west -extent 140x28 .t/scap-$n.png
  magick montage -background '#ffffff' -tile 2x1 -gravity center -geometry +6+0 \
    .t/scap-$n.png .t/s-$n.png .t/srow-$n.png
  syms+=(.t/srow-$n.png)
done
magick montage -background '#ffffff' -tile 1x -gravity west -geometry +8+4 "${syms[@]}" symbolic-strip.png

echo "overview.png $(magick identify -format '%wx%h' overview.png)"
ls sheet-*.png symbolic-strip.png
