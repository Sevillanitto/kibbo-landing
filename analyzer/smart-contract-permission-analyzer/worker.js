// Smart Contract Permission Analyzer — Cloudflare Worker
//
// Same freemium wrapper as the other Kibbo analyzers (access codes, per-IP
// daily rate limit). Unlike the text-based analyzers, this one is primarily
// an ON-CHAIN DATA QUERY, not an LLM judgment call: every fact in the output
// (token, spender, unlimited vs capped, grant age, contract verification,
// spender last-activity) is fetched from the Etherscan API and/or computed
// deterministically in this Worker. The RISK FLAG on each approval is also
// computed deterministically here, not decided by the model. Claude's only
// job is to phrase the already-determined facts in plain language — it is
// never asked to guess or infer approval state from general knowledge.
//
// ETHEREUM MAINNET ONLY at launch. This is a hard, explicit limitation —
// the frontend and this Worker both state it; no other chain is queried or
// implied anywhere in the code or copy.
//
// Endpoints:
//   POST /                → analyze a wallet address (rate limited 3/day per
//                           IP, unlimited for activated IPs)
//   POST /validate-code   → { code } -> { valid: bool }   (KIBBO-CONTRACT- only)
//   POST /activate-code   → { code } -> { success: bool }, marks this IP unlimited
//   GET  /setup-codes     → admin-only, generates 50 access codes (run once)
//
// Required bindings / secrets:
//   - ANTHROPIC_API_KEY  (secret): already configured
//   - ETHERSCAN_API_KEY  (secret): must be bound under exactly this name
//   - ADMIN_KEY          (secret): wrangler secret put ADMIN_KEY
//   - RATE_LIMIT_KV      (KV namespace binding): already bound

const DAILY_LIMIT = 3;
const CODE_COUNT = 50;
const CODE_PREFIX = 'KIBBO-CONTRACT-';

const ETHERSCAN_BASE = 'https://api.etherscan.io/v2/api?chainid=1';
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const SEL_ALLOWANCE = '0xdd62ed3e'; // allowance(address,address)
const SEL_SYMBOL = '0x95d89b41'; // symbol()
const SEL_DECIMALS = '0x313ce567'; // decimals()
const UNLIMITED_THRESHOLD = 2n ** 128n; // far above any realistic bounded amount, far below type(uint256).max
const MAX_PAIRS = 5; // caps Etherscan subrequests well under the Workers free-plan 50/request limit
const STALE_DAYS = 180;

