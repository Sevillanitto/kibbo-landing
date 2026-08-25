// Medical Bill Analyzer — Cloudflare Worker
//
// Same freemium wrapper as the other Kibbo analyzers (Crypto Scam Analyzer /
// Legal Contract Auditor / Course Advertisement Analyzer). Only the
// SYSTEM_PROMPT, CODE_PREFIX and the dual text/image input path differ; the
// access code / rate-limit mechanism is intentionally identical across all
// analyzers.
//
// This is a genuinely new tool, not a variant of the Legal Contract Auditor —
// a medical bill is an itemized financial document, not a contract with risk
// clauses. It accepts EITHER pasted/extracted bill text OR a photographed
// bill (base64 image), and returns an itemized list of billing items worth
// double-checking with the provider — NEVER a fraud accusation, since a
// legitimate explanation may exist for any individual line item.
//
// Endpoints:
//   POST /                → analyze bill text or image (rate limited 3/day
//                           per IP, unlimited for activated IPs)
//   POST /validate-code   → { code } -> { valid: bool }   (KIBBO-MEDBILL- only)
//   POST /activate-code   → { code } -> { success: bool }, marks this IP unlimited
//   GET  /setup-codes     → admin-only, generates 50 access codes (run once)
//
// Required bindings / secrets:
//   - ANTHROPIC_API_KEY  (secret):  already configured
//   - ADMIN_KEY          (secret):  wrangler secret put ADMIN_KEY
//   - RATE_LIMIT_KV      (KV namespace binding): medical-bill-analyzer-rate-limit, already bound

const DAILY_LIMIT = 3;
const CODE_COUNT = 50;
const CODE_PREFIX = 'KIBBO-MEDBILL-';

const SYSTEM_PROMPT = `You are a medical-billing review assistant helping a patient double-check an itemized medical bill or invoice for issues worth raising with the provider's billing department. A bill is an itemized FINANCIAL document, not a contract with risk clauses — you are checking arithmetic, descriptions, and consistency, not legal terms.

You will be given the text of a medical bill (either pasted directly, extracted from an uploaded PDF, or transcribed from a photographed bill image). If the patient described what they actually received during their visit, that context will be included — use it only to check for services listed that don't match what they describe; if no such context is given, skip that specific check.

Check specifically for:
1. Duplicate charges — the same service/item billed more than once (same CPT/description appearing twice, or two near-identical line items).
2. Unusual quantities — a quantity for a service/item that seems inconsistent with a single visit or a standard course of treatment (e.g. "6 units" of something normally billed once).
3. Services that don't match what the patient describes receiving — ONLY if the patient provided that context; do not guess what a patient "should" have received.
4. Charges with no clear description, or a description too vague to verify what was actually provided (e.g. "Misc charge," "Service fee," a bare code with no plain-language explanation).
5. Facility fees, administrative fees, or add-on charges with no breakdown of what they cover.
6. A mismatch between the stated total and the sum of the itemized charges, if you can actually calculate both from the document — only flag this if you can show your arithmetic, never guess.
7. Anything billed that appears twice under different descriptions — a potential disguised duplicate (e.g. the same procedure listed once by its common name and again by a code or alternate description, with the same or similar price).

CRITICAL FRAMING RULES:
1. This is a "here's what to double-check" tool, not a fraud-accusation tool. NEVER assert that a flagged charge is definitely wrong, an error, or fraudulent. Frame every finding as "worth reviewing with your provider" — a legitimate explanation may exist for any individual item (e.g. two providers billing separately for what looks like one visit, or a facility fee that's simply itemized elsewhere).
2. For every finding, quote or closely reference the specific line item from the bill so the patient can find it themselves, explain in plain language why it's worth a second look, and suggest one specific, concrete question to ask the provider's billing department about that exact item.
3. If you cannot read parts of the bill (poor image quality, cut-off text), say so plainly rather than guessing at numbers or descriptions.
4. Do not invent line items, prices, or codes that are not actually present in the submitted document.

Respond ONLY in valid JSON, no markdown, no explanation outside the JSON:
{
  "items_flagged": number (count of entries in "findings"),
  "summary": string (max 45 words, plain language, states how many items were flagged and the general nature — never a verdict like "this bill is fraudulent"),
  "findings": [
    {
      "line_item": string (quote or closely reference the specific charge/line from the bill, max 25 words),
      "category": string (one of: "Duplicate charge", "Unusual quantity", "Doesn't match described service", "Vague/no description", "Unexplained fee", "Total mismatch", "Possible disguised duplicate"),
      "explanation": string (max 40 words, plain language, why this is worth reviewing — framed as a question, not an accusation),
      "question_to_ask": string (max 25 words, one specific question for the billing department about this exact item)
    }
  ]
}

If nothing is flagged, return "items_flagged": 0, an empty "findings" array, and a summary noting no items stood out in this review — while making clear this is not a certification that the bill is fully accurate, since this tool only checks for specific patterns, not a full audit.`;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function rateKey(ip) {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return `ip:${ip}:${day}`;
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

function normalizeCode(code) {
  return (code || '').toString().trim().toUpperCase();
}

// Random code: KIBBO-MEDBILL-XXXX-XXXX-XXXX using an unambiguous charset (no O/0/I/1).
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < 12; i++) {
    if (i === 4 || i === 8) out += '-';
    out += chars[bytes[i] % chars.length];
  }
  return CODE_PREFIX + out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === 'GET' && path === '/setup-codes') {
      return handleSetup(request, env);
    }
    if (request.method === 'POST' && path === '/validate-code') {
      return handleValidate(request, env);
    }
    if (request.method === 'POST' && path === '/activate-code') {
      return handleActivate(request, env);
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }
    return handleAnalyze(request, env);
  },
};

