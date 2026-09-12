#!/usr/bin/env node
/*
 * Generates blog/blog-index.json — a lightweight static index of every
 * article in blog.html's own grid, used by blog/engagement-footer.js to
 * compute "Related articles" / "Next recommended article" without fetching
 * the full 344KB blog.html on every single article page load.
 *
 * WHY THIS SCRIPT EXISTS
 * Before this, engagement-footer.js fetched blog.html itself and
 * DOMParser'd out each <article class="post-item" data-category="...">
 * block at runtime, on every article view. That's a 75KB (compressed)
 * transfer, every time, just to read {slug, title, date, category} for
 * ~522 items. This script does that same extraction once, at publish
 * time, and writes the result as ~20KB of JSON that the runtime script
 * now fetches instead.
 *
 * WHAT IT SCANS
 * blog.html itself (not the raw blog/*.html files) -- this is
 * deliberate, not a shortcut: blog.html's own <article class="post-item">
 * grid is the exact, already-proven source of truth the runtime script
 * used to parse, so building the index from the same source guarantees
 * byte-for-byte identical Related/Next output to before this change.
 * Note: 2 of the 524 live blog articles (case-gym-membership-auto-
 * renewal-clause, case-parcel-delivered-wrong-address-uk -- both a
 * different "Case Study" template) are not in blog.html's own grid
 * either, a separate pre-existing gap unrelated to this task, so they
 * won't appear in this index -- exactly matching current behavior.
 *
 * WHEN TO RUN
 * Manually, as part of publishing a new blog article -- see
 * PUBLISHING-PROTOCOL.md's "New BLOG ARTICLE" section. There's no
 * existing build/CI pipeline on this static site to hook this into
 * automatically (confirmed: no package.json, no build step, nothing
 * Vercel runs beyond serving the files as-is) -- sitemap.xml has the
 * exact same manual-regeneration constraint already, so this follows
 * that established precedent rather than inventing new infrastructure.
 *
 * USAGE
 *   node scripts/generate-blog-index.js            # writes blog/blog-index.json
 *   node scripts/generate-blog-index.js --dry-run   # prints a summary only
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

const blogHtmlPath = path.join(REPO, 'blog.html');
const outPath = path.join(REPO, 'blog', 'blog-index.json');

const raw = fs.readFileSync(blogHtmlPath, 'utf8');

// Match each <article class="post-item" data-category="...">...</article>
// block exactly as the runtime script's querySelectorAll('article.post-item[data-category]') did.
const articleRe = /<article class="post-item" data-category="((?:[^"\\]|\\.)*)">([\s\S]*?)<\/article>/g;
const items = [];
const errors = [];
let m;

while ((m = articleRe.exec(raw))) {
  const category = m[1];
  const body = m[2];

  const timeM = body.match(/<time datetime="([^"]*)"/);
  const linkM = body.match(/<h2><a href="([^"]*)">([\s\S]*?)<\/a><\/h2>/);

  if (!linkM) {
    errors.push('Found a post-item block with no matching <h2><a href="...">...</a></h2> -- skipping: ' + body.slice(0, 100));
    continue;
  }

  const url = linkM[1];
  const title = linkM[2].trim();
  const date = timeM ? timeM[1] : '';
  const slug = url.split('#')[0].split('?')[0].replace(/\/$/, '').split('/').pop().replace(/\.html$/, '');

  // The href is always exactly "/blog/" + slug for every one of the 522
  // articles (verified before adding this check) -- storing it separately
  // would just repeat the same prefix ~522 times for no benefit. The
  // runtime script reconstructs it as '/blog/' + slug instead.
  if (url !== '/blog/' + slug) {
    errors.push(`${slug}: href "${url}" doesn't match the expected "/blog/${slug}" pattern -- refusing (would silently produce a wrong link)`);
    continue;
  }

  items.push({ slug, title, date, category });
}

console.log('Scanned blog.html, found', items.length, 'post-item articles.');
if (errors.length) {
  console.log('\n!!! Errors found while parsing -- refusing to write anything:');
  errors.forEach((e) => console.log(' -', e));
  process.exit(1);
}

// --- Validate before writing anything ---
const slugs = new Set();
const dupes = [];
for (const it of items) {
  if (slugs.has(it.slug)) dupes.push(it.slug);
  slugs.add(it.slug);
}
const missingFields = items.filter((it) => !it.slug || !it.title || !it.date || !it.category);

if (dupes.length) {
  console.log('\n!!! Duplicate slugs found -- refusing to write:', dupes);
  process.exit(1);
}
if (missingFields.length) {
  console.log('\n!!! Items with missing required fields -- refusing to write:', JSON.stringify(missingFields, null, 2));
  process.exit(1);
}
if (items.length < 500) {
  // Sanity floor -- blog.html has ~522 articles at time of writing. A count
  // far below that almost certainly means the regex stopped matching
  // (e.g. blog.html's markup shape changed) rather than that articles were
  // actually removed.
  console.log(`\n!!! Only found ${items.length} articles, expected ~522+ -- this looks like a parsing failure, not a real count drop. Refusing to write.`);
  process.exit(1);
}

console.log('\nValidation passed: no duplicate slugs, no missing fields, count is in the expected range.');

const json = JSON.stringify(items);
console.log('Output size:', (Buffer.byteLength(json) / 1024).toFixed(1), 'KB (', items.length, 'items )');

if (DRY_RUN) {
  console.log('\nDry run only -- not writing. Re-run without --dry-run to write blog/blog-index.json.');
} else {
  fs.writeFileSync(outPath, json);
  console.log('\nWrote', outPath);
}
