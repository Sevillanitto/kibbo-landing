// Supplement Ingredients Auditor — Cloudflare Worker
//
// Receives POST { ingredients: "..." }, enforces a free daily rate limit per
// IP using Cloudflare KV, calls the Claude API, and returns the parsed JSON
// analysis (plus how many free analyses remain today) to the frontend.
//
// Required bindings / secrets:
//   - ANTHROPIC_API_KEY  (secret):  npx wrangler secret put ANTHROPIC_API_KEY
//   - RATE_LIMIT_KV      (KV namespace binding):  see wrangler.toml / README

const DAILY_LIMIT = 3;

const SYSTEM_PROMPT = `You are an evidence-based sports nutrition and toxicology expert. Analyze the following supplement ingredient list.

For each ingredient return:
- verdict: GREEN, YELLOW, or RED
- name: ingredient name
- reason: one clear sentence, no jargon, max 15 words

Also return:
- score: global quality score 1-100
- summary: one paragraph executive summary in plain English, max 40 words

Respond ONLY in valid JSON, no markdown, no explanation:
{
  score: number,
  summary: string,
  ingredients: [
    { name: string, verdict: string, reason: string }
  ]
}`;

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

// KV key for the per-IP, per-day counter, e.g. "ip:203.0.113.7:2026-06-26".
// The date component (UTC) rotates the key every day; the TTL just garbage-
// collects yesterday's keys.
function rateKey(ip) {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return `ip:${ip}:${day}`;
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return jsonResponse({ error: 'Server is missing ANTHROPIC_API_KEY' }, 500);
    }

    let ingredients;
    try {
      const payload = await request.json();
      ingredients = (payload.ingredients || '').toString().trim();
    } catch (err) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    if (!ingredients) {
      return jsonResponse({ error: 'Missing "ingredients" field' }, 400);
    }

    // ---- Rate limiting (free: DAILY_LIMIT analyses per IP per day) ----
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const kv = env.RATE_LIMIT_KV;
    const key = rateKey(ip);
    let used = 0;

    if (kv) {
      try {
        const stored = await kv.get(key);
        used = stored ? (parseInt(stored, 10) || 0) : 0;
      } catch (err) {
        // KV read failed — fail open so a storage hiccup never blocks users.
        used = 0;
      }

      if (used >= DAILY_LIMIT) {
        return jsonResponse(
          {
            error: 'limit_reached',
            message: 'You have used your 3 free analyses today. Come back tomorrow.',
          },
          429
        );
      }
    }

    // ---- Claude API call ----
    try {
      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2048,
          system: SYSTEM_PROMPT,
          messages: [
            { role: 'user', content: ingredients },
          ],
        }),
      });

      if (!apiRes.ok) {
        const detail = await apiRes.text();
        return jsonResponse(
          { error: 'Claude API error', status: apiRes.status, detail },
          502
        );
      }

      const data = await apiRes.json();

      // Extract the text from the first text content block.
      const textBlock = (data.content || []).find((b) => b.type === 'text');
      const raw = textBlock ? textBlock.text : '';

      const parsed = parseAnalysis(raw);
      if (!parsed) {
        return jsonResponse(
          { error: 'Could not parse model output', raw },
          502
        );
      }

      // Only count successful analyses so users aren't charged a credit for
      // our own errors. Increment now and report what's left.
      let remaining = null;
      if (kv) {
        const newUsed = used + 1;
        try {
          await kv.put(key, String(newUsed), { expirationTtl: 86400 });
        } catch (err) {
          // If the write fails we still return the analysis; the counter just
          // won't advance this time.
        }
        remaining = Math.max(0, DAILY_LIMIT - newUsed);
      }

      parsed.remaining = remaining;
      return jsonResponse(parsed);
    } catch (err) {
      return jsonResponse({ error: 'Worker error', detail: err.message }, 500);
    }
  },
};

// Robustly extract the JSON object from the model's reply, even if it wraps it
// in markdown fences or adds stray text.
function parseAnalysis(text) {
  if (!text) return null;

  let candidate = text.trim();

  // Strip ```json ... ``` or ``` ... ``` fences if present.
  const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  }

  // Fall back to the first {...} block.
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
