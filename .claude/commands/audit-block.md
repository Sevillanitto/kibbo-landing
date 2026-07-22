Run the standard cross-system audit for a content block. The user will name the block (e.g. "eu-banking") after this command — use it only to know what was recently added; the checks themselves are always the same five systems.

Report on each of these five by name, explicitly, even if the answer is "no changes needed":

1. **consumer-rights-by-country.html** — do NOT touch. Just report whether anything newly added should eventually feed into it (only relevant once ALL blocks for that country/region are done — do not add partial content).
2. **wizard-config.json** — report only, do not edit. Note if the new content unlocks a new problem-type combination for the Rights Checker/Timeline Generator, but do not activate it here.
3. **Rights Checker** — report whether it needs future changes, don't implement them here.
4. **Timeline Generator** — same, report only.
5. **free-to-try.html** — report whether any of the newly added generators/checklists/templates should be added here, with yes/no + one-line reason each.

Additionally, as part of this same audit:
- Reload every file touched in the prompts run for this block since the last audit, and confirm sitemap.xml actually contains every new URL (paste the exact lines).
- Confirm no page in this block references outdated legal facts (check against the known corrections list: ODR platform discontinued July 2025, PSD3 not in force, GDPR 1-month deadline extendable to 3 months, CE marking "China Export" myth, EU-wide cancel-button doesn't exist yet, Montreal Convention cap = 1,519 SDR, package-travel-only hotel relocation right).
- Confirm all Gumroad product IDs in this block are either real or clearly marked PLACEHOLDER_*, and list which ones are still placeholders.

Do not create, edit, or publish new content in this command — this is a read/report/verify step only. If something needs fixing, list it clearly for the next prompt rather than fixing it inline.
