/* Parcel Help triage — /parcel-help. Standalone, client-side only, same
 * pattern as generate/delivery-claim-generator.js: no shared wizard engine
 * (decision-tree-core.js only models a 2-axis problem x country grid from
 * a single wizard-config.json, with at most one bonus "intermediate"
 * screen reusing that same 2-axis combo — it has no concept of a third
 * independent question like payment method, a fourth optional one like
 * carrier, or loading two separate JSON files with our nested schema).
 * So this is its own small file, fetching the same two JSON files the
 * generator uses (data/delivery-triage/scenarios.json and carriers.json)
 * and building the result entirely in the browser. Nothing typed here is
 * sent or stored anywhere.
 */
(function () {
  'use strict';

  var IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';

  var SCENARIOS_URL = '/data/delivery-triage/scenarios.json';
  var CARRIERS_URL = '/data/delivery-triage/carriers.json';
  var MARKETPLACES_URL = '/data/delivery-triage/marketplaces.json';

  var SCENARIOS = null;
  var CARRIERS = null;
  var MARKETPLACES = null;

  function setData(scenariosData, carriersData, marketplacesData) {
    SCENARIOS = scenariosData;
    CARRIERS = carriersData;
    MARKETPLACES = marketplacesData || null;
  }

  var COUNTRY_LABELS = { UK: 'United Kingdom', US: 'United States', EU: 'European Union', AU: 'Australia' };

  // Plain, first-person wording for the "what happened?" step — the JSON's
  // own `label` field is already fairly plain (and is what the generator's
  // dropdown uses), but this page asks the question more conversationally.
  // Presentation only — no legal fact lives here.
  var PLAIN_LABELS = {
    marked_delivered_not_received: 'Marked delivered but I never got it',
    never_arrived: 'It never arrived / lost in transit',
    damaged: 'It arrived damaged',
    wrong_address_or_unsafe_place: 'Left at the wrong address, or somewhere unsafe',
    signature_not_yours: "The signature on file isn't mine",
    missing_items: 'Part of my order is missing',
    arrived_late: 'It arrived (or still hasn\'t) much later than promised',
    customs_import_charges: 'I was charged customs duty or import VAT I think is wrong',
    lost_return_shipment: 'My return shipment back to the seller got lost',
    seller_says_claim_from_carrier: 'The seller told me to claim from the carrier instead',
  };

  // Secondary resources, hand-mapped to the live site inventory (checked
  // against git-tracked files before being added here — never guessed).
  // Per scenario: a country-agnostic set plus country-specific extras.
  // Anything not listed here is simply not shown — "skip anything missing"
  // rather than force a fit.
  var RESOURCE_MAP = {
    marked_delivered_not_received: {
      checklist: '/checklists/lost-parcel-verification-checklist',
      template: '/templates/lost-parcel-claim-pack',
      calculator: '/delivery-parcels/calculators/lost-parcel-claim-calculator',
      kit: '/kits/lost-stolen-package',
      byCountry: {
        UK: { question: '/questions/delivery-parcels/who-is-responsible-parcel-delivered-not-received', blog: '/blog/royal-mail-lost-parcel-claim-uk' },
        US: { blog: '/blog/usps-domestic-claims-us' }
      }
    },
    never_arrived: {
      checklist: '/checklists/lost-parcel-verification-checklist',
      template: '/templates/lost-parcel-claim-pack',
      calculator: '/delivery-parcels/calculators/lost-parcel-claim-calculator',
      kit: '/kits/lost-stolen-package',
      byCountry: {
        UK: { blog: '/blog/evri-lost-parcel-uk' },
        US: { blog: '/blog/fedex-missing-shipment-claim' },
        AU: { blog: '/blog/au-acl-section-62-reasonable-time-delivery' }
      }
    },
    damaged: {
      template: '/templates/damaged-delivery-evidence-pack',
      byCountry: {
        UK: { question: '/questions/delivery-parcels/can-seller-blame-courier-order-arrives-damaged', blog: '/blog/dpd-lost-damaged-parcel-uk' },
        US: { blog: '/blog/dhl-lost-parcel-claim' }
      }
    },
    wrong_address_or_unsafe_place: {
      template: '/templates/wrong-missing-item-delivery-pack',
      byCountry: {
        UK: { question: '/questions/delivery-parcels/can-courier-leave-parcel-outside-without-permission', blog: '/blog/uk-unauthorized-safe-place-delivery-theft' }
      }
    },
    signature_not_yours: {
      kit: '/kits/lost-stolen-package',
      byCountry: {
        UK: { blog: '/blog/uk-unauthorized-safe-place-delivery-theft' }
      }
    },
    missing_items: {
      template: '/templates/wrong-missing-item-delivery-pack',
      byCountry: {}
    },
    arrived_late: {
      template: '/templates/shipping-delivery-timeline-tracker',
      calculator: '/delivery-parcels/calculators/late-delivery-compensation-calculator',
      byCountry: {
        UK: { question: '/questions/delivery-parcels/can-i-demand-refund-parcel-arrives-weeks-late' },
        EU: { blog: '/blog/eu-article-18-30-day-delivery-rule' }
      }
    },
    customs_import_charges: {
      checklist: '/checklists/unexpected-customs-charges-checklist',
      template: '/templates/customs-duty-import-fee-dispute-worksheet',
      kit: '/kits/unexpected-customs-charges',
      byCountry: {
        EU: { blog: '/blog/eu-ioss-hidden-customs-clearance-fees' }
      }
    },
    lost_return_shipment: {
      template: '/templates/delivery-evidence-log',
      byCountry: {}
    },
    seller_says_claim_from_carrier: {
      checklist: '/checklists/delivery-partner-checklist',
      byCountry: {
        UK: { blog: '/blog/uk-postrs-ofcom-courier-complaint-jurisdiction' }
      }
    }
  };

  // A claims-hub link that exists for every scenario, as a reliable
  // fallback secondary link even where RESOURCE_MAP has gaps.
  var CLAIMS_HUB_URL = { customs_import_charges: '/claims/unexpected-customs-charges' };
  function claimsHubFor(scenarioId) {
    return CLAIMS_HUB_URL[scenarioId] || '/claims/lost-parcel';
  }

  function resourceLinksFor(scenarioId, country) {
    var base = RESOURCE_MAP[scenarioId] || {};
    var byCountry = (base.byCountry && base.byCountry[country]) || {};
    var links = [];
    if (base.checklist) links.push({ label: 'Checklist', url: base.checklist });
    if (base.template) links.push({ label: 'Evidence template', url: base.template });
    if (base.calculator) links.push({ label: 'Calculator', url: base.calculator });
    if (base.kit) links.push({ label: 'Action kit', url: base.kit });
    if (byCountry.question) links.push({ label: 'Related question', url: byCountry.question });
    if (byCountry.blog) links.push({ label: 'Guide', url: byCountry.blog });
    links.push({ label: 'Know your rights', url: claimsHubFor(scenarioId) });
    return links;
  }

  // ------------------------------------------------------------------
  // Small helpers (same conventions as delivery-claim-generator.js)
  // ------------------------------------------------------------------
  function getScenario(id) {
    return (SCENARIOS.scenarios || []).find(function (s) { return s.id === id; });
  }
  function getCell(scenarioId, country) {
    var s = getScenario(scenarioId);
    return s ? s.by_country[country] : null;
  }
  function getCarrier(name) {
    return (CARRIERS.carriers || []).find(function (c) { return c.name === name; });
  }
  function getCountryRoutes(country) {
    return (CARRIERS.country_dispute_routes || {})[country] || null;
  }
  function orFallback(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    return value;
  }

  function addSource(list, seen, label, url, verifiedOn) {
    if (!url || seen[url]) return;
    seen[url] = true;
    list.push({ label: label, url: url, verifiedOn: verifiedOn || null });
  }

  // ------------------------------------------------------------------
  // Marketplace layer (phase 5b-2) — reads ONLY data/delivery-triage/
  // marketplaces.json. Duplicated in generate/delivery-claim-generator.js
  // rather than shared, matching this site's existing convention of each
  // standalone tool owning its own copy of small data-access helpers.
  // ------------------------------------------------------------------
  function getMarketplaceNames() {
    return MARKETPLACES ? (MARKETPLACES.platforms || []).map(function (p) { return p.name; }) : [];
  }
  function getMarketplace(name) {
    return MARKETPLACES ? (MARKETPLACES.platforms || []).find(function (p) { return p.name === name; }) : null;
  }
  function getMarketplaceCell(name, country) {
    var m = getMarketplace(name);
    return (m && m.by_country && m.by_country[country]) || null;
  }
  // A value counts as "empty" the same way whether it's a string or array
  // — this is what triggers the neutral "check the official page" fallback.
  function isEmptyField(v) {
    return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
  }
  function isCellAllNull(cell) {
    return isEmptyField(cell.buyer_protection_name) &&
      isEmptyField(cell.buyer_protection_covers) &&
      isEmptyField(cell.buyer_protection_excludes) &&
      isEmptyField(cell.claim_window) &&
      isEmptyField(cell.evidence_required) &&
      isEmptyField(cell.escalation_internal) &&
      isEmptyField(cell.escalation_external);
  }
  // Returns the real value unchanged, or a neutral fallback that links to
  // the cell's own first source (never an invented URL) when the field is
  // null/empty in the data.
  function fieldOrNeutral(value, platformName, cell) {
    if (!isEmptyField(value)) return value;
    var link = (cell.sources && cell.sources.length) ? cell.sources[0] : null;
    return 'Not stated in our data — check ' + platformName + '\'s official page directly' + (link ? (': ' + link) : '') + '.';
  }
  function isPastReviewBy(reviewByStr, nowDate) {
    if (!reviewByStr) return false;
    var now = nowDate || new Date();
    var due = new Date(reviewByStr + 'T00:00:00');
    return !isNaN(due.getTime()) && now > due;
  }

  // Pure function: given a marketplace name (or '' / 'Other' / falsy for
  // "none") and a country, returns the block the result renders, or null
  // if no marketplace was chosen. Never invents a fact — every non-null
  // field comes straight from marketplaces.json; every null field becomes
  // a neutral message pointing at the cell's own source, if one exists.
  function buildMarketplaceBlock(marketplaceName, country) {
    if (!marketplaceName || marketplaceName === 'Other') return null;
    if (!MARKETPLACES) {
      return { platformName: marketplaceName, country: country, allNull: true, sources: [], verifiedOn: null, reviewBy: null, stale: false,
        neutralMessage: 'We do not have verified marketplace-protection details for ' + marketplaceName + ' loaded — check ' + marketplaceName + '\'s official page directly.' };
    }
    var cell = getMarketplaceCell(marketplaceName, country);
    var globalReviewBy = MARKETPLACES.review_by || null;
    if (!cell) {
      return { platformName: marketplaceName, country: country, allNull: true, sources: [], verifiedOn: null, reviewBy: globalReviewBy, stale: isPastReviewBy(globalReviewBy),
        neutralMessage: 'We do not have verified marketplace-protection details for ' + marketplaceName + ' in ' + country + ' — check ' + marketplaceName + '\'s official page directly.' };
    }
    var reviewBy = cell.review_by || globalReviewBy;
    if (isCellAllNull(cell)) {
      var link = (cell.sources && cell.sources.length) ? cell.sources[0] : null;
      return { platformName: marketplaceName, country: country, allNull: true, sources: cell.sources || [], verifiedOn: cell.verified_on || null, reviewBy: reviewBy, stale: isPastReviewBy(reviewBy),
        neutralMessage: 'We do not have verified marketplace-protection details for ' + marketplaceName + ' in ' + country + ' yet — check ' + marketplaceName + '\'s official page directly' + (link ? (': ' + link) : '') + '.' };
    }
    return {
      platformName: marketplaceName,
      country: country,
      allNull: false,
      name: fieldOrNeutral(cell.buyer_protection_name, marketplaceName, cell),
      covers: fieldOrNeutral(cell.buyer_protection_covers, marketplaceName, cell),
      excludes: fieldOrNeutral(cell.buyer_protection_excludes, marketplaceName, cell),
      claimWindow: fieldOrNeutral(cell.claim_window, marketplaceName, cell),
      evidenceRequired: fieldOrNeutral(cell.evidence_required, marketplaceName, cell),
      escalationInternal: fieldOrNeutral(cell.escalation_internal, marketplaceName, cell),
      escalationExternal: fieldOrNeutral(cell.escalation_external, marketplaceName, cell),
      // Bonus field (not in the core list) shown only when the data has
      // it — this is where country-specific differences like Etsy's
      // UK-only 14-day cooling-off right, or its US-only DDP/customs
      // refund protection, actually live. No neutral fallback: if it's
      // null we simply omit the line rather than clutter the result.
      returnsPolicyBasics: isEmptyField(cell.returns_policy_basics) ? null : cell.returns_policy_basics,
      sources: cell.sources || [],
      verifiedOn: cell.verified_on || null,
      reviewBy: reviewBy,
      stale: isPastReviewBy(reviewBy),
    };
  }

  function paramString(inputs) {
    var params = [];
    if (inputs.country) params.push('country=' + encodeURIComponent(inputs.country));
    if (inputs.scenarioId) params.push('scenario=' + encodeURIComponent(inputs.scenarioId));
    if (inputs.paidBy) params.push('payment=' + encodeURIComponent(inputs.paidBy));
    if (inputs.carrierName) params.push('carrier=' + encodeURIComponent(inputs.carrierName));
    if (inputs.marketplaceName) params.push('marketplace=' + encodeURIComponent(inputs.marketplaceName));
    return params.length ? '?' + params.join('&') : '';
  }

  function buildGeneratorUrl(inputs) {
    return '/generate/delivery-claim-generator' + paramString(inputs);
  }

  function buildShareUrl(inputs) {
    if (!IS_BROWSER) return '';
    return window.location.origin + window.location.pathname + paramString(inputs);
  }

  // Pure function: given { country, scenarioId, paidBy, carrierName },
  // returns the full result object the page renders. No DOM, no fetch —
  // safe to call from Node tests once setData() has been called.
  function buildResult(inputs) {
    var scenario = getScenario(inputs.scenarioId);
    var cell = getCell(inputs.scenarioId, inputs.country) || {};
    var carrier = inputs.carrierName && inputs.carrierName !== 'Other' ? getCarrier(inputs.carrierName) : null;
    var routes = getCountryRoutes(inputs.country);
    var cdr = routes ? routes.card_dispute_route : null;
    var ombudsman = routes ? routes.ombudsman_regulator : null;

    var sources = [];
    var seen = {};
    (cell.sources || []).forEach(function (s) { addSource(sources, seen, 'Scenario rule (' + inputs.country + ')', s, cell.verified_on); });
    if (carrier && carrier.sources) {
      carrier.sources.forEach(function (s) { addSource(sources, seen, carrier.name, s, carrier.verified_on); });
    }
    if (cdr && cdr.sources) {
      cdr.sources.forEach(function (s) { addSource(sources, seen, 'Card dispute route (' + inputs.country + ')', s, cdr.verified_on); });
    }
    if (ombudsman && ombudsman.sources) {
      ombudsman.sources.forEach(function (s) { addSource(sources, seen, ombudsman.name, s, ombudsman.verified_on); });
    }

    var liableParty = orFallback(cell.liable_party, 'Not pinned down for ' + inputs.country + ' in our data — this generally depends on the seller\'s own shipping terms. Check the official source below, or ask the seller directly.');
    var legalBasis = orFallback(cell.legal_basis, 'We do not have a verified legal basis for this exact situation in ' + inputs.country + ' — check the official page for the relevant law or carrier policy directly.');
    var deadlines = (cell.deadlines && cell.deadlines.length) ? cell.deadlines.slice() : null;

    var ukPostrsNote = null;
    if (inputs.country === 'UK') {
      ukPostrsNote = carrier && carrier.name === 'Royal Mail'
        ? 'Your carrier is Royal Mail, so if this is not resolved directly you can escalate to POSTRS (the Postal Redress Service).'
        : 'POSTRS (the Postal Redress Service) only covers Royal Mail — it does not cover other couriers. If you used a different carrier, use the escalation route that applies to that carrier (or the card-dispute route below) instead.';
    }

    // When a marketplace is chosen, the platform's own case system is the
    // step between the seller and a card dispute — open it within its
    // claim window, before escalating further. 'Other'/empty means "no
    // marketplace chosen" (same rule buildMarketplaceBlock applies).
    var hasMarketplace = !!(inputs.marketplaceName && inputs.marketplaceName !== 'Other');
    var steps = hasMarketplace
      ? ['Contact the seller first', 'If unresolved, open a case with ' + inputs.marketplaceName + ' within its claim window', 'If still unresolved, open a card/payment dispute', 'Where one genuinely applies, escalate to the ombudsman or regulator']
      : ['Contact the seller first', 'If unresolved, contact the carrier', 'If still unresolved, open a card/payment dispute', 'Where one genuinely applies, escalate to the ombudsman or regulator'];

    return {
      scenarioLabel: scenario ? scenario.label : inputs.scenarioId,
      country: inputs.country,
      countryLabel: COUNTRY_LABELS[inputs.country] || inputs.country,
      liableParty: liableParty,
      legalBasis: legalBasis,
      deadlines: deadlines,
      steps: steps,
      ukPostrsNote: ukPostrsNote,
      sources: sources,
      generatorUrl: buildGeneratorUrl(inputs),
      secondaryLinks: resourceLinksFor(inputs.scenarioId, inputs.country),
      marketplaceBlock: buildMarketplaceBlock(inputs.marketplaceName, inputs.country),
    };
  }

  // ------------------------------------------------------------------
  // TEST EXPORTS (Node only — no effect on browser behaviour)
  // ------------------------------------------------------------------
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      setData: setData,
      buildResult: buildResult,
      buildGeneratorUrl: buildGeneratorUrl,
      resourceLinksFor: resourceLinksFor,
      buildMarketplaceBlock: buildMarketplaceBlock,
      getMarketplaceNames: getMarketplaceNames,
      isPastReviewBy: isPastReviewBy,
      RESOURCE_MAP: RESOURCE_MAP,
      PLAIN_LABELS: PLAIN_LABELS,
    };
  }

  if (!IS_BROWSER) return;

  // ------------------------------------------------------------------
  // Browser-only: DOM wiring
  // ------------------------------------------------------------------
  var countrySelect = document.getElementById('ph-country');
  var scenarioSelect = document.getElementById('ph-scenario');
  var paidSelect = document.getElementById('ph-paid');
  var carrierSelect = document.getElementById('ph-carrier');
  var carrierOtherWrap = document.getElementById('ph-carrier-other-wrap');
  var carrierOtherInput = document.getElementById('ph-carrier-other');
  var marketplaceSelect = document.getElementById('ph-marketplace');
  var goBtn = document.getElementById('phGoBtn');
  var errorBox = document.getElementById('phError');
  var formSection = document.getElementById('phForm');
  var resultSection = document.getElementById('phResult');

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.style.display = 'block';
  }
  function clearError() {
    errorBox.style.display = 'none';
    errorBox.textContent = '';
  }

  function populateSelects() {
    SCENARIOS.countries.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c;
      opt.textContent = COUNTRY_LABELS[c] || c;
      countrySelect.appendChild(opt);
    });
    SCENARIOS.scenarios.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = PLAIN_LABELS[s.id] || s.label;
      scenarioSelect.appendChild(opt);
    });
    CARRIERS.carriers.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.name;
      opt.textContent = c.name;
      carrierSelect.appendChild(opt);
    });
    var otherOpt = document.createElement('option');
    otherOpt.value = 'Other';
    otherOpt.textContent = 'Other / not listed';
    carrierSelect.appendChild(otherOpt);

    getMarketplaceNames().forEach(function (name) {
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      marketplaceSelect.appendChild(opt);
    });
    var otherMarketOpt = document.createElement('option');
    otherMarketOpt.value = 'Other';
    otherMarketOpt.textContent = 'Other / not sure';
    marketplaceSelect.appendChild(otherMarketOpt);
  }

  carrierSelect.addEventListener('change', function () {
    carrierOtherWrap.style.display = carrierSelect.value === 'Other' ? 'block' : 'none';
  });

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function joinIfArray(v) {
    return Array.isArray(v) ? v.join('; ') : v;
  }

  function renderMarketplaceBlock(block) {
    var wrap = el('div');
    wrap.style.marginTop = '24px';
    wrap.appendChild(el('h2', 'supp-ingredients-heading', 'Marketplace protection — ' + block.platformName));

    var box = el('div', 'gen-letter');
    var visible = el('div', 'gen-visible');
    var lines = [];

    if (block.allNull) {
      lines.push(block.neutralMessage);
    } else {
      lines.push('Protection: ' + joinIfArray(block.name));
      lines.push('');
      lines.push('Covers: ' + joinIfArray(block.covers));
      lines.push('');
      lines.push('Does not cover: ' + joinIfArray(block.excludes));
      lines.push('');
      lines.push('Claim window / how to open a case: ' + joinIfArray(block.claimWindow));
      lines.push('');
      lines.push('Evidence they ask for: ' + joinIfArray(block.evidenceRequired));
      lines.push('');
      lines.push('Escalation inside the platform: ' + joinIfArray(block.escalationInternal));
      lines.push('');
      lines.push('External escalation: ' + joinIfArray(block.escalationExternal));
      if (block.returnsPolicyBasics) {
        lines.push('');
        lines.push('Returns policy: ' + joinIfArray(block.returnsPolicyBasics));
      }
    }

    if (block.sources && block.sources.length) {
      lines.push('');
      lines.push('Source' + (block.sources.length > 1 ? 's' : '') + ': ' + block.sources.join(' · ') + (block.verifiedOn ? ' (verified ' + block.verifiedOn + ')' : ''));
    }
    if (block.stale) {
      lines.push('');
      lines.push('This policy was last verified on ' + (block.verifiedOn || 'an earlier date') + '; platforms change their rules, so check the official page above before relying on it.');
    }
    lines.push('');
    lines.push('This is general information, not legal advice.');

    visible.textContent = lines.join('\n');
    box.appendChild(visible);
    wrap.appendChild(box);
    return wrap;
  }

  function renderResult(result, inputs) {
    resultSection.innerHTML = '';
    resultSection.style.display = 'block';

    resultSection.appendChild(el('h2', 'supp-ingredients-heading', 'What applies to you'));

    var summary = el('div', 'gen-letter');
    var visible = el('div', 'gen-visible');
    var lines = [];
    lines.push('Situation: ' + result.scenarioLabel + ' (' + result.countryLabel + ')');
    lines.push('');
    lines.push('Who is responsible: ' + result.liableParty);
    lines.push('');
    lines.push('Legal basis: ' + result.legalBasis);
    lines.push('');
    if (result.deadlines) {
      lines.push('Deadlines we have on record: ' + result.deadlines.join(' '));
    } else {
      lines.push('We do not have a specific confirmed deadline for this combination — act as soon as reasonably possible.');
    }
    lines.push('');
    lines.push('Recommended order: ' + result.steps.join(' → '));
    if (result.ukPostrsNote) {
      lines.push('');
      lines.push(result.ukPostrsNote);
    }
    lines.push('');
    lines.push('This is general information, not legal advice.');
    visible.textContent = lines.join('\n');
    summary.appendChild(visible);
    resultSection.appendChild(summary);

    var ctaWrap = el('div');
    ctaWrap.style.margin = '20px 0';
    var writeBtn = el('a', 'supp-analyze', 'Write my letters →');
    writeBtn.href = result.generatorUrl;
    writeBtn.style.display = 'inline-block';
    writeBtn.style.textDecoration = 'none';
    writeBtn.style.textAlign = 'center';
    ctaWrap.appendChild(writeBtn);
    resultSection.appendChild(ctaWrap);

    if (result.marketplaceBlock) {
      resultSection.appendChild(renderMarketplaceBlock(result.marketplaceBlock));
    }

    if (result.secondaryLinks && result.secondaryLinks.length) {
      var secWrap = el('div', 'supp-cross');
      secWrap.appendChild(el('p', 'supp-cross-title', 'Related resources'));
      var p = el('p');
      result.secondaryLinks.forEach(function (link, i) {
        if (i > 0) p.appendChild(document.createTextNode(' · '));
        var a = el('a', null, link.label);
        a.href = link.url;
        p.appendChild(a);
      });
      secWrap.appendChild(p);
      resultSection.appendChild(secWrap);
    }

    if (result.sources && result.sources.length) {
      var srcWrap = el('div');
      srcWrap.appendChild(el('p', 'supp-fineprint', 'Sources: ' +
        result.sources.map(function (s) { return s.label + (s.verifiedOn ? ' (verified ' + s.verifiedOn + ')' : ''); }).join(' · ')));
      var srcLinks = el('p');
      result.sources.forEach(function (s, i) {
        if (i > 0) srcLinks.appendChild(document.createTextNode(' · '));
        var a = el('a', null, s.label);
        a.href = s.url;
        a.target = '_blank';
        a.rel = 'noopener';
        srcLinks.appendChild(a);
      });
      srcWrap.appendChild(srcLinks);
      resultSection.appendChild(srcWrap);
    }

    var copyLinkBtn = el('button', 'gen-copy', 'Copy link to this result');
    copyLinkBtn.type = 'button';
    copyLinkBtn.addEventListener('click', function () {
      var shareUrl = buildShareUrl(inputs);
      navigator.clipboard.writeText(shareUrl).then(function () {
        copyLinkBtn.textContent = 'Link copied ✓';
        setTimeout(function () { copyLinkBtn.textContent = 'Copy link to this result'; }, 2000);
      });
    });
    resultSection.appendChild(copyLinkBtn);

    var backBtn = el('button', 'gen-copy', '← Start over');
    backBtn.type = 'button';
    backBtn.addEventListener('click', function () {
      resultSection.style.display = 'none';
      formSection.style.display = 'block';
      formSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    resultSection.appendChild(backBtn);

    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function readInputs() {
    var carrierName = carrierSelect.value;
    var marketplaceName = marketplaceSelect.value;
    return {
      country: countrySelect.value,
      scenarioId: scenarioSelect.value,
      paidBy: paidSelect.value,
      carrierName: carrierName === 'Other' ? (carrierOtherInput.value.trim() || '') : carrierName,
      marketplaceName: marketplaceName === 'Other' ? '' : marketplaceName,
    };
  }

  function go() {
    clearError();
    var inputs = readInputs();
    if (!inputs.country || !inputs.scenarioId) {
      showError('Please select your country and what happened.');
      return;
    }
    formSection.style.display = 'none';
    var result = buildResult(inputs);
    renderResult(result, inputs);
  }

  function applyDeepLinkParams() {
    var params;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (e) {
      return;
    }
    var country = params.get('country');
    var scenarioId = params.get('scenario');
    var payment = params.get('payment');
    var carrier = params.get('carrier');
    var marketplace = params.get('marketplace');

    var validCountry = !!(country && SCENARIOS.countries.indexOf(country) !== -1);
    var validScenario = !!(scenarioId && getScenario(scenarioId));
    var validPayment = !!(payment && ['card', 'paypal', 'other'].indexOf(payment) !== -1);
    var validMarketplace = !!(marketplace && getMarketplaceNames().indexOf(marketplace) !== -1);

    if (validCountry) countrySelect.value = country;
    if (validScenario) scenarioSelect.value = scenarioId;
    if (validPayment) paidSelect.value = payment;
    if (validMarketplace) marketplaceSelect.value = marketplace;

    if (carrier) {
      if (getCarrier(carrier)) {
        carrierSelect.value = carrier;
      } else if (carrier.trim()) {
        carrierSelect.value = 'Other';
        carrierOtherWrap.style.display = 'block';
        carrierOtherInput.value = carrier.trim();
      }
    }

    if (validCountry && validScenario) {
      go();
    }
  }

  function loadData() {
    return Promise.all([
      fetch(SCENARIOS_URL).then(function (r) { return r.json(); }),
      fetch(CARRIERS_URL).then(function (r) { return r.json(); }),
      fetch(MARKETPLACES_URL).then(function (r) { return r.json(); }),
    ]).then(function (results) {
      SCENARIOS = results[0];
      CARRIERS = results[1];
      MARKETPLACES = results[2];
      populateSelects();
      applyDeepLinkParams();
    }).catch(function () {
      showError('Could not load the delivery-rights data. Please reload the page.');
    });
  }

  goBtn.addEventListener('click', go);
  loadData();
})();
