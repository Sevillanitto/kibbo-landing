Add one or more new templates (Word/Excel/PDF products) to templates.html and their product pages. The user will paste the template spec(s) after this command (format, page path, price, what the static document contains).

Follow PUBLISHING-PROTOCOL.md's "New TEMPLATE" section:

1. Create the product page at the given path, matching the existing template card/page pattern (design system, GA, fonts, nav, footer).
2. Add the card to templates.html with the correct badge: "TEMPLATE · $X.XX" (standard), "BUNDLE · $X.XX" (green border), or "FREE DOWNLOAD" (amber border/badge) — pick based on what the user specified.
3. Confirm the Gumroad product/permalink is either real or clearly marked PLACEHOLDER_* — flag if missing, don't let the purchase button go live pointing nowhere.
4. Cross-link with the matching directory.html resource and/or blog article(s) ONLY if already live — otherwise mark as a pending code comment, not a dead link.
5. If this template changes the free tier composition, update complete-protection-bundle.html's total value math.
6. Add to sitemap.xml.

Mandatory verification (do not skip):
- Reload every file you edited and paste the exact lines added into your summary.
- Confirm the Gumroad button links to the correct product for THIS template specifically (not copy-pasted from another template's URL).

Commit directly to main with a clear message. Confirm the push landed on main.

Do not run a cross-system audit as part of this command — run /audit-block separately if needed.
