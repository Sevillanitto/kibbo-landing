#!/usr/bin/env node
// Builds the Claims hub (/claims/) and one page per claim (/claims/<slug>/)
// from data/claims/*.json. Static HTML, no client-side fetch — same
// rationale as build-resources.js: content baked in at build time so it's
// reliably indexable and doesn't depend on JS running.
//
// Unlike build-resources.js, these pages don't pre-exist as hand-written
// shells with markers to inject into — there was nothing to build on top
// of, so this script generates each full HTML file from a template. It's
// still idempotent (a pure function of the three data/claims/*.json files)
// and still wraps the data-driven middle section in CLAIMS:START/END
// markers for consistency with the rest of the build-*.js scripts, even
// though here the whole file is regenerated each run, not just that block.
//
// Launched (indexable, in the Tools nav) — see git history for the
// pre-launch noindex/launch-flag state.
//
// Does NOT touch data/claims/*.json — read-only. Normalizes the schema
// differences between the pilot file (title/last_verified/can_you_claim/
// steps) and the batch files (no title, no steps, status/verified_on per
// field) here in the build script instead.
//
// No npm dependencies. Usage: node scripts/build-claims.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_FILES = [
  'data/claims/claims-pilot-flight-delay.json',
  'data/claims/claims-batch1-money.json',
  'data/claims/claims-batch2-19.json',
];

const CLAIMS_START = '<!-- CLAIMS:START -->';
const CLAIMS_END = '<!-- CLAIMS:END -->';
const SITEMAP_START = '<!-- CLAIMS:START -->';
const SITEMAP_END = '<!-- CLAIMS:END -->';

const SITE = 'https://www.getkibbo.com';

// ---------------------------------------------------------------- helpers

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const ACRONYMS = new Set([
  'FCA', 'FOS', 'FCBA', 'FDCPA', 'FCRA', 'HMRC', 'ACAS', 'NHS', 'ICOBS',
  'USPS', 'FTC', 'SEC', 'CFTC', 'IC3', 'HUD', 'ERISA', 'ROSCA', 'CPA',
  'KYC', 'AML', 'DMCCA', 'MiCA', 'HFHHA', 'VAT', 'IOSS', 'EEOC', 'CFPB',
  'CRA', 'ICO', 'GDPR', 'IRS', 'DOL', 'DOT', 'FLSA', 'CAA', 'ADR', 'CONC',
  'CRD', 'PSD2', 'CCRs', 'EU', 'UK', 'US', 'FBI',
]);

// snake_case field key -> readable label, e.g. "notification_deadline" ->
// "Notification deadline", "fca_firm_checker" -> "FCA firm checker".
function humanizeKey(key) {
  const words = key.split('_');
  return words
    .map((w, i) => {
      const upper = w.toUpperCase();
      if (ACRONYMS.has(upper)) return upper;
      if (i === 0) return w.charAt(0).toUpperCase() + w.slice(1);
      return w;
    })
    .join(' ');
}

function titleCaseSlug(slug) {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// Accepts "YYYY-MM-DD" or "YYYY-MM"; returns a readable date string.
function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(iso || '');
  if (!m) return iso || '';
  const [, y, mo, d] = m;
  const month = MONTHS[parseInt(mo, 10) - 1] || mo;
  return d ? `${parseInt(d, 10)} ${month} ${y}` : `${month} ${y}`;
}

const COUNTRY_LABELS = { US: 'US', UK: 'UK', EU: 'Europe', AU: 'Australia' };
const COUNTRY_ORDER = ['US', 'UK', 'EU', 'AU'];

// Nicer, grammatical titles for the 24 claims that have no explicit
// "title" field in their data file (only the flight-delay pilot has one).
// Kept here rather than mechanically title-casing the slug, since e.g.
// "landlord-wont-repair" -> "Landlord Wont Repair" reads badly.
const TITLE_OVERRIDES = {
  'unauthorized-transaction': "Unauthorized Card or Bank Transaction",
  'hidden-bank-fees': "Hidden or Unfair Bank Fees",
  'credit-report-dispute': "Credit Report Error",
  'debt-collector-harassment': "Debt Collector Harassment",
  'chargeback': "Chargeback or Section 75 Claim",
  'lost-luggage': "Lost, Delayed or Damaged Luggage",
  'rental-deposit-not-returned': "Rental Deposit Not Returned",
  'illegal-eviction': "Illegal Eviction or Lockout",
  'landlord-wont-repair': "Landlord Won't Make Repairs",
  'rent-increase': "Unfair or Unlawful Rent Increase",
  'refund-defective-product': "Refund for a Defective Product",
  'cancel-subscription': "Cancelling a Subscription",
  'charged-after-cancelling': "Charged After Cancelling",
  'insurance-claim-denied': "Insurance Claim Denied",
  'medical-bill-dispute': "Medical Bill Dispute",
  'medical-records-request': "Requesting Your Medical Records",
  'unpaid-wages': "Unpaid Wages or Wage Theft",
  'final-paycheck': "Final Paycheck Not Paid",
  'workplace-harassment': "Workplace Harassment",
  'lost-parcel': "Lost or Stolen Parcel",
  'unexpected-customs-charges': "Unexpected Customs Charges",
  'used-car-hidden-fault': "Used Car With a Hidden Fault",
  'crypto-scam': "Crypto Scam",
  'frozen-crypto-account': "Frozen or Locked Crypto Account",
};

