---
name: customize-resume
description:
  Start and tailor a job-specific resume from a job description (a PDF path or a URL). Use when the
  user asks to customize, tailor, or apply with the resume for a specific job.
argument-hint: <JD PDF path or URL>
---

# Customize the resume for a job description

Input: `$ARGUMENTS` is a path to a job-description PDF or a URL to a public job posting. If it is
empty, ask for one and stop.

Follow these steps in order. Steps 1–5 are mechanical; do not skip or reorder them. Read `CLAUDE.md`
first if it is not already in context: its Core rules (factual accuracy, page length) bind every
step.

## 1. Read the job description

- PDF: read it with the Read tool.
- URL: fetch it with WebFetch. If the page needs a login or the content is missing, ask the user to
  save it as a PDF and stop.

## 2. Create the application directory

- Derive `<company>` and `<role>` slugs: lowercase kebab-case, short (e.g. `acme` and
  `staff-engineer`). If either is ambiguous, ask.
- Run `just new <company> <role>`. Note the directory it prints:
  `applications/YYYY-MM-<company>-<role>/`.
- If the input was a PDF, copy it into that directory as `jd.pdf` (PDFs are gitignored; it stays
  local).

## 3. Write `jd.md`

Fill the template the directory already contains, faithfully and without embellishment:

- Title line: `# <Role title> — <Company>`.
- **URL** (or "saved PDF"), **Captured** (today, `YYYY-MM-DD`), **Location / type**, **Team /
  reports to**.
- **About the team**, **Responsibilities**, **Required qualifications**, **Preferred
  qualifications**: summarize each bullet in the posting's own terms; keep exact technologies,
  years, and degree requirements.
- **Other notes**: compensation, visa, travel, or anything else worth keeping. Delete empty
  sections.

Run `just fmt <dir>/jd.md`.

## 4. Map signals to evidence (stop for approval)

Extract 5–8 meaningful signals from `jd.md` and present a table:

| JD signal | Evidence (canonical bullet or fact) | Current representation | Proposed change |
| --------- | ----------------------------------- | ---------------------- | --------------- |

Use only evidence that exists in `canonical/resume.tex` or `common/facts/`. Mark any signal with no
evidence as **no evidence** — never invent experience to fill it. Show the table and the proposed
plan, then **wait for the user's approval** before editing the resume.

## 5. Tailor `resume.tex`

Edit only `<dir>/resume.tex`, in this order of preference: reorder entries and bullets, emphasize
relevant detail, tighten less relevant bullets, rewrite for clarity, cut low-value content, adjust
the summary and (optionally) `\headline{...}`.

- Never edit `common/facts/` for a variant; facts are shared by every resume.
- Use JD terminology only where it accurately describes the work; no keyword stuffing.
- Flag any rewrite that strengthens a claim instead of applying it silently.

## 6. Build and check

Run `just fmt <dir>/resume.tex` and `just check <dir>`. It must report 2 pages (or fewer) with no
warning lines. If it is over length, cut or tighten content; do not shrink fonts or margins.

## 7. Record and report

- Fill `<dir>/notes.md`: Application, JD Signals, Resume Strategy, Major Changes from Canonical.
- Reply with a **semantic** diff against canonical (per employer/section: what moved, what was
  emphasized or cut, and which JD signal it serves), plus anything flagged in step 5.
- Do not commit unless the user asks. Suggested message: `feat: add <company> <role> application`.
