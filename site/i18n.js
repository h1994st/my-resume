// The site's two languages: English (the default) and Simplified Chinese. One table per language,
// keyed by id; everything the viewer reads that isn't a document or a command comes from here.
// What stays English in both: Duna's resume replica and the real PDFs and page images (the
// honesty check compares them), the job posting and the stray copies on the desk, and the
// terminal's commands and their real output (tool calls, results, file paths, the git tag, and
// the evidence column of the signal → evidence table, which quotes the resume). Claude's own
// replies in the terminal follow the viewer's language, as Claude answers in the user's.
//
// The language: ?lang=zh|en for this visit (not stored), else the choice kept in
// localStorage["lang"], else English. The inline script in index.html's <head> applies it before
// the first paint as <html lang="en|zh-Hans" data-lang="en|zh">; while Chinese is on its way,
// style.css hides the [data-i18n] text it replaces, until this module adds .i18n-ready to <html>.
//
// t(id, vars?, lang?) → the string (or list) for id in the page's language; "{name}" in it takes
//   vars.name. An unknown id logs an error and gives back the id.
// currentLang() → "en" | "zh" (data-lang on <html>; "en" outside a browser).
// initLang({ onChange }) applies the language to the page and wires #lang-toggle, a button that
//   names the language it switches to ("中文" or "EN", with that language's lang on its text).
//   A click switches, stores the choice, applies the strings, and calls onChange(lang); a
//   ?lang= in the address goes away then, so a reload keeps the choice.
// loadLangFonts() → Promise, resolved when the language's pen font is loaded (LXGW WenKai for
//   Chinese: notes measure their text, so they wait for it).
// In index.html, [data-i18n="id"] elements take the string as their content (it may hold markup:
//   the strings are this file's, never the viewer's), and [data-i18n-attr="attr:id …"] take
//   strings as attributes (alt, aria-label, data-note). The page's own English is the en table;
//   the browser tests check the two agree.

export const LANGS = ["en", "zh"];
const TAGS = { en: "en", zh: "zh-Hans" };
const KEY = "lang";

