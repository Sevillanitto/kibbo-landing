// Supplement Ingredients Auditor — Cloudflare Worker
//
// Receives POST { ingredients: "..." }, calls the Claude API, and returns
// the parsed JSON analysis to the frontend.
//
// Set the API key as an environment variable / secret named ANTHROPIC_API_KEY:
//   npx wrangler secret put ANTHROPIC_API_KEY

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

export default {
  async fetch(request, env) {
    // Preflight
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