// Fixed display/group order for the hub, as specified by the task.
const BLOCK_ORDER = [
  'Travel', 'Money & Banking', 'Home & Rentals', 'Work', 'Shopping',
  'Subscriptions', 'Insurance', 'Health', 'Parcels', 'Vehicles', 'Crypto & Scams',
];

// Field keys on a rights[region] object that are structural, not a
// claim-able figure — excluded from the rendered "Your rights" field list.
const STRUCTURAL_KEYS = new Set(['status', 'verified_on', 'source', 'source_url', 'by_state', 'note']);

// ---------------------------------------------------------------- loading

function loadAllClaims() {
  const claims = [];
  for (const rel of DATA_FILES) {
    const full = path.join(ROOT, rel);
    const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    const arr = Array.isArray(raw) ? raw : [raw];
    for (const c of arr) claims.push(Object.assign({ _sourceFile: rel }, c));
  }
  return claims;
}

function regionsOf(claim) {
  return COUNTRY_ORDER.filter(cc => claim.rights && Object.prototype.hasOwnProperty.call(claim.rights, cc));
}

function latestVerifiedDate(claim) {
  const dates = [];
  if (claim.last_verified) dates.push(claim.last_verified);
  for (const r of Object.values(claim.rights || {})) {
    if (!r || typeof r !== 'object') continue;
    if (r.verified_on) dates.push(r.verified_on);
    if (r.by_state) {
      for (const sv of Object.values(r.by_state)) {
        if (sv && sv.verified_on) dates.push(sv.verified_on);
      }
    }
  }
  if (!dates.length) return null;
  return dates.sort().slice(-1)[0];
}

function countTools(claim) {
  let n = 0;
  for (const arr of Object.values(claim.tools || {})) n += (arr || []).length;
  return n;
}

// ------------------------------------------------------- tool-path lookup

const toolCache = new Map();

// Every tool path in the data is already a full site path (e.g.
// "/generate/foo" or "/financial-banking/calculators/bar") -> maps
// directly to <path>.html on disk. Reads the real <title> (preferred) or
// <h1> from that file so link text always matches the actual page.
// Target pages store their <title>/<h1> with HTML entities already encoded
// (e.g. "Chargeback &amp; Card Dispute"). Decode before we re-escape with
// esc() later, or "&amp;" would become the literal text "&amp;amp;".
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&rsquo;/g, '’')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—');
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
      title = decodeEntities(titleMatch[1])
        .replace(/\s*[—|]\s*Kibbo\s*$/i, '')
        .replace(/\s*[—–-]\s*Free\b[^—–-]*$/i, '')
        .trim();
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

const TOOL_TYPE_LABELS = {
  generators: 'Generators', templates: 'Templates', checklists: 'Checklists',
  calculators: 'Calculators', kits: 'Kits', real_cases: 'Real Cases',
};
const TOOL_TYPE_ORDER = ['generators', 'templates', 'checklists', 'calculators', 'kits'];

// ------------------------------------------------------------ rights data

// Returns [{key, label, value}] for the claim-able fields of a verified
// region object (everything except the structural keys).
function rightsFields(regionObj) {
  const out = [];
  for (const [k, v] of Object.entries(regionObj)) {
    if (STRUCTURAL_KEYS.has(k)) continue;
    out.push({ key: k, label: humanizeKey(k), value: v });
  }
  return out;
}

function renderFieldValue(value) {
  if (Array.isArray(value)) {
    // Only source_url is ever an array in this data; render as a list.
    return `<ul class="claims-field-list">${value.map(v => `<li>${esc(v)}</li>`).join('')}</ul>`;
  }
  if (value && typeof value === 'object') {
    return `<dl class="claims-subfields">${Object.entries(value)
      .map(([k, v]) => `<dt>${esc(humanizeKey(k))}</dt><dd>${esc(v)}</dd>`)
      .join('')}</dl>`;
  }
  return esc(value);
}

