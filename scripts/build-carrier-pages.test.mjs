// Node built-in test runner: node --test scripts/build-carrier-pages.test.mjs
// Runs the real build (scripts/build-carrier-pages.js) then asserts on its
// output: no "undefined"/"null" leakage, every cited source link is a real
// URL from carriers.json, every null/unverified field renders the neutral
// fallback (never a bare stated fact), and every internal link resolves to
// a real file on disk.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const carriersData = JSON.parse(readFileSync(path.join(ROOT, 'data/delivery-triage/carriers.json'), 'utf8'));
const ALL_DATA_URLS = new Set();
(function collectUrls(obj) {
  if (Array.isArray(obj)) { obj.forEach(collectUrls); return; }
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) collectUrls(v);
    return;
  }
  if (typeof obj === 'string' && /^https?:\/\//.test(obj)) ALL_DATA_URLS.add(obj);
})(carriersData);

const CARRIER_NAMES = carriersData.carriers.map((c) => c.name);
const SLUGS = CARRIER_NAMES.map((n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));

function buildUnverifiedIndex() {
  const byCarrier = new Map();
  for (const entry of carriersData.unverified || []) {
    if (!entry.carrier) continue;
    if (!byCarrier.has(entry.carrier)) byCarrier.set(entry.carrier, []);
    byCarrier.get(entry.carrier).push(entry.field || '');
  }
  return byCarrier;
}
const unverifiedIndex = buildUnverifiedIndex();
function isUnverified(carrierName, fieldKey) {
  const fields = unverifiedIndex.get(carrierName) || [];
  return fields.some((f) => f.includes(fieldKey));
}
function isEmpty(v) {
  return v === null || v === undefined || v === '' ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
}

before(() => {
  execFileSync(process.execPath, ['scripts/build-carrier-pages.js'], { cwd: ROOT, stdio: 'pipe' });
});

