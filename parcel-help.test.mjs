// Node built-in test runner: node --test
// Loads every country x scenario x payment combination and asserts the
// result renders with no "undefined"/"null", a valid generator link, and
// at least one source link. Also checks every RESOURCE_MAP URL resolves
// to a real file on disk (clean-URL convention: path.html or path/index.html).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ph = require('./parcel-help.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const scenariosData = JSON.parse(readFileSync(path.join(__dirname, 'data/delivery-triage/scenarios.json'), 'utf8'));
const carriersData = JSON.parse(readFileSync(path.join(__dirname, 'data/delivery-triage/carriers.json'), 'utf8'));

ph.setData(scenariosData, carriersData);

const COUNTRIES = scenariosData.countries;
const SCENARIO_IDS = scenariosData.scenarios.map((s) => s.id);
const PAID_BY = ['card', 'paypal', 'other'];
const CARRIER_NAMES = carriersData.carriers.map((c) => c.name).concat(['', 'Other']);

function assertClean(text, context) {
  assert.ok(!/undefined/i.test(text), `${context}: contains "undefined"\n${text}`);
  assert.ok(!/\bnull\b/.test(text), `${context}: contains literal "null"\n${text}`);
}

// Mirrors exactly what renderResult() in parcel-help.js puts on screen —
// `ukPostrsNote: null` and `deadlines: null` are legitimate structured
// data (most countries have no POSTRS note; some cells have no confirmed
// deadline), guarded by the same `if (...)` branches here as in the
// browser renderer, so this never contains a literal "null"/"undefined"
// unless the real rendered page would.
function flattenResultText(result) {
  const lines = [];
  lines.push('Situation: ' + result.scenarioLabel + ' (' + result.countryLabel + ')');
  lines.push('Who is responsible: ' + result.liableParty);
  lines.push('Legal basis: ' + result.legalBasis);
  lines.push(result.deadlines
    ? 'Deadlines we have on record: ' + result.deadlines.join(' ')
    : 'We do not have a specific confirmed deadline for this combination — act as soon as reasonably possible.');
  lines.push('Recommended order: ' + result.steps.join(' -> '));
  if (result.ukPostrsNote) lines.push(result.ukPostrsNote);
  lines.push(result.generatorUrl);
  (result.secondaryLinks || []).forEach((l) => lines.push(l.label + ': ' + l.url));
  (result.sources || []).forEach((s) => lines.push(s.label + ': ' + s.url + (s.verifiedOn ? ' (' + s.verifiedOn + ')' : '')));
  return lines.join('\n');
}

test('every country x scenario x payment combination renders cleanly with a valid generator link and >=1 source', () => {
  let count = 0;
  for (const country of COUNTRIES) {
    for (const scenarioId of SCENARIO_IDS) {
      for (const paidBy of PAID_BY) {
        const inputs = { country, scenarioId, paidBy, carrierName: 'Royal Mail' };
        const result = ph.buildResult(inputs);
        assertClean(flattenResultText(result), `${country}/${scenarioId}/${paidBy}`);

        assert.ok(result.generatorUrl.includes('country=' + country), `${country}/${scenarioId}: generator link missing country`);
        assert.ok(result.generatorUrl.includes('scenario=' + scenarioId), `${country}/${scenarioId}: generator link missing scenario`);
        assert.ok(result.generatorUrl.startsWith('/generate/delivery-claim-generator?'), `${country}/${scenarioId}: generator link malformed`);

        assert.ok(result.sources.length >= 1, `${country}/${scenarioId}/${paidBy}: expected at least one source link`);
        count++;
      }
    }
  }
  assert.equal(count, COUNTRIES.length * SCENARIO_IDS.length * PAID_BY.length);
  console.log(`  (checked ${count} combinations)`);
});

test('every carrier (including none and "Other") renders cleanly for every country', () => {
  for (const country of COUNTRIES) {
    for (const carrierName of CARRIER_NAMES) {
      const inputs = { country, scenarioId: 'never_arrived', paidBy: 'card', carrierName };
      const result = ph.buildResult(inputs);
      assertClean(flattenResultText(result), `carrier=${carrierName || '(none)'} country=${country}`);
    }
  }
});

test('UK POSTRS note only claims coverage for Royal Mail, never for other carriers', () => {
  const rm = ph.buildResult({ country: 'UK', scenarioId: 'never_arrived', paidBy: 'card', carrierName: 'Royal Mail' });
  assert.ok(rm.ukPostrsNote.includes('POSTRS'));
  assert.ok(!/covers all carriers|covers every carrier/i.test(rm.ukPostrsNote));

  const evri = ph.buildResult({ country: 'UK', scenarioId: 'never_arrived', paidBy: 'card', carrierName: 'Evri' });
  assert.ok(evri.ukPostrsNote.includes('only covers Royal Mail'));

  const nonUk = ph.buildResult({ country: 'US', scenarioId: 'never_arrived', paidBy: 'card', carrierName: 'USPS' });
  assert.equal(nonUk.ukPostrsNote, null);
});

test('liable_party / legal_basis nulls render a neutral fallback, never an invented value', () => {
  // lost_return_shipment x US is fully null in scenarios.json (verified via unverified[] entries).
  const result = ph.buildResult({ country: 'US', scenarioId: 'lost_return_shipment', paidBy: 'card', carrierName: 'Royal Mail' });
  assert.ok(/depends on the seller|do not have a verified legal basis/i.test(result.liableParty + ' ' + result.legalBasis));
  assertClean(flattenResultText(result), 'lost_return_shipment/US fully-null cell');
});

test('every RESOURCE_MAP URL resolves to a real file on disk (clean-URL convention)', () => {
  function urlToFilePath(url) {
    const clean = url.replace(/^\//, '');
    const direct = path.join(__dirname, clean + '.html');
    const indexed = path.join(__dirname, clean, 'index.html');
    if (existsSync(direct)) return direct;
    if (existsSync(indexed)) return indexed;
    return null;
  }

  const checked = [];
  Object.entries(ph.RESOURCE_MAP).forEach(([scenarioId, entry]) => {
    ['checklist', 'template', 'calculator', 'kit'].forEach((key) => {
      if (entry[key]) checked.push([scenarioId + '.' + key, entry[key]]);
    });
    Object.entries(entry.byCountry || {}).forEach(([country, byC]) => {
      Object.entries(byC).forEach(([key, url]) => {
        checked.push([scenarioId + '.byCountry.' + country + '.' + key, url]);
      });
    });
  });

  assert.ok(checked.length > 10, 'expected a non-trivial number of mapped resources');
  checked.forEach(([label, url]) => {
    const file = urlToFilePath(url);
    assert.ok(file, `${label}: ${url} does not resolve to a file on disk`);
  });
});

test('every PLAIN_LABELS entry covers a real scenario id, with no leftover theft/forged wording', () => {
  SCENARIO_IDS.forEach((id) => {
    assert.ok(ph.PLAIN_LABELS[id], `missing plain label for ${id}`);
    assert.ok(!/theft|forg|stol/i.test(ph.PLAIN_LABELS[id]), `${id}: plain label is not neutral`);
  });
});
