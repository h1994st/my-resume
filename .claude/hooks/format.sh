#!/usr/bin/env bash
# PostToolUse(Write|Edit|MultiEdit) hook: run `just fmt <file>` on edited .tex/.md/.json files.
# Never blocks: formatting failures are left for `just fmt-check` to catch.
set -uo pipefail

file=$(jq -r '.tool_input.file_path // empty')

case "$file" in
    *.tex | *.md | *.json) cd "$CLAUDE_PROJECT_DIR" && just fmt "$file" >/dev/null 2>&1 ;;
esac
exit 0
