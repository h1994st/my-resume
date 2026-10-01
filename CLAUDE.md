# Resume Repository

A canonical LaTeX resume plus job-specific variants, maintained locally with Git. This is a resume
repository, not a resume-generation framework: keep it boring, explicit, and easy to diff.

The shipped content is a **sample persona, Duna Feline** (see README). To make the repo yours,
replace `common/profile.tex`, the facts in `common/facts/`, `canonical/resume.tex`, and the
"Technical identity" section below, then delete the sample application.

## Environment

- macOS + Homebrew (`Brewfile`): **BasicTeX** (not full MacTeX), `just`, `tex-fmt`, `prettier`, and
  `poppler` (PDF text tools used by the tests).
- **Never edit `Brewfile` directly**; add dependencies with `brew bundle add <formula>` (or
  `--cask`).
- Extra TeX Live packages are listed in `tex-packages.txt`. If a build fails on a missing `.sty`,
  find the owning package (`tlmgr search --global --file <name>.sty`), add it to `tex-packages.txt`
  with a comment, and ask me to run `sudo tlmgr install <pkg>` (needs a password).
- Never switch to full MacTeX to paper over a missing package. Avoid adding new LaTeX packages
  without a reason.
- CI (`.github/workflows/ci.yml`) runs on macOS (`brew bundle`) and Linux (TeX Live `scheme-small`,
  the BasicTeX equivalent), both plus `tex-packages.txt`, then runs `just fmt-check`, `just test`,
  and builds every resume on each push; keep it green. A package missing from `tex-packages.txt`
  fails CI, not just your machine. Linux pins tex-fmt and Prettier versions in the workflow; bump
  them when Homebrew's versions change.

## Commands

Use `just`; don't make users remember raw `latexmk` invocations. No Makefile.

| Command                     | Purpose                                                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `just deps`                 | `brew bundle` + `tlmgr install` everything in `tex-packages.txt`                                                                                      |
| `just deps-check`           | List missing TeX packages                                                                                                                             |
| `just build [dir]`          | Build `<dir>/resume.tex` (default `canonical`) → `<dir>/resume.pdf`                                                                                   |
| `just check [dir] [pages]`  | Build, print overfull/underfull/font warnings, assert page count (canonical: none; variants: at most 2)                                               |
| `just watch [dir]`          | Rebuild on save                                                                                                                                       |
| `just test`                 | Run the template tests in `tests/cases/` (after any change to the class or facts)                                                                     |
| `just new <company> <role>` | Create `applications/YYYY-MM-<company>-<role>/` from canonical + templates                                                                            |
| `just fmt [files...]`       | Format the given files, or the whole repo: `.tex` with `tex-fmt` (`tex-fmt.toml`; the hand-formatted `.cls` is excluded), `.md`/`.json` with Prettier |
| `just fmt-check`            | Fail if any `.tex`/`.md`/`.json` file is unformatted                                                                                                  |
| `just clean`                | Delete `build/`                                                                                                                                       |

All builds run **from the repo root** with XeLaTeX and `TEXINPUTS=common:`, so
`\documentclass{resume}` resolves to `common/resume.cls` and intermediates go to `build/<dir>/`.

Claude Code guardrails (`.claude/settings.json` → `.claude/hooks/`):

- `format.sh` runs `just fmt <file>` after every Edit/Write to a `.tex`/`.md`/`.json` file.
- `protect-brewfile.sh` blocks shell commands that would modify `Brewfile`.

Skills (`.claude/skills/`), for the deterministic workflows:

- `/customize-resume <JD PDF or URL>`: `just new`, summarize the JD into `jd.md`, map signals to
  evidence (stops for approval), tailor, `just check`, record `notes.md`.
- `/update-resume <what changed>`: collect missing facts, update `common/facts/` and canonical, flag
  affected application snapshots, `just test` + `just check`.

## Layout

```text
common/resume.cls                THE template: layout, colour, fonts, fixed section order, commands
common/profile.tex               name, default headline, email, homepage, phone (printed in every header)
common/facts/*.tex               roles, projects, education, publications, service, honors (by key)
fonts/SourceSerif4/, SourceSans3/ static OTF fonts (OFL), loaded by path via fontspec
canonical/resume.tex             canonical resume (content only)
applications/YYYY-MM-company-role/
  resume.tex                     variant content (content only)
  jd.md, notes.md                job description summary; application reasoning and history
templates/application/           skeletons for jd.md and notes.md used by `just new`
tests/run.sh, tests/cases/       template tests (`just test`)
docs/images/                     README screenshots of the sample persona (never commit real resumes)
```

- **One template for all variants.** Every `resume.tex` uses `\documentclass{resume}`; variants
  change content, never layout. Template changes apply to every variant, so run `just test` and
  rebuild and `just check` all of them afterwards.
