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

## Nav order
KIBBO | Analyze | Generate | Templates | Directory | Dev Tools | Blog | Get tools →

## Footer
- Left: © 2026 · Built by Carlos Lopez, an independent developer
- Right: Try TrapMart — see dark patterns in action → (/demo.html)

## Gumroad base URL
https://carlosdevlop.gumroad.com/l/
