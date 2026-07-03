---
name: New Page
description: Create a new HTML page using the site design system. Use when user says create page, new page, add page.
---

Create a new HTML page at the path in $ARGUMENTS.

Use exactly the same structure as `index.html`:
1. Same head with Google Analytics, Google Fonts, styles.css
2. Same nav with all links
3. Same footer
4. Add a page hero section below nav with padding-top 64px.
5. Add the new URL to `sitemap.xml` with today's date as lastmod.
6. Commit and push:
   ```
   git add .
   git commit -m "Add page: [page name]"
   git push origin main
   ```
7. REMIND user to do Request Indexing in Google Search Console for the new URL.