- **Facts live once.** Role/project headers, degrees, publications, service, and honors are defined
  in `common/facts/` and cited by key; never retype them in a resume file. A wrong key, missing
  field, or bad date stops the build with an error naming it. Editing a fact changes every resume
  that cites it, including submitted application snapshots; record such changes in that
  application's `notes.md`.
- **PDFs are not tracked** (`*.pdf` is gitignored), and that includes saved JD PDFs. Git history is
  the record: a submitted resume is the source at its submission commit (see below).

## Authoring a resume

```latex
\documentclass{resume}
\headline{...}                       % optional; default in common/profile.tex; \headline{} hides it
\begin{document}
\begin{summary} Paragraph. \skills{Languages/Tools}{Meow, Purr} \end{summary}
\begin{experience}
  \begin{role}{windowsill}
    \item One bullet per line.
  \end{role}
\end{experience}
\begin{projects} \begin{project}{red-dot-tracker} \item ... \end{project} \end{projects}
\education[dissertation]               % or \education
\publications{feline2019curiosity, whiskers2017box}
\service{acws-pc, jfe-reviewer}
\honors{acws-best-paper}
\end{document}
```

- Sections print in a fixed order (Summary, Experience, Projects, Education, Publications, Service,
  Honors & Awards) regardless of source order; omit a section to drop it. Text outside the section
  environments and commands prints between the header and the first section, so keep all text inside
  sections.
- Within a section, entries and listed keys print in source order, except publications, which print
  newest first by their `date`; bullets print as written.
- Dates in facts are `YYYY-MM` or `present`; the class formats them (`Aug 2024 – Present`). Every
  publication needs a `date = YYYY-MM` (when it was published or presented), used only for sorting.

## Core rules

1. **Factual accuracy is non-negotiable.** Never invent, infer, exaggerate, or silently strengthen
   experience, scope, ownership, metrics, titles, dates, publications, awards, or skills. If a
   rewrite materially strengthens a claim, flag it instead of applying it.
2. **Structural refactors preserve rendered output.** Fonts, sizes, margins, spacing, page breaks,
   and section order stay visually equivalent unless I ask for a visual change. Keep refactoring and
   content editing in separate tasks.
3. **Page length.** Canonical has no page limit: it is the complete superset of my experience.
   Job-specific variants are normally at most two pages; when over length, cut/tighten content
   first; don't shrink fonts, squeeze margins, or stack negative `\vspace`.
4. **Simplicity.** No generators, YAML content DBs, templating engines, compile-time company flags,
   or conditional LaTeX trees. Some duplication between variants is fine.
5. **Git-friendly edits.** One bullet per source block, no unrelated reformatting, small logical
   commits.
6. **Privacy.** Resume/application content is personal data: no external uploads, telemetry, or
   network dependencies.

## Validation after any LaTeX change

`just fmt` then `just check` must pass (and `just test` when `common/resume.cls` or `common/facts/`
changed), then: no new overfull boxes or missing-font/character warnings, no unintended page-break
changes (look at the PDF), and review `git diff`. A zero exit code alone is not enough. `just check`
also lists `Short line` wraps (a few words alone on a line); in a variant, reword them to save the
line.

## Git

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`,
  `fix:`, `docs:`, `chore:`, ...). Subject line only; add a short body only when an explanation is
  really needed.

## Technical identity

_Replace this with your own; it steers every rewrite._ Sample (Duna Feline): a senior mischief
engineer focused on box inspection, windowsill operations, and rodent detection. Prefer concrete
detail (boxes inspected, birds monitored, minutes napped, ...) over generic résumé language ("worked
on", "leveraged", "results-driven"). Show seniority through evidence (originated, owned, drove
ambiguous projects, built reusable infrastructure, mentored kittens), not management-speak.

## Canonical vs. applications

- `canonical/` is the complete, general-purpose resume (no page limit) and the starting point for
  every new variant; a variant selects, reorders entries and bullets, and trims it down to two pages
  (section order is fixed by the class).
- Each application is a snapshot in `applications/YYYY-MM-company-role/` (not a git branch), started
  from canonical.
- Job-specific wording never flows back into canonical silently. If it's better, point it out and
  propose promoting it.
- On submission: commit the application and tag it `submitted/<dir-name>`.
  `git checkout <tag> && just build <dir>` reproduces what was sent (as long as the same TeX Live is
  installed).
- After submission the directory is historical: don't silently modify its content. Record any later
  changes in `notes.md`. Template-wide changes are the exception: they affect every variant by
  design.

## Interpreting requests

- **"Refactor the resume"**: improve organization/maintainability, preserve appearance and content.
- **"Improve this bullet"**: content changes expected; preserve factual meaning.
- **"Update my resume with this experience"**: follow the `update-resume` skill (edit facts and
  canonical; leave application snapshots untouched).
- **"Customize for this JD"**: follow the `customize-resume` skill. Don't start rewriting before the
  JD is saved to `jd.md` and the signal → evidence table is approved; say explicitly when there is
  no evidence for a requirement, and finish with a **semantic** diff vs. canonical recorded in
  `notes.md`.
