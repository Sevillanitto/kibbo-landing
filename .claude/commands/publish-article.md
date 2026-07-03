---
name: Publish Article
description: Adapt a blog HTML file to match the site style, add it to blog.html, update sitemap, commit and push. Use when user says publish article, upload article, add article to blog.
---

Take the HTML file provided in $ARGUMENTS.

1. Open the file and read its content.
2. Compare its nav, footer, head tags and CSS classes against an existing blog article to check alignment.
3. If nav, footer, Google Analytics or Google Fonts are missing or different — fix them to match exactly.
4. Make sure the author-line div uses the correct author image from `images/authors/`.
5. Open `blog.html` and add a new article card at the top of the articles grid matching the exact format of existing cards. Use the title, date, description and author from the article file.
6. Open `sitemap.xml` and add the new URL with today's date as lastmod.
7. Commit and push:
   ```
   git add .
   git commit -m "Publish article: [article title]"
   git push origin main
   ```
8. Report the live URL: https://www.getkibbo.com/blog/[filename]
9. REMIND the user to do Request Indexing in Google Search Console for the new URL.
