#!/usr/bin/env bash
# Regenerates the LXGW WenKai (霞鹜文楷) subset that the Chinese pen notes use. Dev-only: the
# outputs are committed, and nothing runs this at build or deploy time.
#   chars.txt                          every character of site/i18n.js's Chinese strings, printable
#                                      ASCII, and common CJK punctuation
#   lxgw-wenkai-medium-subset.woff2    LXGWWenKai-Medium.ttf cut down to chars.txt
# Run it after changing a Chinese string: the browser tests fail while chars.txt misses one.
#
# Source: LXGW WenKai v1.522, LXGWWenKai-Medium.ttf from the official GitHub release,
# https://github.com/lxgw/LxgwWenKai/releases/tag/v1.522 (SIL OFL 1.1; OFL.txt here is that
# tag's). The TTF (25 MB) is downloaded once into build/wenkai/ and checked against SHA256.
#
# Needs Node, curl, and fontTools with brotli (for woff2), in a Python venv:
#   python3 -m venv build/venv && build/venv/bin/pip install fonttools brotli
#   PYTHON=build/venv/bin/python site/fonts/wenkai/subset.sh
set -euo pipefail

VERSION=v1.522
FILE=LXGWWenKai-Medium.ttf
SHA256=d4bdeb38a39151d74d084cba5090f8cb7d20bf83eedb78c35939ae70b9f4e3f6
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
python=${PYTHON:-python3}
cache="$repo/build/wenkai"
ttf="$cache/${FILE%.ttf}-$VERSION.ttf"

if [[ ! -f $ttf ]]; then
  mkdir -p "$cache"
  curl -fsSL -o "$ttf.part" "https://github.com/lxgw/LxgwWenKai/releases/download/$VERSION/$FILE"
  mv "$ttf.part" "$ttf"
fi
if command -v sha256sum >/dev/null; then
  sum=$(sha256sum "$ttf" | cut -d' ' -f1)
else
  sum=$(shasum -a 256 "$ttf" | cut -d' ' -f1)
fi
if [[ $sum != "$SHA256" ]]; then
  echo "unexpected SHA256 for $ttf: $sum" >&2
  exit 1
fi

# The characters, sorted by code point (the space first), 40 to a line.
node --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const { STRINGS } = await import(pathToFileURL(process.argv[1]).href);
  const chars = new Set();
  for (let c = 0x20; c < 0x7f; c++) chars.add(String.fromCodePoint(c));
  for (const c of "，。、；：？！“”‘’（）《》〈〉【】「」『』…—～·") chars.add(c);
  for (const value of Object.values(STRINGS.zh)) {
    for (const s of [value].flat()) for (const c of s) if (!/\s/u.test(c)) chars.add(c);
  }
  const sorted = [...chars].sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
  const lines = [];
  for (let i = 0; i < sorted.length; i += 40) lines.push(sorted.slice(i, i + 40).join(""));
  process.stdout.write(lines.join("\n") + "\n");
' "$repo/site/i18n.js" >"$here/chars.txt"

"$python" -m fontTools.subset "$ttf" \
  --text-file="$here/chars.txt" \
  --layout-features='*' \
  --no-hinting \
  --flavor=woff2 \
  --output-file="$here/lxgw-wenkai-medium-subset.woff2"

echo "$(wc -m <"$here/chars.txt" | tr -d ' ') characters in chars.txt;" \
  "$(wc -c <"$here/lxgw-wenkai-medium-subset.woff2" | tr -d ' ') bytes of woff2"
