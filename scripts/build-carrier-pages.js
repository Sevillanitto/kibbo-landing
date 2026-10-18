#!/usr/bin/env node
// Builds /parcel-claims/ (index) and /parcel-claims/<carrier>/ (one page per
// carrier) from data/delivery-triage/carriers.json ONLY. Static HTML, no
// client-side fetch. Follows the same conventions as scripts/build-claims.js:
// full-file regeneration per page, a start/end-marker block in sitemap.xml,
// a filter-then-append rewrite of search-index.json, and reuse of the
// shared .claims-* CSS already injected into styles.css by build-claims.js
// (so this script does NOT touch styles.css — nothing new is needed).
//
// Strict data rule: every stated fact must trace to a non-null field in
// carriers.json that is NOT also listed in carriers.json's own top-level
// "unverified" array. Any field that's null OR flagged unverified renders
// as a neutral "check <carrier>'s official page" line instead, with a link
// to the best available source — never stated as fact. Never invent.
//
// Does NOT touch data/delivery-triage/carriers.json — read-only.
// No npm dependencies. Usage: node scripts/build-carrier-pages.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SITE = 'https://www.getkibbo.com';
const DATA_FILE = path.join(ROOT, 'data/delivery-triage/carriers.json');

const SITEMAP_START = '<!-- CARRIERS:START -->';
const SITEMAP_END = '<!-- CARRIERS:END -->';

// ---------------------------------------------------------------- helpers

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(iso || '');
  if (!m) return iso || '';
  const [, y, mo, d] = m;
  const month = MONTHS[parseInt(mo, 10) - 1] || mo;
  return d ? `${parseInt(d, 10)} ${month} ${y}` : `${month} ${y}`;
}

