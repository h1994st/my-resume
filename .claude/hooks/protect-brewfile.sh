#!/usr/bin/env bash
# PreToolUse(Bash) hook: deny shell commands that would modify Brewfile.
# Brewfile changes must go through `brew bundle add/remove` (see CLAUDE.md).
set -euo pipefail

cmd=$(jq -r '.tool_input.command // empty')

# Not about Brewfile: allow.
grep -q 'Brewfile' <<<"$cmd" || exit 0

# A single `brew bundle ...` command (no chaining or redirection): allow.
if grep -Eq '^[[:space:]]*brew[[:space:]]+bundle([[:space:]][^;&|<>]*)?$' <<<"$cmd"; then
    exit 0
fi

# Anything that looks like a write while Brewfile is mentioned: deny.
# Redirects to /dev/null or fd duplication (2>&1) are not writes.
stripped=$(sed -E 's/[0-9]*>{1,2}[[:space:]]*(\/dev\/null|&[0-9-])//g' <<<"$cmd")
write_re='>|\btee\b|\b(sed|perl|ruby)\b[^|;&]*[[:space:]]-[a-zA-Z]*i|\b(mv|cp|rm|ln|install|truncate|dd|touch|patch)\b|\b(python3?|node|awk|ed|ex|vi|vim|nvim)\b|\bgit[[:space:]]+(checkout|restore|apply|stash|reset)\b'
if grep -Eq "$write_re" <<<"$stripped"; then
    jq -n '{hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Brewfile must not be edited directly; use `brew bundle add <formula>` (or `brew bundle remove`)."
    }}'
fi
exit 0
