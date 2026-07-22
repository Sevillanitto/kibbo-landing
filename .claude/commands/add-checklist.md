Add one or more new consumer checklists to the shared checklist-engine.js. The user will paste the checklist JSON(s) after this command.

Follow PUBLISHING-PROTOCOL.md's "New CONSUMER CHECKLIST" section:

1. Add the config entry (as given) to checklist-engine.js.
2. Verify every item with a tool_url points to a real, existing, already-live Kibbo page — if it doesn't exist yet, remove the button rather than link it or fake it. Never add alert()-style simulated actions.
3. Add to checklists.html, grouped under the stated category. If the category doesn't already have another live checklist, flag this to the user rather than creating a new empty-looking category section.
4. Cross-link related blog articles/templates/analyzers ONLY if already live.
5. Add to sitemap.xml.
6. Explicitly evaluate whether this checklist belongs on free-to-try.html — state yes/no with a one-line reason, don't skip this step.

Mandatory verification (do not skip):
- Reload every file you edited and paste the exact lines added into your summary.

Commit directly to main with a clear message. Confirm the push landed on main.

Do not run a cross-system audit as part of this command — run /audit-block separately if needed.
