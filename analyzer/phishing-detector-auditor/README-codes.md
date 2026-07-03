# AI Phishing Detector — Worker, deploy & access codes

Free tool page: `/phishing-detector.html` → talks to the Cloudflare Worker
**`phishing-detector-auditor`**, which holds the Anthropic API key and calls Claude.

- **3 free checks per IP per day** (KV key `ip:{IP}:{YYYY-MM-DD}`, TTL 86400s).
- An **access code** (`KIBBO-PHISH-XXXX-XXXX-XXXX`) unlocks **unlimited** checks
  for that visitor, lifetime. Codes live in the KV namespace
  `phishing-detector-rate-limit` under keys `code:KIBBO-PHISH-...`.
- Only codes with the `KIBBO-PHISH-` prefix are accepted (codes from the other
  Kibbo analyzers are rejected).

## Deployed

- Worker URL: `https://phishing-detector-auditor.carlos-lopez-tejeiro.workers.dev`
- KV namespace: `phishing-detector-rate-limit` (id `a95e5b0325844763814f41b1763f6deb`)
- Secrets: `ANTHROPIC_API_KEY` (already configured), `ADMIN_KEY` (set).

## Redeploy

```bash
cd analyzer/phishing-detector-auditor
npx wrangler deploy
```

## Generate the 50 access codes (run ONCE)

`GET /setup-codes` creates 50 unique `KIBBO-PHISH-` codes, stores each in KV as
`unused`, and returns them as JSON. Protected by the `X-Admin-Key` header.

```bash
curl -s -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  https://phishing-detector-auditor.carlos-lopez-tejeiro.workers.dev/setup-codes \
  > codes.json
```

> Run once. Running again generates **another** 50 (old codes keep working).
> **Keep `codes.json` private — never commit it.**

## Endpoint reference

| Method | Path | Auth | Body | Returns |
|--------|------|------|------|---------|
| `GET`  | `/setup-codes`   | `X-Admin-Key` | — | `{ count, codes[] }` |
| `POST` | `/validate-code` | — | `{ code }` | `{ valid: bool }` (KIBBO-PHISH- only) |
| `POST` | `/activate-code` | — | `{ code }` | `{ success: bool }` (marks this IP unlimited) |
| `POST` | `/`              | — | `{ message }` | analysis + `remaining` (number \| `"unlimited"`) |

Analysis JSON: `{ verdict (PHISHING\|SUSPICIOUS\|LEGITIMATE), confidence, signals[], advice, remaining }`.
The Claude prompt (impersonation targets, signal list, VERDICT/CONFIDENCE/SIGNALS/ADVICE
output) is reused verbatim from the original AI Phishing Detector web app.
