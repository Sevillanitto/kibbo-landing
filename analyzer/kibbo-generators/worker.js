// Kibbo Generators — shared, config-driven letter-generator engine (Cloudflare Worker)
//
// One Worker powers every letter generator. Adding a generator = adding an entry
// to GENERATORS below (+ a config-only frontend page); no new Worker code.
//
// Pricing model (email-capture unlock, free — replaced the Gumroad/license-key
// model on 2026-09-11; see verifyGumroadLicense() below, kept but unused in
// case this needs to be reverted):
//   - Free tier: PREVIEW ONLY. The Worker generates the full letter server-side
//     but only releases the first paragraph to the browser; the rest stays in KV.
//   - Submitting an email (handled entirely on the main Vercel site, at
//     /api/unlock-generators — Mailchimp + Resend, never touches this Worker)
//     unlocks every generator site-wide via a client-side localStorage flag.
//     This Worker's /unlock endpoint no longer checks anything -- it just
//     releases the full letter for a given previewId.
//
// Endpoints:
//   POST /preview  { generatorId, answers }
//       -> rate-limited DAILY_GENERATION_LIMIT/day per IP, SHARED across all
//          generators (any Anthropic-calling request draws from the same
//          per-IP budget -- see checkGenerationLimits()). Generates the full
//          letter, stores it server-side, returns only the first paragraph +
//          a blur hint. { previewId, preview, blurLines, remaining }
//   POST /unlock   { generatorId, previewId, answers }
//       -> releases the full letter for that preview (regenerating from
//          answers -- itself subject to the same per-IP/global limits below
//          -- if the preview already expired). { letter }
//
// Cost guardrails (added 2026-09-12, generation still gated behind
// GENERATORS_PAUSED='true' until Carlos confirms Anthropic credit is loaded
// -- see the "go live" note near isGeneratorsPaused() below):
//   - Model: claude-haiku-4-5-20251001 (see anthropicFetch() below) -- this
//     was already the case before this change, for every generator AND every
//     analyzer Worker in this codebase; there was never a Sonnet call to
//     switch away from here. Confirmed by grepping every worker.js in
//     analyzer/ -- all eleven, generators included, already read
//     'claude-haiku-4-5-20251001'. Left as-is; nothing to change.
//   - Per-IP daily limit: DAILY_GENERATION_LIMIT (10) per IP per 24h, shared
//     across every generator combined -- NOT new; a per-IP shared limit
//     already existed here at 3/day (checked only in /preview). This raises
//     it to 10 per the new spec and closes the one real gap: /unlock's
//     regenerate-from-expired-preview path used to call Anthropic with NO
//     limit check at all. Both paths now go through checkGenerationLimits().
//   - Global daily kill switch: GENERATOR_DAILY_CALL_CAP (env var, default
//     500) across ALL IPs combined. Once hit, every request gets the exact
//     same { paused: true } response the manual billing pause already
//     produces -- the existing frontend "coming soon" UI (generator-engine.js)
//     handles that response shape already, so no frontend change was needed
//     for this part. Trip events are logged via console.log (visible in the
//     Cloudflare dashboard's Worker logs) with the day/time/cap/count.
//   - Prompt caching: NOT implemented. Every prompt_template below interleaves
//     its fixed instructional text with inline {placeholder} substitutions
//     throughout the string (not a clean fixed-prefix + variable-suffix
//     split), so a cache_control breakpoint can't be placed safely without
//     rewriting all ~89 templates to move every {placeholder} to the end --
//     real restructuring risk for a change that's about cost, not features.
//     Flagged as a future optimization, not attempted here.
//   - Monthly cap: NOT a code control. Carlos still needs to set a monthly
//     spend limit in the Anthropic Console (Settings -> Billing) as the
//     final backstop independent of everything above.
//
// Required bindings / secrets:
//   - ANTHROPIC_API_KEY (secret): wrangler secret put ANTHROPIC_API_KEY
//   - GENERATORS_KV (KV namespace binding): namespace "generators-rate-limit"
//     -- also used for the global kill-switch counter (see globalCallKey()).
//     This is the same KV-based rate-limiting PATTERN every analyzer Worker
//     uses via its own RATE_LIMIT_KV binding (DAILY_LIMIT const + rateKey()
//     + fail-open-on-KV-error); reused here under its existing binding name
//     rather than introducing a second KV namespace, which would need a new
//     Cloudflare-side `wrangler kv namespace create` + dashboard binding step
//     with no functional benefit over the binding already wired up here.
//   - GENERATOR_DAILY_CALL_CAP (optional env var / wrangler.toml [vars]):
//     the global kill-switch cap; defaults to 500 if unset or invalid.

const DAILY_GENERATION_LIMIT = 10; // shared across ALL generators, per IP per day (was 3) -- AI-cost guardrail, static generators don't use this
const DEFAULT_DAILY_CALL_CAP = 500; // global kill-switch default if GENERATOR_DAILY_CALL_CAP is unset -- AI-cost guardrail, static generators don't use this
const MAX_TOKENS = 1200; // one-page letter — Haiku, template filling not reasoning
const KV_TTL = 86400; // 24h for previews and the rate-limit counters

// ---- Static-mode generators (2026-09-16 migration) ----
// A generator with `static: true` in its GENERATORS entry below renders its
// letter directly from `render(answers)` -- pure template substitution +
// branch logic, no Anthropic call, no ANTHROPIC_API_KEY dependency, not
// affected by isGeneratorsPaused() or checkGenerationLimits() (both of
// those exist purely to protect Anthropic spend, which a static generator
// doesn't have). The generator's original `prompt_template` field is left
// in place, unused, exactly like verifyGumroadLicense() below -- in case a
// generator ever needs to be reverted to AI mode.
//
// Abuse prevention for static generators is intentionally separate from
// the AI-cost guardrails above: STATIC_DAILY_LIMIT is a much more generous
// per-IP cap (rendering a template costs ~nothing, so this exists only to
// blunt obvious scripted abuse of the endpoint, not to protect spend) and
// has no global cross-IP cap, since there's no aggregate spend to protect
// against.
const STATIC_DAILY_LIMIT = 100; // per IP per day -- abuse prevention only, not cost-related

function staticRateKey(ip) {
  const day = new Date().toISOString().slice(0, 10);
  return `ip:${ip}:${day}:static-generators`;
}

// Same fail-open-on-KV-error stance as checkGenerationLimits() below.
async function checkStaticAbuseLimit(env, ip) {
  const kv = env.GENERATORS_KV;
  if (!kv) return { blocked: false, kv: null };
  const key = staticRateKey(ip);
  let used = 0;
  try {
    const stored = await kv.get(key);
    used = stored ? parseInt(stored, 10) || 0 : 0;
  } catch (err) {
    used = 0; // fail open
  }
  if (used >= STATIC_DAILY_LIMIT) {
    return {
      blocked: true,
      response: jsonResponse(
        { error: 'limit_reached', message: "You've reached today's limit for generating documents. Please try again tomorrow." },
        429
      ),
    };
  }
  return { blocked: false, kv, key, used };
}

async function recordStaticUsage(limits) {
  if (!limits || !limits.kv) return;
  try {
    await limits.kv.put(limits.key, String(limits.used + 1), { expirationTtl: KV_TTL });
  } catch (err) {
    /* best-effort */
  }
}

function todayDate() {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const d = new Date();
  return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
}

// N/A-convention helper: matches this codebase's established pattern of
// asking users to type the literal string "N/A" for a conditionally
// irrelevant field, rather than allowing a truly blank submission (the
// frontend engine requires every visible field to be non-empty).
function hasValue(v) {
  return !!(v && String(v).trim() && String(v).trim().toUpperCase() !== 'N/A');
}

// ---- Numeric-tier parsing (approved Option A, see
// _drafts-pending/generators-static-migration/numeric-parsing-plan.md) --
// used only by eu261-flight-compensation-claim (distance_km) and
// eu-train-delay-claim (delay_minutes), the only 2 of 88 generators that
// branch on a numeric threshold rather than a closed select. Validation
// lives here, worker.js-side, where the tier decision actually happens --
// not as a frontend regex that could drift out of sync with this logic.
function parsePlainNumber(raw) {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/[^\d]/g, ''); // strip everything but 0-9
  if (!digits) return null;
  return parseInt(digits, 10);
}

// Sentinel object a render() function returns instead of a letter string
// when a required numeric field couldn't be parsed. handlePreview/
// handleUnlock recognize this shape and return an explicit refusal to the
// client instead of ever guessing a tier or silently falling through.
function staticValidationError(message) {
  return { staticValidationError: message };
}

// ---- Static render functions (pilot batch, 2026-09-16) ----
// Each takes the `answers` object exactly as submitted by the frontend
// form and returns the finished letter as a plain string. Ported 1:1 from
// the approved literal templates in
// _drafts-pending/generators-static-migration/ -- see those files for the
// annotated per-branch source and the fully-resolved examples used to
// verify this matches before wiring.

