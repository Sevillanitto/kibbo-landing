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
  'landlord-deposit-demand-letter': {
    title: 'Landlord Deposit Demand Letter',
    // Replaces the retired 'landlord-deposit' and 'security-deposit-demand-letter'
    // generators (consolidated into one scenario-branched tool covering both
    // "not returned" and "deductions disputed", across US/UK/EU/Australia).
    gumroad_product_id: 'gdyor',
    prompt_template:
      "Write a formal, firm but professional deposit demand letter matching the scenario selected. If scenario is 'Deposit not returned at all', demand full return within a reasonable stated period, referencing deposit_protection_scheme_name if provided, and the tenant's right to escalate to a jurisdiction-appropriate small claims/tenancy tribunal if unresolved. If scenario is 'Deposit returned with deductions I dispute', state amount_withheld and landlord_stated_reason, present tenant_counter_evidence, and request an itemized justification plus full or partial refund within a reasonable period. For jurisdiction={jurisdiction}, keep any cited deadlines or legal thresholds generic ('the deadline that applies in your area') — never invent a specific number. Tenant: {tenant_full_name}, forwarding address {tenant_forwarding_address}. Landlord: {landlord_full_name}. Property: {property_address}. Move-out: {move_out_date}. Deposit: {deposit_amount_paid}. Scenario: {scenario}. Days since move-out: {days_since_moveout}. Protection scheme: {deposit_protection_scheme_name}. Amount withheld: {amount_withheld}. Landlord's stated reason: {landlord_stated_reason}. Counter-evidence: {tenant_counter_evidence}. Tone: professional, firm, factual.",
  },
  'repair-request-formal-notice': {
    title: 'Repair Request Formal Notice',
    // Replaces the retired 'notice-to-repair' generator.
    gumroad_product_id: 'ofxzc',
    prompt_template:
      "Write a formal written repair request / habitability notice. Describe issue_description, first reported issue_first_reported_date, urgency urgency_level. If prior_notice_given is 'Yes', reference the prior request made on prior_notice_date without adequate resolution. For jurisdiction={jurisdiction}, state that landlords are generally expected to address urgent issues promptly, keeping any specific deadline generic ('within the timeframe required in your area') rather than inventing a number. Request a specific, reasonable repair date and note the tenant is documenting this request in case further action becomes necessary. Tenant: {tenant_full_name}. Landlord: {landlord_full_name}. Property: {property_address}. Issue: {issue_description}. First reported: {issue_first_reported_date}. Urgency: {urgency_level}. Prior notice given: {prior_notice_given}. Prior notice date: {prior_notice_date}. Tone: professional, non-confrontational.",
  },
  'illegal-eviction-warning-letter': {
    title: 'Illegal Eviction Warning Letter',
    gumroad_product_id: 'iavmyw',
    prompt_template:
      "Write a firm formal letter addressing incident_description on incident_date. State clearly that self-help eviction (changing locks, removing belongings, shutting off utilities, forcing a tenant out without a court-ordered legal process) is not a lawful method of eviction in most {jurisdiction} jurisdictions, and only a court-ordered/legally compliant process may remove a tenant. Demand immediate restoration of access/utilities/belongings as applicable. State the tenant is documenting this incident and will pursue all available legal remedies, including contacting local housing authorities or law enforcement, if not immediately resolved. Keep legal citations generic ('applicable landlord-tenant law in your area') rather than inventing statute numbers. Tenant: {tenant_full_name}. Landlord: {landlord_full_name}. Property: {property_address}. Incident: {incident_description}. Incident date: {incident_date}. Tone: firm, unambiguous — this is not a negotiation letter. Also suggest the tenant keep a copy and consider contacting local police/housing authority if access is actively being denied.",
  },
  'rental-scam-refund-demand': {
    title: 'Rental Scam Refund Demand',
    gumroad_product_id: 'esyrb',
    prompt_template:
      "Write two things: (1) a formal refund demand letter/message demanding return of amount_paid, paid via payment_method on payment_date, for a rental that scam_description. State this was based on false pretenses, demand a full refund within a short specific period, and note failure to respond will result in the matter being reported to listing_platform, the payment provider, and local law enforcement/consumer protection authorities in {jurisdiction}. (2) A short, separate, factual, non-alarmist checklist of where to report this scam based on payment_method (bank/card chargeback, payment app fraud report, gift card issuer fraud line, or noting cryptocurrency is generally non-reversible) — don't guess at recovery odds. Victim: {victim_full_name}. Amount paid: {amount_paid}. Payment method: {payment_method}. Payment date: {payment_date}. Recipient: {recipient_name_or_alias}. Listing platform: {listing_platform}. Scam description: {scam_description}. Tone: firm, factual.",
  },
  'lease-clause-challenge-letter': {
    title: 'Lease Clause Challenge Letter',
    gumroad_product_id: 'cajgj',
    prompt_template:
      "Write a professional letter challenging or requesting removal of clause_text_or_summary, concern category clause_concern_type. If already_signed is 'No', frame as a request to amend the clause before signing, politely explaining the concern. If already_signed is 'Yes', frame as a formal notice the clause may be unenforceable under {jurisdiction} tenant protection law (generic — 'may not be enforceable under applicable law in your area', never cite a specific statute unless independently verified) and request written confirmation the landlord will not attempt to enforce it. Tenant: {tenant_full_name}. Landlord: {landlord_full_name}. Property: {property_address}. Clause: {clause_text_or_summary}. Concern type: {clause_concern_type}. Already signed: {already_signed}. Tone: professional, factual — negotiation/notice letter, not a threat.",
  },
  'lease-violation-notice-generator': {
    title: 'Lease Violation Notice Generator',
    gumroad_product_id: 'yxkdiw',
    prompt_template:
      "Write a formal lease violation notice for violation_type, identified violation_date_identified, described as violation_description. State that under {jurisdiction} landlord-tenant law, the tenant is given formal notice and an opportunity to cure within the notice/cure period that applies locally — keep the specific number of days generic ('within the cure period required in your jurisdiction — confirm this before sending') rather than inventing a figure. State failure to cure within that period may result in further legal action, including eviction proceedings, in accordance with local law. Landlord: {landlord_full_name}. Tenant: {tenant_full_name}. Property: {property_address_unit}. Violation type: {violation_type}. Description: {violation_description}. Date identified: {violation_date_identified}. Tone: professional, formal — legal notice. Include a clear disclaimer the landlord must confirm the exact cure period and notice requirements for their jurisdiction before sending, as this is not legal advice.",
  },
  'au-privacy-complaint-letter': {
    title: 'Privacy Complaint Letter to a Company (Australia)',
    // Real Gumroad product_id for the "au-privacy-complaint-letter" product.
    gumroad_product_id: 'ymuznm',
    prompt_template:
      "Write a formal privacy complaint letter to an Australian company, to be sent BEFORE lodging an OAIC complaint (as required by law, giving the company approximately 30 days to respond). Reference the Privacy Act 1988 and the relevant Australian Privacy Principle if provided. State clearly that if the company does not respond satisfactorily within 30 days, the complainant intends to escalate to the Office of the Australian Information Commissioner (OAIC). Do not claim the OAIC's $3 million turnover jurisdiction threshold applies to this specific company unless the person confirms it — phrase this as a general note the reader should check, not an assumption about the company being complained about. Company: {company_name}. Issue: {issue}. APP: {app_breached}. Details: {details}. Remedy sought: {remedy}. Tone: professional, firm, factual.",
  },
  'eu-withdrawal-right-letter': {
    title: 'Withdrawal Right / Cancellation Letter (EU)',
    // Real Gumroad product_id for the "eu-withdrawal-right-letter" product.
    gumroad_product_id: 'onxtxv',
    prompt_template:
      "Write a formal EU right-of-withdrawal notice per Directive 2011/83/EU. State clearly no reason is required. If was_informed is 'No / Not sure', note that failing to properly inform the consumer extends the withdrawal window by 12 months, without asserting this applies with certainty — phrase as something to verify. Do not reference the discontinued ODR platform. Seller: {seller_name}. Order: {order_details}. Delivery date: {delivery_date}. Reason (if given): {reason}. Tone: professional, factual.",
  },
  'eu-legal-guarantee-demand': {
    title: 'Legal Guarantee Repair/Replacement Demand (EU)',
    // Real Gumroad product_id for the "eu-legal-guarantee-demand" product.
    gumroad_product_id: 'ypqab',
    prompt_template:
      "Write a formal legal guarantee (conformity) demand per Directive (EU) 2019/771. State the seller (not manufacturer) is responsible. If within the first year, note the burden-of-proof presumption favors the consumer. State full refund/termination is only available if repair/replacement first failed or was refused, unless remedy is already 'Full refund'. Do not assert a fixed 2-year or 3-year figure as universal — note it varies by member state (2-year EU minimum, some countries extend further). Seller: {seller_name}. Product: {product}. Purchase date: {purchase_date}. Defect: {defect}. Remedy: {remedy}. Tone: professional, factual.",
  },
  'eu261-flight-compensation-claim': {
    title: 'EU261 Flight Delay/Cancellation Compensation Claim',
    // Real Gumroad product_id for the "eu261-flight-compensation-claim" product.
    gumroad_product_id: 'uhpyudt',
    prompt_template:
      "Write a formal EU261 compensation claim per Regulation (EC) No 261/2004. Use the correct distance-based compensation tier: €250 (up to 1,500km), €400 (1,500-3,500km or long intra-EU flights), €600 (over 3,500km) based on distance_km. If cause is airline-controlled, assert the claim firmly; if weather/ATC, note the airline may invoke extraordinary circumstances and frame the claim accordingly without guaranteeing the outcome. State clearly that technical/crew issues are NOT extraordinary circumstances per established case law. Do not recommend using a third-party claims agency. Airline: {airline_name}. Flight: {flight_details}. Scenario: {scenario}. Distance: {distance_km}km. Cause: {cause}. Duty of care: {duty_of_care}. Remedy: {remedy}. Tone: professional, firm, factual.",
  },
  'eu-baggage-claim-montreal': {
    title: 'EU Baggage Claim Letter (Montreal Convention)',
    // Real Gumroad product_id for the "eu-baggage-claim-montreal" product.
    gumroad_product_id: 'dkgscf',
    prompt_template:
      "Write a formal baggage claim under the Montreal Convention. Reference the current liability cap of 1,519 SDR per passenger (approx €2,000, noting the exact euro value fluctuates with the SDR exchange rate — do not assert one fixed euro figure). For damaged baggage, note the 7-day filing deadline from delivery. For lost baggage, note the 21-day threshold at which it's legally considered lost rather than delayed. State clearly this is reimbursement of demonstrated value, not a flat payout. Airline: {airline_name}. Flight: {flight_details}. Issue: {issue}. PIR filed: {pir_filed}. Itemized value: {itemized_value}. Tone: professional, factual.",
  },
  'eu-train-delay-claim': {
    title: 'EU Train Delay Compensation Claim',
    // Real Gumroad product_id for the "eu-train-delay-claim" product.
    gumroad_product_id: 'preig',
    prompt_template:
      "Write a formal EU rail delay compensation claim per Regulation (EU) 2021/782. Use the correct tier: 25% refund (60-119 min delay) or 50% refund (120+ min delay) based on delay_minutes. Note that if cause is force majeure, cash compensation may not apply, but the duty-of-care obligation (food, accommodation) still applies regardless of cause — frame accordingly. If missed_connection is Yes, assert the right to free rerouting on the next available train, including a partner operator, or alternative transport. Operator: {operator_name}. Journey: {journey_details}. Delay: {delay_minutes} min. Cause: {cause}. Missed connection: {missed_connection}. Duty of care: {duty_of_care}. Tone: professional, factual.",
  },
  'eu-package-holiday-complaint': {
    title: 'EU Package Holiday Complaint & Compensation Claim',
    // Real Gumroad product_id for the "eu-package-holiday-complaint" product.
    gumroad_product_id: 'ubqkuu',
    prompt_template:
      "Write a formal complaint to a package travel organiser per Directive (EU) 2015/2302. State the organiser is fully liable for every service in the package, not individual suppliers. If issue is a significant pre-departure change, assert the right to reject it and receive a full refund within 14 days. If non-conformity at destination, request equivalent alternative arrangements or a proportionate price reduction. If insolvency, reference the mandatory insolvency protection insurance and the right to free repatriation. Note this only applies if the booking qualifies as a 'package' under the directive (two or more linked travel services sold together) — flag this as worth confirming if unclear. Agency: {agency_name}. Trip: {trip_details}. Issue: {issue}. Details: {details}. Remedy: {remedy}. Tone: professional, firm, factual.",
  },
  'eu-bank-complaint-finnet': {
    title: 'Bank Complaint Letter (EU / PSD2 / FIN-NET)',
    // Real Gumroad product_id for the "eu-bank-complaint-finnet" product.
    gumroad_product_id: 'jceka',
    prompt_template:
      "Write a formal complaint letter to a European bank. If escalation_stage is 'Filing the first complaint', title it explicitly 'Formal Complaint under the Payment Services Directive' if issue is payment-service related, and note the bank has 15 business days (extendable to 35 in exceptional cases) to respond if this applies. If escalation_stage is 'didn't respond' or 'unsatisfactory', state the complainant intends to escalate via FIN-NET to their national financial ombudsman. Do not claim FIN-NET decisions are universally binding — phrase as a strong, free escalation path rather than a guaranteed legal outcome. Bank: {bank_name}. Issue: {issue}. Details: {details}. Stage: {escalation_stage}. Remedy: {remedy}. Tone: professional, firm, factual.",
  },
  'eu-sepa-recall-request': {
    title: 'SEPA Recall Request Letter',
    // Real Gumroad product_id for the "eu-sepa-recall-request" product.
    gumroad_product_id: 'qawzs',
    prompt_template:
      "Write a formal SEPA Recall request to a bank. Reference the standard SEPA scheme rulebook recall framework — request initiated within a reasonable window (commonly cited as around 10 business days), noting the receiving bank typically has around 15 business days to respond. State clearly the receiving bank cannot withdraw funds from the recipient's account without their consent unless fraud or a technical error is shown. If vop_shown indicates VoP wasn't offered or failed, separately note this may support a compensation claim against the sending bank under the Instant Payments Regulation, distinct from the recall itself. Bank: {bank_name}. Transfer: {transfer_details}. Basis: {basis}. VoP: {vop_shown}. Details: {details}. Tone: professional, factual, urgent but not alarmist.",
  },
  'eu-unauthorised-transaction-psd2': {
    title: 'Unauthorised Transaction Refund Demand (PSD2)',
    // Real Gumroad product_id for the "eu-unauthorised-transaction-psd2" product.
    gumroad_product_id: 'zdjykv',
    prompt_template:
      "Write a formal PSD2 unauthorised transaction refund demand. If sca_used is 'No' or 'Not sure', assert liability shifts to the bank/merchant for failing to require SCA. Cite the €50 maximum liability cap for losses before the transaction was reported, and zero liability for anything after reporting. Demand restitution 'by no later than the end of the following business day' after notification, per PSD2. Do NOT reference PSD3 as if it's already in force — PSD2 is the current governing law. Bank: {bank_name}. Transaction: {transaction_details}. SCA used: {sca_used}. Reported: {reported_date}. Loss before report: {loss_before_report}. Tone: professional, firm, factual.",
  },
  'eu-gdpr-rights-request': {
    title: 'GDPR Rights Request Letter (Access / Erasure / Complaint)',
    // Real Gumroad product_id for the "eu-gdpr-rights-request" product.
    gumroad_product_id: 'pnpwzz',
    prompt_template:
      "Write a formal GDPR rights request letter matching request_type. For Access requests, cite Article 15 and request purposes of processing, categories of data, recipients, and retention period. For Erasure requests, cite Article 17, using the phrase 'I hereby exercise my Right to Erasure under Article 17 of the GDPR'. For both Access and Erasure, note the response deadline is one month, extendable by up to two further months for complex requests provided the company notifies the requester within the first month — do NOT describe this deadline as non-extendable or absolute. For a DPO complaint, frame it as the required pre-escalation step before a formal DPA complaint, referencing a 30-day response expectation before escalating. Company: {company_name}. Request type: {request_type}. Details: {details}. Prior contact: {prior_contact}. Tone: professional, firm, factual.",
  },
  'eu-gdpr-violation-report': {
    title: 'GDPR Violation Report / Whistleblower Notice',
    // Real Gumroad product_id for the "eu-gdpr-violation-report" product.
    gumroad_product_id: 'covqc',
    prompt_template:
      "Write a formal GDPR violation report suitable for submission to a national Data Protection Authority. If reporter_role is 'Employee/contractor', reference protections under the EU Whistleblower Directive (2019/1937) against retaliation. Reference the 72-hour breach notification duty under Article 33 where relevant. Do not encourage the reporter to unlawfully exfiltrate bulk data belonging to others as evidence — advise gathering evidence within lawful means. If anonymity_preference is 'Anonymous', note that fully anonymous reports may limit the regulator's ability to follow up with clarifying questions. Organisation: {organisation_name}. Role: {reporter_role}. Violation type: {violation_type}. Details: {details}. Anonymity: {anonymity_preference}. Tone: professional, factual, serious.",
  },
  'eu-platform-dispute-letter': {
    title: 'Marketplace/Platform Dispute Letter (Amazon/Booking/Airbnb/PayPal)',
    // Real Gumroad product_id for the "eu-platform-dispute-letter" product.
    gumroad_product_id: 'echmjl',
    prompt_template:
      "Write a formal dispute letter tailored to the selected platform. For Amazon: invoke the 14-day withdrawal right or 2-year legal guarantee as applicable, and the A-to-z Guarantee as Amazon's own escalation layer — do NOT reference the discontinued EU ODR platform; if escalation beyond Amazon is needed, reference ECC-Net or national ADR bodies instead. For Booking.com: if booking_type is 'Package/linked booking', invoke Directive (EU) 2015/2302's alternative accommodation mandate; if 'Standalone hotel booking', frame this as a general breach-of-contract claim against the hotel, NOT the codified package travel relocation right. For Airbnb: reference the Guest Refund Policy and note the 72-hour reporting window is Airbnb's own policy, not EU statute, while price/description accuracy is grounded in EU unfair commercial practices law. For PayPal: reference Buyer Protection's 180-day dispute window and 20-day negotiation period as PayPal's own program rules, and note the CSSF Luxembourg escalation path if internal arbitration is unfair. Platform: {platform}. Booking type: {booking_type}. Issue: {issue}. Transaction: {transaction_details}. Remedy: {remedy}. Tone: professional, firm, factual.",
  },
  'eu-subscription-cancellation-demand': {
    title: 'Subscription Cancellation & Refund Demand Letter (EU)',
    // Real Gumroad product_id for the "eu-subscription-cancellation-demand" product.
    gumroad_product_id: 'zyuop',
    prompt_template:
      "Write a formal EU subscription cancellation/refund letter. If scenario is 'Still within my 14-day withdrawal window', invoke Directive (EU) 2023/2673's withdrawal right and request a pro-rata refund. If scenario is 'Trying to cancel an ongoing subscription (past 14 days)', note that a cancellation-button law applies in some member states (e.g. Germany, France) but is NOT yet uniform EU law — request cancellation citing the company's own terms and, if the country field matches Germany or France, their specific national cancellation-button law. If scenario is 'Charged for a renewal I wasn't properly notified about', invoke national consumer protection law citing lack of pre-contractual transparency, without asserting a single EU-wide notice period (varies by member state, commonly 15-30 days where a national law exists). If remedy involves revoking a payment mandate, reference the right under PSD2 to do so via the consumer's own bank. Do not present the cancellation button as EU-wide law outside the 14-day withdrawal context. Company: {company_name}. Country: {country}. Scenario: {scenario}. Sign-up date: {signup_date}. Details: {details}. Remedy: {remedy}. Tone: professional, firm, factual.",
  },
  'flight-disruption-compensation-reimbursement': {
    title: 'Flight Disruption Compensation & Reimbursement Letter',
    // Real Gumroad product_id for the "flight-disruption-compensation-reimbursement" product.
    gumroad_product_id: 'tnyor',
    prompt_template:
      "Write a formal flight disruption letter combining a statutory compensation claim and/or an expense reimbursement demand, based on jurisdiction and scenario. If jurisdiction is 'EU (EU261)': cite Regulation (EC) 261/2004, state compensation of €250/€400/€600 depending on distance (do not calculate the exact distance-based figure yourself — instruct the reader to confirm the correct tier), and note compensation does not apply if the airline proves 'extraordinary circumstances'. If jurisdiction is 'UK (UK261)': cite UK261, use the same tiered logic in GBP equivalents (£220/£350/£520), and note the 6-year claim deadline (5 years in Scotland). If jurisdiction is 'US (DOT rules)': note the US has no fixed cash compensation scheme equivalent to EU261/UK261, and instead reference the automatic cash refund entitlement under 14 CFR 259.5 for a cancelled or significantly changed flight, phrased cautiously as an area with less standardised compensation than EU/UK. If jurisdiction is 'Australia (ACL)': note that Australia has no dedicated flight compensation regulation equivalent to EU261, and any claim rests on general Australian Consumer Law grounds (was the service provided with due care, was the delay reasonably avoidable) — phrase this cautiously and do not invent a specific compensation figure. If jurisdiction is 'Not sure': ask the reader to confirm before the letter is finalized, and default to the most cautious general framing. If scenario is 'Baggage lost, damaged, or delayed — no other disruption', do not reference flight delay/cancellation compensation at all — write purely a baggage claim letter referencing the Montreal Convention's 1,519 SDR per-passenger liability cap (noting this is a cap, not a guaranteed payout, and does not apply if a special value declaration was made and a higher fee paid). If baggage_issue is anything other than 'No' AND scenario is a flight disruption scenario, add a distinct paragraph covering the baggage claim on top of the disruption claim, keeping the two legally separate. If duty_of_care_provided indicates the airline did not provide adequate care, add a paragraph demanding reimbursement of the specific out-of-pocket expenses described, framed as separate from and additional to any statutory compensation. Never state a specific compensation figure with false confidence when jurisdiction is US, Australia, or Not sure. Airline: {airline_name}. Booking: {booking_reference}. Flight: {flight_details}. Scenario: {scenario}. Reason given: {reason_given}. Baggage: {baggage_issue} — {baggage_details}. Duty of care: {duty_of_care_provided} — {out_of_pocket_expenses}. Remedy sought: {remedy_sought}. Tone: professional, firm, factual.",
  },
  'unpaid-wage-compensation-demand': {
    title: 'Unpaid Wage & Compensation Demand Letter',
    // Real Gumroad product_id for the "unpaid-wage-compensation-demand" product.
    gumroad_product_id: 'sbadbs',
    prompt_template:
      "Write a formal unpaid wage/compensation demand letter matching the reason selected. For 'Unpaid trial shift': note that in most jurisdictions, if the worker performed productive work rather than pure observation/shadowing, wage laws generally require payment regardless of the word 'trial' or 'unpaid' in the arrangement — phrase this as a general principle, not a jurisdiction-specific citation, since trial shift rules vary by location. For 'Mandatory training time': note that time an employer requires an employee to spend in training is generally compensable work time under most wage laws, distinct from truly voluntary, non-required training. For 'Overtime hours': request the specific overtime premium calculation without asserting a specific jurisdiction's overtime rate or threshold unless the person's location is known. Do not state a specific legal citation or statute for any reason unless jurisdiction is clear from context — keep legal framing general ('wage protection laws in most jurisdictions require...') rather than citing a specific act. Employer: {employer_name}. Reason: {reason}. Amount: {amount_owed}. Period: {period_covered}. Details: {details}. Prior contact: {prior_contact}. Tone: professional, firm, factual.",
  },
  'wrongful-wage-deduction-letter': {
    title: 'Wrongful/Unlawful Wage Deduction Letter',
    // Real Gumroad product_id for the "wrongful-wage-deduction-letter" product.
    gumroad_product_id: 'ozzcfn',
    prompt_template:
      "Write a formal letter disputing a wage deduction. Note that in most jurisdictions, deductions from wages generally require the employee's prior written consent and/or specific legal authorization, and blanket 'shortage' or 'damage' deductions taken without due process are frequently unlawful — phrase this as a general principle across jurisdictions, not a specific statute citation, since wage deduction law varies significantly by location. If consent_given is 'No' or 'Not sure', emphasize the lack of valid authorization as the central issue. Request full repayment of the deducted amount within a reasonable timeframe (e.g. 14 days) and reference the employee's right to escalate to a labor authority if unresolved. Employer: {employer_name}. Deduction reason: {deduction_reason}. Amount: {amount_deducted}. Consent given: {consent_given}. Details: {details}. Tone: professional, firm, factual.",
  },
  'employment-reference-request': {
    title: 'Employment Reference Request',
    // Real Gumroad product_id for the "employment-reference-request" product.
    gumroad_product_id: 'ehhenj',
    prompt_template:
      "Write a formal, polite but firm request for an employment reference from a former employer. Note that in most jurisdictions employers are NOT legally required to provide anything beyond confirming dates of employment and job title, unless a specific contractual or jurisdiction-specific obligation applies — do not assert a legal entitlement to a full reference. Frame the letter as a professional request rather than a demand, since there is generally no enforceable right being invoked here, with an exception noted only if the refusal_context suggests retaliation for a protected complaint (e.g. discrimination, whistleblowing), in which case add a cautious note that retaliatory reference refusal may raise separate legal issues worth discussing with an employment lawyer. Former employer: {former_employer}. Role: {job_title}. Context: {refusal_context}. Urgency: {urgency}. Tone: professional, courteous, direct.",
  },
  'constructive-dismissal-complaint': {
    title: 'Constructive Dismissal Complaint Letter',
    // Real Gumroad product_id for the "constructive-dismissal-complaint" product.
    gumroad_product_id: 'hfiygj',
    prompt_template:
      "Write a formal letter documenting the case for constructive dismissal (or, if country is 'United States', use the term 'constructive discharge' instead throughout, and note this is a doctrine applied case-by-case rather than a codified statute, distinct from the UK/Australia/EU concept of constructive dismissal). Emphasize that the employer's conduct must be objectively serious enough that a reasonable person in the employee's position would have no reasonable alternative but to resign — mere unhappiness or a single minor grievance does not qualify. If country is 'United Kingdom', note that UK unfair dismissal claims generally require at least two years of continuous employment, and flag this as something to verify before proceeding. If prior_complaints indicates the employee never raised the issue before resigning, note this may weaken the claim, since most jurisdictions expect the employee to have given the employer a chance to address the conduct, or to show why doing so was clearly futile. If pattern_or_incident is 'Pattern of incidents', instruct the letter to lay out a clear chronological timeline of the pattern rather than treating it as one event. Advise the employee to resign promptly after the triggering conduct or shortly after raising it without resolution, since delay can be read as acceptance of the conditions. Do not guarantee a specific legal outcome or cite a specific statute number. Employer: {employer_name}. Country: {country}. Conduct: {conduct_description}. Pattern: {pattern_or_incident}. Prior complaints: {prior_complaints}. Resignation date: {resignation_date}. Tone: professional, serious, factual — this is a formal legal document, not an emotional appeal.",
  },
  'workplace-harassment-complaint': {
    title: 'Workplace Harassment Complaint Letter',
    // Real Gumroad product_id for the "workplace-harassment-complaint" product.
    gumroad_product_id: 'kjxsaj',
    prompt_template:
      "Write a formal harassment complaint letter addressed to HR. If harassment_type is 'Discriminatory harassment', explicitly frame the complaint around the relevant protected characteristic to preserve any anti-discrimination legal protections, without naming a specific statute unless jurisdiction is known. If harassment_type is 'Retaliation after a prior complaint', frame retaliation as a distinct and often more serious issue than the original complaint, since retaliation protections exist independently in most jurisdictions. Request a specific, timely response (e.g. within 5-10 business days) and a description of the investigation process. If prior_reports indicates this was already reported without action, state this clearly and note that continued inaction may itself be a separate issue. Advise the employee to keep a copy of this letter and any response. Company: {company_name}. Person involved: {harasser_role}. Nature: {harassment_type}. Details: {incident_details}. Witnesses: {witnesses}. Prior reports: {prior_reports}. Tone: professional, serious, factual.",
  },
  'flexible-working-request': {
    title: 'Flexible Working Request',
    // Real Gumroad product_id for the "flexible-working-request" product.
    gumroad_product_id: 'jmyyim',
    prompt_template:
      "Write a formal flexible working request letter. If country is 'United Kingdom', note that UK employees generally have a statutory right to REQUEST flexible working from day one of employment, though the employer can still refuse for specified business reasons — the right is to make the request and receive a considered response, not an automatic entitlement to the arrangement itself. If country is 'Australia', note the National Employment Standards give certain eligible employees (e.g. parents, carers, employees with disability, older workers) a right to request flexible working arrangements, with similar limits. If country is 'United States', note there is no general federal right to request flexible working — this is a workplace request, not a legal entitlement, though it may still be reasonable to request in writing, and add that this differs for accommodation requests tied to disability (ADA) which follow a separate legal process not covered by this general letter. If country is 'Other/not sure', keep the framing general and advise the employee to check local law. Present the specific proposed arrangement clearly and offer to discuss a trial period. Employer: {employer_name}. Request type: {request_type}. Reason: {reason}. Proposed arrangement: {proposed_arrangement}. Country: {country}. Tone: professional, collaborative, clear.",
  },
  'employment-data-access-request': {
    title: 'Employment Data Access Request (GDPR/Privacy)',
    // Real Gumroad product_id for the "employment-data-access-request" product.
    gumroad_product_id: 'vsnrks',
    prompt_template:
      "Write a formal data access/deletion/complaint letter matching request_type. If country is 'European Union' or 'United Kingdom', cite GDPR/UK GDPR Article 15 (access) or Article 17 (erasure) as applicable, and note the standard one-month response deadline, extendable to three months for complex requests with proper notice. If request_type is 'Complaint: CV shared without authorization', frame this as a potential violation of data minimization/purpose limitation principles under GDPR (if EU/UK) or as a general privacy complaint otherwise, and request confirmation of who the data was shared with and why. If country is 'United States', note there is no single federal equivalent to GDPR — reference relevant state privacy laws only in general terms (e.g. 'your state's privacy law, if applicable') without citing a specific act unless the person's state is known, and frame the request as a general privacy request rather than a GDPR-based legal right. If country is 'Australia', reference the Privacy Act 1988 and Australian Privacy Principles in general terms. If relationship is 'Former employee' and request_type involves deletion, note that employers may have independent legal retention obligations (tax, employment records) that can limit full deletion even where a privacy law otherwise permits it — do not promise complete erasure will necessarily be granted. Organisation: {organisation_name}. Relationship: {relationship}. Request type: {request_type}. Details: {details}. Country: {country}. Tone: professional, firm, factual.",
  },
  'source-of-funds-package-generator': {
    title: 'Source of Funds Package Generator',
    // Real Gumroad product_id for the "source-of-funds-package-generator" product.
    gumroad_product_id: 'bvltq',
    prompt_template:
      "Generate a complete Source of Funds compliance package, not just a single letter. Structure the output in these sections: (1) A cover letter addressed to {institution_name}'s compliance team, professional and cooperative in tone, stating the total amount under review and referencing that this package is submitted to support their AML/KYC review. (2) A chronological timeline of the funds' origin and movement, built from {timeline_details}, presented as a dated list. (3) An income/source breakdown table listing each source category that applies (from primary_category and secondary_categories) with approximate amounts. (4) A plain-language explanation of the origin of the capital, written in first person as if from the account holder, tying the categories and timeline together into one coherent narrative rather than disconnected facts. (5) A final checklist of exactly which supporting documents should be attached for each category claimed, cross-referencing {documents_available} and flagging anything commonly requested that the person hasn't mentioned having. If prior_contact indicates the account is currently frozen, adjust the cover letter's tone to note the account restriction and request a response timeline, without being confrontational. Never claim this package guarantees the review will be resolved favorably — frame it as organizing the strongest possible case, not a guaranteed outcome. Institution: {institution_name}. Amount: {amount_in_question}. Primary category: {primary_category}. Additional sources: {secondary_categories}. Timeline: {timeline_details}. Documents available: {documents_available}. Status: {prior_contact}. Tone: professional, thorough, cooperative.",
  },
  'exchange-account-freeze-response': {
    title: 'Exchange Account Freeze/Lockout Response Letter',
    // Real Gumroad product_id for the "exchange-account-freeze-response" product.
    gumroad_product_id: 'inkhin',
    prompt_template:
      "Write a formal response letter to a cryptocurrency exchange regarding a frozen or restricted account. If freeze_reason_given is 'No reason given at all' or 'Generic compliance review', explicitly request the specific reason for the restriction and cite the exchange's own terms of service obligation to provide this (most exchange terms require disclosure of the general nature of a hold, even if full compliance details can't be shared). If freeze_reason_given is 'Source of funds/AML review requested', reference that supporting documentation is being prepared and ask for the specific list of documents the compliance team requires, and the expected review timeframe. If freeze_reason_given is 'Suspected account compromise', request confirmation of what security concern triggered the hold and what specific verification is needed to lift it. Request a clear timeline for resolution, and note that prolonged, unexplained freezes may warrant escalation to the exchange's relevant national regulator if unresolved within a reasonable period (do not name a specific regulator unless jurisdiction is known — keep this general). Do not encourage aggressive or threatening language; keep the letter firm but constructive, since cooperative tone tends to move compliance reviews faster than confrontational ones. Exchange: {exchange_name}. Reason given: {freeze_reason_given}. Freeze date: {freeze_date}. Amount affected: {amount_affected}. Communication so far: {communication_so_far}. Urgency: {urgency_factors}. Tone: firm, professional, cooperative.",
  },
  'crypto-complaint-generator': {
    title: 'Crypto Complaint Generator',
    // Real Gumroad product_id for the "crypto-complaint-generator" product.
    gumroad_product_id: 'hbmkox',
    prompt_template:
      "Generate a formal complaint letter, routed to the correct regulator(s) based on country AND problem_type — do not assume a single regulator per country, since especially in the US multiple agencies have narrow, non-overlapping jurisdiction. Routing logic: UNITED STATES — for 'Suspected fraud or scam' or 'Misleading marketing', direct the complaint to the FTC (ReportFraud.ftc.gov) and note the SEC's complaint portal as an additional option if the problem involves what could be an unregistered securities offering; for 'Exchange won't release my funds' or 'Unauthorized transaction', direct to FinCEN's complaint channel if it's a suspected AML/registration issue, and separately note the CFPB for bank-related crypto disputes; for 'Bank refused/closed my account', direct to the CFPB and the OCC if a national bank is involved; explicitly state that the US has no single crypto complaint regulator and the right agency depends on the specific issue. UNITED KINGDOM — direct to the FCA for most complaints, noting the Financial Ombudsman Service (FOS) as the individual dispute resolution path if the FCA-regulated firm doesn't resolve it directly. EUROPEAN UNION — direct to the national competent authority in the person's own member state responsible for MiCA enforcement (do not name a specific single EU-wide crypto regulator, since MiCA enforcement is delegated to national authorities), and note the relevant national financial ombudsman for individual disputes. AUSTRALIA — direct to ASIC for most complaints, noting AFCA (Australian Financial Complaints Authority) as the individual dispute resolution path, and Scamwatch/ACCC specifically for suspected scams rather than regulatory/licensing complaints. If country is 'Other/not sure', keep the letter general and advise the person to identify their national financial regulator before submitting. If prior_contact indicates no direct contact yet, recommend contacting the company directly first before regulatory escalation, unless problem_type is 'Suspected fraud or scam', where direct regulatory/law enforcement reporting takes priority over trying to resolve it with a likely-fraudulent entity. Company/entity: {entity_name}. Problem: {problem_type}. Amount: {amount_involved}. Details: {details}. Prior contact: {prior_contact}. Country: {country}. Tone: professional, factual, firm.",
  },
  'restaurant-policies-generator': {
    title: 'Restaurant Policies Generator',
    // Gumroad short-code product_id for the "restaurant-policies-generator" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/oblszp -> .../l/restaurant-policies-generator).
    gumroad_product_id: 'oblszp',
    prompt_template:
      "Generate a clear, professional {policy_type} for a restaurant called {restaurant_name} ({restaurant_type}). Use these specifics the restaurant provided: {policy_details}. Write in plain, customer-facing language suitable to post on the restaurant's own website or print for guests. This is a policy document meant to carry the restaurant's own name, not Kibbo's — do not add any Kibbo branding, letterhead, date, recipient address block, or signature line. Include a brief closing note that local consumer protection laws may impose additional requirements the restaurant should verify independently. Format with clear headers, no legal jargon.",
  },
  'food-recall-action-plan-generator': {
    title: 'Food Recall Action Plan Generator',
    // Gumroad short-code product_id for the "food-recall-action-plan-generator" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/heasbt -> .../l/food-recall-action-plan-generator).
    gumroad_product_id: 'heasbt',
    prompt_template:
      "Generate a food safety incident action plan for {restaurant_name} regarding {product_affected}, discovered via {source} ({supplier_or_internal}). Already served to customers: {served}. If served, approximate date range and covers affected: {served_details}. Incident manager: {contact_person}. Produce four clearly headed sections: (1) Internal Protocol — immediate containment steps; (2) Withdrawal Checklist — physical removal from kitchen, storage, menu, and delivery platforms, formatted as a checklist suitable to print and post in a kitchen; (3) Communication Templates — a short template for affected customers and, if applicable, a short template for the local food safety authority; (4) Incident Log — a dated table template (columns: Date/Time, Action Taken, Staff Member, Notes) for recording actions as they happen. Keep language calm, procedural, and non-alarmist but clear about urgency. This is an internal operational document, not a letter to a third party — do not add a date, address block, or signature line for the document as a whole.",
  },
  'allergen-menu-labeling-generator': {
    title: 'Allergen Menu Labeling Generator',
    // Gumroad short-code product_id for the "allergen-menu-labeling-generator" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/votobg -> .../l/allergen-menu-labeling-generator).
    gumroad_product_id: 'votobg',
    prompt_template:
      "You are labeling a restaurant menu for {restaurant_name} for allergen disclosure under {jurisdiction} requirements. For each dish below, identify which allergens from that jurisdiction's official allergen list are present based on the ingredients given, and err on the side of flagging a possible allergen if an ingredient is ambiguous. Dishes and ingredients: {menu_input}. Output a table with these exact columns: Dish Name | Allergens Present | Notes. Cross-contamination risk in the kitchen: {cross_contamination} — if Yes, add a short general cross-contact warning notice after the table; if No, omit it. Always end with this exact disclaimer on its own line: \"Generated based on ingredients provided by the restaurant — always verify with your supplier's ingredient documentation. This does not replace professional regulatory review.\" This is a printable menu insert, not a letter — do not add a date, address block, or signature line.",
  },
  'formal-complaint-generator': {
    title: 'Formal Complaint Generator',
    // Gumroad short-code product_id for the "formal-complaint-generator" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/tedlq -> .../l/formal-complaint-generator).
    gumroad_product_id: 'tedlq',
    prompt_template:
      "Generate a clear, formal complaint letter from {your_name} to {provider_name} regarding {course_name}, purchased/enrolled on {enrollment_date} for {amount_paid}. The problem type selected by the user is: {problem_type}. Specific details of what happened: {problem_details}. State clearly what resolution is being requested: {desired_outcome}. Tailor the letter's focus to the selected problem type — for example, an institution closure complaint should center on the closure date and any alternative offered; a refund-refusal complaint should center on the original refund policy and the provider's stated reason for refusing; a misleading-advertising complaint should center on the specific claims made versus what was actually delivered; a fake/invalid certificate complaint should center on what was promised about accreditation/recognition versus what was actually true; a bootcamp complaint should center on the specific broken promise (job guarantee, curriculum, or cohort change); an online platform complaint should center on the access that was promised versus what actually happened. If the problem type is 'Linked credit/financing issues', additionally note that in many jurisdictions a linked or connected credit agreement can be legally challenged if the underlying course was cancelled, misrepresented, or not delivered — phrase this as worth raising with the credit provider and worth checking against local consumer credit law, not as a guaranteed right, since this varies significantly by country and credit type. Reference relevant consumer protection principles in general terms (without claiming to give jurisdiction-specific legal advice), and note that this letter may be escalated to a relevant regulator or ombudsman if not resolved within a reasonable timeframe. Write in a firm, professional, non-aggressive tone. Format as a proper letter with date, recipient, subject line, and closing.",
  },
  'course-provider-terms-refund-policy-generator': {
    title: 'Course Provider Terms & Refund Policy Generator',
    // Gumroad short-code product_id for the "course-provider-terms-refund-policy-generator" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/pvhywh -> .../l/course-provider-terms-refund-policy-generator).
    gumroad_product_id: 'pvhywh',
    prompt_template:
      "Generate a clear, professional {document_type} for an education provider called {provider_name} ({provider_type}), a {program_duration} program priced via {price_model}. Use these specifics the provider gave: {document_details}. Write in plain, learner-facing language, addressed to the provider's own students/customers — this document carries the provider's own name, not Kibbo's, so do not add any Kibbo branding, letterhead, or signature line. For the Marketing Claims Disclaimer specifically: help the provider state any outcome or employment statistics accurately and avoid absolute guarantees — flag language like 'guaranteed job placement' as a legal and reputational risk unless the provider can substantiate an actual guarantee with a real refund or remedy attached to it. Include a brief closing note that local consumer protection laws may impose additional requirements the provider should verify independently. Format with clear headers, no legal jargon.",
  },
  'vendor-compensation-demand-letter': {
    title: 'Vendor Compensation Demand Letter',
    // Gumroad short-code product_id for the "vendor-compensation-demand-letter" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/fvqvcv -> .../l/vendor-compensation-demand-letter).
    gumroad_product_id: 'fvqvcv',
    prompt_template:
      "Generate a clear, formal demand letter from {your_name} to {vendor_name} — the SELLER/VENDOR, not the carrier — regarding order {order_reference}, placed on {order_date} for {amount_paid}. The specific issue is: {scenario}. If scenario is 'Lost parcel (never arrived, or tracking shows no movement)': the last tracking update was {last_tracking_update}, with {days_since_movement} days since any tracking movement, carried by {carrier_used}; carrier confirmed the parcel lost: {carrier_confirmed_lost}. If scenario is 'Damaged parcel (arrived damaged, or contents damaged)': damage was discovered on {damage_discovered_date}, described as: {damage_description}; photos available: {photos_available}; original packaging kept: {packaging_kept}. If scenario is 'Late delivery (arrived significantly after promised date)': the promised/estimated delivery date was {promised_delivery_date}, actual delivery was {actual_delivery_date} (or the parcel has not yet arrived), and the specific harm caused by the delay was: {delay_harm}. Only reference the fields belonging to the selected scenario — ignore the fields for the other two scenarios entirely, and never write 'Not applicable' or 'N/A' into the letter itself. State clearly what resolution is being requested: {desired_outcome}. Reference the general principle that a seller remains responsible for successful delivery of goods to the consumer, without asserting jurisdiction-specific legal citations unless explicitly confident they apply. Note that this letter may be escalated to a card chargeback or relevant consumer authority if not resolved within a reasonable timeframe. Write in a firm, professional, non-aggressive tone. Format as a proper letter with date, recipient, subject line, and closing.",
  },
  'courier-complaint-generator': {
    title: 'Courier Complaint Generator',
    // Gumroad short-code product_id for the "courier-complaint-generator" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/tepzr -> .../l/courier-complaint-generator).
    gumroad_product_id: 'tepzr',
    prompt_template:
      "Generate a formal complaint letter from {your_name} to {carrier} — the CARRIER/COURIER, not the seller — regarding tracking number {tracking_number}, addressing a {issue_type} issue. If issue_type is 'Lost': the last tracking update was {last_tracking_update}. If issue_type is 'Damaged': the damage is described as: {damage_description}. If issue_type is 'Delayed': the promised/estimated delivery date was {promised_delivery_date} and the actual delivery date was {actual_delivery_date} (or the parcel has not yet arrived). If issue_type is 'Delivered to wrong address', state this plainly and request confirmation of the correct delivery location and next steps. Only reference the field(s) belonging to the selected issue type — ignore the others entirely, and never write 'Not applicable' or 'N/A' into the letter itself. This complaint is being made in {country}. Reference the carrier's own standard complaints/compensation process in general terms appropriate to {country} (e.g. UK carriers' standard claims processes, USPS/UPS/FedEx claims procedures, Australia Post's claims process) without inventing specific compensation figures unless you are confident they are current and accurate for {carrier} specifically — if uncertain, instruct the reader to check the carrier's current published limits rather than stating a figure. State the compensation being sought: {compensation_amount}. Write in a firm, professional tone. Format as a proper letter with date, recipient, subject line, and closing.",
  },
  'customs-fee-dispute-generator': {
    title: 'Customs Fee Dispute Generator',
    // Gumroad short-code product_id for the "customs-fee-dispute-generator" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/sukbsc -> .../l/customs-fee-dispute-generator).
    gumroad_product_id: 'sukbsc',
    prompt_template:
      "Generate a formal dispute letter from {your_name} to {carrier_customs_agent} regarding a customs/import charge on tracking number {tracking_number}, imported into {country_of_import}. The charge was {amount_charged}, and the sender believes the correct amount is {amount_correct}. The reason for dispute is: {dispute_reason}. If the reason is 'Other', use this additional detail: {dispute_reason_other} — otherwise ignore that field entirely and do not mention it in the letter. Request a recalculation and refund of the difference, and ask for a clear breakdown of how the original charge was calculated if one wasn't already provided. Write in a firm, professional tone. Format as a proper letter with date, recipient, subject line, and closing.",
  },

  // ---- Healthcare & Medical (first generators for this block) ----
  'healthcare-complaint-letter': {
    title: 'Healthcare Complaint Letter Generator',
    // Real Gumroad product_id for the "healthcare-complaint-letter" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/rivhvf -> .../l/healthcare-complaint-letter).
    gumroad_product_id: 'rivhvf',
    prompt_template:
      "Draft a formal, professional complaint letter from {patient_full_name} to {provider_name} regarding an incident on {incident_date}: {incident_description}. If prior informal contact was already made about this, reference it here without adequate resolution: {prior_contact_details} — otherwise ignore this field entirely and do not mention it in the letter. State the desired outcome clearly: {desired_outcome}. For jurisdiction={jurisdiction}, note that if the provider does not respond adequately, the patient may escalate to the appropriate healthcare complaints or regulatory body in their area — keep this reference generic ('the applicable healthcare complaints body in your area') unless a specific verified body applies; never invent a specific agency name. Firm but professional tone, factual, non-accusatory framing of events.",
  },
  'medical-records-request-letter': {
    title: 'Medical Records Request Letter Generator',
    // Real Gumroad product_id for the "medical-records-request-letter" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/cofgyu -> .../l/medical-records-request-letter).
    gumroad_product_id: 'cofgyu',
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
    prompt_template:
      "Draft a formal, firm but professional letter from {patient_full_name} to {provider_name} regarding {service_description}, amount in question {amount_in_question}. If scenario is 'Incorrect or unexpected charge on a bill': the bill shows {billed_amount} but the patient expected {expected_amount}, because: {discrepancy_reason}. Request an itemized explanation and correction of the amount within a reasonable stated period. If scenario is 'Refund after cancelling a service': the patient cancelled the service on {service_cancellation_date} and has already paid {amount_already_paid}. If cancellation/refund terms were stated to the patient, reference them: {cancellation_policy_reference} — otherwise omit any reference to stated terms. Request a full or appropriate partial refund within a reasonable stated period. Only address the field(s) belonging to the selected scenario — ignore the other scenario's fields entirely and never write 'N/A' into the letter itself. For jurisdiction={jurisdiction}, keep any reference to consumer protection or billing regulations generic unless independently verified — never invent a specific statute or deadline. Professional, factual tone throughout.",
  },
  'healthcare-insurance-appeal-letter': {
    title: 'Healthcare Insurance Appeal Letter Generator',
    // Real Gumroad product_id for the "healthcare-insurance-appeal-letter" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/ssjfcu -> .../l/healthcare-insurance-appeal-letter).
    gumroad_product_id: 'ssjfcu',
    prompt_template:
      "Draft a formal insurance appeal letter from {policyholder_full_name} to {insurer_name} regarding claim reference {claim_reference_number}, for {denied_service_description}. The insurer's stated reason for denial was: {denial_reason_given}. The policyholder's grounds for appeal: {patient_counter_argument}. If an appeal deadline was given, note the appeal is being submitted ahead of it: {appeal_deadline} — otherwise omit any reference to a deadline. Request a formal reconsideration of the claim, referencing the specific reason for denial and directly countering it point by point. For jurisdiction={jurisdiction}, note the policyholder's right to escalate to an external/independent review if the internal appeal is unsuccessful — keep this reference generic ('the applicable external review process for your jurisdiction and plan type') unless a specific verified process applies; never invent a specific agency name. Firm, factual, well-organized tone — this is a formal reconsideration request, not an emotional appeal.",
  },
  'medical-product-complaint-letter': {
    title: 'Medical Product Complaint Letter Generator',
    // Real Gumroad product_id for the "medical-product-complaint-letter" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/yoqtwi -> .../l/medical-product-complaint-letter).
    gumroad_product_id: 'yoqtwi',
    prompt_template:
      "Draft a formal complaint letter from {consumer_full_name} to {seller_or_manufacturer_name} regarding the medical product/device '{product_name}', purchased on {purchase_date}. Issue type: {issue_type}. Description: {issue_description}. Requested resolution: {desired_outcome}. For jurisdiction={jurisdiction}, reference the consumer's general warranty and consumer protection rights for defective or misdescribed products, without citing a specific statute unless independently verified — keep this generic. If issue_type is 'Safety concern', add a brief closing note that the consumer may also consider reporting the issue to the relevant product safety/regulatory authority in their area — for any other issue_type, omit this note entirely. Professional, firm tone.",
  },
  'healthcare-provider-information-request': {
    title: 'Healthcare Provider Information Request Generator',
    // Real Gumroad product_id for the "healthcare-provider-information-request" product
    // (confirmed via redirect: carlosdevlop.gumroad.com/l/rcyqeq -> .../l/healthcare-provider-information-request).
    gumroad_product_id: 'rcyqeq',
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
    prompt_template:
      "Write a formal complaint letter from {customer_name} to {bank_name} regarding {issue_category}, described as: {issue_description}. If prior_contact indicates a prior unresolved attempt was already made, reference that this issue was already raised without resolution: {prior_contact} — otherwise do not mention any prior contact at all. State the desired outcome clearly: {desired_outcome}. For jurisdiction={jurisdiction}, note that if unresolved within a reasonable period, the customer may escalate to the appropriate financial ombudsman/regulator — keep this generic ('the applicable financial complaints body in your area') unless independently verified; never invent a specific agency name. Account/reference: {account_reference}. Tone: professional, firm, factual.",
  },
  'unauthorized-transaction-dispute-letter': {
    title: 'Unauthorized Transaction Dispute Letter Generator',
    gumroad_product_id: 'PLACEHOLDER_UNAUTHORIZED_TXN_DISPUTE',
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
    prompt_template:
      "Write a formal card transaction dispute letter from {customer_name} to {card_issuer}, matching the selected reason: {dispute_reason}. This is a billing/service dispute, NOT a fraud or unauthorized-transaction claim — never use fraud-related language ('unauthorized', 'I did not make this transaction', 'stolen card', 'someone else used my card') anywhere in the letter, regardless of dispute_reason. The disputed transaction was on {transaction_date} for {transaction_amount} from {merchant_name}. If merchant_contact_attempted indicates an attempt was already made, reference that attempt and its outcome: {merchant_contact_attempted} — otherwise state the merchant has not yet been contacted directly. Additional details: {details}. Note the dispute is being filed within the cardholder's standard filing window — keep the specific number of days generic ('within the filing window that applies to your card network') rather than inventing a figure, since this varies by network and dispute reason. Request a formal chargeback/dispute be opened and a written case reference provided. Tone: firm, factual, professional.",
  },
  'bank-fee-refund-request': {
    title: 'Bank Fee Refund Request Generator',
    gumroad_product_id: 'PLACEHOLDER_BANK_FEE_REFUND',
    prompt_template:
      "Write a formal fee refund request letter from {customer_name} to {bank_name} for a {fee_type} of {fee_amount} charged on {fee_date}. Present the customer's basis for disputing it: {dispute_basis}. For jurisdiction={jurisdiction}, reference the bank's general obligation to disclose fees and any changes clearly before charging them — keep this generic ('applicable fee transparency requirements in your area') unless independently verified; never invent a specific regulation name or number. Request a full refund and written confirmation. Tone: firm, factual, professional.",
  },
  'loan-credit-agreement-cancellation-withdrawal': {
    title: 'Loan / Credit Agreement Cancellation & Withdrawal Generator',
    gumroad_product_id: 'PLACEHOLDER_LOAN_CANCELLATION',
    prompt_template:
      "Write a formal notice of cancellation/withdrawal from {customer_name} to {lender_name}, for the credit agreement referenced {agreement_reference}, signed on {signing_date}. If cancellation_reason was provided, include it briefly to add clarity: {cancellation_reason} — otherwise state the cancellation is being exercised as a right and no reason is required. For jurisdiction={jurisdiction}, reference that many jurisdictions provide a statutory cooling-off/right-of-withdrawal period for certain consumer credit agreements — keep the specific number of days generic ('within the withdrawal period that applies to your agreement and location') rather than inventing a figure, and note the customer should confirm this period applies to their specific product before relying on it. Request written confirmation the agreement is cancelled and confirmation of any amount owed or refundable. Tone: formal, clear, professional.",
  },
  'financial-ombudsman-regulator-complaint': {
    title: 'Financial Ombudsman / Regulator Complaint Generator',
    gumroad_product_id: 'PLACEHOLDER_OMBUDSMAN_COMPLAINT',
    prompt_template:
      "Write a formal escalation complaint from {customer_name} to the appropriate financial ombudsman/regulator for jurisdiction={jurisdiction} (e.g. the CFPB in the US, the Financial Ombudsman Service in the UK, FIN-NET / the national competent authority in the EU, or AFCA in Australia — reference the general type of body appropriate for the jurisdiction given without asserting a specific one if the jurisdiction is ambiguous). Regarding {institution_name}, summarize the issue: {issue_summary}. State the institution was first contacted on {prior_complaint_date}, and describe its response so far: {institution_response}. State the desired outcome clearly: {desired_outcome}. Structure the letter with a clear chronology. Note this escalation should generally only be filed after the institution's own complaints process has been exhausted or a reasonable response period has passed — keep any specific deadline generic. Tone: formal, clear, factual — this is a regulatory submission, not an emotional appeal.",
  },
  'debt-collection-dispute-letter': {
    title: 'Debt Collection Dispute Letter Generator',
    gumroad_product_id: 'PLACEHOLDER_DEBT_COLLECTION_DISPUTE',
    prompt_template:
      "Write a formal debt validation/dispute letter from {customer_name} to {collector_name} regarding a claimed debt of {claimed_amount}, originally from {original_creditor} if known. State the basis for the dispute: {dispute_basis}, and the following details: {details}. For jurisdiction={jurisdiction}, reference the consumer's general right to request written validation of a disputed debt before the collector continues collection activity — keep any specific statutory deadline generic ('within the validation period that applies in your area') unless independently verified; never invent a specific day count. Explicitly request: written proof of the debt, verification the collector is legally entitled to collect it, and confirmation of the exact amount owed with an itemized breakdown. Tone: firm, factual, formal — this is a legal validation request, not an admission of the debt.",
  },
  'credit-report-error-dispute-letter': {
    title: 'Credit Report Error Dispute Letter Generator',
    gumroad_product_id: 'PLACEHOLDER_CREDIT_REPORT_DISPUTE',
    prompt_template:
      "Write a formal credit report dispute letter from {customer_name} to {credit_bureau} regarding {error_type} on the account/reference {account_reference} if provided. Describe the error and why it's incorrect: {details}. For jurisdiction={jurisdiction}, reference the consumer's general right to dispute inaccurate information on their credit file and have it investigated within a defined period — keep any specific deadline generic ('within the investigation period required in your area') unless independently verified; never invent a specific day count. Request correction or removal of the disputed item and a copy of the updated report once the investigation concludes. Tone: firm, factual, formal.",
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
    prompt_template:
      "Write a formal, courteous but firm cancellation letter from a consumer to {provider_name}. The consumer's account/reference is {account_id} — ignore this entirely if not provided or marked N/A. This is a cancellation described as: {cancellation_type}. If this is an ongoing subscription or recurring service, reference that the subscription began on {signup_date} and bills {billing_frequency} — otherwise ignore these two fields entirely. If this is a free trial before conversion, reference that the trial is set to end/convert on {trial_end_date}, and if a promotional price was shown, mention it was advertised at {promo_price_seen} — otherwise ignore these two fields entirely. If this is a fixed-term contract, reference that the contract runs through {contract_end_date}, and if a reason for early termination was given, include it: {early_termination_reason} — otherwise ignore these two fields entirely. Only use the fields belonging to the selected cancellation type; never write 'N/A' or reference an inapplicable field in the letter itself. State clearly that cancellation should take effect on {cancellation_date_requested}, and request written confirmation of the cancellation date. If also_request_refund is 'Yes', formally request a refund of {refund_amount}, explaining: {refund_reason} — otherwise do not mention a refund at all. Close by requesting that no further charges be made to the account after the stated cancellation date, and that any charge after that date will be disputed with the payment provider. Keep the tone professional, not aggressive. Do not invent any facts, dates, or figures beyond what was provided.",
  },
  'subscription-service-billing-dispute': {
    title: 'Subscription & Service Billing Dispute Generator',
    gumroad_product_id: 'PLACEHOLDER_subscription-service-billing-dispute',
    prompt_template:
      "Write a formal billing dispute letter from a consumer to {provider_name} regarding a charge of {charge_amount} on {charge_date}. Account/reference: {account_id} — ignore this entirely if not provided or marked N/A. This dispute concerns: {dispute_type}. If the charge occurred after cancellation, state the consumer cancelled on {cancellation_date}, referencing confirmation details if given: {cancellation_confirmation}, so this charge should not have occurred — otherwise ignore these two fields entirely. If this concerns a price increase, state the price was previously {previous_price} and increased to {new_price}, and reference whether advance notice was received: {notice_received} — otherwise ignore these three fields entirely. If this concerns a duplicate, incorrect, or unauthorized charge, state the expected amount was {expected_amount} and describe the issue: {issue_description} — otherwise ignore these two fields entirely. If this concerns an unwanted renewal, state whether the consumer recalls receiving a renewal notice: {renewal_notice_received}, and reference the original signup date if given: {signup_date} — otherwise ignore these two fields entirely. Only use the fields belonging to the selected dispute type; never write 'N/A' or reference an inapplicable field in the letter itself. State the consumer's desired outcome clearly: {desired_outcome}. Request a response within a reasonable timeframe (10 business days), and note that if unresolved, the consumer will dispute the charge directly with their card issuer or relevant regulator. Keep the tone factual and firm, not aggressive. Do not invent any facts, dates, or figures beyond what was provided.",
  },
  'service-complaint-escalation': {
    title: 'Service Complaint & Escalation Generator',
    gumroad_product_id: 'PLACEHOLDER_service-complaint-escalation',
    prompt_template:
      "Write a formal complaint letter from a consumer to {provider_name}, matching the stage described: {complaint_stage}. Account/reference: {account_id} — ignore this entirely if not provided or marked N/A. Issue: {issue_description}. If this is a first formal complaint, state the issue arose on {issue_date}, and if given, describe what was promised versus what was actually delivered: {promised_vs_delivered} — otherwise ignore these two fields entirely. If this is an escalation of an unresolved complaint, state the consumer first raised it on {original_complaint_date}, referencing the reference number if given: {original_reference}, the response received if given: {response_received}, and any deadline the provider previously committed to if given: {deadline_given} — otherwise ignore these four fields entirely; also state explicitly that this is an escalation of an unresolved complaint and request it be handled by a manager or complaints team, not front-line support. Only use the fields belonging to the selected stage; never write 'N/A' or reference an inapplicable field in the letter itself. State the consumer's desired outcome: {desired_outcome}. Request a substantive response within 10 business days, and note that if unresolved, the consumer will escalate to an ombudsman, regulator, or small claims court as appropriate. Keep the tone factual and professional. Do not invent any facts, dates, or figures beyond what was provided.",
  },
  'privacy-rights-request': {
    title: 'Privacy Rights Request Generator',
    gumroad_product_id: 'hplixy',
    prompt_template:
      "Write a formal, courteous but firm privacy rights request letter from a consumer to {company_name}. The consumer's relationship to the company: {your_relationship} — ignore this entirely if not provided or marked N/A. Account/reference: {account_identifier} — ignore this entirely if not provided or marked N/A. This is a request described as: {right_type}. If this is an access request, state the consumer wants to see what personal data is held about them, narrowed to the following scope if given: {specific_data_scope} — otherwise ignore this field entirely. If this is a deletion/erasure request, state the consumer wants their personal data deleted/erased, referencing the following reason if given: {deletion_reason} — otherwise ignore this field entirely. If this is a correction/rectification request, state the following data is incorrect: {incorrect_data}, and that it should instead read: {correct_data} — otherwise ignore these two fields entirely. If this is an objection to AI/ML training use, state the consumer objects to their personal data being used to train AI or machine learning models, narrowed to the following content type if given: {data_type_for_ai}, and requests this use stop and any existing training use be remediated where possible — otherwise ignore this field entirely. If this is a restriction of processing request, state the consumer requests processing of their data be restricted while the following is resolved: {restriction_reason} — otherwise ignore this field entirely. Only use the fields belonging to the selected right; never write 'N/A' or reference an inapplicable field in the letter itself. Request written confirmation of the action taken and the date it was completed. State that a response is expected within the timeframe required by applicable data protection law, and that if no adequate response is received, the consumer will escalate to the relevant data protection authority. Keep the tone professional, not aggressive. Do not invent any facts, dates, regulations, or figures beyond what was provided.",
  },
  'privacy-breach-compliance-complaint': {
    title: 'Privacy Breach & Compliance Complaint Generator',
    gumroad_product_id: 'udtiy',
    prompt_template:
      "Write a formal complaint letter from a consumer to {company_name} regarding a complaint described as: {complaint_type}. Account/reference: {account_identifier} — ignore this entirely if not provided or marked N/A. If this is a data breach complaint, state the consumer was notified of a data breach on {breach_notification_date} (or ignore this field if it is N/A and instead state the consumer became aware of it independently), and that the data affected, as far as the consumer knows, is: {data_affected}. Request a clear explanation of what happened, what data was affected, and what steps are being taken to prevent recurrence — otherwise, if this is not a data breach complaint, ignore these two fields entirely. If this is a cookies/tracking consent complaint, state that on {website_or_app}, the consumer experienced the following issue with cookie/tracking consent: {consent_issue}, and that this appears inconsistent with applicable data protection and e-privacy requirements for valid consent — otherwise ignore these two fields entirely. Only use the fields belonging to the selected complaint type; never write 'N/A' or reference an inapplicable field in the letter itself. State the consumer's desired outcome: {desired_outcome}. Request a substantive written response within a reasonable timeframe (state 20 business days), and note explicitly that this letter is being sent as the required first step before escalating to the relevant data protection authority, and that the consumer will do so if the response is inadequate or absent. Keep the tone factual and firm, not aggressive. Do not invent any facts, dates, or figures beyond what was provided.",
  },
  'privacy-regulator-complaint': {
    title: 'Privacy Regulator Complaint Generator',
    gumroad_product_id: 'gwhjwt',
    prompt_template:
      "Write a formal complaint to the correct data protection regulator regarding {company_name}. Determine the regulator strictly from the jurisdiction (and, only if jurisdiction is European Union, the EU country) provided, using these rules and no others: if jurisdiction is 'United States', address the complaint to the Federal Trade Commission (FTC); if jurisdiction is 'United Kingdom', address it to the Information Commissioner's Office (ICO); if jurisdiction is 'Australia', address it to the Office of the Australian Information Commissioner (OAIC); if jurisdiction is 'European Union' and eu_country is 'Spain', address it to the Agencia Espanola de Proteccion de Datos (AEPD); if eu_country is 'France', address it to the Commission Nationale de l'Informatique et des Libertes (CNIL); if eu_country is 'Germany', address it to the Bundesbeauftragte fur den Datenschutz (BfDI) and add a brief note that Germany also has state-level (Lander) data protection authorities and the consumer should confirm the correct one for their region; if eu_country is 'Other EU country' or 'Not applicable — I selected a different jurisdiction' while jurisdiction is still 'European Union', do not name any specific regulator — instead address the letter generically to 'your national data protection authority' and add a note advising the consumer to confirm the correct authority for their specific EU member state before sending. Ignore the eu_country field entirely if jurisdiction is not 'European Union'. If prior_contact_date is provided and not N/A, state the consumer first raised this issue directly with the company on {prior_contact_date}, referencing the following response if given: {prior_contact_outcome} — otherwise ignore these two fields entirely. Issue: {issue_summary}. The consumer is requesting: {desired_outcome}. Format this as an appropriate formal complaint to a data protection regulator, including a clear factual summary, relevant dates, and a specific request for investigation or action. Do not invent any facts, regulations, case numbers, or figures beyond what was provided. Do not name any regulator other than the single one determined by the rules above.",
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