const SYSTEM_PROMPT = `You are formatting and explaining real on-chain token approval data for a non-technical crypto user. You are given a JSON array of ALREADY-DETERMINED facts — each fact was fetched from the blockchain or computed deterministically. You must NOT invent, guess, re-derive, or contradict any field. Your only job is to phrase these facts in clear, plain, low-jargon language.

For each approval in the input, you will receive:
- token: the token symbol
- spender: the contract address the approval was granted to
- unlimited: true if the approval has no practical cap, false if it's a specific capped amount
- humanAmount: the capped amount in human-readable token units (only present if unlimited is false)
- grantedDaysAgo: how many days ago this approval was granted (on-chain fact)
- verified: whether the spender contract's source code is published/verified on Etherscan (on-chain fact)
- spenderLastActiveDaysAgo: days since the spender contract's last transaction, or null if unknown
- flagged: true/false — ALREADY DETERMINED. Do not recompute this. It is true only when the approval is unlimited AND the spender is unverified and/or has been inactive for a long stretch and/or the approval itself is old — i.e. unlimited approval + unfamiliar or dormant contract, not "any unlimited approval."

Write, for each approval:
- name: a short plain-language label (max 8 words)
- explanation: one or two plain sentences (max 40 words) stating what was found and, if flagged is true, why the combination (unlimited + unfamiliar/dormant) is worth a closer look. If flagged is false, say so plainly and note that many unlimited approvals to well-known, actively-used protocols are a normal, low-risk pattern — do not manufacture concern where none was flagged.
- revoke_note: one sentence reminding the user that revoking requires a small on-chain transaction with its own gas fee on a revocation tool — not a click inside this analyzer, which is read-only.

Also write:
- summary: one plain-language paragraph (max 45 words) describing what was found overall across all approvals.

CRITICAL: Never state or imply this tool can revoke anything itself. Never state a chain other than Ethereum mainnet was checked.

Respond ONLY in valid JSON, no markdown:
{
  "summary": string,
  "approvals": [
    { "name": string, "explanation": string, "revoke_note": string }
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
  const day = new Date().toISOString().slice(0, 10);
  return `ip:${ip}:${day}`;
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

function normalizeCode(code) {
  return (code || '').toString().trim().toUpperCase();
}

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

// ---- Etherscan V2 helpers ----
// Etherscan's free tier caps requests at ~5/sec. A single analysis can fire a
// couple dozen calls (logs + per-pair eth_calls + per-spender lookups); fired
// concurrently, that reliably trips the rate limit. A tripped call still
// returns a 200 with a non-array "result" (e.g. "Max rate limit reached"),
// which silently degraded to "unverified"/"unknown activity" for real,
// well-known, verified, active contracts — a false positive on the exact
// signal this tool exists to get right. All calls are serialized through a
// shared queue with spacing, and a rate-limit response is retried rather
// than treated as a genuine "no data" result.
let etherscanQueueTail = Promise.resolve();
function queueEtherscanCall(fn) {
  const run = () => fn();
  const scheduled = etherscanQueueTail.then(
    () => sleep(230).then(run),
    () => sleep(230).then(run)
  );
  etherscanQueueTail = scheduled.catch(() => {});
  return scheduled;
}

function isRateLimitedResult(json) {
  if (!json) return false;
  if (json.status === '0' && typeof json.result === 'string' && /rate limit/i.test(json.result)) return true;
  if (typeof json.message === 'string' && /rate limit/i.test(json.message)) return true;
  return false;
}

async function rawEtherscanGet(params, apiKey) {
  const qs = new URLSearchParams(params);
  qs.set('apikey', apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${ETHERSCAN_BASE}&${qs.toString()}`, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function etherscanGet(params, apiKey) {
  return queueEtherscanCall(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const json = await rawEtherscanGet(params, apiKey);
      if (json && isRateLimitedResult(json)) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      return json;
    }
    return null;
  });
}

function padAddress(addr) {
  return '0x' + '0'.repeat(24) + addr.toLowerCase().replace(/^0x/, '');
}

function unpadAddress(topicOrWord) {
  return '0x' + topicOrWord.slice(-40);
}

function hexToBigInt(hex) {
  if (!hex || hex === '0x') return 0n;
  try {
    return BigInt(hex);
  } catch (err) {
    return 0n;
  }
}