export const STRINGS = {
  en: {
    "head.title": "my-resume",
    "head.description":
      "A LaTeX resume template you can git diff: facts defined once and cited by key, a canonical resume with tailored variants per job, and Claude Code skills for the workflow.",
    "lang.switch": "中文",
    "header.tagline":
      "A LaTeX resume you can <code>git diff</code>, tailored per job with Claude Code.",
    "theme.label": "Dark",
    "theme.suffix": " theme",

    // The film (film.js).
    "film.label": "The my-resume film: a scripted replay of the workflow",
    "film.role": "demo",
    "film.controls": "Film controls",
    "film.prev": "Previous scene",
    "film.next": "Next scene",
    "film.play": "Play",
    "film.pause": "Pause",
    "film.chapter": "Scene {n}: {name}",
    "film.replay": "replay",
    "film.replayTitle": "A scripted replay of the workflow, not live output",
    "film.transcriptTitle": "What the film shows",
    "film.transcriptItem": "Scene {n}, {name}: {caption}",
    "film.live": "Scene {n} of {count}, {name}: {caption}",

    // The scenes (scenes.js): chapter names, captions (*word* is highlighted), transcripts.
    "scene.problem.name": "The problem",
    "scene.problem.caption": "Every job wants a *different* resume.",
    "scene.problem.transcript": [
      "Three copies of one resume lie on the desk: resume_v2.pdf, resume_final.pdf, and resume_FINAL_v3.pdf, each with a different headline.",
      "A pen note asks: which one is true? Duna, a gray tabby, swats the newest copy off the pile.",
    ],
    "scene.meet.name": "Meet Duna",
    "scene.meet.caption": "Meet Duna.",
    "scene.meet.transcript": [
      "Duna’s canonical resume: two pages with every role, project, paper, and award she has, each fact written once and cited by key.",
      "She waves: hi, I’m Duna. The camera moves in on one role header, Head of Windowsill Operations at Sunbeam Estates.",
    ],
    "scene.job.name": "The job",
    "scene.job.caption": "Then the *dream job* shows up.",
    "scene.job.transcript": [
      "A posting: Senior Mouser, Rodent Operations, at Granary & Sons. Night patrol, early detection, box inspection, and training the barn’s younger cats; published research on rodent detection preferred.",
      "The pen circles what it asks for, and Duna jumps for joy: THE dream job.",
    ],
    "scene.prompt.name": "The prompt",
    "scene.prompt.caption": "She asks Claude to *tailor* it.",
    "scene.prompt.transcript": [
      "Duna types one line into Claude Code: /customize-resume https://example.com/careers/senior-mouser.",
      "Claude fetches the posting (Received 2.1KB, 200 OK), runs just new granary senior-mouser, which creates applications/2026-09-granary-senior-mouser, and writes 37 lines to jd.md, the job description summary.",
    ],
    "scene.plan.name": "The plan",
    "scene.plan.caption": "Claude *asks first*.",
    "scene.plan.transcript": [
      "Claude maps the job’s signals to evidence already in her resume: night patrol and early rodent detection to monitoring 400+ birds a day at Sunbeam (lead with it); fast response to chirping alerts in under 2 seconds (summary); box inventory inspection to 1,200 boxes inspected at Cardboard (keep first); training younger cats to mentoring two younger cats (move up); rodent-detection research to ACWS 2019, Best Paper (keep only this paper).",
      "To fit one page it would drop Service, Honors, two projects, and three papers. It asks: Proceed with this plan? Duna slow-blinks and picks 1. Yes. A pen note: asks first, no fibs.",
    ],
    "scene.tailor.name": "Tailoring",
    "scene.tailor.caption": "The resume *rewrites itself*.",
    "scene.tailor.transcript": [
      "Back at her resume, the pen strikes the 5 a.m. breakfast and dog-treaty bullets (the dog stays off this one) and the Service and Honors sections.",
      "The resume rewrites itself into the Granary variant: a new headline, bird monitoring moved up to the first bullet, mentoring after it, and two pages folded into one.",
    ],
    "scene.ship.name": "Shipped",
    "scene.ship.caption": "One page. *Tagged*. Sent.",
    "scene.ship.transcript": [
      "One page. The replica gives way to the real PDF, built by CI from this commit.",
      "Nangnang, a brown tabby, stamps the git tag submitted/2026-09-granary-senior-mouser with her paw: checking out the tag and building it gives back exactly what was sent.",
    ],
    "scene.update.name": "The update",
    "scene.update.caption": "She got the *job*. 🎉",
    "scene.update.transcript": [
      "Duna types /update-resume Got the job: Senior Mouser at Granary & Sons. Claude asks before it writes any date: What is the start date (YYYY-MM) and location, and when did your Sunbeam role end?",
      "She answers: 2026-11, the grain warehouse; Sunbeam ended 2026-10. First bullet: patrols 40 tons of grain on night shifts. A pen note: asks, never guesses.",
      "Claude updates common/facts/roles.tex and canonical/resume.tex, and the new role, Senior Mouser at Granary & Sons, Nov 2026 – Present, lands on top of her experience. Dudu, a gray cat, cheers; confetti falls; Duna jumps for joy.",
    ],
    "scene.cta.name": "Make it yours",
    "scene.cta.caption": "Make it *yours*.",
    "scene.cta.transcript": [
      "Use this template on GitHub to start your own: free, MIT licensed, no cats required. Duna waves goodbye.",
    ],

    // The pen's notes in the film ("\n" breaks a line; emoji are decoration).
    "note.which": "which one is true? 🙀",
    "note.hi": "hi, I’m Duna 👋",
    "note.complete": "one complete resume",
    "note.once": "every fact\nwritten once",
    "note.dream": "THE dream job 😻",
    "note.paw": "one line. one paw. 🐾",
    "note.fibs": "asks first. no fibs. 🐟",
    "note.dog": "the dog stays\noff this one 🐶",
    "note.up": "moved up!",
    "note.real": "the real PDF,\nfrom this commit",
    "note.asks": "asks, never guesses",
    "note.free": "free, MIT,\nno cats required 🐾",

    // Claude's replies in the terminal, and Duna's answer (her commands stay as typed).
    "term.plan.intro": "JD signals, mapped to evidence in canonical:",
    "term.plan.head": ["JD signal", "Evidence", "Change"],
    "term.plan.signal.1": "Night patrol, early rodent detection",
    "term.plan.signal.2": "Fast response, incident reporting",
    "term.plan.signal.3": "Box inventory inspection",
    "term.plan.signal.4": "Training younger cats",
    "term.plan.signal.5": "Rodent-detection research",
    "term.plan.change.1": "Lead with it",
    "term.plan.change.2": "Summary",
    "term.plan.change.3": "Keep first",
    "term.plan.change.4": "Move up",
    "term.plan.change.5": "Keep only this paper",
    "term.plan.fit": "To fit one page: drop Service, Honors, two projects, and three papers.",
    "term.approve.question": "Proceed with this plan?",
    "term.approve.options": ["Yes", "Adjust the plan"],
    "term.update.ask":
      "What is the start date (YYYY-MM) and location, and when did your Sunbeam role end?",
    "term.update.answer":
      "2026-11, the grain warehouse; Sunbeam ended 2026-10. First bullet: patrols 40 tons of grain on night shifts",

    // Scene 9's call to action.
    "cta.template": "Use this template",
    "cta.github": "GitHub",

    // The page below the film (index.html).
    "template.title": "The template",
    "template.lead":
      "One class file owns the layout; a resume file holds only content. These are the real pages, built by CI from this commit: Duna's complete canonical resume, and the one-page variant tailored for a job.",
    "template.page1.alt": "Canonical resume, page 1",
    "template.page1.caption": "Canonical, page 1",
    "template.page2.alt": "Canonical resume, page 2",
    "template.page2.caption": "Canonical, page 2",
    "template.tailored.alt": "Resume tailored for one job, page 1",
    "template.tailored.caption": "Tailored for one job",
    "template.notice": "What to notice, from the top of a page down:",
    "tour.tabs.title": "Section tabs",
    "tour.tabs.text":
      "Each section opens with a graphite tab and a rule to the margin. Sections always print in the same order (Summary, Experience, Projects, Education, Publications, Service, Honors &amp; Awards), whatever the order in the source; leave one out to drop it.",
    "tour.tabs.alt": "Close-up of page 1: the Experience tab",
    "tour.spine.title": "A timeline spine",
    "tour.spine.text":
      "Roles and projects hang off one line, a ring for each entry, and the line keeps going across a page break.",
    "tour.spine.alt": "Close-up of page 1: the spine beside two roles",
    "tour.dates.title": "Date pills",
    "tour.dates.text":
      'Dates are written once as <code>2023-04</code> or <code>present</code>; the class prints them as <span class="pill">Apr 2023 – Present</span>.',
    "tour.dates.alt": "Close-up of page 1: the date pill Apr 2023 – Present",
    "tour.keys.title": "Facts cited by key",
    "tour.keys.text":
      "A role's title, employer, place, and dates are defined once in <code>common/facts/</code> and cited by key, so every variant prints them the same way.",
    "tour.keys.note": "same key",
    "tour.keys.alt":
      "Close-up of page 1: the role header Head of Windowsill Operations, Sunbeam Estates, Living Room",
    "tour.typo.title": "A typo fails the build",
    "tour.typo.text":
      "Cite <code>windowsil</code> instead of <code>windowsill</code> and the build stops with an error that names it. So do a missing field, a duplicate section, and a date like <code>2024-13</code>.",
    "tour.typo.note": "one “l” short",
    "tour.breaks.title": "No stranded titles",
    "tour.breaks.text":
      'Pages break between bullets, never between a role\'s title and its first bullet or between a heading and its first entry. A test moves the content through <span data-pen="underline">51 page positions</span> to check.',
    "how.title": "How it works",
    "how.lead":
      "One complete resume, a tailored copy for each job, and git to remember what you sent.",
    "how.facts.note": "written once",
    "how.facts.title": "Facts, written once",
    "how.facts.text":
      "Roles, projects, degrees, publications, service, and honors are defined once in <code>common/facts/</code> and cited by key. A wrong key, a missing field, or a bad date stops the build, so a title or a date can't drift between variants.",
    "how.plan.note": "asks first. no fibs. 🐟",
    "how.plan.question": "Proceed with this plan?",
    "how.plan.yes": "1. Yes",
    "how.plan.adjust": "&nbsp; 2. Adjust the plan",
    "how.plan.title": "<code>/customize-resume</code> tailors, with your approval",
    "how.plan.text":
      "Give Claude Code a job posting. It saves a summary as <code>jd.md</code> in a new application folder, maps what the job asks for to evidence already in your resume, and stops for your approval before it edits. An ask with no evidence is marked as such, never invented.",
    "how.history.note": "kept as sent",
    "how.history.title": "<code>/update-resume</code> and tags keep history",
    "how.history.text":
      "New experience goes into the facts and the canonical resume, and Claude asks for any date or title it doesn't have. Each application is a folder; tag it <code>submitted/…</code> when you send it, and checking out the tag and building it gives back what you sent (with the same TeX Live).",
    "start.title": "Get started",
    "start.lead": "Use the repo as a template and clone your copy. Then, on macOS with Homebrew:",
    "start.prose":
      "To make it yours, put your details in <code>common/profile.tex</code> and <code>common/facts/</code> (or run <code>/update-resume</code> in Claude Code and let it ask for them), and rewrite <code>canonical/resume.tex</code>. For a job, run <code>/customize-resume</code> with the posting.",
    "start.repo": "The repository on GitHub",
    "start.repo.about": "the source and the full README",
    "start.rules.about": "the rules Claude follows, starting with: never invent or inflate a claim",
    "start.customize": "The customize-resume skill",
    "start.customize.about": "tailors a variant to a job posting, and stops for your approval",
    "start.update": "The update-resume skill",
    "start.update.about": "adds new experience to the facts and the canonical resume",
    "credits.title": "Credits",
    "credits.duna.name": "Duna Feline",
    "credits.duna.text":
      "The star, and the owner of the sample resume: a gray tabby with amber eyes. Duna Feline is fictional. Her name is half of each of her co-stars:",
    "credits.duna.name-sum": '<span data-pen="underline">Duna = Du(du) + Na(ngnang)</span>',
    "credits.dudu.name": "Dudu",
    "credits.dudu.text":
      "Solid gray, green eyes. Co-author of Duna's papers; cheers when she gets the job.",
    "credits.nangnang.name": "Nangnang",
    "credits.nangnang.text": "A brown tabby. Co-author too; stamps the tag when a resume goes out.",
    "credits.fine":
      'my-resume is under the <a href="https://github.com/h1994st/my-resume/blob/main/LICENSE">MIT license</a>. Fonts: Source Serif 4 and Source Sans 3 for the resume, and Caveat for the pen, all under the <a href="https://github.com/h1994st/my-resume/blob/main/fonts/SourceSerif4/LICENSE.md">SIL Open Font License</a> (<a href="fonts/caveat/OFL.txt">Caveat\'s license</a>).',
  },

  zh: {
    "head.title": "my-resume：能 git diff 的 LaTeX 简历",
    "head.description":
      "一个能 git diff 的 LaTeX 简历模板：事实只定义一次、按键引用；一份主简历，为每份工作派生定制版；再配上 Claude Code 技能，串起整个流程。",
    "lang.switch": "EN",
    "header.tagline": "能 <code>git diff</code> 的 LaTeX 简历，用 Claude Code 为每份工作量身定制。",
    "theme.label": "深色",
    "theme.suffix": "模式",

    "film.label": "my-resume 短片：按脚本回放的工作流程",
    "film.role": "演示",
    "film.controls": "短片控制",
    "film.prev": "上一幕",
    "film.next": "下一幕",
    "film.play": "播放",
    "film.pause": "暂停",
    "film.chapter": "第 {n} 幕：{name}",
    "film.replay": "回放",
    "film.replayTitle": "按脚本回放的工作流程，不是实时输出",
    "film.transcriptTitle": "短片内容",
    "film.transcriptItem": "第 {n} 幕，{name}：{caption}",
    "film.live": "第 {n} 幕（共 {count} 幕），{name}：{caption}",

    "scene.problem.name": "难题",
    "scene.problem.caption": "每份工作，都想要一份*不一样*的简历。",
    "scene.problem.transcript": [
      "桌上摊着同一份简历的三个副本：resume_v2.pdf、resume_final.pdf 和 resume_FINAL_v3.pdf，每份的头衔都不一样。",
      "一张笔记问：哪份才是真的？灰色虎斑猫嘟娜一爪子把最新的那份拍下了纸堆。",
    ],
    "scene.meet.name": "认识嘟娜",
    "scene.meet.caption": "认识一下嘟娜。",
    "scene.meet.transcript": [
      "嘟娜的主简历：两页纸，写着她所有的职位、项目、论文和奖项，每条事实只写一次，按键引用。",
      "她挥挥爪：嗨，我是嘟娜。镜头推近一个职位标题：Sunbeam Estates 的 Head of Windowsill Operations。",
    ],
    "scene.job.name": "机会",
    "scene.job.caption": "然后，*梦想工作*出现了。",
    "scene.job.transcript": [
      "一则招聘：Granary & Sons 招 Senior Mouser, Rodent Operations。要夜间巡逻、及早发现鼠情、检查纸箱，还要带粮仓里的小猫；发表过鼠类探测研究者优先。",
      "笔圈出了招聘要的几样，嘟娜高兴得跳了起来：梦中情岗！",
    ],
    "scene.prompt.name": "一行指令",
    "scene.prompt.caption": "她请 Claude 来*量身定制*。",
    "scene.prompt.transcript": [
      "嘟娜在 Claude Code 里输入一行：/customize-resume https://example.com/careers/senior-mouser。",
      "Claude 抓取招聘页面（Received 2.1KB (200 OK)），运行 just new granary senior-mouser，新建 applications/2026-09-granary-senior-mouser，再把 37 行职位摘要写进 jd.md。",
    ],
    "scene.plan.name": "计划",
    "scene.plan.caption": "Claude *先问*，再动手。",
    "scene.plan.transcript": [
      "Claude 把职位的每项要求对上她简历里已有的证据：夜间巡逻、及早发现鼠情，对应在 Sunbeam 每天盯着 400 多只鸟（放在最前）；快速响应，对应 2 秒内发出啾啾警报（写进摘要）；检查纸箱，对应在 Cardboard 检查过 1,200 个纸箱（保持第一）；带教小猫，对应带过两只小猫（往前提）；鼠类探测研究，对应 ACWS 2019 最佳论文（只留这一篇）。",
      "为了压到一页，它打算删去 Service、Honors、两个项目和三篇论文。它问：按这个计划进行吗？嘟娜慢慢眨了眨眼，选了“1. 是”。一张笔记写着：先问再改，不吹牛。",
    ],
    "scene.tailor.name": "定制",
    "scene.tailor.caption": "简历*自己改写*了。",
    "scene.tailor.transcript": [
      "回到她的简历，笔划掉了凌晨 5 点叫早餐和与狗签约那两条（这份简历不带狗玩），还有 Service 和 Honors 两节。",
      "简历自己改写成 Granary 版：头衔换了新的，盯鸟那条提到第一，带小猫的紧随其后，两页折成了一页。",
    ],
    "scene.ship.name": "投出",
    "scene.ship.caption": "一页。*打标签*。投出。",
    "scene.ship.transcript": [
      "一页纸。复刻的简历换成了真正的 PDF，由 CI 从这次提交构建。",
      "棕色虎斑猫囔囔用爪子盖下 git 标签 submitted/2026-09-granary-senior-mouser：日后检出这个标签再构建，得到的正是当初投出去的那份。",
    ],
    "scene.update.name": "更新",
    "scene.update.caption": "她*拿到工作*了！🎉",
    "scene.update.transcript": [
      "嘟娜输入 /update-resume Got the job: Senior Mouser at Granary & Sons。Claude 写下任何日期之前都先问：入职日期（YYYY-MM）和地点是？Sunbeam 那份工作哪个月结束的？",
      "她回答：2026-11，粮仓；Sunbeam 到 2026-10 结束。第一条写：patrols 40 tons of grain on night shifts。一张笔记写着：问清楚，不瞎猜。",
      "Claude 更新了 common/facts/roles.tex 和 canonical/resume.tex，新职位 Granary & Sons 的 Senior Mouser（Nov 2026 – Present）落在她经历的最上方。灰猫嘟嘟欢呼，彩纸纷飞，嘟娜高兴得跳了起来。",
    ],
    "scene.cta.name": "轮到你",
    "scene.cta.caption": "把它变成*你的*。",
    "scene.cta.transcript": [
      "在 GitHub 上用这个模板，开始写你自己的简历：免费，MIT 许可，无需自备猫。嘟娜挥手道别。",
    ],

    "note.which": "哪份才是真的？🙀",
    "note.hi": "嗨，我是嘟娜 👋",
    "note.complete": "一份完整的简历",
    "note.once": "每条事实\n只写一次",
    "note.dream": "梦中情岗！😻",
    "note.paw": "一行字，一爪搞定 🐾",
    "note.fibs": "先问再改，不吹牛 🐟",
    "note.dog": "这份简历\n不带狗玩 🐶",
    "note.up": "置顶了！",
    "note.real": "真正的 PDF，\n来自这次提交",
    "note.asks": "问清楚，不瞎猜",
    "note.free": "免费，MIT，\n无需自备猫 🐾",

    "term.plan.intro": "JD 要求与 canonical 中的证据对照：",
    "term.plan.head": ["JD 要求", "证据", "改动"],
    "term.plan.signal.1": "夜间巡逻，及早发现鼠情",
    "term.plan.signal.2": "快速响应，上报事件",
    "term.plan.signal.3": "检查纸箱库存",
    "term.plan.signal.4": "带教小猫",
    "term.plan.signal.5": "鼠类探测研究",
    "term.plan.change.1": "放在最前",
    "term.plan.change.2": "写进摘要",
    "term.plan.change.3": "保持第一",
    "term.plan.change.4": "往前提",
    "term.plan.change.5": "只留这篇",
    "term.plan.fit": "为了压到一页：删去 Service、Honors、两个项目和三篇论文。",
    "term.approve.question": "按这个计划进行吗？",
    "term.approve.options": ["是", "调整计划"],
    "term.update.ask": "入职日期（YYYY-MM）和地点是？Sunbeam 那份工作哪个月结束的？",
    "term.update.answer":
      "2026-11，粮仓；Sunbeam 到 2026-10 结束。第一条写：patrols 40 tons of grain on night shifts",

    "cta.template": "使用这个模板",
    "cta.github": "GitHub",

    "template.title": "模板",
    "template.lead":
      "版式全交给一个类文件，简历文件里只放内容。下面是 CI 从这次提交构建出的真实页面：嘟娜完整的主简历（canonical），以及为一份工作定制的一页版。",
    "template.page1.alt": "主简历，第 1 页",
    "template.page1.caption": "主简历，第 1 页",
    "template.page2.alt": "主简历，第 2 页",
    "template.page2.caption": "主简历，第 2 页",
    "template.tailored.alt": "为一份工作定制的简历，第 1 页",
    "template.tailored.caption": "为一份工作定制",
    "template.notice": "从页面顶部往下看，值得留意的有：",
    "tour.tabs.title": "章节标签",
    "tour.tabs.text":
      "每一节都以一枚石墨色标签开头，一条细线延伸到页边。不管源文件里怎么排，各节总按同样的顺序印出（Summary、Experience、Projects、Education、Publications、Service、Honors &amp; Awards）；不写哪一节，就没有哪一节。",
    "tour.tabs.alt": "第 1 页特写：Experience 标签",
    "tour.spine.title": "一条时间线",
    "tour.spine.text":
      "职位和项目都挂在同一条竖线上，每个条目一个圆环；遇到分页，这条线也接着往下走。",
    "tour.spine.alt": "第 1 页特写：两个职位旁的时间线",
    "tour.dates.title": "日期胶囊",
    "tour.dates.text":
      '日期只写一次，形如 <code>2023-04</code> 或 <code>present</code>；类文件把它印成 <span class="pill">Apr 2023 – Present</span>。',
    "tour.dates.alt": "第 1 页特写：日期胶囊 Apr 2023 – Present",
    "tour.keys.title": "事实按键引用",
    "tour.keys.text":
      "职位的头衔、雇主、地点和日期都只在 <code>common/facts/</code> 里定义一次，再按键引用，所以每个版本印出来都一模一样。",
    "tour.keys.note": "同一个键",
    "tour.keys.alt":
      "第 1 页特写：职位标题 Head of Windowsill Operations, Sunbeam Estates, Living Room",
    "tour.typo.title": "一处笔误，构建就停",
    "tour.typo.text":
      "把 <code>windowsill</code> 错写成 <code>windowsil</code>，构建就会停下，报错里点名这个键。缺字段、重复的节、<code>2024-13</code> 这样的日期，也都一样。",
    "tour.typo.note": "少了一个 “l”",
    "tour.breaks.title": "标题不落单",
    "tour.breaks.text":
      '分页只落在要点之间，绝不会把职位标题和它的第一条要点拆开，也不会让节标题和第一个条目分家。有个测试把内容挪过 <span data-pen="underline">51 个分页位置</span>来验证。',
    "how.title": "运作方式",
    "how.lead": "一份完整的简历，每份工作一份定制版，再让 git 记住你投出去的是哪一份。",
    "how.facts.note": "只写一次",
    "how.facts.title": "事实，只写一次",
    "how.facts.text":
      "职位、项目、学位、论文、学术服务和荣誉都只在 <code>common/facts/</code> 里定义一次，按键引用。键写错、缺字段、日期不对，构建都会停下，所以头衔和日期不会在各版本之间走样。",
    "how.plan.note": "先问再改，不吹牛 🐟",
    "how.plan.question": "按这个计划进行吗？",
    "how.plan.yes": "1. 是",
    "how.plan.adjust": "&nbsp; 2. 调整计划",
    "how.plan.title": "<code>/customize-resume</code> 来定制，你点头才动手",
    "how.plan.text":
      "把职位描述交给 Claude Code。它在新的申请文件夹里存一份摘要 <code>jd.md</code>，把职位的每项要求对上你简历里已有的证据，动手修改前先停下来等你批准。找不到证据的要求会如实标出，绝不编造。",
    "how.history.note": "原样存档",
    "how.history.title": "<code>/update-resume</code> 和标签留住历史",
    "how.history.text":
      "新经历写进事实库和主简历；缺哪个日期或头衔，Claude 都会先问你。每次申请是一个文件夹；投出时打上 <code>submitted/…</code> 标签，日后检出这个标签再构建，就能还原当初投出的那份（TeX Live 版本相同即可）。",
    "start.title": "开始使用",
    "start.lead": "用这个仓库作模板创建你自己的副本，克隆下来。然后在装了 Homebrew 的 macOS 上：",
    "start.prose":
      "要把它变成你的简历：把你的信息填进 <code>common/profile.tex</code> 和 <code>common/facts/</code>（或者在 Claude Code 里运行 <code>/update-resume</code>，让它来问你），再重写 <code>canonical/resume.tex</code>。要投某份工作时，带上职位描述运行 <code>/customize-resume</code>。",
    "start.repo": "GitHub 上的仓库",
    "start.repo.about": "源码和完整的 README",
    "start.rules.about": "Claude 遵守的规则，第一条就是：绝不编造或夸大任何经历",
    "start.customize": "customize-resume 技能",
    "start.customize.about": "按职位描述定制一个版本，并停下来等你批准",
    "start.update": "update-resume 技能",
    "start.update.about": "把新经历加进事实库和主简历",
    "credits.title": "演职员表",
    "credits.duna.name": "嘟娜·菲琳",
    "credits.duna.text":
      "主演，也是示例简历的主人：一只琥珀色眼睛的灰色虎斑猫。嘟娜·菲琳是虚构的。她的名字各取自两位搭档：",
    "credits.duna.name-sum":
      '<span data-pen="underline">嘟娜 = 嘟嘟的“嘟”</span> <span data-pen="underline">+ 囔囔的“na”（娜）</span>',
    "credits.dudu.name": "嘟嘟",
    "credits.dudu.text": "一身纯灰，绿眼睛。嘟娜论文的合著者；她拿到工作时负责欢呼。",
    "credits.nangnang.name": "囔囔",
    "credits.nangnang.text": "一只棕色虎斑猫。也是合著者；简历投出时，由她盖下标签。",
    "credits.fine":
      'my-resume 采用 <a href="https://github.com/h1994st/my-resume/blob/main/LICENSE">MIT 许可证</a>。字体：简历用 Source Serif 4 和 Source Sans 3，笔迹用 Caveat 和霞鹜文楷（LXGW WenKai），均采用 <a href="https://github.com/h1994st/my-resume/blob/main/fonts/SourceSerif4/LICENSE.md">SIL 开源字体许可证</a>（<a href="fonts/caveat/OFL.txt">Caveat 的许可证</a>、<a href="fonts/wenkai/OFL.txt">霞鹜文楷的许可证</a>）。',
  },
};