// ---- Admin: generate the access codes (run once) ----
async function handleSetup(request, env) {
  if (!env.ADMIN_KEY) {
    return jsonResponse({ error: 'Server is missing ADMIN_KEY' }, 500);
  }
  if (request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  if (!env.RATE_LIMIT_KV) {
    return jsonResponse({ error: 'RATE_LIMIT_KV not configured' }, 500);
  }

  const codes = new Set();
  while (codes.size < CODE_COUNT) codes.add(generateCode());
  const list = [...codes];

  await Promise.all(list.map((c) => env.RATE_LIMIT_KV.put('code:' + c, 'unused')));

  return jsonResponse({ count: list.length, codes: list });
}

// ---- Validate a code (lifetime; existence is enough) ----
async function handleValidate(request, env) {
  let code;
  try {
    code = normalizeCode((await request.json()).code);
  } catch (err) {
    return jsonResponse({ valid: false, error: 'Invalid JSON body' }, 400);
  }
  if (!code || !code.startsWith(CODE_PREFIX) || !env.RATE_LIMIT_KV) {
    return jsonResponse({ valid: false });
  }
  const stored = await env.RATE_LIMIT_KV.get('code:' + code);
  return jsonResponse({ valid: stored !== null });
}

// ---- Activate a code for this IP (lifetime unlimited) ----
async function handleActivate(request, env) {
  let code;
  try {
    code = normalizeCode((await request.json()).code);
  } catch (err) {
    return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400);
  }
  if (!env.RATE_LIMIT_KV) {
    return jsonResponse({ success: false, error: 'RATE_LIMIT_KV not configured' }, 500);
  }
  if (!code.startsWith(CODE_PREFIX)) {
    return jsonResponse({ success: false });
  }

  const stored = await env.RATE_LIMIT_KV.get('code:' + code);
  if (stored === null) {
    return jsonResponse({ success: false });
  }

  await env.RATE_LIMIT_KV.put('activated:' + clientIp(request), 'true');
  return jsonResponse({ success: true });
}

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// ---- Main analysis (rate limited unless the IP is activated) ----
async function handleAnalyze(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: 'Server is missing ANTHROPIC_API_KEY' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const text = (body.text || '').toString().trim();
  const patientContext = (body.patient_context || '').toString().trim().slice(0, 1000);
  const imageBase64 = (body.image_base64 || '').toString().trim();
  const imageMediaType = (body.image_media_type || '').toString().trim();

  const hasImage = !!imageBase64 && ALLOWED_IMAGE_TYPES.has(imageMediaType);
  if (!text && !hasImage) {
    return jsonResponse({ error: 'Missing "text" or a valid "image_base64"/"image_media_type" pair' }, 400);
  }
  // Cap image payload (base64) at ~8MB to stay well under Worker/Anthropic limits.
  if (imageBase64 && imageBase64.length > 8 * 1024 * 1024) {
    return jsonResponse({ error: 'Image is too large. Please upload a smaller image or a PDF.' }, 400);
  }

  const ip = clientIp(request);
  const kv = env.RATE_LIMIT_KV;
  const key = rateKey(ip);

  let unlimited = false;
  if (kv) {
    try {
      unlimited = (await kv.get('activated:' + ip)) !== null;
    } catch (err) {
      unlimited = false;
    }
  }

  let used = 0;
  if (kv && !unlimited) {
    try {
      const stored = await kv.get(key);
      used = stored ? (parseInt(stored, 10) || 0) : 0;
    } catch (err) {
      used = 0;
    }
    if (used >= DAILY_LIMIT) {
      return jsonResponse(
        {
          error: 'limit_reached',
          message: 'You have used your 3 free checks today. Come back tomorrow.',
        },
        429
      );
    }
  }

  // Build the user message content: an image block (if provided) plus the
  // bill text and any patient-supplied context about what they actually
  // received, so the model can check for services that don't match.
  const contentParts = [];
  if (hasImage) {
    contentParts.push({
      type: 'image',
      source: { type: 'base64', media_type: imageMediaType, data: imageBase64 },
    });
  }
  let instructionText = hasImage
    ? 'The attached image is a photograph or scan of a medical bill. Read it carefully and analyze it as described.'
    : `MEDICAL BILL TEXT:\n${text}`;
  if (patientContext) {
    instructionText += `\n\nPATIENT-DESCRIBED CONTEXT (what the patient says they actually received — use this only to check for services listed that don't match): ${patientContext}`;
  }
  contentParts.push({ type: 'text', text: instructionText });

  try {
    let apiRes;
    let lastDetail = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        apiRes = await anthropicFetch(env.ANTHROPIC_API_KEY, contentParts);
      } catch (netErr) {
        lastDetail = netErr && netErr.name === 'AbortError'
          ? 'Anthropic request timed out'
          : (netErr && netErr.message) || 'network error';
        apiRes = null;
      }

      if (apiRes && apiRes.ok) break;

      const status = apiRes ? apiRes.status : 0;
      const transient = !apiRes || status === 429 || status === 500 ||
        status === 502 || status === 503 || status === 529;
      if (!transient) {
        const detail = await apiRes.text();
        return jsonResponse({ error: 'Claude API error', status, detail }, 502);
      }
      if (apiRes) lastDetail = await apiRes.text();
      if (attempt < 2) await sleep(400 * (attempt + 1));
    }

    if (!apiRes || !apiRes.ok) {
      return jsonResponse(
        { error: 'Analysis service is busy, please try again in a moment.', detail: lastDetail },
        503
      );
    }

    const data = await apiRes.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    const parsed = parseAnalysis(textBlock ? textBlock.text : '');
    if (!parsed) {
      return jsonResponse({ error: 'Could not parse model output' }, 502);
    }

    if (unlimited) {
      parsed.remaining = 'unlimited';
    } else if (kv) {
      const newUsed = used + 1;
      try {
        await kv.put(key, String(newUsed), { expirationTtl: 86400 });
      } catch (err) {
        /* counter just won't advance this time */
      }
      parsed.remaining = Math.max(0, DAILY_LIMIT - newUsed);
    } else {
      parsed.remaining = null;
    }

    return jsonResponse(parsed);
  } catch (err) {
    return jsonResponse({ error: 'Worker error', detail: err.message }, 500);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function anthropicFetch(apiKey, contentParts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
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
        max_tokens: 1536,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: contentParts }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function parseAnalysis(text) {
  if (!text) return null;
  let candidate = text.trim();

  const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) candidate = fenceMatch[1].trim();

  if (candidate[0] !== '{') {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      candidate = candidate.slice(start, end + 1);
    }
  }

  try {
    return JSON.parse(candidate);
  } catch (err) {
    return null;
  }
}
