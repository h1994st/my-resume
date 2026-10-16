#!/usr/bin/env bash
# Assembles the static site into <out>: the site files, the site's own fonts (Caveat) and the
# template's fonts (all with their OFL licenses), the two built PDFs, and PNGs of their pages.
# Usage: site/assemble.sh <out> [pdf-root]  (pdf-root holds canonical/resume.pdf and
# applications/2026-09-granary-senior-mouser/resume.pdf; default: the template checkout)
# The template's fonts come from TEMPLATE_DIR, a checkout of main (default: ./template).
set -euo pipefail
out=${1:?usage: site/assemble.sh <out> [pdf-root]}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
template=$(cd "${TEMPLATE_DIR:-$repo/template}" && pwd)
root=${2:-$template}

rm -rf "$out"
mkdir -p "$out/fonts/SourceSans3" "$out/fonts/SourceSerif4" "$out/pdf" "$out/img"

# Site files, without tests and the build-time scripts.
for f in "$here"/*; do
  case $(basename "$f") in
    tests | fonts | *.sh | strings.mjs) continue ;;
  esac
  cp -R "$f" "$out/"
done

cp -R "$here/fonts/." "$out/fonts/"
for family in SourceSans3 SourceSerif4; do
  cp "$template/fonts/$family"/*.otf "$template/fonts/$family/LICENSE.md" "$out/fonts/$family/"
done

cp "$root/canonical/resume.pdf" "$out/pdf/canonical.pdf"
cp "$root/applications/2026-09-granary-senior-mouser/resume.pdf" "$out/pdf/tailored.pdf"
# pdftoppm numbers pages from 1: canonical-1.png, canonical-2.png, tailored-1.png.
pdftoppm -png -r 110 "$out/pdf/canonical.pdf" "$out/img/canonical"
pdftoppm -png -r 110 "$out/pdf/tailored.pdf" "$out/img/tailored"

# The sitemap, stamped with the newer of the site's and the template's commit dates
# (shengtuo.me's robots.txt points here). Outside git checkouts it goes out without <lastmod>.
lastmod=$(
  {
    git -C "$repo" log -1 --format=%cs 2>/dev/null || true
    git -C "$template" log -1 --format=%cs 2>/dev/null || true
  } | sort | tail -1
)
{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
  echo "  <url><loc>https://shengtuo.me/my-resume/</loc>${lastmod:+<lastmod>$lastmod</lastmod>}</url>"
  echo '</urlset>'
} >"$out/sitemap.xml"

echo "Assembled $out"
