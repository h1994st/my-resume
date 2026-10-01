set shell := ["bash", "-euo", "pipefail", "-c"]

# Optional local-only recipes; skipped when sync.just does not exist
import? 'sync.just'

# Files Prettier owns; dot-directories must be listed explicitly
prettier_globs := '"**/*.{md,json}" ".claude/**/*.json"'

# Build the canonical resume
default: build

# Install Homebrew and TeX Live dependencies (tlmgr needs sudo)
deps:
    brew bundle
    sudo tlmgr install $(grep -Ev '^\s*(#|$)' tex-packages.txt)

# List packages from tex-packages.txt that are not installed
deps-check:
    #!/usr/bin/env bash
    set -euo pipefail
    installed=$(tlmgr info --only-installed --data name)
    missing=$(grep -Ev '^\s*(#|$)' tex-packages.txt | while read -r pkg; do
        grep -qx "$pkg" <<<"$installed" || echo "$pkg"
    done)
    if [[ -n "$missing" ]]; then echo "Missing TeX packages:" $missing; exit 1; fi
    echo "All TeX packages installed."

# Build a resume directory (default: canonical); writes <dir>/resume.pdf
build dir="canonical":
    #!/usr/bin/env bash
    set -euo pipefail
    dir="{{trim_end_match(dir, '/')}}"
    TEXINPUTS="common:" latexmk -xelatex -interaction=nonstopmode -halt-on-error -file-line-error \
        -outdir="build/$dir" "$dir/resume.tex"
    cp "build/$dir/resume.pdf" "$dir/resume.pdf"
    echo "Wrote $dir/resume.pdf"

# Build, report layout warnings, and verify page count (canonical: no limit; variants: at most 2)
check dir="canonical" pages="": (build dir)
    #!/usr/bin/env bash
    set -euo pipefail
    dir="{{trim_end_match(dir, '/')}}"
    log="build/$dir/resume.log"
    # TeX wraps long log lines (no added spaces), so join them before parsing the page count.
    actual=$(tr -d '\n' < "$log" | sed -nE 's/.*Output written on [^(]*\(([0-9]+) pages?.*/\1/p')
    grep -nE 'Overfull|Underfull|LaTeX( Font)? Warning|Package .* Warning|Missing character' "$log" || true
    if [[ -n "{{pages}}" ]]; then
        # An explicit page count must match exactly.
        if [[ "$actual" != "{{pages}}" ]]; then
            echo "FAIL: $dir/resume.pdf has $actual pages, expected {{pages}}"; exit 1
        fi
    elif [[ "$dir" != "canonical" && "$actual" -gt 2 ]]; then
        echo "FAIL: $dir/resume.pdf has $actual pages, variants must fit in 2"; exit 1
    fi
    echo "OK: $dir/resume.pdf has $actual pages"

# Rebuild continuously on save
watch dir="canonical":
    TEXINPUTS="common:" latexmk -xelatex -pvc -interaction=nonstopmode -outdir="build/{{dir}}" "{{dir}}/resume.tex"

# Run the template tests in tests/cases/ (after any change to common/resume.cls or facts)
test:
    tests/run.sh

# Start a new application from canonical: applications/YYYY-MM-<company>-<role>/
new company role:
    #!/usr/bin/env bash
    set -euo pipefail
    dir="applications/$(date +%Y-%m)-{{company}}-{{role}}"
    if [[ -e "$dir" ]]; then echo "$dir already exists"; exit 1; fi
    mkdir -p "$dir"
    cp canonical/resume.tex templates/application/jd.md templates/application/notes.md "$dir/"
    echo "Created $dir — fill in jd.md, then ask Claude to customize."

# Format the given files, or the whole repo: .tex with tex-fmt (not .cls), .md/.json with Prettier
[positional-arguments]
fmt *files:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ $# -eq 0 ]]; then
        find . -name '*.tex' -not -path './build/*' -print0 | xargs -0 tex-fmt
        prettier --write --log-level warn {{prettier_globs}}
        exit 0
    fi
    for f in "$@"; do
        case "$f" in
            *.tex) tex-fmt "$f" ;;
            *.md | *.json) prettier --write --log-level warn "$f" ;;
            *) echo "fmt: no formatter for $f" ;;
        esac
    done

# Fail if any .tex/.md/.json file is not formatted
fmt-check:
    find . -name '*.tex' -not -path './build/*' -print0 | xargs -0 tex-fmt --check
    prettier --check --log-level warn {{prettier_globs}}

# Remove build intermediates
clean:
    rm -rf build
