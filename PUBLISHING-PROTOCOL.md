# Kibbo — Publishing Protocol

Checklist to run through EVERY time something new goes live. Pick the
matching content type below. Never skip the "Mandatory verification"
step at the end of each — it has caught real bugs before (orphan pages,
broken CSP, unescaped characters, wrong Gumroad IDs).

---

## New BLOG ARTICLE

1. Adapt to the standard template (reference: an existing recent
   article, e.g. extension-bloat-browser-security-consolidation.html) —
   same head (GA + fonts), nav, footer, heading hierarchy.
2. Assign `data-category` — must match one of: Financial & Banking,
   Shopping & E-Commerce, Delivery & Parcels, Privacy & Data, Housing &
   Rentals, Telecoms & Utilities, Legal & Contracts, Health &
   Supplements, Developer Tools & Security, Templates & Downloads.
3. Add the card to blog.html's grid; confirm the category filter count
   updates (+1 or however many).
4. Include engagement-footer.js (the container div + script tag).
5. If it corresponds to a directory.html resource: add "Want to know
   more? Read our full guide →" under that resource's "When to use"
   text (add an id to the resource card if it doesn't have one), AND
   link back from the article to directory.html#that-id.
6. If a related Kibbo tool exists (analyzer, generator, or template)
   for this topic, cross-link it naturally in the article body or
   resource-footer.
7. If the content is country-specific (only UK or US supported so
   far), add it to consumer-rights-by-country.html's matching column.
   Do not add anything to any other country's column — none exist yet.
8. Add the URL to sitemap.xml.
9. Mandatory verification: reload every file you edited and confirm
   the exact lines you added are actually present — paste them into
   your summary. Do not just assume an edit applied.
10. Commit and push to main with a clear message.
11. (Manual, human step) Request Indexing for the new URL in Google
    Search Console.

---

## New TEMPLATE (Word/Excel/PDF product)

1. Create the product page in templates/ matching the Clean Lab design
   system and the existing card/page pattern.
2. Add the card to templates.html — correct badge style:
   "TEMPLATE · $X.XX" (standard), "BUNDLE · $X.XX" with green border
   (the all-in-one bundle), or "FREE DOWNLOAD" with amber border/badge
   (lead-magnet templates).
3. Gumroad product must exist with the matching slug/permalink before
   the purchase button goes live, or it 404s.
4. Cross-link with the matching directory.html resource and/or blog
   article(s) if applicable, same pattern as articles above.
5. If this template is added to or removed from the free tier, update
   the bundle's total value math on complete-protection-bundle.html.
6. Add to sitemap.xml.
7. Mandatory verification: reload edited files, confirm changes
   present, paste into summary.
8. Commit and push.
9. (Manual) Request Indexing in Search Console.

---

## New ANALYZER

1. Manual Cloudflare setup first: Worker, KV namespace, RATE_LIMIT_KV
   binding, ANTHROPIC_API_KEY secret (and ADMIN_KEY only if using the
   manual-code-delivery model, not needed for license-key model).
2. Add the new Worker's domain to connect-src in the Content-Security-
   Policy — centralized in vercel.json, never per-page.
3. Frontend matches Clean Lab design system; paywall banner links to
   the correct Gumroad product URL for THIS analyzer specifically (not
   copy-pasted from another analyzer).
4. Add the card to analyze.html.
5. Consider adding to free-to-try.html if it fits that hub's purpose.
6. Cross-link related blog articles/templates.
7. Add to sitemap.xml.
8. Mandatory verification: test the analyzer end-to-end in an actual
   browser (not just curl) before considering it done. Reload edited
   files to confirm changes.
9. Commit and push.
10. (Manual) Create the Gumroad product if not already done, confirm
    it resolves (HTTP 200), and confirm the license-key/access-code
    flow works with a real test.
11. (Manual) Request Indexing in Search Console.

---

## New GENERATOR

The config lives in TWO places — get both right or the generator fails:
  - Frontend page (generate/<id>.html): `window.KIBBO_GENERATOR` with
    id, title, price, gumroad_permalink, questions[]. This is served by
    Vercel.
  - Server (analyzer/kibbo-generators/worker.js `GENERATORS` map): the
    id -> { title, gumroad_product_id, prompt_template }. This runs on
    Cloudflare, NOT Vercel.

1. Add the frontend page (copy an existing generator page; only the
   `window.KIBBO_GENERATOR` block and page copy change).
2. Add the server entry to worker.js `GENERATORS` (prompt_template +
   the REAL gumroad_product_id, never the permalink).
3. **Redeploy the Worker: `npx wrangler deploy` in
   analyzer/kibbo-generators/. THIS IS THE #1 REASON A NEW GENERATOR
   "DOESN'T WORK" — the config committed to git does nothing until the
   Worker is redeployed. Committing to main only ships the frontend;
   the free preview 404s on an unknown generatorId until you deploy.**
4. Gumroad product must exist with "Generate a unique license key per
   sale" enabled and its permalink matching gumroad_permalink, or the
   checkout/unlock 404s.
5. Gumroad checkout overlay CSP is already handled centrally in
   vercel.json (gumroad.com + *.gumroad.com in script/style/font/
   connect/frame-src). Do NOT add per-page CSP; if the overlay ever
   loads a new gumroad subdomain, widen the central *.gumroad.com rule.
6. Add the card to generate.html.
7. Cross-link related blog articles/templates.
8. Add to sitemap.xml.
9. Mandatory verification: in a real browser, run the free preview end
   to end AND open the Gumroad overlay (confirm no CSP errors in the
   console) before considering it done.
10. Commit and push.
11. (Manual) Request Indexing in Search Console.

---

## New CONSUMER CHECKLIST

1. No new engine code — add a new config entry (JSON: zones, items,
   common_mistakes, related links) to the shared checklist-engine.js.
2. Every item with a "tool" button must link to a real, existing Kibbo
   page (analyzer/generator/template/article) or external official
   resource — NEVER a fake/simulated action (no alert() popups
   pretending to run a scan). If no real tool applies, the item has no
   button.
3. Add to checklists.html hub, grouped under its category — only show
   categories that have at least one real checklist; never show an
   empty category.
4. Cross-link related blog articles/templates/analyzers.
5. Add to sitemap.xml.
6. Mandatory verification: reload files, confirm changes present.
7. Commit and push.
8. (Manual) Request Indexing in Search Console.

---

## Cross-cutting rules — apply to every content type above

- Never link to a resource, tool, or page that doesn't actually exist
  or hasn't been verified — omit it rather than guess or fake it.
- Verify all facts, figures, legal citations, and deadlines against
  real current sources before publishing — laws and thresholds change
  (e.g. FOS compensation limit, CCPA deadlines, Section 21 abolition —
  all have changed recently and caught out earlier drafts).
- Never show an empty category, section, or "coming soon" placeholder
  to real visitors.
- Always physically reload any file you edited to confirm the change
  is actually there before reporting success — this has caught real
  failures before.
- Always end with "commit and push to main with a clear commit
  message."
- Check the current UK/US balance on consumer-rights-by-country.html
  before choosing what to write next — prioritize whichever region is
  behind.
- No country besides UK and US on consumer-rights-by-country.html yet
  — do not add Australia, EU, or others until real content exists for
  them.