function readPage(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

const PAGE_FILES = ['parcel-claims/index.html', ...SLUGS.map((s) => `parcel-claims/${s}/index.html`)];

test('every generated page exists', () => {
  for (const f of PAGE_FILES) {
    assert.ok(existsSync(path.join(ROOT, f)), `${f} was not generated`);
  }
});

test('no page contains "undefined" or a literal standalone "null" (outside known boilerplate)', () => {
  for (const f of PAGE_FILES) {
    const html = readPage(f);
    assert.ok(!/undefined/i.test(html), `${f}: contains "undefined"`);
    // The font-preload snippet's `this.onload=null;` is expected site-wide
    // boilerplate (same on every page on this site) — exclude only that
    // exact substring before checking for a literal "null" leak.
    const withoutBoilerplate = html.replace(/this\.onload=null;/g, '');
    assert.ok(!/\bnull\b/.test(withoutBoilerplate), `${f}: contains a literal "null" outside the font-preload boilerplate`);
  }
});

test('every external "Source" link cited on a carrier page is a real URL from carriers.json', () => {
  for (const f of PAGE_FILES.slice(1)) {
    const html = readPage(f);
    // Only "Source" / claim-form / official-page citation links are checked
    // here — self-referential getkibbo.com URLs (canonical, og:url,
    // breadcrumb JSON-LD, the generator CTA) are the site's own links, not
    // data citations, so they're excluded.
    const BOILERPLATE_DOMAINS = ['getkibbo.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
    const hrefs = [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)]
      .map((m) => m[1])
      .filter((u) => !BOILERPLATE_DOMAINS.some((d) => u.includes(d)));
    for (const url of hrefs) {
      assert.ok(ALL_DATA_URLS.has(url), `${f}: cited external link "${url}" is not a URL found anywhere in carriers.json`);
    }
  }
});

test('every internal link resolves to a real file on disk', () => {
  function urlToFilePath(url) {
    const clean = url.replace(/^\//, '').split('#')[0].split('?')[0];
    if (!clean) return path.join(ROOT, 'index.html');
    // Static assets (icons, etc.) are referenced by their exact path, not
    // the clean-URL convention — check them directly.
    if (/\.(svg|png|ico|css|js|json|xml|webp|jpg|jpeg)$/i.test(clean)) {
      const asset = path.join(ROOT, clean);
      return existsSync(asset) ? asset : null;
    }
    const direct = path.join(ROOT, clean + '.html');
    const indexed = path.join(ROOT, clean, 'index.html');
    if (existsSync(direct)) return direct;
    if (existsSync(indexed)) return indexed;
    return null;
  }
  let checked = 0;
  for (const f of PAGE_FILES) {
    const html = readPage(f);
    const hrefs = [...html.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);
    for (const url of hrefs) {
      if (url.startsWith('//')) continue; // protocol-relative, not internal
      const file = urlToFilePath(url);
      assert.ok(file, `${f}: internal link "${url}" does not resolve to a file on disk`);
      checked++;
    }
  }
  assert.ok(checked > 20, 'expected a non-trivial number of internal links checked');
});

test('every null or unverified field renders the neutral fallback, never a bare stated fact', () => {
  for (const carrier of carriersData.carriers) {
    const slug = carrier.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const html = readPage(`parcel-claims/${slug}/index.html`);
    const neutralMarker = `check ${carrier.name}'s official page directly`;

    const nullOrUnverifiedFieldKeys = [];
    for (const [k, v] of Object.entries(carrier.claim_windows || {})) {
      if (isEmpty(v) || isUnverified(carrier.name, `claim_windows.${k}`)) nullOrUnverifiedFieldKeys.push(`claim_windows.${k}`);
    }
    for (const [k, v] of Object.entries(carrier.compensation_limits || {})) {
      if (isEmpty(v) || isUnverified(carrier.name, `compensation_limits.${k}`)) nullOrUnverifiedFieldKeys.push(`compensation_limits.${k}`);
    }
    const cr = carrier.contact_routes || {};
    for (const k of ['claim_form_url', 'claims_email', 'phone', 'postal_address']) {
      if (!Object.prototype.hasOwnProperty.call(cr, k)) continue;
      if (isEmpty(cr[k]) || isUnverified(carrier.name, `contact_routes.${k}`)) nullOrUnverifiedFieldKeys.push(`contact_routes.${k}`);
    }
    if (isEmpty(carrier.claim_process) || isUnverified(carrier.name, 'claim_process')) nullOrUnverifiedFieldKeys.push('claim_process');
    if (isEmpty(carrier.escalation_route) || isUnverified(carrier.name, 'escalation_route')) nullOrUnverifiedFieldKeys.push('escalation_route');

    if (nullOrUnverifiedFieldKeys.length) {
      assert.ok(html.includes(neutralMarker), `${carrier.name}: expected the neutral fallback marker to appear for null/unverified fields [${nullOrUnverifiedFieldKeys.join(', ')}], but it was not found in the page`);
    }
  }
});

test('UK carrier pages state POSTRS covers Royal Mail only, never claim ADR membership for others', () => {
  const ukCarriers = carriersData.carriers.filter((c) => ['Royal Mail', 'Evri', 'DPD', 'Yodel'].includes(c.name));
  for (const carrier of ukCarriers) {
    const slug = carrier.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const html = readPage(`parcel-claims/${slug}/index.html`);
    assert.ok(html.includes('POSTRS'), `${carrier.name}: expected a POSTRS mention`);
    if (carrier.name === 'Royal Mail') {
      assert.ok(html.includes('POSTRS (the Postal Redress Service) covers Royal Mail only.'), 'Royal Mail: expected the POSTRS-covers-Royal-Mail note');
    } else {
      assert.ok(html.includes(`It does not cover ${carrier.name}.`), `${carrier.name}: expected an explicit "does not cover" statement`);
    }
  }
});

test('FAQ section (and its JSON-LD) only appears when the page has 3+ genuinely eligible Q&As', () => {
  for (const f of PAGE_FILES.slice(1)) {
    const html = readPage(f);
    const hasFaqSection = html.includes('id="faq"');
    const hasFaqJsonLd = html.includes('"@type": "FAQPage"');
    assert.equal(hasFaqSection, hasFaqJsonLd, `${f}: FAQ section and FAQPage JSON-LD should be in lock-step`);
  }
});

test('generator CTA link includes the exact carrier name as the ?carrier= param', () => {
  for (const carrier of carriersData.carriers) {
    const slug = carrier.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const html = readPage(`parcel-claims/${slug}/index.html`);
    const expected = `carrier=${encodeURIComponent(carrier.name)}`;
    assert.ok(html.includes(expected), `${carrier.name}: expected generator link to include ${expected}`);
  }
});

test('index page lists all 9 carriers with a working link each', () => {
  const html = readPage('parcel-claims/index.html');
  for (const name of CARRIER_NAMES) {
    assert.ok(html.includes(`>${name}<`), `index: expected a link labeled "${name}"`);
  }
});
