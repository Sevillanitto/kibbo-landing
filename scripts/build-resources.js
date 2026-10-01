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
const BADGE_START = '<!-- BADGE:START -->';
const BADGE_END = '<!-- BADGE:END -->';
const BADGE_INDEX_START = '<!-- BADGE_INDEX:START -->';
const BADGE_INDEX_END = '<!-- BADGE_INDEX:END -->';

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

function injectBetweenMarkersRaw(raw, content, start, end, filePath) {
  const startIdx = raw.indexOf(start);
  const endIdx = raw.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`Markers ${start}/${end} not found (or out of order) in ${filePath}`);
  }
  const before = raw.slice(0, startIdx + start.length);
  const after = raw.slice(endIdx);
  return `${before}\n${content}\n${after}`;
}

function injectBetweenMarkers(filePath, content, start, end) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = injectBetweenMarkersRaw(raw, content, start || START, end || END, filePath);
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

// "Listed in Kibbo Resources" badge section — light/dark embed code the
// site owner can copy onto their own page. Pure HTML/CSS reusing the
// site's existing card (.audience-card) and embed-code/copy-button
// (.embed-code / .embed-copy-btn, same pattern as the calculator embed
// widgets) components — no new visual language introduced.
// Shared by the per-category badge section and the general, directory-wide
// one on resources/index.html — same markup/script, different link target
// and id namespace (idSuffix) so the two never collide if both appear on
// the same rendered output.
function buildBadgeSection(pageUrl, idSuffix, heading) {
  const variant = (key, bg, svgFile) => {
    const codeId = `badgeCode-${key}-${idSuffix}`;
    const embedHtml = `<a href="${pageUrl}" target="_blank" rel="noopener"><img src="https://www.getkibbo.com/badges/${svgFile}" alt="Listed in Kibbo Consumer Resources" width="244" height="56"></a>`;
    return [
      `        <div class="audience-card">`,
      `          <h3>${key === 'light' ? 'Light' : 'Dark'}</h3>`,
      `          <div style="background:${bg}; padding:20px; border-radius:var(--radius-sm); margin:12px 0; display:flex;">`,
      `            <a href="${pageUrl}" target="_blank" rel="noopener"><img src="/badges/${svgFile}" alt="Listed in Kibbo Consumer Resources" width="244" height="56"></a>`,
      `          </div>`,
      `          <pre class="embed-code"><code id="${codeId}">${esc(embedHtml)}</code></pre>`,
      `          <button type="button" class="embed-copy-btn" data-copy="${codeId}">Copy code</button>`,
      `        </div>`,
    ].join('\n');
  };

  return [
    `    <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid var(--border);">`,
    `      <span class="section-label">Optional</span>`,
    `      <h2 class="section-title" style="font-size: 24px;">${heading}</h2>`,
    `      <p style="color: var(--text-secondary); font-size: 15px; line-height: 1.6; margin: 10px 0 0;">Totally optional — inclusion never depends on linking back. Copy the code and paste it anywhere on your site.</p>`,
    `      <div class="product-audience-grid">`,
    variant('light', 'var(--bg)', 'listed-light.svg'),
    variant('dark', '#2A2925', 'listed-dark.svg'),
    `      </div>`,
    `    </div>`,
    `    <script>`,
    `    (function () {`,
    `      document.querySelectorAll('.embed-copy-btn[data-copy^="badgeCode-"]').forEach(function (btn) {`,
    `        btn.addEventListener('click', function () {`,
    `          var text = document.getElementById(btn.getAttribute('data-copy')).textContent;`,
    `          var done = function () { btn.textContent = 'Copied!'; setTimeout(function () { btn.textContent = 'Copy code'; }, 2000); };`,
    `          if (navigator.clipboard) { navigator.clipboard.writeText(text).then(done); }`,
    `          else { var t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); done(); }`,
    `        });`,
    `      });`,
    `    })();`,
    `    </script>`,
  ].join('\n');
}

function buildBadgeBlock(cat) {
  const pageUrl = `https://www.getkibbo.com/resources/${cat.slug}/`;
  return buildBadgeSection(pageUrl, cat.slug, 'Listed here? Add a badge to your site');
}

// General, directory-wide badge for resources/index.html — links to the
// whole directory rather than any one category, for sites that want to
// show they're in Kibbo Resources without tying it to a specific block.
function buildIndexBadgeBlock() {
  return buildBadgeSection('https://www.getkibbo.com/resources/', 'directory', 'Add a Kibbo Resources badge to your site');
}

function main() {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const categories = data.categories;

  {
    const filePath = path.join(ROOT, 'resources', 'index.html');
    let raw = fs.readFileSync(filePath, 'utf8');
    raw = injectBetweenMarkersRaw(raw, buildIndexBlock(categories), START, END, filePath);
    raw = injectBetweenMarkersRaw(raw, buildIndexBadgeBlock(), BADGE_INDEX_START, BADGE_INDEX_END, filePath);
    fs.writeFileSync(filePath, raw);
    console.log('Updated resources/index.html');
  }

  for (const cat of categories) {
    const filePath = path.join(ROOT, 'resources', cat.slug, 'index.html');
    let raw = fs.readFileSync(filePath, 'utf8');
    raw = injectBetweenMarkersRaw(raw, buildCategoryBlock(cat), START, END, filePath);
    raw = injectBetweenMarkersRaw(raw, buildBadgeBlock(cat), BADGE_START, BADGE_END, filePath);
    fs.writeFileSync(filePath, raw);
    console.log(`Updated resources/${cat.slug}/index.html`);
  }

  console.log(`\nDone. ${categories.length} category pages + index rebuilt from data/resources.json.`);
}

main();
