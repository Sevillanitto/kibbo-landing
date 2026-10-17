// Node built-in test runner, zero dependencies: node --test
// Loads every scenario x country (x carrier x payment method) combination
// and asserts every generated letter/section renders with no
// "undefined" or literal "null" text leaking through.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const dcg = require('./delivery-claim-generator.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const scenariosData = JSON.parse(readFileSync(path.join(ROOT, 'data/delivery-triage/scenarios.json'), 'utf8'));
const carriersData = JSON.parse(readFileSync(path.join(ROOT, 'data/delivery-triage/carriers.json'), 'utf8'));

dcg.setData(scenariosData, carriersData);

const COUNTRIES = scenariosData.countries;
const SCENARIO_IDS = scenariosData.scenarios.map(s => s.id);
const CARRIER_NAMES = carriersData.carriers.map(c => c.name).concat(['Other']);
const PAID_BY = ['card', 'paypal', 'other'];

// A "bad text" check: no literal "undefined" or standalone "null" should
// ever appear in generated text. (We deliberately allow the word "null"
// only if it were part of some real legal term, which none of our data
// contains, so a bare substring check is safe and strict here.)
function assertClean(text, context) {
  assert.ok(!/undefined/i.test(text), `${context}: contains "undefined"\n${text}`);
  assert.ok(!/\bnull\b/.test(text), `${context}: contains literal "null"\n${text}`);
}

function sampleInputs(scenarioId, country, carrierName, paidBy, filled) {
  return {
    country,
    scenarioId,
    carrierName,
    carrierDisplay: carrierName === 'Other' ? 'Local Courier Ltd' : carrierName,
    paidBy,
    seller: filled ? 'Acme Store' : '',
    purchaseDate: filled ? '2026-09-01' : null,
    deliveryDate: filled ? '2026-09-10' : null,
    order: filled ? 'ORD-12345' : '',
    tracking: filled ? 'TRK98765' : '',
    item: filled ? 'Wireless headphones' : '',
    amount: filled ? '£49.99' : '',
    facts: filled ? 'Contacted seller on 2026-09-15, no response.' : '',
  };
}

test('every scenario x country combination renders all 6 sections cleanly (fields filled)', () => {
  let count = 0;
  for (const scenarioId of SCENARIO_IDS) {
    for (const country of COUNTRIES) {
      const inputs = sampleInputs(scenarioId, country, 'Royal Mail', 'card', true);
      const sections = dcg.generateSections(inputs);
      assert.equal(sections.length, 6, `${scenarioId}/${country}: expected 6 sections`);
      sections.forEach((s) => {
        assert.ok(typeof s.text === 'string' && s.text.length > 0, `${scenarioId}/${country}/${s.title}: empty text`);
        assertClean(s.text, `${scenarioId}/${country}/${s.title}`);
      });
      count++;
    }
  }
  assert.equal(count, SCENARIO_IDS.length * COUNTRIES.length);
});

test('every scenario x country combination renders cleanly with ALL optional fields empty (fallback paths)', () => {
  for (const scenarioId of SCENARIO_IDS) {
    for (const country of COUNTRIES) {
      const inputs = sampleInputs(scenarioId, country, 'Royal Mail', 'card', false);
      const sections = dcg.generateSections(inputs);
      sections.forEach((s) => {
        assertClean(s.text, `[empty-fields] ${scenarioId}/${country}/${s.title}`);
      });
    }
  }
});

test('every carrier (plus "Other") renders a clean carrier letter, for every country', () => {
  for (const carrierName of CARRIER_NAMES) {
    for (const country of COUNTRIES) {
      const inputs = sampleInputs('never_arrived', country, carrierName, 'card', true);
      const letter = dcg.buildCarrierLetter(inputs);
      assertClean(letter.text, `carrier=${carrierName} country=${country}`);
    }
  }
});

test('every payment method renders a clean card-dispute section, for every country', () => {
  for (const paidBy of PAID_BY) {
    for (const country of COUNTRIES) {
      const inputs = sampleInputs('never_arrived', country, 'Royal Mail', paidBy, true);
      const letter = dcg.buildCardDisputeLetter(inputs);
      assertClean(letter.text, `paidBy=${paidBy} country=${country}`);
    }
  }
});

test('full cross product (scenario x country x carrier x paidBy) renders cleanly', () => {
  let count = 0;
  for (const scenarioId of SCENARIO_IDS) {
    for (const country of COUNTRIES) {
      for (const carrierName of CARRIER_NAMES) {
        for (const paidBy of PAID_BY) {
          const inputs = sampleInputs(scenarioId, country, carrierName, paidBy, true);
          const sections = dcg.generateSections(inputs);
          sections.forEach((s) => assertClean(s.text, `${scenarioId}/${country}/${carrierName}/${paidBy}/${s.title}`));
          count++;
        }
      }
    }
  }
  console.log(`  (checked ${count} full combinations)`);
  assert.equal(count, SCENARIO_IDS.length * COUNTRIES.length * CARRIER_NAMES.length * PAID_BY.length);
});

test('escalation letter only generates a real POSTRS letter for Royal Mail + UK, never for other carriers', () => {
  const uk = sampleInputs('never_arrived', 'UK', 'Royal Mail', 'card', true);
  const royalMailLetter = dcg.buildEscalationLetter(uk);
  assert.ok(royalMailLetter.text.includes('POSTRS'), 'Royal Mail + UK should mention POSTRS');

  for (const carrierName of CARRIER_NAMES) {
    if (carrierName === 'Royal Mail') continue;
    const inputs = sampleInputs('never_arrived', 'UK', carrierName, 'card', true);
    const letter = dcg.buildEscalationLetter(inputs);
    assert.ok(!letter.text.includes('Dear Sir/Madam'), `${carrierName}: should not generate a formal ADR letter (no scheme confirmed)`);
  }
});

test('extractDays finds the first day-count in a deadline string, or null if none', () => {
  assert.equal(dcg.extractDays('Within 80 calendar days of posting'), 80);
  assert.equal(dcg.extractDays('No statutory deadline to notify the seller.'), null);
  assert.equal(dcg.extractDays(null), null);
});

test('deadline tracker never throws when no dates were entered', () => {
  const inputs = sampleInputs('arrived_late', 'US', 'FedEx', 'card', false);
  const tracker = dcg.buildDeadlineTracker(inputs, scenariosData.scenarios.find(s => s.id === 'arrived_late').by_country.US);
  assertClean(tracker.text, 'deadline tracker, no dates');
  assert.ok(tracker.text.includes('No purchase or delivery date was entered'));
});

test('every SCENARIO_PHRASES entry is neutral wording (no "theft"/"forged"/"stolen" language)', () => {
  Object.entries(dcg.SCENARIO_PHRASES).forEach(([id, phrase]) => {
    assert.ok(!/theft|forg|stol/i.test(phrase), `${id}: phrase is not neutral: "${phrase}"`);
  });
});