function renderSourceLinks(regionObj) {
  const src = regionObj.source_url || regionObj.source;
  if (!src) return '';
  const urls = Array.isArray(src) ? src : [src];
  if (urls.length === 1) {
    return `<p class="claims-source"><a href="${esc(urls[0])}" target="_blank" rel="noopener">Source &rarr;</a></p>`;
  }
  return `<p class="claims-source">${urls.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">Source ${i + 1} &rarr;</a>`).join(' &middot; ')}</p>`;
}

// ----------------------------------------------------------- normalizing

function normalizeClaim(claim, allClaims) {
  const slug = claim.slug;
  const title = claim.title || TITLE_OVERRIDES[slug] || titleCaseSlug(slug);
  const regions = regionsOf(claim);
  const lastVerified = latestVerifiedDate(claim);

  // Can-you-claim: pilot has an explicit, richer array; every other claim
  // gets one derived question from the already-verified "rule" field per
  // region (PENDING_VERIFY regions are skipped — nothing invented there).
  let canYouClaim = claim.can_you_claim;
  if (!canYouClaim) {
    const entry = { q: 'Does this apply where you are?' };
    let any = false;
    for (const cc of regions) {
      const r = claim.rights[cc];
      if (r && r.status === 'verified' && r.rule) {
        entry[cc] = r.rule;
        any = true;
      }
    }
    canYouClaim = any ? [entry] : [];
  }

  const evidence = claim.evidence || [];
  const steps = (claim.steps && claim.steps.length) ? claim.steps : null;

  // Related claims: explicit related[] (slugs) if present, else up to 3
  // other claims sharing the same block — a structural fact already in
  // the verified data, not an invented relationship.
  let relatedSlugs = claim.related || [];
  if (!relatedSlugs.length) {
    relatedSlugs = allClaims
      .filter(c => c.slug !== slug && c.block === claim.block)
      .slice(0, 3)
      .map(c => c.slug);
  }

  return {
    slug, title, block: claim.block, regions, lastVerified,
    canYouClaim, evidence, steps, rights: claim.rights,
    tools: claim.tools || {}, relatedSlugs,
    toolCount: countTools(claim),
  };
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

// ---------------------------------------------------------------- hub page

function buildHubPage(normalized) {
  const byBlock = new Map();
  for (const c of normalized) {
    if (!byBlock.has(c.block)) byBlock.set(c.block, []);
    byBlock.get(c.block).push(c);
  }
  for (const list of byBlock.values()) list.sort((a, b) => a.title.localeCompare(b.title));

  const regionsPresent = COUNTRY_ORDER.filter(cc => normalized.some(c => c.regions.includes(cc)));

  const blocksHtml = BLOCK_ORDER.filter(b => byBlock.has(b)).map(block => {
    const list = byBlock.get(block);
    const cells = list.map(c => {
      const regionLabels = c.regions.map(cc => COUNTRY_LABELS[cc] || cc).join(', ');
      const searchBlob = esc(`${c.title} ${c.block} ${regionLabels}`.toLowerCase());
      return `        <div class="cr-cell" data-regions="${esc(c.regions.join(','))}" data-search="${searchBlob}">
          <a class="cr-name" href="/claims/${esc(c.slug)}/">${esc(c.title)}</a>
          <p class="cr-meta-line">${esc(regionLabels)} &middot; ${c.toolCount} tool${c.toolCount === 1 ? '' : 's'}</p>
          <a class="cr-link" href="/claims/${esc(c.slug)}/">View your rights &rarr;</a>
        </div>`;
    }).join('\n');
    return `    <div class="claims-block" data-claims-block>
      <div class="pillar-category-header" style="margin-bottom:16px;">
        <h2 class="pillar-category-name" style="font-size:20px;">${esc(block)}</h2>
        <span class="pillar-category-count">${list.length} claim${list.length === 1 ? '' : 's'}</span>
      </div>
      <div class="cr-grid" data-claims-grid>
${cells}
      </div>
    </div>`;
  }).join('\n');

  const chips = regionsPresent.map(cc =>
    `        <button type="button" class="claims-chip" data-region="${esc(cc)}">${esc(COUNTRY_LABELS[cc] || cc)}</button>`
  ).join('\n');

  const middle = `<div class="claims-toolbar">
      <input type="search" class="claims-search" id="claimsSearch" placeholder="Search claims (e.g. flight delay, deposit, chargeback)" aria-label="Search claims">
      <div class="claims-chips" role="group" aria-label="Filter by region">
        <button type="button" class="claims-chip active" data-region="">All regions</button>
${chips}
      </div>
    </div>
    <p class="claims-empty" id="claimsEmpty" hidden>No claims match your search.</p>
