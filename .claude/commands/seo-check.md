---
name: SEO Check
description: Quick SEO audit of a page or the whole site. Use when user says check seo, seo audit, check page seo.
---

Run a quick SEO check on $ARGUMENTS or all HTML files if no argument given.

For each file check:
1. Title tag — exists, under 60 chars
2. Meta description — exists, under 160 chars
3. Canonical URL — points to www.getkibbo.com
4. Google Analytics tag — present in head
5. Google Fonts import — present in head
6. H1 — exactly one per page
7. Author line — present in blog articles
8. sitemap.xml — page URL is listed

Report: OK / MISSING / NEEDS ATTENTION for each check.

Fix any issues found automatically, then commit and push.
