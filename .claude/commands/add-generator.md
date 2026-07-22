Add one or more new generators to the shared kibbo-generators engine. The user will paste the generator JSON(s) after this command — treat each JSON block as one generator to add.

Follow PUBLISHING-PROTOCOL.md's "New GENERATOR" section exactly. Specifically, for each generator provided:

1. Add the config entry (as given) to the shared generator engine config.
2. Confirm the Gumroad product_id field is either a real ID or clearly marked PLACEHOLDER_* — do not invent one.
3. Create the page at the path implied by the generator's `id` (generate/{id}.html) matching the existing generator page pattern (design system, GA, fonts, nav, footer).
4. Add the card to generate.html.
5. Cross-link related blog articles/templates ONLY if they already exist and are confirmed live — otherwise add as a code comment marked "pending: article not yet published" rather than a dead link.
6. Add the URL to sitemap.xml.
7. Do NOT touch consumer-rights-by-country.html, wizard-config.json, or any other cross-system file — those are handled by /audit-block, not this command.

Mandatory verification (do not skip):
- Reload every file you edited and paste the exact lines added into your summary.
- Test each generator's free preview + output live via the actual Worker (not curl-only) and confirm no output references anything flagged as legally outdated (e.g. PSD3 as current law, discontinued ODR platform, uniform EU cancel-button, etc.) unless the prompt_template explicitly instructs otherwise.
- Confirm none of the prompt_templates make legal claims stronger than what's in the source JSON (e.g. "strong escalation path" not "guaranteed outcome").

Commit directly to main with a clear message. Confirm the push landed on main.

Do not run a cross-system audit as part of this command — that's a separate step, run /audit-block after this if needed.