function humanizeKey(key) {
  return key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const COUNTRY_LABELS = { UK: 'United Kingdom', US: 'United States', EU: 'European Union', AU: 'Australia' };

// Which of the 4 country_dispute_routes blocks are relevant to each
// carrier's "What happens next" section — derived directly from that
// carrier's own `country` field in carriers.json (e.g. "International
// (UK/EU/US routes checked)" -> UK, EU, US). This only decides WHICH of
// the already-verified country blocks to show, not any new fact.
const ESCALATION_COUNTRIES = {
  'Royal Mail': ['UK'],
  'Evri': ['UK'],
  'DPD': ['UK'],
  'Yodel': ['UK'],
  'UPS': ['US'],
  'FedEx': ['US'],
  'USPS': ['US'],
  'DHL': ['UK', 'EU', 'US'],
  'Amazon Logistics': ['US', 'UK', 'EU', 'AU'],
};

// Existing blog article for this carrier, if one exists on disk (checked
// against the live repo before being listed here — never guessed).
const BLOG_MAP = {
  'Royal Mail': '/blog/royal-mail-lost-parcel-claim-uk',
  'Evri': '/blog/evri-lost-parcel-uk',
  'DPD': '/blog/dpd-lost-damaged-parcel-uk',
  'Yodel': null,
  'UPS': '/blog/ups-missing-package-claim',
  'FedEx': '/blog/fedex-missing-shipment-claim',
  'DHL': '/blog/dhl-lost-parcel-claim',
  'USPS': '/blog/usps-domestic-claims-us',
  'Amazon Logistics': '/blog/amazon-a-to-z-guarantee-us',
};

// Extra, carrier-specific "related reading" resources beyond the generic
// pair every carrier gets (lost-parcel-verification-checklist + delivery-
// evidence-log) — only entries confirmed to exist on disk are used; a
// missing path is reported, never silently linked.
const EXTRA_RELATED = {
  'Royal Mail': ['/checklists/postal-ombudsman-escalation-checklist'],
  'USPS': ['/checklists/usps-claims-checklist'],
};

// ------------------------------------------------------- tool-path lookup
// Same convention as build-claims.js's resolveTool(): read the real
// <title>/<h1> from disk at build time so link text always matches the
// actual page, and a missing/renamed page is caught instead of guessed.

const toolCache = new Map();
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&rsquo;/g, '’').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—');
}
function resolveTool(urlPath) {
  if (toolCache.has(urlPath)) return toolCache.get(urlPath);
  const rel = urlPath.replace(/^\//, '') + '.html';
  const full = path.join(ROOT, rel);
  let result;
  if (!fs.existsSync(full)) {
    result = { exists: false, url: urlPath, title: null };
  } else {
    const html = fs.readFileSync(full, 'utf8');
    let title = null;
    const titleMatch = /<title>([^<]*)<\/title>/i.exec(html);
    if (titleMatch) {
      title = decodeEntities(titleMatch[1]).replace(/\s*[—|]\s*Kibbo\s*$/i, '').trim();
    }
    if (!title) {
      const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
      if (h1Match) title = decodeEntities(h1Match[1].replace(/<[^>]+>/g, '')).trim();
    }
    result = { exists: true, url: urlPath, title: title || urlPath };
  }
  toolCache.set(urlPath, result);
  return result;
}

// ------------------------------------------------------------ data access

function loadData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

// Builds a quick lookup: for a given carrier name, which "field" strings
// (as free text, e.g. "contact_routes.claims_email, contact_routes.postal_address")
// are listed in the top-level unverified[] array. A field KEY counts as
// unverified if it appears as a substring of any matching entry's `field`
// string — matches carriers.json's own free-text convention.
function buildUnverifiedIndex(data) {
  const byCarrier = new Map();
  for (const entry of data.unverified || []) {
    if (!entry.carrier) continue;
    if (!byCarrier.has(entry.carrier)) byCarrier.set(entry.carrier, []);
    byCarrier.get(entry.carrier).push(entry.field || '');
  }
  return byCarrier;
}

function isUnverified(unverifiedIndex, carrierName, fieldKey) {
  const fields = unverifiedIndex.get(carrierName) || [];
  return fields.some(f => f.includes(fieldKey));
}

function isEmpty(v) {
  return v === null || v === undefined || v === '' ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
}

// Returns the real value (never altered) when it's present AND not flagged
// unverified; otherwise null, signalling the caller to render the neutral
// "check the official page" fallback instead.
function factOrNull(value, unverifiedIndex, carrierName, fieldKey) {
  if (isEmpty(value)) return null;
  if (isUnverified(unverifiedIndex, carrierName, fieldKey)) return null;
  return value;
}

function bestLink(carrier) {
  if (carrier.contact_routes && carrier.contact_routes.source && carrier.contact_routes.source.length) {
    return carrier.contact_routes.source[0];
  }
  if (carrier.sources && carrier.sources.length) return carrier.sources[0];
  return null;
}

function neutralLine(carrierName, link) {
  return `Not stated in our data — check ${esc(carrierName)}'s official page directly${link ? `: <a href="${esc(link)}" target="_blank" rel="noopener">${esc(link)}</a>` : '.'}`;
}

// ---------------------------------------------------------------- shared

function navAndHero(heroLabel, heroTitle, heroSubtitle, extraHeroHtml) {
  return `<nav class="nav kibbo-navbar">
  <div class="kibbo-navbar-inner">
    <a href="/" class="kibbo-logo">
      <span class="kibbo-logo-text">Kibbo</span>
    </a>
    <div class="kibbo-nav-links">
      <button type="button" class="kibbo-nav-item" data-dropdown="tools" aria-expanded="false">
        Tools
        <svg class="kibbo-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <button type="button" class="kibbo-nav-item" data-dropdown="guides" aria-expanded="false">
        Guides
        <svg class="kibbo-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <button type="button" class="kibbo-nav-item" data-dropdown="learn" aria-expanded="false">
        Learn
        <svg class="kibbo-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <button type="button" class="kibbo-nav-item" data-dropdown="resources" aria-expanded="false">
        Resources
        <svg class="kibbo-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>

      <div class="kibbo-dropdown kibbo-dropdown-tools" data-panel="tools">
        <div class="kibbo-panel-grid">
          <a href="/generate" class="kibbo-panel-item"><span class="kibbo-panel-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></span><span class="kibbo-panel-text"><span class="kibbo-panel-title">Generators</span><span class="kibbo-panel-desc">Build a complaint or dispute letter, free to use.</span></span></a>
          <a href="/templates" class="kibbo-panel-item"><span class="kibbo-panel-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></span><span class="kibbo-panel-text"><span class="kibbo-panel-title">Templates</span><span class="kibbo-panel-desc">Downloadable documents, ready to send.</span></span></a>
          <a href="/checklists" class="kibbo-panel-item"><span class="kibbo-panel-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3.5 17 1.75 1.75L9 15"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg></span><span class="kibbo-panel-text"><span class="kibbo-panel-title">Checklists</span><span class="kibbo-panel-desc">Step-by-step verification before you act.</span></span></a>
          <a href="/analyze" class="kibbo-panel-item"><span class="kibbo-panel-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span><span class="kibbo-panel-text"><span class="kibbo-panel-title">Analyzers</span><span class="kibbo-panel-desc">AI-powered review of contracts and notices.</span></span></a>
          <a href="/kits" class="kibbo-panel-item"><span class="kibbo-panel-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.73Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg></span><span class="kibbo-panel-text"><span class="kibbo-panel-title">Kits</span><span class="kibbo-panel-desc">Multi-step tool bundles, in the right order.</span></span></a>
          <a href="/developer-tools" class="kibbo-panel-item"><span class="kibbo-panel-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></span><span class="kibbo-panel-text"><span class="kibbo-panel-title">Developer Tools</span><span class="kibbo-panel-desc">Source code for our browser extensions and tools.</span></span></a>
          <a href="/claims/" class="kibbo-panel-item"><span class="kibbo-panel-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 6v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V6l-8-4Z"/><path d="m9 12 2 2 4-4"/></svg></span><span class="kibbo-panel-text"><span class="kibbo-panel-title">Claims</span><span class="kibbo-panel-desc">Know your rights and how to claim, by situation.</span></span></a>
          <a href="/calculators" class="kibbo-panel-row"><span class="kibbo-panel-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="14" x2="8.01" y2="14"/><line x1="12" y1="14" x2="12.01" y2="14"/><line x1="16" y1="14" x2="16.01" y2="14"/><line x1="8" y1="18" x2="8.01" y2="18"/><line x1="12" y1="18" x2="12.01" y2="18"/><line x1="16" y1="18" x2="16" y2="18"/></svg></span><span class="kibbo-panel-row-text"><strong>Calculators</strong> Refunds, interest, and fee totals.</span></a>
          <div class="kibbo-panel-banner"><div><div class="kibbo-panel-banner-title">Not sure where to start?</div><div class="kibbo-panel-banner-sub">Try the Wizard and we'll point you to the right tool.</div></div><a href="/wizard" class="kibbo-panel-banner-btn">Start the Wizard &rarr;</a></div>
        </div>
      </div>

      <div class="kibbo-dropdown kibbo-dropdown-guides" data-panel="guides">
        <div class="kibbo-panel-grid">
          <a href="/blog" class="kibbo-panel-item"><span class="kibbo-panel-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></span><span class="kibbo-panel-text"><span class="kibbo-panel-title">Blog</span><span class="kibbo-panel-desc">All articles, guides, and case breakdowns.</span></span></a>
          <a href="/investigations" class="kibbo-panel-item"><span class="kibbo-panel-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></span><span class="kibbo-panel-text"><span class="kibbo-panel-title">Investigations</span><span class="kibbo-panel-desc">Original data and reporting on consumer issues.</span></span></a>
        </div>
      </div>

      <div class="kibbo-dropdown kibbo-dropdown-learn" data-panel="learn">
        <div class="kibbo-panel-grid">
          <a href="/questions" class="kibbo-panel-item"><span class="kibbo-panel-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span><span class="kibbo-panel-text"><span class="kibbo-panel-title">Questions</span><span class="kibbo-panel-desc">Quick, direct answers to common legal questions.</span></span></a>
          <a href="/real-cases" class="kibbo-panel-item"><span class="kibbo-panel-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg></span><span class="kibbo-panel-text"><span class="kibbo-panel-title">Cases</span><span class="kibbo-panel-desc">Real examples of how disputes were resolved.</span></span></a>
        </div>
      </div>

      <div class="kibbo-dropdown kibbo-dropdown-resources" data-panel="resources">
        <div class="kibbo-panel-grid">
          <a href="/directory" class="kibbo-panel-item"><span class="kibbo-panel-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6"/><path d="M9 16h6"/></svg></span><span class="kibbo-panel-text"><span class="kibbo-panel-title">Directory</span><span class="kibbo-panel-desc">Verified contacts for regulators and agencies.</span></span></a>
          <a href="/resources/" class="kibbo-panel-item"><span class="kibbo-panel-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></span><span class="kibbo-panel-text"><span class="kibbo-panel-title">Community Resources</span><span class="kibbo-panel-desc">Free consumer resources, tools and guides from the community.</span></span></a>
          <a href="/consumer-rights-by-country" class="kibbo-panel-item"><span class="kibbo-panel-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></span><span class="kibbo-panel-text"><span class="kibbo-panel-title">Consumer Rights by Country</span><span class="kibbo-panel-desc">Compare your rights across the US, UK, EU, and Australia.</span></span></a>
          <a href="/datasets" class="kibbo-panel-item"><span class="kibbo-panel-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6"/></svg></span><span class="kibbo-panel-text"><span class="kibbo-panel-title">Consumer Data Library</span><span class="kibbo-panel-desc">Datasets behind Kibbo's own investigations.</span></span></a>
          <a href="/research" class="kibbo-panel-item"><span class="kibbo-panel-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6.5L4 18a2 2 0 0 0 1.8 3h12.4a2 2 0 0 0 1.8-3l-5-9.5V2"/><path d="M8.5 2h7"/><path d="M8 13h8"/></svg></span><span class="kibbo-panel-text"><span class="kibbo-panel-title">Kibbo Research</span><span class="kibbo-panel-desc">Original investigations and datasets, built to be cited.</span></span></a>
          <a href="/education" class="kibbo-panel-item"><span class="kibbo-panel-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/></svg></span><span class="kibbo-panel-text"><span class="kibbo-panel-title">Kibbo Education</span><span class="kibbo-panel-desc">Free classroom exercises built on our own data.</span></span></a>
          <a href="/library/" class="kibbo-panel-item"><span class="kibbo-panel-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></span><span class="kibbo-panel-text"><span class="kibbo-panel-title">Education Library</span><span class="kibbo-panel-desc">Free external resources for teachers and students.</span></span></a>
        </div>
      </div>
    </div>

    <a href="/free-to-try" class="kibbo-cta">Start for free &rarr;</a>

    <button type="button" class="kibbo-hamburger" aria-label="Open menu" aria-expanded="false">
      <span></span><span></span><span></span>
    </button>
  </div>

  <div class="kibbo-mobile-menu">
    <details>
      <summary>Tools</summary>
      <a href="/generate">Generators</a>
      <a href="/templates">Templates</a>
      <a href="/checklists">Checklists</a>
      <a href="/analyze">Analyzers</a>
      <a href="/kits">Kits</a>
      <a href="/developer-tools">Developer Tools</a>
      <a href="/claims/">Claims</a>
      <a href="/calculators">Calculators</a>
      <a href="/wizard">Start the Wizard &rarr;</a>
    </details>
    <details>
      <summary>Guides</summary>
      <a href="/blog">Blog</a>
      <a href="/investigations">Investigations</a>
    </details>
    <details>
      <summary>Learn</summary>
      <a href="/questions">Questions</a>
      <a href="/real-cases">Cases</a>
    </details>
    <details>
      <summary>Resources</summary>
      <a href="/directory">Directory</a>
      <a href="/resources/">Community Resources</a>
      <a href="/consumer-rights-by-country">Consumer Rights by Country</a>
      <a href="/datasets">Consumer Data Library</a>
      <a href="/research">Kibbo Research</a>
      <a href="/education">Kibbo Education</a>
      <a href="/library/">Education Library</a>
    </details>
    <a href="/free-to-try" class="kibbo-cta kibbo-mobile-cta">Start for free &rarr;</a>
  </div>
</nav>

<div class="section-page-hero">
  <div class="container">
    <p class="section-label">${esc(heroLabel)}</p>
    <h1 class="section-title">${heroTitle}</h1>
    <p class="section-subtitle">${heroSubtitle}</p>
    ${extraHeroHtml || ''}
  </div>
</div>`;
}

function footer() {
  return `<footer class="footer">
  <div class="container">
    <div class="footer-cta">
      <h2 class="footer-cta-heading">Ready to protect yourself?</h2>
      <a href="/free-to-try" class="footer-cta-btn">Start for free &rarr;</a>
    </div>
    <div class="footer-main">
      <div class="footer-brand">
        <a href="/" class="footer-logo">Kibbo</a>
      </div>
      <div class="footer-cols">
        <div class="footer-col">
          <h4>Tools</h4>
          <a href="/generate">Generators</a>
          <a href="/templates">Templates</a>
          <a href="/checklists">Checklists</a>
          <a href="/analyze">Analyzers</a>
          <a href="/kits">Kits</a>
          <a href="/calculators">Calculators</a>
          <a href="/developer-tools">Developer Tools</a>
        </div>
        <div class="footer-col">
          <h4>Content</h4>
          <a href="/blog">Blog</a>
          <a href="/investigations">Investigations</a>
          <a href="/questions">Questions</a>
          <a href="/directory">Directory</a>
          <a href="/real-cases">Real Cases</a>
          <a href="/resources/">Community Resources</a>
          <a href="/datasets">Consumer Data Library</a>
          <a href="/research">Kibbo Research</a>
          <a href="/education">Kibbo Education</a>
        </div>
        <div class="footer-col">
          <h4>Company</h4>
          <a href="/about">About Us</a>
          <a href="/consumer-rights-by-country">Consumer Rights by Country</a>
          <a href="/corrections-log">Corrections Log</a>
        </div>
        <div class="footer-col">
          <h4>Legal</h4>
          <a href="/privacy-policy">Privacy Policy</a>
          <a href="/cookie-policy">Cookie Policy</a>
          <a href="/terms-of-use">Terms of Use</a>
        </div>
      </div>
    </div>
    <div class="footer-bottom">
      <p>&copy; 2026 Kibbo. This site provides general information, not legal advice.</p>
    </div>
  </div>
</footer>`;
}

function headBlock({ title, description, canonical }) {
  return `<script src="/cookie-consent.js" defer></script>
<script src="/newsletter-signup.js" defer></script>
<script src="/kibbo-navbar.js" defer></script>

<meta charset="UTF-8">
<link rel="canonical" href="${esc(canonical)}">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(title)}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="shortcut icon" href="/favicon.ico">
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Kibbo">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="https://www.getkibbo.com/favicon.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=Inter:wght@300;400;500;600&display=swap" onload="this.onload=null;this.rel='stylesheet'">
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=Inter:wght@300;400;500;600&display=swap"></noscript>
<link rel="stylesheet" href="/styles.css">`;
}

function breadcrumbJsonLd(items) {
  return `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
${items.map((it, i) => `    { "@type": "ListItem", "position": ${i + 1}, "name": ${JSON.stringify(it.name)}, "item": ${JSON.stringify(it.url)} }`).join(',\n')}
  ]
}
</script>`;
}

// ---------------------------------------------------------------- index page

function buildIndexPage(carriers) {
  const cells = carriers.map(c => {
    const countries = c.country;
    return `        <div class="cr-cell">
          <a class="cr-name" href="/parcel-claims/${esc(c.slug)}/">${esc(c.name)}</a>
          <p class="cr-meta-line">${esc(countries)}</p>
          <a class="cr-link" href="/parcel-claims/${esc(c.slug)}/">View claim guide &rarr;</a>
        </div>`;
  }).join('\n');

  const middle = `<p class="section-subtitle" style="max-width:720px;">Deadlines, compensation limits, and the official way to start a claim with each carrier — built only from each carrier's own published terms, with a source and a verified date for every figure. Not sure which carrier delivered your parcel, or what to do first? <a href="/parcel-help">Try Parcel Help</a> — three quick questions, and we point you to the right page.</p>
    <div class="cr-grid" style="margin-top:32px;">
${cells}
    </div>`;

  const title = 'Carrier Claim Guides: Deadlines, Limits & How to Claim — Kibbo';
  const description = 'How to claim from Royal Mail, Evri, DPD, Yodel, UPS, FedEx, DHL, USPS and Amazon Logistics — official claim windows, compensation limits and escalation routes, sourced and dated.';
  const canonical = `${SITE}/parcel-claims`;
  const head = headBlock({ title, description, canonical });
  const breadcrumb = breadcrumbJsonLd([
    { name: 'Home', url: `${SITE}/` },
    { name: 'Parcel Claim Guides', url: canonical },
  ]);
  const hero = navAndHero(
    'Delivery & Parcels',
    'Carrier claim guides',
    'Pick the carrier that delivered (or lost) your parcel.',
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
${head}
${breadcrumb}
</head>
<body>

${hero}

<main class="section-main">
  <div class="container">
    ${middle}
  </div>
</main>

${footer()}

</body>
</html>
`;
}

// --------------------------------------------------------- carrier page

function buildAtAGlance(carrier, unverifiedIndex) {
  const link = bestLink(carrier);
  const windows = Object.entries(carrier.claim_windows || {}).map(([k, v]) => {
    const fact = factOrNull(v, unverifiedIndex, carrier.name, `claim_windows.${k}`);
    return `        <dt>${esc(humanizeKey(k))}</dt><dd>${fact ? esc(fact) : neutralLine(carrier.name, link)}</dd>`;
  }).join('\n');
  const limits = Object.entries(carrier.compensation_limits || {}).map(([k, v]) => {
    const fact = factOrNull(v, unverifiedIndex, carrier.name, `compensation_limits.${k}`);
    return `        <dt>${esc(humanizeKey(k))}</dt><dd>${fact ? esc(fact) : neutralLine(carrier.name, link)}</dd>`;
  }).join('\n');

  const sourceLine = (carrier.sources && carrier.sources.length)
    ? `<p class="claims-source">${carrier.sources.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">Source ${i + 1} &rarr;</a>`).join(' &middot; ')} &middot; verified ${esc(fmtDate(carrier.verified_on))}</p>`
    : '';

  return `    <section class="claims-section" id="at-a-glance">
      <h2 class="cl-section-title">At a glance</h2>
      <p class="claims-rule">Countries served: ${esc(carrier.country)}</p>
      <h3 class="claims-tool-group-title" style="margin-top:20px;">Claim window</h3>
      <dl class="claims-fields">
${windows || `        <dt>&nbsp;</dt><dd>${neutralLine(carrier.name, link)}</dd>`}
      </dl>
      <h3 class="claims-tool-group-title" style="margin-top:20px;">Compensation limits</h3>
      <dl class="claims-fields">
${limits || `        <dt>&nbsp;</dt><dd>${neutralLine(carrier.name, link)}</dd>`}
      </dl>
      ${sourceLine}
    </section>`;
}

function buildHowToClaim(carrier, unverifiedIndex) {
  const cr = carrier.contact_routes || {};
  const link = bestLink(carrier);
  const rows = [];
  // "Only fields that exist" = only render a row for a contact method whose
  // KEY is present in this carrier's own contact_routes object — but once a
  // key exists, a null/unverified VALUE still gets the neutral fallback
  // line rather than being silently dropped (never state it as fact, but
  // never go silent on a contact method the data schema actually tracks).
  const FIELD_LABELS = [
    ['claim_form_url', 'Official claim form'],
    ['claims_email', 'Claims email'],
    ['phone', 'Phone'],
    ['postal_address', 'Postal address'],
  ];
  for (const [key, label] of FIELD_LABELS) {
    if (!Object.prototype.hasOwnProperty.call(cr, key)) continue;
    const fact = factOrNull(cr[key], unverifiedIndex, carrier.name, `contact_routes.${key}`);
    rows.push(`        <dt>${esc(label)}</dt><dd>${fact ? esc(fact) : neutralLine(carrier.name, link)}</dd>`);
  }

  const processFact = factOrNull(carrier.claim_process, unverifiedIndex, carrier.name, 'claim_process');
  const processLine = processFact
    ? `<p class="claims-rule">${esc(processFact)}</p>`
    : `<p class="claims-pending">${neutralLine(carrier.name, link)}</p>`;

  const crSourceLine = (cr.source && cr.source.length)
    ? `<p class="claims-source">${cr.source.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">Source ${i + 1} &rarr;</a>`).join(' &middot; ')}${cr.verified_on ? ` &middot; verified ${esc(fmtDate(cr.verified_on))}` : ''}</p>`
    : '';

  return `    <section class="claims-section" id="how-to-claim">
      <h2 class="cl-section-title">How to make a claim</h2>
      ${processLine}
      ${rows.length ? `<dl class="claims-fields" style="margin-top:16px;">\n${rows.join('\n')}\n      </dl>` : `<p class="claims-pending">${neutralLine(carrier.name, link)}</p>`}
      ${crSourceLine}
    </section>`;
}

function buildEvidenceSection(carrier) {
  const items = [
    'Order confirmation or receipt',
    'Tracking number and tracking history (a screenshot, with dates/status)',
    'Proof of the item\'s value',
    'Photos of the item and packaging, if it arrived damaged',
    'Any correspondence with the seller or ' + esc(carrier.name) + ' so far',
  ];
  return `    <section class="claims-section" id="evidence">
      <h2 class="cl-section-title">Evidence to gather</h2>
      <ul class="claims-list">
${items.map(i => `        <li>${i}</li>`).join('\n')}
        <li><a href="/templates/delivery-evidence-log">Delivery Evidence Log template</a> — a structured way to keep all of this in one place</li>
      </ul>
    </section>`;
}

function buildEscalationSection(carrier, data, unverifiedIndex) {
  const link = bestLink(carrier);
  const escFact = factOrNull(carrier.escalation_route, unverifiedIndex, carrier.name, 'escalation_route');
  const escLine = escFact ? `<p class="claims-rule">${esc(escFact)}</p>` : `<p class="claims-pending">${neutralLine(carrier.name, link)}</p>`;

  const countries = ESCALATION_COUNTRIES[carrier.name] || [];
  const countryBlocks = countries.map(cc => {
    const routes = (data.country_dispute_routes || {})[cc];
    if (!routes) return '';
    const cdr = routes.card_dispute_route;
    const om = routes.ombudsman_regulator;
    const cdrSrc = cdr && cdr.sources && cdr.sources.length ? cdr.sources[0] : null;
    const omSrc = om && om.sources && om.sources.length ? om.sources[0] : null;
    return `      <div class="claims-tool-group">
        <h3 class="claims-tool-group-title">${esc(COUNTRY_LABELS[cc] || cc)}</h3>
        <p class="claims-rule" style="font-size:15px;">${esc((cdr && cdr.name) || '')}</p>
        <p class="claims-cyq-answer">${esc((cdr && cdr.basis) || '')}</p>
        ${cdrSrc ? `<p class="claims-source"><a href="${esc(cdrSrc)}" target="_blank" rel="noopener">Source &rarr;</a></p>` : ''}
        <p class="claims-cyq-answer" style="margin-top:12px;"><strong>${esc((om && om.name) || '')}</strong> &mdash; ${esc((om && om.scope_note) || '')}</p>
        ${om && om.complaint_url ? `<p class="claims-source"><a href="${esc(om.complaint_url)}" target="_blank" rel="noopener">Complain to ${esc(om.name)} &rarr;</a></p>` : ''}
      </div>`;
  }).filter(Boolean).join('\n');

  const postrsNote = countries.includes('UK')
    ? `<p class="claims-note">UK note: POSTRS (the Postal Redress Service) covers Royal Mail only.${carrier.name === 'Royal Mail' ? '' : ` It does not cover ${esc(carrier.name)}.`} For a non-Royal-Mail UK carrier, the realistic escalation route is via the retailer who chose the carrier, or a card dispute (see below) — never assume ADR membership that isn't confirmed.</p>`
    : '';

  return `    <section class="claims-section" id="escalation">
      <h2 class="cl-section-title">What happens next</h2>
      ${escLine}
      ${postrsNote}
      <div class="claims-tool-groups" style="margin-top:16px;">
${countryBlocks}
      </div>
    </section>`;
}

// NOTE: deliberately NOT using the .supp-analyze class here — it relies on
// var(--supp-accent), which is only defined under the .supp-page body
// class used by the generator/analyzer pages. These carrier pages don't
// carry that class, so --supp-accent would resolve to nothing and the
// button would render invisible (white text, no background). Using the
// globally-defined --accent-green token directly instead.
function buildCtaSection(carrier) {
  const genUrl = `/generate/delivery-claim-generator?carrier=${encodeURIComponent(carrier.name)}`;
  const base = 'display:inline-block;text-decoration:none;text-align:center;padding:16px 28px;font-family:var(--font-sans);font-size:16px;font-weight:600;letter-spacing:-0.01em;border-radius:100px;transition:var(--transition);';
  return `    <section class="claims-section" id="cta">
      <div style="display:flex;flex-wrap:wrap;gap:12px;">
        <a style="${base}color:#fff;background:var(--accent-green);" href="${esc(genUrl)}">Write my letters &rarr;</a>
        <a style="${base}background:var(--bg-card);color:var(--text-primary);border:1px solid var(--border);" href="/parcel-help">Not sure what to do? &rarr;</a>
      </div>
    </section>`;
}

function buildRelatedSection(carrier, report) {
  const items = [];
  const blogPath = BLOG_MAP[carrier.name];
  if (blogPath) {
    const t = resolveTool(blogPath);
    if (t.exists) items.push(`<li><a href="${esc(t.url)}">${esc(t.title)}</a></li>`);
    else report.missingTools.push(`${carrier.slug} (blog): ${blogPath}`);
  }
  const generic = ['/checklists/lost-parcel-verification-checklist', '/templates/delivery-evidence-log'];
  const extra = EXTRA_RELATED[carrier.name] || [];
  for (const p of generic.concat(extra)) {
    const t = resolveTool(p);
    if (t.exists) items.push(`<li><a href="${esc(t.url)}">${esc(t.title)}</a></li>`);
    else report.missingTools.push(`${carrier.slug} (related): ${p}`);
  }
  if (!items.length) return '';
  return `    <section class="claims-section" id="related">
      <h2 class="cl-section-title">Related reading</h2>
      <ul class="claims-list">
${items.join('\n')}
      </ul>
    </section>`;
}

// FAQ: only built when >= 3 genuinely eligible (non-null, non-unverified)
// Q&As exist for this carrier. Never pads with invented questions.
function buildFaqCandidates(carrier, unverifiedIndex) {
  const out = [];
  const windows = Object.entries(carrier.claim_windows || {})
    .map(([k, v]) => factOrNull(v, unverifiedIndex, carrier.name, `claim_windows.${k}`))
    .filter(Boolean);
  if (windows.length) {
    out.push({ q: `What is the claim window for a ${carrier.name} parcel claim?`, a: windows.join(' ') });
  }
  const limits = Object.entries(carrier.compensation_limits || {})
    .map(([k, v]) => factOrNull(v, unverifiedIndex, carrier.name, `compensation_limits.${k}`))
    .filter(Boolean);
  if (limits.length) {
    out.push({ q: `Is there a compensation limit for a ${carrier.name} claim?`, a: limits.join(' ') });
  }
  const process = factOrNull(carrier.claim_process, unverifiedIndex, carrier.name, 'claim_process');
  if (process) {
    out.push({ q: `How do I start a claim with ${carrier.name}?`, a: process });
  }
  const escalation = factOrNull(carrier.escalation_route, unverifiedIndex, carrier.name, 'escalation_route');
  if (escalation) {
    out.push({ q: `What if ${carrier.name} doesn't resolve my claim?`, a: escalation });
  }
  if (ESCALATION_COUNTRIES[carrier.name] && ESCALATION_COUNTRIES[carrier.name].includes('UK')) {
    out.push({
      q: `Does POSTRS cover ${carrier.name}?`,
      a: carrier.name === 'Royal Mail'
        ? 'Yes. POSTRS (the Postal Redress Service, run by CEDR and Ofcom-approved) covers Royal Mail.'
        : `No. POSTRS only covers Royal Mail. It does not cover ${carrier.name}.`,
    });
  }
  return out;
}

function buildFaqSection(candidates) {
  if (candidates.length < 3) return { html: '', jsonLd: '' };
  const html = `    <section class="claims-section" id="faq">
      <h2 class="cl-section-title">Common questions</h2>
${candidates.map(c => `      <details>\n        <summary>${esc(c.q)}</summary>\n        <p>${esc(c.a)}</p>\n      </details>`).join('\n')}
    </section>`;
  const jsonLd = `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
${candidates.map(c => `    { "@type": "Question", "name": ${JSON.stringify(c.q)}, "acceptedAnswer": { "@type": "Answer", "text": ${JSON.stringify(c.a)} } }`).join(',\n')}
  ]
}
</script>`;
  return { html, jsonLd };
}

function buildCarrierPage(carrier, data, unverifiedIndex, report) {
  const canonical = `${SITE}/parcel-claims/${carrier.slug}`;
  const title = `How to Claim from ${carrier.name}: Deadlines, Limits & Letters — Kibbo`;
  const description = `How to claim from ${carrier.name}: official claim window, compensation limits, how to start a claim, and your escalation options — sourced from ${carrier.name}'s own terms and dated.`;

  const head = headBlock({ title, description, canonical });
  const breadcrumb = breadcrumbJsonLd([
    { name: 'Home', url: `${SITE}/` },
    { name: 'Parcel Claim Guides', url: `${SITE}/parcel-claims` },
    { name: carrier.name, url: canonical },
  ]);

  const faqCandidates = buildFaqCandidates(carrier, unverifiedIndex);
  const faq = buildFaqSection(faqCandidates);

  const hero = navAndHero(
    'Delivery & Parcels',
    `How to Claim from ${esc(carrier.name)}`,
    `Deadlines, compensation limits and the official way to start a claim — according to ${esc(carrier.name)}'s own terms.`,
    `<p class="claims-verified">Data reviewed on ${esc(fmtDate(carrier.verified_on))}</p>`,
  );

  const sections = [
    buildAtAGlance(carrier, unverifiedIndex),
    buildHowToClaim(carrier, unverifiedIndex),
    buildEvidenceSection(carrier),
    buildEscalationSection(carrier, data, unverifiedIndex),
    buildCtaSection(carrier),
    buildRelatedSection(carrier, report),
    faq.html,
  ].filter(Boolean).join('\n');

  const middle = `${sections}
    <p class="claims-disclaimer">This is general information, not legal advice. Figures are sourced from ${esc(carrier.name)}'s own published terms, linked above, and reviewed on the date shown.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
${head}
${breadcrumb}
${faq.jsonLd}
</head>
<body>

${hero}

<main class="section-main">
  <div class="container claims-detail">
    ${middle}
  </div>
</main>

${footer()}

</body>
</html>
`;
}

// --------------------------------------------------------------- sitemap

function injectBetweenMarkersRaw(raw, content, start, end, label) {
  const startIdx = raw.indexOf(start);
  const endIdx = raw.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`Markers not found (or out of order) for ${label}`);
  }
  const before = raw.slice(0, startIdx + start.length);
  const after = raw.slice(endIdx);
  return `${before}\n${content}\n${after}`;
}

