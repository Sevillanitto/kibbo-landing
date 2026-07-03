# Legal Contract Auditor — Worker, deploy & access codes

Free tool page: `/legal-contract-auditor.html` → talks to the Cloudflare Worker
**`legal-contract-auditor`**, which holds the Anthropic API key and calls Claude.

- **3 free analyses per IP per day** (KV key `ip:{IP}:{YYYY-MM-DD}`, TTL 86400s).
- An **access code** (`KIBBO-LEGAL-XXXX-XXXX-XXXX`) unlocks **unlimited** analyses
  for that visitor, lifetime. Codes live in the KV namespace
  `legal-contract-rate-limit` under keys `code:KIBBO-LEGAL-...`.
- Only codes with the `KIBBO-LEGAL-` prefix are accepted (generic `KIBBO-` codes
  from the Supplement Auditor are rejected).

## Deployed

- Worker URL: `https://legal-contract-auditor.carlos-lopez-tejeiro.workers.dev`
- KV namespace: `legal-contract-rate-limit` (id `57c970ae206a42629176fecfae01607e`)
- Secrets: `ANTHROPIC_API_KEY` (already configured), `ADMIN_KEY` (set).

## Redeploy

```bash
cd analyzer/legal-contract-auditor
npx wrangler deploy
```

## Secrets

```bash
npx wrangler secret put ANTHROPIC_API_KEY   # already set
npx wrangler secret put ADMIN_KEY           # protects /setup-codes
```

## Generate the 50 access codes (run ONCE)

`GET /setup-codes` creates 50 unique `KIBBO-LEGAL-` codes, stores each in KV as
`unused`, and returns them as JSON. Protected by the `X-Admin-Key` header.

```bash
curl -s -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  https://legal-contract-auditor.carlos-lopez-tejeiro.workers.dev/setup-codes \
  > codes.json
```

> Run once. Running again generates **another** 50 (old codes keep working).
> **Keep `codes.json` private — never commit it** (anyone with a code gets
> unlimited access).

## Endpoint reference

| Method | Path | Auth | Body | Returns |
|--------|------|------|------|---------|
| `GET`  | `/setup-codes`   | `X-Admin-Key` | — | `{ count, codes[] }` |
| `POST` | `/validate-code` | — | `{ code }` | `{ valid: bool }` (KIBBO-LEGAL- only) |
| `POST` | `/activate-code` | — | `{ code }` | `{ success: bool }` (marks this IP unlimited) |
| `POST` | `/`              | — | `{ contract }` | analysis + `remaining` (number \| `"unlimited"`) |

Analysis JSON: `{ score, summary, clauses: [ { name, verdict (RED\|AMBER), reason, quote } ] }`
