#!/usr/bin/env bash
# Fails if the site's resume replica shows text the real PDFs don't (keeps the demo honest).
# Usage: site/check.sh [pdf-root]  (pdf-root holds canonical/resume.pdf and applications/*/resume.pdf)
set -euo pipefail
root=${1:-.}
here=$(cd "$(dirname "$0")" && pwd)

# PDF text: NFC; ligatures spelled out; "Page N of M" footers and form feeds dropped (so text split
# across a page break joins up); a line ending in "-" joined to the next without a space (hyphenation
# is off in the template, so such a wrap is always at a real hyphen, e.g. "laser-pointer"); then all
# whitespace, line breaks included, collapsed to single spaces.
norm() {
  node -e '
    let s = require("fs").readFileSync(0, "utf8").normalize("NFC");
    const lig = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl" };
    s = s.replace(/[ﬀ-ﬄ]/g, (c) => lig[c]);
    s = s.replace(/^[ \t]*Page \d+ of \d+[ \t]*$/gm, " ").replace(/\f/g, "\n");
    s = s.replace(/-[ \t]*\n\s*/g, "-");
    process.stdout.write(s.replace(/\s+/g, " "));
  '
}
# Replica strings: NFC, whitespace collapsed, trimmed, one per line.
norm_lines() {
  node -e '
    const s = require("fs").readFileSync(0, "utf8").normalize("NFC");
    for (const line of s.split("\n")) {
      const t = line.replace(/\s+/g, " ").trim();
      if (t) console.log(t);
    }
  '
}

fail=0
for pair in canonical:canonical applications/2026-09-granary-senior-mouser:granary; do
  dir=${pair%%:*} state=${pair##*:}
  pdf="$root/$dir/resume.pdf"
  # -layout keeps right-aligned dates on the same line; raw order catches wrapped bullets.
  text=$(pdftotext -layout -enc UTF-8 "$pdf" - | norm)
  raw=$(pdftotext -enc UTF-8 "$pdf" - | norm)
  # Captured first (not read through process substitution) so a failing strings.mjs fails the check.
  strings=$(node "$here/strings.mjs" "$state" | norm_lines)
  if [[ -z $strings ]]; then
    echo "no replica strings for state '$state'"
    fail=1
    continue
  fi
  n=0
  while IFS= read -r s; do
    n=$((n + 1))
    [[ $text == *"$s"* || $raw == *"$s"* ]] && continue
    echo "missing from $dir/resume.pdf: $s"
    fail=1
  done <<<"$strings"
  echo "checked $n strings of '$state' against $dir/resume.pdf"
done
exit $fail