function updateSitemap(carriers) {
  const filePath = path.join(ROOT, 'sitemap.xml');
  let raw = fs.readFileSync(filePath, 'utf8');
  const today = new Date().toISOString().slice(0, 10);
  const urls = [`${SITE}/parcel-claims`, ...carriers.map(c => `${SITE}/parcel-claims/${c.slug}`)];
  const block = urls.map(u => `  <url>\n    <loc>${u}</loc>\n    <lastmod>${today}</lastmod>\n  </url>`).join('\n');

  if (raw.includes(SITEMAP_START)) {
    raw = injectBetweenMarkersRaw(raw, block, SITEMAP_START, SITEMAP_END, 'sitemap.xml');
  } else {
    raw = raw.replace('</urlset>', `${SITEMAP_START}\n${block}\n${SITEMAP_END}\n</urlset>`);
  }
  fs.writeFileSync(filePath, raw);
  console.log(`Updated sitemap.xml (${urls.length} parcel-claims URLs)`);
}

// ---------------------------------------------------------- search-index

function updateSearchIndex(carriers) {
  const filePath = path.join(ROOT, 'search-index.json');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const kept = data.filter(d => !d.url.startsWith('/parcel-claims'));

  const entries = [{
    title: 'Carrier Claim Guides',
    type: 'claim',
    block: 'delivery-parcels',
    url: '/parcel-claims',
    description: 'How to claim from Royal Mail, Evri, DPD, Yodel, UPS, FedEx, DHL, USPS and Amazon Logistics — deadlines, compensation limits and escalation routes, sourced and dated.',
    keywords: ['carrier claim guide', 'how to claim lost parcel', 'courier compensation limit'],
  }];
  for (const c of carriers) {
    entries.push({
      title: `How to Claim from ${c.name}`,
      type: 'claim',
      block: 'delivery-parcels',
      url: `/parcel-claims/${c.slug}`,
      description: `How to claim from ${c.name}: official claim window, compensation limits and how to start a claim, sourced from ${c.name}'s own terms.`,
      keywords: [`${c.name.toLowerCase()} claim`, `${c.name.toLowerCase()} compensation`, `${c.name.toLowerCase()} lost parcel`],
    });
  }

  const merged = kept.concat(entries);
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + '\n');
  console.log(`Updated search-index.json (+${entries.length} parcel-claims entries)`);
}

// ---------------------------------------------------------------- main

function main() {
  const report = { missingTools: [] };
  const data = loadData();
  const unverifiedIndex = buildUnverifiedIndex(data);

  const carriers = data.carriers.map(c => Object.assign({ slug: slugify(c.name) }, c));

  fs.mkdirSync(path.join(ROOT, 'parcel-claims'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'parcel-claims', 'index.html'), buildIndexPage(carriers));
  console.log('Wrote parcel-claims/index.html');

  for (const carrier of carriers) {
    const dir = path.join(ROOT, 'parcel-claims', carrier.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), buildCarrierPage(carrier, data, unverifiedIndex, report));
    console.log(`Wrote parcel-claims/${carrier.slug}/index.html`);
  }

  updateSitemap(carriers);
  updateSearchIndex(carriers);

  console.log('\n=== Build report ===');
  console.log(`Carrier pages built: ${carriers.length}`);
  console.log(`\nMissing tool/related paths (skipped): ${report.missingTools.length}`);
  report.missingTools.forEach(m => console.log(`  - ${m}`));
  console.log('\nDone.');
}

main();
