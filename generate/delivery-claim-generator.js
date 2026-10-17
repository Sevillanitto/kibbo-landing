/* Delivery Claim Generator — standalone, client-side only.
 *
 * Unlike every other generator on this site, this one does NOT use
 * generator-engine.js (no paywall, no Worker, no email capture, no
 * localStorage unlock flag). It fetches two static JSON files from this
 * same site (data/delivery-triage/scenarios.json and carriers.json) and
 * generates everything in the browser. Nothing the user types is sent
 * anywhere or stored anywhere (not even localStorage) — loading the two
 * reference JSON files is the only network activity, and it carries no
 * user data.
 *
 * Every legal fact in the generated letters comes directly from those
 * two JSON files — no invented facts, no assumed carrier/country rules.
 * Where a fact is null in the data, the letter says so neutrally
 * ("check the carrier's official page") instead of guessing.
 */
(function () {
  'use strict';

  // True only inside an actual browser context. Lets this same file be
  // require()'d directly from Node (see test/) to unit-test the pure
  // letter-builder functions below, without touching `document` or
  // `fetch`. Does not change browser behaviour at all — in a real
  // browser this is always true. Same pattern used by the Checkout
  // Security Shield extension's content.js.
  var IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';

  var SCENARIOS_URL = '/data/delivery-triage/scenarios.json';
  var CARRIERS_URL = '/data/delivery-triage/carriers.json';

  var countrySelect, scenarioSelect, carrierSelect, carrierOtherWrap, carrierOtherInput, genBtn, errorBox, result;
  if (IS_BROWSER) {
    countrySelect = document.getElementById('dcg-country');
    scenarioSelect = document.getElementById('dcg-scenario');
    carrierSelect = document.getElementById('dcg-carrier');
    carrierOtherWrap = document.getElementById('dcg-carrier-other-wrap');
    carrierOtherInput = document.getElementById('dcg-carrier-other');
    genBtn = document.getElementById('dcgBtn');
    errorBox = document.getElementById('dcgError');
    result = document.getElementById('dcgResult');
  }

  var SCENARIOS = null; // { countries: [...], scenarios: [...] }
  var CARRIERS = null;  // { carriers: [...], country_dispute_routes: {...} }

  // Lets a Node test inject the two JSON files directly, bypassing
  // fetch(). No effect on browser behaviour (the browser always uses
  // loadData() -> fetch() instead).
  function setData(scenariosData, carriersData) {
    SCENARIOS = scenariosData;
    CARRIERS = carriersData;
  }

  // Neutral, non-accusatory one-line description per scenario id. Used
  // inside every letter. Never implies theft or a forged signature.
  var SCENARIO_PHRASES = {
    marked_delivered_not_received: 'the parcel is marked as delivered, but I have not received it',
    never_arrived: 'the parcel has not arrived',
    damaged: 'the parcel arrived damaged',
    wrong_address_or_unsafe_place: 'the parcel was left at the wrong address, or in a place I had not agreed to',
    signature_not_yours: "the delivery record shows a signature that does not match my own records",
    missing_items: 'part of my order is missing from the delivery I received',
    arrived_late: 'the parcel arrived later than the date promised or required',
    customs_import_charges: 'I was charged customs duty or import VAT that I believe may be incorrect or duplicated',
    lost_return_shipment: 'the parcel I returned appears to have been lost in transit back to you',
    seller_says_claim_from_carrier: 'I was told to claim directly from the carrier instead of from you',
  };

  var COUNTRY_LABELS = { UK: 'United Kingdom', US: 'United States', EU: 'European Union', AU: 'Australia' };

  // ------------------------------------------------------------------
  // Data loading
  // ------------------------------------------------------------------
  function loadData() {
    return Promise.all([
      fetch(SCENARIOS_URL).then(function (r) { return r.json(); }),
      fetch(CARRIERS_URL).then(function (r) { return r.json(); }),
    ]).then(function (results) {
      SCENARIOS = results[0];
      CARRIERS = results[1];
      populateSelects();
      applyDeepLinkParams();
    }).catch(function () {
      showError('Could not load the delivery-rights data. Please reload the page.');
    });
  }

  // ------------------------------------------------------------------
  // Deep-link query params: ?country=&scenario=&payment=&carrier=
  // Preselects whatever is valid and auto-generates when scenario and
  // country are both present and valid. Any missing/invalid param is
  // ignored safely — this never throws and never changes behaviour for
  // a plain visit with no query string.
  // ------------------------------------------------------------------
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

    var validCountry = !!(country && SCENARIOS.countries.indexOf(country) !== -1);
    var validScenario = !!(scenarioId && getScenario(scenarioId));
    var validPayment = !!(payment && ['card', 'paypal', 'other'].indexOf(payment) !== -1);

    if (validCountry) countrySelect.value = country;
    if (validScenario) scenarioSelect.value = scenarioId;
    if (validPayment) document.getElementById('dcg-paid').value = payment;

    if (carrier) {
      if (getCarrier(carrier)) {
        carrierSelect.value = carrier;
        carrierOtherWrap.style.display = 'none';
      } else if (carrier.trim()) {
        carrierSelect.value = 'Other';
        carrierOtherWrap.style.display = 'block';
        carrierOtherInput.value = carrier.trim();
      }
    }

    if (validCountry && validScenario) {
      runGenerate({ allowMissingCarrier: true });
    }
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
      opt.textContent = s.label;
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
  }

  if (IS_BROWSER) {
    carrierSelect.addEventListener('change', function () {
      carrierOtherWrap.style.display = carrierSelect.value === 'Other' ? 'block' : 'none';
    });
  }

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------
  function getScenario(id) {
    return SCENARIOS.scenarios.find(function (s) { return s.id === id; });
  }
  function getCell(scenarioId, country) {
    var s = getScenario(scenarioId);
    return s ? s.by_country[country] : null;
  }
  function getCarrier(name) {
    return CARRIERS.carriers.find(function (c) { return c.name === name; });
  }
  function getCountryRoutes(country) {
    return CARRIERS.country_dispute_routes[country] || null;
  }

  function fmtDate(d) {
    if (!d) return null;
    try {
      var dt = new Date(d + 'T00:00:00');
      if (isNaN(dt.getTime())) return null;
      return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch (e) { return null; }
  }
  function addDays(d, n) {
    if (!d) return null;
    var dt = new Date(d + 'T00:00:00');
    if (isNaN(dt.getTime())) return null;
    dt.setDate(dt.getDate() + n);
    return dt;
  }
  function todayLong() {
    return new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  // Extracts the first "N day(s)" figure from a free-text deadline
  // string, e.g. "Within 80 calendar days of posting" -> 80. Returns
  // null if no number is found — we never invent one.
  function extractDays(text) {
    if (!text) return null;
    var m = /(\d+)\s*(?:calendar\s+)?day/i.exec(text);
    return m ? parseInt(m[1], 10) : null;
  }

  function joinOrNone(arr, fallback) {
    if (!arr || !arr.length) return fallback;
    return arr.join(' ');
  }

  // Renders a value that may be null as either the value itself, or a
  // neutral "check the official page" fallback — never an invented value.
  function orFallback(value, fallbackNote) {
    if (value === null || value === undefined || value === '') {
      return fallbackNote || 'Not stated in our data — check the carrier\'s or regulator\'s official page directly.';
    }
    return value;
  }

  function flattenObjectValues(obj) {
    if (!obj) return [];
    return Object.keys(obj).map(function (k) {
      return humanizeKey(k) + ': ' + obj[k];
    });
  }
  function humanizeKey(key) {
    return key.split('_').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  }

  function escapeForMailto(s) {
    return encodeURIComponent(s || '');
  }

  // ------------------------------------------------------------------
  // Letter builders — each returns { title, text, mailSubject, mailTo }
  // ------------------------------------------------------------------
  function buildSellerLetter(inputs, cell) {
    var phrase = SCENARIO_PHRASES[inputs.scenarioId] || 'there is a problem with my delivery';
    var lines = [];
    lines.push(todayLong());
    lines.push('');
    lines.push('To: ' + orFallback(inputs.seller, 'The Seller'));
    lines.push('Re: Order ' + orFallback(inputs.order, '[order number]') + ' — ' + orFallback(inputs.item, '[item]'));
    lines.push('');
    lines.push('Dear ' + orFallback(inputs.seller, 'Sir/Madam') + ',');
    lines.push('');
    lines.push('I am writing about my order ' + orFallback(inputs.order, '[order number]') +
      (inputs.purchaseDate ? ', placed on ' + fmtDate(inputs.purchaseDate) : '') +
      ', for ' + orFallback(inputs.item, '[item]') +
      (inputs.amount ? ' (amount paid: ' + inputs.amount + ')' : '') +
      (inputs.deliveryDate ? ', due or delivered on ' + fmtDate(inputs.deliveryDate) : '') +
      (inputs.carrierDisplay ? ', sent via ' + inputs.carrierDisplay : '') + '.');
    lines.push('');
    lines.push('To describe the problem in your own system: ' + phrase + '.');
    lines.push('');
    if (cell && cell.legal_basis) {
      lines.push(cell.legal_basis);
    } else {
      lines.push('We do not have a single verified rule covering exactly this situation for this country in our data, so I am asking you, as the seller, to address this directly.');
    }
    if (cell && cell.liable_party === null) {
      lines.push('');
      lines.push('(Note: liability for a problem like this can depend on the specific shipping terms you agreed to when you shipped my order — we are not asserting which party is responsible, only asking you to look into it and respond.)');
    }
    lines.push('');
    if (cell && cell.deadlines && cell.deadlines.length) {
      lines.push('Relevant deadline(s) we are aware of: ' + cell.deadlines.join(' '));
      lines.push('');
    }
    if (inputs.facts) {
      lines.push('Additional facts: ' + inputs.facts);
      lines.push('');
    }
    lines.push('I ask that you resolve this — by refund, replacement, or re-delivery as appropriate — within 14 days of this letter.');
    lines.push('');
    lines.push('If I do not hear from you within that time, I will pursue a card dispute with my payment provider and, where one applies, an escalation to the relevant ombudsman or regulator.');
    lines.push('');
    lines.push('Please treat this as a formal notice.');
    lines.push('');
    lines.push('Yours sincerely,');
    lines.push('[Your name]');
    lines.push('');
    lines.push('---');
    if (cell && cell.sources && cell.sources.length) {
      lines.push('Sources: ' + cell.sources.join(', '));
    }
    if (cell && cell.verified_on) {
      lines.push('Facts verified: ' + cell.verified_on);
    }
    lines.push('This is general information, not legal advice.');

    return {
      title: 'Letter to the seller',
      text: lines.join('\n'),
      mailSubject: 'Order ' + orFallback(inputs.order, '') + ' — ' + (getScenario(inputs.scenarioId) || {}).label,
      mailTo: null,
    };
  }

  function buildCarrierLetter(inputs) {
    var phrase = SCENARIO_PHRASES[inputs.scenarioId] || 'there is a problem with my delivery';
    var carrier = inputs.carrierName === 'Other' ? null : getCarrier(inputs.carrierName);
    var lines = [];
    lines.push(todayLong());
    lines.push('');
    lines.push('To: ' + inputs.carrierDisplay);
    lines.push('Re: Tracking ' + orFallback(inputs.tracking, '[tracking number]'));
    lines.push('');
    lines.push('Dear ' + inputs.carrierDisplay + ',');
    lines.push('');
    lines.push('I am contacting you about a parcel with tracking number ' + orFallback(inputs.tracking, '[tracking number]') +
      ', addressed to me' + (inputs.seller ? (', sent by ' + inputs.seller) : '') + '.');
    lines.push('');
    lines.push('The issue: ' + phrase + '.');
    lines.push('');

    if (!carrier) {
      lines.push('We do not have verified claim-process details for this carrier in our data. Please check ' + inputs.carrierDisplay + "'s own official website for their claims process, claim window and compensation limit, and use their published claims form, email or postal address.");
    } else {
      if (carrier.note_on_direct_claims) {
        lines.push('(Note: ' + carrier.note_on_direct_claims + ')');
        lines.push('');
      }
      lines.push('Claim process: ' + orFallback(carrier.claim_process));
      var windows = flattenObjectValues(carrier.claim_windows);
      if (windows.length) {
        lines.push('Claim window(s): ' + windows.join(' | '));
      }
      var limits = flattenObjectValues(carrier.compensation_limits).filter(function (l) { return !/:\s*null$/i.test(l); });
      if (limits.length) {
        lines.push('Compensation limit(s): ' + limits.join(' | '));
      }
      lines.push('');
      lines.push('I ask you to open a claim for this parcel and confirm the outcome to me in writing.');
      lines.push('');
      var cr = carrier.contact_routes || {};
      if (cr.claim_form_url) lines.push('Claim form: ' + cr.claim_form_url);
      if (cr.postal_address) lines.push('Postal address: ' + cr.postal_address);
      if (cr.claims_email) lines.push('Email: ' + cr.claims_email);
      if (!cr.claim_form_url && !cr.postal_address && !cr.claims_email) {
        lines.push('(We do not have a verified email or postal address for ' + carrier.name + ' in our data — check their official page for the best way to submit this.)');
      }
    }

    lines.push('');
    lines.push('Yours sincerely,');
    lines.push('[Your name]');
    lines.push('');
    lines.push('---');
    if (carrier && carrier.sources && carrier.sources.length) {
      lines.push('Sources: ' + carrier.sources.join(', '));
    }
    if (carrier && carrier.verified_on) {
      lines.push('Facts verified: ' + carrier.verified_on);
    }
    lines.push('This is general information, not legal advice.');

    return {
      title: 'Letter to the carrier',
      text: lines.join('\n'),
      mailSubject: 'Claim for tracking ' + orFallback(inputs.tracking, ''),
      mailTo: (carrier && carrier.contact_routes && carrier.contact_routes.claims_email) || null,
    };
  }

  function buildCardDisputeLetter(inputs) {
    var phrase = SCENARIO_PHRASES[inputs.scenarioId] || 'there is a problem with my delivery';
    var lines = [];
    lines.push(todayLong());
    lines.push('');

    if (inputs.paidBy === 'paypal') {
      lines.push('You told us you paid via PayPal. PayPal runs its own Buyer Protection dispute process, separate from a bank card dispute — we do not have verified details of that specific process in our data, so we have not generated a letter for it. Open a dispute directly in PayPal\'s own Resolution Centre, describing the issue as: ' + phrase + '.');
      return { title: 'Card / payment dispute', text: lines.join('\n'), mailSubject: '', mailTo: null };
    }
    if (inputs.paidBy === 'other') {
      lines.push('You told us you did not pay by card or PayPal. A card chargeback, Section 75, or FCBA-style claim only applies to card payments, so none of those routes apply here. Contact whatever payment method or provider you used directly and ask what protection, if any, applies to this transaction.');
      return { title: 'Card / payment dispute', text: lines.join('\n'), mailSubject: '', mailTo: null };
    }

    var routes = getCountryRoutes(inputs.country);
    var cdr = routes ? routes.card_dispute_route : null;

    lines.push('To: My Card Issuer');
    lines.push('Re: Disputed transaction — ' + orFallback(inputs.seller, '[seller]') + (inputs.amount ? ' — ' + inputs.amount : ''));
    lines.push('');
    lines.push('Dear Sir/Madam,');
    lines.push('');
    lines.push('I am writing to dispute a card transaction with ' + orFallback(inputs.seller, '[seller]') +
      ' for ' + orFallback(inputs.item, '[item]') +
      (inputs.amount ? ' (amount: ' + inputs.amount + ')' : '') +
      (inputs.purchaseDate ? ', purchased on ' + fmtDate(inputs.purchaseDate) : '') + '.');
    lines.push('');
    lines.push('The issue: ' + phrase + '.');
    lines.push('');
    if (cdr) {
      lines.push(cdr.basis);
      if (cdr.confidence_note) {
        lines.push('(' + cdr.confidence_note + ')');
      }
    } else {
      lines.push('We do not have a verified card-dispute rule for this country in our data — please ask your card issuer what dispute process applies.');
    }
    lines.push('');
    lines.push('I ask you to open a dispute/chargeback for this transaction and confirm the outcome to me in writing.');
    lines.push('');
    lines.push('Yours sincerely,');
    lines.push('[Your name]');
    lines.push('');
    lines.push('---');
    if (cdr && cdr.sources && cdr.sources.length) lines.push('Sources: ' + cdr.sources.join(', '));
    if (cdr && cdr.verified_on) lines.push('Facts verified: ' + cdr.verified_on);
    lines.push('This is general information, not legal advice.');

    return {
      title: 'Card / payment dispute letter',
      text: lines.join('\n'),
      mailSubject: 'Disputed transaction — ' + orFallback(inputs.seller, ''),
      mailTo: null,
    };
  }

  function buildEscalationLetter(inputs) {
    var carrier = inputs.carrierName === 'Other' ? null : getCarrier(inputs.carrierName);
    var isRoyalMailUK = carrier && carrier.name === 'Royal Mail' && inputs.country === 'UK';
    var routes = getCountryRoutes(inputs.country);
    var lines = [];
    lines.push(todayLong());
    lines.push('');

    if (isRoyalMailUK) {
      lines.push('To: POSTRS (Postal Redress Service)');
      lines.push('Re: Unresolved complaint about Royal Mail — tracking ' + orFallback(inputs.tracking, '[tracking number]'));
      lines.push('');
      lines.push('Dear Sir/Madam,');
      lines.push('');
      lines.push('I am escalating an unresolved complaint about Royal Mail (tracking ' + orFallback(inputs.tracking, '[tracking number]') + ') after receiving Royal Mail\'s final response, or after a reasonable period without resolution.');
      lines.push('');
      lines.push(carrier.escalation_route);
      lines.push('');
      lines.push('Yours sincerely,');
      lines.push('[Your name]');
      lines.push('');
      lines.push('---');
      if (carrier.sources) lines.push('Sources: ' + carrier.sources.join(', '));
      if (carrier.verified_on) lines.push('Facts verified: ' + carrier.verified_on);
      lines.push('This is general information, not legal advice.');
      return { title: 'Escalation letter (POSTRS)', text: lines.join('\n'), mailSubject: 'POSTRS complaint — Royal Mail', mailTo: null };
    }

    // No carrier-specific ADR scheme confirmed — informational note only,
    // never a fabricated ombudsman letter. "Never assume membership."
    lines.push('No carrier letter is generated here.');
    lines.push('');
    if (carrier && carrier.escalation_route) {
      lines.push('For ' + carrier.name + ', our data says: ' + carrier.escalation_route);
    } else if (carrier) {
      lines.push('We do not have a verified ombudsman/ADR scheme for ' + carrier.name + ' in our data.');
    } else {
      lines.push('We do not have verified ombudsman/ADR information for a carrier not in our list.');
    }
    lines.push('');
    if (routes && routes.ombudsman_regulator) {
      var om = routes.ombudsman_regulator;
      lines.push('Separately: if your dispute becomes specifically about how your own bank or card issuer handled a card dispute/chargeback (not about the seller or the carrier directly), you can contact ' + om.name + '.');
      if (om.scope_note) lines.push(om.scope_note);
      if (om.complaint_url) lines.push('Complaint page: ' + om.complaint_url);
      if (om.postal_address) lines.push('Postal address: ' + om.postal_address);
      if (om.phone) lines.push('Phone: ' + om.phone);
    } else {
      lines.push('We do not have verified ombudsman/regulator information for ' + (COUNTRY_LABELS[inputs.country] || inputs.country) + ' in our data.');
    }
    lines.push('');
    lines.push('This is general information, not legal advice.');

    return { title: 'Escalation — what applies (informational)', text: lines.join('\n'), mailSubject: '', mailTo: null };
  }

  // ------------------------------------------------------------------
  // Deadline tracker
  // ------------------------------------------------------------------
  function buildDeadlineTracker(inputs, cell) {
    var anchor = inputs.deliveryDate || inputs.purchaseDate || null;
    var items = []; // { label, raw, date }

    function addFromList(list, labelPrefix) {
      (list || []).forEach(function (text) {
        var days = extractDays(text);
        var date = days !== null && anchor ? addDays(anchor, days) : null;
        items.push({ label: labelPrefix, raw: text, date: date });
      });
    }

    if (cell && cell.deadlines) addFromList(cell.deadlines, 'Seller / scenario deadline');

    var carrier = inputs.carrierName === 'Other' ? null : getCarrier(inputs.carrierName);
    if (carrier && carrier.claim_windows) {
      Object.keys(carrier.claim_windows).forEach(function (k) {
        var text = carrier.claim_windows[k];
        var days = extractDays(text);
        var date = days !== null && anchor ? addDays(anchor, days) : null;
        items.push({ label: carrier.name + ' claim window (' + humanizeKey(k) + ')', raw: text, date: date });
      });
    }

    var routes = getCountryRoutes(inputs.country);
    if (inputs.paidBy === 'card' && routes && routes.card_dispute_route) {
      var cdText = routes.card_dispute_route.basis;
      var days = extractDays(cdText);
      var date = days !== null && anchor ? addDays(anchor, days) : null;
      items.push({ label: 'Card dispute deadline', raw: cdText, date: date });
    }

    items.sort(function (a, b) {
      if (a.date && b.date) return a.date - b.date;
      if (a.date) return -1;
      if (b.date) return 1;
      return 0;
    });

    var lines = [];
    lines.push('Deadline tracker');
    lines.push('(Dates marked "calculated" are approximate, based on the delivery date — or purchase date if no delivery date was given — that you entered. Always re-check the exact wording of each deadline.)');
    lines.push('');
    if (!anchor) {
      lines.push('No purchase or delivery date was entered, so no exact dates could be calculated below — only the raw deadline text from our data is shown.');
      lines.push('');
    }
    items.forEach(function (it) {
      var dateStr = it.date ? ' — calculated date: ' + it.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
      lines.push('• ' + it.label + ': ' + it.raw + dateStr);
    });
    if (!items.length) {
      lines.push('No specific deadlines were found in our data for this combination — proceed as soon as reasonably possible and keep your own record of dates.');
    }

    return { title: 'Deadline tracker', text: lines.join('\n'), mailSubject: '', mailTo: null };
  }

  // ------------------------------------------------------------------
  // Evidence checklist
  // ------------------------------------------------------------------
  var CHECKLIST_EXTRA = {
    damaged: ['Photos of the damaged item from multiple angles', 'Photos of the outer packaging as received'],
    missing_items: ['Photo of everything you actually received, laid out together', 'The packing list or invoice, if one was included'],
    wrong_address_or_unsafe_place: ['A photo of where the parcel was left, if you can get one', 'Any note the carrier left'],
    signature_not_yours: ['Your own whereabouts/records for the delivery date and time, if relevant'],
    customs_import_charges: ['The customs charge label and/or invoice from the carrier', 'Proof of the declared value of the goods'],
    lost_return_shipment: ['Your proof of posting the return (receipt or tracking number)', 'The retailer\'s return confirmation/label, if they provided one'],
    arrived_late: ['A screenshot of the delivery date promised at checkout'],
  };

  function buildEvidenceChecklist(inputs) {
    var lines = [];
    lines.push('Evidence checklist');
    lines.push('');
    var base = [
      'Order confirmation / receipt',
      'Tracking history (a screenshot, including dates/status)',
      'Any correspondence with the seller or carrier so far',
      'Proof of the amount paid',
    ];
    base.concat(CHECKLIST_EXTRA[inputs.scenarioId] || []).forEach(function (item) {
      lines.push('☐ ' + item);
    });
    return { title: 'Evidence checklist', text: lines.join('\n'), mailSubject: '', mailTo: null };
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function renderSection(section) {
    var wrap = el('div');
    wrap.style.marginBottom = '40px';
    wrap.appendChild(el('h2', 'supp-ingredients-heading', section.title));
    var box = el('div', 'gen-letter');
    var visible = el('div', 'gen-visible', section.text);
    box.appendChild(visible);
    wrap.appendChild(box);

    var actions = el('div', 'gen-print-actions');

    if (section.mailSubject !== undefined && section.mailSubject !== '') {
      var mailBtn = el('button', 'gen-copy', 'Open in my email app');
      mailBtn.type = 'button';
      mailBtn.addEventListener('click', function () {
        var to = section.mailTo ? escapeForMailto(section.mailTo) : '';
        var href = 'mailto:' + to + '?subject=' + escapeForMailto(section.mailSubject) + '&body=' + escapeForMailto(section.text);
        window.location.href = href;
      });
      actions.appendChild(mailBtn);
    }

    var copyBtn = el('button', 'gen-copy', 'Copy text');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', function () {
      navigator.clipboard.writeText(section.text).then(function () {
        copyBtn.textContent = 'Copied ✓';
        setTimeout(function () { copyBtn.textContent = 'Copy text'; }, 2000);
      });
    });
    actions.appendChild(copyBtn);

    var printBtn = el('button', 'gen-copy', 'Print / save as PDF');
    printBtn.type = 'button';
    printBtn.addEventListener('click', function () {
      // Scope printing to just this section: hide every other .gen-visible
      // node for the duration of the print, then restore.
      var all = document.querySelectorAll('.gen-visible');
      var restore = [];
      all.forEach(function (node) {
        if (node !== visible) {
          restore.push([node, node.style.display]);
          node.style.display = 'none';
        }
      });
      window.print();
      restore.forEach(function (pair) { pair[0].style.display = pair[1]; });
    });
    actions.appendChild(printBtn);

    wrap.appendChild(actions);
    return wrap;
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.style.display = 'block';
  }
  function clearError() {
    errorBox.style.display = 'none';
    errorBox.textContent = '';
  }

  // Pure function: given the form inputs, returns the array of 6 output
  // sections ({title, text, mailSubject, mailTo}). Exported for tests —
  // this is exactly what the "Generate" button uses.
  function generateSections(inputs) {
    var cell = getCell(inputs.scenarioId, inputs.country);
    return [
      buildSellerLetter(inputs, cell),
      buildCarrierLetter(inputs),
      buildCardDisputeLetter(inputs),
      buildEscalationLetter(inputs),
      buildDeadlineTracker(inputs, cell),
      buildEvidenceChecklist(inputs),
    ];
  }

  // ------------------------------------------------------------------
  // Main generate action
  // ------------------------------------------------------------------
  // Reads the current form state and renders all 6 sections. Used by both
  // the "Generate my letters" button (opts omitted — identical to the
  // original behaviour) and the deep-link auto-generate path (opts.
  // allowMissingCarrier lets a shared link render results even when the
  // carrier wasn't part of the link).
  function runGenerate(opts) {
    opts = opts || {};
    clearError();
    var country = countrySelect.value;
    var scenarioId = scenarioSelect.value;
    var carrierName = carrierSelect.value;
    if (!country || !scenarioId || (!opts.allowMissingCarrier && !carrierName)) {
      showError('Please select your country, what happened, and the carrier.');
      return;
    }
    var carrierDisplay = carrierName === 'Other' ? (carrierOtherInput.value.trim() || 'the carrier') : (carrierName || 'the carrier');

    var inputs = {
      country: country,
      scenarioId: scenarioId,
      carrierName: carrierName,
      carrierDisplay: carrierDisplay,
      paidBy: document.getElementById('dcg-paid').value,
      seller: document.getElementById('dcg-seller').value.trim(),
      purchaseDate: document.getElementById('dcg-purchase-date').value || null,
      deliveryDate: document.getElementById('dcg-delivery-date').value || null,
      order: document.getElementById('dcg-order').value.trim(),
      tracking: document.getElementById('dcg-tracking').value.trim(),
      item: document.getElementById('dcg-item').value.trim(),
      amount: document.getElementById('dcg-amount').value.trim(),
      facts: document.getElementById('dcg-facts').value.trim(),
    };

    var sections = generateSections(inputs);

    result.innerHTML = '';
    result.style.display = 'block';
    sections.forEach(function (s) { result.appendChild(renderSection(s)); });
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  if (IS_BROWSER) {
    genBtn.addEventListener('click', function () { runGenerate(); });
    loadData();
  }

  // ------------------------------------------------------------------
  // TEST EXPORTS (Node only — no effect on browser behaviour)
  // ------------------------------------------------------------------
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      setData: setData,
      generateSections: generateSections,
      buildSellerLetter: buildSellerLetter,
      buildCarrierLetter: buildCarrierLetter,
      buildCardDisputeLetter: buildCardDisputeLetter,
      buildEscalationLetter: buildEscalationLetter,
      buildDeadlineTracker: buildDeadlineTracker,
      buildEvidenceChecklist: buildEvidenceChecklist,
      extractDays: extractDays,
      SCENARIO_PHRASES: SCENARIO_PHRASES,
    };
  }
})();
