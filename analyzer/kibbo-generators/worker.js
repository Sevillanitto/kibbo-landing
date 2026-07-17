// Kibbo Generators — shared, config-driven letter-generator engine (Cloudflare Worker)
//
// One Worker powers every letter generator. Adding a generator = adding an entry
// to GENERATORS below (+ a config-only frontend page); no new Worker code.
//
// Pricing model (pay-per-generation, instant unlock — NOT the analyzers' model):
//   - Free tier: PREVIEW ONLY. The Worker generates the full letter server-side
//     but only releases the first paragraph to the browser; the rest stays in KV.
//   - $4.60 unlocks ONE full letter, delivered instantly via a Gumroad license key.
//
// Endpoints:
//   POST /preview  { generatorId, answers }
//       -> rate-limited 3/day per IP, SHARED across all generators.
//          Generates the full letter, stores it server-side, returns only the
//          first paragraph + a blur hint. { previewId, preview, blurLines, remaining }
//   POST /unlock   { generatorId, previewId, answers, licenseKey }
//       -> verifies the Gumroad license by product_id (server-side, never trusts a
//          client-supplied product id), then releases the full letter. { letter }
//
// Required bindings / secrets:
//   - ANTHROPIC_API_KEY (secret): wrangler secret put ANTHROPIC_API_KEY
//   - GENERATORS_KV (KV namespace binding): namespace "generators-rate-limit"

const DAILY_PREVIEW_LIMIT = 3; // shared across ALL generators, per IP per day
const MAX_TOKENS = 1200; // one-page letter — Haiku, template filling not reasoning
const KV_TTL = 86400; // 24h for previews and redeemed keys

