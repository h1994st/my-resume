// The demo's timeline: five acts, each a list of steps. A step is terminal lines (see terminal.js)
// plus the resume replica's end state: { state, highlight?, proof? } (state keys from
// resume-data.js; highlight = data-ids; proof = a real PDF page image shown over the replica).
// `hold` is how long autoplay rests on the step after playing it (ms; default 1600).
//
// Everything mirrors the repo: file contents, command names, and command output are copied from
// common/facts/roles.tex, canonical/resume.tex, applications/2026-09-granary-senior-mouser/, the
// justfile, and the two skills. Only act 5 (the new Granary role) is not in the repo; the stage
// labels it as a demo step.

const APP = "applications/2026-09-granary-senior-mouser";

const WINDOWSILL_FACT = [
  { text: "\\defrole{windowsill}{" },
  { text: "  title = {Head of Windowsill Operations}," },
  { text: "  org = {Sunbeam Estates}," },
  { text: "  location = {Living Room}," },
  { text: "  start = 2023-04, end = present," },
  { text: "}" },
];

// Act 1 — Facts → canonical.
const facts = [
  {
    lines: [
      { t: "welcome" },
      { t: "code", file: "common/facts/roles.tex", lines: WINDOWSILL_FACT },
    ],
    resume: { state: "canonical", highlight: ["windowsill"] },
    hold: 3000,
  },
  {
    lines: [
      {
        t: "code",
        file: "canonical/resume.tex",
        lines: [
          { text: "\\begin{experience}" },
          { text: "  \\begin{role}{windowsill}" },
          {
            text: "    \\item Initiated and led ``Operation Red Dot'', a household-wide laser-pointer pursuit program spanning 12 rooms, with a perfectly consistent record of zero dots caught",
          },
        ],
      },
    ],
    resume: { state: "canonical", highlight: ["windowsill", "w-red-dot"] },
    hold: 3000,
  },
  {
    lines: [
      { t: "bash", text: "just build" },
      {
        t: "out",
        tone: "dim",
        text: "Output written on build/canonical/resume.xdv (2 pages, 78948 bytes).",
      },
      { t: "out", text: "Wrote canonical/resume.pdf" },
    ],
    resume: { state: "canonical" },
    hold: 2400,
  },
];

// Act 2 — Tailor (the /customize-resume skill).
const tailor = [
  {
    lines: [
      { t: "gap" },
      { t: "prompt", text: "/customize-resume https://example.com/careers/senior-mouser" },
      { t: "spin", text: "Sniffing", ms: 1000 },
      { t: "tool", name: "Fetch", arg: "example.com/careers/senior-mouser" },
      { t: "result", text: "Received 2.1KB (200 OK)" },
    ],
    resume: { state: "canonical" },
    hold: 800,
  },
  {
    lines: [
      { t: "tool", name: "Bash", arg: "just new granary senior-mouser" },
      {
        t: "result",
        text: `Created ${APP} — fill in jd.md, then ask Claude to customize.`,
      },
      { t: "tool", name: "Write", arg: "…/jd.md" },
      { t: "result", text: "Wrote 37 lines to …/jd.md" },
    ],
    resume: { state: "canonical" },
    hold: 1200,
  },
  {
    lines: [
      { t: "say", text: "JD signals, mapped to evidence in canonical:" },
      {
        t: "table",
        head: ["JD signal", "Evidence", "Change"],
        rows: [
          [
            "Night patrol, early rodent detection",
            "Monitored 400+ birds a day (Sunbeam)",
            "Lead with it",
          ],
          ["Fast response, incident reporting", "Chirping alerts in under 2 seconds", "Summary"],
          ["Box inventory inspection", "Inspected 1,200 boxes (Cardboard)", "Keep first"],
          ["Training younger cats", "Mentored two younger cats", "Move up"],
          ["Rodent-detection research", "ACWS 2019, Best Paper", "Keep only this paper"],
        ],
      },
      {
        t: "say",
        text: "To fit one page: drop Service, Honors, two projects, and three papers.",
      },
      {
        t: "ask",
        question: "Proceed with this plan?",
        options: ["Yes", "Adjust the plan"],
        pick: 0,
      },
    ],
    resume: {
      state: "canonical",
      highlight: ["w-birds", "c-boxes", "w-mentor", "feline2019curiosity"],
    },
    hold: 3000,
  },
  {
    lines: [
      { t: "spin", text: "Tailoring", ms: 1200 },
      { t: "tool", name: "Update", arg: "…/resume.tex" },
      { t: "result", text: "Updated …/resume.tex with 9 additions and 26 removals" },
      {
        t: "code",
        file: `${APP}/resume.tex`,
        lines: [
          { text: "\\headline{Rodent Operations Specialist, Ph.C.}", mark: "+" },
          { text: "  \\begin{role}{windowsill}" },
          {
            text: "    \\item Monitored 400+ birds and 37 squirrels a day from the bay window, chirping alerts in under 2 seconds",
            mark: "+",
          },
          {
            text: "    \\item Initiated and led ``Operation Red Dot'', a household-wide laser-pointer pursuit program spanning 12 rooms, with a perfectly consistent record of zero dots caught",
          },
          {
            text: "    \\item Monitored 400+ birds and 37 squirrels a day from the bay window, chirping alerts in under 2 seconds",
            mark: "-",
          },
        ],
      },
    ],
    resume: { state: "granary", highlight: ["headline", "w-birds"] },
    hold: 3200,
  },
  {
    lines: [
      { t: "tool", name: "Update", arg: "…/notes.md" },
      { t: "result", text: "Updated …/notes.md with 27 additions and 9 removals" },
      {
        t: "say",
        text: "Sunbeam leads with monitoring and mentoring (dog treaty and breakfast cut); box inspection stays first at Cardboard.",
      },
      {
        t: "say",
        text: "Cut Purrometheus, Hairball, Service, Honors, and three papers: 2 pages → 1.",
      },
    ],
    resume: { state: "granary" },
    hold: 3000,
  },
];

