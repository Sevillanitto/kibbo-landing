# Supplement Ingredients Auditor

A small web app that analyzes a supplement's ingredient list and returns a
quality score, an executive summary, and a per-ingredient verdict
(GREEN / YELLOW / RED), powered by Claude.

It is two files:

- **`index.html`** — the entire frontend (vanilla JS, no frameworks, no build step).
- **`worker.js`** — a Cloudflare Worker that holds your Anthropic API key and talks to Claude.

Total setup time is under 15 minutes, even if you've never deployed anything.

---

## What you'll need

- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account.
- An [Anthropic](https://console.anthropic.com) account with API access.
- [Node.js](https://nodejs.org) installed (only used to run Cloudflare's `wrangler` command-line tool).

---

## Step 1 — Get an Anthropic API key (≈3 min)

1. Go to **https://console.anthropic.com**.
2. Sign in (or create an account).
3. Add a small amount of credit under **Billing** if you haven't already.
4. Open **API Keys** → **Create Key**.
5. Copy the key (it starts with `sk-ant-...`). **Save it somewhere safe — you only see it once.**

---

## Step 2 — Deploy the Cloudflare Worker (≈6 min)

The Worker keeps your API key secret. The browser never sees it.

1. Open a terminal in the folder that contains `worker.js`.

2. Install Cloudflare's tool and log in:

   ```bash
   npm install -g wrangler
   wrangler login
   ```

   A browser window opens — click **Allow** to connect wrangler to your account.

3. Create a config file named **`wrangler.toml`** next to `worker.js`:

   ```toml
   name = "supplement-auditor"
   main = "worker.js"
   compatibility_date = "2024-01-01"
   ```

4. Store your Anthropic key as a secret (it is NOT written into any file):

   ```bash
   wrangler secret put ANTHROPIC_API_KEY
   ```

   Paste your `sk-ant-...` key when prompted and press Enter.

5. Deploy:

   ```bash
   wrangler deploy
   ```

6. When it finishes, wrangler prints a URL like:

   ```
   https://supplement-auditor.YOUR-NAME.workers.dev
   ```

   **Copy that URL** — you need it in the next step.

---

## Step 3 — Point the HTML at your Worker (≈1 min)

1. Open **`index.html`** in any text editor.
2. Near the top of the `<script>` block, find this line:

   ```js
   const WORKER_URL = 'https://your-worker.workers.dev';
   ```

3. Replace it with the URL you copied in Step 2:

   ```js
   const WORKER_URL = 'https://supplement-auditor.YOUR-NAME.workers.dev';
   ```

4. Save the file.

You can now open `index.html` directly in your browser and it will work.

---

## Step 4 — Publish the page on Netlify (≈2 min)

1. Go to **https://app.netlify.com** and sign in (free account).
2. On the dashboard, find the **"Drag and drop"** deploy area
   (it says something like *"Want to deploy a new site without connecting to Git? Drag and drop your site output folder here"*).
3. Drag your **`index.html`** file (or the folder containing it) onto that area.
4. Netlify gives you a live URL like `https://random-name.netlify.app`.

That's it — your auditor is live on the internet.

> Tip: if you ever change the `WORKER_URL`, just drag the updated `index.html`
> onto Netlify again to redeploy.

---

## How it works

```
Browser (index.html)
   │   POST { ingredients: "..." }
   ▼
Cloudflare Worker (worker.js)   ← holds ANTHROPIC_API_KEY
   │   calls the Claude API (claude-haiku-4-5-20251001)
   ▼
Claude returns JSON  →  Worker  →  Browser renders the report
```

The Worker adds CORS headers so the browser is allowed to call it, keeps your
API key off the client, and parses Claude's JSON response before returning it.

---

## Troubleshooting

- **"Could not analyze the ingredients"** in the browser — the `WORKER_URL` is
  wrong or the Worker isn't deployed. Re-check Step 3, and open the Worker URL
  directly: a `POST`-only worker will say "Method not allowed" for a normal
  visit, which means it's alive.
- **500 "missing ANTHROPIC_API_KEY"** — re-run `wrangler secret put ANTHROPIC_API_KEY`, then `wrangler deploy` again.
- **502 "Claude API error"** — usually an invalid key or no billing credit on
  your Anthropic account. Check the Anthropic console.