// ---- Config-driven generator definitions ----
// Only the server-side concerns live here (prompt + product id). The frontend
// carries the question set + Gumroad permalink in its own page config. The
// gumroad_product_id is looked up here by generatorId so a client can never
// substitute a different product's id during license verification.
const GENERATORS = {
  'lost-parcel': {
    title: 'Lost Parcel Legal Demand',
    gumroad_product_id: 'lcbzyb',
    prompt_template:
      'Write a formal demand letter addressed to the RETAILER (not the courier/shipping company) demanding a full refund within 48 hours for a lost or damaged parcel. If country is UK, cite the Consumer Rights Act 2015 (the retailer remains liable for goods until they reach the consumer, regardless of courier used). If country is US, cite general state consumer protection law language without inventing a specific statute number. Retailer: {retailer}. Order date: {order_date}. Amount paid: {amount}. Issue: {issue}. Tone: professional, firm, cites the relevant legal basis, gives a specific 48-hour deadline.',
  },
  'landlord-deposit': {
    title: 'Landlord Deposit Demand Letter',
    gumroad_product_id: 'fcgrqc',
    prompt_template:
      'Write a formal demand letter to a landlord or letting agency demanding the return of a tenancy deposit. If country is UK, cite the Housing Act 2004 and the tenancy deposit protection (TDP) scheme requirements, and note that failure to protect a deposit correctly can entitle the tenant to compensation of 1-3x the deposit amount in addition to its return. If country is US, reference general state security deposit return law without inventing a specific statute. Landlord: {landlord_name}. Deposit: {deposit_amount}. Move-out date: {move_out_date}. Protection status: {protected}. Tone: professional, firm, cites the relevant legal basis, requests a clear response deadline.',
  },
  'fcra-credit-dispute': {
    title: 'Credit Report Dispute Letter (FCRA)',
    gumroad_product_id: 'vytma',
    prompt_template:
      'Write a formal FCRA Section 611 credit report dispute letter addressed to the named credit bureau. State clearly that the consumer is disputing the specific account/item as inaccurate, incomplete, or unverifiable under the Fair Credit Reporting Act, describe the specific error using the details provided, and formally request that the bureau conduct a reasonable reinvestigation and delete or correct the item if it cannot be verified within the 30-day statutory window (45 days if applicable). Bureau: {bureau}. Account/creditor: {account_name}. Issue: {issue_type}. Details: {details}. Tone: professional, factual, cites the correct legal basis, no emotional language.',
  },
  'fdcpa-cease-desist': {
    title: 'Debt Collector Cease & Desist Letter (FDCPA)',
    gumroad_product_id: 'ualrk',
    prompt_template:
      'Write a formal cease-and-desist letter to a debt collection agency, explicitly invoking Section 805(c) of the Fair Debt Collection Practices Act (FDCPA), demanding they stop all further communication except as permitted by law (confirming cessation or notifying of specific legal action). Reference the specific issue described. Note this letter should be sent via certified mail with return receipt requested — mention this in the letter\'s closing instructions to the sender, not as part of the letter\'s own body text to the collector. Collector: {collector_name}. Account reference: {account_reference}. Issue: {issue}. If is_third_party is \'No / Not sure\', add a brief note in the generated output (outside the letter itself) reminding the user that the FDCPA generally applies only to third-party collectors, not original creditors collecting their own debt, and to verify which applies to their situation. Tone: firm, professional, cites the correct legal section.',
  },
  'state-ag-complaint': {
    title: 'State Attorney General Complaint Letter',
    gumroad_product_id: 'wrbdyq',
    prompt_template:
      'Write a formal complaint letter to the addressee\'s State Attorney General\'s Consumer Protection Division. State clearly that the consumer is filing a complaint against the named business for unfair or deceptive business practices, describe the issue using the details provided, reference general consumer protection principles (misleading advertising, breach of implied warranty, or unconscionable business practices as applicable) WITHOUT inventing or citing a specific state statute name or number — state protection laws vary and the letter should stay accurate by not naming a specific act unless the user already did. Business: {business_name}. State: {state}. Issue: {issue_type}. Details: {details}. Tone: professional, factual, no emotional language.',
  },
  'security-deposit-demand-letter': {
    title: 'Security Deposit Demand Letter (US)',
    gumroad_product_id: 'yikkj',
    prompt_template:
      'Write a formal demand letter to a landlord requesting return of a security deposit. Reference that state security deposit laws impose a specific deadline for returning the deposit or providing an itemized statement of deductions (without inventing a specific statute number or exact day count unless already well-established — state law varies), and that failure to meet this deadline can result in forfeiting the right to withhold any portion of the deposit, with some states allowing additional statutory damages for bad-faith retention. Landlord: {landlord_name}. State: {state}. Deposit amount: {deposit_amount}. Move-out date: {move_out_date}. Issue: {issue}. Tone: professional, firm, requests a clear response deadline (commonly 5-10 days).',
  },
  'notice-to-repair': {
    title: 'Notice to Repair Letter (Habitability)',
    gumroad_product_id: 'lqmxl',
    prompt_template:
      'Write a formal Notice to Repair letter to a landlord, invoking the Implied Warranty of Habitability, which requires landlords to maintain rental units in a condition fit for basic human habitation regardless of lease terms. Describe the issue using the details provided, and request repair within a reasonable time — state that this means an expedited response (same day or next day) if is_emergency is \'Yes\', or a standard reasonable window (commonly 5-14 days, without citing a specific state statute number) if not. Mention that continued failure to act may result in the tenant pursuing repair-and-deduct, rent escrow, or a code enforcement complaint, depending on what\'s permitted in their state. Landlord: {landlord_name}. Issue: {issue}. Details: {details}. Tone: professional, firm, factual.',
  },
  'fcc-complaint': {
    title: 'FCC Informal Complaint Letter',
    gumroad_product_id: 'eyssdz',
    prompt_template:
      'Write a formal FCC informal complaint narrative suitable for submission through the FCC Consumer Complaint Center. State the category of the complaint (billing, service quality, availability, or contract dispute), describe the issue factually using the details provided, reference any prior attempts to resolve it directly with the provider, and state the specific resolution requested (credit, rate correction, technician visit, or contract release, as applicable based on the issue). Provider: {provider_name}. Category: {category}. Prior attempts: {prior_attempts}. Details: {details}. Tone: factual, clear, no emotional language — written to be pasted into the FCC\'s own complaint form fields, not as a mailed letter.',
  },
  'dol-wage-complaint': {
    title: 'DOL Wage Theft Complaint (FLSA)',
    gumroad_product_id: 'cygypm',
    prompt_template:
      'Write a formal wage complaint narrative suitable for submission to the US Department of Labor\'s Wage and Hour Division (WHD), referencing the Fair Labor Standards Act (FLSA). State the employer name, describe the specific wage issue and the discrepancy between hours worked and hours paid using the details provided, and note that FLSA claims generally have a 2-year recovery window (3 years if the violation is willful) without inventing case-specific willfulness language unless clearly supported. If retaliation is \'Yes\', add a separate paragraph noting that retaliation for raising a wage complaint is independently illegal under FLSA Section 15(a)(3), and that this should be reported as well. Employer: {employer_name}. Issue: {issue_type}. Discrepancy: {discrepancy}. Tone: factual, clear, no emotional language — written to be submitted via WHD\'s online complaint form or read over the phone.',
  },
  'au-major-failure-refund-demand': {
    title: 'Major Failure Refund Demand Letter (Australia)',
    gumroad_product_id: 'ikchrx',
    prompt_template:
      'Write a formal demand letter to an Australian retailer asserting that a product fault constitutes a major failure under the Australian Consumer Law (ACL) consumer guarantees. Reference that the ACL does not set a fixed 12-month guarantee period — protection lasts as long as reasonable given the product\'s price and type — and that for a major failure the consumer, not the retailer, chooses between refund and replacement. State plainly that the letter is not a request for goodwill but an assertion of a statutory right, and that the retailer (not the manufacturer) is legally responsible. Do not cite a specific ACL section number unless already well-established; do not invent a compensation figure or fixed response deadline beyond a reasonable window (commonly 7-14 days). Retailer: {retailer_name}. Product: {product}. Purchase date: {purchase_date}. Price paid: {price_paid}. Fault: {fault}. Basis: {failure_test}. Remedy sought: {remedy}. Tone: professional, firm, factual.',
  },
  'au-unauthorised-transaction-dispute': {
    title: 'Bank Dispute Letter — Unauthorised Transaction (Australia)',
    // Real Gumroad product_id for the "au-unauthorised-transaction-dispute" product.
    gumroad_product_id: 'wnqma',
    prompt_template:
      'Write a formal dispute letter to an Australian bank regarding a genuinely unauthorised transaction, invoking the ePayments Code. IMPORTANT: only use this template for transactions the customer did NOT knowingly authorise (stolen card, hacked account, etc.) — do not use scam-related language implying authorised transfers are covered, since the ePayments Code does not currently cover scams where the customer was deceived into authorising a payment themselves. State that under the Code, the customer is not liable for the loss unless the bank can demonstrate the customer contributed through serious carelessness, and that the burden of proof sits with the bank, not the customer. Request a formal investigation and a dispute reference number. Do not invent a specific compensation figure or a fixed response deadline — request a response within a reasonable time (commonly 15-45 days, per standard IDR timeframes) instead. Bank: {bank_name}. Transaction date: {transaction_date}. Amount: {amount}. Scenario: {scenario}. Reported to bank on: {reported_date}. Evidence: {evidence}. Tone: professional, firm, factual.',
  },
  'au-tio-cancellation-demand': {
    title: 'Telco Cancellation & TIO Complaint Letter (Australia)',
    // Real Gumroad product_id for the "au-tio-cancellation-demand" product.
    gumroad_product_id: 'doeik',
    prompt_template:
      'Write a formal letter to an Australian telco/ISP requesting contract cancellation without an early termination fee, referencing that a provider failing to deliver promised service quality or unilaterally changing contract terms is generally considered a breach on the provider\'s side. State that if this isn\'t resolved directly, the customer intends to lodge a complaint with the Telecommunications Industry Ombudsman (TIO), which gives providers a short window (commonly around 10 business days) to resolve complaints once referred. Do not invent a specific TIO fee amount charged to the provider — keep this general (e.g. \'costs associated with TIO involvement\'). Provider: {provider_name}. Issue: {issue}. Cancellation first requested: {cancellation_request_date}. Details: {details}. Remedy sought: {remedy}. Tone: professional, firm, factual.',
  },
  'au-airline-complaint': {
    title: 'Airline Complaint Letter (Australia)',
    // Real Gumroad product_id for the "au-airline-complaint" product.
    gumroad_product_id: 'ymfpyv',
    prompt_template:
      'Write a formal complaint letter to an Australian domestic airline. Do NOT claim a guaranteed automatic cash compensation right — Australia has no EU261-style automatic delay compensation scheme. Frame any expense/reasonable-time argument under the Australian Consumer Law as a claim being made, not a guaranteed entitlement, especially where the cause was airline-controlled (technical/crew/maintenance) rather than weather or air traffic control. For baggage claims, reference the Civil Aviation (Carriers\' Liability) Act 1959 liability framework without inventing a specific dollar cap — note that liability limits are capped and periodically adjusted, and reference the airline\'s own Conditions of Carriage for exact claim deadlines rather than asserting one universal number. If a refund is sought instead of a travel voucher, state that clearly. Airline: {airline_name}. Flight: {flight_details}. Issue: {issue_type}. Cause: {cause}. Expenses: {expenses}. PIR filed: {pir_filed}. Remedy sought: {remedy}. Tone: professional, firm, factual, realistic about what is guaranteed versus what is being requested.',
  },
  'au-notice-to-remedy-repairs': {
    title: 'Notice to Remedy / Urgent Repairs Letter (Australia)',
    // Real Gumroad product_id for the "au-notice-to-remedy-repairs" product.
    gumroad_product_id: 'rdytkn',
    prompt_template:
      "Write a formal Notice to Remedy Breach / Urgent Repairs letter to a landlord or agent in Australia. If is_urgent is 'Yes', state that the tenant may arrange a qualified tradesperson directly and seek reimbursement if the landlord doesn't act immediately, and request contact within 24 hours. If 'No', request repair within a reasonable window (commonly 7-14 days, noting this varies by state — do not assert one fixed number as universal law). Do NOT suggest withholding rent under any circumstance — explicitly state that rent will continue to be paid in full. Mention that if the deadline passes, the tenant may apply to their state tenancy tribunal (NCAT/VCAT/QCAT or equivalent) for a repair order and/or compensation. Landlord/agent: {landlord_name}. State: {state}. Issue: {issue}. Urgent: {is_urgent}. Details: {details}. Prior contact: {prior_contact}. Tone: professional, firm, factual.",
  },
};

