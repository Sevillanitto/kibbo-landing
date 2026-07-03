---
name: Export for Dev.to
description: Convert a blog HTML article to Markdown ready to paste in Dev.to with canonical URL. Use when user says export devto, prepare devto, devto version.
---

Take the HTML file in $ARGUMENTS.

1. Read the full article content.
2. Convert to clean Markdown — headings, paragraphs, code blocks with language tags.
3. Add this frontmatter at the top:
   ```
   ---
   title: "[article title]"
   published: true
   description: "[meta description from the HTML]"
   tags: webdev, javascript, security, consumer-protection
   canonical_url: https://getkibbo.com/blog/[filename]
   ---
   ```
4. Strip all HTML tags, nav, footer, head. Keep only article body content.
5. Save as `[filename]-devto.md` in the `blog/` folder.
6. Remind the user: publish on getkibbo.com FIRST, then paste on Dev.to.