// Act 3 — Check, then the real PDF.
const check = [
  {
    lines: [
      { t: "gap" },
      { t: "bash", text: `just check ${APP}` },
      { t: "out", tone: "dim", text: `Wrote ${APP}/resume.pdf` },
      { t: "out", tone: "ok", text: `OK: ${APP}/resume.pdf has 1 pages` },
    ],
    resume: { state: "granary" },
    hold: 1400,
  },
  {
    lines: [],
    resume: { state: "granary", proof: "tailored" },
    hold: 4000,
  },
];

// Act 4 — Submit: commit and tag the snapshot.
const submit = [
  {
    lines: [
      { t: "gap" },
      { t: "bash", text: `git add ${APP}` },
      { t: "bash", text: 'git commit -m "feat: add granary senior-mouser application"' },
      { t: "out", text: "[main 1a2b3c4] feat: add granary senior-mouser application" },
      { t: "out", text: " 3 files changed, 122 insertions(+)" },
    ],
    resume: { state: "granary" },
    hold: 1400,
  },
  {
    lines: [
      { t: "bash", text: "git tag submitted/2026-09-granary-senior-mouser" },
      { t: "gap" },
      {
        t: "out",
        tone: "dim",
        text: "# git checkout <tag> && just build <dir> rebuilds exactly what was sent",
      },
    ],
    resume: { state: "granary" },
    hold: 2400,
  },
];

// Act 5 — Update canonical (the /update-resume skill). Demo only: this role is not in the repo.
const update = [
  {
    lines: [
      { t: "gap" },
      { t: "prompt", text: "/update-resume Got the job: Senior Mouser at Granary & Sons" },
      { t: "spin", text: "Purring", ms: 1000 },
      { t: "say", text: "What is the start date (YYYY-MM), and the location?" },
    ],
    resume: { state: "canonical" },
    hold: 1200,
  },
  {
    lines: [
      {
        t: "prompt",
        text: "2026-11, the grain warehouse; first bullet: patrols 40 tons of grain on night shifts",
      },
      { t: "tool", name: "Update", arg: "common/facts/roles.tex" },
      { t: "result", text: "Updated common/facts/roles.tex with 7 additions and 1 removal" },
      {
        t: "code",
        file: "common/facts/roles.tex",
        lines: [
          { text: "\\defrole{granary}{", mark: "+" },
          { text: "  title = {Senior Mouser},", mark: "+" },
          { text: "  org = {Granary \\& Sons},", mark: "+" },
          { text: "  location = {Grain Warehouse},", mark: "+" },
          { text: "  start = 2026-11, end = present,", mark: "+" },
          { text: "}", mark: "+" },
          { text: "\\defrole{windowsill}{" },
          { text: "  start = 2023-04, end = present,", mark: "-" },
          { text: "  start = 2023-04, end = 2026-10,", mark: "+" },
        ],
      },
    ],
    resume: { state: "canonical", highlight: ["windowsill"] },
    hold: 2000,
  },
  {
    lines: [
      { t: "tool", name: "Update", arg: "canonical/resume.tex" },
      { t: "result", text: "Updated canonical/resume.tex with 3 additions" },
      {
        t: "code",
        file: "canonical/resume.tex",
        lines: [
          { text: "\\begin{experience}" },
          { text: "  \\begin{role}{granary}", mark: "+" },
          { text: "    \\item Patrols 40 tons of grain on night shifts", mark: "+" },
          { text: "  \\end{role}", mark: "+" },
          { text: "  \\begin{role}{windowsill}" },
        ],
      },
    ],
    resume: { state: "updated", highlight: ["granary", "g-patrol"] },
    hold: 2600,
  },
  {
    lines: [
      { t: "tool", name: "Update", arg: `${APP}/notes.md` },
      { t: "result", text: "Updated …/notes.md with 1 addition" },
      {
        t: "say",
        text: "The submitted Granary snapshot is history; left untouched. It cites windowsill, so its notes.md records the new end date.",
      },
    ],
    resume: { state: "updated" },
    hold: 3600,
  },
];

export const ACTS = [
  { id: "facts", name: "Facts", title: "Facts live once, cited by key", steps: facts },
  { id: "tailor", name: "Tailor", title: "Tailor a variant for a job", steps: tailor },
  { id: "check", name: "Check", title: "Check it fits, see the real PDF", steps: check },
  { id: "submit", name: "Submit", title: "Commit and tag what was sent", steps: submit },
  { id: "update", name: "Update", title: "Update canonical (demo step)", steps: update },
];