${blocksHtml}
    <script>
    (function () {
      var search = document.getElementById('claimsSearch');
      var chips = Array.prototype.slice.call(document.querySelectorAll('.claims-chip'));
      var cells = Array.prototype.slice.call(document.querySelectorAll('[data-claims-grid] .cr-cell'));
      var blocks = Array.prototype.slice.call(document.querySelectorAll('[data-claims-block]'));
      var empty = document.getElementById('claimsEmpty');
      var activeRegion = '';
      function apply() {
        var q = (search.value || '').trim().toLowerCase();
        var shown = 0;
        cells.forEach(function (cell) {
          var matchesSearch = !q || cell.getAttribute('data-search').indexOf(q) !== -1;
          var regions = (cell.getAttribute('data-regions') || '').split(',');
          var matchesRegion = !activeRegion || regions.indexOf(activeRegion) !== -1;
          var match = matchesSearch && matchesRegion;
          cell.hidden = !match;
          if (match) shown++;
        });
        blocks.forEach(function (block) {
          var anyShown = Array.prototype.slice.call(block.querySelectorAll('.cr-cell')).some(function (c) { return !c.hidden; });
          block.hidden = !anyShown;
        });
        empty.hidden = shown !== 0;
      }
      search.addEventListener('input', apply);
      chips.forEach(function (btn) {
        btn.addEventListener('click', function () {
          activeRegion = btn.getAttribute('data-region') || '';
          chips.forEach(function (b) { b.classList.toggle('active', b === btn); });
          apply();
        });
      });
    })();
    </script>`;

  const title = 'Claims: How to Claim Your Consumer Rights — Kibbo';
  const description = 'Know your rights and claim what you\'re owed — flight delays, bank errors, deposits, unpaid wages and more, with figures and deadlines sourced from official regulators for the US, UK and Europe.';
  const canonical = `${SITE}/claims`;

  const head = headBlock({ title, description, canonical });
  const breadcrumb = breadcrumbJsonLd([
    { name: 'Home', url: `${SITE}/` },
    { name: 'Claims', url: canonical },
  ]);
  const hero = navAndHero(
    'Know your rights',
    'Claim what you\'re owed',
    'Pick the problem that matches your situation. Each claim page shows the exact rule, the figures and deadlines, and the free tools to act on it — for the US, UK and Europe.',
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
${CLAIMS_START}
${middle}
${CLAIMS_END}
  </div>
</main>

${footer()}

</body>
</html>
`;
}

// -------------------------------------------------------------- claim page

function buildCanYouClaimSection(claim) {
  if (!claim.canYouClaim.length) return '';
  const items = claim.canYouClaim.map(entry => {
    const rows = claim.regions
      .filter(cc => entry[cc])
      .map(cc => `<div class="claims-cyq-answer" data-region-panel="${esc(cc)}"><strong>${esc(COUNTRY_LABELS[cc] || cc)}:</strong> ${esc(entry[cc])}</div>`)
      .join('\n');
    const universal = entry.answer ? `<div class="claims-cyq-answer">${esc(entry.answer)}</div>` : '';
    return `      <div class="claims-cyq">
        <p class="claims-cyq-q">${esc(entry.q)}</p>
        ${universal}
        ${rows}
      </div>`;
  }).join('\n');
  return `    <section class="claims-section" id="can-you-claim">
      <h2 class="cl-section-title">Can you claim?</h2>
${items}
    </section>`;
}

function buildRightsSection(claim) {
  const panels = claim.regions.map((cc, i) => {
    const r = claim.rights[cc];
    const label = COUNTRY_LABELS[cc] || cc;
    let body;
    if (r.by_state) {
      body = buildByStateTable(claim, cc, r);
    } else if (r.status === 'PENDING_VERIFY') {
      const src = r.source_url || r.source;
      const srcLink = src ? `<a href="${esc(Array.isArray(src) ? src[0] : src)}" target="_blank" rel="noopener">the official source</a>` : 'the official source';
      body = `<p class="claims-pending">We're still verifying this for ${esc(label)}. Check ${srcLink}.</p>`;
    } else {
      const fields = rightsFields(r);
      body = `<p class="claims-rule">${esc(r.rule)}</p>
      <dl class="claims-fields">
${fields.filter(f => f.key !== 'rule').map(f => `        <dt>${esc(f.label)}</dt><dd>${renderFieldValue(f.value)}</dd>`).join('\n')}
      </dl>
      ${renderSourceLinks(r)}`;
    }
    return `      <div class="claims-region-panel" data-region-panel="${esc(cc)}"${i === 0 ? '' : ' hidden'}>
        ${body}
      </div>`;
  }).join('\n');

  const tabs = claim.regions.map((cc, i) =>
    `        <button type="button" class="claims-tab${i === 0 ? ' active' : ''}" data-region-tab="${esc(cc)}">${esc(COUNTRY_LABELS[cc] || cc)}</button>`
  ).join('\n');

  return `    <section class="claims-section" id="your-rights">
      <h2 class="cl-section-title">Your rights</h2>
      <div class="claims-tabs" role="tablist" aria-label="Region">
${tabs}
      </div>
${panels}
    </section>`;
}