const OUTPUT_RULES =
  '\n\nOutput ONLY the finished letter itself, ready to send — start with a date and address block and end with a signature line. Do not include any commentary, explanation, notes, or markdown code fences. Use [square brackets] for any detail the user did not provide (e.g. [Your name], [Your address]).';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

function rateKey(ip) {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return `ip:${ip}:${day}:generators`;
}

function randomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fill {placeholders} from answers, then append every answer verbatim so values
// referenced only in prose (e.g. country) are always available to the model.
function buildPrompt(template, answers) {
  let filled = template.replace(/\{(\w+)\}/g, (m, key) =>
    answers[key] != null && answers[key] !== '' ? String(answers[key]) : m
  );
  const details = Object.keys(answers)
    .map((k) => `- ${k}: ${answers[k]}`)
    .join('\n');
  return `${filled}\n\nAll details provided by the user:\n${details}${OUTPUT_RULES}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }
    if (path === '/preview') return handlePreview(request, env);
    if (path === '/unlock') return handleUnlock(request, env);
    return jsonResponse({ error: 'Not found' }, 404);
  },
};

// ---- Free preview: generate full letter, release only the first paragraph ----
async function handlePreview(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: 'Server is missing ANTHROPIC_API_KEY' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const gen = GENERATORS[body && body.generatorId];
  if (!gen) return jsonResponse({ error: 'Unknown generator' }, 400);
  const answers = (body && body.answers) || {};
  if (typeof answers !== 'object' || !Object.keys(answers).length) {
    return jsonResponse({ error: 'Missing answers' }, 400);
  }

  const ip = clientIp(request);
  const kv = env.GENERATORS_KV;
  const key = rateKey(ip);

  // Shared free-preview rate limit (fails open on KV error so a KV blip never
  // blocks a paying customer's preview).
  let used = 0;
  if (kv) {
    try {
      const stored = await kv.get(key);
      used = stored ? parseInt(stored, 10) || 0 : 0;
    } catch (err) {
      used = 0;
    }
    if (used >= DAILY_PREVIEW_LIMIT) {
      return jsonResponse(
        {
          error: 'limit_reached',
          message:
            'You have used your 3 free letter previews today (shared across all generators). Come back tomorrow, or unlock a full letter below.',
        },
        429
      );
    }
  }

  const prompt = buildPrompt(gen.prompt_template, answers);

  let letter;
  try {
    letter = await generateLetter(env.ANTHROPIC_API_KEY, prompt);
  } catch (err) {
    return jsonResponse(
      { error: 'Generation service is busy, please try again in a moment.', detail: err.message },
      503
    );
  }
  if (!letter) {
    return jsonResponse({ error: 'Could not generate a letter, please try again.' }, 502);
  }

  // Split: reveal the first paragraph, keep the rest server-side.
  const { visible, blurLines } = splitPreview(letter);
  const previewId = randomId();
  if (kv) {
    try {
      await kv.put(`preview:${previewId}`, letter, { expirationTtl: KV_TTL });
      await kv.put(key, String(used + 1), { expirationTtl: KV_TTL });
    } catch (err) {
      /* preview just won't survive a refresh; unlock will regenerate from answers */
    }
  }

  return jsonResponse({
    previewId,
    preview: visible,
    blurLines,
    remaining: Math.max(0, DAILY_PREVIEW_LIMIT - (used + 1)),
  });
}

// ---- Paid unlock: verify Gumroad license by product_id, release full letter ----
async function handleUnlock(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const gen = GENERATORS[body && body.generatorId];
  if (!gen) return jsonResponse({ error: 'Unknown generator' }, 400);
  const licenseKey = ((body && body.licenseKey) || '').toString().trim();
  if (!licenseKey) return jsonResponse({ error: 'Please enter your license key.' }, 400);

  const kv = env.GENERATORS_KV;

  // Refresh-safe: if this key already unlocked a letter, return it without
  // re-verifying (so refreshing the page keeps access and never double-charges
  // the uses count).
  if (kv) {
    try {
      const already = await kv.get(`redeem:${licenseKey}`);
      if (already) return jsonResponse({ letter: already, alreadyRedeemed: true });
    } catch (err) {
      /* fall through to verification */
    }
  }

  // Verify by product_id (looked up server-side) — NEVER by product_permalink,
  // which has a known key-forgery vulnerability.
  let verify;
  try {
    verify = await verifyGumroadLicense(gen.gumroad_product_id, licenseKey);
  } catch (err) {
    return jsonResponse(
      { error: 'Could not reach the license service, please try again.', detail: err.message },
      503
    );
  }

  if (!verify || verify.success !== true) {
    return jsonResponse(
      { error: 'invalid_license', message: 'That license key is not valid for this generator.' },
      403
    );
  }
  const purchase = verify.purchase || {};
  if (purchase.refunded || purchase.chargebacked || purchase.disputed) {
    return jsonResponse(
      { error: 'invalid_license', message: 'This purchase is no longer valid (refunded or disputed).' },
      403
    );
  }
  // One letter per purchase: with increment_uses_count=true, uses === 1 on the
  // first legitimate redemption. A higher count with no stored letter means the
  // key was already used elsewhere.
  if (typeof verify.uses === 'number' && verify.uses > 1) {
    return jsonResponse(
      {
        error: 'license_used',
        message: 'This license key has already been used to unlock a letter.',
      },
      403
    );
  }

  // Retrieve the exact previewed letter; regenerate from answers if the preview
  // expired (so the buyer still gets a letter).
  let letter = null;
  const previewId = (body && body.previewId) || '';
  if (kv && previewId) {
    try {
      letter = await kv.get(`preview:${previewId}`);
    } catch (err) {
      letter = null;
    }
  }
  if (!letter) {
    const answers = (body && body.answers) || {};
    if (!Object.keys(answers).length && env.ANTHROPIC_API_KEY == null) {
      return jsonResponse({ error: 'Your preview expired — please generate it again.' }, 410);
    }
    if (Object.keys(answers).length && env.ANTHROPIC_API_KEY) {
      try {
        letter = await generateLetter(env.ANTHROPIC_API_KEY, buildPrompt(gen.prompt_template, answers));
      } catch (err) {
        letter = null;
      }
    }
  }
  if (!letter) {
    return jsonResponse({ error: 'Your preview expired — please generate it again.' }, 410);
  }

  if (kv) {
    try {
      await kv.put(`redeem:${licenseKey}`, letter, { expirationTtl: KV_TTL });
    } catch (err) {
      /* non-fatal; buyer still gets the letter this time */
    }
  }
  return jsonResponse({ letter });
}

// Reveal the letter's header + opening line as the free teaser, then blur the
// rest (the actual demand, legal citation and deadline). Never reveal more than
// ~45% of the letter, and no hidden content is sent to the browser.
function splitPreview(letter) {
  const paras = letter.split(/\n\s*\n/);
  const cap = Math.floor(letter.length * 0.45);
  const shown = [];
  let len = 0;
  for (const p of paras) {
    if (shown.length >= 1 && (len >= 260 || len + p.length > cap)) break;
    shown.push(p);
    len += p.length + 2;
  }
  const visible = shown.join('\n\n').trim();
  const hidden = letter.slice(visible.length);
  const blurLines = Math.min(18, Math.max(6, hidden.split('\n').filter((l) => l.trim()).length));
  return { visible, blurLines };
}

// ---- Anthropic call with a timeout + retry-with-backoff on transient errors ----
async function generateLetter(apiKey, prompt) {
  let lastDetail = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    let res = null;
    try {
      res = await anthropicFetch(apiKey, prompt);
    } catch (netErr) {
      lastDetail =
        netErr && netErr.name === 'AbortError'
          ? 'Anthropic request timed out'
          : (netErr && netErr.message) || 'network error';
    }
    if (res && res.ok) {
      const data = await res.json();
      const block = (data.content || []).find((b) => b.type === 'text');
      return block ? block.text.trim() : '';
    }
    const status = res ? res.status : 0;
    const transient =
      !res || status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
    if (!transient) {
      lastDetail = await res.text();
      throw new Error('Claude API error ' + status + ': ' + lastDetail);
    }
    if (res) lastDetail = await res.text();
    if (attempt < 2) await sleep(400 * (attempt + 1)); // 400ms, 800ms
  }
  throw new Error(lastDetail || 'model unavailable');
}

async function anthropicFetch(apiKey, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000); // 25s < Worker limit
  try {
    return await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---- Gumroad license verification (by product_id, increments the uses count) ----
async function verifyGumroadLicense(productId, licenseKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        product_id: productId,
        license_key: licenseKey,
        increment_uses_count: 'true',
      }),
      signal: controller.signal,
    });
    // Gumroad returns 404 with { success:false } for an unknown key — treat as
    // an invalid license, not a transport error.
    if (res.status === 404) return { success: false };
    if (!res.ok) throw new Error('Gumroad responded ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
