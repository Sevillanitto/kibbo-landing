# getkibbo.com — Claude Code Context

## Project
Consumer protection platform. Static HTML site deployed on Vercel.
Repo: github.com/Sevillanitto/kibbo-landing (THE ONLY REPO THAT NEEDS COMMITS)
Live: https://www.getkibbo.com

## Stack
Pure HTML + CSS + Vanilla JS. No frameworks.
- `styles.css` — single shared stylesheet with CSS variables
- Vercel deployment — git push to main = live in seconds
- Cloudflare Workers for backend (supplement analyzer)
- Google Analytics: G-N0QKW8L27Y (must be in every HTML file head)
- Google Fonts: Syne + Inter (must be in every HTML file head)

## Structure
```
kibbo-landing/
├── index.html          # Home
├── styles.css          # All styles — edit here only
├── blog/               # Blog articles
├── directory/          # 8 free resource pages
├── templates/          # Template product pages
├── images/
│   ├── authors/        # carlos-lopez.jpg + margaret-spencer-breen.jpg
│   └── hero-illustration.svg
├── analyze.html
├── generate.html
├── templates.html
├── directory.html
├── developer-tools.html
├── supplement-analyzer.html
├── blog.html
├── about.html
├── sitemap.xml
└── CLAUDE.md
```

## Design System (NEVER change these values)
```
--bg: #F7F5F0
--bg-dark: #141210
--accent-green: #3D6B4F
--accent-amber: #C8922A
--accent-terra: #B85C3A
--font-serif: 'Syne', system-ui, sans-serif
--font-sans: 'Inter', system-ui, sans-serif
```

## Authors
- Carlos Lopez → `images/authors/carlos-lopez.jpg` → technical articles
- Margaret Spencer Breen → `images/authors/margaret-spencer-breen.jpg` → consumer articles
- Both link to `/about.html`

## Rules
1. Every HTML file MUST have Google Analytics in head
2. Every HTML file MUST have Google Fonts import in head
3. Every HTML file MUST have the same nav and footer as index.html
4. sitemap.xml must be updated when any new page is added
5. Never break existing internal links
6. Always commit with a clear message and push to main
7. CLAUDE.md stays under 200 lines
8. Before publishing any new content (article, template, analyzer, generator, or checklist), read PUBLISHING-PROTOCOL.md and follow its checklist for that content type.
9. When drafting an article with a "Related Kibbo Tools" section, tag it with `CROSSLINK_TAGS` (see Cross-Linking Workflow below) instead of hand-writing the links or a descriptive placeholder comment.

## Cross-Linking Workflow
Cross-links for "Related Kibbo Tools" sections are generated deterministically from `cross-link-map.json`, not reasoned about per-article. See `scripts/inject-cross-links.py` for full usage docs (`--help` or the file's docstring).

**Adding a new template/generator/checklist to the map** — once it's live (URL confirmed 200, not before):
1. Open `cross-link-map.json`, find the block (e.g. `housing-rentals`).
2. Add `{"type": "template"|"generator"|"checklist", "name": "...", "url": "https://www.getkibbo.com/..."}` to an existing tag's array, or add a new short kebab-case tag if none fits the topic (e.g. `deposit-dispute`, `habitability`).
3. Commit the JSON change — no code changes needed elsewhere.

**Tagging a draft article:**
1. Inside the "Related Kibbo Tools" section, keep (or add) the placeholder: `<!-- Claude Code: link ... here once URLs confirmed live -->`.
2. Add one marker line anywhere in the file: `<!-- CROSSLINK_TAGS: tag1, tag2 -->` — comma-separated, using tags that exist in `cross-link-map.json` for that block.

**Running the script before a publishing prompt:**
```
python scripts/inject-cross-links.py _drafts-pending/<batch-folder> <block-key> --dry-run   # preview first
python scripts/inject-cross-links.py _drafts-pending/<batch-folder> <block-key>             # writes files
```
It reports any tag with no match in the JSON instead of guessing — add the entry to `cross-link-map.json` and re-run rather than hand-writing the link.

## Nav order
KIBBO | Analyze | Generate | Templates | Directory | Dev Tools | Blog | Get tools →

## Footer
- Left: © 2026 · Built by Carlos Lopez, an independent developer
- Right: Try TrapMart — see dark patterns in action → (/demo.html)

## Gumroad base URL
https://carlosdevlop.gumroad.com/l/
