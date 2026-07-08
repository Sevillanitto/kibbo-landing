// AI Phishing Detector — Cloudflare Worker
//
// Same freemium wrapper as the Supplement Ingredients Auditor, adapted for
// phishing / scam message analysis. The analysis logic (the Claude prompt with
// its impersonation targets, signal list and VERDICT/CONFIDENCE/SIGNALS/ADVICE
// output format) is reused verbatim from the existing AI Phishing Detector
// web app; only the wrapper (rate limiting, access codes, output parsing) is new.
//
// Endpoints:
//   POST /                → analyze a message (rate limited 3/day per IP,
//                           unlimited for activated IPs)
//   POST /validate-code   → { code } -> { valid: bool }   (KIBBO-PHISH- only)
//   POST /activate-code   → { code } -> { success: bool }, marks this IP unlimited
//   GET  /setup-codes     → admin-only, generates 50 access codes (run once)
//
// Required bindings / secrets:
//   - ANTHROPIC_API_KEY  (secret):  wrangler secret put ANTHROPIC_API_KEY
//   - ADMIN_KEY          (secret):  wrangler secret put ADMIN_KEY
//   - RATE_LIMIT_KV      (KV namespace binding): namespace "phishing-detector-rate-limit"

const DAILY_LIMIT = 3;
const CODE_COUNT = 50;
const CODE_PREFIX = 'KIBBO-PHISH-';

// Reused verbatim from the AI Phishing Detector web app (buildPrompt), moved into
// the system prompt. The user's message is sent as the user turn.
const SYSTEM_PROMPT = `You are an expert cybersecurity analyst specializing in phishing and social engineering detection.

Analyze the following message and determine if it is PHISHING, SUSPICIOUS, or LEGITIMATE.

Pay special attention to impersonation of:
- Financial: PayPal, Chase, Bank of America, Wells Fargo, Citibank, Barclays, HSBC, Lloyds, NatWest, Halifax, Capital One
- Government: IRS, HMRC, DVLA, SSA, Medicare, DWP, ATO
- Delivery: UPS, FedEx, DHL, USPS, Royal Mail, Australia Post
- Tech & retail: Amazon, Apple, Microsoft, Google, Netflix, eBay, Spotify, Meta, Instagram
- Telecoms: AT&T, Verizon, Comcast, BT, EE, Vodafone

Key signals to detect:
- Artificial urgency (act now, within 24 hours, immediate action)
- Suspicious or misspelled domains (amaz0n.com, paypa1.com, hmrc-refund.co, irs-payment.net)
- Requests for personal data, passwords or payment details
- Unexpected delivery fees or customs charges
- Prize or lottery notifications
- Account suspension or unauthorized access alerts
- Requests to call a number or click a shortened link
- Grammar or spelling inconsistent with the claimed sender

Respond ONLY in this exact format, nothing else:
VERDICT: [PHISHING / SUSPICIOUS / LEGITIMATE]
CONFIDENCE: [High / Medium / Low]
SIGNALS: [comma-separated list of detected signals, max 4]
ADVICE: [one clear action sentence for the user]`;

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

// Random code: KIBBO-PHISH-XXXX-XXXX-XXXX using an unambiguous charset (no O/0/I/1).
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
  // Only KIBBO-PHISH- codes are valid for this analyzer.
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
  // Reject anything that is not a KIBBO-PHISH- code before touching KV.
  if (!code.startsWith(CODE_PREFIX)) {
    return jsonResponse({ success: false });
  }

  const stored = await env.RATE_LIMIT_KV.get('code:' + code);
  if (stored === null) {
    return jsonResponse({ success: false }); // unknown / invalid code
  }

  await env.RATE_LIMIT_KV.put('activated:' + clientIp(request), 'true');
  return jsonResponse({ success: true });
}

// ---- Main analysis (rate limited unless the IP is activated) ----
async function handleAnalyze(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: 'Server is missing ANTHROPIC_API_KEY' }, 500);
  }

  let message;
  try {
    message = ((await request.json()).message || '').toString().trim();
  } catch (err) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  if (!message) {
    return jsonResponse({ error: 'Missing "message" field' }, 400);
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
          message: 'You have used your 3 free checks today. Come back tomorrow.',
        },
        429
      );
    }
  }

  // Claude API call. The model call can be slow or occasionally overloaded —
  // either of which otherwise surfaces to the user as a 502 (or a platform 502
  // if the Worker exceeds its wall-clock limit waiting on a hung request).
  // Guard with an explicit timeout and retry transient errors with backoff so a
  // momentary blip doesn't fail the whole request.
  try {
    let apiRes;
    let lastDetail = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        apiRes = await anthropicFetch(env.ANTHROPIC_API_KEY, message);
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

// Single Anthropic Messages API call, aborted if it runs too long so a hung
// upstream request can't push the Worker past its wall-clock limit (which would
// surface to the browser as an opaque platform 502).
async function anthropicFetch(apiKey, message) {
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
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: message }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Parse the model's fixed-format reply (VERDICT / CONFIDENCE / SIGNALS / ADVICE)
// into structured JSON for the frontend.
function parseAnalysis(text) {
  if (!text) return null;
  const clean = (s) => (s || '').replace(/^\s*\[?|\]?\s*$/g, '').trim();
  const field = (name) => {
    const line = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.toUpperCase().startsWith(name + ':'));
    return line ? clean(line.slice(line.indexOf(':') + 1)) : '';
  };

  const vRaw = field('VERDICT').toUpperCase();
  let verdict;
  if (vRaw.includes('PHISHING')) verdict = 'PHISHING';
  else if (vRaw.includes('SUSPICIOUS')) verdict = 'SUSPICIOUS';
  else if (vRaw.includes('LEGITIMATE')) verdict = 'LEGITIMATE';
  else return null;

  const signals = field('SIGNALS')
    .split(',')
    .map((s) => clean(s))
    .filter((s) => s && s.toLowerCase() !== 'none')
    .slice(0, 6);

  return {
    verdict,
    confidence: field('CONFIDENCE'),
    signals,
    advice: field('ADVICE'),
  };
}
