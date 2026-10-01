#!/usr/bin/env bash
# Template tests. Each tests/cases/*.tex states its expectation in comment lines:
#   % expect: error <text>        the build must fail and the log must contain <text>
#   % expect: ok                  the build must succeed without overfull boxes
#   % expect-text: <text>         the PDF text must contain <text>
#   % expect-unwanted: <text>     the PDF text must not contain <text>
#   % expect-order: A | B | C     lines equal to A, B, C appear in this order
#   % expect-unstranded: N        shifting the content down 0..N lines (N lines must fit on a page)
#                                 never overflows a page and never leaves a page
#                                 ending with a section heading or an entry title line
set -uo pipefail
cd "$(dirname "$0")/.."
export TEXINPUTS="common:${TEXINPUTS:-}"
out=build/tests
mkdir -p "$out"
failures=0

compile() { # $1 = .tex file; prints nothing, returns latexmk's status
  latexmk -xelatex -interaction=nonstopmode -halt-on-error -outdir="$out" "$1" >/dev/null 2>&1
}
fail() { echo "FAIL $1: $2"; failures=$((failures + 1)); }

titles='^\s*(Summary|Experience|Projects|Education|Publications|Service|Honors & Awards)\s*$|[A-Z][a-z]{2} [0-9]{4} – (Present|[A-Z][a-z]{2} [0-9]{4})\s*$'

for tex in tests/cases/*.tex; do
  name=$(basename "$tex" .tex)
  log="$out/$name.log"; pdf="$out/$name.pdf"
  expect=$(sed -nE 's/^% expect: (.*)$/\1/p' "$tex")
  if [[ "$expect" == error* ]]; then
    want=${expect#error }
    if compile "$tex"; then fail "$name" "expected the build to fail"; continue; fi
    grep -qF -- "$want" "$log" || fail "$name" "log lacks: $want"
    continue
  fi
  if ! compile "$tex"; then fail "$name" "build failed: $(grep -m1 '^!' "$log")"; continue; fi
  grep -q 'Overfull \\[hv]box' "$log" && fail "$name" "overfull box in log"
  text=$(pdftotext -layout "$pdf" -)
  while IFS= read -r want; do
    grep -qF -- "$want" <<<"$text" || fail "$name" "PDF lacks: $want"
  done < <(sed -nE 's/^% expect-text: (.*)$/\1/p' "$tex")
  while IFS= read -r unwanted; do
    grep -qF -- "$unwanted" <<<"$text" && fail "$name" "PDF unexpectedly contains: $unwanted"
  done < <(sed -nE 's/^% expect-unwanted: (.*)$/\1/p' "$tex")
  order=$(sed -nE 's/^% expect-order: (.*)$/\1/p' "$tex")
  if [[ -n "$order" ]]; then
    got=$(sed -E 's/^ +//; s/ +$//' <<<"$text" | grep -xF -f <(tr '|' '\n' <<<"$order" | sed -E 's/^ +//; s/ +$//') | paste -sd'|' -)
    [[ "$got" == "$(tr '|' '\n' <<<"$order" | sed -E 's/^ +//; s/ +$//' | paste -sd'|' -)" ]] || fail "$name" "order was: $got"
  fi
  n=$(sed -nE 's/^% expect-unstranded: ([0-9]+)$/\1/p' "$tex")
  if [[ -n "$n" ]]; then
    for shift in $(seq 0 "$n"); do
      shifted="$out/${name}-shift.tex"
      sed "s/\\\\begin{document}/\\\\begin{document}\\\\vspace*{${shift}\\\\baselineskip}/" "$tex" > "$shifted"
      compile "$shifted" || { fail "$name" "shift $shift: build failed"; break; }
      grep -q 'Overfull \\[hv]box' "$out/${name}-shift.log" && fail "$name" "shift $shift: overfull box in log"
      pages=$(pdfinfo "$out/${name}-shift.pdf" | awk '/^Pages:/ {print $2}')
      for p in $(seq 1 $((pages - 1))); do
        last=$(pdftotext -f "$p" -l "$p" -layout "$out/${name}-shift.pdf" - | grep -vE '^\s*$|Page [0-9]+ of' | tail -1)
        grep -qE "$titles" <<<"$last" && fail "$name" "shift $shift: page $p ends with: $last"
      done
    done
  fi
done

if (( failures > 0 )); then echo "$failures test failure(s)"; exit 1; fi
echo "All template tests passed."
