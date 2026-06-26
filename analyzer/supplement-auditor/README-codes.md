# Access Codes — setup & fulfilment

The Supplement Auditor gives everyone **3 free analyses per IP per day**. An
**access code** unlocks **unlimited** analyses for that visitor (lifetime, not
single-use — the same code can be activated from several devices/IPs).

Codes live in the same KV namespace (`RATE_LIMIT_KV`) under keys `code:KIBBO-...`.
You generate a batch of 50 once, then hand one code to each buyer.

---

## 0. Prerequisites (one-time)

You already have `ANTHROPIC_API_KEY` and the `RATE_LIMIT_KV` binding. You now
also need an **admin key** that protects the code-generation endpoint.

1. Pick a long random string (e.g. `openssl rand -hex 24`).
2. Store it as a Worker secret:

   ```bash
   cd analyzer/supplement-auditor
   wrangler secret put ADMIN_KEY
   # paste the random string when prompted
   wrangler deploy
   ```

> In the Cloudflare dashboard this is: **Workers & Pages → supplement-auditor →
> Settings → Variables and Bindings → Add → Secret → Name `ADMIN_KEY`**.

---

## 1. Generate the 50 codes (run ONCE)

`GET /setup-codes` creates 50 unique codes, stores each in KV as `unused`, and
returns them as JSON. It is protected by the `X-Admin-Key` header.

```bash
curl -s -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  https://supplement-auditor.carlos-lopez-tejeiro.workers.dev/setup-codes \
  > codes.json
```

`codes.json` looks like:

```json
{ "count": 50, "codes": ["KIBBO-AB3C-9KQ2-7MTX", "KIBBO-..."] }
```

> Run this **once**. Running it again generates **another** 50 codes (the old
> ones keep working — codes are never deleted). Keep `codes.json` private.

---

## 2. Download / save the codes as a plain list

Turn the JSON into a one-code-per-line text file:

```bash
# requires jq (or use the Python one-liner below)
jq -r '.codes[]' codes.json > codes.txt
```

No `jq`? Use Python:

```bash
python -c "import json;[print(c) for c in json.load(open('codes.json'))['codes']]" > codes.txt
```

`codes.txt` is your master list. Each time you sell one, mark it as used in this
file (the server does not need this — it is just your own bookkeeping).

---

## 3. Make one PDF per code (for Gumroad)

Generate 50 branded PDFs, one code each, into a `pdfs/` folder.

```bash
pip install reportlab
python make_code_pdfs.py     # script below
```

Create `make_code_pdfs.py` next to `codes.json`:

```python
import json, os
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

CODES = json.load(open("codes.json"))["codes"]
os.makedirs("pdfs", exist_ok=True)
URL = "https://www.getkibbo.com/supplement-analyzer"

for i, code in enumerate(CODES, 1):
    c = canvas.Canvas("pdfs/kibbo-code-%02d.pdf" % i, pagesize=A4)
    w, h = A4
    c.setFillColorRGB(0.83, 0.66, 0.26)            # amber #D4A843
    c.rect(0, h - 70 * mm, w, 70 * mm, fill=1, stroke=0)
    c.setFillColorRGB(1, 1, 1)
    c.setFont("Helvetica-Bold", 30)
    c.drawCentredString(w / 2, h - 42 * mm, "KIBBO — Unlimited Access")
    c.setFillColorRGB(0.17, 0.17, 0.16)            # ink
    c.setFont("Helvetica", 13)
    c.drawCentredString(w / 2, h - 95 * mm, "Your personal access code:")
    c.setFont("Courier-Bold", 26)
    c.drawCentredString(w / 2, h - 110 * mm, code)
    c.setFont("Helvetica", 12)
    lines = [
        "How to activate:",
        "1. Go to %s" % URL,
        "2. Click “Have an access code?” under the Analyze button.",
        "3. Paste the code above and press “Activate Code”.",
        "4. Enjoy unlimited analyses on that browser. Lifetime — no subscription.",
    ]
    y = h - 135 * mm
    for ln in lines:
        c.drawString(28 * mm, y, ln)
        y -= 8 * mm
    c.save()

print("Wrote %d PDFs to ./pdfs/" % len(CODES))
```

You now have `pdfs/kibbo-code-01.pdf … kibbo-code-50.pdf`.

---

## 4. Deliver one code per purchase on Gumroad

Gumroad does not auto-hand-out one file from a pool, so use one of these:

- **Simplest (recommended): Gumroad license keys.** Create the product, enable
  **"Generate a unique license key per sale"**, and in the product content paste
  the activation instructions plus a line: *"Your code is your license key
  above."* Then mirror those license keys into KV by re-running setup is **not**
  needed — instead, generate the codes here and treat each Gumroad sale as
  manual: see the next option. (License-key text and our `KIBBO-` codes are
  different namespaces, so only use this if you switch the worker to accept
  Gumroad keys.)

- **Manual fulfilment (works today, no code changes):** upload nothing
  sensitive to the public product. After each sale, Gumroad emails you the buyer;
  reply (or use Gumroad's "post-purchase" email) attaching the next unused
  `pdfs/kibbo-code-NN.pdf` and cross it off `codes.txt`. Low volume, zero risk.

- **Semi-automated:** upload all 50 PDFs to the product as files; in the receipt
  tell buyers to use only the file matching their order number. (Not airtight —
  a buyer could grab several — fine for trust-based, low-volume sales.)

Whichever you pick, the activation flow for the buyer is identical: paste the
`KIBBO-XXXX-XXXX-XXXX` code on the page and it's unlimited from then on.

---

## Endpoint reference

| Method | Path | Auth | Body | Returns |
|--------|------|------|------|---------|
| `GET`  | `/setup-codes`   | `X-Admin-Key` | — | `{ count, codes[] }` |
| `POST` | `/validate-code` | — | `{ code }` | `{ valid: bool }` |
| `POST` | `/activate-code` | — | `{ code }` | `{ success: bool }` (marks this IP unlimited) |
| `POST` | `/`              | — | `{ ingredients }` | analysis + `remaining` (number \| `"unlimited"`) |