function buildByStateTable(claim, cc, r) {
  const states = Object.entries(r.by_state);
  const intro = r.rule ? `<p class="claims-rule">${esc(r.rule)}</p>` : '';
  const smallClaims = r.small_claims_route ? `<p class="claims-note">${esc(r.small_claims_route)}</p>` : '';
  const rows = states.map(([state, sv]) => {
    if (sv.status === 'PENDING_VERIFY') {
      return `          <tr data-state="${esc(state.toLowerCase())}"><td>${esc(state)}</td><td colspan="2">Not yet verified</td></tr>`;
    }
    const figs = Object.entries(sv)
      .filter(([k]) => !['status', 'verified_on', 'source_url', 'source'].includes(k))
      .map(([k, v]) => `<strong>${esc(humanizeKey(k))}:</strong> ${esc(v)}`)
      .join('<br>');
    const src = sv.source_url || sv.source;
    const srcCell = src ? `<a href="${esc(src)}" target="_blank" rel="noopener">Source &rarr;</a>` : '';
    return `          <tr data-state="${esc(state.toLowerCase())}"><td>${esc(state)}</td><td>${figs}</td><td>${srcCell}</td></tr>`;
  }).join('\n');

  const tableId = `byState-${cc}-${claim.slug}`;
  return `${intro}
      <input type="search" class="claims-state-search" data-table="${tableId}" placeholder="Search states..." aria-label="Search states">
      <div class="claims-table-wrap">
        <table class="claims-state-table" id="${tableId}">
          <thead><tr><th>State</th><th>Details</th><th></th></tr></thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>
      ${smallClaims}
      <script>
      (function () {
        var search = document.querySelector('input[data-table="${tableId}"]');
        var table = document.getElementById('${tableId}');
        if (!search || !table) return;
        search.addEventListener('input', function () {
          var q = search.value.trim().toLowerCase();
          Array.prototype.slice.call(table.querySelectorAll('tbody tr')).forEach(function (tr) {
            tr.hidden = q && tr.getAttribute('data-state').indexOf(q) === -1;
          });
        });
      })();
      </script>`;
}

function buildEvidenceSection(claim) {
  if (!claim.evidence.length) return '';
  return `    <section class="claims-section" id="evidence">
      <h2 class="cl-section-title">Evidence to gather</h2>
      <ul class="claims-list">
${claim.evidence.map(e => `        <li>${esc(e)}</li>`).join('\n')}
      </ul>
    </section>`;
}

function stripStepPrefix(s) {
  return s.replace(/^\d+\.\s*/, '');
}

function buildStepsSection(claim) {
  let stepsHtml;
  if (claim.steps) {
    stepsHtml = claim.steps.map(s => `        <li>${esc(stripStepPrefix(s))}</li>`).join('\n');
  } else {
    const parts = ['Gather your evidence (see the list above).', 'Send a written complaint to the business or provider, citing the rule for your region from "Your rights" above.', 'If unresolved by their deadline, escalate using the route named in "Your rights" for your region.', "If still unresolved, consider your region's ombudsman, regulator, or small claims court — see \"Your rights\" for the specific option."];
    stepsHtml = parts.map(s => `        <li>${esc(s)}</li>`).join('\n');
  }
  return `    <section class="claims-section" id="steps">
      <h2 class="cl-section-title">Steps</h2>
      <ol class="claims-steps">
${stepsHtml}
      </ol>
    </section>`;
}

function buildToolsSection(claim, report) {
  const groups = TOOL_TYPE_ORDER.filter(t => (claim.tools[t] || []).length).map(type => {
    const items = (claim.tools[type] || []).map(p => {
      const t = resolveTool(p);
      if (!t.exists) {
        report.missingTools.push(`${claim.slug} (${type}): ${p}`);
        return null;
      }
      return `          <li><a href="${esc(t.url)}">${esc(t.title)}</a></li>`;
    }).filter(Boolean);
    if (!items.length) return '';
    return `      <div class="claims-tool-group">
        <h3 class="claims-tool-group-title">${esc(TOOL_TYPE_LABELS[type])}</h3>
        <ul class="claims-list">
${items.join('\n')}
        </ul>
      </div>`;
  }).filter(Boolean).join('\n');

  if (!groups) return '';
  return `    <section class="claims-section" id="tools">
      <h2 class="cl-section-title">Your tools</h2>
      <div class="claims-tool-groups">
${groups}
      </div>
    </section>`;
}

