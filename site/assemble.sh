#!/usr/bin/env bash
# Assembles the static site into <out>: the site files, the template's fonts (with their OFL
# licenses), the two built PDFs, and PNGs of their pages.
# Usage: site/assemble.sh <out> [pdf-root]  (pdf-root holds canonical/resume.pdf and
# applications/2026-09-granary-senior-mouser/resume.pdf; default: the current directory)
set -euo pipefail
out=${1:?usage: site/assemble.sh <out> [pdf-root]}
root=${2:-.}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")

rm -rf "$out"
mkdir -p "$out/fonts/SourceSans3" "$out/fonts/SourceSerif4" "$out/pdf" "$out/img"

# Site files, without tests and the build-time scripts.
for f in "$here"/*; do
  case $(basename "$f") in
    tests | *.sh | strings.mjs) continue ;;
  esac
  cp -R "$f" "$out/"
done

for family in SourceSans3 SourceSerif4; do
  cp "$repo/fonts/$family"/*.otf "$repo/fonts/$family/LICENSE.md" "$out/fonts/$family/"
done

cp "$root/canonical/resume.pdf" "$out/pdf/canonical.pdf"
cp "$root/applications/2026-09-granary-senior-mouser/resume.pdf" "$out/pdf/tailored.pdf"
# pdftoppm numbers pages from 1: canonical-1.png, canonical-2.png, tailored-1.png.
pdftoppm -png -r 110 "$out/pdf/canonical.pdf" "$out/img/canonical"
pdftoppm -png -r 110 "$out/pdf/tailored.pdf" "$out/img/tailored"

echo "Assembled $out"
