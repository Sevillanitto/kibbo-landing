# Delivery Contract Analyzer — Worker, deploy & access codes

Free tool page: `/delivery-contract-analyzer.html` → talks to the Cloudflare
Worker **`delivery-contract-analyzer`**, which holds the Anthropic API key and
calls Claude.

- **3 free analyses per IP per day** (KV key `ip:{IP}:{YYYY-MM-DD}`, TTL 86400s).
- An **access code** (`KIBBO-DELIVERY-XXXX-XXXX-XXXX`) unlocks **unlimited**
  analyses for that visitor, lifetime. Codes live in the KV namespace
  `delivery-contract-analyzer-rate-limit` under keys `code:KIBBO-DELIVERY-...`.
- Only codes with the `KIBBO-DELIVERY-` prefix are accepted (codes from the
  other analyzers are rejected).

## Deployed

- Worker URL: `https://delivery-contract-analyzer.carlos-lopez-tejeiro.workers.dev`
- KV namespace: `delivery-contract-analyzer-rate-limit` (id `d11971d629794bfeb705e72eb42fd76a`), bound as `RATE_LIMIT_KV`
- Secrets: `ANTHROPIC_API_KEY` (already configured, confirmed `secret_text` type via `wrangler secret list`), `ADMIN_KEY` (set).

## Redeploy

```bash
cd analyzer/delivery-contract-analyzer
npx wrangler deploy
```

## Secrets

```bash
npx wrangler secret put ANTHROPIC_API_KEY   # already set
npx wrangler secret put ADMIN_KEY           # protects /setup-codes
```

## Generate more access codes

`GET /setup-codes` creates 50 unique `KIBBO-DELIVERY-` codes, stores each in KV
as `unused`, and returns them as JSON. Protected by the `X-Admin-Key` header.

```bash
curl -s -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  https://delivery-contract-analyzer.carlos-lopez-tejeiro.workers.dev/setup-codes \
  > codes.json
```

> The initial 50 codes were generated 2026-08-13. Running this again generates
> **another** 50 (old codes keep working — codes are never deleted).
> **Keep `codes.json` private — never commit it** (anyone with a code gets
> unlimited access). It's already covered by the repo's root `.gitignore`
> (`**/codes.json`).

## Endpoint reference

| Method | Path | Auth | Body | Returns |
|--------|------|------|------|---------|
| `GET`  | `/setup-codes`   | `X-Admin-Key` | — | `{ count, codes[] }` |
| `POST` | `/validate-code` | — | `{ code }` | `{ valid: bool }` (KIBBO-DELIVERY- only) |
| `POST` | `/activate-code` | — | `{ code }` | `{ success: bool }` (marks this IP unlimited) |
| `POST` | `/`              | — | `{ contract }` | analysis + `remaining` (number \| `"unlimited"`) |

Analysis JSON: `{ overall_risk, summary, disclaimer, categories: [ { category, risk (low|medium|high), quote, explanation, suggestion } ] }` — always exactly 7 categories, in a fixed order, normalized server-side even if the model drops one.

Frontend note: the contract can be typed/pasted directly into a textarea, **or**
uploaded as a PDF and extracted to plain text client-side with PDF.js (same
extraction code as the Employment Contract Analyzer) — either way the Worker
only ever sees plain text, sent as `{ contract: text }`.