function renderLostParcel(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.retailer);
  lines.push('Re: Formal Demand for Refund — Order dated ' + a.order_date);
  lines.push('');
  lines.push('I am writing to formally demand a full refund of ' + a.amount + ' for my order placed with you on ' + a.order_date + '.');
  lines.push('');
  if (a.issue === 'Never arrived') {
    lines.push('This parcel has never arrived.');
  } else if (a.issue === 'Arrived damaged') {
    lines.push('This parcel arrived damaged, and its contents are not usable as delivered.');
  }
  lines.push('');
  if (a.country === 'UK') {
    lines.push("Under the Consumer Rights Act 2015, you as the retailer remain legally responsible for these goods until they reach me, regardless of which courier you used to deliver them. This responsibility is yours, not the courier's, and does not depend on any dispute you may have with your delivery provider.");
  } else if (a.country === 'US') {
    lines.push('Under consumer protection law, a retailer is generally responsible for ensuring goods are delivered as ordered, and remains liable to the customer when a shipment is lost or arrives damaged — this responsibility does not transfer to the courier simply because a third party handled delivery.');
  }
  lines.push('');
  lines.push('I am requesting a full refund of ' + a.amount + ' within 48 hours of this letter. If I do not receive confirmation of a refund within that time, I will pursue this through a card chargeback, my bank, or the relevant consumer protection authority, and will reference this letter as evidence that you were given fair notice and an opportunity to resolve this directly.');
  lines.push('');
  lines.push('Please confirm receipt of this letter and the refund timeline in writing.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderFdcpaCeaseDesist(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.collector_name);
  lines.push('Re: Account Reference ' + a.account_reference + ' — Cease and Desist Communication');
  lines.push('');
  lines.push('This letter is a formal cease-and-desist notice under Section 805(c) of the Fair Debt Collection Practices Act (FDCPA), 15 U.S.C. § 1692c(c).');
  lines.push('');
  lines.push('I am writing regarding the following issue with your communications: ' + a.issue + '.');
  lines.push('');
  lines.push('Pursuant to Section 805(c) of the FDCPA, I am formally requesting that you cease all further communication with me regarding this account, except to confirm that you are ceasing collection efforts, or to notify me that you intend to invoke a specific legal remedy, such as filing a lawsuit.');
  lines.push('');
  lines.push('Any further contact with me outside of these two narrow exceptions will be treated as a violation of the FDCPA.');
  lines.push('');
  lines.push('Please direct any necessary correspondence to the address below.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  lines.push('[Your address]');
  lines.push('');
  lines.push('---');
  lines.push('Sending instructions: Send this letter via certified mail with return receipt requested, and keep a copy along with the mailing receipt for your records.');
  if (a.is_third_party === 'No / Not sure') {
    lines.push('');
    lines.push('Note: The FDCPA generally applies only to third-party debt collectors — not to an original creditor (like your own bank or lender) collecting its own debt directly. Before sending this letter, confirm whether ' + a.collector_name + ' is a third-party collection agency or your original creditor, since this affects whether the FDCPA applies to your situation.');
  }
  return lines.join('\n');
}

function renderHealthcareComplaintLetter(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.provider_name);
  lines.push('Re: Formal Complaint — Incident on ' + a.incident_date);
  lines.push('');
  lines.push('I am writing to formally complain about an incident that occurred on ' + a.incident_date + ': ' + a.incident_description + '.');
  lines.push('');
  if (hasValue(a.prior_contact_details)) {
    lines.push('I previously raised this informally: ' + a.prior_contact_details + '. This was not adequately resolved, which is why I am now submitting this as a formal written complaint.');
    lines.push('');
  }
  lines.push('The outcome I am seeking is: ' + a.desired_outcome + '.');
  lines.push('');
  lines.push('If this complaint is not addressed satisfactorily, I may escalate this matter to the applicable healthcare complaints body for my jurisdiction.');
  lines.push('');
  lines.push('Jurisdiction: ' + a.jurisdiction + '.');
  lines.push('');
  lines.push('Please acknowledge receipt of this letter and provide a substantive response within a reasonable timeframe.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.patient_full_name);
  return lines.join('\n');
}

function renderEuGdprRightsRequest(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.company_name);
  lines.push('Re: GDPR Rights Request');
  lines.push('');
  if (a.request_type === 'Subject Access Request (Article 15)') {
    lines.push('I am writing to exercise my right of access under Article 15 of the GDPR. Please provide me with confirmation of whether you are processing my personal data, and if so, a copy of that data along with the purposes of processing, the categories of data involved, the recipients it has been or will be disclosed to, and the period for which it will be stored.');
  } else if (a.request_type === 'Erasure / Right to be Forgotten (Article 17)') {
    lines.push('I hereby exercise my Right to Erasure under Article 17 of the GDPR. Please delete all personal data you hold about me and confirm in writing once this has been completed, including confirmation that any data shared with third parties has also been deleted or that those parties have been informed of my request.');
  } else if (a.request_type === 'Rectification of incorrect data') {
    lines.push('I am writing to request rectification of incorrect personal data you hold about me, under Article 16 of the GDPR.');
  } else if (a.request_type === "Formal complaint to the company's DPO (before escalating to a DPA)") {
    lines.push('I am writing a formal complaint to your Data Protection Officer regarding the handling of my personal data. This letter is being sent as the required step before I escalate this matter to my national Data Protection Authority if it is not resolved.');
  }
  lines.push('');
  lines.push('Additional context: ' + a.details);
  lines.push('');
  if (a.prior_contact === "Yes, and they didn't respond within the deadline") {
    lines.push("I note that I have already raised this with you previously and did not receive a response within the required deadline.");
    lines.push('');
  } else if (a.prior_contact === 'Yes, and their response was unsatisfactory') {
    lines.push('I note that I have already raised this with you previously, and your response was not satisfactory.');
    lines.push('');
  }
  lines.push('Please note that under the GDPR, you are required to respond within one month of receiving this request. This may be extended by up to two further months for complex requests, provided you notify me of the extension and the reasons for it within the first month.');
  lines.push('');
  lines.push('If this matter is not resolved to my satisfaction, I intend to lodge a complaint with my national Data Protection Authority.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

// ---- Static render functions (Batch 1 rollout: Financial & Banking,
// 2026-09-17) ----
// Ported 1:1 from the approved literal templates in
// _drafts-pending/generators-static-migration/batch-2.md. fdcpa-cease-desist
// (the 13th Financial & Banking generator) was already ported during the
// pilot batch above.

function renderFcraCreditDispute(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.bureau);
  lines.push('Re: Formal Credit Report Dispute');
  lines.push('');
  lines.push('Issue: ' + a.issue_type + '.');
  lines.push('Account/reference: ' + a.account_reference + '.');
  lines.push('');
  lines.push('Details of the error: ' + a.details);
  lines.push('');
  if (a.jurisdiction === 'US') {
    lines.push('I am disputing this as an FCRA Section 611 dispute under the Fair Credit Reporting Act. I am requesting that you conduct a reasonable reinvestigation and delete or correct this item if it cannot be verified within the 30-day statutory window (45 days if applicable).');
  } else if (a.jurisdiction === 'UK' || a.jurisdiction === 'EU' || a.jurisdiction === 'Australia') {
    lines.push('I am exercising my general right to dispute inaccurate information on my credit file and have it investigated within the timeframe that applies in my area.');
  }
  lines.push('');
  lines.push('I am requesting correction or removal of this item, and a copy of the updated report once your investigation concludes.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.customer_name);
  return lines.join('\n');
}

function renderAuUnauthorisedTransactionDispute(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.bank_name);
  lines.push('Re: Unauthorised Transaction Dispute — ' + a.amount + ' on ' + a.transaction_date);
  lines.push('');
  lines.push('I am formally disputing a transaction of ' + a.amount + ' on ' + a.transaction_date + ' as unauthorised.');
  lines.push('');
  lines.push('What happened: ' + a.scenario);
  lines.push('');
  lines.push('Evidence: ' + a.evidence);
  lines.push('');
  lines.push('I reported this to you on ' + a.reported_date + '. Under the ePayments Code, I am not liable for this loss unless you can demonstrate I contributed through serious carelessness — the burden of proof sits with you, not me.');
  lines.push('');
  lines.push('I am requesting a formal investigation and a dispute reference number.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderEuBankComplaintFinnet(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.bank_name);
  lines.push('Re: Formal Complaint');
  lines.push('');
  lines.push('Issue: ' + a.issue + '.');
  lines.push('');
  lines.push(a.details);
  lines.push('');
  if (a.escalation_stage === 'Filing the first complaint to the bank') {
    lines.push('This is my first complaint on this matter.');
    if (a.issue === 'Payment service issue (transfer, card, unauthorised charge)') {
      lines.push('As this concerns a payment service, I understand you have 15 business days to respond under the Payment Services Directive (extendable to 35 in exceptional cases).');
    }
  } else if (a.escalation_stage === "Bank didn't respond within 15 business days") {
    lines.push('I raised this complaint previously and did not receive a response within 15 business days.');
  } else if (a.escalation_stage === 'Bank responded but unsatisfactorily — ready to escalate to FIN-NET') {
    lines.push('I raised this complaint previously and your response was unsatisfactory. If this is not resolved, I intend to escalate it to FIN-NET, my national financial ombudsman.');
  }
  lines.push('');
  lines.push('Remedy sought: ' + a.remedy + '.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderEuSepaRecallRequest(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.bank_name);
  lines.push('Re: SEPA Recall Request');
  lines.push('');
  lines.push('I am requesting a SEPA recall for the following transfer: ' + a.transfer_details + '.');
  lines.push('');
  lines.push('Basis for recall: ' + a.basis + '.');
  lines.push('');
  lines.push(a.details);
  lines.push('');
  if (a.vop_shown === 'Yes, but I proceeded anyway') {
    lines.push('Verification of Payee showed a mismatch warning before I sent this transfer, and I proceeded anyway.');
  } else if (a.vop_shown === 'Yes, and my bank should have blocked/warned more clearly') {
    lines.push('Verification of Payee showed a mismatch warning, but I believe it should have been presented more clearly, or the transfer should have been blocked pending my confirmation.');
  } else if (a.vop_shown === 'No mismatch was shown') {
    lines.push('No Verification of Payee mismatch was shown before I sent this transfer.');
  } else if (a.vop_shown === "VoP wasn't offered at all") {
    lines.push("Verification of Payee was not offered at all for this transfer. I believe this may support a separate compensation claim against you under the Instant Payments Regulation, distinct from this recall request.");
  }
  lines.push('');
  lines.push("Under the standard SEPA recall framework, I understand this request should be initiated within a reasonable window (commonly around 10 business days), and the receiving bank typically has around 15 business days to respond. I understand funds cannot be withdrawn from the recipient's account without their consent unless fraud or a technical error is shown.");
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderEuUnauthorisedTransactionPsd2(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.bank_name);
  lines.push('Re: PSD2 Unauthorised Transaction Refund Demand');
  lines.push('');
  lines.push('I am disputing the following transaction as unauthorised: ' + a.transaction_details + '. I reported this to you on ' + a.reported_date + '.');
  lines.push('');
  lines.push('Strong Customer Authentication used: ' + a.sca_used + '.');
  lines.push('');
  if (a.sca_used === 'No, not requested at all' || a.sca_used === 'Not sure') {
    lines.push('As Strong Customer Authentication does not appear to have been properly required for this transaction, I believe liability shifts to you/the merchant under PSD2 for failing to require SCA.');
  } else if (a.sca_used === "Yes, but I didn't authorise it") {
    lines.push('Although Strong Customer Authentication was completed for this transaction, I did not personally authorise it — I believe this points to a compromise of my authentication method or device, which is a separate basis for disputing this transaction as unauthorised.');
  }
  lines.push('');
  lines.push('Loss before I reported it: ' + a.loss_before_report);
  lines.push('');
  lines.push('Under PSD2, my maximum liability for losses before reporting is capped at €50, and I have zero liability for anything after I reported it. I am requesting restitution by no later than the end of the business day following this notification.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderBankComplaintLetter(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.bank_name);
  lines.push('Re: Formal Complaint — Account ' + a.account_reference);
  lines.push('');
  lines.push('Issue type: ' + a.issue_category + '.');
  lines.push('');
  lines.push(a.issue_description);
  lines.push('');
  if (a.prior_contact === 'Yes, verbally, no resolution') {
    lines.push('I previously raised this verbally and it was not resolved.');
    lines.push('');
  } else if (a.prior_contact === 'Yes, in writing, no resolution') {
    lines.push('I previously raised this in writing and it was not resolved.');
    lines.push('');
  }
  lines.push('Desired outcome: ' + a.desired_outcome + '.');
  lines.push('');
  lines.push('If this is not resolved within a reasonable period, I may escalate this matter to the applicable financial complaints body for my jurisdiction.');
  lines.push('');
  lines.push('Jurisdiction: ' + a.jurisdiction + '.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.customer_name);
  return lines.join('\n');
}

function renderUnauthorizedTransactionDisputeLetter(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.bank_name);
  lines.push('Re: Unauthorized Transaction Dispute');
  lines.push('');
  lines.push('I do not recognize or authorize the transaction on ' + a.transaction_date + ' for ' + a.transaction_amount + ' at ' + a.merchant_name + ', first noticed on ' + a.detected_date + '.');
  lines.push('');
  lines.push('Card/access device status: ' + a.card_or_account_status + '.');
  lines.push('');
  lines.push('My liability protections generally depend on how promptly I report this. Jurisdiction: ' + a.jurisdiction + '.');
  lines.push('');
  lines.push('I am requesting this transaction be investigated and reversed, and ask for written confirmation of the case reference number.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.customer_name);
  return lines.join('\n');
}

function renderCardTransactionBillingDispute(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.card_issuer);
  lines.push('Re: Card Transaction Dispute');
  lines.push('');
  lines.push('I am disputing a transaction of ' + a.transaction_amount + ' on ' + a.transaction_date + ' from ' + a.merchant_name + '.');
  lines.push('');
  lines.push('Reason for dispute: ' + a.dispute_reason + '.');
  lines.push('');
  lines.push(a.details);
  lines.push('');
  if (a.merchant_contact_attempted === 'Yes, no response') {
    lines.push('I contacted the merchant directly and received no response.');
  } else if (a.merchant_contact_attempted === 'Yes, refused') {
    lines.push('I contacted the merchant directly and they refused to resolve this.');
  } else if (a.merchant_contact_attempted === 'No') {
    lines.push('I have not yet contacted the merchant directly about this.');
  }
  lines.push('');
  lines.push("This dispute is being filed within my card network's standard filing window. I am requesting a formal chargeback/dispute investigation and a written case reference.");
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.customer_name);
  return lines.join('\n');
}

function renderBankFeeRefundRequest(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.bank_name);
  lines.push('Re: Fee Refund Request');
  lines.push('');
  lines.push('I am requesting a refund of a ' + a.fee_type + ' of ' + a.fee_amount + ' charged on ' + a.fee_date + '.');
  lines.push('');
  lines.push('Basis for dispute: ' + a.dispute_basis);
  lines.push('');
  lines.push('Banks are generally required to disclose fees and any changes to them clearly before charging. Jurisdiction: ' + a.jurisdiction + '.');
  lines.push('');
  lines.push('I am requesting a full refund and written confirmation.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.customer_name);
  return lines.join('\n');
}

function renderLoanCreditAgreementCancellationWithdrawal(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.lender_name);
  lines.push('Re: Notice of Cancellation/Withdrawal — Agreement ' + a.agreement_reference);
  lines.push('');
  lines.push('I am formally cancelling/withdrawing from the credit agreement referenced ' + a.agreement_reference + ', signed on ' + a.signing_date + '.');
  lines.push('');
  if (hasValue(a.cancellation_reason)) {
    lines.push('Reason: ' + a.cancellation_reason);
  } else {
    lines.push('I am exercising this as a right, and no reason is required.');
  }
  lines.push('');
  lines.push('Many jurisdictions provide a statutory cooling-off/right-of-withdrawal period for certain consumer credit agreements. Jurisdiction: ' + a.jurisdiction + '. I am confirming this period applies to my specific agreement before relying on it.');
  lines.push('');
  lines.push('I am requesting written confirmation that this agreement is cancelled, and confirmation of any amount owed or refundable.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.customer_name);
  return lines.join('\n');
}

function renderFinancialOmbudsmanRegulatorComplaint(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  let to = '';
  if (a.jurisdiction === 'US') {
    to = 'the Consumer Financial Protection Bureau (CFPB)';
  } else if (a.jurisdiction === 'UK') {
    to = 'the Financial Ombudsman Service (FOS)';
  } else if (a.jurisdiction === 'EU') {
    to = 'FIN-NET / my national competent authority';
  } else if (a.jurisdiction === 'Australia') {
    to = 'the Australian Financial Complaints Authority (AFCA)';
  }
  lines.push('To: ' + to);
  lines.push('Re: Complaint Escalation — ' + a.institution_name);
  lines.push('');
  lines.push('I am escalating a complaint regarding ' + a.institution_name + '.');
  lines.push('');
  lines.push('Summary of the issue: ' + a.issue_summary);
  lines.push('');
  lines.push('I first contacted ' + a.institution_name + ' about this on ' + a.prior_complaint_date + '. Their response: ' + a.institution_response);
  lines.push('');
  lines.push('Desired outcome: ' + a.desired_outcome);
  lines.push('');
  lines.push("I am filing this escalation because " + a.institution_name + "'s own complaints process has been exhausted or a reasonable response period has passed.");
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.customer_name);
  return lines.join('\n');
}

function renderDebtCollectionDisputeLetter(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.collector_name);
  lines.push('Re: Formal Debt Validation/Dispute — ' + a.claimed_amount);
  lines.push('');
  let debtLine = 'I am disputing the claimed debt of ' + a.claimed_amount;
  if (hasValue(a.original_creditor)) {
    debtLine += ', originally from ' + a.original_creditor;
  }
  debtLine += '.';
  lines.push(debtLine);
  lines.push('');
  lines.push('Basis for dispute: ' + a.dispute_basis + '.');
  lines.push('');
  lines.push(a.details);
  lines.push('');
  lines.push('I am exercising my right to request written validation of this debt before you continue any collection activity. Jurisdiction: ' + a.jurisdiction + '.');
  lines.push('');
  lines.push('I am explicitly requesting: written proof of the debt, verification that you are legally entitled to collect it, and confirmation of the exact amount owed with an itemized breakdown.');
  lines.push('');
  lines.push('This letter is not an admission of the debt.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.customer_name);
  return lines.join('\n');
}

// ---- Static render functions (Batch 2 rollout: Legal & Contracts,
// Privacy & Data, Public Services & Administration, 2026-09-17) ----
// Ported 1:1 from the approved literal templates in
// _drafts-pending/generators-static-migration/batch-5.md.

function renderContractDemandLetter(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.other_party_name);
  lines.push('Re: Formal Demand — Contract ' + a.contract_reference);
  lines.push('');
  lines.push('I am writing regarding our contract, ' + a.contract_reference + '.');
  lines.push('');
  lines.push('Issue: ' + a.issue_type + '.');
  lines.push('');
  if (a.issue_type === 'Breach of contract') {
    lines.push('Obligation breached: ' + a.breach_obligation + '. This breach occurred or was discovered on ' + a.breach_date + '. Evidence available: ' + a.breach_evidence + '.');
  } else if (a.issue_type === 'Payment owed to you') {
    lines.push('Amount owed: ' + a.payment_amount + ', for ' + a.payment_for + ', originally due ' + a.payment_due_date + '.');
    if (a.payment_partial_received === 'Yes — specify amount') {
      lines.push('A partial payment of ' + a.payment_partial_amount + ' has already been received.');
    }
  } else if (a.issue_type === 'Refund owed to you') {
    lines.push('I originally paid ' + a.refund_amount + ' for ' + a.refund_item + ' on ' + a.refund_payment_date + '. I am owed a refund because: ' + a.refund_reason);
  } else if (a.issue_type === 'General dispute over obligations or interpretation') {
    lines.push('Clause/obligation in dispute: ' + a.dispute_clause + '. My interpretation versus yours: ' + a.dispute_interpretation + '. Impact of this disagreement: ' + a.dispute_impact);
  } else if (a.issue_type === 'Final notice before small claims') {
    if (a.finalnotice_prior_demand === 'Yes — specify date') {
      lines.push('I previously sent a demand on ' + a.finalnotice_prior_demand_date + '.');
    } else {
      lines.push('No prior demand has been sent before this one.');
    }
    lines.push('Response received, if any: ' + a.finalnotice_response_received);
    lines.push('Amount being claimed: ' + a.finalnotice_amount_claimed);
    if (hasValue(a.finalnotice_jurisdiction)) {
      lines.push('Court/jurisdiction I intend to file in, if known: ' + a.finalnotice_jurisdiction);
    }
    lines.push('This is a final opportunity to resolve this matter before a small claims filing is made.');
  }
  lines.push('');
  lines.push('Supporting evidence is attached separately where applicable.');
  lines.push('');
  let outcome;
  if (a.desired_outcome === 'Partial payment — specify amount') {
    outcome = 'a partial payment of ' + a.desired_outcome_amount;
  } else if (a.desired_outcome === 'Other — free text') {
    outcome = a.desired_outcome_other;
  } else {
    outcome = a.desired_outcome;
  }
  lines.push('Desired outcome: ' + outcome + '.');
  lines.push('');
  const responseWindow = a.issue_type === 'Final notice before small claims' ? '7 days' : '14 days';
  lines.push('Please respond within ' + responseWindow + '.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.your_name);
  return lines.join('\n');
}

function renderContractAmendmentCounteroffer(a) {
  const lines = [];
  lines.push('CONTRACT AMENDMENT / COUNTEROFFER');
  lines.push('');
  lines.push('Contract: ' + a.contract_reference);
  lines.push('Between: ' + a.your_name + ' and ' + a.other_party_name);
  lines.push('Clause(s) addressed: ' + a.clause_reference);
  lines.push('');
  if (a.amendment_type === 'Propose a change — counteroffer') {
    lines.push('Current wording: ' + a.current_wording);
    lines.push('Proposed new wording: ' + a.proposed_wording);
    lines.push('Reason for the change: ' + a.change_reason);
    if (hasValue(a.response_deadline)) {
      lines.push('Response requested by: ' + a.response_deadline);
    }
  } else if (a.amendment_type === 'Document a change already agreed') {
    lines.push('The original wording — ' + a.original_wording + ' — is replaced with the following agreed wording as of ' + a.agreement_date + ': ' + a.new_agreed_wording);
    lines.push('All other terms and conditions of the original contract remain unchanged and in full force.');
  }
  lines.push('');
  lines.push('Signatures:');
  lines.push('');
  lines.push(a.your_name + ': _______________________  Date: __________');
  lines.push('');
  lines.push(a.other_party_name + ': _______________________  Date: __________');
  return lines.join('\n');
}

function renderContractTerminationRenewalNotice(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.other_party_name);
  lines.push('Re: Notice Regarding Contract ' + a.contract_reference + ' — Effective ' + a.effective_date);
  lines.push('');
  if (a.notice_type === 'Terminating the contract now') {
    lines.push('This is formal notice that I am terminating this contract, effective ' + a.effective_date + '.');
    const reason = a.termination_reason === 'Other — free text' ? a.termination_reason_other : a.termination_reason;
    lines.push('Reason: ' + reason + '.');
    if (hasValue(a.termination_clause)) {
      lines.push('Termination clause relied on: ' + a.termination_clause + '.');
    }
    if (hasValue(a.outstanding_obligations)) {
      lines.push('Outstanding obligations to settle: ' + a.outstanding_obligations);
    }
  } else if (a.notice_type === 'Declining to renew at term end') {
    lines.push('This is formal notice that I will not be renewing this contract. The contract will end on ' + a.contract_end_date + ', per the required notice period of ' + a.required_notice_period + '.');
    if (hasValue(a.nonrenewal_reason)) {
      lines.push('Reason: ' + a.nonrenewal_reason);
    }
  } else if (a.notice_type === 'Confirming renewal') {
    lines.push('This confirms renewal of this contract for a new term of ' + a.new_term_length + '.');
    if (hasValue(a.renewal_changes)) {
      lines.push('Changes to terms being confirmed alongside this renewal: ' + a.renewal_changes);
    }
  }
  lines.push('');
  lines.push('Please contact me with any questions.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.your_name);
  return lines.join('\n');
}

function renderServiceAgreement(a) {
  const lines = [];
  lines.push('SERVICE AGREEMENT');
  lines.push('');
  lines.push('Between ' + a.provider_name + ' (Provider) and ' + a.client_name + ' (Client)');
  lines.push('');
  lines.push('1. Services');
  lines.push(a.service_description);
  lines.push('');
  lines.push('2. Price & Payment');
  lines.push(a.price_and_payment);
  lines.push('');
  lines.push('3. Term');
  lines.push('Starting ' + a.start_date + ' for ' + a.duration + '.');
  lines.push('');
  lines.push('4. Termination');
  lines.push(a.termination_terms + '.');
  if (a.termination_terms === 'Either party with notice — specify days') {
    lines.push('Notice period: ' + a.termination_notice_days + ' days.');
  }
  lines.push('');
  lines.push('5. Confidentiality');
  if (a.confidentiality_needed === 'Yes') {
    lines.push('Both parties agree to keep confidential information disclosed under this agreement confidential.');
  } else if (a.confidentiality_needed === 'No') {
    lines.push('No confidentiality clause applies to this agreement.');
  }
  lines.push('');
  lines.push('6. Liability');
  if (a.liability_needed === 'Yes') {
    const cap = hasValue(a.liability_cap) ? a.liability_cap : 'a reasonable limitation to be agreed by both parties';
    lines.push("Provider's liability under this agreement is limited to " + cap + '.');
  } else if (a.liability_needed === 'No') {
    lines.push('No liability limitation clause applies to this agreement.');
  }
  lines.push('');
  lines.push('7. Independent Contractor Status');
  lines.push('Provider is an independent contractor and not an employee of Client.');
  lines.push('');
  lines.push('8. Governing Law');
  lines.push('This agreement is governed by the laws of ' + a.jurisdiction + '.');
  lines.push('');
  lines.push('9. Signatures');
  lines.push('');
  lines.push(a.provider_name + ': _______________________  Date: __________');
  lines.push('');
  lines.push(a.client_name + ': _______________________  Date: __________');
  lines.push('');
  lines.push('---');
  lines.push('This is a starting template and should be reviewed by a qualified attorney before use, particularly for higher-value or more complex engagements.');
  return lines.join('\n');
}

function renderEuGdprViolationReport(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: [National Data Protection Authority]');
  lines.push('Re: GDPR Violation Report — ' + a.organisation_name);
  lines.push('');
  lines.push('I am submitting this report regarding ' + a.organisation_name + '.');
  lines.push('');
  lines.push('Reporting as: ' + a.reporter_role + '.');
  if (a.reporter_role === 'Employee/contractor (internal whistleblower)') {
    lines.push('As an employee/contractor reporting this, I understand I am protected against retaliation under the EU Whistleblower Directive (2019/1937).');
  }
  lines.push('');
  lines.push('What I observed: ' + a.violation_type + '.');
  lines.push('');
  lines.push(a.details);
  lines.push('');
  if (a.violation_type === 'Data breach not reported to the DPA within 72 hours') {
    lines.push('I understand organisations have a 72-hour breach notification duty under Article 33 of the GDPR.');
    lines.push('');
  }
  lines.push('Anonymity preference: ' + a.anonymity_preference + '.');
  if (a.anonymity_preference === 'Anonymous') {
    lines.push('I understand that submitting this anonymously may limit your ability to follow up with clarifying questions.');
  }
  lines.push('');
  lines.push('I am gathering evidence within lawful means only.');
  return lines.join('\n');
}

function renderPrivacyBreachComplianceComplaint(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.company_name);
  lines.push('Re: Complaint — ' + a.complaint_type);
  lines.push('');
  if (hasValue(a.account_identifier)) {
    lines.push('Account/reference: ' + a.account_identifier + '.');
    lines.push('');
  }
  lines.push('Complaint type: ' + a.complaint_type + '.');
  lines.push('');
  if (a.complaint_type === 'Data breach — my personal data was exposed in a security incident') {
    if (hasValue(a.breach_notification_date)) {
      lines.push('I was notified of this breach on ' + a.breach_notification_date + '.');
    } else {
      lines.push('I became aware of this breach independently.');
    }
    lines.push('Data affected, as far as I know: ' + a.data_affected);
    lines.push('I am requesting a clear explanation of what happened, what data was affected, and what steps are being taken to prevent recurrence.');
  } else if (a.complaint_type === 'Cookies/tracking used without valid consent') {
    lines.push('On ' + a.website_or_app + ', I experienced the following issue with cookie/tracking consent: ' + a.consent_issue);
    lines.push('This appears inconsistent with applicable data protection and e-privacy requirements for valid consent.');
  }
  lines.push('');
  lines.push('Desired outcome: ' + a.desired_outcome + '.');
  lines.push('');
  lines.push('I am requesting a substantive written response within 20 business days. This letter is being sent as the required first step before escalating to the relevant data protection authority, which I will do if the response is inadequate or absent.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderAuPrivacyComplaintLetter(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.company_name);
  lines.push('Re: Privacy Complaint');
  lines.push('');
  lines.push('This letter is being sent before lodging a complaint with the OAIC, as required by law, giving you approximately 30 days to respond.');
  lines.push('');
  lines.push('Issue: ' + a.issue + '.');
  lines.push('');
  const app = a.app_breached === 'Not sure - describe the issue instead' ? 'not sure which APP applies' : a.app_breached;
  lines.push('Relevant Australian Privacy Principle: ' + app + '.');
  lines.push('');
  lines.push(a.details);
  lines.push('');
  lines.push("If this is not resolved satisfactorily within 30 days, I intend to escalate to the Office of the Australian Information Commissioner (OAIC). Please note I am not asserting the OAIC's $3 million turnover jurisdiction threshold applies to your company — please confirm this independently if relevant.");
  lines.push('');
  lines.push('Remedy sought: ' + a.remedy + '.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderPrivacyRegulatorComplaint(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  let to = '';
  let note = '';
  if (a.jurisdiction === 'United States') {
    to = 'Federal Trade Commission (FTC)';
  } else if (a.jurisdiction === 'United Kingdom') {
    to = "Information Commissioner's Office (ICO)";
  } else if (a.jurisdiction === 'Australia') {
    to = 'Office of the Australian Information Commissioner (OAIC)';
  } else if (a.jurisdiction === 'European Union') {
    if (a.eu_country === 'Spain') {
      to = 'Agencia Española de Protección de Datos (AEPD)';
    } else if (a.eu_country === 'France') {
      to = "Commission Nationale de l'Informatique et des Libertés (CNIL)";
    } else if (a.eu_country === 'Germany') {
      to = 'Bundesbeauftragte für den Datenschutz (BfDI)';
      note = 'Note: Germany also has state-level (Länder) data protection authorities — confirm the correct one for your region before sending.';
    } else {
      // 'Other EU country', or the 'Not applicable' placeholder left selected
      // by mistake alongside jurisdiction == 'European Union' -- same
      // generic fallback either way, since neither case has a determinate
      // single authority.
      to = 'your national data protection authority';
      note = 'Note: confirm the correct data protection authority for your specific EU member state before sending.';
    }
  }
  lines.push('To: ' + to);
  lines.push('Re: Data Protection Complaint — ' + a.company_name);
  lines.push('');
  if (hasValue(a.prior_contact_date)) {
    lines.push('I first raised this directly with ' + a.company_name + ' on ' + a.prior_contact_date + '. Response received: ' + a.prior_contact_outcome);
  } else {
    lines.push('I have not yet contacted ' + a.company_name + ' directly about this.');
  }
  lines.push('');
  lines.push('Issue: ' + a.issue_summary);
  lines.push('');
  lines.push('I am requesting: ' + a.desired_outcome);
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  if (note) {
    lines.push('');
    lines.push('---');
    lines.push(note);
  }
  return lines.join('\n');
}

function renderPrivacyRightsRequest(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.company_name);
  lines.push('Re: Privacy Rights Request');
  lines.push('');
  // your_relationship and account_identifier share one paragraph (no blank
  // between them when both are present, matching the template) followed by
  // a single trailing blank -- only if at least one of them actually
  // produced a line. Folding the blank into each `if` independently would
  // insert a stray blank *between* the two lines whenever both are
  // provided, which the template doesn't call for.
  const hasRelationship = hasValue(a.your_relationship);
  const hasAccountId = hasValue(a.account_identifier);
  if (hasRelationship) {
    lines.push('My relationship to you: ' + a.your_relationship + '.');
  }
  if (hasAccountId) {
    lines.push('Account/reference: ' + a.account_identifier + '.');
  }
  if (hasRelationship || hasAccountId) {
    lines.push('');
  }
  lines.push('This is a request described as: ' + a.right_type + '.');
  lines.push('');
  if (a.right_type === 'Access — I want to see what data they hold about me') {
    lines.push('I want to see what personal data you hold about me.');
    if (hasValue(a.specific_data_scope)) {
      lines.push('Narrowed to: ' + a.specific_data_scope);
    }
  } else if (a.right_type === 'Deletion/Erasure — I want my data removed') {
    lines.push('I want my personal data deleted/erased.');
    if (hasValue(a.deletion_reason)) {
      lines.push('Reason: ' + a.deletion_reason);
    }
  } else if (a.right_type === 'Correction/Rectification — I want inaccurate data fixed') {
    lines.push('The following data is incorrect: ' + a.incorrect_data + '. It should instead read: ' + a.correct_data);
  } else if (a.right_type === "Objection to AI/ML training use — I don't want my data used to train AI models") {
    lines.push('I object to my personal data being used to train AI or machine learning models.');
    if (hasValue(a.data_type_for_ai)) {
      lines.push('Narrowed to: ' + a.data_type_for_ai);
    }
    lines.push('I am requesting this use stop and any existing training use be remediated where possible.');
  } else if (a.right_type === 'Restriction of processing — I want processing limited while a dispute is resolved') {
    lines.push('I am requesting processing of my data be restricted while the following is resolved: ' + a.restriction_reason);
  }
  lines.push('');
  lines.push('I am requesting written confirmation of the action taken and the date it was completed. I expect a response within the timeframe required by applicable data protection law, and will escalate to the relevant data protection authority if no adequate response is received.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderAdministrativeAppealReviewDecisionResponse(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.agency_name);
  lines.push('Re: Response to Decision ' + a.reference_number + ', dated ' + a.decision_date);
  lines.push('');
  lines.push(a.decision_description);
  lines.push('');
  if (a.response_type === 'Formally appeal the decision') {
    lines.push('I am formally appealing this decision.');
    const grounds = a.appeal_grounds === 'Other — free text' ? a.appeal_grounds_other : a.appeal_grounds;
    lines.push('Grounds: ' + grounds + '.');
    lines.push(a.appeal_explanation);
    lines.push('Outcome sought: ' + a.appeal_outcome);
  } else if (a.response_type === 'Request an extension or payment plan') {
    lines.push('I am requesting an extension/payment plan for: ' + a.extension_subject + '.');
    lines.push('Proposed new terms: ' + a.proposed_terms);
    lines.push('Reason: ' + a.extension_reason);
  } else if (a.response_type === 'Accept the decision but request clarification') {
    lines.push('I accept this decision, but request clarification on: ' + a.clarification_needed);
    lines.push('Reason clarification is needed: ' + a.clarification_reason);
  } else if (a.response_type === 'Provide additional information that was requested') {
    lines.push('In response to your request for ' + a.info_requested + ', I am providing the following: ' + a.info_summary);
    lines.push('Attachments are included separately.');
  }
  lines.push('');
  lines.push('Please confirm receipt and respond within a reasonable timeframe. Please confirm the specific appeal process and deadline stated in your own decision letter — this does not invent agency-specific procedures.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.full_name);
  return lines.join('\n');
}

function renderAdministrativeInformationRequest(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.agency_name);
  let re = 'Re: Information Request';
  if (hasValue(a.reference_number)) {
    re += ' — Reference ' + a.reference_number;
  }
  lines.push(re);
  lines.push('');
  lines.push('I am requesting the following: ' + a.information_requested);
  lines.push('');
  if (a.reason === 'Yes — free text') {
    lines.push('Reason (offered voluntarily, not a precondition for this request): ' + a.reason_detail);
    lines.push('');
  }
  if (a.legal_basis === 'Freedom of Information request') {
    lines.push('This is a Freedom of Information request.');
  } else if (a.legal_basis === 'Data/privacy access request') {
    lines.push('This is a data/privacy access request.');
  } else if (a.legal_basis === 'Other') {
    lines.push('Legal basis: ' + a.legal_basis_other);
  } else if (a.legal_basis === 'Not sure' || a.legal_basis === 'General inquiry, no specific legal basis') {
    lines.push('(no specific legal basis stated)');
  }
  lines.push('');
  lines.push('Preferred format/delivery: ' + a.delivery_preference + '.');
  lines.push('');
  lines.push('Please provide a specific response timeframe.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.full_name);
  return lines.join('\n');
}

function renderGovernmentComplaintLetter(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.agency_name);
  let re = 'Re: ' + a.subject;
  if (hasValue(a.reference_number)) {
    re += ' — Reference ' + a.reference_number;
  }
  lines.push(re);
  lines.push('');
  if (a.complaint_stage === 'Initial complaint') {
    lines.push('This issue occurred/was first noticed on ' + a.date_occurred + ': ' + a.issue_description);
    if (a.prior_contact === 'Yes — free text describing what happened') {
      lines.push('Prior contact: ' + a.prior_contact_detail);
    } else {
      lines.push('I have not yet contacted you about this.');
    }
  } else if (a.complaint_stage === 'Escalation of an unresolved complaint') {
    lines.push('I originally complained on ' + a.original_complaint_date + ', reference ' + a.original_reference + '.');
    lines.push('Response received: ' + a.response_summary);
    lines.push('This was unsatisfactory because: ' + a.unsatisfactory_reason);
    if (a.escalation_body === 'Ombudsman' || a.escalation_body === 'Inspector General') {
      lines.push('I am copying/referencing the ' + a.escalation_body + ' on this escalation.');
    } else if (a.escalation_body === 'Other — free text') {
      lines.push('I am copying/referencing ' + a.escalation_body_other + ' on this escalation.');
    }
  }
  lines.push('');
  lines.push('Desired outcome: ' + a.desired_outcome + '.');
  lines.push('');
  const respondWindow = a.complaint_stage === 'Escalation of an unresolved complaint' ? '10 days' : '14 days';
  lines.push('Please respond within ' + respondWindow + '.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.full_name);
  return lines.join('\n');
}

// ---- Static render functions (Batch 3 rollout: Shipping & E-commerce,
// Shopping & E-Commerce, Subscriptions & Services, Training & Education,
// 2026-09-17 -- final batch, completes all 88 generators) ----
// Ported 1:1 from the approved literal templates in
// _drafts-pending/generators-static-migration/batch-6.md.

function renderChargebackLetter(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.card_issuer_name);
  lines.push('Re: Formal Chargeback Request — ' + a.transaction_amount + ' on ' + a.transaction_date);
  lines.push('');
  lines.push('I am requesting a formal chargeback/dispute investigation for a transaction of ' + a.transaction_amount + ' on ' + a.transaction_date + ' with ' + a.seller_name + '.');
  lines.push('');
  if (hasValue(a.order_number)) {
    lines.push('Order reference: ' + a.order_number + '.');
    lines.push('');
  }
  lines.push('Reason for dispute: ' + a.dispute_reason);
  lines.push('');
  if (a.prior_contact_attempted === 'Yes') {
    lines.push('I already attempted to resolve this directly with the seller. What happened: ' + a.prior_contact_outcome);
  } else if (a.prior_contact_attempted === 'No') {
    lines.push('I have not yet attempted to resolve this directly with the seller.');
  }
  lines.push('');
  lines.push('Please open a formal dispute investigation for this transaction and confirm the dispute reference number and expected timeline.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderMarketplaceComplaint(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  const to = a.platform === "Another marketplace — I'll name it below" ? a.platform_name : a.platform + ' — Buyer Protection / Resolution Center';
  lines.push('To: ' + to);
  lines.push('Re: Complaint Regarding Seller ' + a.seller_name + ', Order ' + a.order_number);
  lines.push('');
  lines.push('I am submitting a complaint regarding seller ' + a.seller_name + ', order ' + a.order_number + '.');
  lines.push('');
  lines.push('Issue: ' + a.issue_description);
  lines.push('');
  if (a.seller_contacted === 'Yes') {
    lines.push('I have already contacted the seller directly. Their response: ' + a.seller_response);
  } else if (a.seller_contacted === 'No') {
    lines.push('I have not yet contacted the seller directly.');
  }
  lines.push('');
  lines.push('Desired outcome: ' + a.desired_outcome + '.');
  lines.push('');
  lines.push('---');
  lines.push("Note: confirm the exact policy details and deadlines on this platform's own resolution center page before submitting — they vary by platform and aren't restated here.");
  return lines.join('\n');
}

function renderEuPlatformDisputeLetter(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.platform);
  lines.push('Re: Dispute — ' + a.transaction_details);
  lines.push('');
  lines.push('What happened: ' + a.issue);
  // The platform-specific paragraph is optional in one edge case (Booking.com
  // with booking_type left at 'Not applicable' -- the engine can't express
  // a showWhen dependent on platform, so booking_type is always visible).
  // Track whether anything was actually added so we emit exactly one blank
  // line either way, instead of an unconditional blank that would double up
  // when nothing fires.
  let extra = null;
  if (a.platform === 'Amazon (marketplace seller)') {
    extra = "I am invoking my 14-day withdrawal right and/or the 2-year legal guarantee, as applicable, and escalating via Amazon's A-to-z Guarantee. If escalation beyond Amazon is needed, I understand I can reference ECC-Net or my national ADR body — not the discontinued EU ODR platform.";
  } else if (a.platform === 'Booking.com') {
    if (a.booking_type === 'Package/linked booking') {
      extra = "As this is a package/linked booking, I am invoking Directive (EU) 2015/2302's alternative accommodation mandate.";
    } else if (a.booking_type === 'Standalone hotel booking') {
      extra = 'As this is a standalone hotel booking, this is a general breach-of-contract claim against the hotel, not a codified package travel relocation right.';
    }
  } else if (a.platform === 'Airbnb') {
    extra = "I am referencing the Guest Refund Policy. I understand the 72-hour reporting window is Airbnb's own policy, not EU statute, while price/description accuracy is grounded in EU unfair commercial practices law.";
  } else if (a.platform === 'PayPal') {
    extra = "I am referencing Buyer Protection's 180-day dispute window and 20-day negotiation period as PayPal's own program rules, and the CSSF Luxembourg escalation path if internal arbitration is unfair.";
  }
  if (extra) {
    lines.push('');
    lines.push(extra);
  }
  lines.push('');
  lines.push('Remedy sought: ' + a.remedy + '.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderRefundWarrantyClaim(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.seller_name);
  lines.push('Re: Order ' + a.order_number + ' — ' + a.item_name);
  lines.push('');
  lines.push('I am writing regarding ' + a.item_name + ', order ' + a.order_number + ', purchased on ' + a.purchase_date + '.');
  lines.push('');
  lines.push('Claim: ' + a.claim_reason + '.');
  lines.push('');
  if (a.claim_reason === "The item isn't as described, doesn't work as expected, or I'm not satisfied with it") {
    lines.push(a.issue_description);
  } else if (a.claim_reason === 'The item is defective, broke, or stopped working') {
    lines.push(a.defect_description);
    if (hasValue(a.warranty_period_stated)) {
      lines.push('Warranty period stated at purchase: ' + a.warranty_period_stated + '.');
    }
  }
  lines.push('');
  lines.push('Desired outcome: ' + a.desired_outcome + '.');
  lines.push('');
  lines.push('I am requesting a response within 10 business days. If unresolved, I will pursue a card issuer dispute or the relevant consumer protection avenue.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderEuLegalGuaranteeDemand(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.seller_name);
  lines.push('Re: Legal Guarantee Claim — ' + a.product);
  lines.push('');
  lines.push('I am submitting a formal legal guarantee (conformity) demand under Directive (EU) 2019/771 regarding ' + a.product + ', purchased on ' + a.purchase_date + '.');
  lines.push('');
  lines.push('Defect/non-conformity: ' + a.defect);
  lines.push('');
  lines.push('As the seller, you — not the manufacturer — are responsible for this guarantee. If this is within the first year, the burden-of-proof presumption favors me as the consumer.');
  lines.push('');
  lines.push('Remedy sought: ' + a.remedy + '.');
  if (a.remedy === 'Full refund (contract termination)') {
    lines.push('I am aware full refund/termination is only available if repair/replacement has first failed or was refused — please note if this applies to my situation as you understand it.');
  }
  lines.push('');
  lines.push('This guarantee is a minimum of 2 years under EU law, though some member states extend it further.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderAuMajorFailureRefundDemand(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.retailer_name);
  lines.push('Re: Major Failure Refund Demand — ' + a.product);
  lines.push('');
  lines.push('I am asserting that ' + a.product + ', purchased on ' + a.purchase_date + ' for ' + a.price_paid + ', has a fault constituting a major failure under the Australian Consumer Law (ACL) consumer guarantees.');
  lines.push('');
  lines.push('Fault: ' + a.fault);
  lines.push('');
  lines.push('This qualifies as a major failure because: ' + a.failure_test + '.');
  lines.push('');
  lines.push("The ACL does not set a fixed 12-month guarantee period — protection lasts as long as reasonable given the product's price and type. As this is a major failure, I — not you — choose between refund and replacement. This is not a request for goodwill, but an assertion of a statutory right, and you as the retailer (not the manufacturer) are legally responsible.");
  lines.push('');
  lines.push('Remedy sought: ' + a.remedy + '.');
  lines.push('');
  lines.push('I am requesting a response within a reasonable window (commonly 7-14 days).');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderStateAgComplaint(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push("To: [Your State] Attorney General's Consumer Protection Division");
  lines.push('Re: Complaint Against ' + a.business_name);
  lines.push('');
  lines.push('I am filing a complaint against ' + a.business_name + ' for unfair or deceptive business practices.');
  lines.push('');
  lines.push('Issue: ' + a.issue_type + '.');
  lines.push('');
  lines.push(a.details);
  lines.push('');
  lines.push('This complaint references general consumer protection principles — misleading advertising, breach of implied warranty, or unconscionable business practices as applicable — without asserting a specific state statute.');
  lines.push('');
  lines.push('State: ' + a.state + '.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderEuWithdrawalRightLetter(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.seller_name);
  lines.push('Re: Withdrawal Notice — Order ' + a.order_details);
  lines.push('');
  let intro = 'I am exercising my right of withdrawal under Directive 2011/83/EU regarding ' + a.order_details;
  if (hasValue(a.delivery_date)) {
    intro += ', delivered ' + a.delivery_date;
  }
  intro += '.';
  lines.push(intro);
  lines.push('');
  lines.push('No reason is required for this withdrawal.');
  if (hasValue(a.reason)) {
    lines.push('For context: ' + a.reason);
  }
  lines.push('');
  if (a.was_informed === 'No / Not sure') {
    lines.push('I was not clearly informed of my withdrawal right before purchase, or am not sure I was — if confirmed, this extends my withdrawal window by 12 months. Please confirm whether this applies.');
    lines.push('');
  }
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderFccComplaint(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('[FCC Informal Complaint — Consumer Complaint Center]');
  lines.push('Provider: ' + a.provider_name);
  lines.push('Category: ' + a.category);
  lines.push('');
  lines.push(a.details);
  lines.push('');
  lines.push('Prior attempts to resolve directly with the provider: ' + a.prior_attempts + '.');
  lines.push('');
  lines.push('Resolution requested:');
  let resolution = '';
  if (a.category === 'Billing dispute/unauthorized charge') {
    resolution = 'a credit or rate correction';
  } else if (a.category === 'Service quality (outages, slow speeds)') {
    resolution = 'a technician visit or service credit';
  } else if (a.category === 'Availability (promised infrastructure not delivered)') {
    resolution = 'delivery of the promised service or release from any related contract';
  } else if (a.category === 'Contract/cancellation dispute') {
    resolution = 'contract release or resolution of the cancellation dispute';
  }
  lines.push(resolution);
  return lines.join('\n');
}

function renderServiceComplaintEscalation(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.provider_name);
  const re = a.complaint_stage === 'This is my first formal complaint about this issue' ? 'Formal Complaint' : 'Escalation of Unresolved Complaint';
  lines.push('Re: ' + re);
  lines.push('');
  if (hasValue(a.account_id)) {
    lines.push('Account/reference: ' + a.account_id + '.');
    lines.push('');
  }
  lines.push('Issue: ' + a.issue_description);
  if (a.complaint_stage === 'This is my first formal complaint about this issue') {
    const extraLines = [];
    if (hasValue(a.issue_date)) {
      extraLines.push('This arose on: ' + a.issue_date + '.');
    }
    if (hasValue(a.promised_vs_delivered)) {
      extraLines.push('Promised vs. delivered: ' + a.promised_vs_delivered);
    }
    if (extraLines.length) {
      lines.push('');
      extraLines.forEach(function (l) { lines.push(l); });
    }
  } else if (a.complaint_stage === "I already complained and it wasn't resolved") {
    lines.push('');
    if (hasValue(a.original_complaint_date)) {
      let l = 'I first raised this on ' + a.original_complaint_date;
      if (hasValue(a.original_reference)) {
        l += ', reference ' + a.original_reference;
      }
      l += '.';
      lines.push(l);
    }
    if (hasValue(a.response_received)) {
      lines.push('Response received: ' + a.response_received);
    }
    if (hasValue(a.deadline_given)) {
      lines.push('Deadline previously committed to: ' + a.deadline_given);
    }
    lines.push('This is an escalation of an unresolved complaint — please handle by a manager or complaints team, not front-line support.');
  }
  lines.push('');
  lines.push('Desired outcome: ' + a.desired_outcome + '.');
  lines.push('');
  lines.push('Please respond within 10 business days. If unresolved, I will escalate to an ombudsman, regulator, or small claims court as appropriate.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderSubscriptionServiceBillingDispute(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.provider_name);
  lines.push('Re: Billing Dispute — ' + a.charge_amount + ' on ' + a.charge_date);
  lines.push('');
  if (hasValue(a.account_id)) {
    lines.push('Account/reference: ' + a.account_id + '.');
    lines.push('');
  }
  lines.push('I am disputing a charge of ' + a.charge_amount + ' on ' + a.charge_date + '.');
  lines.push('');
  lines.push('Dispute: ' + a.dispute_type + '.');
  lines.push('');
  if (a.dispute_type === 'Charged after I had already cancelled') {
    let l = 'I cancelled on ' + a.cancellation_date;
    if (hasValue(a.cancellation_confirmation)) {
      l += ', confirmation ' + a.cancellation_confirmation;
    }
    l += '. This charge should not have occurred.';
    lines.push(l);
  } else if (a.dispute_type === 'Price increased without proper notice') {
    lines.push('The price was previously ' + a.previous_price + ', increased to ' + a.new_price + '.');
    lines.push('Advance notice received: ' + a.notice_received + '.');
  } else if (a.dispute_type === 'Duplicate, incorrect, or unauthorized charge') {
    lines.push('Expected amount: ' + a.expected_amount + '. ' + a.issue_description);
  } else if (a.dispute_type === "Charged for a renewal I didn't want or wasn't clearly warned about") {
    lines.push('Renewal notice received: ' + a.renewal_notice_received + '.');
    if (hasValue(a.signup_date)) {
      lines.push('Original signup date: ' + a.signup_date + '.');
    }
  }
  lines.push('');
  lines.push('Desired outcome: ' + a.desired_outcome + '.');
  lines.push('');
  lines.push('I am requesting a response within 10 business days. If unresolved, I will dispute this charge directly with my card issuer or the relevant regulator.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderEuSubscriptionCancellationDemand(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.company_name);
  lines.push('Re: Subscription Cancellation/Refund');
  lines.push('');
  lines.push('Situation: ' + a.scenario + '.');
  lines.push('');
  lines.push('Sign-up date: ' + a.signup_date + '.');
  lines.push('');
  lines.push(a.details);
  lines.push('');
  if (a.scenario === 'Still within my 14-day withdrawal window') {
    lines.push("I am invoking Directive (EU) 2023/2673's withdrawal right and requesting a pro-rata refund.");
  } else if (a.scenario === 'Trying to cancel an ongoing subscription (past 14 days)') {
    lines.push('I am requesting cancellation citing your own terms. If a national cancellation-button law applies in my country (' + a.country + ') — such as in Germany or France — I am also citing that.');
  } else if (a.scenario === "Charged for a renewal I wasn't properly notified about") {
    lines.push("I am invoking my national consumer protection law's requirement for pre-contractual transparency regarding renewal notice, which is not yet uniform EU-wide law but commonly requires 15-30 days' notice where a national law exists.");
  }
  lines.push('');
  lines.push('Remedy sought: ' + a.remedy + '.');
  if (a.remedy === "Revoke my payment mandate if the company won't stop billing") {
    lines.push('If billing continues, I am exercising my right under PSD2 to revoke this payment mandate via my own bank.');
  }
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderAuTioCancellationDemand(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.provider_name);
  lines.push('Re: Contract Cancellation Request');
  lines.push('');
  lines.push('Issue: ' + a.issue + '.');
  lines.push('');
  if (hasValue(a.cancellation_request_date)) {
    lines.push('I first requested cancellation on ' + a.cancellation_request_date + '.');
    lines.push('');
  }
  lines.push(a.details);
  lines.push('');
  lines.push("I am requesting contract cancellation without an early termination fee. A provider failing to deliver promised service quality, or unilaterally changing contract terms, is generally considered a breach on the provider's side.");
  lines.push('');
  lines.push('If this isn\'t resolved directly, I intend to lodge a complaint with the Telecommunications Industry Ombudsman (TIO), which gives providers a short window (commonly around 10 business days) to resolve complaints once referred, along with costs associated with TIO involvement.');
  lines.push('');
  lines.push('Remedy sought: ' + a.remedy + '.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderFormalComplaintGenerator(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.provider_name);
  lines.push('Re: Formal Complaint — ' + a.course_name);
  lines.push('');
  lines.push('I am writing regarding ' + a.course_name + ', enrolled/purchased on ' + a.enrollment_date + ' for ' + a.amount_paid + '.');
  lines.push('');
  lines.push('Problem: ' + a.problem_type + '.');
  lines.push('');
  lines.push(a.problem_details);
  lines.push('');
  if (a.problem_type === 'Institution/academy closed (school or academy shut down mid-course)') {
    lines.push('I am focusing this complaint on the closure date and any alternative arrangement offered.');
  } else if (a.problem_type === "Provider won't refund (refund requested and refused or ignored)") {
    lines.push('I am focusing this complaint on the original refund policy and your stated reason for refusing.');
  } else if (a.problem_type === 'Misleading advertising (course/outcomes misrepresented before purchase)') {
    lines.push('I am focusing this complaint on the specific claims made versus what was actually delivered.');
  } else if (a.problem_type === 'Fake or invalid certificate (certificate not recognized, accredited, or as described)') {
    lines.push('I am focusing this complaint on what was promised about accreditation/recognition versus what was actually true.');
  } else if (a.problem_type === 'Bootcamp-specific issues (job guarantee not honored, curriculum materially different, cohort cancelled/merged without consent)') {
    lines.push('I am focusing this complaint on the specific broken promise — job guarantee, curriculum, or cohort change.');
  } else if (a.problem_type === 'Online platform issues (course removed/inaccessible, promised lifetime access revoked, technical failure preventing completion)') {
    lines.push('I am focusing this complaint on the access that was promised versus what actually happened.');
  } else if (a.problem_type === 'Linked credit/financing issues (course was sold bundled with a loan or installment credit product)') {
    lines.push('I am noting that a linked or connected credit agreement can, in many jurisdictions, be legally challenged if the underlying course was cancelled, misrepresented, or not delivered — worth raising with the credit provider and checking against local consumer credit law, though this varies significantly by country and credit type.');
  }
  lines.push('');
  lines.push('I am referencing general consumer protection principles without claiming jurisdiction-specific legal advice, and may escalate to a relevant regulator or ombudsman if this is not resolved within a reasonable timeframe.');
  lines.push('');
  const outcome = a.desired_outcome === 'Other (describe it in the details field above)' ? 'see details above' : a.desired_outcome;
  lines.push('Desired outcome: ' + outcome + '.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.your_name);
  return lines.join('\n');
}

// ---- Static render functions (Batch 4 rollout: Employment + Subscriptions
// & Services, 2026-09-18) ----
// Ported 1:1 from the approved literal templates in
// _drafts-pending/generators-static-migration/batch-1.md (Employment) and
// static-generators-phase1-sample.md (subscription-service-cancellation).

function renderConstructiveDismissalComplaint(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.employer_name);
  const re = a.country === 'United States' ? 'Constructive Discharge' : 'Constructive Dismissal — Formal Notice';
  lines.push('Re: ' + re);
  lines.push('');
  const ground = a.country === 'United States' ? 'constructive discharge' : 'constructive dismissal';
  lines.push('I am writing to formally document my resignation from ' + a.employer_name + ', effective ' + a.resignation_date + ', on the grounds of ' + ground + '.');
  lines.push('');
  lines.push(a.conduct_description);
  lines.push('');
  if (a.pattern_or_incident === 'Pattern of incidents over time') {
    lines.push('This reflects a pattern of conduct over time, not a single isolated incident, as set out above in chronological order.');
  } else if (a.pattern_or_incident === 'Single serious incident') {
    lines.push('This reflects a single, sufficiently serious incident that left me with no reasonable alternative but to resign.');
  }
  lines.push('');
  if (a.prior_complaints === 'Yes, formally in writing') {
    lines.push('I raised these concerns with ' + a.employer_name + ' formally, in writing, before resigning.');
  } else if (a.prior_complaints === 'Yes, verbally only') {
    lines.push('I raised these concerns with ' + a.employer_name + ' verbally before resigning.');
  } else if (a.prior_complaints === 'No, I resigned without raising it first') {
    lines.push('I did not raise these concerns with ' + a.employer_name + ' before resigning.');
  }
  lines.push('');
  lines.push('I consider this resignation to have been caused directly by the conduct described above, leaving me no reasonable alternative but to resign.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  const notes = [];
  if (a.country === 'United Kingdom') {
    notes.push('Note: UK unfair dismissal claims generally require at least two years of continuous employment — confirm this applies to your situation before proceeding.');
  }
  if (a.prior_complaints === 'No, I resigned without raising it first') {
    notes.push('Note: Not having raised this before resigning may weaken a constructive dismissal claim in many jurisdictions, since employers are typically expected to have had a chance to address the conduct, or you should be able to show why doing so was clearly futile. Consider getting this reviewed before relying on it.');
  }
  if (notes.length) {
    lines.push('');
    lines.push('---');
    notes.forEach(function (n) { lines.push(n); });
  }
  return lines.join('\n');
}

function renderDolWageComplaint(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('Re: Wage Complaint — ' + a.employer_name);
  lines.push("[For submission to the US Department of Labor's Wage and Hour Division (WHD)]");
  lines.push('');
  lines.push('I am filing this wage complaint against ' + a.employer_name + ' under the Fair Labor Standards Act (FLSA).');
  lines.push('');
  lines.push('Issue: ' + a.issue_type + '. ' + a.discrepancy);
  lines.push('');
  lines.push('FLSA claims generally have a 2-year recovery window (3 years if the violation is willful).');
  lines.push('');
  if (a.retaliation === 'Yes') {
    lines.push('My employer has retaliated against me for raising this issue. Retaliation for raising a wage complaint is independently illegal under FLSA Section 15(a)(3), and I am reporting this as well.');
    lines.push('');
  }
  lines.push('I am requesting this matter be investigated.');
  lines.push('');
  lines.push('[Your name]');
  lines.push('[Your contact information]');
  return lines.join('\n');
}

function renderEmploymentDataAccessRequest(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.organisation_name);
  let re = '';
  if (a.request_type === 'Access to all personal data held (Subject Access Request)') {
    re = 'Subject Access Request';
  } else if (a.request_type === 'Deletion of my CV/application data' || a.request_type === 'Deletion of my full employee record after leaving') {
    re = 'Data Deletion Request';
  } else if (a.request_type === 'Complaint: my CV/data was shared without authorization') {
    re = 'Data Sharing Complaint';
  }
  lines.push('Re: ' + re);
  lines.push('');
  lines.push('Relationship to organisation: ' + a.relationship + '.');
  lines.push('');
  lines.push('I am writing regarding ' + a.organisation_name + ' about the following: ' + a.request_type + '.');
  lines.push('');
  lines.push(a.details);
  lines.push('');
  if (a.country === 'European Union' || a.country === 'United Kingdom') {
    lines.push('This request is made under GDPR/UK GDPR — Article 15 for access, Article 17 for erasure. I expect a response within one month, extendable to three months for complex requests with proper notice.');
  } else if (a.country === 'United States') {
    lines.push('I am making this as a general privacy request under any applicable state privacy law.');
  } else if (a.country === 'Australia') {
    lines.push('This request is made with reference to the Privacy Act 1988 and the Australian Privacy Principles.');
  } else if (a.country === 'Other/not sure') {
    lines.push('I am making this as a general data privacy request and ask you to apply whatever data protection law governs your handling of my information.');
  }
  if (a.request_type === 'Complaint: my CV/data was shared without authorization') {
    lines.push('');
    lines.push('I am requesting confirmation of who my data was shared with and why.');
  }
  if (a.relationship === 'Former employee' && (a.request_type === 'Deletion of my CV/application data' || a.request_type === 'Deletion of my full employee record after leaving')) {
    lines.push('');
    lines.push('I understand you may have independent legal retention obligations (e.g. tax, employment records) that could limit full deletion — please confirm what, if anything, can and cannot be deleted.');
  }
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderEmploymentReferenceRequest(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.former_employer);
  lines.push('Re: Request for Employment Reference — ' + a.job_title);
  lines.push('');
  lines.push('I am writing to request an employment reference regarding my time in the role of ' + a.job_title + '.');
  lines.push('');
  if (a.refusal_context === 'Employer has ignored requests entirely') {
    lines.push('I have reached out previously about this and have not received a response.');
  } else if (a.refusal_context === 'Employer explicitly refused to provide a reference') {
    lines.push('I understand a reference was previously declined. I would appreciate reconsidering this, or clarifying what, if anything, you are able to provide.');
  } else if (a.refusal_context === 'Employer only offers to confirm dates of employment, nothing more') {
    lines.push("I understand you are able to confirm my dates of employment. I would be grateful if you're able to provide anything further, but a confirmation of dates and job title would still be helpful in the meantime.");
  }
  if (hasValue(a.urgency)) {
    lines.push('');
    lines.push(a.urgency);
  }
  lines.push('');
  lines.push('I understand that in most jurisdictions, employers are not legally required to provide anything beyond confirming dates of employment and job title, unless a specific contractual obligation applies, and I appreciate this is a request rather than a legal entitlement.');
  lines.push('');
  lines.push('Thank you for your time.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderFlexibleWorkingRequest(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.employer_name);
  lines.push('Re: Flexible Working Request');
  lines.push('');
  lines.push('I am writing to formally request: ' + a.request_type + '.');
  lines.push('');
  if (hasValue(a.reason)) {
    lines.push('Reason for this request: ' + a.reason);
    lines.push('');
  }
  lines.push('My specific proposed arrangement: ' + a.proposed_arrangement + '. I would welcome the opportunity to discuss a trial period.');
  lines.push('');
  if (a.country === 'United Kingdom') {
    lines.push('I understand UK employees generally have a statutory right to REQUEST flexible working from day one of employment, though you may still decline for specified business reasons — this is a right to make the request and receive a considered response, not an automatic entitlement to the arrangement itself.');
  } else if (a.country === 'Australia') {
    lines.push('I understand certain eligible employees have a right under the National Employment Standards to request flexible working arrangements, with similar limits.');
  } else if (a.country === 'United States') {
    lines.push('I understand there is no general federal right to request flexible working — I am making this as a workplace request, not asserting a legal entitlement.');
  } else if (a.country === 'European Union country' || a.country === 'Other/not sure') {
    lines.push('I ask that you consider this request in line with whatever employment law applies in our jurisdiction.');
  }
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderUnpaidWageCompensationDemand(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.employer_name);
  lines.push('Re: Formal Demand for Unpaid Wages');
  lines.push('');
  lines.push('I am writing to formally demand payment of ' + a.amount_owed + ' in unpaid wages, covering ' + a.period_covered + '.');
  lines.push('');
  lines.push('Reason: ' + a.reason + '. ' + a.details);
  let reasonNote = null;
  if (a.reason === 'Unpaid trial shift') {
    reasonNote = 'In most jurisdictions, if productive work was performed rather than pure observation/shadowing, wage laws generally require payment regardless of the word "trial" or "unpaid" used in the arrangement.';
  } else if (a.reason === 'Mandatory training time') {
    reasonNote = 'Time an employer requires an employee to spend in training is generally compensable work time under most wage laws, distinct from truly voluntary, non-required training.';
  } else if (a.reason === 'Overtime hours') {
    reasonNote = 'I am requesting the specific overtime premium owed for these hours.';
  }
  if (reasonNote) {
    lines.push('');
    lines.push(reasonNote);
  }
  let priorNote = null;
  if (a.prior_contact === 'Yes, verbally, no response') {
    priorNote = 'I previously raised this verbally and received no response.';
  } else if (a.prior_contact === 'Yes, in writing, no response or refused') {
    priorNote = 'I previously raised this in writing and received no response, or it was refused.';
  }
  if (priorNote) {
    lines.push('');
    lines.push(priorNote);
  }
  lines.push('');
  lines.push('I am requesting payment within a reasonable timeframe from the date of this letter.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderWorkplaceHarassmentComplaint(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: HR, ' + a.company_name);
  lines.push('Re: Formal Harassment Complaint');
  lines.push('');
  lines.push('I am filing a formal complaint.');
  lines.push('');
  lines.push('Person involved: ' + a.harasser_role + '.');
  lines.push('Nature of the conduct: ' + a.harassment_type + '.');
  lines.push('');
  lines.push(a.incident_details);
  if (hasValue(a.witnesses)) {
    lines.push('');
    lines.push('Witnesses: ' + a.witnesses + '.');
  }
  let typeNote = null;
  if (a.harassment_type === 'Discriminatory harassment (based on a protected characteristic)') {
    typeNote = 'I am framing this complaint around the relevant protected characteristic to preserve any applicable anti-discrimination legal protections.';
  } else if (a.harassment_type === 'Retaliation after a prior complaint') {
    typeNote = 'I consider this retaliation to be a distinct and serious issue in its own right, separate from my original complaint, since retaliation protections generally exist independently.';
  }
  if (typeNote) {
    lines.push('');
    lines.push(typeNote);
  }
  let reportNote = null;
  if (a.prior_reports === 'Yes, informally, nothing happened') {
    reportNote = 'I previously reported this informally and nothing was done.';
  } else if (a.prior_reports === 'Yes, formally, nothing happened') {
    reportNote = 'I previously reported this formally and nothing was done. Continued inaction may itself be a separate issue.';
  }
  if (reportNote) {
    lines.push('');
    lines.push(reportNote);
  }
  lines.push('');
  lines.push('I am requesting a specific, timely response — within 5-10 business days — and a description of the investigation process. I am keeping a copy of this letter and any response.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderWrongfulWageDeductionLetter(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.employer_name);
  lines.push('Re: Disputed Wage Deduction');
  lines.push('');
  lines.push('I am writing to dispute a wage deduction of ' + a.amount_deducted + ' for: ' + a.deduction_reason + '. ' + a.details);
  lines.push('');
  lines.push('In most jurisdictions, deductions from wages generally require the employee\'s prior written consent and/or specific legal authorization, and blanket "shortage" or "damage" deductions taken without due process are frequently unlawful.');
  lines.push('');
  if (a.consent_given === 'No') {
    lines.push('I did not authorize this deduction.');
  } else if (a.consent_given === "Yes, but I didn't understand what I was signing") {
    lines.push('I do not believe I gave valid, informed authorization for this deduction.');
  } else if (a.consent_given === 'Not sure') {
    lines.push('I am not aware of having authorized this deduction.');
  }
  lines.push('');
  lines.push('I am requesting full repayment of the deducted amount within 14 days, and reserve the right to escalate this to the relevant labor authority if unresolved.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderSubscriptionServiceCancellation(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.provider_name);
  let re = 'Re: Cancellation Notice';
  if (hasValue(a.account_id)) {
    re += ' — Account ' + a.account_id;
  }
  lines.push(re);
  lines.push('');
  lines.push('I am writing to formally cancel:');
  lines.push('');
  if (a.cancellation_type === 'Cancelling an ongoing subscription or recurring service') {
    lines.push('my ongoing subscription, which began on ' + a.signup_date + ' and bills ' + a.billing_frequency + '.');
  } else if (a.cancellation_type === 'Cancelling a free trial before it converts to paid') {
    let l = 'my free trial before it converts to a paid subscription. I understand the trial is set to convert on ' + a.trial_end_date;
    if (hasValue(a.promo_price_seen)) {
      l += ', at the price advertised to me of ' + a.promo_price_seen;
    }
    l += '.';
    lines.push(l);
  } else if (a.cancellation_type === 'Terminating a fixed-term service contract') {
    lines.push('my fixed-term contract, which runs through ' + a.contract_end_date + '.');
    if (hasValue(a.early_termination_reason)) {
      lines.push('My reason for terminating early: ' + a.early_termination_reason + '.');
    }
  }
  lines.push('');
  lines.push('Please treat ' + a.cancellation_date_requested + ' as the effective cancellation date, and confirm this date in writing.');
  if (a.also_request_refund === 'Yes') {
    lines.push('');
    lines.push('I am also formally requesting a refund of ' + a.refund_amount + '.');
    lines.push(a.refund_reason);
  }
  lines.push('');
  lines.push('Please ensure no further charges are made to this account after the effective cancellation date above. Any charge made after that date will be disputed directly with my payment provider.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

// ---- Static render functions (Batch 5 rollout: Housing & Rentals + Home
// Renovations & Services + Legal & Contracts, 2026-09-18) ----
// Ported 1:1 from the approved literal templates in
// _drafts-pending/generators-static-migration/batch-4.md (Housing/Home
// Renovations) and static-generators-phase1-sample.md (landlord-deposit-
// demand-letter, scope-of-work-generator, terms-conditions-generator).

function renderContractorDisputeDemandLetterGenerator(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.contractor_name);
  lines.push('Re: Formal Demand — Contract dated ' + a.contract_date + ', ' + a.property_address);
  lines.push('');
  lines.push('I am writing regarding our contract dated ' + a.contract_date + ' for work at ' + a.property_address + ', total contract price ' + a.contract_price + '.');
  lines.push('');
  lines.push('Issue: ' + a.issue_type + '.');
  lines.push('');
  if (a.issue_type === 'Incomplete work') {
    lines.push('Approximately ' + a.incomplete_pct_complete + '% of the contracted work is complete. Work not yet done: ' + a.incomplete_work_remaining + '. You stopped or left the site on ' + a.incomplete_stop_date + '.');
  } else if (a.issue_type === 'Defective work') {
    lines.push('Defect: ' + a.defect_description + ', located at ' + a.defect_location + ', first noticed on ' + a.defect_noticed_date + '.');
    if (hasValue(a.defect_repair_cost)) {
      lines.push('Estimated repair cost: ' + a.defect_repair_cost + '.');
    }
  } else if (a.issue_type === 'Unauthorized overcharge') {
    const reason = a.overcharge_reason === 'Other' ? a.overcharge_reason_other : a.overcharge_reason;
    lines.push('Disputed amount: ' + a.overcharge_amount + '. Reason this is unauthorized: ' + reason + '.');
  } else if (a.issue_type === 'Project delay') {
    lines.push('Original agreed completion date: ' + a.delay_original_date + '. Current status: ' + a.delay_current_status + '.');
    if (hasValue(a.delay_reason_given)) {
      lines.push('Reason given for the delay: ' + a.delay_reason_given);
    }
  }
  lines.push('');
  let outcome;
  if (a.desired_outcome === 'Partial refund — specify amount') {
    outcome = 'a partial refund of ' + a.desired_outcome_amount;
  } else if (a.desired_outcome === 'Completion by a specific date — specify date') {
    outcome = 'completion by ' + a.desired_outcome_date;
  } else {
    outcome = a.desired_outcome;
  }
  lines.push('Desired outcome: ' + outcome + '.');
  lines.push('');
  lines.push('Supporting evidence (photos, communications log) is attached separately. Please respond within 14 days.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.homeowner_name);
  return lines.join('\n');
}

function renderIllegalEvictionWarningLetter(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.landlord_full_name);
  lines.push('Re: ' + a.property_address + ' — Formal Notice Regarding Unlawful Self-Help Eviction');
  lines.push('');
  lines.push('On ' + a.incident_date + ', the following occurred: ' + a.incident_description + '.');
  lines.push('');
  lines.push('Self-help eviction — changing locks, removing belongings, shutting off utilities, or otherwise forcing a tenant out without a court-ordered legal process — is not a lawful method of eviction in most jurisdictions. Only a court-ordered, legally compliant process may remove a tenant.');
  lines.push('');
  lines.push('Jurisdiction: ' + a.jurisdiction + '.');
  lines.push('');
  lines.push('I am demanding immediate restoration of access, utilities, and/or belongings as applicable. I am documenting this incident and will pursue all available legal remedies, including contacting local housing authorities or law enforcement, if this is not immediately resolved.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.tenant_full_name);
  lines.push('');
  lines.push('---');
  lines.push('Keep a copy of this letter, and consider contacting local police or your housing authority if access is actively being denied.');
  return lines.join('\n');
}

function renderLeaseClauseChallengeLetter(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.landlord_full_name);
  lines.push('Re: ' + a.property_address + ' — Lease Clause Concern');
  lines.push('');
  lines.push('I am writing regarding the following clause: ' + a.clause_text_or_summary + '.');
  lines.push('');
  lines.push('Concern: ' + a.clause_concern_type + '.');
  lines.push('');
  if (a.already_signed === 'No') {
    lines.push('I have not yet signed the lease. I am requesting this clause be amended before I do.');
  } else if (a.already_signed === 'Yes') {
    lines.push('I have already signed the lease. I am formally noting that this clause may not be enforceable under applicable tenant protection law in my area, and requesting written confirmation that you will not attempt to enforce it.');
  }
  lines.push('');
  lines.push('Jurisdiction: ' + a.jurisdiction + '.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.tenant_full_name);
  return lines.join('\n');
}

function renderLeaseViolationNoticeGenerator(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.tenant_full_name);
  lines.push('Re: ' + a.property_address_unit + ' — Formal Lease Violation Notice');
  lines.push('');
  lines.push('This is formal notice of a lease violation: ' + a.violation_type + ', identified on ' + a.violation_date_identified + '.');
  lines.push('');
  lines.push(a.violation_description);
  lines.push('');
  lines.push('Under applicable landlord-tenant law, you are given formal notice and an opportunity to cure within the notice/cure period that applies locally — confirm this period before relying on it, as it is not stated here. Failure to cure within that period may result in further legal action, including eviction proceedings, in accordance with local law.');
  lines.push('');
  lines.push('Jurisdiction: ' + a.jurisdiction + '.');
  lines.push('');
  lines.push('This is not legal advice — confirm the exact cure period and notice requirements for your jurisdiction before sending.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.landlord_full_name);
  return lines.join('\n');
}

function renderAuNoticeToRemedyRepairs(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.landlord_name);
  lines.push('Re: Notice to Remedy — ' + a.issue);
  lines.push('');
  lines.push('I am writing regarding the following issue: ' + a.issue + '. ' + a.details);
  lines.push('');
  if (a.is_urgent === 'Yes') {
    lines.push("This is urgent, affecting safety/habitability. I may arrange a qualified tradesperson directly and seek reimbursement if you don't act immediately. Please make contact within 24 hours.");
  } else if (a.is_urgent === 'No') {
    lines.push('I am requesting repair within a reasonable window (commonly 7-14 days, though this varies by state — please confirm the exact period for ' + a.state + ').');
  }
  lines.push('');
  lines.push('I will continue to pay rent in full throughout this process.');
  lines.push('');
  if (a.prior_contact === 'Yes, verbally only') {
    lines.push('I have already raised this verbally.');
  } else if (a.prior_contact === 'Yes, in writing') {
    lines.push('I have already raised this in writing.');
  } else if (a.prior_contact === 'No, this is the first notice') {
    lines.push('This is the first formal notice of this issue.');
  }
  lines.push('');
  lines.push('If this deadline passes, I may apply to my state tenancy tribunal (NCAT/VCAT/QCAT or equivalent) for a repair order and/or compensation.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderRentalScamRefundDemand(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.recipient_name_or_alias);
  lines.push('Re: Formal Demand for Refund');
  lines.push('');
  lines.push('I am demanding the return of ' + a.amount_paid + ', paid via ' + a.payment_method + ' on ' + a.payment_date + ', for a rental that ' + a.scam_description + '.');
  lines.push('');
  lines.push('This was based on false pretenses. I am demanding a full refund within a short, specific period. Failure to respond will result in this matter being reported to ' + a.listing_platform + ', my payment provider, and local law enforcement/consumer protection authorities.');
  lines.push('');
  lines.push('Jurisdiction: ' + a.jurisdiction + '.');
  lines.push('');
  lines.push('---');
  lines.push('Where to report this, based on how you paid:');
  let reportLine = '';
  if (a.payment_method === 'Bank transfer') {
    reportLine = 'Contact your bank about a chargeback/recall.';
  } else if (a.payment_method === 'Payment app') {
    reportLine = 'File a fraud report with the payment app provider.';
  } else if (a.payment_method === 'Gift card') {
    reportLine = "Contact the gift card issuer's fraud line.";
  } else if (a.payment_method === 'Cryptocurrency') {
    reportLine = 'Cryptocurrency payments are generally non-reversible — report to the platform used and local authorities, but recovery is unlikely.';
  } else if (a.payment_method === 'Other') {
    reportLine = 'Contact your payment provider directly to ask about dispute options.';
  }
  lines.push(reportLine);
  lines.push('');
  lines.push('This is factual information, not a guarantee of recovery.');
  return lines.join('\n');
}

function renderRepairRequestFormalNotice(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.landlord_full_name);
  lines.push('Re: ' + a.property_address + ' — Repair Request');
  lines.push('');
  lines.push('I am writing to formally request repair of the following issue, first reported/noticed on ' + a.issue_first_reported_date + ': ' + a.issue_description);
  lines.push('');
  lines.push('Urgency: ' + a.urgency_level + '.');
  if (a.prior_notice_given === 'Yes') {
    lines.push('');
    lines.push('I previously raised this on ' + a.prior_notice_date + ' without adequate resolution.');
  }
  lines.push('');
  lines.push('Landlords are generally expected to address urgent issues promptly — please confirm the specific timeframe that applies in your area.');
  lines.push('');
  lines.push('Jurisdiction: ' + a.jurisdiction + '.');
  lines.push('');
  lines.push('Please provide a specific, reasonable repair date. I am documenting this request in case further action becomes necessary.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.tenant_full_name);
  return lines.join('\n');
}

function renderLandlordDepositDemandLetter(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.landlord_full_name);
  lines.push('Re: ' + a.property_address + ' — Formal Demand Regarding Security Deposit');
  lines.push('');
  lines.push('I am writing regarding the security deposit of ' + a.deposit_amount_paid + ' I paid for the property at ' + a.property_address + ', which I vacated on ' + a.move_out_date + '.');
  lines.push('');
  if (a.scenario === 'Deposit not returned at all') {
    lines.push('As of today, ' + a.days_since_moveout + ' days have passed since I moved out, and I have not received any refund of my deposit, nor any itemized explanation for withholding it.');
    if (hasValue(a.deposit_protection_scheme_name)) {
      lines.push('I understand this deposit was to be protected under ' + a.deposit_protection_scheme_name + ', and I am requesting confirmation of its protection status alongside its return.');
    }
    lines.push('I am formally demanding the full return of my deposit, ' + a.deposit_amount_paid + ', within a reasonable period from the date of this letter.');
  } else if (a.scenario === 'Deposit returned with deductions I dispute') {
    lines.push('I received my deposit back with ' + a.amount_withheld + ' withheld. Your stated reason for this deduction was: ' + a.landlord_stated_reason + '.');
    lines.push('I dispute this deduction. ' + a.tenant_counter_evidence);
    lines.push('I am formally requesting an itemized justification for this deduction, along with the full or partial refund of the disputed amount, within a reasonable period from the date of this letter.');
  }
  lines.push('');
  lines.push('If this is not resolved, I intend to escalate this matter to the deposit protection/tenancy authority or small claims court with jurisdiction where I rented.');
  lines.push('');
  lines.push('Jurisdiction: ' + a.jurisdiction + '.');
  lines.push('');
  lines.push('Please send any refund or written response to my forwarding address below.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.tenant_full_name);
  lines.push(a.tenant_forwarding_address);
  return lines.join('\n');
}

function renderScopeOfWorkGenerator(a) {
  const lines = [];
  lines.push('SCOPE OF WORK');
  lines.push('');
  lines.push('Property: ' + a.project_address);
  lines.push('Homeowner: ' + a.homeowner_name);
  lines.push('Contractor: ' + a.contractor_name);
  lines.push('');
  lines.push('1. Project Overview');
  const projectType = a.project_type === 'Other' ? a.project_type_other : a.project_type;
  lines.push('Project type: ' + projectType);
  lines.push('Start date: ' + a.start_date);
  lines.push('Target completion date: ' + a.completion_date);
  lines.push('');
  lines.push('2. Detailed Scope of Work');
  lines.push(a.work_description);
  lines.push('');
  lines.push('3. Materials & Supplies');
  lines.push(a.materials);
  if (a.materials_responsibility === 'Mixed — specify which items below') {
    lines.push('Responsibility split: ' + a.materials_responsibility_detail);
  } else {
    lines.push('Materials will be supplied by: ' + a.materials_responsibility + '.');
  }
  lines.push('');
  lines.push('4. Permits & Compliance');
  if (a.permit_status === 'Yes') {
    lines.push('This project requires permits. Responsibility for obtaining permits: ' + a.permit_responsibility + '.');
  } else if (a.permit_status === 'No') {
    lines.push('This project does not require permits.');
  } else if (a.permit_status === 'Unsure') {
    lines.push('Permit requirements for this project have not yet been confirmed and should be verified with the local building authority before work begins.');
  }
  lines.push('');
  lines.push('5. Cleanup & Site Responsibility');
  lines.push('Cleanup and debris removal is the responsibility of: ' + a.cleanup_responsibility + '.');
  lines.push('');
  lines.push('6. Exclusions');
  lines.push('The following are explicitly NOT included in this scope of work: ' + a.exclusions);
  lines.push('');
  lines.push('7. Price & Payment Terms');
  lines.push(a.price_and_payment);
  lines.push('');
  lines.push('8. Signatures');
  lines.push('');
  lines.push('Homeowner: _______________________  Date: __________');
  lines.push(a.homeowner_name);
  lines.push('');
  lines.push('Contractor: _______________________  Date: __________');
  lines.push(a.contractor_name);
  return lines.join('\n');
}

function renderTermsConditionsGenerator(a) {
  const lines = [];
  lines.push('TERMS & CONDITIONS — ' + a.business_name);
  lines.push('');
  lines.push('1. Acceptance of Terms');
  lines.push('By using ' + a.business_name + ', you agree to these Terms & Conditions.');
  lines.push('');
  lines.push('2. Description of Service');
  const offeringType = a.offering_type === 'Other — free text' ? a.offering_type_other : a.offering_type;
  lines.push('Type of business: ' + offeringType + '.');
  lines.push('');
  lines.push('3. Accounts');
  if (a.has_accounts === 'Yes') {
    lines.push('Use of this service may require creating a user account. You are responsible for maintaining the confidentiality of your login credentials.');
  } else if (a.has_accounts === 'No') {
    lines.push('This service does not require a user account.');
  }
  lines.push('');
  lines.push('4. Payments');
  if (a.processes_payments === 'Yes') {
    lines.push('Payments are processed directly through ' + a.business_name + '. By making a purchase, you agree to provide accurate payment information.');
  } else if (a.processes_payments === 'No') {
    lines.push(a.business_name + ' does not process payments directly.');
  }
  lines.push('');
  lines.push('5. Returns & Refunds');
  lines.push(a.refund_policy);
  lines.push('');
  lines.push('6. User-Generated Content');
  if (a.has_ugc === 'Yes') {
    lines.push(a.business_name + ' allows user-generated content: ' + a.ugc_description + '. You retain ownership of content you submit, but grant ' + a.business_name + ' a license to display and use it in connection with the service. You are responsible for ensuring your content does not violate applicable law or third-party rights.');
  } else if (a.has_ugc === 'No') {
    lines.push('This service does not involve user-generated content.');
  }
  lines.push('');
  lines.push('7. Age Restrictions');
  if (a.age_restriction === 'None') {
    lines.push('There is no minimum age restriction for using this service beyond what is required by law.');
  } else {
    lines.push('Minimum age to use this service: ' + a.age_restriction + '.');
  }
  lines.push('');
  lines.push('8. Limitation of Liability');
  lines.push(a.business_name + "'s liability arising from your use of the service is limited to the maximum extent permitted under the laws of " + a.jurisdiction + '.');
  lines.push('');
  lines.push('9. Termination of Access');
  lines.push(a.business_name + ' may suspend or terminate your access to the service for violation of these terms.');
  lines.push('');
  lines.push('10. Governing Law');
  lines.push('These terms are governed by the laws of ' + a.jurisdiction + '.');
  lines.push('');
  lines.push('11. Changes to These Terms');
  lines.push(a.business_name + ' may update these terms from time to time. Continued use of the service after changes take effect constitutes acceptance of the revised terms.');
  lines.push('');
  lines.push('12. Contact');
  lines.push('Questions about these terms can be directed to ' + a.contact_email + '.');
  lines.push('');
  lines.push('---');
  lines.push('This is a starting template only and should be reviewed by a qualified attorney before publication, particularly if ' + a.business_name + ' handles sensitive data, regulated products, or operates across multiple jurisdictions.');
  return lines.join('\n');
}

// ---- Static render functions (Batch 6 rollout: Flights & Travel +
// Delivery & Parcels + Healthcare & Medical, 2026-09-19) ----
// Ported 1:1 from the approved literal templates in
// _drafts-pending/generators-static-migration/batch-3.md (Flights &
// Travel / Healthcare & Medical), batch-1.md (courier-complaint-generator,
// customs-fee-dispute-generator), and static-generators-phase1-sample.md
// (eu261-flight-compensation-claim, vendor-compensation-demand-letter).

function renderAuAirlineComplaint(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.airline_name);
  lines.push('Re: Formal Complaint — Flight ' + a.flight_details);
  lines.push('');
  lines.push('I am writing regarding ' + a.flight_details + '.');
  lines.push('');
  lines.push('Issue: ' + a.issue_type + '.');
  lines.push('');
  if (a.issue_type === 'Flight delayed' || a.issue_type === 'Flight cancelled') {
    lines.push('Cause given: ' + a.cause + '.');
    if (a.cause === 'Airline-controlled (crew, maintenance, technical)') {
      lines.push('As this was airline-controlled, I am raising a claim under the Australian Consumer Law for the reasonable expenses caused by this disruption — this is a claim I am making, not a guaranteed automatic entitlement, as Australia has no EU261-style automatic delay compensation scheme.');
    } else if (a.cause === 'Weather/air traffic control') {
      lines.push('I understand the cause given was weather or air traffic control, which may limit any claim under the Australian Consumer Law, but I am still raising the following.');
    } else if (a.cause === 'Not stated by airline') {
      lines.push('No cause was stated for this disruption. I am asking you to confirm the cause and my options under the Australian Consumer Law.');
    }
    lines.push('Expenses: ' + a.expenses);
  } else if (a.issue_type === 'Baggage damaged' || a.issue_type === 'Baggage lost/delayed') {
    lines.push('Property Irregularity Report (PIR) filed: ' + a.pir_filed + '.');
    lines.push("This claim is made with reference to the Civil Aviation (Carriers' Liability) Act 1959's liability framework, which caps liability at a level periodically adjusted — please refer to your own Conditions of Carriage for the exact current cap and claim deadline.");
  }
  lines.push('');
  lines.push('Remedy sought: ' + a.remedy + '.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderEuBaggageClaimMontreal(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.airline_name);
  lines.push('Re: Baggage Claim — Flight ' + a.flight_details + ' (Montreal Convention)');
  lines.push('');
  lines.push('I am submitting a formal baggage claim under the Montreal Convention for ' + a.flight_details + '.');
  lines.push('');
  lines.push('What happened: ' + a.issue + '.');
  lines.push('');
  lines.push('PIR (Property Irregularity Report) filed: ' + a.pir_filed + '.');
  lines.push('');
  lines.push('Itemized value: ' + a.itemized_value);
  lines.push('');
  if (a.issue === 'Baggage damaged') {
    lines.push('I am filing this claim within 7 days of delivery, as required for damage claims.');
  } else if (a.issue === 'Baggage lost (21+ days missing)') {
    lines.push('This baggage has now been missing for 21 days or more, at which point it is legally considered lost rather than delayed.');
  } else if (a.issue === 'Baggage delayed (under 21 days) — essential items purchased') {
    lines.push('This baggage remains delayed. I purchased essential items in the meantime, itemized above.');
  }
  lines.push('');
  lines.push('The Montreal Convention caps liability at 1,519 SDR per passenger (approximately €2,000, though the exact euro value fluctuates with the SDR exchange rate). This is reimbursement of demonstrated value, not a flat payout.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderEuTrainDelayClaim(a) {
  const delayNum = parsePlainNumber(a.delay_minutes);
  if (delayNum === null) {
    return staticValidationError('Please enter the delay in minutes as a number so we can calculate the correct compensation tier.');
  }
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.operator_name);
  lines.push('Re: EU Rail Delay Compensation Claim — ' + a.journey_details);
  lines.push('');
  lines.push('I am submitting a formal delay compensation claim under Regulation (EU) 2021/782 for ' + a.journey_details + ', delayed ' + a.delay_minutes + ' minutes on arrival.');
  lines.push('');
  lines.push('Compensation due:');
  if (delayNum >= 60 && delayNum < 120) {
    lines.push('25% refund.');
  } else if (delayNum >= 120) {
    lines.push('50% refund.');
  }
  lines.push('');
  lines.push('Cause: ' + a.cause + '.');
  if (a.cause === 'Force majeure (extreme weather, person on tracks, etc.)') {
    lines.push('I understand cash compensation may not apply if this qualifies as force majeure, but your duty-of-care obligation (food, accommodation) still applies regardless of cause.');
  }
  lines.push('');
  if (a.missed_connection === 'Yes') {
    lines.push('I missed a connecting train because of this delay. I am asserting my right to free rerouting on the next available train, including via a partner operator, or alternative transport.');
    lines.push('');
  }
  if (a.duty_of_care_provided === 'No') {
    lines.push('I was not provided with food or accommodation as required. My expenses were: ' + a.duty_of_care_expenses + '. I am requesting reimbursement of these.');
    lines.push('');
  }
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderEuPackageHolidayComplaint(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.agency_name);
  lines.push('Re: Package Holiday Complaint — ' + a.trip_details);
  lines.push('');
  lines.push('I am submitting a formal complaint under Directive (EU) 2015/2302 regarding ' + a.trip_details + '.');
  lines.push('');
  lines.push('What happened: ' + a.issue + '.');
  lines.push('');
  lines.push(a.details);
  lines.push('');
  if (a.issue === 'Significant change made before departure (hotel downgrade, date shift, etc.)') {
    lines.push('As the organiser, you are liable for every service in this package, not individual suppliers. I am asserting my right to reject this change and receive a full refund within 14 days.');
  } else if (a.issue === 'Non-conformity at destination (hotel/excursions not as described)') {
    lines.push('As the organiser, you are liable for every service in this package, not individual suppliers. I am requesting equivalent alternative arrangements or a proportionate price reduction.');
  } else if (a.issue === 'Agency insolvency during or before trip') {
    lines.push('I am referencing the mandatory insolvency protection insurance required under the Directive, and my right to free repatriation.');
  }
  lines.push('');
  lines.push('Note: this claim applies if this booking qualifies as a "package" under the Directive (two or more linked travel services sold together) — please confirm this applies if it\'s not already clear.');
  lines.push('');
  lines.push('Remedy sought: ' + a.remedy + '.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderEu261FlightCompensationClaim(a) {
  const distanceNum = parsePlainNumber(a.distance_km);
  if (distanceNum === null) {
    return staticValidationError('Please enter the flight distance in km as a number so we can calculate the correct compensation tier.');
  }
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.airline_name);
  lines.push('Re: EU261 Compensation Claim — Flight ' + a.flight_details);
  lines.push('');
  lines.push('I am writing to formally claim compensation under Regulation (EC) No 261/2004 for ' + a.flight_details + '.');
  lines.push('');
  if (a.scenario === 'Delayed 3+ hours on arrival') {
    lines.push('This flight arrived more than three hours after its scheduled arrival time.');
  } else if (a.scenario === "Cancelled with less than 14 days' notice") {
    lines.push('This flight was cancelled, and I was notified less than 14 days before the scheduled departure.');
  }
  lines.push('');
  lines.push('Based on a flight distance of approximately ' + a.distance_km + ' km, the compensation due is:');
  if (distanceNum <= 1500) {
    lines.push('€250 per passenger.');
  } else if (distanceNum <= 3500) {
    lines.push('€400 per passenger.');
  } else {
    lines.push('€600 per passenger.');
  }
  lines.push('');
  if (a.cause === 'Technical/crew issue (airline-controlled)') {
    lines.push('The cause given for this disruption was a technical or crew issue. Under established case law, technical and crew-related issues are within the airline\'s control and do NOT qualify as "extraordinary circumstances" under Regulation (EC) No 261/2004. I am therefore asserting this claim in full.');
  } else if (a.cause === 'Weather/ATC/airspace closure') {
    lines.push('I understand the stated cause was weather or air traffic control related. If you are able to demonstrate that this genuinely qualifies as an "extraordinary circumstance," compensation may not be owed — however, I am submitting this claim and ask you to confirm your position and the evidence for it in writing.');
  } else if (a.cause === 'Not stated by airline') {
    lines.push('No cause was provided to me for this disruption. I am submitting this claim on the basis that, absent evidence of a genuine extraordinary circumstance, compensation is owed.');
  }
  lines.push('');
  if (a.duty_of_care_provided === 'No') {
    lines.push("In addition, I was not provided with the meals, refreshments, or accommodation required under Regulation (EC) No 261/2004's duty-of-care obligations. My out-of-pocket expenses as a result were: " + a.duty_of_care_expenses + '. I am requesting reimbursement of these in addition to the statutory compensation above.');
    lines.push('');
  }
  if (a.remedy === 'Full refund instead of rerouting/voucher') {
    lines.push('I am requesting a full refund of my ticket rather than rerouting or a voucher.');
    lines.push('');
  } else if (a.remedy === 'All of the above') {
    lines.push('I am requesting the full statutory compensation, a full refund of my ticket, and reimbursement of my duty-of-care expenses as set out above.');
    lines.push('');
  }
  lines.push('Please confirm receipt of this claim and provide a substantive response, including your position on liability, within a reasonable timeframe.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderFlightDisruptionCompensationReimbursement(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.airline_name);
  lines.push('Re: Flight Disruption Claim — ' + a.flight_details + ' (Booking ' + a.booking_reference + ')');
  lines.push('');
  if (a.scenario === 'Baggage lost, damaged, or delayed — no other disruption') {
    lines.push('I am submitting a baggage claim under the Montreal Convention for ' + a.flight_details + ' (booking ' + a.booking_reference + ').');
    lines.push('Baggage issue: ' + a.baggage_issue + '. ' + a.baggage_details);
    lines.push('The Montreal Convention caps liability at 1,519 SDR per passenger — this is a cap, not a guaranteed payout, and does not apply if a special value declaration was made and a higher fee paid at check-in.');
  } else {
    lines.push('I am submitting a compensation/reimbursement claim for ' + a.flight_details + ' (booking ' + a.booking_reference + ').');
    lines.push('');
    lines.push('Disruption: ' + a.scenario + '. Reason given by the airline: ' + a.reason_given + '.');
    lines.push('');
    if (a.jurisdiction === 'EU (EU261)') {
      lines.push('Under Regulation (EC) 261/2004, compensation of €250/€400/€600 applies depending on distance — please confirm the correct tier for this flight. Compensation does not apply if you can prove "extraordinary circumstances."');
    } else if (a.jurisdiction === 'UK (UK261)') {
      lines.push('Under UK261, the same tiered compensation applies in GBP equivalents (£220/£350/£520) — please confirm the correct tier for this flight. The claim deadline is 6 years (5 years in Scotland).');
    } else if (a.jurisdiction === 'US (DOT rules)') {
      lines.push('The US has no fixed cash compensation scheme equivalent to EU261/UK261. I am asserting my automatic cash refund entitlement under 14 CFR 259.5 for a cancelled or significantly changed flight.');
    } else if (a.jurisdiction === 'Australia (ACL)') {
      lines.push('Australia has no dedicated flight compensation regulation equivalent to EU261. I am raising this claim under the Australian Consumer Law — was the service provided with due care, was the delay reasonably avoidable.');
    } else if (a.jurisdiction === 'Not sure') {
      lines.push('I am not certain which regulatory framework applies to this flight — I would appreciate you confirming this, and I am reserving my rights under whichever framework does apply.');
    }
    if (a.baggage_issue !== 'No') {
      lines.push('');
      lines.push('In addition, my baggage was affected: ' + a.baggage_issue + '.');
      lines.push(a.baggage_details);
      lines.push('This is a separate claim under the Montreal Convention, distinct from the flight disruption claim above.');
    }
    if (a.duty_of_care_provided === 'No — I had to pay myself' || a.duty_of_care_provided === 'Partially — I paid for some of it myself') {
      lines.push('');
      lines.push('I was not adequately provided with meals, refreshments, or accommodation during this disruption. My out-of-pocket expenses were: ' + a.out_of_pocket_expenses + '. I am requesting reimbursement of these, separate from and additional to any statutory compensation.');
    }
  }
  lines.push('');
  lines.push('Remedy sought: ' + a.remedy_sought + '.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderCourierComplaintGenerator(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.carrier);
  lines.push('Re: Tracking Number ' + a.tracking_number + ' — Formal Complaint');
  lines.push('');
  lines.push('I am writing to formally complain about the handling of my parcel, tracking number ' + a.tracking_number + '.');
  lines.push('');
  if (a.issue_type === 'Lost') {
    lines.push('This parcel is lost. The last tracking update was: ' + a.last_tracking_update + '.');
  } else if (a.issue_type === 'Damaged') {
    lines.push('This parcel arrived damaged. ' + a.damage_description);
  } else if (a.issue_type === 'Delayed') {
    let l = 'This parcel was delayed. The promised/estimated delivery date was ' + a.promised_delivery_date + ', but ';
    l += a.actual_delivery_date === 'Not yet delivered' ? 'it has still not arrived' : 'it did not arrive until ' + a.actual_delivery_date;
    lines.push(l + '.');
  } else if (a.issue_type === 'Delivered to wrong address') {
    lines.push('This parcel was delivered to the wrong address. Please confirm the correct delivery location and the next steps to recover or resolve this.');
  }
  lines.push('');
  lines.push('Country: ' + a.country + '.');
  lines.push('');
  lines.push('Please refer to your own standard complaints/compensation process for this country in resolving this. I am seeking compensation of ' + a.compensation_amount + '.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.your_name);
  return lines.join('\n');
}

function renderCustomsFeeDisputeGenerator(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.carrier_customs_agent);
  lines.push('Re: Customs Charge Dispute — Tracking Number ' + a.tracking_number);
  lines.push('');
  lines.push('I am writing to dispute a customs/import charge on tracking number ' + a.tracking_number + ', imported into ' + a.country_of_import + '.');
  lines.push('');
  lines.push('The charge was ' + a.amount_charged + '. I believe the correct amount is ' + a.amount_correct + '.');
  lines.push('');
  const reason = a.dispute_reason === 'Other' ? a.dispute_reason_other : a.dispute_reason;
  lines.push('Reason for dispute: ' + reason + '.');
  lines.push('');
  lines.push('I am requesting a recalculation and refund of the difference, and a clear breakdown of how the original charge was calculated if one was not already provided.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.your_name);
  return lines.join('\n');
}

function renderVendorCompensationDemandLetter(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.vendor_name);
  lines.push('Re: Formal Demand — Order ' + a.order_reference);
  lines.push('');
  lines.push('I am writing regarding order ' + a.order_reference + ', placed on ' + a.order_date + ' for ' + a.amount_paid + '.');
  lines.push('');
  if (a.scenario === 'Lost parcel (never arrived, or tracking shows no movement)') {
    lines.push('This parcel has not arrived. The last tracking update was ' + a.last_tracking_update + ', and there has been no tracking movement for ' + a.days_since_movement + ' days, via ' + a.carrier_used + '.');
    if (a.carrier_confirmed_lost === 'Yes') {
      lines.push('The carrier has confirmed this parcel is lost.');
    } else if (a.carrier_confirmed_lost === 'No') {
      lines.push('The carrier has not yet confirmed the parcel is lost, but given the lack of movement, I am not willing to wait indefinitely.');
    }
  } else if (a.scenario === 'Damaged parcel (arrived damaged, or contents damaged)') {
    lines.push('This parcel arrived damaged on ' + a.damage_discovered_date + '.');
    lines.push(a.damage_description);
    if (a.photos_available === 'Yes') {
      lines.push('I have photos documenting the damage, available on request.');
    }
    if (a.packaging_kept === 'Yes') {
      lines.push('I have kept the original packaging.');
    }
  } else if (a.scenario === 'Late delivery (arrived significantly after promised date)') {
    let l = 'This order was promised for delivery by ' + a.promised_delivery_date + ', but ';
    l += a.actual_delivery_date === 'Not yet delivered' ? 'has still not arrived' : 'did not actually arrive until ' + a.actual_delivery_date;
    lines.push(l + '.');
    lines.push(a.delay_harm);
  }
  lines.push('');
  lines.push('As the seller, you remain responsible for successful delivery of the goods I ordered from you. I am requesting the following: ' + a.desired_outcome + '.');
  lines.push('');
  lines.push('If this is not resolved, I will pursue a chargeback with my card issuer or escalate to the relevant consumer protection authority.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.your_name);
  return lines.join('\n');
}

function renderMedicalRecordsRequestLetter(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.provider_name);
  lines.push('Re: Request for Medical Records');
  lines.push('');
  lines.push('I am requesting access to the following medical records: ' + a.records_requested + '.');
  lines.push('');
  if (hasValue(a.date_range)) {
    lines.push('Date range: ' + a.date_range + '.');
    lines.push('');
  }
  lines.push('Preferred delivery format: ' + a.delivery_preference + '.');
  lines.push('');
  if (a.reason_for_request !== 'Prefer not to say') {
    lines.push('Reason for this request: ' + a.reason_for_request + '.');
    lines.push('');
  }
  lines.push('I am making this request under my general right to access my own medical records under applicable law.');
  lines.push('');
  lines.push('Jurisdiction: ' + a.jurisdiction + '.');
  lines.push('');
  lines.push('Please respond within a reasonable, stated timeframe.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.patient_full_name);
  return lines.join('\n');
}

function renderHealthcareBillingDisputeRefundLetter(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.provider_name);
  lines.push('Re: Billing Dispute — ' + a.service_description);
  lines.push('');
  lines.push('I am writing regarding ' + a.service_description + ', amount in question ' + a.amount_in_question + '.');
  lines.push('');
  if (a.scenario === 'Incorrect or unexpected charge on a bill') {
    lines.push('The bill shows ' + a.billed_amount + ', but I expected ' + a.expected_amount + '.');
    lines.push('Reason for the discrepancy: ' + a.discrepancy_reason);
    lines.push('I am requesting an itemized explanation and correction of this amount within a reasonable period.');
  } else if (a.scenario === 'Refund after cancelling a service') {
    lines.push('I cancelled this service on ' + a.service_cancellation_date + ' and have already paid ' + a.amount_already_paid + '.');
    if (hasValue(a.cancellation_policy_reference)) {
      lines.push('I was told the following about cancellation/refund terms: ' + a.cancellation_policy_reference);
    }
    lines.push('I am requesting a full or appropriate partial refund within a reasonable period.');
  }
  lines.push('');
  lines.push('Jurisdiction: ' + a.jurisdiction + '.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.patient_full_name);
  return lines.join('\n');
}

function renderHealthcareInsuranceAppealLetter(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.insurer_name);
  lines.push('Re: Formal Appeal — Claim ' + a.claim_reference_number);
  lines.push('');
  lines.push('I am formally appealing the denial of coverage for ' + a.denied_service_description + ', claim reference ' + a.claim_reference_number + '.');
  lines.push('');
  lines.push('Your stated reason for denial: ' + a.denial_reason_given);
  lines.push('');
  lines.push('My grounds for appeal: ' + a.patient_counter_argument);
  lines.push('');
  if (hasValue(a.appeal_deadline)) {
    lines.push('This appeal is submitted ahead of the stated deadline: ' + a.appeal_deadline + '.');
    lines.push('');
  }
  lines.push('I am requesting a formal reconsideration of this claim, directly addressing the reason for denial above.');
  lines.push('');
  lines.push('If this internal appeal is unsuccessful, I understand I may escalate to the applicable external/independent review process for my jurisdiction and plan type.');
  lines.push('');
  lines.push('Jurisdiction: ' + a.jurisdiction + '.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.policyholder_full_name);
  return lines.join('\n');
}

function renderMedicalProductComplaintLetter(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.seller_or_manufacturer_name);
  lines.push('Re: Complaint — ' + a.product_name);
  lines.push('');
  lines.push('I am writing regarding ' + a.product_name + ', purchased on ' + a.purchase_date + '.');
  lines.push('');
  lines.push('Issue type: ' + a.issue_type + '.');
  lines.push('');
  lines.push(a.issue_description);
  lines.push('');
  if (a.issue_type === 'Safety concern') {
    lines.push('I may also report this issue to the relevant product safety/regulatory authority in my area.');
    lines.push('');
  }
  lines.push('I am requesting the following resolution: ' + a.desired_outcome + '.');
  lines.push('');
  lines.push('I am asserting my general warranty and consumer protection rights for a defective or misdescribed product.');
  lines.push('');
  lines.push('Jurisdiction: ' + a.jurisdiction + '.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.consumer_full_name);
  return lines.join('\n');
}

function renderHealthcareProviderInformationRequest(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.provider_name);
  lines.push('Re: Information Request — ' + a.service_of_interest);
  lines.push('');
  lines.push('Before making a decision about ' + a.service_of_interest + ', I would like to request the following information: ' + a.information_requested);
  lines.push('');
  if (hasValue(a.response_deadline_requested)) {
    lines.push('I would appreciate a response by: ' + a.response_deadline_requested + '.');
    lines.push('');
  }
  lines.push('Thank you for your time.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.requester_full_name);
  return lines.join('\n');
}

// ---- Batch 7 (FINAL): Cars & Vehicles, Crypto & Fintech, Food &
// Hospitality, Insurance & Claims, Training & Education ----

function renderVehiclePurchaseWarrantyComplaintGenerator(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.seller_dealer_name);
  lines.push('Re: ' + a.vehicle_details + ' (VIN: ' + a.vin + ') — Formal Complaint');
  lines.push('');
  lines.push('I am writing regarding the vehicle ' + a.vehicle_details + ' (VIN: ' + a.vin + '), purchased on ' + a.purchase_date + ' for ' + a.purchase_price + '.');
  lines.push('');
  if (a.situation_type === "Vehicle doesn't match the listing/description") {
    lines.push('The listing/seller claimed: ' + a.listing_claim + '. What I actually found: ' + a.actual_finding + '. I have the following evidence: ' + a.mismatch_evidence + '.');
  } else if (a.situation_type === 'Defect discovered after purchase') {
    lines.push('I discovered the following defect on ' + a.defect_discovery_date + ': ' + a.defect_description + '.');
    if (a.defect_disclosure_status === 'No') {
      lines.push('This was not disclosed to me before purchase.');
    } else if (a.defect_disclosure_status === 'Yes but described differently') {
      lines.push('This was described to me differently before purchase than what I have found.');
    } else if (a.defect_disclosure_status === 'Unsure') {
      lines.push('I am not sure whether this was disclosed to me before purchase.');
    }
  } else if (a.situation_type === 'Warranty claim') {
    lines.push('Under the warranty terms provided — ' + a.warranty_terms + ' — I am submitting a claim for the following defect, discovered on ' + a.warranty_discovery_date + ': ' + a.warranty_defect_description + '.');
    if (a.warranty_repair_estimate === 'Yes — specify amount') {
      lines.push('A repair estimate of ' + a.warranty_repair_estimate_amount + ' has been obtained.');
    }
  } else if (a.situation_type === 'Escalation of an unresolved complaint') {
    lines.push('I first submitted this complaint on ' + a.original_complaint_date + '. The response I received: ' + a.response_summary + '. This response was not satisfactory because: ' + a.unsatisfactory_reason + '. I am escalating this matter as it remains unresolved.');
  }
  lines.push('');
  const vpwOutcome = a.desired_outcome === 'Partial refund — specify amount' ? 'a partial refund of ' + a.desired_outcome_amount : a.desired_outcome;
  lines.push('The outcome I am requesting is: ' + vpwOutcome + '.');
  lines.push('');
  const vpwDeadline = a.situation_type === 'Escalation of an unresolved complaint' ? '7-10 days' : '14 days';
  lines.push('Please respond within ' + vpwDeadline + ' of this letter.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.your_name);
  return lines.join('\n');
}

function renderVehicleRepairDisputeGenerator(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.shop_name);
  lines.push('Re: Repair Dispute — ' + a.vehicle_details);
  lines.push('');
  lines.push('I am writing regarding the repair performed on ' + a.vehicle_details + ', dropped off on ' + a.dropoff_date + ' (' + a.completion_status + '), for a total cost of ' + a.amount_paid + '.');
  lines.push('');
  lines.push('The specific issue is: ' + a.issue_type + '. ' + a.issue_description);
  lines.push('');
  if (a.prior_contact === 'Yes — free text describing their response') {
    lines.push('I have already raised this with you, and your response was: ' + a.prior_contact_response + '.');
  } else if (a.prior_contact === 'No, this is the first contact') {
    lines.push('This is the first time I am raising this issue with you formally.');
  }
  lines.push('');
  lines.push('The outcome I am requesting is: ' + a.desired_outcome + '.');
  lines.push('');
  lines.push('Please respond within 14 days of this letter.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.your_name);
  return lines.join('\n');
}

// Routing table for crypto-complaint-generator — resolved in code, 1:1 port
// of the original AI prompt's routing instructions (see
// _drafts-pending/generators-static-migration/static-generators-phase1-sample.md).
function cryptoComplaintRouting(a) {
  const country = a.country;
  const pt = a.problem_type;
  if (country === 'United States') {
    if (pt === 'Suspected fraud or scam (fake platform, rug pull, etc.)' || pt === 'Misleading marketing or advertised returns') {
      return {
        to: 'the Federal Trade Commission (ReportFraud.ftc.gov)',
        note: "If this could involve an unregistered securities offering, you may also wish to consider the SEC's complaint portal.",
      };
    }
    if (pt === "Exchange won't release my funds / account frozen" || pt === 'Unauthorized transaction / account compromise') {
      return {
        to: "FinCEN's complaint channel",
        note: 'If this involves a bank-related crypto dispute, you may also wish to consider the CFPB.',
      };
    }
    if (pt === 'Bank refused/closed my account for crypto-related activity') {
      return {
        to: 'the Consumer Financial Protection Bureau (CFPB)',
        note: 'If a national bank is involved, you may also wish to consider the OCC.',
      };
    }
    // 'Other regulatory concern'
    return {
      to: 'the appropriate US financial regulator for your specific issue — the US has no single crypto complaint regulator',
      note: null,
    };
  }
  if (country === 'United Kingdom') {
    return {
      to: 'the Financial Conduct Authority (FCA)',
      note: 'If the FCA-regulated firm does not resolve this directly, the Financial Ombudsman Service (FOS) is the individual dispute resolution path.',
    };
  }
  if (country === 'European Union') {
    return {
      to: 'your national competent authority responsible for MiCA enforcement in your EU member state',
      note: 'For individual dispute resolution, contact the relevant national financial ombudsman.',
    };
  }
  if (country === 'Australia') {
    return {
      to: 'the Australian Securities and Investments Commission (ASIC)',
      note: 'For individual dispute resolution, contact AFCA (Australian Financial Complaints Authority). For suspected scams specifically, also consider reporting to Scamwatch/ACCC.',
    };
  }
  // 'Other/not sure'
  return {
    to: 'your national financial regulator — please identify the correct one before submitting this complaint',
    note: null,
  };
}

function renderCryptoComplaintGenerator(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('Re: Formal Complaint Regarding ' + a.entity_name);
  lines.push('');
  const routing = cryptoComplaintRouting(a);
  lines.push('To: ' + routing.to);
  if (routing.note) {
    lines.push(routing.note);
  }
  lines.push('');
  lines.push('I am submitting this complaint regarding ' + a.entity_name + ' in relation to the following issue: ' + a.problem_type + '.');
  lines.push('');
  lines.push('Details: ' + a.details);
  lines.push('Amount involved: approximately ' + a.amount_involved + '.');
  lines.push('');
  const isFraud = a.problem_type === 'Suspected fraud or scam (fake platform, rug pull, etc.)';
  if (a.prior_contact === 'No, not yet' && isFraud) {
    lines.push('Given this involves suspected fraud, I am reporting this directly to the appropriate authority rather than attempting to resolve it with the company first.');
  } else if (a.prior_contact === 'No, not yet') {
    lines.push('I have not yet contacted ' + a.entity_name + ' directly about this issue, and intend to do so before escalating further, but am filing this complaint to formally register the issue in the meantime.');
  } else if (a.prior_contact === 'Yes, no response') {
    lines.push('I have already contacted ' + a.entity_name + ' directly about this issue and received no response.');
  } else if (a.prior_contact === 'Yes, unsatisfactory response') {
    lines.push('I have already contacted ' + a.entity_name + ' directly about this issue and their response was unsatisfactory.');
  }
  lines.push('');
  lines.push('I am requesting that this complaint be formally investigated.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

function renderExchangeAccountFreezeResponse(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.exchange_name);
  lines.push('Re: Account Restriction Since ' + a.freeze_date);
  lines.push('');
  lines.push("My account with you has been frozen/restricted since " + a.freeze_date + ", affecting approximately " + a.amount_affected + " in funds. What I've been told since the freeze: " + a.communication_so_far + '.');
  lines.push('');
  if (a.freeze_reason_given === 'No reason given at all' || a.freeze_reason_given === "Generic 'compliance review' with no specifics") {
    lines.push("No specific reason has been given for this restriction. I am requesting the specific reason for this hold — your own terms of service generally require disclosure of the general nature of a hold, even if full compliance details cannot be shared.");
  } else if (a.freeze_reason_given === 'Source of funds/AML review requested') {
    lines.push('I understand this relates to a source of funds/AML review. I am preparing supporting documentation and am requesting the specific list of documents your compliance team requires, and the expected review timeframe.');
  } else if (a.freeze_reason_given === 'Suspected account compromise/security hold') {
    lines.push('I am requesting confirmation of what security concern triggered this hold and what specific verification is needed to lift it.');
  } else if (a.freeze_reason_given === 'Other reason stated') {
    lines.push('I am requesting further written clarification of the specific reason for this restriction and what is needed to resolve it.');
  }
  lines.push('');
  if (hasValue(a.urgency_factors)) {
    lines.push(a.urgency_factors);
    lines.push('');
  }
  lines.push('I am requesting a clear timeline for resolution. If this remains unresolved within a reasonable period, I will consider escalating this to the relevant national regulator.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

// source-of-funds-package-generator — per-scenario labeled fact list.
// Field names inheritance_date_received / gift_date_received (NOT a shared
// date_received) match the live frontend, which renamed them to avoid a
// duplicate-DOM-id collision — see generators-static-migration-inventory.md.
function sourceOfFundsScenarioLines(a) {
  const lines = [];
  if (a.scenario === 'Payroll/employment income') {
    lines.push('- Employer: ' + a.employer_name);
    lines.push('- Employment start date: ' + a.employment_start_date);
    lines.push('- Approximate income: ' + a.approx_income_amount + ' (' + a.income_frequency + ')');
    lines.push('- Funds accumulated: ' + a.accumulation_period);
  } else if (a.scenario === 'Inheritance') {
    lines.push('- Relationship to deceased: ' + a.deceased_relationship);
    lines.push('- Date received: ' + a.inheritance_date_received);
    if (hasValue(a.probate_reference)) {
      lines.push('- Probate/estate reference: ' + a.probate_reference);
    }
  } else if (a.scenario === 'Sale of property or assets') {
    lines.push('- Asset sold: ' + a.asset_type);
    lines.push('- Sale date: ' + a.sale_date);
    lines.push('- Sale price: ' + a.sale_price);
  } else if (a.scenario === 'Gift or donation') {
    lines.push('- From: ' + a.donor_name + ' (' + a.donor_relationship + ')');
    lines.push('- Date received: ' + a.gift_date_received);
  } else if (a.scenario === 'Business income') {
    lines.push('- Business: ' + a.business_name + ' (' + a.business_type + ')');
    lines.push('- Income period: ' + a.income_period);
    lines.push('- Approximate revenue: ' + a.approx_revenue);
  } else if (a.scenario === 'Investment proceeds') {
    lines.push('- Investment type: ' + a.investment_type);
    lines.push('- Holding period: ' + a.holding_period);
    lines.push('- Proceeds realized: ' + a.proceeds_date);
  }
  return lines;
}

function renderSourceOfFundsPackageGenerator(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.institution_name + ' Compliance Team');
  lines.push('Re: Source of Funds — ' + a.amount_in_question);
  lines.push('');
  lines.push('This letter and the attached documentation are submitted in support of your source-of-funds/AML review regarding ' + a.amount_in_question + '.');
  lines.push('');
  if (a.prior_contact === 'Yes, account is currently frozen/restricted') {
    lines.push('I understand my account is currently frozen/restricted pending this review, and I would appreciate a response timeline.');
    lines.push('');
  } else if (a.prior_contact === 'Yes, but account access was already fully restored') {
    lines.push('I understand access to my account has already been restored; I am submitting this documentation to formally close out the review.');
    lines.push('');
  }
  lines.push('Source of Funds — ' + a.scenario + ':');
  for (const line of sourceOfFundsScenarioLines(a)) {
    lines.push(line);
  }
  lines.push('');
  lines.push('Supporting documents available: ' + a.documents_available);
  lines.push('');
  lines.push('This package is submitted to support your review — please let me know if any additional documentation is required.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push('[Your name]');
  return lines.join('\n');
}

// restaurant-policies-generator — 7 structured policy_type branches, each
// sourced from its own dedicated field set (policy_details free-text was
// removed from the frontend precisely so this could be static — see
// generators-static-migration-inventory.md).
function renderRestaurantPoliciesGenerator(a) {
  const lines = [];
  if (a.policy_type === 'Reservation Policy') {
    lines.push('RESERVATION POLICY — ' + a.restaurant_name);
    lines.push('');
    lines.push('Booking method: ' + a.booking_method + '.');
    lines.push('');
    lines.push('Parties of up to ' + a.max_group_no_deposit + ' do not require a deposit to book. Larger parties may be asked for a deposit — contact us directly for group bookings.');
    lines.push('');
    lines.push('We hold reservations for ' + a.grace_period_minutes + ' minutes past the booked time. After this, the table may be released to walk-in guests.');
    lines.push('');
    const hasBookingPlatform = hasValue(a.booking_platform) && a.booking_platform.trim().toLowerCase() !== 'none';
    lines.push('Questions about reservations: ' + a.contact_email + (hasBookingPlatform ? ', or via ' + a.booking_platform + '.' : '.'));
    lines.push('');
    lines.push('Local consumer protection laws may impose additional requirements — please verify independently.');
  } else if (a.policy_type === 'Cancellation Policy') {
    lines.push('CANCELLATION POLICY — ' + a.restaurant_name);
    lines.push('');
    lines.push('Cancellations made at least ' + a.min_notice_hours + ' hours before your reservation are free of charge.');
    lines.push('');
    if (a.penalty_type === 'No penalty') {
      lines.push('Cancellations made after this window do not incur a penalty, but we ask for as much notice as possible.');
    } else if (a.penalty_type === 'Percentage of the bill') {
      lines.push('Cancellations made after this window may incur a charge of ' + a.penalty_value + '% of the expected bill.');
    } else if (a.penalty_type === 'Fixed amount') {
      lines.push('Cancellations made after this window may incur a charge of ' + a.penalty_value + '.');
    }
    if (hasValue(a.cancellation_exceptions)) {
      lines.push('');
      lines.push('Exceptions: ' + a.cancellation_exceptions);
    }
    lines.push('');
    lines.push('Local consumer protection laws may impose additional requirements — please verify independently.');
  } else if (a.policy_type === 'No-Show Policy') {
    lines.push('NO-SHOW POLICY — ' + a.restaurant_name);
    lines.push('');
    if (a.deposit_required === 'Yes') {
      lines.push('A deposit is required for this booking.');
      if (a.noshow_deposit_outcome === 'Deposit is forfeited') {
        lines.push('If you do not show up without cancelling, your deposit will be forfeited.');
      } else if (a.noshow_deposit_outcome === 'Partial deposit forfeited') {
        lines.push('If you do not show up without cancelling, part of your deposit will be forfeited.');
      } else if (a.noshow_deposit_outcome === 'Other') {
        lines.push('Our no-show deposit terms will be explained at the time of booking.');
      }
    } else if (a.deposit_required === 'No') {
      lines.push('A deposit is not currently required for bookings.');
    }
    lines.push('');
    lines.push('After ' + a.noshows_before_deposit_required + ' no-shows, we may require a deposit for future bookings.');
    lines.push('');
    lines.push('Local consumer protection laws may impose additional requirements — please verify independently.');
  } else if (a.policy_type === 'Refund Policy') {
    lines.push('REFUND POLICY — ' + a.restaurant_name);
    lines.push('');
    lines.push('Refund method: ' + a.refund_method + '. Processing time: ' + a.refund_processing_time + '.');
    lines.push('');
    lines.push('Refunds may apply in the following cases: ' + a.refund_qualifying_cases);
    lines.push('');
    lines.push('Local consumer protection laws may impose additional requirements — please verify independently.');
  } else if (a.policy_type === 'Allergen Policy') {
    lines.push('ALLERGEN POLICY — ' + a.restaurant_name);
    lines.push('');
    if (a.cross_contact_risk === 'Yes') {
      lines.push('Our kitchen prepares multiple dishes in a shared space, and we cannot guarantee any dish is completely free of cross-contact with common allergens.');
    } else if (a.cross_contact_risk === 'No') {
      lines.push('We take steps to avoid allergen cross-contact between dishes.');
    }
    lines.push('');
    lines.push('If you have a food allergy, please inform your server before ordering. ' + a.allergy_disclosure_procedure);
    lines.push('');
    lines.push('This policy is a starting point and does not replace professional allergen verification. Local consumer protection laws may impose additional requirements — please verify independently.');
  } else if (a.policy_type === 'Delivery Policy') {
    lines.push('DELIVERY POLICY — ' + a.restaurant_name);
    lines.push('');
    const showPlatformName = a.delivery_method !== 'Our own delivery staff' && hasValue(a.delivery_platform_name);
    lines.push('Delivery method: ' + a.delivery_method + (showPlatformName ? ' (' + a.delivery_platform_name + ').' : '.'));
    lines.push('Estimated delivery time: ' + a.estimated_delivery_time + '.');
    lines.push('');
    lines.push('If your order arrives incorrect or cold, we offer: ' + a.incorrect_cold_order_policy + '. Contact us at ' + a.contact_email + ' to report an issue.');
    lines.push('');
    lines.push('Local consumer protection laws may impose additional requirements — please verify independently.');
  } else if (a.policy_type === 'Privacy Policy') {
    lines.push('PRIVACY POLICY — ' + a.restaurant_name);
    lines.push('');
    lines.push('We collect your name, email, and phone number when you make a reservation or place an order.');
    lines.push('');
    if (a.email_marketing_use === 'Yes') {
      lines.push('We may use your email to send you marketing communications. You can opt out at any time.');
    } else if (a.email_marketing_use === 'No') {
      lines.push('We do not use your email for marketing communications.');
    }
    lines.push('');
    if (a.third_party_data_sharing === 'Not shared with third parties') {
      lines.push('We do not share your data with third parties.');
    } else if (a.third_party_data_sharing === 'Shared with our booking platform only') {
      lines.push('Your data may be shared with ' + a.booking_platform + ', our booking platform, to process your reservation.');
    } else if (a.third_party_data_sharing === 'Shared with booking and delivery platforms') {
      lines.push('Your data may be shared with our booking and delivery platforms to process your reservation or order.');
    }
    lines.push('');
    lines.push('Contact ' + a.contact_email + ' with any privacy questions. Local consumer protection laws may impose additional requirements — please verify independently.');
  }
  return lines.join('\n');
}

function renderFoodRecallActionPlanGenerator(a) {
  const lines = [];
  lines.push('FOOD SAFETY INCIDENT ACTION PLAN — ' + a.restaurant_name);
  lines.push('');
  lines.push('Product/ingredient affected: ' + a.product_affected);
  lines.push('Source of concern: ' + a.source + ' (' + a.supplier_or_internal + ')');
  lines.push('Incident manager: ' + a.contact_person);
  lines.push('Already served to customers: ' + a.served);
  if (a.served === 'Yes') {
    lines.push('Date range / covers affected: ' + a.served_details);
  }
  lines.push('');
  lines.push('1. Internal Protocol');
  lines.push('- Immediately remove ' + a.product_affected + ' from all kitchen, storage, and menu locations.');
  lines.push('- Notify all kitchen and front-of-house staff of the affected product.');
  lines.push('- ' + a.contact_person + ' is designated incident manager and single point of contact for this recall.');
  if (a.served === 'Yes') {
    lines.push('- Because this product has already been served, assess whether affected customers need to be proactively notified (see Communication Templates below).');
  }
  lines.push('');
  lines.push('2. Withdrawal Checklist');
  lines.push('[ ] Remove ' + a.product_affected + ' from kitchen prep areas');
  lines.push('[ ] Remove from cold/dry storage');
  lines.push('[ ] Remove from printed and digital menus');
  lines.push('[ ] Remove from delivery platform listings');
  lines.push('[ ] Confirm no remaining stock in any location');
  lines.push('[ ] Log the withdrawal in the Incident Log below');
  lines.push('');
  lines.push('3. Communication Templates');
  lines.push('');
  lines.push('Customer-facing template:');
  lines.push('"We are writing to inform you that [product] served [date range] has been affected by a ' + a.source + ' concern. As a precaution, we recommend seeking medical advice if symptoms occur, or contacting us directly. We take food safety seriously and have removed this product immediately. Please contact ' + a.contact_person + ' with any questions."');
  if (a.supplier_or_internal === 'Supplier-issued recall') {
    lines.push('');
    lines.push('Local food safety authority notification template:');
    lines.push('"We are notifying you of a supplier-issued recall affecting ' + a.product_affected + ', received via ' + a.source + '. We have removed the affected product from service as of [date/time] and are following our internal recall protocol. Contact: ' + a.contact_person + '."');
  }
  lines.push('');
  lines.push('4. Incident Log');
  lines.push('| Date/Time | Action Taken | Staff Member | Notes |');
  lines.push('|---|---|---|---|');
  lines.push('| | | | |');
  lines.push('| | | | |');
  lines.push('| | | | |');
  return lines.join('\n');
}

// allergen-menu-labeling-generator — static keyword-match engine, one
// jurisdiction-specific lookup table per option on the `jurisdiction` select.
// Tables and matching logic are the exact approved design from
// _drafts-pending/generators-static-migration/batch-1.md (US) and
// batch-1-addendum.md (EU/UK/Australia) — Carlos-approved 2026-09-16.
// This is deliberately a closed keyword lookup, never an AI call: matching
// is case-insensitive substring search against a fixed table, not judgment.
const ALLERGEN_TABLE_EU_UK = [
  ['Cereals containing gluten', ['wheat', 'rye', 'barley', 'oats', 'spelt', 'kamut', 'flour', 'bread', 'breadcrumb', 'pasta', 'couscous', 'semolina', 'bulgur', 'malt', 'beer', 'noodle']],
  ['Crustaceans', ['shrimp', 'prawn', 'crab', 'lobster', 'crawfish', 'crayfish', 'langoustine']],
  ['Eggs', ['egg', 'eggs', 'mayonnaise', 'mayo', 'meringue', 'aioli']],
  ['Fish', ['fish', 'salmon', 'tuna', 'cod', 'anchovy', 'anchovies', 'bass', 'trout', 'halibut', 'sardine', 'fish sauce', 'worcestershire']],
  ['Peanuts', ['peanut', 'peanuts', 'groundnut']],
  ['Soybeans', ['soy', 'soya', 'tofu', 'edamame', 'tempeh', 'miso', 'soy sauce', 'soybean']],
  ['Milk', ['milk', 'butter', 'cream', 'cheese', 'yogurt', 'yoghurt', 'ghee', 'whey', 'casein', 'buttermilk', 'custard']],
  ['Nuts (tree nuts)', ['almond', 'hazelnut', 'walnut', 'cashew', 'pecan', 'brazil nut', 'pistachio', 'macadamia', 'queensland nut', 'nutella']],
  ['Celery', ['celery', 'celeriac']],
  ['Mustard', ['mustard']],
  ['Sesame seeds', ['sesame', 'tahini', 'hummus']],
  ['Sulphur dioxide/sulphites', ['sulphite', 'sulfite', 'sulphur dioxide', 'e220', 'e221', 'e222', 'e223', 'e224', 'e226', 'e227', 'e228', 'dried fruit', 'wine vinegar']],
  ['Lupin', ['lupin', 'lupine', 'lupin flour']],
  ['Molluscs', ['mussel', 'oyster', 'clam', 'scallop', 'squid', 'octopus', 'snail', 'escargot']],
];
const ALLERGEN_TABLE_US = [
  ['Milk', ['milk', 'butter', 'cream', 'cheese', 'yogurt', 'yoghurt', 'ghee', 'whey', 'casein', 'buttermilk', 'custard']],
  ['Egg', ['egg', 'eggs', 'mayonnaise', 'mayo', 'meringue', 'aioli']],
  ['Fish', ['fish', 'salmon', 'tuna', 'cod', 'anchovy', 'anchovies', 'bass', 'trout', 'halibut', 'sardine', 'fish sauce', 'worcestershire']],
  ['Shellfish (crustacean/mollusk)', ['shrimp', 'prawn', 'crab', 'lobster', 'scallop', 'clam', 'mussel', 'oyster', 'crawfish', 'crayfish']],
  ['Tree nuts', ['almond', 'walnut', 'cashew', 'pistachio', 'pecan', 'hazelnut', 'macadamia', 'brazil nut', 'pine nut', 'nutella']],
  ['Peanuts', ['peanut', 'peanuts', 'groundnut']],
  ['Wheat', ['wheat', 'flour', 'bread', 'breadcrumb', 'breadcrumbs', 'pasta', 'couscous', 'semolina', 'bulgur', 'noodle']],
  ['Soy', ['soy', 'soya', 'tofu', 'edamame', 'tempeh', 'miso', 'soy sauce', 'soybean']],
  ['Sesame', ['sesame', 'tahini', 'hummus']],
];
const ALLERGEN_TABLE_AU = [
  ['Peanut', ['peanut', 'peanuts', 'groundnut']],
  ['Almond', ['almond']],
  ['Brazil nut', ['brazil nut']],
  ['Cashew', ['cashew']],
  ['Hazelnut', ['hazelnut']],
  ['Macadamia', ['macadamia', 'queensland nut']],
  ['Pecan', ['pecan']],
  ['Pine nut', ['pine nut']],
  ['Pistachio', ['pistachio']],
  ['Walnut', ['walnut']],
  ['Milk', ['milk', 'butter', 'cream', 'cheese', 'yogurt', 'yoghurt', 'ghee', 'whey', 'casein', 'buttermilk', 'custard']],
  ['Egg', ['egg', 'eggs', 'mayonnaise', 'mayo', 'meringue', 'aioli']],
  ['Fish', ['fish', 'salmon', 'tuna', 'cod', 'anchovy', 'anchovies', 'bass', 'trout', 'halibut', 'sardine', 'fish sauce', 'worcestershire']],
  ['Crustacean', ['shrimp', 'prawn', 'crab', 'lobster', 'crawfish', 'crayfish']],
  ['Mollusc', ['mussel', 'oyster', 'clam', 'scallop', 'squid', 'octopus', 'snail', 'escargot']],
  ['Soy / soya / soybean', ['soy', 'soya', 'tofu', 'edamame', 'tempeh', 'miso', 'soy sauce', 'soybean']],
  ['Sesame', ['sesame', 'tahini', 'hummus']],
  ['Lupin', ['lupin', 'lupine', 'lupin flour']],
  ['Wheat (+ gluten)', ['wheat', 'flour', 'bread', 'breadcrumb', 'pasta', 'couscous', 'semolina', 'bulgur', 'noodle']],
  ['Barley (+ gluten, if present)', ['barley', 'malt', 'beer']],
  ['Oats (+ gluten, if present)', ['oats']],
  ['Rye (+ gluten, if present)', ['rye']],
  ['Sulphites (≥10mg/kg)', ['sulphite', 'sulfite', 'sulphur dioxide', 'dried fruit', 'wine vinegar']],
];

function matchAllergens(text, table) {
  const lower = String(text || '').toLowerCase();
  const matched = [];
  for (const [name, keywords] of table) {
    if (keywords.some((kw) => lower.includes(kw))) {
      matched.push(name);
    }
  }
  return matched;
}

function parseMenuInput(menuInput) {
  const dishes = [];
  const rawLines = String(menuInput || '').split(/\r?\n/);
  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      dishes.push({ name: line, text: line });
    } else {
      const name = line.slice(0, colonIdx).trim();
      const ingredients = line.slice(colonIdx + 1).trim();
      dishes.push({ name: name, text: name + ' ' + ingredients });
    }
  }
  return dishes;
}

function renderAllergenMenuLabelingGenerator(a) {
  let table;
  let disclaimer;
  if (a.jurisdiction === 'EU — 14 allergens') {
    table = ALLERGEN_TABLE_EU_UK;
    disclaimer = "Generated using a static keyword match against the EU's 14 allergens under Regulation (EU) No 1169/2011, Annex II — this is a starting point, not a substitute for professional allergen verification. Always confirm with your supplier's ingredient documentation, especially for processed ingredients, sauces, and cross-contact risk that a keyword match cannot catch.";
  } else if (a.jurisdiction === "UK — 14 allergens (Natasha's Law)") {
    table = ALLERGEN_TABLE_EU_UK;
    disclaimer = "Generated using a static keyword match against the UK's 14 allergens (the same list retained from EU FIC Regulation 1169/2011, enforced for prepacked-for-direct-sale food under Natasha's Law) — this is a starting point, not a substitute for professional allergen verification. Always confirm with your supplier's ingredient documentation, especially for processed ingredients, sauces, and cross-contact risk that a keyword match cannot catch.";
  } else if (a.jurisdiction === 'US — Big 9 (FDA FASTER Act)') {
    table = ALLERGEN_TABLE_US;
    disclaimer = 'Generated using a static keyword match against the US FDA "Big 9" allergen list — this is a starting point, not a substitute for professional allergen verification. Always confirm with your supplier\'s ingredient documentation, especially for processed ingredients, sauces, and cross-contact risk that a keyword match cannot catch.';
  } else if (a.jurisdiction === 'Australia — ANZ Food Standards Code allergens') {
    table = ALLERGEN_TABLE_AU;
    disclaimer = "Generated using a static keyword match against the individual allergen names required under Standard 1.2.3, Schedule 9 of the Food Standards Code (Australia/NZ) — this is a starting point, not a substitute for professional allergen verification. Always confirm with your supplier's ingredient documentation, especially for processed ingredients, sauces, and cross-contact risk that a keyword match cannot catch.";
  }

  const dishes = parseMenuInput(a.menu_input);
  const lines = [];
  lines.push('ALLERGEN LABELING — ' + a.restaurant_name);
  lines.push('');
  lines.push('| Dish Name | Allergens Present | Notes |');
  lines.push('|---|---|---|');
  for (const dish of dishes) {
    const matched = matchAllergens(dish.text, table);
    lines.push('| ' + dish.name + ' | ' + (matched.length ? matched.join(', ') : 'None matched') + ' | |');
  }
  if (a.cross_contamination === 'Yes') {
    lines.push('');
    lines.push('Note: This kitchen prepares multiple dishes in a shared space and cannot guarantee any dish is completely free of cross-contact with other allergens.');
  }
  lines.push('');
  lines.push(disclaimer);
  return lines.join('\n');
}

// course-provider-terms-refund-policy-generator — guarantee-phrase table is
// the same closed keyword list built and approved in Batch 1, now applied
// to the dedicated outcome_stat_description field instead of an open
// document_details textarea (per the frontend field redesign).
const GUARANTEE_PHRASES = [
  'guaranteed job placement',
  '100% job guarantee',
  "promise you'll get hired",
  'guaranteed to get a job',
  'we guarantee employment',
  '100% placement rate',
  'guaranteed to land a job',
  'job guarantee',
];

function containsGuaranteePhrase(text) {
  const lower = String(text || '').toLowerCase();
  return GUARANTEE_PHRASES.some((p) => lower.includes(p));
}

function renderCourseProviderTermsRefundPolicyGenerator(a) {
  const lines = [];
  if (a.document_type === 'Enrollment & Cancellation Policy') {
    lines.push('ENROLLMENT & CANCELLATION POLICY — ' + a.provider_name);
    lines.push('');
    lines.push('Program type: ' + a.provider_type);
    lines.push('Duration: ' + a.program_duration);
    lines.push('Payment model: ' + a.price_model);
    lines.push('');
    lines.push('You may cancel your enrollment without penalty within ' + a.cancellation_window + ' of enrolling.');
    lines.push('');
    if (a.penalty_after_window === 'No penalty') {
      lines.push('Cancellations made after this window do not incur a penalty.');
    } else if (a.penalty_after_window === 'Percentage of price') {
      lines.push('Cancellations made after this window may incur a charge of ' + a.penalty_value + '% of the program price.');
    } else if (a.penalty_after_window === 'Fixed fee') {
      lines.push('Cancellations made after this window may incur a fee of ' + a.penalty_value + '.');
    }
    lines.push('');
    lines.push('If ' + a.provider_name + ' cancels or postpones a cohort: ' + a.cohort_cancel_postpone_policy);
    lines.push('');
    lines.push('This is a starting template and should be reviewed by a qualified attorney before publication.');
  } else if (a.document_type === 'Refund Policy') {
    lines.push('REFUND POLICY — ' + a.provider_name);
    lines.push('');
    lines.push('Refund method: ' + a.refund_method + '. Processing time: ' + a.refund_processing_time + '.');
    lines.push('');
    if (a.refund_proration === 'Full refund only') {
      lines.push('Refunds, where eligible, are issued in full.');
    } else if (a.refund_proration === 'Prorated based on usage') {
      lines.push('Refunds are prorated based on how much of the program you have accessed or completed.');
    } else if (a.refund_proration === 'Prorated based on time elapsed') {
      lines.push('Refunds are prorated based on how much time has elapsed since enrollment.');
    }
    if (hasValue(a.non_refundable_components)) {
      lines.push('');
      lines.push('The following are non-refundable: ' + a.non_refundable_components);
    }
    lines.push('');
    lines.push('This is a starting template and should be reviewed by a qualified attorney before publication.');
  } else if (a.document_type === 'Certificate/Completion Policy') {
    lines.push('CERTIFICATE/COMPLETION POLICY — ' + a.provider_name);
    lines.push('');
    lines.push('To be considered as having completed this program, the following criteria apply: ' + a.completion_criteria);
    lines.push('');
    if (a.certificate_accredited === 'Yes, accredited by a named third-party body') {
      lines.push('Upon completion, you will receive a certificate accredited by ' + a.accrediting_body_name + '.');
    } else if (a.certificate_accredited === 'No, internal completion certificate only') {
      lines.push('Upon completion, you will receive an internal completion certificate issued by ' + a.provider_name + '. This certificate is not accredited by an external body.');
    }
    lines.push('');
    lines.push('This is a starting template and should be reviewed by a qualified attorney before publication.');
  } else if (a.document_type === 'Marketing Claims Disclaimer') {
    lines.push('MARKETING CLAIMS DISCLAIMER — ' + a.provider_name);
    lines.push('');
    if (a.outcome_stat_used === "No, I don't reference any outcome statistics") {
      lines.push(a.provider_name + ' does not reference employment or outcome statistics in its marketing.');
    } else if (a.outcome_stat_used === 'Yes, I reference an employment/outcome statistic') {
      lines.push(a.provider_name + ' references the following statistic in its marketing: ' + a.outcome_stat_description + '.');
      if (a.stat_verification === 'Independently verified') {
        lines.push('This statistic has been independently verified.');
      } else if (a.stat_verification === 'Self-reported by graduates') {
        lines.push('This statistic is self-reported by graduates and has not been independently verified — this should be disclosed alongside the statistic wherever it is used.');
      }
      if (containsGuaranteePhrase(a.outcome_stat_description)) {
        lines.push('This phrasing may constitute an absolute employment guarantee. Absolute guarantees are a legal and reputational risk unless you can substantiate an actual guarantee with a real refund or remedy attached to it — consider rephrasing or confirming you can back this claim.');
      }
    }
    lines.push('');
    lines.push('This is a starting template and should be reviewed by a qualified attorney before publication.');
  }
  return lines.join('\n');
}

function renderInsuranceClaimLetterGenerator(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.insurance_company);
  lines.push('Re: Insurance Claim — Policy ' + a.policy_number);
  if (hasValue(a.claim_number_if_any)) {
    lines.push('(Claim ' + a.claim_number_if_any + ')');
  }
  lines.push('');
  lines.push('I am submitting a claim regarding an incident on ' + a.incident_date + ': ' + a.incident_description);
  lines.push('');
  lines.push('Damages/losses: ' + a.damages_description);
  lines.push('');
  lines.push('Coverage believed to apply: ' + a.relevant_coverage);
  lines.push('');
  lines.push('Documentation enclosed: ' + a.documentation_list);
  lines.push('');
  lines.push('Amount claimed: ' + a.amount_claimed + '.');
  lines.push('');
  const iclOutcome = a.desired_outcome === 'Other — specify' ? a.desired_outcome_other : a.desired_outcome;
  lines.push('Desired outcome: ' + iclOutcome + '.');
  lines.push('');
  lines.push('Please acknowledge receipt and advise on next steps.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.your_name);
  return lines.join('\n');
}

// insurance-claim-followup-escalation-generator — escalation_target's 4th
// option label was corrected 2026-09-16 from a phrase referencing a
// nonexistent jurisdiction field to "Unsure — ask them to direct this to
// the correct contact"; the branch condition below matches the corrected,
// live frontend text exactly.
function renderInsuranceClaimFollowupEscalationGenerator(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.insurance_company);
  const isFollowup = a.situation_type === 'No response or unexplained delay — routine follow-up';
  lines.push('Re: Claim ' + a.claim_number + ' (Policy ' + a.policy_number + ') — ' + (isFollowup ? 'Follow-Up' : 'Formal Escalation'));
  lines.push('');
  lines.push('This claim was originally submitted on ' + a.claim_submission_date + '.');
  lines.push('');
  if (isFollowup) {
    if (hasValue(a.last_contact_date)) {
      lines.push('Date of last contact: ' + a.last_contact_date + '.');
    }
    lines.push('Missed deadline, if any: ' + a.missed_deadline + '.');
    lines.push('I am requesting an update.');
  } else {
    lines.push('Prior contact and responses so far: ' + a.prior_contact_summary);
    lines.push('This is unsatisfactory because: ' + a.unsatisfactory_reason);
    if (a.escalation_target === 'Internal complaints department') {
      lines.push('I am requesting this be handled by your internal complaints department.');
    } else if (a.escalation_target === 'Named supervisor or manager') {
      lines.push('I am requesting this be handled by a named supervisor or manager, not front-line support.');
    } else if (a.escalation_target === 'Insurance ombudsman or equivalent regulator') {
      lines.push('If this is not resolved, I will escalate to the applicable insurance ombudsman or regulator.');
    } else if (a.escalation_target === 'Unsure — ask them to direct this to the correct contact') {
      lines.push('I am requesting you direct this to whichever internal escalation contact is correct for a claim at this stage.');
    }
    lines.push('This letter is being sent as a formal escalation of an unresolved complaint.');
  }
  lines.push('');
  lines.push('Desired outcome: ' + a.desired_outcome + '.');
  lines.push('');
  lines.push('Please respond within ' + (isFollowup ? '14 days' : '7 days') + '.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.your_name);
  return lines.join('\n');
}

function renderInsuranceDenialCoverageDisputeGenerator(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  lines.push('To: ' + a.insurance_company);
  lines.push('Re: Formal Dispute — Claim ' + a.claim_number + ' (Policy ' + a.policy_number + ')');
  lines.push('');
  lines.push('I am disputing your decision dated ' + a.decision_date + ' regarding this claim.');
  lines.push('');
  lines.push('Your stated reason(s): ' + a.insurer_reasons);
  lines.push('');
  if (a.situation_type === 'The claim was denied outright') {
    lines.push('Policy clause(s) cited: ' + a.cited_clauses);
    lines.push('Why this reasoning is disputed: ' + a.dispute_reasoning);
    lines.push('Counter-evidence available: ' + a.counter_evidence);
  } else if (a.situation_type === 'The claim was accepted but the amount or scope of coverage is disputed') {
    lines.push('Amount/scope offered: ' + a.amount_offered);
    lines.push('Amount/scope believed correct, and why: ' + a.amount_believed_correct);
    lines.push('Supporting evidence: ' + a.supporting_evidence);
  }
  lines.push('');
  lines.push('Amount in dispute: ' + a.amount_in_dispute + '.');
  lines.push('');
  const idcOutcome = a.desired_outcome === 'Partial payment reflecting a specific disputed portion — specify' ? 'a partial payment of ' + a.desired_outcome_partial_amount : a.desired_outcome;
  lines.push('Desired outcome: ' + idcOutcome + '.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.your_name);
  return lines.join('\n');
}

function renderThirdPartyLiabilityClaimLetterGenerator(a) {
  const lines = [];
  lines.push(todayDate());
  lines.push('');
  let toLine = 'To: ' + a.at_fault_party_name;
  if (hasValue(a.insurer_if_known)) {
    toLine += ' (c/o ' + a.insurer_if_known + ')';
  }
  lines.push(toLine);
  lines.push('Re: Liability Claim — Incident on ' + a.incident_date);
  lines.push('');
  lines.push('I am writing regarding an incident on ' + a.incident_date + ' at ' + a.incident_location + ': ' + a.incident_description);
  lines.push('');
  lines.push('Damages/losses suffered: ' + a.damages_description);
  lines.push('');
  lines.push('Supporting evidence available: ' + a.evidence_list);
  lines.push('');
  lines.push('Amount claimed: ' + a.amount_claimed + ', based on: ' + a.amount_basis);
  lines.push('');
  const tplOutcome = a.desired_outcome === 'Other — specify' ? a.desired_outcome_other : a.desired_outcome;
  lines.push('Desired outcome: ' + tplOutcome + '.');
  lines.push('');
  lines.push('Please respond within 14 days.');
  lines.push('');
  lines.push('Sincerely,');
  lines.push(a.your_name);
  return lines.join('\n');
}

// Override for generators producing a formatted document rather than a letter
// (e.g. a Scope of Work attached to a contract) — no date/address block at the
// top, numbered sections instead, signature blocks at the end for both parties.
// Declared here, before GENERATORS, since several entries reference it directly
// in their object literal (referencing a const declared later in the module
// throws a ReferenceError at load time — this ordering avoids that).
const DOCUMENT_OUTPUT_RULES =
  '\n\nOutput ONLY the finished document itself, ready to attach to a contract or print — a numbered document with clear section headers, not a letter. Do not start with a date or address block. End with labeled signature blocks (with date lines) for both parties named in the instructions above. Do not include any commentary, explanation, notes, or markdown code fences. Use [square brackets] for any detail the user did not provide.';

// ---- Config-driven generator definitions ----
// Only the server-side concerns live here (prompt template + output rules).
// gumroad_product_id fields below are DEPRECATED and unused since the
// 2026-09-11 switch to free, email-capture unlocking -- left in place
// rather than deleted, in case Gumroad monetization needs to be reverted
// to later. The frontend carries the question set in its own page config.
const GENERATORS = {
  'lost-parcel': {
    title: 'Lost Parcel Legal Demand',
    gumroad_product_id: 'lcbzyb',
    // STATIC as of 2026-09-16 (pilot batch) -- prompt_template below is now
    // DEAD CODE, kept unused in case this ever needs reverting to AI mode
    // (same convention as verifyGumroadLicense()). render() is the real path.
    static: true,
    render: renderLostParcel,
    prompt_template:
      'Write a formal demand letter addressed to the RETAILER (not the courier/shipping company) demanding a full refund within 48 hours for a lost or damaged parcel. If country is UK, cite the Consumer Rights Act 2015 (the retailer remains liable for goods until they reach the consumer, regardless of courier used). If country is US, cite general state consumer protection law language without inventing a specific statute number. Retailer: {retailer}. Order date: {order_date}. Amount paid: {amount}. Issue: {issue}. Tone: professional, firm, cites the relevant legal basis, gives a specific 48-hour deadline.',
  },
  'fcra-credit-dispute': {
    // Merged with the former 'credit-report-error-dispute-letter' generator
    // (retired, never had a real Gumroad product wired, not in cross-link-map.json)
    // -- both produced the same deliverable (a dispute letter to a credit
    // bureau) with meaningful overlap. This one keeps its wired Gumroad
    // product and absorbs the other's jurisdiction handling: the US branch
    // below is unchanged from before the merge (still cites FCRA Section 611
    // and the 30/45-day window); the UK/EU/Australia branch reuses the
    // retired generator's own general-but-accurate phrasing verbatim rather
    // than inventing new claims for jurisdictions not yet legally verified.
    title: 'Credit Report Dispute Letter Generator',
    gumroad_product_id: 'vytma',
    // STATIC as of 2026-09-17 (Batch 1: Financial & Banking) -- prompt_template
    // below is now DEAD CODE, kept unused per the established convention.
    static: true,
    render: renderFcraCreditDispute,
    prompt_template:
      "Write a formal credit report dispute letter from {customer_name} to {bureau} regarding {issue_type} on the account/reference {account_reference}, if provided, describing the specific error: {details}. Jurisdiction: {jurisdiction}. If jurisdiction is 'US': explicitly identify this as an FCRA Section 611 dispute, state clearly that the consumer is disputing the specific account/item as inaccurate, incomplete, or unverifiable under the Fair Credit Reporting Act, and formally request that the bureau conduct a reasonable reinvestigation and delete or correct the item if it cannot be verified within the 30-day statutory window (45 days if applicable). If jurisdiction is 'UK', 'EU', or 'Australia': reference the consumer's general right to dispute inaccurate information on their credit file and have it investigated within a defined period — keep any specific deadline generic ('within the investigation period required in your area') unless independently verified; never invent a specific day count, and do not cite a specific statute name. Request correction or removal of the disputed item and a copy of the updated report once the investigation concludes. Tone: professional, factual, formal, no emotional language.",
  },
  'fdcpa-cease-desist': {
    title: 'Debt Collector Cease & Desist Letter (FDCPA)',
    gumroad_product_id: 'ualrk',
    // STATIC as of 2026-09-17 (pilot batch 2/4) -- prompt_template below is
    // now DEAD CODE, kept unused per the same convention as lost-parcel.
    static: true,
    render: renderFdcpaCeaseDesist,
    prompt_template:
      'Write a formal cease-and-desist letter to a debt collection agency, explicitly invoking Section 805(c) of the Fair Debt Collection Practices Act (FDCPA), demanding they stop all further communication except as permitted by law (confirming cessation or notifying of specific legal action). Reference the specific issue described. Note this letter should be sent via certified mail with return receipt requested — mention this in the letter\'s closing instructions to the sender, not as part of the letter\'s own body text to the collector. Collector: {collector_name}. Account reference: {account_reference}. Issue: {issue}. If is_third_party is \'No / Not sure\', add a brief note in the generated output (outside the letter itself) reminding the user that the FDCPA generally applies only to third-party collectors, not original creditors collecting their own debt, and to verify which applies to their situation. Tone: firm, professional, cites the correct legal section.',
  },
  'state-ag-complaint': {
    title: 'State Attorney General Complaint Letter',
    gumroad_product_id: 'wrbdyq',
    // STATIC as of 2026-09-17 (Batch 3: Shipping/Shopping/Subscriptions/
    // Training -- final batch) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderStateAgComplaint,
    prompt_template:
      'Write a formal complaint letter to the addressee\'s State Attorney General\'s Consumer Protection Division. State clearly that the consumer is filing a complaint against the named business for unfair or deceptive business practices, describe the issue using the details provided, reference general consumer protection principles (misleading advertising, breach of implied warranty, or unconscionable business practices as applicable) WITHOUT inventing or citing a specific state statute name or number — state protection laws vary and the letter should stay accurate by not naming a specific act unless the user already did. Business: {business_name}. State: {state}. Issue: {issue_type}. Details: {details}. Tone: professional, factual, no emotional language.',
  },
  'fcc-complaint': {
    title: 'FCC Informal Complaint Letter',
    gumroad_product_id: 'eyssdz',
    // STATIC as of 2026-09-17 (Batch 3: Shipping/Shopping/Subscriptions/
    // Training -- final batch) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderFccComplaint,
    prompt_template:
      'Write a formal FCC informal complaint narrative suitable for submission through the FCC Consumer Complaint Center. State the category of the complaint (billing, service quality, availability, or contract dispute), describe the issue factually using the details provided, reference any prior attempts to resolve it directly with the provider, and state the specific resolution requested (credit, rate correction, technician visit, or contract release, as applicable based on the issue). Provider: {provider_name}. Category: {category}. Prior attempts: {prior_attempts}. Details: {details}. Tone: factual, clear, no emotional language — written to be pasted into the FCC\'s own complaint form fields, not as a mailed letter.',
  },
  'dol-wage-complaint': {
    title: 'DOL Wage Theft Complaint (FLSA)',
    gumroad_product_id: 'cygypm',
    // STATIC as of 2026-09-18 (Batch 4: Employment + Subscriptions &
    // Services) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderDolWageComplaint,
    prompt_template:
      'Write a formal wage complaint narrative suitable for submission to the US Department of Labor\'s Wage and Hour Division (WHD), referencing the Fair Labor Standards Act (FLSA). State the employer name, describe the specific wage issue and the discrepancy between hours worked and hours paid using the details provided, and note that FLSA claims generally have a 2-year recovery window (3 years if the violation is willful) without inventing case-specific willfulness language unless clearly supported. If retaliation is \'Yes\', add a separate paragraph noting that retaliation for raising a wage complaint is independently illegal under FLSA Section 15(a)(3), and that this should be reported as well. Employer: {employer_name}. Issue: {issue_type}. Discrepancy: {discrepancy}. Tone: factual, clear, no emotional language — written to be submitted via WHD\'s online complaint form or read over the phone.',
  },
  'au-major-failure-refund-demand': {
    title: 'Major Failure Refund Demand Letter (Australia)',
    gumroad_product_id: 'ikchrx',
    // STATIC as of 2026-09-17 (Batch 3: Shipping/Shopping/Subscriptions/
    // Training -- final batch) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderAuMajorFailureRefundDemand,
    prompt_template:
      'Write a formal demand letter to an Australian retailer asserting that a product fault constitutes a major failure under the Australian Consumer Law (ACL) consumer guarantees. Reference that the ACL does not set a fixed 12-month guarantee period — protection lasts as long as reasonable given the product\'s price and type — and that for a major failure the consumer, not the retailer, chooses between refund and replacement. State plainly that the letter is not a request for goodwill but an assertion of a statutory right, and that the retailer (not the manufacturer) is legally responsible. Do not cite a specific ACL section number unless already well-established; do not invent a compensation figure or fixed response deadline beyond a reasonable window (commonly 7-14 days). Retailer: {retailer_name}. Product: {product}. Purchase date: {purchase_date}. Price paid: {price_paid}. Fault: {fault}. Basis: {failure_test}. Remedy sought: {remedy}. Tone: professional, firm, factual.',
  },
  'au-unauthorised-transaction-dispute': {
    title: 'Bank Dispute Letter — Unauthorised Transaction (Australia)',
    // Real Gumroad product_id for the "au-unauthorised-transaction-dispute" product.
    gumroad_product_id: 'wnqma',
    // STATIC as of 2026-09-17 (Batch 1: Financial & Banking) -- prompt_template
    // below is now DEAD CODE, kept unused per the established convention.
    static: true,
    render: renderAuUnauthorisedTransactionDispute,
    prompt_template:
      'Write a formal dispute letter to an Australian bank regarding a genuinely unauthorised transaction, invoking the ePayments Code. IMPORTANT: only use this template for transactions the customer did NOT knowingly authorise (stolen card, hacked account, etc.) — do not use scam-related language implying authorised transfers are covered, since the ePayments Code does not currently cover scams where the customer was deceived into authorising a payment themselves. State that under the Code, the customer is not liable for the loss unless the bank can demonstrate the customer contributed through serious carelessness, and that the burden of proof sits with the bank, not the customer. Request a formal investigation and a dispute reference number. Do not invent a specific compensation figure or a fixed response deadline — request a response within a reasonable time (commonly 15-45 days, per standard IDR timeframes) instead. Bank: {bank_name}. Transaction date: {transaction_date}. Amount: {amount}. Scenario: {scenario}. Reported to bank on: {reported_date}. Evidence: {evidence}. Tone: professional, firm, factual.',
  },
  'au-tio-cancellation-demand': {
    title: 'Telco Cancellation & TIO Complaint Letter (Australia)',
    // Real Gumroad product_id for the "au-tio-cancellation-demand" product.
    gumroad_product_id: 'doeik',
    // STATIC as of 2026-09-17 (Batch 3: Shipping/Shopping/Subscriptions/
    // Training -- final batch) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderAuTioCancellationDemand,
    prompt_template:
      'Write a formal letter to an Australian telco/ISP requesting contract cancellation without an early termination fee, referencing that a provider failing to deliver promised service quality or unilaterally changing contract terms is generally considered a breach on the provider\'s side. State that if this isn\'t resolved directly, the customer intends to lodge a complaint with the Telecommunications Industry Ombudsman (TIO), which gives providers a short window (commonly around 10 business days) to resolve complaints once referred. Do not invent a specific TIO fee amount charged to the provider — keep this general (e.g. \'costs associated with TIO involvement\'). Provider: {provider_name}. Issue: {issue}. Cancellation first requested: {cancellation_request_date}. Details: {details}. Remedy sought: {remedy}. Tone: professional, firm, factual.',
  },
  'au-airline-complaint': {
    title: 'Airline Complaint Letter (Australia)',
    // Real Gumroad product_id for the "au-airline-complaint" product.
    gumroad_product_id: 'ymfpyv',
    // STATIC as of 2026-09-19 (Batch 6: Flights & Travel / Delivery &
    // Parcels / Healthcare & Medical) -- prompt_template below is now
    // DEAD CODE.
    static: true,
    render: renderAuAirlineComplaint,
    prompt_template:
      'Write a formal complaint letter to an Australian domestic airline. Do NOT claim a guaranteed automatic cash compensation right — Australia has no EU261-style automatic delay compensation scheme. Frame any expense/reasonable-time argument under the Australian Consumer Law as a claim being made, not a guaranteed entitlement, especially where the cause was airline-controlled (technical/crew/maintenance) rather than weather or air traffic control. For baggage claims, reference the Civil Aviation (Carriers\' Liability) Act 1959 liability framework without inventing a specific dollar cap — note that liability limits are capped and periodically adjusted, and reference the airline\'s own Conditions of Carriage for exact claim deadlines rather than asserting one universal number. If a refund is sought instead of a travel voucher, state that clearly. Airline: {airline_name}. Flight: {flight_details}. Issue: {issue_type}. Cause: {cause}. Expenses: {expenses}. PIR filed: {pir_filed}. Remedy sought: {remedy}. Tone: professional, firm, factual, realistic about what is guaranteed versus what is being requested.',
  },
  'au-notice-to-remedy-repairs': {
    title: 'Notice to Remedy / Urgent Repairs Letter (Australia)',
    // Real Gumroad product_id for the "au-notice-to-remedy-repairs" product.
    gumroad_product_id: 'rdytkn',
    // STATIC as of 2026-09-18 (Batch 5: Housing & Rentals / Home
    // Renovations / Legal & Contracts) -- prompt_template below is now
    // DEAD CODE.
    static: true,
    render: renderAuNoticeToRemedyRepairs,
    prompt_template:
      "Write a formal Notice to Remedy Breach / Urgent Repairs letter to a landlord or agent in Australia. If is_urgent is 'Yes', state that the tenant may arrange a qualified tradesperson directly and seek reimbursement if the landlord doesn't act immediately, and request contact within 24 hours. If 'No', request repair within a reasonable window (commonly 7-14 days, noting this varies by state — do not assert one fixed number as universal law). Do NOT suggest withholding rent under any circumstance — explicitly state that rent will continue to be paid in full. Mention that if the deadline passes, the tenant may apply to their state tenancy tribunal (NCAT/VCAT/QCAT or equivalent) for a repair order and/or compensation. Landlord/agent: {landlord_name}. State: {state}. Issue: {issue}. Urgent: {is_urgent}. Details: {details}. Prior contact: {prior_contact}. Tone: professional, firm, factual.",
  },
  'landlord-deposit-demand-letter': {
    title: 'Landlord Deposit Demand Letter',
    // Replaces the retired 'landlord-deposit' and 'security-deposit-demand-letter'
    // generators (consolidated into one scenario-branched tool covering both
    // "not returned" and "deductions disputed", across US/UK/EU/Australia).
    gumroad_product_id: 'gdyor',
    // STATIC as of 2026-09-18 (Batch 5: Housing & Rentals / Home
    // Renovations / Legal & Contracts) -- prompt_template below is now
    // DEAD CODE.
    static: true,
    render: renderLandlordDepositDemandLetter,
    prompt_template:
      "Write a formal, firm but professional deposit demand letter matching the scenario selected. If scenario is 'Deposit not returned at all', demand full return within a reasonable stated period, referencing deposit_protection_scheme_name if provided, and the tenant's right to escalate to a jurisdiction-appropriate small claims/tenancy tribunal if unresolved. If scenario is 'Deposit returned with deductions I dispute', state amount_withheld and landlord_stated_reason, present tenant_counter_evidence, and request an itemized justification plus full or partial refund within a reasonable period. For jurisdiction={jurisdiction}, keep any cited deadlines or legal thresholds generic ('the deadline that applies in your area') — never invent a specific number. Tenant: {tenant_full_name}, forwarding address {tenant_forwarding_address}. Landlord: {landlord_full_name}. Property: {property_address}. Move-out: {move_out_date}. Deposit: {deposit_amount_paid}. Scenario: {scenario}. Days since move-out: {days_since_moveout}. Protection scheme: {deposit_protection_scheme_name}. Amount withheld: {amount_withheld}. Landlord's stated reason: {landlord_stated_reason}. Counter-evidence: {tenant_counter_evidence}. Tone: professional, firm, factual.",
  },
  'repair-request-formal-notice': {
    title: 'Repair Request Formal Notice',
    // Replaces the retired 'notice-to-repair' generator.
    gumroad_product_id: 'ofxzc',
    // STATIC as of 2026-09-18 (Batch 5: Housing & Rentals / Home
    // Renovations / Legal & Contracts) -- prompt_template below is now
    // DEAD CODE.
    static: true,
    render: renderRepairRequestFormalNotice,
    prompt_template:
      "Write a formal written repair request / habitability notice. Describe issue_description, first reported issue_first_reported_date, urgency urgency_level. If prior_notice_given is 'Yes', reference the prior request made on prior_notice_date without adequate resolution. For jurisdiction={jurisdiction}, state that landlords are generally expected to address urgent issues promptly, keeping any specific deadline generic ('within the timeframe required in your area') rather than inventing a number. Request a specific, reasonable repair date and note the tenant is documenting this request in case further action becomes necessary. Tenant: {tenant_full_name}. Landlord: {landlord_full_name}. Property: {property_address}. Issue: {issue_description}. First reported: {issue_first_reported_date}. Urgency: {urgency_level}. Prior notice given: {prior_notice_given}. Prior notice date: {prior_notice_date}. Tone: professional, non-confrontational.",
  },
  'illegal-eviction-warning-letter': {
    title: 'Illegal Eviction Warning Letter',
    gumroad_product_id: 'iavmyw',
    // STATIC as of 2026-09-18 (Batch 5: Housing & Rentals / Home
    // Renovations / Legal & Contracts) -- prompt_template below is now
    // DEAD CODE.
    static: true,
    render: renderIllegalEvictionWarningLetter,
    prompt_template:
      "Write a firm formal letter addressing incident_description on incident_date. State clearly that self-help eviction (changing locks, removing belongings, shutting off utilities, forcing a tenant out without a court-ordered legal process) is not a lawful method of eviction in most {jurisdiction} jurisdictions, and only a court-ordered/legally compliant process may remove a tenant. Demand immediate restoration of access/utilities/belongings as applicable. State the tenant is documenting this incident and will pursue all available legal remedies, including contacting local housing authorities or law enforcement, if not immediately resolved. Keep legal citations generic ('applicable landlord-tenant law in your area') rather than inventing statute numbers. Tenant: {tenant_full_name}. Landlord: {landlord_full_name}. Property: {property_address}. Incident: {incident_description}. Incident date: {incident_date}. Tone: firm, unambiguous — this is not a negotiation letter. Also suggest the tenant keep a copy and consider contacting local police/housing authority if access is actively being denied.",
  },
  'rental-scam-refund-demand': {
    title: 'Rental Scam Refund Demand',
    gumroad_product_id: 'esyrb',
    // STATIC as of 2026-09-18 (Batch 5: Housing & Rentals / Home
    // Renovations / Legal & Contracts) -- prompt_template below is now
    // DEAD CODE.
    static: true,
    render: renderRentalScamRefundDemand,
    prompt_template:
      "Write two things: (1) a formal refund demand letter/message demanding return of amount_paid, paid via payment_method on payment_date, for a rental that scam_description. State this was based on false pretenses, demand a full refund within a short specific period, and note failure to respond will result in the matter being reported to listing_platform, the payment provider, and local law enforcement/consumer protection authorities in {jurisdiction}. (2) A short, separate, factual, non-alarmist checklist of where to report this scam based on payment_method (bank/card chargeback, payment app fraud report, gift card issuer fraud line, or noting cryptocurrency is generally non-reversible) — don't guess at recovery odds. Victim: {victim_full_name}. Amount paid: {amount_paid}. Payment method: {payment_method}. Payment date: {payment_date}. Recipient: {recipient_name_or_alias}. Listing platform: {listing_platform}. Scam description: {scam_description}. Tone: firm, factual.",
  },
  'lease-clause-challenge-letter': {
    title: 'Lease Clause Challenge Letter',
    gumroad_product_id: 'cajgj',
    // STATIC as of 2026-09-18 (Batch 5: Housing & Rentals / Home
    // Renovations / Legal & Contracts) -- prompt_template below is now
    // DEAD CODE.
    static: true,
    render: renderLeaseClauseChallengeLetter,
    prompt_template:
      "Write a professional letter challenging or requesting removal of clause_text_or_summary, concern category clause_concern_type. If already_signed is 'No', frame as a request to amend the clause before signing, politely explaining the concern. If already_signed is 'Yes', frame as a formal notice the clause may be unenforceable under {jurisdiction} tenant protection law (generic — 'may not be enforceable under applicable law in your area', never cite a specific statute unless independently verified) and request written confirmation the landlord will not attempt to enforce it. Tenant: {tenant_full_name}. Landlord: {landlord_full_name}. Property: {property_address}. Clause: {clause_text_or_summary}. Concern type: {clause_concern_type}. Already signed: {already_signed}. Tone: professional, factual — negotiation/notice letter, not a threat.",
  },
  'lease-violation-notice-generator': {
    title: 'Lease Violation Notice Generator',
    gumroad_product_id: 'yxkdiw',
    // STATIC as of 2026-09-18 (Batch 5: Housing & Rentals / Home
    // Renovations / Legal & Contracts) -- prompt_template below is now
    // DEAD CODE.
    static: true,
    render: renderLeaseViolationNoticeGenerator,
    prompt_template:
      "Write a formal lease violation notice for violation_type, identified violation_date_identified, described as violation_description. State that under {jurisdiction} landlord-tenant law, the tenant is given formal notice and an opportunity to cure within the notice/cure period that applies locally — keep the specific number of days generic ('within the cure period required in your jurisdiction — confirm this before sending') rather than inventing a figure. State failure to cure within that period may result in further legal action, including eviction proceedings, in accordance with local law. Landlord: {landlord_full_name}. Tenant: {tenant_full_name}. Property: {property_address_unit}. Violation type: {violation_type}. Description: {violation_description}. Date identified: {violation_date_identified}. Tone: professional, formal — legal notice. Include a clear disclaimer the landlord must confirm the exact cure period and notice requirements for their jurisdiction before sending, as this is not legal advice.",
  },
  'au-privacy-complaint-letter': {
    title: 'Privacy Complaint Letter to a Company (Australia)',
    // Real Gumroad product_id for the "au-privacy-complaint-letter" product.
    gumroad_product_id: 'ymuznm',
    // STATIC as of 2026-09-17 (Batch 2: Legal & Contracts / Privacy & Data /
    // Public Services) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderAuPrivacyComplaintLetter,
    prompt_template:
      "Write a formal privacy complaint letter to an Australian company, to be sent BEFORE lodging an OAIC complaint (as required by law, giving the company approximately 30 days to respond). Reference the Privacy Act 1988 and the relevant Australian Privacy Principle if provided. State clearly that if the company does not respond satisfactorily within 30 days, the complainant intends to escalate to the Office of the Australian Information Commissioner (OAIC). Do not claim the OAIC's $3 million turnover jurisdiction threshold applies to this specific company unless the person confirms it — phrase this as a general note the reader should check, not an assumption about the company being complained about. Company: {company_name}. Issue: {issue}. APP: {app_breached}. Details: {details}. Remedy sought: {remedy}. Tone: professional, firm, factual.",
  },
  'eu-withdrawal-right-letter': {
    title: 'Withdrawal Right / Cancellation Letter (EU)',
    // Real Gumroad product_id for the "eu-withdrawal-right-letter" product.
    gumroad_product_id: 'onxtxv',
    // STATIC as of 2026-09-17 (Batch 3: Shipping/Shopping/Subscriptions/
    // Training -- final batch) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderEuWithdrawalRightLetter,
    prompt_template:
      "Write a formal EU right-of-withdrawal notice per Directive 2011/83/EU. State clearly no reason is required. If was_informed is 'No / Not sure', note that failing to properly inform the consumer extends the withdrawal window by 12 months, without asserting this applies with certainty — phrase as something to verify. Do not reference the discontinued ODR platform. Seller: {seller_name}. Order: {order_details}. Delivery date: {delivery_date}. Reason (if given): {reason}. Tone: professional, factual.",
  },
  'eu-legal-guarantee-demand': {
    title: 'Legal Guarantee Repair/Replacement Demand (EU)',
    // Real Gumroad product_id for the "eu-legal-guarantee-demand" product.
    gumroad_product_id: 'ypqab',
    // STATIC as of 2026-09-17 (Batch 3: Shipping/Shopping/Subscriptions/
    // Training -- final batch) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderEuLegalGuaranteeDemand,
    prompt_template:
      "Write a formal legal guarantee (conformity) demand per Directive (EU) 2019/771. State the seller (not manufacturer) is responsible. If within the first year, note the burden-of-proof presumption favors the consumer. State full refund/termination is only available if repair/replacement first failed or was refused, unless remedy is already 'Full refund'. Do not assert a fixed 2-year or 3-year figure as universal — note it varies by member state (2-year EU minimum, some countries extend further). Seller: {seller_name}. Product: {product}. Purchase date: {purchase_date}. Defect: {defect}. Remedy: {remedy}. Tone: professional, factual.",
  },
  'eu261-flight-compensation-claim': {
    title: 'EU261 Flight Delay/Cancellation Compensation Claim',
    // Real Gumroad product_id for the "eu261-flight-compensation-claim" product.
    gumroad_product_id: 'uhpyudt',
    // STATIC as of 2026-09-19 (Batch 6: Flights & Travel / Delivery &
    // Parcels / Healthcare & Medical) -- prompt_template below is now
    // DEAD CODE. Numeric-tier parsing (distance_km) implemented via
    // parsePlainNumber()/staticValidationError() per the approved Option A
    // plan -- see numeric-parsing-plan.md.
    static: true,
    render: renderEu261FlightCompensationClaim,
    prompt_template:
      "Write a formal EU261 compensation claim per Regulation (EC) No 261/2004. Use the correct distance-based compensation tier: €250 (up to 1,500km), €400 (1,500-3,500km or long intra-EU flights), €600 (over 3,500km) based on distance_km. If cause is airline-controlled, assert the claim firmly; if weather/ATC, note the airline may invoke extraordinary circumstances and frame the claim accordingly without guaranteeing the outcome. State clearly that technical/crew issues are NOT extraordinary circumstances per established case law. Do not recommend using a third-party claims agency. Airline: {airline_name}. Flight: {flight_details}. Scenario: {scenario}. Distance: {distance_km}km. Cause: {cause}. Duty of care: {duty_of_care}. Remedy: {remedy}. Tone: professional, firm, factual.",
  },
  'eu-baggage-claim-montreal': {
    title: 'EU Baggage Claim Letter (Montreal Convention)',
    // Real Gumroad product_id for the "eu-baggage-claim-montreal" product.
    gumroad_product_id: 'dkgscf',
    // STATIC as of 2026-09-19 (Batch 6: Flights & Travel / Delivery &
    // Parcels / Healthcare & Medical) -- prompt_template below is now
    // DEAD CODE.
    static: true,
    render: renderEuBaggageClaimMontreal,
    prompt_template:
      "Write a formal baggage claim under the Montreal Convention. Reference the current liability cap of 1,519 SDR per passenger (approx €2,000, noting the exact euro value fluctuates with the SDR exchange rate — do not assert one fixed euro figure). For damaged baggage, note the 7-day filing deadline from delivery. For lost baggage, note the 21-day threshold at which it's legally considered lost rather than delayed. State clearly this is reimbursement of demonstrated value, not a flat payout. Airline: {airline_name}. Flight: {flight_details}. Issue: {issue}. PIR filed: {pir_filed}. Itemized value: {itemized_value}. Tone: professional, factual.",
  },
  'eu-train-delay-claim': {
    title: 'EU Train Delay Compensation Claim',
    // Real Gumroad product_id for the "eu-train-delay-claim" product.
    gumroad_product_id: 'preig',
    // STATIC as of 2026-09-19 (Batch 6: Flights & Travel / Delivery &
    // Parcels / Healthcare & Medical) -- prompt_template below is now
    // DEAD CODE. Numeric-tier parsing (delay_minutes) implemented via
    // parsePlainNumber()/staticValidationError() per the approved Option A
    // plan -- see numeric-parsing-plan.md.
    static: true,
    render: renderEuTrainDelayClaim,
    prompt_template:
      "Write a formal EU rail delay compensation claim per Regulation (EU) 2021/782. Use the correct tier: 25% refund (60-119 min delay) or 50% refund (120+ min delay) based on delay_minutes. Note that if cause is force majeure, cash compensation may not apply, but the duty-of-care obligation (food, accommodation) still applies regardless of cause — frame accordingly. If missed_connection is Yes, assert the right to free rerouting on the next available train, including a partner operator, or alternative transport. Operator: {operator_name}. Journey: {journey_details}. Delay: {delay_minutes} min. Cause: {cause}. Missed connection: {missed_connection}. Duty of care: {duty_of_care}. Tone: professional, factual.",
  },
  'eu-package-holiday-complaint': {
    title: 'EU Package Holiday Complaint & Compensation Claim',
    // Real Gumroad product_id for the "eu-package-holiday-complaint" product.
    gumroad_product_id: 'ubqkuu',
    // STATIC as of 2026-09-19 (Batch 6: Flights & Travel / Delivery &
    // Parcels / Healthcare & Medical) -- prompt_template below is now
    // DEAD CODE.
    static: true,
    render: renderEuPackageHolidayComplaint,
    prompt_template:
      "Write a formal complaint to a package travel organiser per Directive (EU) 2015/2302. State the organiser is fully liable for every service in the package, not individual suppliers. If issue is a significant pre-departure change, assert the right to reject it and receive a full refund within 14 days. If non-conformity at destination, request equivalent alternative arrangements or a proportionate price reduction. If insolvency, reference the mandatory insolvency protection insurance and the right to free repatriation. Note this only applies if the booking qualifies as a 'package' under the directive (two or more linked travel services sold together) — flag this as worth confirming if unclear. Agency: {agency_name}. Trip: {trip_details}. Issue: {issue}. Details: {details}. Remedy: {remedy}. Tone: professional, firm, factual.",
  },
  'eu-bank-complaint-finnet': {
    title: 'Bank Complaint Letter (EU / PSD2 / FIN-NET)',
    // Real Gumroad product_id for the "eu-bank-complaint-finnet" product.
    gumroad_product_id: 'jceka',
    // STATIC as of 2026-09-17 (Batch 1: Financial & Banking) -- prompt_template
    // below is now DEAD CODE, kept unused per the established convention.
    static: true,
    render: renderEuBankComplaintFinnet,
    prompt_template:
      "Write a formal complaint letter to a European bank. If escalation_stage is 'Filing the first complaint', title it explicitly 'Formal Complaint under the Payment Services Directive' if issue is payment-service related, and note the bank has 15 business days (extendable to 35 in exceptional cases) to respond if this applies. If escalation_stage is 'didn't respond' or 'unsatisfactory', state the complainant intends to escalate via FIN-NET to their national financial ombudsman. Do not claim FIN-NET decisions are universally binding — phrase as a strong, free escalation path rather than a guaranteed legal outcome. Bank: {bank_name}. Issue: {issue}. Details: {details}. Stage: {escalation_stage}. Remedy: {remedy}. Tone: professional, firm, factual.",
  },
  'eu-sepa-recall-request': {
    title: 'SEPA Recall Request Letter',
    // Real Gumroad product_id for the "eu-sepa-recall-request" product.
    gumroad_product_id: 'qawzs',
    // STATIC as of 2026-09-17 (Batch 1: Financial & Banking) -- prompt_template
    // below is now DEAD CODE, kept unused per the established convention.
    static: true,
    render: renderEuSepaRecallRequest,
    prompt_template:
      "Write a formal SEPA Recall request to a bank. Reference the standard SEPA scheme rulebook recall framework — request initiated within a reasonable window (commonly cited as around 10 business days), noting the receiving bank typically has around 15 business days to respond. State clearly the receiving bank cannot withdraw funds from the recipient's account without their consent unless fraud or a technical error is shown. If vop_shown indicates VoP wasn't offered or failed, separately note this may support a compensation claim against the sending bank under the Instant Payments Regulation, distinct from the recall itself. Bank: {bank_name}. Transfer: {transfer_details}. Basis: {basis}. VoP: {vop_shown}. Details: {details}. Tone: professional, factual, urgent but not alarmist.",
  },
  'eu-unauthorised-transaction-psd2': {
    title: 'Unauthorised Transaction Refund Demand (PSD2)',
    // Real Gumroad product_id for the "eu-unauthorised-transaction-psd2" product.
    gumroad_product_id: 'zdjykv',
    // STATIC as of 2026-09-17 (Batch 1: Financial & Banking) -- prompt_template
    // below is now DEAD CODE, kept unused per the established convention.
    static: true,
    render: renderEuUnauthorisedTransactionPsd2,
    prompt_template:
      "Write a formal PSD2 unauthorised transaction refund demand. If sca_used is 'No' or 'Not sure', assert liability shifts to the bank/merchant for failing to require SCA. Cite the €50 maximum liability cap for losses before the transaction was reported, and zero liability for anything after reporting. Demand restitution 'by no later than the end of the following business day' after notification, per PSD2. Do NOT reference PSD3 as if it's already in force — PSD2 is the current governing law. Bank: {bank_name}. Transaction: {transaction_details}. SCA used: {sca_used}. Reported: {reported_date}. Loss before report: {loss_before_report}. Tone: professional, firm, factual.",
  },
  'eu-gdpr-rights-request': {
    title: 'GDPR Rights Request Letter (Access / Erasure / Complaint)',
    // Real Gumroad product_id for the "eu-gdpr-rights-request" product.
    gumroad_product_id: 'pnpwzz',
    // STATIC as of 2026-09-17 (pilot batch 3/4) -- prompt_template below is
    // now DEAD CODE, kept unused per the same convention as the other pilot
    // generators. (Originally logged as "4/4" -- corrected: healthcare-
    // complaint-letter was skipped by mistake and is the true 4th.)
    static: true,
    render: renderEuGdprRightsRequest,
    prompt_template:
      "Write a formal GDPR rights request letter matching request_type. For Access requests, cite Article 15 and request purposes of processing, categories of data, recipients, and retention period. For Erasure requests, cite Article 17, using the phrase 'I hereby exercise my Right to Erasure under Article 17 of the GDPR'. For both Access and Erasure, note the response deadline is one month, extendable by up to two further months for complex requests provided the company notifies the requester within the first month — do NOT describe this deadline as non-extendable or absolute. For a DPO complaint, frame it as the required pre-escalation step before a formal DPA complaint, referencing a 30-day response expectation before escalating. Company: {company_name}. Request type: {request_type}. Details: {details}. Prior contact: {prior_contact}. Tone: professional, firm, factual.",
  },
  'eu-gdpr-violation-report': {
    title: 'GDPR Violation Report / Whistleblower Notice',
    // Real Gumroad product_id for the "eu-gdpr-violation-report" product.
    gumroad_product_id: 'covqc',
    // STATIC as of 2026-09-17 (Batch 2: Legal & Contracts / Privacy & Data /
    // Public Services) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderEuGdprViolationReport,
    prompt_template:
      "Write a formal GDPR violation report suitable for submission to a national Data Protection Authority. If reporter_role is 'Employee/contractor', reference protections under the EU Whistleblower Directive (2019/1937) against retaliation. Reference the 72-hour breach notification duty under Article 33 where relevant. Do not encourage the reporter to unlawfully exfiltrate bulk data belonging to others as evidence — advise gathering evidence within lawful means. If anonymity_preference is 'Anonymous', note that fully anonymous reports may limit the regulator's ability to follow up with clarifying questions. Organisation: {organisation_name}. Role: {reporter_role}. Violation type: {violation_type}. Details: {details}. Anonymity: {anonymity_preference}. Tone: professional, factual, serious.",
  },
  'eu-platform-dispute-letter': {
    title: 'Marketplace/Platform Dispute Letter (Amazon/Booking/Airbnb/PayPal)',
    // Real Gumroad product_id for the "eu-platform-dispute-letter" product.
    gumroad_product_id: 'echmjl',
    // STATIC as of 2026-09-17 (Batch 3: Shipping/Shopping/Subscriptions/
    // Training -- final batch) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderEuPlatformDisputeLetter,
    prompt_template:
      "Write a formal dispute letter tailored to the selected platform. For Amazon: invoke the 14-day withdrawal right or 2-year legal guarantee as applicable, and the A-to-z Guarantee as Amazon's own escalation layer — do NOT reference the discontinued EU ODR platform; if escalation beyond Amazon is needed, reference ECC-Net or national ADR bodies instead. For Booking.com: if booking_type is 'Package/linked booking', invoke Directive (EU) 2015/2302's alternative accommodation mandate; if 'Standalone hotel booking', frame this as a general breach-of-contract claim against the hotel, NOT the codified package travel relocation right. For Airbnb: reference the Guest Refund Policy and note the 72-hour reporting window is Airbnb's own policy, not EU statute, while price/description accuracy is grounded in EU unfair commercial practices law. For PayPal: reference Buyer Protection's 180-day dispute window and 20-day negotiation period as PayPal's own program rules, and note the CSSF Luxembourg escalation path if internal arbitration is unfair. Platform: {platform}. Booking type: {booking_type}. Issue: {issue}. Transaction: {transaction_details}. Remedy: {remedy}. Tone: professional, firm, factual.",
  },
  'eu-subscription-cancellation-demand': {
    title: 'Subscription Cancellation & Refund Demand Letter (EU)',
    // Real Gumroad product_id for the "eu-subscription-cancellation-demand" product.
    gumroad_product_id: 'zyuop',
    // STATIC as of 2026-09-17 (Batch 3: Shipping/Shopping/Subscriptions/
    // Training -- final batch) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderEuSubscriptionCancellationDemand,
    prompt_template:
      "Write a formal EU subscription cancellation/refund letter. If scenario is 'Still within my 14-day withdrawal window', invoke Directive (EU) 2023/2673's withdrawal right and request a pro-rata refund. If scenario is 'Trying to cancel an ongoing subscription (past 14 days)', note that a cancellation-button law applies in some member states (e.g. Germany, France) but is NOT yet uniform EU law — request cancellation citing the company's own terms and, if the country field matches Germany or France, their specific national cancellation-button law. If scenario is 'Charged for a renewal I wasn't properly notified about', invoke national consumer protection law citing lack of pre-contractual transparency, without asserting a single EU-wide notice period (varies by member state, commonly 15-30 days where a national law exists). If remedy involves revoking a payment mandate, reference the right under PSD2 to do so via the consumer's own bank. Do not present the cancellation button as EU-wide law outside the 14-day withdrawal context. Company: {company_name}. Country: {country}. Scenario: {scenario}. Sign-up date: {signup_date}. Details: {details}. Remedy: {remedy}. Tone: professional, firm, factual.",
  },
  'flight-disruption-compensation-reimbursement': {
    title: 'Flight Disruption Compensation & Reimbursement Letter',
    // Real Gumroad product_id for the "flight-disruption-compensation-reimbursement" product.
    gumroad_product_id: 'tnyor',
    // STATIC as of 2026-09-19 (Batch 6: Flights & Travel / Delivery &
    // Parcels / Healthcare & Medical) -- prompt_template below is now
    // DEAD CODE.
    static: true,
    render: renderFlightDisruptionCompensationReimbursement,
    prompt_template:
      "Write a formal flight disruption letter combining a statutory compensation claim and/or an expense reimbursement demand, based on jurisdiction and scenario. If jurisdiction is 'EU (EU261)': cite Regulation (EC) 261/2004, state compensation of €250/€400/€600 depending on distance (do not calculate the exact distance-based figure yourself — instruct the reader to confirm the correct tier), and note compensation does not apply if the airline proves 'extraordinary circumstances'. If jurisdiction is 'UK (UK261)': cite UK261, use the same tiered logic in GBP equivalents (£220/£350/£520), and note the 6-year claim deadline (5 years in Scotland). If jurisdiction is 'US (DOT rules)': note the US has no fixed cash compensation scheme equivalent to EU261/UK261, and instead reference the automatic cash refund entitlement under 14 CFR 259.5 for a cancelled or significantly changed flight, phrased cautiously as an area with less standardised compensation than EU/UK. If jurisdiction is 'Australia (ACL)': note that Australia has no dedicated flight compensation regulation equivalent to EU261, and any claim rests on general Australian Consumer Law grounds (was the service provided with due care, was the delay reasonably avoidable) — phrase this cautiously and do not invent a specific compensation figure. If jurisdiction is 'Not sure': ask the reader to confirm before the letter is finalized, and default to the most cautious general framing. If scenario is 'Baggage lost, damaged, or delayed — no other disruption', do not reference flight delay/cancellation compensation at all — write purely a baggage claim letter referencing the Montreal Convention's 1,519 SDR per-passenger liability cap (noting this is a cap, not a guaranteed payout, and does not apply if a special value declaration was made and a higher fee paid). If baggage_issue is anything other than 'No' AND scenario is a flight disruption scenario, add a distinct paragraph covering the baggage claim on top of the disruption claim, keeping the two legally separate. If duty_of_care_provided indicates the airline did not provide adequate care, add a paragraph demanding reimbursement of the specific out-of-pocket expenses described, framed as separate from and additional to any statutory compensation. Never state a specific compensation figure with false confidence when jurisdiction is US, Australia, or Not sure. Airline: {airline_name}. Booking: {booking_reference}. Flight: {flight_details}. Scenario: {scenario}. Reason given: {reason_given}. Baggage: {baggage_issue} — {baggage_details}. Duty of care: {duty_of_care_provided} — {out_of_pocket_expenses}. Remedy sought: {remedy_sought}. Tone: professional, firm, factual.",
  },
  'unpaid-wage-compensation-demand': {
    title: 'Unpaid Wage & Compensation Demand Letter',
    // Real Gumroad product_id for the "unpaid-wage-compensation-demand" product.
    gumroad_product_id: 'sbadbs',
    // STATIC as of 2026-09-18 (Batch 4: Employment + Subscriptions &
    // Services) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderUnpaidWageCompensationDemand,
    prompt_template:
      "Write a formal unpaid wage/compensation demand letter matching the reason selected. For 'Unpaid trial shift': note that in most jurisdictions, if the worker performed productive work rather than pure observation/shadowing, wage laws generally require payment regardless of the word 'trial' or 'unpaid' in the arrangement — phrase this as a general principle, not a jurisdiction-specific citation, since trial shift rules vary by location. For 'Mandatory training time': note that time an employer requires an employee to spend in training is generally compensable work time under most wage laws, distinct from truly voluntary, non-required training. For 'Overtime hours': request the specific overtime premium calculation without asserting a specific jurisdiction's overtime rate or threshold unless the person's location is known. Do not state a specific legal citation or statute for any reason unless jurisdiction is clear from context — keep legal framing general ('wage protection laws in most jurisdictions require...') rather than citing a specific act. Employer: {employer_name}. Reason: {reason}. Amount: {amount_owed}. Period: {period_covered}. Details: {details}. Prior contact: {prior_contact}. Tone: professional, firm, factual.",
  },
  'wrongful-wage-deduction-letter': {
    title: 'Wrongful/Unlawful Wage Deduction Letter',
    // Real Gumroad product_id for the "wrongful-wage-deduction-letter" product.
    gumroad_product_id: 'ozzcfn',
    // STATIC as of 2026-09-18 (Batch 4: Employment + Subscriptions &
    // Services) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderWrongfulWageDeductionLetter,
    prompt_template:
      "Write a formal letter disputing a wage deduction. Note that in most jurisdictions, deductions from wages generally require the employee's prior written consent and/or specific legal authorization, and blanket 'shortage' or 'damage' deductions taken without due process are frequently unlawful — phrase this as a general principle across jurisdictions, not a specific statute citation, since wage deduction law varies significantly by location. If consent_given is 'No' or 'Not sure', emphasize the lack of valid authorization as the central issue. Request full repayment of the deducted amount within a reasonable timeframe (e.g. 14 days) and reference the employee's right to escalate to a labor authority if unresolved. Employer: {employer_name}. Deduction reason: {deduction_reason}. Amount: {amount_deducted}. Consent given: {consent_given}. Details: {details}. Tone: professional, firm, factual.",
  },
  'employment-reference-request': {
    title: 'Employment Reference Request',
    // Real Gumroad product_id for the "employment-reference-request" product.
    gumroad_product_id: 'ehhenj',
    // STATIC as of 2026-09-18 (Batch 4: Employment + Subscriptions &
    // Services) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderEmploymentReferenceRequest,
    prompt_template:
      "Write a formal, polite but firm request for an employment reference from a former employer. Note that in most jurisdictions employers are NOT legally required to provide anything beyond confirming dates of employment and job title, unless a specific contractual or jurisdiction-specific obligation applies — do not assert a legal entitlement to a full reference. Frame the letter as a professional request rather than a demand, since there is generally no enforceable right being invoked here, with an exception noted only if the refusal_context suggests retaliation for a protected complaint (e.g. discrimination, whistleblowing), in which case add a cautious note that retaliatory reference refusal may raise separate legal issues worth discussing with an employment lawyer. Former employer: {former_employer}. Role: {job_title}. Context: {refusal_context}. Urgency: {urgency}. Tone: professional, courteous, direct.",
  },
  'constructive-dismissal-complaint': {
    title: 'Constructive Dismissal Complaint Letter',
    // Real Gumroad product_id for the "constructive-dismissal-complaint" product.
    gumroad_product_id: 'hfiygj',
    // STATIC as of 2026-09-18 (Batch 4: Employment + Subscriptions &
    // Services) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderConstructiveDismissalComplaint,
    prompt_template:
      "Write a formal letter documenting the case for constructive dismissal (or, if country is 'United States', use the term 'constructive discharge' instead throughout, and note this is a doctrine applied case-by-case rather than a codified statute, distinct from the UK/Australia/EU concept of constructive dismissal). Emphasize that the employer's conduct must be objectively serious enough that a reasonable person in the employee's position would have no reasonable alternative but to resign — mere unhappiness or a single minor grievance does not qualify. If country is 'United Kingdom', note that UK unfair dismissal claims generally require at least two years of continuous employment, and flag this as something to verify before proceeding. If prior_complaints indicates the employee never raised the issue before resigning, note this may weaken the claim, since most jurisdictions expect the employee to have given the employer a chance to address the conduct, or to show why doing so was clearly futile. If pattern_or_incident is 'Pattern of incidents', instruct the letter to lay out a clear chronological timeline of the pattern rather than treating it as one event. Advise the employee to resign promptly after the triggering conduct or shortly after raising it without resolution, since delay can be read as acceptance of the conditions. Do not guarantee a specific legal outcome or cite a specific statute number. Employer: {employer_name}. Country: {country}. Conduct: {conduct_description}. Pattern: {pattern_or_incident}. Prior complaints: {prior_complaints}. Resignation date: {resignation_date}. Tone: professional, serious, factual — this is a formal legal document, not an emotional appeal.",
  },
  'workplace-harassment-complaint': {
    title: 'Workplace Harassment Complaint Letter',
    // Real Gumroad product_id for the "workplace-harassment-complaint" product.
    gumroad_product_id: 'kjxsaj',
    // STATIC as of 2026-09-18 (Batch 4: Employment + Subscriptions &
    // Services) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderWorkplaceHarassmentComplaint,
    prompt_template:
      "Write a formal harassment complaint letter addressed to HR. If harassment_type is 'Discriminatory harassment', explicitly frame the complaint around the relevant protected characteristic to preserve any anti-discrimination legal protections, without naming a specific statute unless jurisdiction is known. If harassment_type is 'Retaliation after a prior complaint', frame retaliation as a distinct and often more serious issue than the original complaint, since retaliation protections exist independently in most jurisdictions. Request a specific, timely response (e.g. within 5-10 business days) and a description of the investigation process. If prior_reports indicates this was already reported without action, state this clearly and note that continued inaction may itself be a separate issue. Advise the employee to keep a copy of this letter and any response. Company: {company_name}. Person involved: {harasser_role}. Nature: {harassment_type}. Details: {incident_details}. Witnesses: {witnesses}. Prior reports: {prior_reports}. Tone: professional, serious, factual.",
  },
  'flexible-working-request': {
    title: 'Flexible Working Request',
    // Real Gumroad product_id for the "flexible-working-request" product.
    gumroad_product_id: 'jmyyim',
    // STATIC as of 2026-09-18 (Batch 4: Employment + Subscriptions &
    // Services) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderFlexibleWorkingRequest,
    prompt_template:
      "Write a formal flexible working request letter. If country is 'United Kingdom', note that UK employees generally have a statutory right to REQUEST flexible working from day one of employment, though the employer can still refuse for specified business reasons — the right is to make the request and receive a considered response, not an automatic entitlement to the arrangement itself. If country is 'Australia', note the National Employment Standards give certain eligible employees (e.g. parents, carers, employees with disability, older workers) a right to request flexible working arrangements, with similar limits. If country is 'United States', note there is no general federal right to request flexible working — this is a workplace request, not a legal entitlement, though it may still be reasonable to request in writing, and add that this differs for accommodation requests tied to disability (ADA) which follow a separate legal process not covered by this general letter. If country is 'Other/not sure', keep the framing general and advise the employee to check local law. Present the specific proposed arrangement clearly and offer to discuss a trial period. Employer: {employer_name}. Request type: {request_type}. Reason: {reason}. Proposed arrangement: {proposed_arrangement}. Country: {country}. Tone: professional, collaborative, clear.",
  },
  'employment-data-access-request': {
    title: 'Employment Data Access Request (GDPR/Privacy)',
    // Real Gumroad product_id for the "employment-data-access-request" product.
    gumroad_product_id: 'vsnrks',
    // STATIC as of 2026-09-18 (Batch 4: Employment + Subscriptions &
    // Services) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderEmploymentDataAccessRequest,
    prompt_template:
      "Write a formal data access/deletion/complaint letter matching request_type. If country is 'European Union' or 'United Kingdom', cite GDPR/UK GDPR Article 15 (access) or Article 17 (erasure) as applicable, and note the standard one-month response deadline, extendable to three months for complex requests with proper notice. If request_type is 'Complaint: CV shared without authorization', frame this as a potential violation of data minimization/purpose limitation principles under GDPR (if EU/UK) or as a general privacy complaint otherwise, and request confirmation of who the data was shared with and why. If country is 'United States', note there is no single federal equivalent to GDPR — reference relevant state privacy laws only in general terms (e.g. 'your state's privacy law, if applicable') without citing a specific act unless the person's state is known, and frame the request as a general privacy request rather than a GDPR-based legal right. If country is 'Australia', reference the Privacy Act 1988 and Australian Privacy Principles in general terms. If relationship is 'Former employee' and request_type involves deletion, note that employers may have independent legal retention obligations (tax, employment records) that can limit full deletion even where a privacy law otherwise permits it — do not promise complete erasure will necessarily be granted. Organisation: {organisation_name}. Relationship: {relationship}. Request type: {request_type}. Details: {details}. Country: {country}. Tone: professional, firm, factual.",
  },
  'source-of-funds-package-generator': {
    title: 'Source of Funds Package Generator',
    // Real Gumroad product_id for the "source-of-funds-package-generator" product.
    gumroad_product_id: 'bvltq',
    // STATIC as of 2026-09-19 (Batch 7: FINAL batch -- Cars & Vehicles /
    // Crypto & Fintech / Food & Hospitality / Insurance & Claims / Training
    // & Education) -- prompt_template below is now DEAD CODE. Redesigned
    // frontend field set (scenario selector + structured per-scenario
    // fields, replacing the old primary_category/secondary_categories/
    // timeline_details) -- see generators-static-migration-inventory.md.
    static: true,
    render: renderSourceOfFundsPackageGenerator,
    prompt_template:
      "Generate a complete Source of Funds compliance package, not just a single letter. Structure the output in these sections: (1) A cover letter addressed to {institution_name}'s compliance team, professional and cooperative in tone, stating the total amount under review and referencing that this package is submitted to support their AML/KYC review. (2) A chronological timeline of the funds' origin and movement, built from {timeline_details}, presented as a dated list. (3) An income/source breakdown table listing each source category that applies (from primary_category and secondary_categories) with approximate amounts. (4) A plain-language explanation of the origin of the capital, written in first person as if from the account holder, tying the categories and timeline together into one coherent narrative rather than disconnected facts. (5) A final checklist of exactly which supporting documents should be attached for each category claimed, cross-referencing {documents_available} and flagging anything commonly requested that the person hasn't mentioned having. If prior_contact indicates the account is currently frozen, adjust the cover letter's tone to note the account restriction and request a response timeline, without being confrontational. Never claim this package guarantees the review will be resolved favorably — frame it as organizing the strongest possible case, not a guaranteed outcome. Institution: {institution_name}. Amount: {amount_in_question}. Primary category: {primary_category}. Additional sources: {secondary_categories}. Timeline: {timeline_details}. Documents available: {documents_available}. Status: {prior_contact}. Tone: professional, thorough, cooperative.",
  },
  'exchange-account-freeze-response': {
    title: 'Exchange Account Freeze/Lockout Response Letter',
    // Real Gumroad product_id for the "exchange-account-freeze-response" product.
    gumroad_product_id: 'inkhin',
    // STATIC as of 2026-09-19 (Batch 7: FINAL batch) -- prompt_template
    // below is now DEAD CODE.
    static: true,
    render: renderExchangeAccountFreezeResponse,
    prompt_template:
      "Write a formal response letter to a cryptocurrency exchange regarding a frozen or restricted account. If freeze_reason_given is 'No reason given at all' or 'Generic compliance review', explicitly request the specific reason for the restriction and cite the exchange's own terms of service obligation to provide this (most exchange terms require disclosure of the general nature of a hold, even if full compliance details can't be shared). If freeze_reason_given is 'Source of funds/AML review requested', reference that supporting documentation is being prepared and ask for the specific list of documents the compliance team requires, and the expected review timeframe. If freeze_reason_given is 'Suspected account compromise', request confirmation of what security concern triggered the hold and what specific verification is needed to lift it. Request a clear timeline for resolution, and note that prolonged, unexplained freezes may warrant escalation to the exchange's relevant national regulator if unresolved within a reasonable period (do not name a specific regulator unless jurisdiction is known — keep this general). Do not encourage aggressive or threatening language; keep the letter firm but constructive, since cooperative tone tends to move compliance reviews faster than confrontational ones. Exchange: {exchange_name}. Reason given: {freeze_reason_given}. Freeze date: {freeze_date}. Amount affected: {amount_affected}. Communication so far: {communication_so_far}. Urgency: {urgency_factors}. Tone: firm, professional, cooperative.",
  },
  'crypto-complaint-generator': {
    title: 'Crypto Complaint Generator',
    // Real Gumroad product_id for the "crypto-complaint-generator" product.
    gumroad_product_id: 'hbmkox',
    // STATIC as of 2026-09-19 (Batch 7: FINAL batch) -- prompt_template
    // below is now DEAD CODE. Country x problem_type routing resolved as a
    // closed lookup table in cryptoComplaintRouting() -- see
    // static-generators-phase1-sample.md for the 1:1 routing-table source.
    static: true,
    render: renderCryptoComplaintGenerator,
    prompt_template:
      "Generate a formal complaint letter, routed to the correct regulator(s) based on country AND problem_type — do not assume a single regulator per country, since especially in the US multiple agencies have narrow, non-overlapping jurisdiction. Routing logic: UNITED STATES — for 'Suspected fraud or scam' or 'Misleading marketing', direct the complaint to the FTC (ReportFraud.ftc.gov) and note the SEC's complaint portal as an additional option if the problem involves what could be an unregistered securities offering; for 'Exchange won't release my funds' or 'Unauthorized transaction', direct to FinCEN's complaint channel if it's a suspected AML/registration issue, and separately note the CFPB for bank-related crypto disputes; for 'Bank refused/closed my account', direct to the CFPB and the OCC if a national bank is involved; explicitly state that the US has no single crypto complaint regulator and the right agency depends on the specific issue. UNITED KINGDOM — direct to the FCA for most complaints, noting the Financial Ombudsman Service (FOS) as the individual dispute resolution path if the FCA-regulated firm doesn't resolve it directly. EUROPEAN UNION — direct to the national competent authority in the person's own member state responsible for MiCA enforcement (do not name a specific single EU-wide crypto regulator, since MiCA enforcement is delegated to national authorities), and note the relevant national financial ombudsman for individual disputes. AUSTRALIA — direct to ASIC for most complaints, noting AFCA (Australian Financial Complaints Authority) as the individual dispute resolution path, and Scamwatch/ACCC specifically for suspected scams rather than regulatory/licensing complaints. If country is 'Other/not sure', keep the letter general and advise the person to identify their national financial regulator before submitting. If prior_contact indicates no direct contact yet, recommend contacting the company directly first before regulatory escalation, unless problem_type is 'Suspected fraud or scam', where direct regulatory/law enforcement reporting takes priority over trying to resolve it with a likely-fraudulent entity. Company/entity: {entity_name}. Problem: {problem_type}. Amount: {amount_involved}. Details: {details}. Prior contact: {prior_contact}. Country: {country}. Tone: professional, factual, firm.",
  },
  'restaurant-policies-generator': {
    title: 'Restaurant Policies Generator',
    // Gumroad short-code product_id for the "restaurant-policies-generator" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/oblszp -> .../l/restaurant-policies-generator).
    gumroad_product_id: 'oblszp',
    // STATIC as of 2026-09-19 (Batch 7: FINAL batch) -- prompt_template
    // below is now DEAD CODE. Redesigned frontend field set (7 structured
    // per-policy_type field groups, replacing the old open policy_details
    // textarea) -- see generators-static-migration-inventory.md.
    static: true,
    render: renderRestaurantPoliciesGenerator,
    prompt_template:
      "Generate a clear, professional {policy_type} for a restaurant called {restaurant_name} ({restaurant_type}). Use these specifics the restaurant provided: {policy_details}. Write in plain, customer-facing language suitable to post on the restaurant's own website or print for guests. This is a policy document meant to carry the restaurant's own name, not Kibbo's — do not add any Kibbo branding, letterhead, date, recipient address block, or signature line. Include a brief closing note that local consumer protection laws may impose additional requirements the restaurant should verify independently. Format with clear headers, no legal jargon.",
  },
  'food-recall-action-plan-generator': {
    title: 'Food Recall Action Plan Generator',
    // Gumroad short-code product_id for the "food-recall-action-plan-generator" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/heasbt -> .../l/food-recall-action-plan-generator).
    gumroad_product_id: 'heasbt',
    // STATIC as of 2026-09-19 (Batch 7: FINAL batch) -- prompt_template
    // below is now DEAD CODE.
    static: true,
    render: renderFoodRecallActionPlanGenerator,
    prompt_template:
      "Generate a food safety incident action plan for {restaurant_name} regarding {product_affected}, discovered via {source} ({supplier_or_internal}). Already served to customers: {served}. If served, approximate date range and covers affected: {served_details}. Incident manager: {contact_person}. Produce four clearly headed sections: (1) Internal Protocol — immediate containment steps; (2) Withdrawal Checklist — physical removal from kitchen, storage, menu, and delivery platforms, formatted as a checklist suitable to print and post in a kitchen; (3) Communication Templates — a short template for affected customers and, if applicable, a short template for the local food safety authority; (4) Incident Log — a dated table template (columns: Date/Time, Action Taken, Staff Member, Notes) for recording actions as they happen. Keep language calm, procedural, and non-alarmist but clear about urgency. This is an internal operational document, not a letter to a third party — do not add a date, address block, or signature line for the document as a whole.",
  },
  'allergen-menu-labeling-generator': {
    title: 'Allergen Menu Labeling Generator',
    // Gumroad short-code product_id for the "allergen-menu-labeling-generator" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/votobg -> .../l/allergen-menu-labeling-generator).
    gumroad_product_id: 'votobg',
    // STATIC as of 2026-09-19 (Batch 7: FINAL batch) -- prompt_template
    // below is now DEAD CODE. Uses a static, jurisdiction-specific
    // keyword-match table (built + Carlos-approved 2026-09-16) instead of
    // AI classification -- see batch-1.md / batch-1-addendum.md.
    static: true,
    render: renderAllergenMenuLabelingGenerator,
    prompt_template:
      "You are labeling a restaurant menu for {restaurant_name} for allergen disclosure under {jurisdiction} requirements. For each dish below, identify which allergens from that jurisdiction's official allergen list are present based on the ingredients given, and err on the side of flagging a possible allergen if an ingredient is ambiguous. Dishes and ingredients: {menu_input}. Output a table with these exact columns: Dish Name | Allergens Present | Notes. Cross-contamination risk in the kitchen: {cross_contamination} — if Yes, add a short general cross-contact warning notice after the table; if No, omit it. Always end with this exact disclaimer on its own line: \"Generated based on ingredients provided by the restaurant — always verify with your supplier's ingredient documentation. This does not replace professional regulatory review.\" This is a printable menu insert, not a letter — do not add a date, address block, or signature line.",
  },
  'formal-complaint-generator': {
    title: 'Formal Complaint Generator',
    // Gumroad short-code product_id for the "formal-complaint-generator" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/tedlq -> .../l/formal-complaint-generator).
    gumroad_product_id: 'tedlq',
    // STATIC as of 2026-09-17 (Batch 3: Shipping/Shopping/Subscriptions/
    // Training -- final batch) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderFormalComplaintGenerator,
    prompt_template:
      "Generate a clear, formal complaint letter from {your_name} to {provider_name} regarding {course_name}, purchased/enrolled on {enrollment_date} for {amount_paid}. The problem type selected by the user is: {problem_type}. Specific details of what happened: {problem_details}. State clearly what resolution is being requested: {desired_outcome}. Tailor the letter's focus to the selected problem type — for example, an institution closure complaint should center on the closure date and any alternative offered; a refund-refusal complaint should center on the original refund policy and the provider's stated reason for refusing; a misleading-advertising complaint should center on the specific claims made versus what was actually delivered; a fake/invalid certificate complaint should center on what was promised about accreditation/recognition versus what was actually true; a bootcamp complaint should center on the specific broken promise (job guarantee, curriculum, or cohort change); an online platform complaint should center on the access that was promised versus what actually happened. If the problem type is 'Linked credit/financing issues', additionally note that in many jurisdictions a linked or connected credit agreement can be legally challenged if the underlying course was cancelled, misrepresented, or not delivered — phrase this as worth raising with the credit provider and worth checking against local consumer credit law, not as a guaranteed right, since this varies significantly by country and credit type. Reference relevant consumer protection principles in general terms (without claiming to give jurisdiction-specific legal advice), and note that this letter may be escalated to a relevant regulator or ombudsman if not resolved within a reasonable timeframe. Write in a firm, professional, non-aggressive tone. Format as a proper letter with date, recipient, subject line, and closing.",
  },
  'course-provider-terms-refund-policy-generator': {
    title: 'Course Provider Terms & Refund Policy Generator',
    // Gumroad short-code product_id for the "course-provider-terms-refund-policy-generator" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/pvhywh -> .../l/course-provider-terms-refund-policy-generator).
    gumroad_product_id: 'pvhywh',
    // STATIC as of 2026-09-19 (Batch 7: FINAL batch) -- prompt_template
    // below is now DEAD CODE. Redesigned frontend field set (4 structured
    // per-document_type field groups, replacing the old open
    // document_details textarea) -- see generators-static-migration-inventory.md.
    static: true,
    render: renderCourseProviderTermsRefundPolicyGenerator,
    prompt_template:
      "Generate a clear, professional {document_type} for an education provider called {provider_name} ({provider_type}), a {program_duration} program priced via {price_model}. Use these specifics the provider gave: {document_details}. Write in plain, learner-facing language, addressed to the provider's own students/customers — this document carries the provider's own name, not Kibbo's, so do not add any Kibbo branding, letterhead, or signature line. For the Marketing Claims Disclaimer specifically: help the provider state any outcome or employment statistics accurately and avoid absolute guarantees — flag language like 'guaranteed job placement' as a legal and reputational risk unless the provider can substantiate an actual guarantee with a real refund or remedy attached to it. Include a brief closing note that local consumer protection laws may impose additional requirements the provider should verify independently. Format with clear headers, no legal jargon.",
  },
  'vendor-compensation-demand-letter': {
    title: 'Vendor Compensation Demand Letter',
    // Gumroad short-code product_id for the "vendor-compensation-demand-letter" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/fvqvcv -> .../l/vendor-compensation-demand-letter).
    gumroad_product_id: 'fvqvcv',
    // STATIC as of 2026-09-19 (Batch 6: Flights & Travel / Delivery &
    // Parcels / Healthcare & Medical) -- prompt_template below is now
    // DEAD CODE.
    static: true,
    render: renderVendorCompensationDemandLetter,
    prompt_template:
      "Generate a clear, formal demand letter from {your_name} to {vendor_name} — the SELLER/VENDOR, not the carrier — regarding order {order_reference}, placed on {order_date} for {amount_paid}. The specific issue is: {scenario}. If scenario is 'Lost parcel (never arrived, or tracking shows no movement)': the last tracking update was {last_tracking_update}, with {days_since_movement} days since any tracking movement, carried by {carrier_used}; carrier confirmed the parcel lost: {carrier_confirmed_lost}. If scenario is 'Damaged parcel (arrived damaged, or contents damaged)': damage was discovered on {damage_discovered_date}, described as: {damage_description}; photos available: {photos_available}; original packaging kept: {packaging_kept}. If scenario is 'Late delivery (arrived significantly after promised date)': the promised/estimated delivery date was {promised_delivery_date}, actual delivery was {actual_delivery_date} (or the parcel has not yet arrived), and the specific harm caused by the delay was: {delay_harm}. Only reference the fields belonging to the selected scenario — ignore the fields for the other two scenarios entirely, and never write 'Not applicable' or 'N/A' into the letter itself. State clearly what resolution is being requested: {desired_outcome}. Reference the general principle that a seller remains responsible for successful delivery of goods to the consumer, without asserting jurisdiction-specific legal citations unless explicitly confident they apply. Note that this letter may be escalated to a card chargeback or relevant consumer authority if not resolved within a reasonable timeframe. Write in a firm, professional, non-aggressive tone. Format as a proper letter with date, recipient, subject line, and closing.",
  },
  'courier-complaint-generator': {
    title: 'Courier Complaint Generator',
    // Gumroad short-code product_id for the "courier-complaint-generator" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/tepzr -> .../l/courier-complaint-generator).
    gumroad_product_id: 'tepzr',
    // STATIC as of 2026-09-19 (Batch 6: Flights & Travel / Delivery &
    // Parcels / Healthcare & Medical) -- prompt_template below is now
    // DEAD CODE.
    static: true,
    render: renderCourierComplaintGenerator,
    prompt_template:
      "Generate a formal complaint letter from {your_name} to {carrier} — the CARRIER/COURIER, not the seller — regarding tracking number {tracking_number}, addressing a {issue_type} issue. If issue_type is 'Lost': the last tracking update was {last_tracking_update}. If issue_type is 'Damaged': the damage is described as: {damage_description}. If issue_type is 'Delayed': the promised/estimated delivery date was {promised_delivery_date} and the actual delivery date was {actual_delivery_date} (or the parcel has not yet arrived). If issue_type is 'Delivered to wrong address', state this plainly and request confirmation of the correct delivery location and next steps. Only reference the field(s) belonging to the selected issue type — ignore the others entirely, and never write 'Not applicable' or 'N/A' into the letter itself. This complaint is being made in {country}. Reference the carrier's own standard complaints/compensation process in general terms appropriate to {country} (e.g. UK carriers' standard claims processes, USPS/UPS/FedEx claims procedures, Australia Post's claims process) without inventing specific compensation figures unless you are confident they are current and accurate for {carrier} specifically — if uncertain, instruct the reader to check the carrier's current published limits rather than stating a figure. State the compensation being sought: {compensation_amount}. Write in a firm, professional tone. Format as a proper letter with date, recipient, subject line, and closing.",
  },
  'customs-fee-dispute-generator': {
    title: 'Customs Fee Dispute Generator',
    // Gumroad short-code product_id for the "customs-fee-dispute-generator" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/sukbsc -> .../l/customs-fee-dispute-generator).
    gumroad_product_id: 'sukbsc',
    // STATIC as of 2026-09-19 (Batch 6: Flights & Travel / Delivery &
    // Parcels / Healthcare & Medical) -- prompt_template below is now
    // DEAD CODE.
    static: true,
    render: renderCustomsFeeDisputeGenerator,
    prompt_template:
      "Generate a formal dispute letter from {your_name} to {carrier_customs_agent} regarding a customs/import charge on tracking number {tracking_number}, imported into {country_of_import}. The charge was {amount_charged}, and the sender believes the correct amount is {amount_correct}. The reason for dispute is: {dispute_reason}. If the reason is 'Other', use this additional detail: {dispute_reason_other} — otherwise ignore that field entirely and do not mention it in the letter. Request a recalculation and refund of the difference, and ask for a clear breakdown of how the original charge was calculated if one wasn't already provided. Write in a firm, professional tone. Format as a proper letter with date, recipient, subject line, and closing.",
  },

  // ---- Healthcare & Medical (first generators for this block) ----
  'healthcare-complaint-letter': {
    title: 'Healthcare Complaint Letter Generator',
    // Real Gumroad product_id for the "healthcare-complaint-letter" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/rivhvf -> .../l/healthcare-complaint-letter).
    gumroad_product_id: 'rivhvf',
    // STATIC as of 2026-09-17 (pilot batch 4/4 -- true final pilot generator;
    // this one was skipped by mistake in the earlier pass, added now to
    // complete the originally-approved 4-generator pilot list). render()
    // function pre-existed and already passed the Node harness before this
    // commit. prompt_template below is now DEAD CODE, kept unused per the
    // same convention as the other 3 pilot generators.
    static: true,
    render: renderHealthcareComplaintLetter,
    prompt_template:
      "Draft a formal, professional complaint letter from {patient_full_name} to {provider_name} regarding an incident on {incident_date}: {incident_description}. If prior informal contact was already made about this, reference it here without adequate resolution: {prior_contact_details} — otherwise ignore this field entirely and do not mention it in the letter. State the desired outcome clearly: {desired_outcome}. For jurisdiction={jurisdiction}, note that if the provider does not respond adequately, the patient may escalate to the appropriate healthcare complaints or regulatory body in their area — keep this reference generic ('the applicable healthcare complaints body in your area') unless a specific verified body applies; never invent a specific agency name. Firm but professional tone, factual, non-accusatory framing of events.",
  },
  'medical-records-request-letter': {
    title: 'Medical Records Request Letter Generator',
    // Real Gumroad product_id for the "medical-records-request-letter" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/cofgyu -> .../l/medical-records-request-letter).
    gumroad_product_id: 'cofgyu',
    // STATIC as of 2026-09-19 (Batch 6: Flights & Travel / Delivery &
    // Parcels / Healthcare & Medical) -- prompt_template below is now
    // DEAD CODE.
    static: true,
    render: renderMedicalRecordsRequestLetter,
    prompt_template:
      "Draft a formal written request from {patient_full_name} to {provider_name} for access to the following medical records: {records_requested}. If a specific date range applies, it covers: {date_range} — otherwise ignore this detail entirely. Preferred delivery format: {delivery_preference}. If a reason for the request was given and it is not 'Prefer not to say', state it as: {reason_for_request} — otherwise omit any stated reason from the letter. For jurisdiction={jurisdiction}, reference the patient's general right to access their own medical records under applicable law, without citing a specific statute unless independently verified — keep this generic ('as provided under applicable patient records access law in your area'). Request a response within a reasonable, stated timeframe. Polite, formal tone.",
  },
  'healthcare-billing-dispute-refund-letter': {
    title: 'Healthcare Billing Dispute & Refund Letter Generator',
    // Consolidated generator — covers both an incorrect/unexpected charge and a
    // cancellation refund via the 'scenario' field, branched entirely in this
    // prompt (the frontend has no conditional-field logic). Never add a separate
    // generator for a billing-issue sub-scenario — extend this branching instead.
    // Real Gumroad product_id for the "healthcare-billing-dispute-refund-letter" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/pzetved -> .../l/healthcare-billing-dispute-refund-letter).
    gumroad_product_id: 'pzetved',
    // STATIC as of 2026-09-19 (Batch 6: Flights & Travel / Delivery &
    // Parcels / Healthcare & Medical) -- prompt_template below is now
    // DEAD CODE.
    static: true,
    render: renderHealthcareBillingDisputeRefundLetter,
    prompt_template:
      "Draft a formal, firm but professional letter from {patient_full_name} to {provider_name} regarding {service_description}, amount in question {amount_in_question}. If scenario is 'Incorrect or unexpected charge on a bill': the bill shows {billed_amount} but the patient expected {expected_amount}, because: {discrepancy_reason}. Request an itemized explanation and correction of the amount within a reasonable stated period. If scenario is 'Refund after cancelling a service': the patient cancelled the service on {service_cancellation_date} and has already paid {amount_already_paid}. If cancellation/refund terms were stated to the patient, reference them: {cancellation_policy_reference} — otherwise omit any reference to stated terms. Request a full or appropriate partial refund within a reasonable stated period. Only address the field(s) belonging to the selected scenario — ignore the other scenario's fields entirely and never write 'N/A' into the letter itself. For jurisdiction={jurisdiction}, keep any reference to consumer protection or billing regulations generic unless independently verified — never invent a specific statute or deadline. Professional, factual tone throughout.",
  },
  'healthcare-insurance-appeal-letter': {
    title: 'Healthcare Insurance Appeal Letter Generator',
    // Real Gumroad product_id for the "healthcare-insurance-appeal-letter" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/ssjfcu -> .../l/healthcare-insurance-appeal-letter).
    gumroad_product_id: 'ssjfcu',
    // STATIC as of 2026-09-19 (Batch 6: Flights & Travel / Delivery &
    // Parcels / Healthcare & Medical) -- prompt_template below is now
    // DEAD CODE.
    static: true,
    render: renderHealthcareInsuranceAppealLetter,
    prompt_template:
      "Draft a formal insurance appeal letter from {policyholder_full_name} to {insurer_name} regarding claim reference {claim_reference_number}, for {denied_service_description}. The insurer's stated reason for denial was: {denial_reason_given}. The policyholder's grounds for appeal: {patient_counter_argument}. If an appeal deadline was given, note the appeal is being submitted ahead of it: {appeal_deadline} — otherwise omit any reference to a deadline. Request a formal reconsideration of the claim, referencing the specific reason for denial and directly countering it point by point. For jurisdiction={jurisdiction}, note the policyholder's right to escalate to an external/independent review if the internal appeal is unsuccessful — keep this reference generic ('the applicable external review process for your jurisdiction and plan type') unless a specific verified process applies; never invent a specific agency name. Firm, factual, well-organized tone — this is a formal reconsideration request, not an emotional appeal.",
  },
  'medical-product-complaint-letter': {
    title: 'Medical Product Complaint Letter Generator',
    // Real Gumroad product_id for the "medical-product-complaint-letter" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/yoqtwi -> .../l/medical-product-complaint-letter).
    gumroad_product_id: 'yoqtwi',
    // STATIC as of 2026-09-19 (Batch 6: Flights & Travel / Delivery &
    // Parcels / Healthcare & Medical) -- prompt_template below is now
    // DEAD CODE.
    static: true,
    render: renderMedicalProductComplaintLetter,
    prompt_template:
      "Draft a formal complaint letter from {consumer_full_name} to {seller_or_manufacturer_name} regarding the medical product/device '{product_name}', purchased on {purchase_date}. Issue type: {issue_type}. Description: {issue_description}. Requested resolution: {desired_outcome}. For jurisdiction={jurisdiction}, reference the consumer's general warranty and consumer protection rights for defective or misdescribed products, without citing a specific statute unless independently verified — keep this generic. If issue_type is 'Safety concern', add a brief closing note that the consumer may also consider reporting the issue to the relevant product safety/regulatory authority in their area — for any other issue_type, omit this note entirely. Professional, firm tone.",
  },
  'healthcare-provider-information-request': {
    title: 'Healthcare Provider Information Request Generator',
    // Real Gumroad product_id for the "healthcare-provider-information-request" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/rcyqeq -> .../l/healthcare-provider-information-request).
    gumroad_product_id: 'rcyqeq',
    // STATIC as of 2026-09-19 (Batch 6: Flights & Travel / Delivery &
    // Parcels / Healthcare & Medical) -- prompt_template below is now
    // DEAD CODE.
    static: true,
    render: renderHealthcareProviderInformationRequest,
    prompt_template:
      "Draft a polite, clear written request from {requester_full_name} to {provider_name} asking for information about {service_of_interest} before making a decision. Specifically request the following: {information_requested}. If a response deadline was requested, politely include it: {response_deadline_requested} — otherwise omit any deadline reference. Professional, straightforward tone — this is a pre-decision information request, not a complaint.",
  },

  // ---- Financial & Banking (first generators for this block) ----
  // gumroad_product_id is PLACEHOLDER_ for all 8 below: Carlos created the Gumroad
  // products with the permalinks used on each frontend page (confirmed live), but
  // the internal Gumroad product_id needed here for server-side license
  // verification has not been supplied yet — do not guess it from the permalink.
  // Real IDs land in a follow-up prompt; swap each PLACEHOLDER_ below then.
  'bank-complaint-letter': {
    title: 'Bank Complaint Letter Generator',
    gumroad_product_id: 'PLACEHOLDER_BANK_COMPLAINT',
    // STATIC as of 2026-09-17 (Batch 1: Financial & Banking) -- prompt_template
    // below is now DEAD CODE, kept unused per the established convention.
    static: true,
    render: renderBankComplaintLetter,
    prompt_template:
      "Write a formal complaint letter from {customer_name} to {bank_name} regarding {issue_category}, described as: {issue_description}. If prior_contact indicates a prior unresolved attempt was already made, reference that this issue was already raised without resolution: {prior_contact} — otherwise do not mention any prior contact at all. State the desired outcome clearly: {desired_outcome}. For jurisdiction={jurisdiction}, note that if unresolved within a reasonable period, the customer may escalate to the appropriate financial ombudsman/regulator — keep this generic ('the applicable financial complaints body in your area') unless independently verified; never invent a specific agency name. Account/reference: {account_reference}. Tone: professional, firm, factual.",
  },
  'unauthorized-transaction-dispute-letter': {
    title: 'Unauthorized Transaction Dispute Letter Generator',
    gumroad_product_id: 'PLACEHOLDER_UNAUTHORIZED_TXN_DISPUTE',
    // STATIC as of 2026-09-17 (Batch 1: Financial & Banking) -- prompt_template
    // below is now DEAD CODE, kept unused per the established convention.
    static: true,
    render: renderUnauthorizedTransactionDisputeLetter,
    prompt_template:
      "Write a formal unauthorized transaction dispute letter from {customer_name} to {bank_name}. State the customer does not recognize or authorize the transaction on {transaction_date} for {transaction_amount} at {merchant_name}, first noticed on {detected_date}. Reference the status of the card/access device: {card_or_account_status}. For jurisdiction={jurisdiction}, note the customer's liability protections generally depend on prompt reporting (e.g. Regulation E in the US) — keep specific liability figures and deadlines generic ('the liability limit that applies based on how quickly you report this') unless independently verified for the jurisdiction; never invent a specific dollar cap or day count. Request the transaction be investigated and reversed, and ask for written confirmation of the case reference number. Tone: firm, factual, urgent but professional.",
  },
  'card-transaction-billing-dispute': {
    title: 'Card Transaction & Billing Dispute Generator',
    // Consolidated generator — covers billing/service disputes (never received,
    // not as described, duplicate charge, incorrect amount, cancelled-but-charged)
    // via a 'dispute_reason' branch. Explicitly does NOT cover fraud/unauthorized
    // transactions — that's 'unauthorized-transaction-dispute-letter' above.
    // Never split this back into separate generators per dispute reason, and
    // never let fraud language leak into this one's output.
    gumroad_product_id: 'PLACEHOLDER_CARD_BILLING_DISPUTE',
    // STATIC as of 2026-09-17 (Batch 1: Financial & Banking) -- prompt_template
    // below is now DEAD CODE, kept unused per the established convention.
    static: true,
    render: renderCardTransactionBillingDispute,
    prompt_template:
      "Write a formal card transaction dispute letter from {customer_name} to {card_issuer}, matching the selected reason: {dispute_reason}. This is a billing/service dispute, NOT a fraud or unauthorized-transaction claim — never use fraud-related language ('unauthorized', 'I did not make this transaction', 'stolen card', 'someone else used my card') anywhere in the letter, regardless of dispute_reason. The disputed transaction was on {transaction_date} for {transaction_amount} from {merchant_name}. If merchant_contact_attempted indicates an attempt was already made, reference that attempt and its outcome: {merchant_contact_attempted} — otherwise state the merchant has not yet been contacted directly. Additional details: {details}. Note the dispute is being filed within the cardholder's standard filing window — keep the specific number of days generic ('within the filing window that applies to your card network') rather than inventing a figure, since this varies by network and dispute reason. Request a formal chargeback/dispute be opened and a written case reference provided. Tone: firm, factual, professional.",
  },
  'bank-fee-refund-request': {
    title: 'Bank Fee Refund Request Generator',
    gumroad_product_id: 'PLACEHOLDER_BANK_FEE_REFUND',
    // STATIC as of 2026-09-17 (Batch 1: Financial & Banking) -- prompt_template
    // below is now DEAD CODE, kept unused per the established convention.
    static: true,
    render: renderBankFeeRefundRequest,
    prompt_template:
      "Write a formal fee refund request letter from {customer_name} to {bank_name} for a {fee_type} of {fee_amount} charged on {fee_date}. Present the customer's basis for disputing it: {dispute_basis}. For jurisdiction={jurisdiction}, reference the bank's general obligation to disclose fees and any changes clearly before charging them — keep this generic ('applicable fee transparency requirements in your area') unless independently verified; never invent a specific regulation name or number. Request a full refund and written confirmation. Tone: firm, factual, professional.",
  },
  'loan-credit-agreement-cancellation-withdrawal': {
    title: 'Loan / Credit Agreement Cancellation & Withdrawal Generator',
    gumroad_product_id: 'PLACEHOLDER_LOAN_CANCELLATION',
    // STATIC as of 2026-09-17 (Batch 1: Financial & Banking) -- prompt_template
    // below is now DEAD CODE, kept unused per the established convention.
    static: true,
    render: renderLoanCreditAgreementCancellationWithdrawal,
    prompt_template:
      "Write a formal notice of cancellation/withdrawal from {customer_name} to {lender_name}, for the credit agreement referenced {agreement_reference}, signed on {signing_date}. If cancellation_reason was provided, include it briefly to add clarity: {cancellation_reason} — otherwise state the cancellation is being exercised as a right and no reason is required. For jurisdiction={jurisdiction}, reference that many jurisdictions provide a statutory cooling-off/right-of-withdrawal period for certain consumer credit agreements — keep the specific number of days generic ('within the withdrawal period that applies to your agreement and location') rather than inventing a figure, and note the customer should confirm this period applies to their specific product before relying on it. Request written confirmation the agreement is cancelled and confirmation of any amount owed or refundable. Tone: formal, clear, professional.",
  },
  'financial-ombudsman-regulator-complaint': {
    title: 'Financial Ombudsman / Regulator Complaint Generator',
    gumroad_product_id: 'PLACEHOLDER_OMBUDSMAN_COMPLAINT',
    // STATIC as of 2026-09-17 (Batch 1: Financial & Banking) -- prompt_template
    // below is now DEAD CODE, kept unused per the established convention.
    static: true,
    render: renderFinancialOmbudsmanRegulatorComplaint,
    prompt_template:
      "Write a formal escalation complaint from {customer_name} to the appropriate financial ombudsman/regulator for jurisdiction={jurisdiction} (e.g. the CFPB in the US, the Financial Ombudsman Service in the UK, FIN-NET / the national competent authority in the EU, or AFCA in Australia — reference the general type of body appropriate for the jurisdiction given without asserting a specific one if the jurisdiction is ambiguous). Regarding {institution_name}, summarize the issue: {issue_summary}. State the institution was first contacted on {prior_complaint_date}, and describe its response so far: {institution_response}. State the desired outcome clearly: {desired_outcome}. Structure the letter with a clear chronology. Note this escalation should generally only be filed after the institution's own complaints process has been exhausted or a reasonable response period has passed — keep any specific deadline generic. Tone: formal, clear, factual — this is a regulatory submission, not an emotional appeal.",
  },
  'debt-collection-dispute-letter': {
    title: 'Debt Collection Dispute Letter Generator',
    gumroad_product_id: 'PLACEHOLDER_DEBT_COLLECTION_DISPUTE',
    // STATIC as of 2026-09-17 (Batch 1: Financial & Banking) -- prompt_template
    // below is now DEAD CODE, kept unused per the established convention.
    static: true,
    render: renderDebtCollectionDisputeLetter,
    prompt_template:
      "Write a formal debt validation/dispute letter from {customer_name} to {collector_name} regarding a claimed debt of {claimed_amount}, originally from {original_creditor} if known. State the basis for the dispute: {dispute_basis}, and the following details: {details}. For jurisdiction={jurisdiction}, reference the consumer's general right to request written validation of a disputed debt before the collector continues collection activity — keep any specific statutory deadline generic ('within the validation period that applies in your area') unless independently verified; never invent a specific day count. Explicitly request: written proof of the debt, verification the collector is legally entitled to collect it, and confirmation of the exact amount owed with an itemized breakdown. Tone: firm, factual, formal — this is a legal validation request, not an admission of the debt.",
  },

  // ---- Subscriptions & Services (first generators for this block) ----
  // gumroad_product_id is PLACEHOLDER_ for all 3 below: Carlos created the Gumroad
  // products with the permalinks used on each frontend page (confirmed live), but
  // the internal Gumroad product_id needed here for server-side license
  // verification has not been supplied yet — do not guess it from the permalink.
  // Real IDs land in a follow-up prompt; swap each PLACEHOLDER_ below then.
  'subscription-service-cancellation': {
    title: 'Subscription & Service Cancellation Generator',
    gumroad_product_id: 'PLACEHOLDER_subscription-service-cancellation',
    // STATIC as of 2026-09-18 (Batch 4: Employment + Subscriptions &
    // Services) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderSubscriptionServiceCancellation,
    prompt_template:
      "Write a formal, courteous but firm cancellation letter from a consumer to {provider_name}. The consumer's account/reference is {account_id} — ignore this entirely if not provided or marked N/A. This is a cancellation described as: {cancellation_type}. If this is an ongoing subscription or recurring service, reference that the subscription began on {signup_date} and bills {billing_frequency} — otherwise ignore these two fields entirely. If this is a free trial before conversion, reference that the trial is set to end/convert on {trial_end_date}, and if a promotional price was shown, mention it was advertised at {promo_price_seen} — otherwise ignore these two fields entirely. If this is a fixed-term contract, reference that the contract runs through {contract_end_date}, and if a reason for early termination was given, include it: {early_termination_reason} — otherwise ignore these two fields entirely. Only use the fields belonging to the selected cancellation type; never write 'N/A' or reference an inapplicable field in the letter itself. State clearly that cancellation should take effect on {cancellation_date_requested}, and request written confirmation of the cancellation date. If also_request_refund is 'Yes', formally request a refund of {refund_amount}, explaining: {refund_reason} — otherwise do not mention a refund at all. Close by requesting that no further charges be made to the account after the stated cancellation date, and that any charge after that date will be disputed with the payment provider. Keep the tone professional, not aggressive. Do not invent any facts, dates, or figures beyond what was provided.",
  },
  'subscription-service-billing-dispute': {
    title: 'Subscription & Service Billing Dispute Generator',
    gumroad_product_id: 'PLACEHOLDER_subscription-service-billing-dispute',
    // STATIC as of 2026-09-17 (Batch 3: Shipping/Shopping/Subscriptions/
    // Training -- final batch) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderSubscriptionServiceBillingDispute,
    prompt_template:
      "Write a formal billing dispute letter from a consumer to {provider_name} regarding a charge of {charge_amount} on {charge_date}. Account/reference: {account_id} — ignore this entirely if not provided or marked N/A. This dispute concerns: {dispute_type}. If the charge occurred after cancellation, state the consumer cancelled on {cancellation_date}, referencing confirmation details if given: {cancellation_confirmation}, so this charge should not have occurred — otherwise ignore these two fields entirely. If this concerns a price increase, state the price was previously {previous_price} and increased to {new_price}, and reference whether advance notice was received: {notice_received} — otherwise ignore these three fields entirely. If this concerns a duplicate, incorrect, or unauthorized charge, state the expected amount was {expected_amount} and describe the issue: {issue_description} — otherwise ignore these two fields entirely. If this concerns an unwanted renewal, state whether the consumer recalls receiving a renewal notice: {renewal_notice_received}, and reference the original signup date if given: {signup_date} — otherwise ignore these two fields entirely. Only use the fields belonging to the selected dispute type; never write 'N/A' or reference an inapplicable field in the letter itself. State the consumer's desired outcome clearly: {desired_outcome}. Request a response within a reasonable timeframe (10 business days), and note that if unresolved, the consumer will dispute the charge directly with their card issuer or relevant regulator. Keep the tone factual and firm, not aggressive. Do not invent any facts, dates, or figures beyond what was provided.",
  },
  'service-complaint-escalation': {
    title: 'Service Complaint & Escalation Generator',
    gumroad_product_id: 'PLACEHOLDER_service-complaint-escalation',
    // STATIC as of 2026-09-17 (Batch 3: Shipping/Shopping/Subscriptions/
    // Training -- final batch) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderServiceComplaintEscalation,
    prompt_template:
      "Write a formal complaint letter from a consumer to {provider_name}, matching the stage described: {complaint_stage}. Account/reference: {account_id} — ignore this entirely if not provided or marked N/A. Issue: {issue_description}. If this is a first formal complaint, state the issue arose on {issue_date}, and if given, describe what was promised versus what was actually delivered: {promised_vs_delivered} — otherwise ignore these two fields entirely. If this is an escalation of an unresolved complaint, state the consumer first raised it on {original_complaint_date}, referencing the reference number if given: {original_reference}, the response received if given: {response_received}, and any deadline the provider previously committed to if given: {deadline_given} — otherwise ignore these four fields entirely; also state explicitly that this is an escalation of an unresolved complaint and request it be handled by a manager or complaints team, not front-line support. Only use the fields belonging to the selected stage; never write 'N/A' or reference an inapplicable field in the letter itself. State the consumer's desired outcome: {desired_outcome}. Request a substantive response within 10 business days, and note that if unresolved, the consumer will escalate to an ombudsman, regulator, or small claims court as appropriate. Keep the tone factual and professional. Do not invent any facts, dates, or figures beyond what was provided.",
  },
  'privacy-rights-request': {
    title: 'Privacy Rights Request Generator',
    gumroad_product_id: 'hplixy',
    // STATIC as of 2026-09-17 (Batch 2: Legal & Contracts / Privacy & Data /
    // Public Services) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderPrivacyRightsRequest,
    prompt_template:
      "Write a formal, courteous but firm privacy rights request letter from a consumer to {company_name}. The consumer's relationship to the company: {your_relationship} — ignore this entirely if not provided or marked N/A. Account/reference: {account_identifier} — ignore this entirely if not provided or marked N/A. This is a request described as: {right_type}. If this is an access request, state the consumer wants to see what personal data is held about them, narrowed to the following scope if given: {specific_data_scope} — otherwise ignore this field entirely. If this is a deletion/erasure request, state the consumer wants their personal data deleted/erased, referencing the following reason if given: {deletion_reason} — otherwise ignore this field entirely. If this is a correction/rectification request, state the following data is incorrect: {incorrect_data}, and that it should instead read: {correct_data} — otherwise ignore these two fields entirely. If this is an objection to AI/ML training use, state the consumer objects to their personal data being used to train AI or machine learning models, narrowed to the following content type if given: {data_type_for_ai}, and requests this use stop and any existing training use be remediated where possible — otherwise ignore this field entirely. If this is a restriction of processing request, state the consumer requests processing of their data be restricted while the following is resolved: {restriction_reason} — otherwise ignore this field entirely. Only use the fields belonging to the selected right; never write 'N/A' or reference an inapplicable field in the letter itself. Request written confirmation of the action taken and the date it was completed. State that a response is expected within the timeframe required by applicable data protection law, and that if no adequate response is received, the consumer will escalate to the relevant data protection authority. Keep the tone professional, not aggressive. Do not invent any facts, dates, regulations, or figures beyond what was provided.",
  },
  'privacy-breach-compliance-complaint': {
    title: 'Privacy Breach & Compliance Complaint Generator',
    gumroad_product_id: 'udtiy',
    // STATIC as of 2026-09-17 (Batch 2: Legal & Contracts / Privacy & Data /
    // Public Services) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderPrivacyBreachComplianceComplaint,
    prompt_template:
      "Write a formal complaint letter from a consumer to {company_name} regarding a complaint described as: {complaint_type}. Account/reference: {account_identifier} — ignore this entirely if not provided or marked N/A. If this is a data breach complaint, state the consumer was notified of a data breach on {breach_notification_date} (or ignore this field if it is N/A and instead state the consumer became aware of it independently), and that the data affected, as far as the consumer knows, is: {data_affected}. Request a clear explanation of what happened, what data was affected, and what steps are being taken to prevent recurrence — otherwise, if this is not a data breach complaint, ignore these two fields entirely. If this is a cookies/tracking consent complaint, state that on {website_or_app}, the consumer experienced the following issue with cookie/tracking consent: {consent_issue}, and that this appears inconsistent with applicable data protection and e-privacy requirements for valid consent — otherwise ignore these two fields entirely. Only use the fields belonging to the selected complaint type; never write 'N/A' or reference an inapplicable field in the letter itself. State the consumer's desired outcome: {desired_outcome}. Request a substantive written response within a reasonable timeframe (state 20 business days), and note explicitly that this letter is being sent as the required first step before escalating to the relevant data protection authority, and that the consumer will do so if the response is inadequate or absent. Keep the tone factual and firm, not aggressive. Do not invent any facts, dates, or figures beyond what was provided.",
  },
  'privacy-regulator-complaint': {
    title: 'Privacy Regulator Complaint Generator',
    gumroad_product_id: 'gwhjwt',
    // STATIC as of 2026-09-17 (Batch 2: Legal & Contracts / Privacy & Data /
    // Public Services) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderPrivacyRegulatorComplaint,
    prompt_template:
      "Write a formal complaint to the correct data protection regulator regarding {company_name}. Determine the regulator strictly from the jurisdiction (and, only if jurisdiction is European Union, the EU country) provided, using these rules and no others: if jurisdiction is 'United States', address the complaint to the Federal Trade Commission (FTC); if jurisdiction is 'United Kingdom', address it to the Information Commissioner's Office (ICO); if jurisdiction is 'Australia', address it to the Office of the Australian Information Commissioner (OAIC); if jurisdiction is 'European Union' and eu_country is 'Spain', address it to the Agencia Espanola de Proteccion de Datos (AEPD); if eu_country is 'France', address it to the Commission Nationale de l'Informatique et des Libertes (CNIL); if eu_country is 'Germany', address it to the Bundesbeauftragte fur den Datenschutz (BfDI) and add a brief note that Germany also has state-level (Lander) data protection authorities and the consumer should confirm the correct one for their region; if eu_country is 'Other EU country' or 'Not applicable — I selected a different jurisdiction' while jurisdiction is still 'European Union', do not name any specific regulator — instead address the letter generically to 'your national data protection authority' and add a note advising the consumer to confirm the correct authority for their specific EU member state before sending. Ignore the eu_country field entirely if jurisdiction is not 'European Union'. If prior_contact_date is provided and not N/A, state the consumer first raised this issue directly with the company on {prior_contact_date}, referencing the following response if given: {prior_contact_outcome} — otherwise ignore these two fields entirely. Issue: {issue_summary}. The consumer is requesting: {desired_outcome}. Format this as an appropriate formal complaint to a data protection regulator, including a clear factual summary, relevant dates, and a specific request for investigation or action. Do not invent any facts, regulations, case numbers, or figures beyond what was provided. Do not name any regulator other than the single one determined by the rules above.",
  },
  'refund-warranty-claim': {
    title: 'Refund & Warranty Claim Generator',
    // Real Gumroad product_id, confirmed by the user (product "lidrwt") — permalink
    // "refund-warranty-claim-generator" verified live (HTTP 200, matching title) on
    // carlosdevlop.gumroad.com before wiring.
    gumroad_product_id: 'lidrwt',
    // STATIC as of 2026-09-17 (Batch 3: Shipping/Shopping/Subscriptions/
    // Training -- final batch) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderRefundWarrantyClaim,
    prompt_template:
      "Write a formal, courteous but firm letter from a consumer to {seller_name} regarding order {order_number} for {item_name}, purchased on {purchase_date}. This claim is described as: {claim_reason}. If this is described as the item not being as described, not working as expected, or not being satisfactory, state the following issue: {issue_description} — otherwise ignore this field entirely. If this is described as the item being defective, broken, or having stopped working, state the following defect: {defect_description}, referencing a stated warranty period if given: {warranty_period_stated} — otherwise ignore these two fields entirely. Only use the fields belonging to the selected claim type; never write 'N/A' or reference an inapplicable field in the letter itself. State the consumer's desired outcome clearly: {desired_outcome}. Request a response within a reasonable timeframe (10 business days), and note that if unresolved, the consumer will pursue a card issuer dispute or the relevant consumer protection avenue. Keep the tone professional, courteous but firm, not aggressive. Do not invent any facts, warranty terms, laws, or figures beyond what was provided.",
  },
  'chargeback-letter': {
    title: 'Chargeback Letter Generator',
    // Real Gumroad product_id, confirmed by the user (product "frpxfr") — permalink
    // "chargeback-letter-generator" verified live (HTTP 200, matching title) on
    // carlosdevlop.gumroad.com before wiring.
    gumroad_product_id: 'frpxfr',
    // STATIC as of 2026-09-17 (Batch 3: Shipping/Shopping/Subscriptions/
    // Training -- final batch) -- prompt_template below is now DEAD CODE.
    // Per the 2026-09-16 Option 1 decision: no AI-guessed card-network
    // dispute-reason category anywhere in the output -- render() presents
    // the dispute facts and lets the bank do its own categorization.
    static: true,
    render: renderChargebackLetter,
    prompt_template:
      "Write a formal chargeback request from a cardholder to {card_issuer_name} regarding a transaction of {transaction_amount} on {transaction_date} with {seller_name}. Order reference: {order_number} — ignore this entirely if not provided or marked N/A. Reason for dispute: {dispute_reason}. Whether the cardholder already attempted to resolve this directly with the seller: {prior_contact_attempted}. If yes, state what happened: {prior_contact_outcome} — otherwise ignore this field entirely. Request that the bank open a formal chargeback/dispute investigation for this transaction, referencing the card network dispute reason category that the facts given most plausibly fall under, without inventing a specific reason code number. Ask for confirmation of the dispute reference number and expected timeline. Keep the tone factual and direct. Do not invent any facts, dates, figures, or specific card network rules beyond what was provided.",
  },
  'marketplace-complaint': {
    title: 'Marketplace Complaint Generator',
    // Real Gumroad product_id, given directly by Carlos — permalink
    // "marketplace-complaint-generator" verified live (HTTP 200, matching title)
    // on carlosdevlop.gumroad.com before wiring.
    gumroad_product_id: 'ppxiud',
    // STATIC as of 2026-09-17 (Batch 3: Shipping/Shopping/Subscriptions/
    // Training -- final batch) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderMarketplaceComplaint,
    prompt_template:
      "Write a formal complaint regarding seller {seller_name}, order {order_number}, to the marketplace platform. The platform is: {platform}. If the platform is 'Another marketplace — I'll name it below', use the specific name given here instead: {platform_name} — otherwise ignore this field entirely. Issue: {issue_description}. Whether the buyer already contacted the seller directly: {seller_contacted}. If yes, state what response was received: {seller_response} — otherwise ignore this field entirely. The buyer is requesting: {desired_outcome}. Format this as an appropriate complaint to submit through that platform's buyer protection or resolution center, using a factual, evidence-oriented tone consistent with what that type of platform process expects. Do not invent specific platform policy names, deadlines, or guarantee terms beyond general, appropriately hedged language — instead, outside the letter itself, add a note reminding the buyer to confirm the exact policy details and deadline on the platform's own resolution center page before submitting. Do not invent any facts beyond what was provided.",
  },
  'scope-of-work-generator': {
    title: 'Scope of Work Generator',
    // Gumroad product not yet created — Carlos uploads the file directly and
    // will provide the real product id in a follow-up prompt. PLACEHOLDER.
    gumroad_product_id: 'PLACEHOLDER_scope-of-work',
    // STATIC as of 2026-09-18 (Batch 5: Housing & Rentals / Home
    // Renovations / Legal & Contracts) -- output_rules and prompt_template
    // below are now DEAD CODE.
    static: true,
    render: renderScopeOfWorkGenerator,
    output_rules: DOCUMENT_OUTPUT_RULES,
    prompt_template:
      "Draft a professional, formal Scope of Work document — not a letter — intended for attachment to a renovation/repair contract between {homeowner_name} and {contractor_name} for the property at {project_address}. Structure it as a numbered document with these sections: 1) Project Overview (project type {project_type} — if 'Other', use {project_type_other} — start date {start_date}, target completion {completion_date}), 2) Detailed Scope of Work (the specific tasks from {work_description}, in the order provided), 3) Materials & Supplies ({materials} and who supplies them: {materials_responsibility} — if 'Mixed — specify which items below', use this breakdown: {materials_responsibility_detail}), 4) Permits & Compliance ({permit_status} — if 'Yes', responsibility sits with {permit_responsibility}), 5) Cleanup & Site Responsibility ({cleanup_responsibility}), 6) Exclusions (explicitly list {exclusions} as NOT included in this scope), 7) Price & Payment Terms ({price_and_payment}), 8) Signature blocks for both homeowner and contractor with date lines. Use factual, contract-appropriate language throughout — this is a legal-adjacent document meant to prevent scope disputes, not a narrative description. Do not invent contract clauses or legal terms beyond what the user provided.",
  },
  'contractor-dispute-demand-letter-generator': {
    title: 'Contractor Dispute & Demand Letter Generator',
    // Gumroad product not yet created — Carlos uploads the file directly and
    // will provide the real product id in a follow-up prompt. PLACEHOLDER.
    gumroad_product_id: 'PLACEHOLDER_contractor-dispute-letter',
    // STATIC as of 2026-09-18 (Batch 5: Housing & Rentals / Home
    // Renovations / Legal & Contracts) -- prompt_template below is now
    // DEAD CODE.
    static: true,
    render: renderContractorDisputeDemandLetterGenerator,
    prompt_template:
      "Write a formal demand letter addressed to {contractor_name} regarding the contract dated {contract_date} for work at {property_address}, with a total contract price of {contract_price}. The specific issue is: {issue_type}. If issue_type is 'Incomplete work', state that approximately {incomplete_pct_complete}% of the contracted work is complete, describe the work not yet done: {incomplete_work_remaining}, and note the contractor stopped or left the site on {incomplete_stop_date} — otherwise ignore these three fields entirely. If issue_type is 'Defective work', describe the defect: {defect_description}, located at {defect_location}, first noticed on {defect_noticed_date}, with an estimated repair cost of {defect_repair_cost} if known — otherwise ignore these four fields entirely. If issue_type is 'Unauthorized overcharge', state the disputed amount of {overcharge_amount} and the reason it is unauthorized: {overcharge_reason} (if 'Other', use {overcharge_reason_other} instead) — otherwise ignore these fields entirely. If issue_type is 'Project delay', state the original agreed completion date of {delay_original_date}, the current status of the work: {delay_current_status}, and the reason given by the contractor for the delay, if any: {delay_reason_given} — otherwise ignore these three fields entirely. Clearly state the desired outcome: {desired_outcome} (if 'Partial refund — specify amount', the amount requested is {desired_outcome_amount}; if 'Completion by a specific date — specify date', the requested date is {desired_outcome_date}). Reference that supporting evidence (photos, communications log) is attached separately. Keep tone firm, factual, and professional — this is a demand letter, not an emotional complaint. Close with a reasonable response deadline (14 days) and contact details for reply. Do not invent legal citations or threaten specific legal action beyond stating that further steps will be considered if unresolved.",
  },
  'government-complaint-letter-generator': {
    title: 'Government Complaint Letter Generator',
    // Gumroad product not yet created — Carlos uploads the file directly and
    // will provide the real product id in a follow-up prompt. PLACEHOLDER.
    gumroad_product_id: 'PLACEHOLDER_government-complaint-letter',
    // STATIC as of 2026-09-17 (Batch 2: Legal & Contracts / Privacy & Data /
    // Public Services) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderGovernmentComplaintLetter,
    prompt_template:
      "Write a formal complaint letter addressed to {agency_name} regarding {subject}, referencing case/reference number {reference_number} if provided. Based on the branch selected: for an initial complaint, describe the issue factually using {issue_description} and {date_occurred}, noting any prior contact attempts ({prior_contact} — if 'Yes — free text describing what happened', use {prior_contact_detail}) — otherwise ignore these fields entirely. For an escalation, reference the original complaint dated {original_complaint_date} with reference {original_reference}, summarize the response received ({response_summary}) or its absence, explain why it was unsatisfactory ({unsatisfactory_reason}), and note the letter is being escalated, referencing the escalation body if known ({escalation_body} — if 'Other — free text', use {escalation_body_other}) — otherwise ignore these fields entirely. State the desired outcome ({desired_outcome}) clearly in both branches. Keep tone factual and professional — firmer in tone for the escalation branch, since this reflects an unresolved prior attempt, but never hostile or threatening. Close with a reasonable response deadline (14 days for initial, 10 days for escalation) and contact details for reply. Do not invent regulatory citations or agency-specific procedures. Sender: {full_name}.",
  },
  'administrative-appeal-review-decision-response-generator': {
    title: 'Administrative Appeal, Review & Decision Response Generator',
    // Gumroad product not yet created — Carlos uploads the file directly and
    // will provide the real product id in a follow-up prompt. PLACEHOLDER.
    gumroad_product_id: 'PLACEHOLDER_administrative-appeal-response',
    // STATIC as of 2026-09-17 (Batch 2: Legal & Contracts / Privacy & Data /
    // Public Services) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderAdministrativeAppealReviewDecisionResponse,
    prompt_template:
      "Write a formal written response addressed to {agency_name} regarding the decision/notification dated {decision_date}, reference {reference_number}, described as: {decision_description}. Based on the branch selected: for an appeal, state the grounds ({appeal_grounds} — if 'Other — free text', use {appeal_grounds_other}) and detailed explanation ({appeal_explanation}), and the outcome sought ({appeal_outcome}) — otherwise ignore these fields entirely. For an extension/payment plan request, state what's being requested an extension for ({extension_subject}), the proposed new terms ({proposed_terms}), and the reason ({extension_reason}) — otherwise ignore these fields entirely. For a clarification request, state what needs clarifying ({clarification_needed}) and why ({clarification_reason}) — otherwise ignore these fields entirely. For providing additional information, reference what was requested ({info_requested}) and summarize what's being provided ({info_summary}), noting attachments are included separately — otherwise ignore these fields entirely. Keep tone factual and professional throughout — an appeal should be firm but not adversarial; a clarification or extension request should be courteous. Close with a reasonable response deadline and contact details for reply. Do not invent regulatory citations or agency-specific appeal procedures — note that the user should confirm the specific appeal process and deadline stated in their own decision letter. Sender: {full_name}.",
  },
  'administrative-information-request-generator': {
    title: 'Administrative Information Request Generator',
    // Gumroad product not yet created — Carlos uploads the file directly and
    // will provide the real product id in a follow-up prompt. PLACEHOLDER.
    gumroad_product_id: 'PLACEHOLDER_administrative-information-request',
    // STATIC as of 2026-09-17 (Batch 2: Legal & Contracts / Privacy & Data /
    // Public Services) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderAdministrativeInformationRequest,
    prompt_template:
      "Write a formal information request addressed to {agency_name}, referencing case/reference number {reference_number} if provided. Clearly and specifically state what is being requested: {information_requested}. If a reason is provided ({reason} — if 'Yes — free text', use {reason_detail}), include it briefly, noting that a reason is being offered voluntarily and is not a precondition for the request — otherwise omit any reason. If a legal basis is specified ({legal_basis} — if 'Other', use {legal_basis_other}), reference it appropriately — for example, framing the request explicitly as a Freedom of Information request or a data/privacy access request if selected, without inventing specific statutory citations the user didn't provide. State the preferred format/delivery method ({delivery_preference}). Keep tone neutral and straightforward — this is a routine administrative request, not a complaint. Close with a request for a specific response timeframe and contact details for reply. Sender: {full_name}.",
  },
  'contract-demand-letter-generator': {
    title: 'Contract & Demand Letter Generator',
    // Gumroad product not yet created — Carlos uploads the file directly and
    // will provide the real product id in a follow-up prompt. PLACEHOLDER.
    gumroad_product_id: 'PLACEHOLDER_contract-demand-letter',
    // STATIC as of 2026-09-17 (Batch 2: Legal & Contracts / Privacy & Data /
    // Public Services) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderContractDemandLetter,
    prompt_template:
      "Write a formal demand/dispute letter from {your_name} to {other_party_name} regarding the contract {contract_reference}. Based on the branch selected ({issue_type}): for 'Breach of contract', describe the specific obligation breached ({breach_obligation}), the date the breach occurred or was discovered ({breach_date}), and the evidence available ({breach_evidence}) — otherwise ignore these fields entirely. For 'Payment owed to you', state the amount owed ({payment_amount}), what the payment is for ({payment_for}), the original due date ({payment_due_date}), and note any partial payment already received ({payment_partial_received} — if 'Yes — specify amount', the amount is {payment_partial_amount}) — otherwise ignore these fields entirely. For 'Refund owed to you', state the amount paid originally ({refund_amount}) for {refund_item}, why a refund is owed ({refund_reason}), and the date of original payment ({refund_payment_date}) — otherwise ignore these fields entirely. For 'General dispute over obligations or interpretation', state the specific clause or obligation in dispute ({dispute_clause}), the sender's interpretation versus the other party's ({dispute_interpretation}), and the impact of the disagreement ({dispute_impact}) — otherwise ignore these fields entirely. For 'Final notice before small claims', note whether a prior demand was sent ({finalnotice_prior_demand} — if 'Yes — specify date', the date was {finalnotice_prior_demand_date}), any response received ({finalnotice_response_received}), the amount being claimed ({finalnotice_amount_claimed}), and the court/jurisdiction intended if known ({finalnotice_jurisdiction}) — otherwise ignore these fields entirely, and state explicitly that this is a final opportunity to resolve the matter before a small claims filing is made, without naming a specific court procedure beyond what the user provided. Reference that supporting evidence is attached separately where applicable. State the desired outcome clearly: {desired_outcome} (if 'Partial payment — specify amount', the amount is {desired_outcome_amount}; if 'Other — free text', use {desired_outcome_other}). Keep tone firm, factual, and professional — escalate firmness only for the final-notice branch. Close with a reasonable response deadline (14 days, or 7 days for the final-notice branch) and contact details for reply. Do not invent legal citations, statutes, or threaten specific legal action beyond stating that further steps will be considered.",
  },
  'contract-termination-renewal-notice-generator': {
    title: 'Contract Termination & Renewal Notice Generator',
    // Gumroad product not yet created — Carlos uploads the file directly and
    // will provide the real product id in a follow-up prompt. PLACEHOLDER.
    gumroad_product_id: 'PLACEHOLDER_termination-renewal-notice',
    // STATIC as of 2026-09-17 (Batch 2: Legal & Contracts / Privacy & Data /
    // Public Services) -- prompt_template below is now DEAD CODE.
    static: true,
    render: renderContractTerminationRenewalNotice,
    prompt_template:
      "Write a formal notice from {your_name} to {other_party_name} regarding the contract {contract_reference}, effective {effective_date}. Based on the branch selected ({notice_type}): for 'Terminating the contract now', state the reason ({termination_reason} — if 'Other — free text', use {termination_reason_other}), reference the relevant termination clause if provided ({termination_clause}), and note any outstanding obligations to settle ({outstanding_obligations}) — otherwise ignore these fields entirely. For 'Declining to renew at term end', confirm the contract will end on {contract_end_date} per the required notice period ({required_notice_period}), including the optional reason ({nonrenewal_reason}) only if provided — otherwise ignore these fields entirely. For 'Confirming renewal', confirm the new term ({new_term_length}) and any changes to terms being confirmed alongside the renewal ({renewal_changes}) — otherwise ignore these fields entirely. Keep tone clear, factual, and unambiguous about the exact effective date — this is the most common source of disputes after a termination or non-renewal notice. Close with contact details for any questions. Do not invent legal citations or contract terms beyond what the user provided.",
  },
  'contract-amendment-counteroffer-generator': {
    title: 'Contract Amendment & Counteroffer Generator',
    // Gumroad product not yet created — Carlos uploads the file directly and
    // will provide the real product id in a follow-up prompt. PLACEHOLDER.
    gumroad_product_id: 'PLACEHOLDER_amendment-counteroffer',
    // STATIC as of 2026-09-17 (Batch 2: Legal & Contracts / Privacy & Data /
    // Public Services) -- output_rules and prompt_template below are now
    // DEAD CODE.
    static: true,
    render: renderContractAmendmentCounteroffer,
    output_rules: DOCUMENT_OUTPUT_RULES,
    prompt_template:
      "Draft a formal contract amendment or counteroffer document — not a conversational letter — from {your_name} to {other_party_name} regarding the contract {contract_reference}, addressing the clause(s): {clause_reference}. Based on the branch selected ({amendment_type}): for 'Propose a change — counteroffer', present the current wording ({current_wording}), the proposed new wording ({proposed_wording}), and the reason for the change ({change_reason}), and request a response by {response_deadline} if provided — otherwise ignore these fields entirely. For 'Document a change already agreed', state that the original wording ({original_wording}) is replaced with the new agreed wording ({new_agreed_wording}) as of {agreement_date}, and explicitly confirm that all other terms and conditions of the original contract remain unchanged and in full force — otherwise ignore these fields entirely. Keep tone professional and precise — this is a document meant to prevent future ambiguity about what was actually agreed, not a persuasive letter. Include signature lines for both parties with date lines, especially in the amendment-documentation branch.",
  },
  'terms-conditions-generator': {
    title: 'Terms & Conditions Generator',
    // Gumroad product not yet created — Carlos uploads the file directly and
    // will provide the real product id in a follow-up prompt. PLACEHOLDER.
    gumroad_product_id: 'PLACEHOLDER_terms-conditions',
    // STATIC as of 2026-09-18 (Batch 5: Housing & Rentals / Home
    // Renovations / Legal & Contracts) -- output_rules and prompt_template
    // below are now DEAD CODE.
    static: true,
    render: renderTermsConditionsGenerator,
    output_rules: DOCUMENT_OUTPUT_RULES,
    prompt_template:
      "Draft a basic Terms & Conditions document for {business_name}, a {offering_type} business (if 'Other — free text', use {offering_type_other}) operating under the laws of {jurisdiction}. Include standard numbered sections: acceptance of terms, description of service, account terms if applicable ({has_accounts}), payment terms if applicable ({processes_payments}), the provided return/refund policy summary ({refund_policy}), user-generated content terms if applicable ({has_ugc} — if 'Yes', describe: {ugc_description}), age restrictions ({age_restriction}), limitation of liability, termination of access, governing law, changes to terms, and contact information ({contact_email}). Use clear, plain-language legal drafting appropriate for a basic T&C document. Do not invent specific statutory citations. Include a prominent disclaimer that this is a starting template and should be reviewed by a qualified attorney before publication, especially for businesses handling sensitive data, regulated products, or operating across multiple jurisdictions.",
  },
  'service-agreement-generator': {
    title: 'Service Agreement Generator',
    // Gumroad product not yet created — Carlos uploads the file directly and
    // will provide the real product id in a follow-up prompt. PLACEHOLDER.
    gumroad_product_id: 'PLACEHOLDER_service-agreement',
    // STATIC as of 2026-09-17 (Batch 2: Legal & Contracts / Privacy & Data /
    // Public Services) -- output_rules and prompt_template below are now
    // DEAD CODE.
    static: true,
    render: renderServiceAgreement,
    output_rules: DOCUMENT_OUTPUT_RULES,
    prompt_template:
      "Draft a basic Service Agreement between {provider_name} (Provider) and {client_name} (Client), governed by the laws of {jurisdiction}. Include numbered sections: 1) Services — describe {service_description} clearly as the scope of work, 2) Price & Payment — {price_and_payment}, 3) Term — starting {start_date} for {duration}, 4) Termination — {termination_terms} (if 'Either party with notice — specify days', the notice period is {termination_notice_days} days), 5) Confidentiality clause if {confidentiality_needed} is 'Yes', 6) Liability limitation if {liability_needed} is 'Yes' (cap: {liability_cap}, or a reasonable limitation if not specified), 7) Independent contractor status (Provider is not an employee of Client), 8) Governing law, 9) Signature blocks for both parties with date lines. Use clear, factual, contract-appropriate language. Do not invent specific clauses beyond what the user provided. Include a prominent disclaimer that this is a starting template and should be reviewed by a qualified attorney before use, particularly for higher-value or more complex engagements.",
  },
  'vehicle-purchase-warranty-complaint-generator': {
    title: 'Vehicle Purchase & Warranty Complaint Generator',
    // Gumroad product not yet created — Carlos uploads the file directly and
    // will provide the real product id in a follow-up prompt. PLACEHOLDER.
    gumroad_product_id: 'PLACEHOLDER_vehicle-purchase-warranty-complaint',
    // STATIC as of 2026-09-19 (Batch 7: FINAL batch) -- prompt_template
    // below is now DEAD CODE.
    static: true,
    render: renderVehiclePurchaseWarrantyComplaintGenerator,
    prompt_template:
      "Write a formal complaint letter addressed to {seller_dealer_name} regarding the vehicle {vehicle_details} (VIN: {vin}), purchased on {purchase_date} for {purchase_price}. Based on the branch selected ({situation_type}): for a listing mismatch, describe the discrepancy between what was claimed ({listing_claim}) and what was found ({actual_finding}), referencing available evidence ({mismatch_evidence}) — otherwise ignore these fields entirely. For a defect discovered after purchase, describe the defect ({defect_description}), when it was discovered ({defect_discovery_date}), and whether it was previously disclosed by the seller ({defect_disclosure_status}) — otherwise ignore these fields entirely. For a warranty claim, reference the specific warranty terms ({warranty_terms}), the defect ({warranty_defect_description}), when it was discovered ({warranty_discovery_date}), and any repair estimate obtained ({warranty_repair_estimate} — if 'Yes — specify amount', the estimate is {warranty_repair_estimate_amount}) — otherwise ignore these fields entirely. For an escalation, reference the original complaint dated {original_complaint_date}, summarize the response received ({response_summary}) or its absence, and explain why it was unsatisfactory ({unsatisfactory_reason}) — otherwise ignore these fields entirely. State the desired outcome clearly: {desired_outcome} (if 'Partial refund — specify amount', the amount requested is {desired_outcome_amount}). Keep tone factual and professional — firmer for the escalation branch, since it reflects an unresolved prior attempt. Close with a reasonable response deadline (14 days for initial complaints, 7-10 days for escalations) and contact details for reply. Do not invent regulatory citations, warranty law specifics, or threaten specific legal action beyond stating that further steps will be considered.",
  },
  'vehicle-repair-dispute-generator': {
    title: 'Vehicle Repair Dispute Generator',
    // Gumroad product not yet created — Carlos uploads the file directly and
    // will provide the real product id in a follow-up prompt. PLACEHOLDER.
    gumroad_product_id: 'PLACEHOLDER_vehicle-repair-dispute',
    // STATIC as of 2026-09-19 (Batch 7: FINAL batch) -- prompt_template
    // below is now DEAD CODE.
    static: true,
    render: renderVehicleRepairDisputeGenerator,
    prompt_template:
      "Write a formal complaint letter addressed to {shop_name} regarding a repair performed on {vehicle_details}, dropped off on {dropoff_date} and {completion_status}, for a total cost of {amount_paid}. Describe the specific issue based on the type selected ({issue_type}): {issue_description}. If the matter was previously raised with the shop ({prior_contact} — if 'Yes — free text describing their response', reference that prior contact and the shop's response: {prior_contact_response}) — otherwise state this is the first formal contact. State the desired outcome clearly: {desired_outcome}. Keep tone factual and professional. Close with a reasonable response deadline (14 days) and contact details for reply. Do not invent regulatory citations or threaten specific legal action beyond stating that further steps will be considered.",
  },
  'insurance-claim-letter-generator': {
    title: 'Insurance Claim Letter Generator',
    // Gumroad product not yet created — Carlos uploads the file directly and
    // will provide the real product id in a follow-up prompt. PLACEHOLDER.
    gumroad_product_id: 'PLACEHOLDER_insurance-claim-letter',
    // STATIC as of 2026-09-19 (Batch 7: FINAL batch) -- prompt_template
    // below is now DEAD CODE.
    static: true,
    render: renderInsuranceClaimLetterGenerator,
    prompt_template:
      "Write a formal insurance claim letter addressed to {insurance_company} regarding policy number {policy_number} ({claim_number_if_any}). Describe the incident that occurred on {incident_date}: {incident_description}. Describe the resulting damages or losses: {damages_description}. State the coverage believed to apply: {relevant_coverage}. List the supporting documentation enclosed: {documentation_list}. State the amount being claimed ({amount_claimed}) and the desired outcome ({desired_outcome}) clearly. Keep tone factual, organized, and professional — this is a first submission, not a dispute. Close with a request for acknowledgement and next steps, and contact details for reply. Do not invent policy clause numbers, regulatory citations, or specific coverage guarantees not stated by the user.",
  },
  'insurance-claim-followup-escalation-generator': {
    title: 'Insurance Claim Follow-Up & Escalation Generator',
    // Gumroad product not yet created — Carlos uploads the file directly and
    // will provide the real product id in a follow-up prompt. PLACEHOLDER.
    gumroad_product_id: 'PLACEHOLDER_claim-followup-escalation',
    // STATIC as of 2026-09-19 (Batch 7: FINAL batch) -- prompt_template
    // below is now DEAD CODE. escalation_target's 4th option was corrected
    // 2026-09-16 (no longer references a nonexistent jurisdiction field) --
    // render function's branch condition matches the corrected live text.
    static: true,
    render: renderInsuranceClaimFollowupEscalationGenerator,
    prompt_template:
      "Write a formal letter addressed to {insurance_company} regarding claim number {claim_number} under policy {policy_number}, originally submitted on {claim_submission_date}. Based on the branch selected: for a routine follow-up, reference the date of last contact ({last_contact_date}) and any missed deadline ({missed_deadline}), and request an update. For a formal escalation, summarize the prior contact and responses received ({prior_contact_summary}), explain why they were unsatisfactory ({unsatisfactory_reason}), and address the letter to the appropriate escalation target ({escalation_target}) — if the target is unsure, phrase the letter to request the correct internal escalation contact. State the desired outcome ({desired_outcome}) clearly in either branch. Keep tone firmer and more formal for the escalation branch than for the routine follow-up branch, reflecting the unresolved prior attempt. Close with a reasonable response deadline (7 days for escalations, 14 days for routine follow-ups) and contact details for reply. Do not invent regulatory citations, ombudsman procedures, or specific compensation entitlements not stated by the user.",
  },
  'insurance-denial-coverage-dispute-generator': {
    title: 'Insurance Denial & Coverage Dispute Generator',
    // Gumroad product not yet created — Carlos uploads the file directly and
    // will provide the real product id in a follow-up prompt. PLACEHOLDER.
    gumroad_product_id: 'PLACEHOLDER_denial-coverage-dispute',
    // STATIC as of 2026-09-19 (Batch 7: FINAL batch) -- prompt_template
    // below is now DEAD CODE.
    static: true,
    render: renderInsuranceDenialCoverageDisputeGenerator,
    prompt_template:
      "Write a formal dispute letter addressed to {insurance_company} regarding claim number {claim_number} under policy {policy_number}, in response to the decision dated {decision_date}. Quote or summarize the insurer's stated reason(s): {insurer_reasons}. Based on the branch selected: for an outright denial, reference the policy clause(s) cited ({cited_clauses}), explain why this reasoning is disputed ({dispute_reasoning}), and reference the counter-evidence available ({counter_evidence}). For a coverage/amount dispute, state the amount or scope offered ({amount_offered}) versus what is believed correct ({amount_believed_correct}) and why, referencing supporting valuation or evidence ({supporting_evidence}). State the amount in dispute ({amount_in_dispute}) and desired outcome ({desired_outcome}) clearly. Keep tone factual, firm, and professional — this is a formal dispute, not a first-time complaint. Close with a reasonable response deadline (14 days) and contact details for reply. Do not invent policy clause numbers, regulatory citations, or ombudsman procedures not stated by the user.",
  },
  'third-party-liability-claim-letter-generator': {
    title: 'Third-Party Liability Claim Letter Generator',
    // Gumroad product not yet created — Carlos uploads the file directly and
    // will provide the real product id in a follow-up prompt. PLACEHOLDER.
    gumroad_product_id: 'PLACEHOLDER_third-party-liability-letter',
    // STATIC as of 2026-09-19 (Batch 7: FINAL batch) -- prompt_template
    // below is now DEAD CODE.
    static: true,
    render: renderThirdPartyLiabilityClaimLetterGenerator,
    prompt_template:
      "Write a formal liability claim letter addressed to {at_fault_party_name} ({insurer_if_known}) regarding an incident that occurred on {incident_date} at {incident_location}. Describe what happened: {incident_description}. Describe the damages or losses suffered: {damages_description}. Reference the supporting evidence available: {evidence_list}. State the amount being claimed ({amount_claimed}) and the basis for that amount ({amount_basis}). State the desired outcome ({desired_outcome}) clearly. Keep tone factual, professional, and non-accusatory in describing fault — state what happened and let the facts establish liability, rather than using inflammatory language. Close with a reasonable response deadline (14 days) and contact details for reply. Do not invent legal citations, liability percentages, or threaten specific legal action beyond stating that further steps will be considered.",
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

// Global (all-IPs-combined) counter key for the daily spend kill switch --
// same UTC-day derivation as rateKey() above, just not scoped to one IP.
function globalCallKey() {
  const day = new Date().toISOString().slice(0, 10);
  return `global:${day}:generators:calls`;
}

function getDailyCallCap(env) {
  const n = parseInt(env.GENERATOR_DAILY_CALL_CAP, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_CALL_CAP;
}

// Checked immediately before EVERY Anthropic call in this file (both the
// /preview generation and /unlock's regenerate-from-expired-preview
// fallback), so the two limits below are enforced identically everywhere
// generation can actually happen, not just on one endpoint.
//
// Returns { blocked: false, kv, ipKey, ipUsed, gKey, globalUsed } when the
// caller may proceed -- it does NOT increment anything itself; call
// recordGenerationUsage() with these fields after a successful generation,
// so a failed/errored Anthropic call never consumes budget from either
// counter (matches this file's pre-existing preview behavior, just now
// shared with /unlock too).
//
// Returns { blocked: true, response } when either limit is already hit;
// `response` is the exact Response to return to the caller.
//
// Both counters fail OPEN on a KV read error -- consistent with this file's
// existing per-IP limiter and preview-storage logic elsewhere, which already
// tolerate a transient KV blip rather than treating it as a hard failure.
// If GENERATORS_KV isn't bound at all, neither limit is enforced (same
// fail-open stance the original per-IP-only check already had).
async function checkGenerationLimits(env, ip) {
  const kv = env.GENERATORS_KV;
  if (!kv) return { blocked: false, kv: null };

  const cap = getDailyCallCap(env);
  const gKey = globalCallKey();
  let globalUsed = 0;
  try {
    const stored = await kv.get(gKey);
    globalUsed = stored ? parseInt(stored, 10) || 0 : 0;
  } catch (err) {
    globalUsed = 0; // fail open
  }
  if (globalUsed >= cap) {
    console.log('[kibbo-generators] daily call cap reached', {
      day: new Date().toISOString().slice(0, 10),
      time: new Date().toISOString(),
      cap,
      globalUsed,
    });
    return { blocked: true, response: jsonResponse({ paused: true }) };
  }

  const ipKey = rateKey(ip);
  let ipUsed = 0;
  try {
    const stored = await kv.get(ipKey);
    ipUsed = stored ? parseInt(stored, 10) || 0 : 0;
  } catch (err) {
    ipUsed = 0; // fail open
  }
  if (ipUsed >= DAILY_GENERATION_LIMIT) {
    return {
      blocked: true,
      response: jsonResponse(
        {
          error: 'limit_reached',
          message: "You've reached today's limit for generating documents. Please try again tomorrow.",
        },
        429
      ),
    };
  }

  return { blocked: false, kv, ipKey, ipUsed, gKey, globalUsed };
}

// Best-effort increment of both counters after a successful generation.
// Swallows write errors individually so one failing write never blocks the
// other, or the response already prepared for the caller.
async function recordGenerationUsage(limits) {
  if (!limits || !limits.kv) return;
  try {
    await limits.kv.put(limits.ipKey, String(limits.ipUsed + 1), { expirationTtl: KV_TTL });
  } catch (err) {
    /* best-effort */
  }
  try {
    await limits.kv.put(limits.gKey, String(limits.globalUsed + 1), { expirationTtl: KV_TTL });
  } catch (err) {
    /* best-effort */
  }
}

function randomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// TO GO LIVE (manual, one line, do this yourself once Anthropic credit is
// confirmed loaded AND a monthly cap is set in the Anthropic Console ->
// Settings -> Billing -- see the top-of-file comment):
//   npx wrangler secret put GENERATORS_PAUSED     (enter: false)
// or delete the secret entirely. Takes effect immediately, no redeploy.
//
// Billing pause toggle. Deliberately set as a Worker SECRET
// (`wrangler secret put GENERATORS_PAUSED`), not a wrangler.toml [vars]
// entry -- secrets aren't touched by a code-only `wrangler deploy`, so
// flipping this in the Cloudflare dashboard (or via `wrangler secret put`
// again) takes effect immediately with NO redeploy, and a future code
// change won't silently reset it back. Any value other than the exact
// string "true" is treated as unpaused (so an unset/missing secret defaults
// to normal operation, not paused).
function isGeneratorsPaused(env) {
  return env.GENERATORS_PAUSED === 'true';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fill {placeholders} from answers, then append every answer verbatim so values
// referenced only in prose (e.g. country) are always available to the model.
// outputRules defaults to the standard letter framing (OUTPUT_RULES below);
// a generator can override it via its own `output_rules` field for a
// structurally different deliverable (e.g. a numbered document, not a letter).
function buildPrompt(template, answers, outputRules) {
  let filled = template.replace(/\{(\w+)\}/g, (m, key) =>
    answers[key] != null && answers[key] !== '' ? String(answers[key]) : m
  );
  const details = Object.keys(answers)
    .map((k) => `- ${k}: ${answers[k]}`)
    .join('\n');
  return `${filled}\n\nAll details provided by the user:\n${details}${outputRules || OUTPUT_RULES}`;
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
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const gen = GENERATORS[body && body.generatorId];
  if (!gen) return jsonResponse({ error: 'Unknown generator' }, 400);

  // ---- Static-mode generators (see the top-of-file static-mode comment)
  // -- zero Anthropic dependency: not gated by isGeneratorsPaused(), doesn't
  // require ANTHROPIC_API_KEY, doesn't touch checkGenerationLimits() (that
  // exists purely to protect Anthropic spend, which doesn't apply here).
  // Abuse prevention is a separate, much more generous per-IP-only limit --
  // see checkStaticAbuseLimit().
  if (gen.static) {
    const answers = (body && body.answers) || {};
    if (typeof answers !== 'object' || !Object.keys(answers).length) {
      return jsonResponse({ error: 'Missing answers' }, 400);
    }
    const ip = clientIp(request);
    const abuseLimit = await checkStaticAbuseLimit(env, ip);
    if (abuseLimit.blocked) return abuseLimit.response;

    const letter = gen.render(answers);
    if (letter && typeof letter === 'object' && letter.staticValidationError) {
      return jsonResponse({ error: letter.staticValidationError }, 400);
    }
    if (!letter) return jsonResponse({ error: 'Could not generate a letter, please try again.' }, 502);

    const { visible, blurLines } = splitPreview(letter);
    const previewId = randomId();
    if (abuseLimit.kv) {
      try {
        await abuseLimit.kv.put(`preview:${previewId}`, letter, { expirationTtl: KV_TTL });
      } catch (err) {
        /* preview just won't survive a refresh; unlock will re-render from answers */
      }
    }
    await recordStaticUsage(abuseLimit);

    return jsonResponse({
      previewId,
      preview: visible,
      blurLines,
      remaining: Math.max(0, STATIC_DAILY_LIMIT - (abuseLimit.kv ? abuseLimit.used + 1 : 0)),
    });
  }

  // Billing pause (see the top-of-file comment) -- checked before anything
  // else touches Anthropic, the KV rate limiter, or requires answers to be
  // present at all. Zero Anthropic calls while this is set, full stop.
  if (isGeneratorsPaused(env)) {
    return jsonResponse({ paused: true });
  }

  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: 'Server is missing ANTHROPIC_API_KEY' }, 500);
  }

  const answers = (body && body.answers) || {};
  if (typeof answers !== 'object' || !Object.keys(answers).length) {
    return jsonResponse({ error: 'Missing answers' }, 400);
  }

  const ip = clientIp(request);

  // Per-IP daily limit + global daily kill switch, checked together right
  // before the one Anthropic call this endpoint makes (see the top-of-file
  // comment and checkGenerationLimits() for what each one does).
  const limits = await checkGenerationLimits(env, ip);
  if (limits.blocked) return limits.response;

  const prompt = buildPrompt(gen.prompt_template, answers, gen.output_rules);

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
  if (limits.kv) {
    try {
      await limits.kv.put(`preview:${previewId}`, letter, { expirationTtl: KV_TTL });
    } catch (err) {
      /* preview just won't survive a refresh; unlock will regenerate from answers */
    }
  }
  await recordGenerationUsage(limits);

  return jsonResponse({
    previewId,
    preview: visible,
    blurLines,
    remaining: Math.max(0, DAILY_GENERATION_LIMIT - (limits.kv ? limits.ipUsed + 1 : 0)),
  });
}

// ---- Free unlock: release the full letter for a given preview ----
// No license/payment check any more (see the pricing-model comment at the
// top of this file) -- the actual unlock gate is the email-capture step on
// the main site, entirely upstream of this Worker. This endpoint's only job
// is to hand back the letter the /preview call already generated, or
// regenerate it from the submitted answers if that preview expired from KV.
async function handleUnlock(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const gen = GENERATORS[body && body.generatorId];
  if (!gen) return jsonResponse({ error: 'Unknown generator' }, 400);

  // ---- Static-mode generators -- no Anthropic dependency, so no billing
  // pause, no rate limit on the re-render-from-answers fallback (it costs
  // nothing to protect against; the /preview call already counted once
  // against the abuse limit).
  if (gen.static) {
    const kv = env.GENERATORS_KV;
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
      if (Object.keys(answers).length) {
        letter = gen.render(answers);
      }
    }
    if (letter && typeof letter === 'object' && letter.staticValidationError) {
      return jsonResponse({ error: letter.staticValidationError }, 400);
    }
    if (!letter) {
      return jsonResponse({ error: 'Your preview expired — please generate it again.' }, 410);
    }
    return jsonResponse({ letter });
  }

  // Billing pause -- defense in depth. The front-end never calls /unlock at
  // all while paused (it already knows from /preview's { paused: true }
  // response and shows the "coming soon" message directly), but this stays
  // paused too in case /unlock is ever hit directly.
  if (isGeneratorsPaused(env)) {
    return jsonResponse({ paused: true });
  }

  const kv = env.GENERATORS_KV;

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
    // Regenerating from scratch means a second Anthropic call this preview
    // didn't already account for -- subject to the exact same per-IP/global
    // limits as /preview (this path used to call Anthropic with NO limit
    // check at all; that gap is closed here).
    const answers = (body && body.answers) || {};
    if (Object.keys(answers).length && env.ANTHROPIC_API_KEY) {
      const ip = clientIp(request);
      const limits = await checkGenerationLimits(env, ip);
      if (limits.blocked) return limits.response;
      try {
        letter = await generateLetter(env.ANTHROPIC_API_KEY, buildPrompt(gen.prompt_template, answers, gen.output_rules));
        if (letter) await recordGenerationUsage(limits);
      } catch (err) {
        letter = null;
      }
    }
  }
  if (!letter) {
    return jsonResponse({ error: 'Your preview expired — please generate it again.' }, 410);
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

// ---- DEPRECATED, unused since 2026-09-11 (see the pricing-model comment at
// the top of this file) -- handleUnlock() no longer calls this. Kept in
// place, not deleted, in case Gumroad monetization needs to be reverted to.
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