const isLang = (lang) => LANGS.includes(lang);
const other = (lang) => (lang === "zh" ? "en" : "zh");

export function currentLang() {
  if (typeof document === "undefined") return "en";
  return document.documentElement.dataset.lang === "zh" ? "zh" : "en";
}

export function t(id, vars, lang = currentLang()) {
  let s = STRINGS[lang]?.[id] ?? STRINGS.en[id];
  if (s === undefined) {
    console.error(`i18n: no string "${id}"`);
    return id;
  }
  if (vars && typeof s === "string") {
    s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }
  return s;
}

// localStorage can be missing or throw (private windows, blocked storage).
function stored() {
  try {
    const value = localStorage.getItem(KEY);
    return isLang(value) ? value : null;
  } catch {
    return null;
  }
}

function store(lang) {
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    // The choice then lasts for this page only.
  }
}

// As index.html's head script decides it: ?lang=, else the stored choice, else English.
function chosen() {
  const asked = new URLSearchParams(location.search).get("lang");
  return isLang(asked) ? asked : (stored() ?? "en");
}

function setRoot(lang) {
  const root = document.documentElement;
  root.dataset.lang = lang;
  root.lang = TAGS[lang];
}

// Puts the language's strings on the page: [data-i18n] content, [data-i18n-attr] attributes,
// the title and the description.
function apply() {
  for (const el of document.querySelectorAll("[data-i18n]")) el.innerHTML = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of el.dataset.i18nAttr.trim().split(/\s+/)) {
      const [attr, id] = pair.split(":");
      el.setAttribute(attr, t(id));
    }
  }
  document.title = t("head.title");
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute("content", t("head.description"));
}

