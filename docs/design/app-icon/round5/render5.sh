#!/bin/zsh
# Round 5 preview. Renders every v*.svg at 128/64/32/16 on light and dark into overview.png, and
# a second sheet at 256 px so the one thing this round is about -- the bill -- can be judged.
#
# rsvg-convert is not installed here; ImageMagick's own SVG renderer draws the gradients, the
# clip paths and the <use> references in these files correctly (checked against round 4's
# output), so `magick` does both the rasterising and the montage.
set -e
setopt null_glob          # zsh aborts on an unmatched glob; the cleanup below runs on an empty dir too
setopt numeric_glob_sort  # or round 5b's v10..v16 would sort in between v1 and v2
cd "${0:A:h}"
REF=/tmp/icontest  # the four GNOME messengers, if they have been fetched; skipped when absent
L='#f6f5f4'
D='#241f31'

rm -f overview.png details.png
mkdir -p .t && rm -f .t/*.png

# ------------------------------------------------- overview: every variant, four sizes, both themes
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
    label:"$i  $n" +set label -gravity west -extent 320x28 .t/cap-$n.png
  magick montage -background '#ffffff' -tile 3x1 -gravity center -geometry +6+0 \
    .t/cap-$n.png .t/light-$n.png .t/dark-$n.png .t/row-$n.png
  rows+=(.t/row-$n.png)
done

# ------------------------------------- reference row: the bubbles we line up with, when available
if [[ -d $REF ]]; then
  magick -background '#ffffff' -fill '#241f31' -pointsize 17 \
    label:"ref  Fractal / Flare" +set label -gravity west -extent 320x28 .t/cap-ref.png
  magick montage -background $L -tile 4x1 -gravity center -geometry 128x128+5+5 \
    \( $REF/ref-org.gnome.Fractal.svg -background $L -resize 128x128 \) \
    \( $REF/ref-de.schmidhuberj.Flare.svg -background $L -resize 128x128 \) \
    \( v1-front-bubble.svg -background $L -resize 128x128 \) \
    \( v9-front-in-tile-red.svg -background $L -resize 128x128 \) .t/refrow.png
  magick montage -background '#ffffff' -tile 2x1 -gravity center -geometry +6+0 \
    .t/cap-ref.png .t/refrow.png .t/row-zz-ref.png
fi

magick montage -background '#ffffff' -tile 1x -gravity west -geometry +8+4 \
  "${rows[@]}" .t/row-zz-ref.png(N) overview.png

# --------------------------------------------------- details: 256 px, where the bill is readable
dets=()
for f in v*.svg; do
  n=${f%.svg}
  magick -background $L $f -resize 256x256 -bordercolor $L -border 6 .t/big-$n.png
  magick -background '#ffffff' -fill '#241f31' -pointsize 15 \
    label:"$n" +set label -gravity center -extent 268x24 .t/bcap-$n.png
  magick montage -background '#ffffff' -tile 1x2 -gravity center -geometry +0+0 \
    .t/big-$n.png .t/bcap-$n.png .t/det-$n.png
  dets+=(.t/det-$n.png)
done
magick montage -background '#ffffff' -tile 3x -gravity center -geometry +8+8 "${dets[@]}" details.png

rm -rf .t
echo "overview.png $(magick identify -format '%wx%h' overview.png)"
echo "details.png  $(magick identify -format '%wx%h' details.png)"
