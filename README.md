# my-resume project site

The source of https://shengtuo.me/my-resume/, the launch film and product page for the
[my-resume](https://github.com/h1994st/my-resume) template. It lives on this orphan `site` branch so
that copies made with "Use this template" (which take only `main`) never get it.

## How it deploys

- `main`'s CI builds the resumes. After a green build of `main` in `h1994st/my-resume`, it
  dispatches [`pages.yml`](.github/workflows/pages.yml) here with that run's id.
- `pages.yml` checks out `main` at that commit into `template/`, downloads the run's PDFs, runs the
  honesty check (`site/check.sh`) and the browser tests' smoke tier, assembles `build/site/`, and
  deploys it to GitHub Pages. A push to this branch republishes with the latest green build of
  `main`; a manual run can pick the full test tier.

## Working locally

Keep a checkout of `main` at `template/` (git-ignored), for example as a symlink to your main
worktree, and build its resumes first:

```bash
ln -s ../my-resume template                 # or set TEMPLATE_DIR
(cd template && just build && just build applications/2026-09-granary-senior-mouser)
site/check.sh template                      # replica text is in the real PDFs
site/assemble.sh build/site                 # site + fonts + PDFs + page images + sitemap
node site/tests/browser.mjs                 # full tier locally; CI runs the smoke tier
python3 -m http.server -d build/site 8765   # then open http://127.0.0.1:8765/
```

## Languages

The site is in English and Chinese (`?lang=zh` for one visit, or the header toggle). Every string is
in [`site/i18n.js`](site/i18n.js), one table per language; the resume replica, the PDFs, and the
terminal's commands and output stay English. The Chinese pen notes use a subset of
[LXGW WenKai](https://github.com/lxgw/LxgwWenKai) (SIL OFL) with only the characters the Chinese
strings use. After changing a Chinese string, regenerate it (the browser tests fail until you do):

```bash
python3 -m venv build/venv && build/venv/bin/pip install fonttools brotli   # once
PYTHON=build/venv/bin/python site/fonts/wenkai/subset.sh
```