// The toggle names the language it switches to, in that language.
function renderToggle() {
  const label = document.querySelector("#lang-toggle [lang]");
  if (!label) return;
  label.textContent = t("lang.switch");
  label.lang = TAGS[other(currentLang())];
}

export function initLang({ onChange } = {}) {
  const root = document.documentElement;
  // The head script normally did this already; repeat it in case it could not run.
  if (!isLang(root.dataset.lang)) setRoot(chosen());
  if (currentLang() !== "en") apply(); // the page's own text is English
  renderToggle();
  root.classList.add("i18n-ready");

  document.getElementById("lang-toggle")?.addEventListener("click", () => {
    const next = other(currentLang());
    setRoot(next);
    store(next);
    // A ?lang= would win over the choice on a reload: drop it.
    const url = new URL(location.href);
    if (url.searchParams.has("lang")) {
      url.searchParams.delete("lang");
      history.replaceState(history.state, "", url);
    }
    apply();
    renderToggle();
    onChange?.(next);
  });
  return { lang: currentLang };
}

export function loadLangFonts(lang = currentLang()) {
  if (lang !== "zh" || typeof document === "undefined") return Promise.resolve();
  return Promise.all([
    document.fonts.load('400 26px "LXGW WenKai"', "嘟娜"),
    document.fonts.load('600 26px "LXGW WenKai"', "嘟娜"),
  ]).catch(() => {});
}
