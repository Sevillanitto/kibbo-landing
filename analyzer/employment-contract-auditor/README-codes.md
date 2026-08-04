# Employment Contract Auditor — Worker, deploy & access codes

Free tool page: `/employment-contract-analyzer.html` → talks to the Cloudflare
Worker **`employment-contract-auditor`**, which holds the Anthropic API key and
calls Claude.

- **3 free analyses per IP per day** (KV key `ip:{IP}:{YYYY-MM-DD}`, TTL 86400s).
- An **access code** (`KIBBO-EMPLOY-XXXX-XXXX-XXXX`) unlocks **unlimited**
  analyses for that visitor, lifetime. Codes live in the KV namespace
  `EMPLOYMENT_ANALYZER_RATE_LIMIT` under keys `code:KIBBO-EMPLOY-...`.
- Only codes with the `KIBBO-EMPLOY-` prefix are accepted (codes from the other
  3 analyzers are rejected).

## Deployed

- Worker URL: `https://employment-contract-auditor.carlos-lopez-tejeiro.workers.dev`
- KV namespace: `EMPLOYMENT_ANALYZER_RATE_LIMIT` (id `e347ff4548d54446a165222a5f4dc164`), bound as `RATE_LIMIT_KV`
- Secrets: `ANTHROPIC_API_KEY` (already configured), `ADMIN_KEY` (set).

## Redeploy

```bash
cd analyzer/employment-contract-auditor
npx wrangler deploy
```

## Secrets

```bash
npx wrangler secret put ANTHROPIC_API_KEY   # already set
npx wrangler secret put ADMIN_KEY           # protects /setup-codes
```

## Generate more access codes

`GET /setup-codes` creates 50 unique `KIBBO-EMPLOY-` codes, stores each in KV as
`unused`, and returns them as JSON. Protected by the `X-Admin-Key` header.

```bash
curl -s -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  https://employment-contract-auditor.carlos-lopez-tejeiro.workers.dev/setup-codes \
  > codes.json
```

> The initial 50 codes were generated 2026-08-04. Running this again generates
> **another** 50 (old codes keep working — codes are never deleted).
> **Keep `codes.json` private — never commit it** (anyone with a code gets
> unlimited access). It's already covered by the repo's root `.gitignore`
> (`**/codes.json`).

## Endpoint reference

| Method | Path | Auth | Body | Returns |
|--------|------|------|------|---------|
| `GET`  | `/setup-codes`   | `X-Admin-Key` | — | `{ count, codes[] }` |
| `POST` | `/validate-code` | — | `{ code }` | `{ valid: bool }` (KIBBO-EMPLOY- only) |
| `POST` | `/activate-code` | — | `{ code }` | `{ success: bool }` (marks this IP unlimited) |
| `POST` | `/`              | — | `{ contract }` | analysis + `remaining` (number \| `"unlimited"`) |

Analysis JSON: `{ score, summary, clauses: [ { name, verdict (RED\|AMBER), reason, quote } ] }`

Frontend note: the contract is uploaded as a PDF, then extracted to plain text
client-side with PDF.js before being sent to the Worker as `{ contract: text }`
— the Worker itself only ever sees text, identical to the Legal Contract
Auditor's wire format.
