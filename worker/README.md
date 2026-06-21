# Shooting Star community timer — backend (Cloudflare Worker + D1)

This is the write-capable backend that lets **anyone** submit a min/max "minutes
until next star" prediction plus a username. It stores submissions in a
Cloudflare D1 (SQLite) database and serves a **median consensus** (presented as
"the average") plus a browse list. The GitHub Pages frontend stays where it is —
it just calls these two endpoints.

```
POST /submit   { username, minTime, maxTime, telescopeType? }  -> { ok: true }
GET  /data     -> { schemaVersion, absMin, absMax, method, sampleCount,
                    rejectedCount, computedAt, submissions: [...] }
```

`absMin` / `absMax` are **absolute epoch-ms timestamps** of the predicted event
window. The frontend converts them to "minutes from now" at display time.

---

## One-time deploy (≈10 minutes)

You need a (free) Cloudflare account. Everything below is free tier.

### 1. Install Wrangler

```bash
npm install -g wrangler        # or use `npx wrangler ...` everywhere below
wrangler --version
```

### 2. Log in (opens a browser)

```bash
wrangler login
```

### 3. Create the D1 database

```bash
cd worker
wrangler d1 create star-timer
```

This prints a `database_id`. Copy it into **`wrangler.toml`**, replacing
`REPLACE_WITH_YOUR_DATABASE_ID`.

### 4. Create the table

```bash
wrangler d1 execute star-timer --remote --file=./schema.sql
```

### 5. Set the `CLIENT_HINT_KEY` secret

The Worker stores per-client vote-dedupe keys as `HMAC-SHA-256(CLIENT_HINT_KEY, ip)`
rather than plain `SHA-256(ip)` — so that an attacker who ever reads the `predictions`
table cannot rainbow-table those hashes back to raw IPs. Generate any sufficiently
random string and set it as a Worker secret (the value never goes in `wrangler.toml`
or any committed file):

```bash
openssl rand -hex 32 | wrangler secret put CLIENT_HINT_KEY
```

Without this secret the Worker throws on every submit. Rotate it any time; old rows
will simply expire out via the normal 6h TTL (a one-time duplicate-vote window opens
for ~6h after rotation, which is the intended trade-off).

### 6. Deploy the Worker

```bash
wrangler deploy
```

Wrangler prints your Worker URL, e.g.
`https://star-timer.<your-subdomain>.workers.dev`.

### 7. Point the frontend at it

In **`../script.js`**, set the config constant near the top:

```js
const REMOTE_API = 'https://star-timer.<your-subdomain>.workers.dev';
```

(No trailing slash.) Commit and push — GitHub Pages redeploys automatically. The
submit form and "Community Predictions" list appear once `REMOTE_API` is set;
while it's empty, the site behaves exactly as before (reads `global-data.json`).

---

## Local testing (no Cloudflare account needed)

`wrangler dev` runs the Worker locally with an in-memory/local SQLite via
Miniflare — no login required:

```bash
cd worker
wrangler d1 execute star-timer --local --file=./schema.sql   # seed local DB
wrangler dev                                                  # serves on http://localhost:8787
```

Then in another shell:

```bash
# submit
curl -s -X POST http://localhost:8787/submit \
  -H 'Content-Type: application/json' \
  -d '{"username":"Zezima","minTime":55,"maxTime":56,"telescopeType":"Mahogany"}'

# read aggregate + list
curl -s http://localhost:8787/data | jq
```

To test the frontend against your local Worker, set
`const REMOTE_API = 'http://localhost:8787';` temporarily (localhost origins are
already allowed by the Worker's CORS config).

---

## How it behaves (the parts worth knowing)

- **Server stamps the time.** `submitted_at` is set by the Worker, never the
  client, so a wrong/lying client clock can't poison the consensus.
- **Median, not mean.** A single troll submitting `maxTime` of nonsense barely
  moves the displayed window. With ≥4 live submissions, midpoint outliers beyond
  1.5×IQR are dropped before the median is taken.
- **One active prediction per client.** A client is keyed by `sha256(ip)` (the true
  Cloudflare-set connecting IP, which the browser can't spoof; User-Agent is
  deliberately excluded so it can't be varied to mint extra votes). Resubmitting
  overwrites your previous entry — enforced by a `UNIQUE(client_hint)` upsert — instead
  of stacking votes, and a 10-second cooldown blocks rapid hammering. Trade-off: people
  behind the same IP (a shared household) share one vote.
- **Self-cleaning.** Submissions older than 6h are deleted on the next write AND by a
  daily Cron Trigger (so quiet boards clean up too). Expired predictions (window already
  elapsed) are excluded from the consensus and shown greyed-out in the list.
- **Validation.** `0 ≤ minTime ≤ maxTime ≤ 400` minutes (the in-game telescope tops
  out around 333 min); usernames are trimmed, stripped of control chars, and capped
  at 20 characters. The frontend additionally **HTML-escapes** usernames on render
  to prevent XSS.

## Moderation

To remove a bad row:

```bash
wrangler d1 execute star-timer --remote \
  --command "DELETE FROM predictions WHERE username = 'BadName';"
```

Or inspect everything:

```bash
wrangler d1 execute star-timer --remote --command "SELECT username, min_time, max_time, datetime(submitted_at/1000,'unixepoch') AS at FROM predictions ORDER BY submitted_at DESC;"
```

## Optional hardening (only if you actually see abuse)

The submit endpoint is intentionally anonymous, so abuse is *bounded* (IP-keyed
one-vote + cooldown + median + IQR), not *eliminated*. A determined attacker with
many IPs can still stuff plausible-looking votes. If that ever happens:

- **Cloudflare Rate Limiting rule** on `POST /submit`, keyed on IP at the edge —
  the highest-leverage fix, configured in the Cloudflare dashboard, no code change.
- **Cloudflare Turnstile** — a no-puzzle, no-account bot check; add a token to the
  submit body and verify it in the Worker. Near-zero friction.
- **Content-Security-Policy** on the GitHub Pages site (`script-src 'self'`) as
  defense-in-depth for the stored usernames. Note: the current `index.html` uses
  inline `onclick=` handlers, which a strict CSP would block — you'd refactor those
  to `addEventListener` first.

None of these are needed at launch for a low-visibility hobby tool.

## Limits (free tier, 2026)

Workers: 100k requests/day. D1: 5M rows read/day, 100k written/day, 5 GB storage.
At tens-to-hundreds of submissions and a few hundred page-loads/day you use well
under 0.1% of any of these.
