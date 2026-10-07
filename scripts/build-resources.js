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

// Country code -> display label, and the fixed display order for the
// region filter sidebar (only regions actually present in a topic are
// rendered, in this order).
const COUNTRY_LABELS = {
  US: 'US', UK: 'UK', EU: 'Europe', CA: 'Canada', AU: 'Australia',
  NZ: 'New Zealand', GLOBAL: 'Global',
};
const COUNTRY_ORDER = ['US', 'UK', 'EU', 'CA', 'AU', 'NZ', 'GLOBAL'];

const TYPE_LABELS = {
  organization: 'Organization', tool: 'Tool', website: 'Website',
  guide: 'Guide', dataset: 'Dataset', publication: 'Publication',
};

function sortKey(name) {
  return String(name).replace(/^The\s+/i, '').toLowerCase();
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
  const sorted = cat.resources.slice().sort((a, b) => {
    const ka = sortKey(a.name), kb = sortKey(b.name);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  // Regions present in this topic, in the fixed display order, with counts.
  const counts = new Map();
  for (const r of sorted) counts.set(r.country, (counts.get(r.country) || 0) + 1);
  const regionsPresent = COUNTRY_ORDER.filter(c => counts.has(c));
  const showSidebar = regionsPresent.length > 1;

  const cells = sorted.map(r => {
    const regionLabel = COUNTRY_LABELS[r.country] || r.country;
    const typeLabel = TYPE_LABELS[r.type] || r.type;
    return [
      `        <div class="cr-cell" data-region="${esc(r.country)}">`,
      `          <a class="cr-name" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>`,
      `          <p class="cr-desc">${esc(r.description)}</p>`,
      `          <p class="cr-meta-line">${esc(regionLabel)} &middot; ${esc(typeLabel)}</p>`,
      `          <a class="cr-link" href="${esc(r.url)}" target="_blank" rel="noopener">Visit website &rarr;</a>`,
      `        </div>`,
    ].join('\n');
  });

  const gridBlock = [
    `      <div class="cr-grid" id="crGrid-${cat.slug}" data-resource-grid="${cat.slug}">`,
    cells.join('\n'),
    `      </div>`,
  ].join('\n');

  const addLine = `      <p class="cr-add-line">Know a free consumer resource that belongs here? <a href="/resources/submit/?category=${encodeURIComponent(cat.slug)}">Add your website, free of charge &rarr;</a></p>`;

  if (cat.resources.length === 0) {
    return [
      `  <div class="cr-main-full">`,
      `      <p class="resource-empty">No resources listed yet. Know a good one? <a href="/resources/submit/?category=${encodeURIComponent(cat.slug)}">Submit it →</a></p>`,
      `  </div>`,
    ].join('\n');
  }

  if (!showSidebar) {
    return [
      `  <div class="cr-main-full">`,
      gridBlock,
      addLine,
      `  </div>`,
    ].join('\n');
  }

  const total = sorted.length;
  const sidebarItems = regionsPresent.map(c =>
    `        <li><button type="button" data-value="${esc(c)}" data-name="${esc(COUNTRY_LABELS[c] || c)}" data-count="${counts.get(c)}">${esc(COUNTRY_LABELS[c] || c)} (${counts.get(c)})</button></li>`
  ).join('\n');

  const sidebar = [
    `  <aside class="blf-sidebar" aria-label="Filter by region">`,
    `    <p class="blf-sidebar-label">Region</p>`,
    `    <details class="blf-cat" open id="crFilterToggle-${cat.slug}">`,
    `      <summary><span class="blf-cat-name" id="crFilterName-${cat.slug}">All</span><span class="blf-count" id="crFilterCount-${cat.slug}" aria-label="resources">${total}</span><svg class="blf-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></summary>`,
    `      <ul class="blf-cat-list" id="crFilter-${cat.slug}" role="tablist" aria-label="Region filter">`,
    `        <li><button type="button" data-value="" data-name="All" data-count="${total}" class="active">All (${total})</button></li>`,
    sidebarItems,
    `      </ul>`,
    `    </details>`,
    `  </aside>`,
  ].join('\n');

  const filterScript = [
    `  <script>`,
    `  (function () {`,
    `    var slug = ${JSON.stringify(cat.slug)};`,
    `    var grid = document.getElementById('crGrid-' + slug);`,
    `    if (!grid) return;`,
    `    var cells = Array.prototype.slice.call(grid.querySelectorAll('.cr-cell'));`,
    `    var buttons = Array.prototype.slice.call(document.querySelectorAll('#crFilter-' + slug + ' button'));`,
    `    var nameEl = document.getElementById('crFilterName-' + slug);`,
    `    var countEl = document.getElementById('crFilterCount-' + slug);`,
    `    function apply(value) {`,
    `      var shown = 0;`,
    `      cells.forEach(function (c) {`,
    `        var match = !value || c.getAttribute('data-region') === value;`,
    `        c.hidden = !match;`,
    `        if (match) shown++;`,
    `      });`,
    `      buttons.forEach(function (b) { b.classList.toggle('active', b.dataset.value === value); });`,
    `      if (nameEl) nameEl.textContent = value ? (buttons.filter(function (b) { return b.dataset.value === value; })[0] || {}).dataset.name || 'All' : 'All';`,
    `      if (countEl) countEl.textContent = shown;`,
    `    }`,
    `    buttons.forEach(function (b) {`,
    `      b.addEventListener('click', function () { apply(b.dataset.value); });`,
    `    });`,
    `  })();`,
    `  </script>`,
  ].join('\n');

  return [
    `  <div class="cr-layout">`,
    sidebar,
    `  <div class="cr-main">`,
    gridBlock,
    addLine,
    `  </div>`,
    `  </div>`,
    filterScript,
  ].join('\n');
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
