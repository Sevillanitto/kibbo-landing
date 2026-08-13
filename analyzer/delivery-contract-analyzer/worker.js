// Delivery Contract Analyzer — Cloudflare Worker
//
// Same freemium wrapper as the Legal Contract Auditor / Employment Contract
// Auditor / Supplement Ingredients Auditor / AI Phishing Detector, adapted
// for food-delivery-platform merchant/partner contract analysis. Only the
// SYSTEM_PROMPT, CODE_PREFIX and response schema differ; the access code /
// rate-limit mechanism is intentionally identical across all analyzers.
//
// Endpoints:
//   POST /                → analyze contract text (rate limited 3/day per IP,
//                           unlimited for activated IPs)
//   POST /validate-code   → { code } -> { valid: bool }   (KIBBO-DELIVERY- only)
//   POST /activate-code   → { code } -> { success: bool }, marks this IP unlimited
//   GET  /setup-codes     → admin-only, generates 50 access codes (run once)
//
// Required bindings / secrets:
//   - ANTHROPIC_API_KEY  (secret):  already configured
//   - ADMIN_KEY          (secret):  wrangler secret put ADMIN_KEY
//   - RATE_LIMIT_KV      (KV namespace binding): delivery-contract-analyzer-rate-limit, already bound

const DAILY_LIMIT = 3;
const CODE_COUNT = 50;
const CODE_PREFIX = 'KIBBO-DELIVERY-';

const RISK_CATEGORIES = [
  'Commission structure and hidden fees',
  'Exclusivity clauses',
  'Contract length and auto-renewal terms',
  'Penalty clauses (cancellations, rejections, low ratings, out-of-stock items)',
  'Liability allocation for delivery/prep errors',
  'Customer data ownership',
  'Termination terms',
];

const DISCLAIMER = 'This analysis is for informational purposes and does not constitute legal advice. Always have a contract reviewed by a lawyer before signing, especially for long-term commitments.';

const SYSTEM_PROMPT = `You are a contract-law-aware reviewer helping a restaurant, cafe, or other food business owner understand what a food delivery platform's merchant or partner agreement (e.g. Uber Eats, DoorDash, Deliveroo, Just Eat) actually says. Analyze the following contract text.

Always evaluate exactly these 7 categories, in this exact order, even if a category is not explicitly addressed in the text — in that case, treat the silence itself as the finding (an unaddressed category is not automatically low risk; missing terms on liability, data ownership, or termination are often themselves worth flagging as medium risk):

1. Commission structure and hidden fees
2. Exclusivity clauses
3. Contract length and auto-renewal terms
4. Penalty clauses (cancellations, order rejections, low ratings, out-of-stock items)
5. Liability allocation for delivery/prep errors
6. Customer data ownership
7. Termination terms

For each of the 7 categories, return an object with:
- category: the exact category name from the list above, verbatim
- risk: "low", "medium", or "high"
- quote: a short verbatim excerpt from the contract text supporting this finding, max 160 characters — or null if the contract does not address this category at all
- explanation: one plain-English sentence explaining the risk, max 30 words
- suggestion: one plain-English sentence suggesting what to negotiate or ask before signing, max 25 words

Also return:
- overall_risk: "low", "medium", or "high" — an overall assessment weighting high-risk categories most heavily
- summary: one plain-English paragraph, max 50 words, summarizing what stands out about this contract overall

CRITICAL FRAMING RULE: Never state that a clause "is illegal" or "is unenforceable" or give a definitive legal verdict. Enforceability varies by jurisdiction and the specific facts. Every "explanation" field must describe what the contract says and why it's worth a closer look — not whether it would hold up legally.

Never invent contract terms that are not in the text. If a category is not addressed, say so explicitly in the explanation field rather than fabricating a quote.

Respond ONLY in valid JSON, no markdown, no explanation:
{
  "overall_risk": string,
  "summary": string,
  "categories": [
    { "category": string, "risk": string, "quote": string|null, "explanation": string, "suggestion": string }
  ]
}`;

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

// Random code: KIBBO-DELIVERY-XXXX-XXXX-XXXX using an unambiguous charset (no O/0/I/1).
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

