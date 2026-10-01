#!/usr/bin/env node
// Writes static resource content into resources/index.html and each
// resources/<slug>/index.html, from data/resources.json. Only the
// content between <!-- RESOURCES:START --> and <!-- RESOURCES:END -->
// markers is touched — everything else in those files is left alone.
//
// Why: resources/index.html listed resource counts, and each category
// page its resource list, by fetching data/resources.json client-side
// (resources-loader.js). Google doesn't reliably index content that only
// appears after a JS fetch, so this script bakes that same content into
// the HTML at build time instead. Edit data/resources.json, run this
// script, commit the regenerated HTML — no client-side fetch involved.
//
// No npm dependencies. Idempotent: running it twice in a row produces
// byte-identical output, since it's a pure function of resources.json.
//
// Usage: node scripts/build-resources.js   (or: npm run build:resources)

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'data', 'resources.json');
const START = '<!-- RESOURCES:START -->';
const END = '<!-- RESOURCES:END -->';

// The 5 top-level groups shown on resources/index.html — id, icon SVG,
// and display name, exactly as used on pillar-pages.html. Hardcoded here
// (rather than re-parsed from pillar-pages.html on every build) so this
// script has a single, stable input: data/resources.json.
const GROUPS = [
  {
    id: 'money-protection',
    name: 'Money &amp; Protection',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="#141210"><rect x="2" y="2" width="8" height="8"/><rect x="14" y="2" width="8" height="8"/><rect x="2" y="14" width="8" height="8"/><rect x="14" y="14" width="8" height="8"/></svg>',
  },
  {
    id: 'home-living',
    name: 'Home &amp; Living',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="#141210"><path d="M12 1 L14.5 9.5 L23 12 L14.5 14.5 L12 23 L9.5 14.5 L1 12 L9.5 9.5 Z"/></svg>',
  },
  {
    id: 'work-travel',
    name: 'Work &amp; Travel',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="#141210"><rect x="3" y="15" width="4" height="6"/><rect x="10" y="10" width="4" height="11"/><rect x="17" y="4" width="4" height="17"/></svg>',
  },
  {
    id: 'shopping-digital-life',
    name: 'Shopping &amp; Digital Life',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#141210" stroke-width="7"><circle cx="12" cy="12" r="8.5"/></svg>',
  },
  {
    id: 'health-everyday',
    name: 'Health &amp; Everyday',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="#141210"><path d="M12 1 L23 12 L12 23 L1 12 Z"/><rect x="9" y="9" width="6" height="6" fill="#FFFF00"/></svg>',
  },
];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function injectBetweenMarkers(filePath, content) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const startIdx = raw.indexOf(START);
  const endIdx = raw.indexOf(END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`Markers not found (or out of order) in ${filePath}`);
  }
  const before = raw.slice(0, startIdx + START.length);
  const after = raw.slice(endIdx);
  const out = `${before}\n${content}\n${after}`;
  fs.writeFileSync(filePath, out);
}

function buildIndexBlock(categories) {
  const byGroup = new Map();
  for (const cat of categories) {
    const key = cat.group;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(cat);
  }

  const lines = [];
  for (const g of GROUPS) {
    const groupName = g.name.replace(/&amp;/g, '&');
    const cats = categories.filter(c => c.group === groupName);
    lines.push(`    <div class="pillar-category" id="${g.id}">`);
    lines.push(`      <div class="pillar-category-header">`);
    lines.push(`        <div class="pillar-category-icon">`);
    lines.push(`          ${g.icon}`);
    lines.push(`        </div>`);
    lines.push(`        <h2 class="pillar-category-name">${g.name}</h2>`);
    lines.push(`        <span class="pillar-category-count">${cats.length} topic${cats.length === 1 ? '' : 's'}</span>`);
    lines.push(`      </div>`);
    lines.push(`      <div class="pillar-card-grid">`);
    for (const c of cats) {
      const n = c.resources.length;
      const countText = `${n} resource${n === 1 ? '' : 's'}`;
      lines.push(`        <a href="/resources/${c.slug}/" class="pillar-card"><span>${esc(c.name)}<span class="pillar-card-count">${esc(countText)}</span></span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></a>`);
    }
    lines.push(`      </div>`);
    lines.push(`    </div>`);
  }
  return lines.join('\n');
}

function buildCategoryBlock(cat) {
  if (cat.resources.length === 0) {
    return '      <p class="resource-empty">No resources listed yet. Know a good one? <a href="/resources/submit/">Submit it →</a></p>';
  }
  const items = cat.resources.map(r => [
    `      <div class="resource-item">`,
    `        <h3 class="resource-name">${esc(r.name)}</h3>`,
    `        <p class="resource-desc">${esc(r.description)}</p>`,
    `        <div class="resource-meta"><span>${esc(r.country)}</span><span>${esc(r.type)}</span></div>`,
    `        <a href="${esc(r.url)}" class="resource-link" target="_blank" rel="noopener">Visit website →</a>`,
    `      </div>`,
  ].join('\n'));
  return items.join('\n');
}

function main() {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const categories = data.categories;

  injectBetweenMarkers(path.join(ROOT, 'resources', 'index.html'), buildIndexBlock(categories));
  console.log('Updated resources/index.html');

  for (const cat of categories) {
    const filePath = path.join(ROOT, 'resources', cat.slug, 'index.html');
    injectBetweenMarkers(filePath, buildCategoryBlock(cat));
    console.log(`Updated resources/${cat.slug}/index.html`);
  }

  console.log(`\nDone. ${categories.length} category pages + index rebuilt from data/resources.json.`);
}

main();
