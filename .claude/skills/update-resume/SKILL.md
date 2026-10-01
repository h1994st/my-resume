---
name: update-resume
description:
  Add or update experience in the canonical resume (a new role, project, publication, award, service
  item, bullets, or skills). Use when the user shares new experience or corrections for their
  resume.
argument-hint: <what changed, e.g. "new role at Acme as Staff Engineer since 2026-10">
---

# Update the canonical resume

Input: `$ARGUMENTS` describes the new or changed experience. If it is empty, ask what changed and
stop.

Follow these steps in order. Read `CLAUDE.md` first if it is not already in context: factual
accuracy is non-negotiable, and application snapshots are history.

## 1. Collect the facts (ask, never guess)

Decide which kinds of change the input contains:

- **Fact** (shared header data): role (`title`, `org`, `location`, `start`, `end`), project
  (`title`, `org`, `link`, `note`, `start`, `end`), degree, publication (`title`, `venue`,
  `authors`, `award`), service or honor (`text`, `years`).
- **Content**: bullets, summary, or skills in `canonical/resume.tex`.

Ask the user for any required value that is missing or ambiguous: exact titles, organization names,
dates as `YYYY-MM` (or `present`), author order, venue names. Do not infer dates or titles.

## 2. Update `common/facts/`

- New fact: add a `\defrole` / `\defproject` / `\defdegree` / `\defpub` / `\defservice` /
  `\defhonor` entry with a new lowercase kebab-case key, in the right file and position (newest
  first for roles and projects).
- Changed fact (e.g. a role ends, a title changes): edit the existing entry. Then run
  `grep -rn '<key>' applications/` and tell the user which application snapshots also change. For
  each submitted application, append a dated line to its `notes.md` recording the change.

## 3. Update `canonical/resume.tex`

- Cite new keys in the right section (`\begin{role}{<key>}`, `\begin{project}{<key>}`, or add the
  key to `\publications{...}`, `\service{...}`, `\honors{...}`).
- Add or edit bullets, one `\item` per line. Keep the user's meaning; tighten wording, prefer
  concrete detail and real metrics the user provided. Flag (do not apply) any rewrite that
  strengthens a claim.
- Leave `applications/` resume files untouched.

## 4. Verify

Run `just fmt`, then `just test` (facts changed), then `just check`. All must pass with no new
warning lines. Look at the PDF if a page break moved.

## 5. Report

Summarize what changed (facts, canonical sections, affected snapshots) and any flagged claims. Do
not commit unless the user asks. Suggested message: `feat: add <thing> to canonical`.