// ---- Admin: generate the access codes (run once, or again for more) ----
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
  // Only KIBBO-DELIVERY- codes are valid for this analyzer.
  if (!code || !code.startsWith(CODE_PREFIX) || !env.RATE_LIMIT_KV) {
    return jsonResponse({ valid: false });
  }
  // Codes are lifetime, not single-use: if the key exists, it's valid.
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
  // Reject anything that is not a KIBBO-DELIVERY- code before touching KV.
  if (!code.startsWith(CODE_PREFIX)) {
    return jsonResponse({ success: false });
  }

  const stored = await env.RATE_LIMIT_KV.get('code:' + code);
  if (stored === null) {
    return jsonResponse({ success: false }); // unknown / invalid code
  }

  // Grant this IP unlimited access, permanently (no expiry).
  await env.RATE_LIMIT_KV.put('activated:' + clientIp(request), 'true');
  return jsonResponse({ success: true });
}

// ---- Main analysis (rate limited unless the IP is activated) ----
async function handleAnalyze(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: 'Server is missing ANTHROPIC_API_KEY' }, 500);
  }

  let contract;
  try {
    contract = ((await request.json()).contract || '').toString().trim();
  } catch (err) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  if (!contract) {
    return jsonResponse({ error: 'Missing "contract" field' }, 400);
  }

  const ip = clientIp(request);
  const kv = env.RATE_LIMIT_KV;
  const key = rateKey(ip);

  // Unlimited if this IP has activated a code.
  let unlimited = false;
  if (kv) {
    try {
      unlimited = (await kv.get('activated:' + ip)) !== null;
    } catch (err) {
      unlimited = false;
    }
  }

  // Rate limit (free users only).
  let used = 0;
  if (kv && !unlimited) {
    try {
      const stored = await kv.get(key);
      used = stored ? (parseInt(stored, 10) || 0) : 0;
    } catch (err) {
      used = 0; // fail open
    }
    if (used >= DAILY_LIMIT) {
      return jsonResponse(
        {
          error: 'limit_reached',
          message: 'You have used your 3 free contract analyses today. Come back tomorrow.',
        },
        429
      );
    }
  }

  // Claude API call. Contracts can be long, so the model call can be slow or
  // occasionally overloaded — either of which otherwise surfaces to the user as
  // a 502 (or a platform 502 if the Worker exceeds its wall-clock limit waiting
  // on a hung request). Guard with an explicit timeout and retry transient
  // errors with backoff so a momentary blip doesn't fail the whole request.
  try {
    let apiRes;
    let lastDetail = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        apiRes = await anthropicFetch(env.ANTHROPIC_API_KEY, contract);
      } catch (netErr) {
        // Network error or timeout (AbortError) — treat as transient.
        lastDetail = netErr && netErr.name === 'AbortError'
          ? 'Anthropic request timed out'
          : (netErr && netErr.message) || 'network error';
        apiRes = null;
      }

      if (apiRes && apiRes.ok) break;

      const status = apiRes ? apiRes.status : 0;
      // Retry only transient failures; fail fast on 4xx like 400/401.
      const transient = !apiRes || status === 429 || status === 500 ||
        status === 502 || status === 503 || status === 529;
      if (!transient) {
        const detail = await apiRes.text();
        return jsonResponse({ error: 'Claude API error', status, detail }, 502);
      }
      if (apiRes) lastDetail = await apiRes.text();
      if (attempt < 2) await sleep(400 * (attempt + 1)); // 400ms, 800ms
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

    // Normalize: guarantee all 7 categories are present, in the fixed order,
    // even if the model dropped one — never let a malformed subset reach the
    // frontend as if it were the full table.
    parsed.categories = normalizeCategories(parsed.categories);
    parsed.disclaimer = DISCLAIMER;

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

function normalizeCategories(categories) {
  const byName = new Map();
  (Array.isArray(categories) ? categories : []).forEach((c) => {
    if (c && typeof c.category === 'string') byName.set(c.category.trim(), c);
  });
  return RISK_CATEGORIES.map((name) => {
    const found = byName.get(name);
    return {
      category: name,
      risk: found && ['low', 'medium', 'high'].includes(found.risk) ? found.risk : 'medium',
      quote: found && found.quote ? String(found.quote) : null,
      explanation: found && found.explanation ? String(found.explanation) : 'Not clearly addressed in the text provided.',
      suggestion: found && found.suggestion ? String(found.suggestion) : 'Ask the platform to clarify this term in writing before signing.',
    };
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Single Anthropic Messages API call, aborted if it runs too long so a hung
// upstream request can't push the Worker past its wall-clock limit (which would
// surface to the browser as an opaque platform 502).
async function anthropicFetch(apiKey, contract) {
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
        max_tokens: 3072,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: contract }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Robustly extract the JSON object from the model's reply.
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