function buildRelatedSection(claim, bySlug, report) {
  const realCasePaths = claim.tools.real_cases || [];
  const realCaseItems = realCasePaths.map(p => {
    const t = resolveTool(p);
    if (!t.exists) { report.missingTools.push(`${claim.slug} (real_cases): ${p}`); return null; }
    return `          <li><a href="${esc(t.url)}">${esc(t.title)}</a></li>`;
  }).filter(Boolean);

  const relatedItems = claim.relatedSlugs
    .map(s => bySlug.get(s))
    .filter(Boolean)
    .map(c => `          <li><a href="/claims/${esc(c.slug)}/">${esc(c.title)}</a></li>`);

  if (!realCaseItems.length && !relatedItems.length) return '';

  const realCaseBlock = realCaseItems.length ? `      <div class="claims-tool-group">
        <h3 class="claims-tool-group-title">Real Cases</h3>
        <ul class="claims-list">
${realCaseItems.join('\n')}
        </ul>
      </div>` : '';
  const relatedBlock = relatedItems.length ? `      <div class="claims-tool-group">
        <h3 class="claims-tool-group-title">Related claims</h3>
        <ul class="claims-list">
${relatedItems.join('\n')}
        </ul>
      </div>` : '';

  return `    <section class="claims-section" id="related">
      <h2 class="cl-section-title">Related guides</h2>
      <div class="claims-tool-groups">
${[realCaseBlock, relatedBlock].filter(Boolean).join('\n')}
      </div>
    </section>`;
}

function buildFaqJsonLd(claim) {
  const questions = [];
  for (const entry of claim.canYouClaim) {
    for (const cc of claim.regions) {
      if (entry[cc]) {
        questions.push({
          q: `${entry.q} (${COUNTRY_LABELS[cc] || cc})`,
          a: entry[cc],
        });
      }
    }
    if (entry.answer) questions.push({ q: entry.q, a: entry.answer });
  }
  if (!questions.length) return '';
  return `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
${questions.map(q => `    { "@type": "Question", "name": ${JSON.stringify(q.q)}, "acceptedAnswer": { "@type": "Answer", "text": ${JSON.stringify(q.a)} } }`).join(',\n')}
  ]
}
</script>`;
}

function buildClaimPage(claim, bySlug, report) {
  const canonical = `${SITE}/claims/${claim.slug}`;
  const title = `How to Claim ${claim.title}: Rights, Deadlines & Free Tools — Kibbo`;
  const regionLabels = claim.regions.map(cc => COUNTRY_LABELS[cc] || cc).join(', ');
  const description = `${claim.title}: know your rights in ${regionLabels}, the exact figures and deadlines from official sources, and free tools to act — generators, templates and checklists.`;

  const head = headBlock({ title, description, canonical });
  const breadcrumb = breadcrumbJsonLd([
    { name: 'Home', url: `${SITE}/` },
    { name: 'Claims', url: `${SITE}/claims` },
    { name: claim.title, url: canonical },
  ]);
  const faq = buildFaqJsonLd(claim);

  const verifiedLine = claim.lastVerified
    ? `<p class="claims-verified">Last verified: ${esc(fmtDate(claim.lastVerified))}</p>`
    : '';
  const regionTabsHero = claim.regions.map(cc => `<span class="cl-chip">${esc(COUNTRY_LABELS[cc] || cc)}</span>`).join(' ');

  const hero = navAndHero(
    claim.block,
    esc(claim.title),
    `Know your rights, the deadlines that apply, and the free tools to act on it.`,
    `${verifiedLine}<p style="margin-top:8px;">${regionTabsHero}</p>`,
  );

  const sections = [
    buildCanYouClaimSection(claim),
    buildRightsSection(claim),
    buildEvidenceSection(claim),
    buildStepsSection(claim),
    buildToolsSection(claim, report),
    buildRelatedSection(claim, bySlug, report),
  ].filter(Boolean).join('\n');

  const middle = `${sections}
    <p class="claims-disclaimer">Information, not legal advice. Figures verified against the official sources linked above.</p>
    <script>
    (function () {
      var tabs = Array.prototype.slice.call(document.querySelectorAll('.claims-tab'));
      var panels = Array.prototype.slice.call(document.querySelectorAll('#your-rights [data-region-panel]'));
      tabs.forEach(function (tab) {
        tab.addEventListener('click', function () {
          var region = tab.getAttribute('data-region-tab');
          tabs.forEach(function (t) { t.classList.toggle('active', t === tab); });
          panels.forEach(function (p) {
            p.hidden = p.getAttribute('data-region-panel') !== region;
          });
        });
      });
    })();
    </script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
${head}
${breadcrumb}
${faq}
</head>
<body>

${hero}

<main class="section-main">
  <div class="container claims-detail">
${CLAIMS_START}
${middle}
${CLAIMS_END}
  </div>
</main>

${footer()}

</body>
</html>
`;
}

