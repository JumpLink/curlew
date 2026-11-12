#!/bin/zsh
# Round 7 preview. Renders every v*.svg at 128/64/48/32/16 on light and dark into overview.png,
# a second sheet at 256 px (details.png) so the bill can be judged, and symbolic.svg at 16/32 px
# on both themes into symbolic-strip.png.
#
# rsvg-convert is not installed here; ImageMagick's own SVG renderer handles the gradients,
# clip paths and <use> references in these files, so `magick` does the rasterising and the montage.
set -e
setopt null_glob
setopt numeric_glob_sort
cd "${0:A:h}"
L='#f6f5f4'
D='#241f31'

rm -f overview.png details.png symbolic-strip.png
mkdir -p .t && rm -f .t/*.png

# ------------------------------------------------ overview: every variant, five sizes, both themes
i=0
rows=()
for f in v*.svg; do
  i=$((i+1))
  n=${f%.svg}
  for bg mode in $L light $D dark; do
    magick montage -background $bg -tile 5x1 -gravity center -geometry 128x128+4+4 \
      \( $f -background $bg -resize 128x128 \) \
      \( $f -background $bg -resize 64x64 \) \
      \( $f -background $bg -resize 48x48 \) \
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
magick montage -background '#ffffff' -tile 1x -gravity west -geometry +8+4 "${rows[@]}" overview.png

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

# ------------------------------------------------------- symbolic: 16 and 32 px, light and dark
# montage has no -opaque, so the dark-theme recolour is done by magick on each tile first
magick -background $L symbolic.svg -resize 16x16 -scale 400% .t/sym-l16.png
magick -background $L symbolic.svg -resize 32x32 -scale 200% .t/sym-l32.png
magick -background none symbolic.svg -resize 16x16 -fill '#ffffff' -opaque '#2e3436' \
  -background $D -flatten -scale 400% .t/sym-d16.png
magick -background none symbolic.svg -resize 32x32 -fill '#ffffff' -opaque '#2e3436' \
  -background $D -flatten -scale 200% .t/sym-d32.png
magick montage -background '#ffffff' -tile 4x1 -gravity center -geometry 64x64+8+8 \
  .t/sym-l16.png .t/sym-l32.png .t/sym-d16.png .t/sym-d32.png symbolic-strip.png

rm -rf .t
echo "overview.png $(magick identify -format '%wx%h' overview.png)"
echo "details.png  $(magick identify -format '%wx%h' details.png)"
echo "symbolic-strip.png $(magick identify -format '%wx%h' symbolic-strip.png)"