// Decodes an ERC-20 symbol() return, handling both the standard dynamic
// `string` ABI encoding and the non-standard fixed `bytes32` return some
// older tokens (e.g. MKR-style) use.
function decodeERC20String(hex, fallback) {
  if (!hex || hex === '0x' || hex.length < 3) return fallback;
  const clean = hex.slice(2);
  try {
    if (clean.length === 64) {
      // Could be a bytes32 return OR a degenerate dynamic string with zero length.
      const bytes = [];
      for (let i = 0; i < 64; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
      const trimmed = bytes.filter((b) => b !== 0);
      if (trimmed.length > 0) {
        return String.fromCharCode(...trimmed).trim() || fallback;
      }
    }
    if (clean.length >= 128) {
      const lenWord = clean.slice(64, 128);
      const len = parseInt(lenWord, 16);
      if (len > 0 && len < 256) {
        const dataHex = clean.slice(128, 128 + len * 2);
        const bytes = [];
        for (let i = 0; i < dataHex.length; i += 2) bytes.push(parseInt(dataHex.slice(i, i + 2), 16));
        return String.fromCharCode(...bytes).trim() || fallback;
      }
    }
  } catch (err) {
    /* fall through */
  }
  return fallback;
}

function formatTokenAmount(raw, decimals) {
  const d = typeof decimals === 'number' && decimals >= 0 && decimals <= 36 ? decimals : 18;
  const divisor = 10n ** BigInt(d);
  const whole = raw / divisor;
  if (whole > 1000000000n) return '> 1 billion';
  const remainder = raw % divisor;
  if (remainder === 0n) return whole.toString();
  const fracStr = remainder.toString().padStart(d, '0').slice(0, 4).replace(/0+$/, '');
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

async function ethCall(to, data, apiKey) {
  const res = await etherscanGet(
    { module: 'proxy', action: 'eth_call', to, data, tag: 'latest' },
    apiKey
  );
  if (!res || typeof res.result !== 'string') return null;
  return res.result;
}

async function handleAnalyze(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: 'Server is missing ANTHROPIC_API_KEY' }, 500);
  }
  if (!env.ETHERSCAN_API_KEY) {
    return jsonResponse({ error: 'Server is missing ETHERSCAN_API_KEY' }, 500);
  }

  let address;
  try {
    address = ((await request.json()).address || '').toString().trim();
  } catch (err) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return jsonResponse({ error: 'Please enter a valid Ethereum mainnet address (0x followed by 40 hex characters).' }, 400);
  }
  address = address.toLowerCase();

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
        { error: 'limit_reached', message: 'You have used your 3 free analyses today. Come back tomorrow.' },
        429
      );
    }
  }

  const etherscanKey = env.ETHERSCAN_API_KEY;

  // ---- Step 1: real on-chain data — Approval event logs for this owner ----
  const logsRes = await etherscanGet(
    {
      module: 'logs',
      action: 'getLogs',
      fromBlock: '0',
      toBlock: 'latest',
      topic0: APPROVAL_TOPIC,
      topic1: padAddress(address),
      page: '1',
      offset: '1000',
    },
    etherscanKey
  );

  const rawLogs = logsRes && Array.isArray(logsRes.result) ? logsRes.result : [];
  if (!rawLogs.length) {
    const empty = {
      summary: 'No ERC-20 approval events were found on Ethereum mainnet for this address in the available on-chain history.',
      approvals: [],
      chain: 'Ethereum mainnet only',
    };
    empty.remaining = await consumeQuota(kv, unlimited, key, used);
    return jsonResponse(empty);
  }

  // Dedupe by (token contract, spender), keeping the most recent (highest block) log.
  const pairMap = new Map();
  for (const log of rawLogs) {
    if (!log.topics || log.topics.length < 3) continue;
    const tokenContract = (log.address || '').toLowerCase();
    const spender = unpadAddress(log.topics[2]).toLowerCase();
    const blockNum = hexToBigInt(log.blockNumber);
    const mapKey = tokenContract + ':' + spender;
    const existing = pairMap.get(mapKey);
    if (!existing || blockNum > existing.blockNum) {
      pairMap.set(mapKey, {
        tokenContract,
        spender,
        blockNum,
        timeStamp: hexToBigInt(log.timeStamp),
      });
    }
  }

  const pairs = [...pairMap.values()]
    .sort((a, b) => (b.blockNum > a.blockNum ? 1 : b.blockNum < a.blockNum ? -1 : 0))
    .slice(0, MAX_PAIRS);

  const nowSec = BigInt(Math.floor(Date.now() / 1000));

  // ---- Step 2: current allowance + token metadata for each pair ----
  const pairResults = await Promise.all(
    pairs.map(async (p) => {
      const [allowanceHex, symbolHex, decimalsHex] = await Promise.all([
        ethCall(p.tokenContract, SEL_ALLOWANCE + padAddress(address).slice(2) + padAddress(p.spender).slice(2), etherscanKey),
        ethCall(p.tokenContract, SEL_SYMBOL, etherscanKey),
        ethCall(p.tokenContract, SEL_DECIMALS, etherscanKey),
      ]);
      const currentAllowance = allowanceHex ? hexToBigInt(allowanceHex) : 0n;
      const decimals = decimalsHex ? Number(hexToBigInt(decimalsHex)) : 18;
      const symbol = decodeERC20String(symbolHex, p.tokenContract.slice(0, 8) + '…');
      const grantedDaysAgo = Number((nowSec - p.timeStamp) / 86400n);
      return {
        tokenContract: p.tokenContract,
        spender: p.spender,
        symbol,
        decimals,
        currentAllowance,
        grantedDaysAgo,
      };
    })
  );

  // Only currently-active (nonzero) approvals are meaningful to surface.
  const active = pairResults.filter((r) => r.currentAllowance > 0n);

  if (!active.length) {
    const empty = {
      summary: 'No currently active (nonzero) token approvals were found for this address among its recent on-chain approval history — any past approvals appear to have already been spent down or revoked.',
      approvals: [],
      chain: 'Ethereum mainnet only',
    };
    empty.remaining = await consumeQuota(kv, unlimited, key, used);
    return jsonResponse(empty);
  }

  // ---- Step 3: spender contract verification + last-activity, deduped by spender ----
  const uniqueSpenders = [...new Set(active.map((a) => a.spender))];
  const spenderInfo = new Map();
  await Promise.all(
    uniqueSpenders.map(async (spender) => {
      const [sourceRes, txRes] = await Promise.all([
        etherscanGet({ module: 'contract', action: 'getsourcecode', address: spender }, etherscanKey),
        etherscanGet({ module: 'account', action: 'txlist', address: spender, page: '1', offset: '1', sort: 'desc' }, etherscanKey),
      ]);
      const sourceRow = sourceRes && Array.isArray(sourceRes.result) ? sourceRes.result[0] : null;
      const verified = !!(sourceRow && sourceRow.SourceCode && sourceRow.SourceCode.length > 0);
      const txRow = txRes && Array.isArray(txRes.result) ? txRes.result[0] : null;
      const lastActiveDaysAgo = txRow && txRow.timeStamp
        ? Number((nowSec - BigInt(txRow.timeStamp)) / 86400n)
        : null;
      spenderInfo.set(spender, { verified, lastActiveDaysAgo });
    })
  );

  // ---- Step 4: build deterministic facts (unlimited threshold + flag logic computed here, not by the model) ----
  const facts = active.map((a) => {
    const info = spenderInfo.get(a.spender) || { verified: false, lastActiveDaysAgo: null };
    const isUnlimited = a.currentAllowance >= UNLIMITED_THRESHOLD;
    const dormant = info.lastActiveDaysAgo === null || info.lastActiveDaysAgo > STALE_DAYS;
    const flagged = isUnlimited && (!info.verified || dormant || a.grantedDaysAgo > STALE_DAYS);
    return {
      token: a.symbol,
      tokenContract: a.tokenContract,
      spender: a.spender,
      unlimited: isUnlimited,
      humanAmount: isUnlimited ? undefined : formatTokenAmount(a.currentAllowance, a.decimals),
      grantedDaysAgo: a.grantedDaysAgo,
      verified: info.verified,
      spenderLastActiveDaysAgo: info.lastActiveDaysAgo,
      flagged,
    };
  });

  // ---- Step 5: Claude formats/explains the already-determined facts ----
  try {
    let apiRes;
    let lastDetail = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        apiRes = await anthropicFetch(env.ANTHROPIC_API_KEY, facts);
      } catch (netErr) {
        lastDetail = netErr && netErr.name === 'AbortError' ? 'Anthropic request timed out' : (netErr && netErr.message) || 'network error';
        apiRes = null;
      }
      if (apiRes && apiRes.ok) break;
      const status = apiRes ? apiRes.status : 0;
      const transient = !apiRes || status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
      if (!transient) {
        const detail = await apiRes.text();
        return jsonResponse({ error: 'Claude API error', status, detail }, 502);
      }
      if (apiRes) lastDetail = await apiRes.text();
      if (attempt < 2) await sleep(400 * (attempt + 1));
    }

    if (!apiRes || !apiRes.ok) {
      return jsonResponse({ error: 'Analysis service is busy, please try again in a moment.', detail: lastDetail }, 503);
    }

    const data = await apiRes.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    const parsed = parseAnalysis(textBlock ? textBlock.text : '');
    if (!parsed) {
      return jsonResponse({ error: 'Could not parse model output' }, 502);
    }

    // Merge the deterministic facts back in so the frontend has everything
    // (token, spender, amounts, flags) even though the model only produced
    // the plain-language name/explanation/revoke_note per approval.
    parsed.approvals = (parsed.approvals || []).map((a, i) => ({
      ...a,
      ...facts[i],
    }));
    parsed.chain = 'Ethereum mainnet only';
    parsed.remaining = await consumeQuota(kv, unlimited, key, used);

    return jsonResponse(parsed);
  } catch (err) {
    return jsonResponse({ error: 'Worker error', detail: err.message }, 500);
  }
}

async function consumeQuota(kv, unlimited, key, used) {
  if (unlimited) return 'unlimited';
  if (!kv) return null;
  const newUsed = used + 1;
  try {
    await kv.put(key, String(newUsed), { expirationTtl: 86400 });
  } catch (err) {
    /* counter just won't advance this time */
  }
  return Math.max(0, DAILY_LIMIT - newUsed);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function anthropicFetch(apiKey, facts) {
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
        messages: [{ role: 'user', content: JSON.stringify(facts) }],
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