// ------------------------------------------------------------------ css

const CLAIMS_CSS_START = '/* CLAIMS:START */';
const CLAIMS_CSS_END = '/* CLAIMS:END */';

const CLAIMS_CSS = `${CLAIMS_CSS_START}
.claims-toolbar { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; justify-content: space-between; margin-bottom: 32px; }
.claims-search { flex: 1 1 320px; max-width: 480px; padding: 12px 18px; border: 1px solid var(--border); border-radius: 100px; font-family: var(--font-sans); font-size: 14.5px; background: var(--bg-card); color: var(--text-primary); }
.claims-search:focus { outline: none; border-color: var(--accent-green); }
.claims-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.claims-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: var(--text-secondary); background: var(--bg-card); border: 1px solid var(--border); padding: 7px 16px; border-radius: 100px; cursor: pointer; font-family: var(--font-sans); transition: var(--transition); }
.claims-chip:hover { border-color: var(--accent-green); color: var(--accent-green); }
.claims-chip.active { background: var(--text-primary); color: var(--text-inverse); border-color: var(--text-primary); }
.claims-empty { color: var(--text-secondary); font-size: 14.5px; padding: 24px 0; }
.claims-block { margin-bottom: 40px; }
.claims-detail { max-width: 760px; }
.claims-verified { font-size: 13px; color: var(--text-muted); margin-top: 16px; }
.claims-section { margin-top: 40px; padding-top: 32px; border-top: 1px solid var(--border); }
.claims-section:first-child { margin-top: 0; padding-top: 0; border-top: none; }
.claims-tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
.claims-tab { font-size: 13.5px; font-weight: 600; color: var(--text-secondary); background: var(--bg-card); border: 1px solid var(--border); padding: 8px 18px; border-radius: 100px; cursor: pointer; font-family: var(--font-sans); }
.claims-tab:hover { border-color: var(--accent-green); color: var(--accent-green); }
.claims-tab.active { background: var(--accent-green); color: var(--text-inverse); border-color: var(--accent-green); }
.claims-region-panel[hidden] { display: none; }
.claims-rule { font-family: var(--font-serif); font-size: 17px; font-weight: 600; color: var(--text-primary); margin-bottom: 14px; }
.claims-fields { display: grid; grid-template-columns: max-content 1fr; gap: 8px 18px; font-size: 14.5px; }
.claims-fields dt { font-weight: 600; color: var(--text-primary); }
.claims-fields dd { color: var(--text-secondary); line-height: 1.6; }
.claims-field-list { margin: 0; padding-left: 18px; }
.claims-subfields { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; font-size: 13.5px; }
.claims-subfields dt { font-weight: 600; }
.claims-source { margin-top: 16px; font-size: 13.5px; }
.claims-source a { color: var(--accent-green); font-weight: 600; text-decoration: none; }
.claims-source a:hover { text-decoration: underline; }
.claims-pending { font-size: 15px; color: var(--text-secondary); font-style: italic; }
.claims-pending a { color: var(--accent-green); font-weight: 600; }
.claims-cyq { margin-bottom: 20px; }
.claims-cyq-q { font-weight: 600; color: var(--text-primary); margin-bottom: 8px; }
.claims-cyq-answer { font-size: 14.5px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 4px; }
.claims-list { padding-left: 20px; font-size: 14.5px; color: var(--text-secondary); line-height: 1.8; }
.claims-list a { color: var(--accent-green); font-weight: 600; text-decoration: none; }
.claims-list a:hover { text-decoration: underline; }
.claims-steps { padding-left: 20px; font-size: 15px; color: var(--text-secondary); line-height: 1.9; }
.claims-tool-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 24px; }
.claims-tool-group-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 10px; }
.claims-state-search { width: 100%; max-width: 320px; padding: 10px 16px; border: 1px solid var(--border); border-radius: 100px; font-family: var(--font-sans); font-size: 14px; margin-bottom: 16px; display: block; }
.claims-table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.claims-state-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.claims-state-table th { text-align: left; padding: 10px 14px; background: var(--bg); border-bottom: 1px solid var(--border); font-weight: 700; }
.claims-state-table td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: top; color: var(--text-secondary); }
.claims-state-table tr:last-child td { border-bottom: none; }
.claims-state-table a { color: var(--accent-green); font-weight: 600; text-decoration: none; white-space: nowrap; }
.claims-note { font-size: 13px; color: var(--text-muted); margin-top: 12px; }
.claims-disclaimer { margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--border); font-size: 12.5px; color: var(--text-muted); }
${CLAIMS_CSS_END}`;

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

