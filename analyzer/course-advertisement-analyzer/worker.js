// Course Advertisement Analyzer — Cloudflare Worker
//
// Same freemium wrapper as the other Kibbo analyzers (Crypto Scam Analyzer /
// Legal Contract Auditor / AI Phishing Detector). Only the SYSTEM_PROMPT,
// CODE_PREFIX and the optional domain-age lookup differ; the access code /
// rate-limit mechanism is intentionally identical across all analyzers.
//
// This analyzer accepts a URL, or a block of pasted text (a course/academy/
// bootcamp landing page's copy), and returns an ITEMIZED list of misleading-
// marketing patterns matched — never a blunt "legit / not legit" binary, and
// never a claim that a named institution is fraudulent or dishonest. If the
// input looks like a URL, the Worker performs a real RDAP domain-registration
// lookup (no API key required, public protocol) and passes the actual
// computed domain age to the model as a fact — the model does not guess or
// infer domain age from general knowledge.
//
// Endpoints:
//   POST /                → analyze text/URL (rate limited 3/day per IP,
//                           unlimited for activated IPs)
//   POST /validate-code   → { code } -> { valid: bool }   (KIBBO-COURSEAD- only)
//   POST /activate-code   → { code } -> { success: bool }, marks this IP unlimited
//   GET  /setup-codes     → admin-only, generates 50 access codes (run once)
//
// Required bindings / secrets:
//   - ANTHROPIC_API_KEY  (secret):  already configured
//   - ADMIN_KEY          (secret):  wrangler secret put ADMIN_KEY
//   - RATE_LIMIT_KV      (KV namespace binding): course-advertisement-analyzer-rate-limit, already bound

const DAILY_LIMIT = 3;
const CODE_COUNT = 50;
const CODE_PREFIX = 'KIBBO-COURSEAD-';

const SYSTEM_PROMPT = `You are a marketing-pattern analyst helping a prospective student evaluate a course, academy, or bootcamp landing page for language patterns commonly associated with misleading education marketing.

You will be given the user's pasted text (and, if it was a URL, a real domain-registration-age fact computed separately — never invent or guess a domain's age yourself; only use the age fact if it is explicitly provided to you).

Detect and flag ONLY patterns genuinely present in the submitted text. Check specifically for:
- Job or employment guarantees with no clearly stated definition, timeframe, or remedy attached (e.g. a "guaranteed job" claim with no specifics on what counts as a qualifying job or what happens if the guarantee isn't met)
- Salary or earnings claims presented without a clear, checkable source (e.g. "our graduates earn $120k" with no stated methodology, sample size, or independent verification mentioned)
- Certification or accreditation claims that reference a body or status without enough detail for a reader to independently verify it (a vague "accredited" claim with no named accrediting body)
- Testimonials with patterns suggesting they may not be genuine (generic, stock-photo-style language, no way to verify the person exists, or a suspiciously uniform tone across multiple testimonials)
- Urgency or scarcity tactics around enrollment deadlines or pricing
- Absolute or unqualified outcome claims generally ("everyone who completes this gets hired," "100% success rate")

CRITICAL FRAMING RULES:
1. Never produce a blunt binary "legitimate" or "scam" verdict. Frame the output as which SPECIFIC patterns commonly associated with misleading marketing were matched, so the user can evaluate the evidence themselves.
2. Never state or imply certainty that a specific named institution, academy, or bootcamp is fraudulent or dishonest. Describe the patterns found IN THE SUBMITTED TEXT ITSELF — never make an accusation against a named party.
3. If no patterns are matched, do NOT say the page, course, or institution is "verified legitimate," "safe," or "trustworthy." Absence of a detected pattern is not proof of legitimacy — many legitimate pages simply weren't tested here, and this tool only checks language/structure, not the institution's actual conduct or outcomes. State plainly that no common misleading-marketing patterns were detected in this specific text, while noting this is not a legitimacy verification.
4. Every explanation must describe what is present in the text and why it matches a known misleading-marketing pattern — not a legal or factual conclusion about the institution.

Respond ONLY in valid JSON, no markdown, no explanation outside the JSON:
{
  "risk_level": "High" | "Medium" | "Low" | "None Detected",
  "summary": string (max 45 words, plain language, framed around patterns found — never a legitimacy claim),
  "patterns": [
    { "name": string (max 8 words), "explanation": string (max 30 words, quote or reference the specific part of the text that matched) }
  ]
}

If no patterns are found, return an empty "patterns" array, "risk_level": "None Detected", and a summary that explicitly notes the absence of detected patterns does not confirm legitimacy.`;

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

// Random code: KIBBO-COURSEAD-XXXX-XXXX-XXXX using an unambiguous charset (no O/0/I/1).
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

// ---- Optional real domain-age lookup (RDAP, public protocol, no API key) ----
// Only used if the submitted text is itself a bare URL/domain. Best-effort:
// any failure or timeout simply omits the fact rather than blocking analysis.
function extractDomain(input) {
  const trimmed = (input || '').trim();
  const urlMatch = trimmed.match(/^https?:\/\/([^\s/]+)/i);
  let host = urlMatch ? urlMatch[1] : null;
  if (!host) {
    // Treat as a bare domain only if the ENTIRE trimmed input matches (avoid
    // pulling a domain-looking substring out of a longer pasted message).
    const bareMatch = trimmed.match(/^([a-z0-9-]+\.)+[a-z]{2,}$/i);
    host = bareMatch ? trimmed : null;
  }
  if (!host) return null;
  host = host.replace(/:\d+$/, ''); // strip port
  return host.toLowerCase();
}

async function lookupDomainAgeDays(domain) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/rdap+json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const events = Array.isArray(data.events) ? data.events : [];
    const reg = events.find((e) => e.eventAction === 'registration');
    if (!reg || !reg.eventDate) return null;
    const regDate = new Date(reg.eventDate);
    if (isNaN(regDate.getTime())) return null;
    return Math.floor((Date.now() - regDate.getTime()) / 86400000);
  } catch (err) {
    return null; // RDAP unavailable/timeout — omit the fact, don't block analysis
  } finally {
    clearTimeout(timer);
  }
}

// ---- Main analysis (rate limited unless the IP is activated) ----
async function handleAnalyze(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: 'Server is missing ANTHROPIC_API_KEY' }, 500);
  }

  let input;
  try {
    input = ((await request.json()).text || '').toString().trim();
  } catch (err) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  if (!input) {
    return jsonResponse({ error: 'Missing "text" field' }, 400);
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

  // Real domain-age fact (RDAP), only appended if the input is itself a URL/domain.
  let userMessage = input;
  const domain = extractDomain(input);
  if (domain) {
    const ageDays = await lookupDomainAgeDays(domain);
    if (ageDays !== null) {
      userMessage =
        `SUBMITTED URL/DOMAIN: ${input}\n` +
        `VERIFIED DOMAIN AGE FACT (from public RDAP registration data): this domain was registered approximately ${ageDays} day(s) ago.\n\n` +
        `Analyze the above using this verified age fact only where it is directly relevant (e.g. if the page or its content claims a longer operating history than this).`;
    } else {
      userMessage =
        `SUBMITTED URL/DOMAIN: ${input}\n` +
        `Domain age could not be verified (no data returned). Do not state or guess a domain age.\n\n` +
        `Analyze the above.`;
    }
  }

  try {
    let apiRes;
    let lastDetail = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        apiRes = await anthropicFetch(env.ANTHROPIC_API_KEY, userMessage);
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

async function anthropicFetch(apiKey, message) {
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
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: message }],
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