function updateStylesCss() {
  const filePath = path.join(ROOT, 'styles.css');
  let raw = fs.readFileSync(filePath, 'utf8');
  if (raw.includes(CLAIMS_CSS_START)) {
    raw = injectBetweenMarkersRaw(raw, CLAIMS_CSS.slice(CLAIMS_CSS_START.length, -CLAIMS_CSS_END.length).trim(), CLAIMS_CSS_START, CLAIMS_CSS_END, 'styles.css');
  } else {
    raw = raw.replace(/\s*$/, '\n') + '\n' + CLAIMS_CSS + '\n';
  }
  fs.writeFileSync(filePath, raw);
  console.log('Updated styles.css (.claims-* rules)');
}

// --------------------------------------------------------------- sitemap

function updateSitemap(normalized) {
  const filePath = path.join(ROOT, 'sitemap.xml');
  let raw = fs.readFileSync(filePath, 'utf8');
  const today = new Date().toISOString().slice(0, 10);
  const urls = [`${SITE}/claims`, ...normalized.map(c => `${SITE}/claims/${c.slug}`)];
  const block = urls.map(u => `  <url>\n    <loc>${u}</loc>\n    <lastmod>${today}</lastmod>\n  </url>`).join('\n');

  if (raw.includes(SITEMAP_START)) {
    raw = injectBetweenMarkersRaw(raw, block, SITEMAP_START, SITEMAP_END, 'sitemap.xml');
  } else {
    raw = raw.replace('</urlset>', `${SITEMAP_START}\n${block}\n${SITEMAP_END}\n</urlset>`);
  }
  fs.writeFileSync(filePath, raw);
  console.log(`Updated sitemap.xml (${urls.length} claim URLs)`);
}

// ---------------------------------------------------------- search-index

function updateSearchIndex(normalized) {
  const filePath = path.join(ROOT, 'search-index.json');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const kept = data.filter(d => !d.url.startsWith('/claims'));

  const entries = [{
    title: 'Claims: How to Claim Your Consumer Rights',
    type: 'claim',
    block: 'general',
    url: '/claims',
    description: 'Know your rights and claim what you\'re owed — flight delays, bank errors, deposits, unpaid wages and more, for the US, UK and Europe.',
    keywords: ['how to claim', 'know your rights', 'consumer rights by problem'],
  }];
  for (const c of normalized) {
    entries.push({
      title: c.title,
      type: 'claim',
      block: c.block,
      url: `/claims/${c.slug}`,
      description: `${c.title}: rights, deadlines and free tools for ${c.regions.map(cc => COUNTRY_LABELS[cc] || cc).join(', ')}.`,
      keywords: [c.title.toLowerCase(), c.block.toLowerCase()],
    });
  }

  const merged = kept.concat(entries);
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + '\n');
  console.log(`Updated search-index.json (+${entries.length} claim entries)`);
}

// ---------------------------------------------------------------- main

function main() {
  const report = { missingTools: [] };
  const raw = loadAllClaims();
  const normalized = raw.map(c => normalizeClaim(c, raw));
  const bySlug = new Map(normalized.map(c => [c.slug, c]));

  // Hub page
  fs.mkdirSync(path.join(ROOT, 'claims'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'claims', 'index.html'), buildHubPage(normalized));
  console.log('Wrote claims/index.html');

  // Claim pages
  for (const claim of normalized) {
    const dir = path.join(ROOT, 'claims', claim.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), buildClaimPage(claim, bySlug, report));
    console.log(`Wrote claims/${claim.slug}/index.html`);
  }

  updateStylesCss();
  updateSitemap(normalized);
  updateSearchIndex(normalized);

  // ---------------------------------------------------------- final report
  console.log('\n=== Build report ===');
  console.log(`Claims built: ${normalized.length}`);
  for (const c of normalized) {
    const regionLabels = c.regions.map(cc => COUNTRY_LABELS[cc] || cc).join(', ');
    const pendingBits = [];
    for (const cc of c.regions) {
      const r = c.rights[cc];
      if (r.status === 'PENDING_VERIFY') pendingBits.push(`${cc} (whole region)`);
      if (r.by_state) {
        const n = Object.values(r.by_state).filter(sv => sv.status === 'PENDING_VERIFY').length;
        if (n) pendingBits.push(`${cc}: ${n} state(s) in by_state`);
      }
    }
    console.log(`- ${c.slug}: regions [${regionLabels}]${pendingBits.length ? ' | still verifying: ' + pendingBits.join('; ') : ''}`);
  }
  console.log(`\nMissing tool paths (skipped): ${report.missingTools.length}`);
  report.missingTools.forEach(m => console.log(`  - ${m}`));
  console.log('\nDone.');
}

main();
