/**
 * Shooting Star community timer — Cloudflare Worker + D1.
 *
 * Two CORS-enabled endpoints called by the GitHub Pages frontend:
 *   POST /submit  { username, minTime, maxTime, telescopeType? }  -> { ok }
 *   GET  /data    -> { schemaVersion, absMin, absMax, method, sampleCount, rejectedCount, computedAt, submissions[] }
 *
 * Design notes:
 *  - submitted_at is stamped SERVER-SIDE; client clocks are never trusted for the anchor.
 *  - Each submission is converted to an ABSOLUTE predicted-event window (abs_min/abs_max)
 *    at write time, so predictions made at different wall-clock times are comparable.
 *  - The consensus is a robust MEDIAN of those windows (presented to users as "the average"),
 *    so a single troll submitting an absurd value cannot move the timer.
 *  - There is NO secret in client JS: the Worker runs server-side; D1 credentials never reach
 *    the browser. The /submit endpoint is intentionally public (anonymous community submissions),
 *    so abuse is bounded by validation + per-client dedupe/cooldown + median aggregation, not auth.
 */

const ALLOWED_ORIGINS = [
  'https://realdam.github.io',
];

const MAX_HORIZON_MINUTES = 400;          // telescope tops out ~333 min; beyond this is garbage
const USERNAME_MAX = 20;
const HARD_TTL_MS = 6 * 60 * 60 * 1000;   // drop submissions older than 6h (self-cleaning)
const COOLDOWN_MS = 10 * 1000;            // one client may not resubmit faster than this
const LIST_CAP = 100;                     // newest-N shown in the browse list
const MAX_SUBMIT_BODY_BYTES = 2048;
const MIN_IQR_BAND_MS = 3 * 60000;        // outlier fence never tighter than 3 min (keep near-agreeing rows)
const ALLOWED_TELESCOPES = ['Wooden', 'Teak', 'Mahogany'];

function corsHeaders(origin) {
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
  const allow = ALLOWED_ORIGINS.includes(origin) || isLocal ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
}

function json(body, status, origin, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin), ...(extraHeaders || {}) },
  });
}

async function readJsonBody(request, maxBytes) {
  const lengthHeader = request.headers.get('Content-Length');
  if (lengthHeader != null) {
    const declaredLength = Number(lengthHeader);
    if (!Number.isFinite(declaredLength) || declaredLength < 0)
      return { error: 'Invalid Content-Length header.', status: 400 };
    if (declaredLength > maxBytes)
      return { error: `Request body is too large (max ${maxBytes} bytes).`, status: 413 };
  }

  if (!request.body)
    return { error: 'Invalid JSON body.', status: 400 };

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { error: `Request body is too large (max ${maxBytes} bytes).`, status: 413 };
      }

      text += decoder.decode(value, { stream: true });
    }

    text += decoder.decode();
  } catch (e) {
    console.error('readJsonBody: stream/parse failure:', e?.message);
    return { error: 'Invalid request body.', status: 400 };
  }

  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: 'Invalid JSON body.', status: 400 };
  }
}

// Per-client key for dedupe + cooldown. Keyed on HMAC-SHA-256(env.CLIENT_HINT_KEY, ip)
// where ip is the true connecting IP (Cloudflare sets CF-Connecting-IP and the client
// cannot spoof it). The HMAC secret (set via `wrangler secret put CLIENT_HINT_KEY`)
// prevents an attacker with DB read access from rainbow-table-ing the hashes back to
// raw IPs — a plain SHA-256(ip) would be reversible against edge-log correlation.
// User-Agent is deliberately excluded: including it would let one host mint unlimited
// identities by varying UA, defeating the one-vote-per-client and rate-limit guards.
// Trade-off: users behind the same IP (shared NAT/household) collapse to one active
// vote, which is acceptable and strengthens consensus integrity against ballot-stuffing.
async function clientHint(request, env) {
  if (!env.CLIENT_HINT_KEY) {
    throw new Error('CLIENT_HINT_KEY not configured (run: wrangler secret put CLIENT_HINT_KEY)');
  }
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.CLIENT_HINT_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Strip ASCII control chars (codepoints < 32 and DEL 127), collapse whitespace, cap length.
// Done by codepoint check so no control characters appear in this source file.
function sanitizeUsername(raw) {
  if (typeof raw !== 'string') return null;
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (code < 32 || code === 127) continue;
    out += ch;
  }
  // Cap by codepoint (not UTF-16 unit) so astral-plane chars can't overflow the limit.
  const cleaned = [...out.replace(/\s+/g, ' ').trim()].slice(0, USERNAME_MAX).join('');
  return cleaned.length ? cleaned : null;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

async function handleSubmit(request, env, origin) {
  const parsed = await readJsonBody(request, MAX_SUBMIT_BODY_BYTES);
  if (parsed.error) return json({ ok: false, error: parsed.error }, parsed.status, origin);
  const body = parsed.body;

  const username = sanitizeUsername(body.username);
  if (!username) return json({ ok: false, error: `A name is required (1-${USERNAME_MAX} characters).` }, 400, origin);

  const minTime = Number(body.minTime);
  const maxTime = Number(body.maxTime);
  if (!Number.isFinite(minTime) || !Number.isFinite(maxTime))
    return json({ ok: false, error: 'min/max time must be numbers.' }, 400, origin);
  if (minTime < 0 || maxTime < minTime)
    return json({ ok: false, error: 'Require 0 <= minTime <= maxTime.' }, 400, origin);
  if (maxTime > MAX_HORIZON_MINUTES)
    return json({ ok: false, error: `Prediction is too far out (max ${MAX_HORIZON_MINUTES} min).` }, 400, origin);

  const telescope = ALLOWED_TELESCOPES.includes(body.telescopeType) ? body.telescopeType : null;
  const roundedMin = Math.round(minTime * 10) / 10;
  const roundedMax = Math.round(maxTime * 10) / 10;

  const now = Date.now();
  const hint = await clientHint(request, env);

  // Cooldown: reject rapid resubmits from the same client.
  const last = await env.DB
    .prepare('SELECT submitted_at FROM predictions WHERE client_hint = ? ORDER BY submitted_at DESC LIMIT 1')
    .bind(hint)
    .first();
  if (last && now - last.submitted_at < COOLDOWN_MS) {
    const retryAfter = Math.ceil((COOLDOWN_MS - (now - last.submitted_at)) / 1000);
    return json(
      { ok: false, error: 'Please wait a few seconds before resubmitting.' },
      429,
      origin,
      { 'Retry-After': String(retryAfter) }
    );
  }

  const absMin = now + roundedMin * 60000;
  const absMax = now + roundedMax * 60000;
  const id = crypto.randomUUID();

  // Upsert: one active prediction per client. UNIQUE(client_hint) makes "one row per
  // client" a schema invariant; a resubmit overwrites the prior row. Also self-clean
  // stale rows on the write path (the Cron Trigger covers quiet boards with no writes).
  await env.DB.batch([
    env.DB.prepare('DELETE FROM predictions WHERE submitted_at < ?').bind(now - HARD_TTL_MS),
    env.DB
      .prepare(
        `INSERT INTO predictions (id, username, min_time, max_time, telescope, submitted_at, abs_min, abs_max, client_hint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(client_hint) DO UPDATE SET
           id = excluded.id, username = excluded.username, min_time = excluded.min_time,
           max_time = excluded.max_time, telescope = excluded.telescope,
           submitted_at = excluded.submitted_at, abs_min = excluded.abs_min, abs_max = excluded.abs_max`
      )
      .bind(id, username, roundedMin, roundedMax, telescope, now, absMin, absMax, hint),
  ]);

  return json({ ok: true }, 200, origin);
}

async function handleData(request, env, origin) {
  const now = Date.now();
  const { results } = await env.DB
    .prepare(
      'SELECT username, min_time, max_time, telescope, submitted_at, abs_min, abs_max FROM predictions WHERE submitted_at >= ? ORDER BY submitted_at DESC'
    )
    .bind(now - HARD_TTL_MS)
    .all();
  const rows = results || [];

  // Aggregate the median absolute window over NON-EXPIRED submissions, with IQR outlier rejection.
  const live = rows.filter((r) => r.abs_max >= now);
  let considered = live;
  if (live.length >= 4) {
    const mids = live.map((r) => (r.abs_min + r.abs_max) / 2).sort((a, b) => a - b);
    const q1 = quantile(mids, 0.25);
    const q3 = quantile(mids, 0.75);
    const iqr = q3 - q1;
    // Floor the fence at MIN_IQR_BAND_MS so tight agreement doesn't reject honest,
    // near-agreeing submissions (a degenerate IQR≈0 would otherwise discard them).
    const band = Math.max(1.5 * iqr, MIN_IQR_BAND_MS);
    const lo = q1 - band;
    const hi = q3 + band;
    considered = live.filter((r) => {
      const m = (r.abs_min + r.abs_max) / 2;
      return m >= lo && m <= hi;
    });
  }

  let absMin = null;
  let absMax = null;
  if (considered.length) {
    absMin = median(considered.map((r) => r.abs_min));
    absMax = median(considered.map((r) => r.abs_max));
    if (absMin > absMax) {
      const mid = (absMin + absMax) / 2; // safety clamp (shouldn't happen for sane data)
      absMin = mid;
      absMax = mid;
    }
  }

  const submissions = rows.slice(0, LIST_CAP).map((r) => ({
    username: r.username,
    minTime: r.min_time,
    maxTime: r.max_time,
    telescopeType: r.telescope,
    submittedAt: r.submitted_at,
    expired: r.abs_max < now,
  }));

  return json(
    {
      schemaVersion: 2,
      absMin,
      absMax,
      method: 'median',
      sampleCount: considered.length,
      rejectedCount: live.length - considered.length,
      computedAt: now,
      submissions,
    },
    200,
    origin
  );
}

export default {
  // Cron Trigger (see wrangler.toml [triggers]) — removes stale rows even on quiet
  // boards where no POST happens to trigger the write-path cleanup.
  async scheduled(event, env) {
    await env.DB
      .prepare('DELETE FROM predictions WHERE submitted_at < ?')
      .bind(Date.now() - HARD_TTL_MS)
      .run();
  },

  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (request.method === 'POST' && url.pathname === '/submit')
      return handleSubmit(request, env, origin);

    if (request.method === 'GET' && url.pathname === '/data')
      return handleData(request, env, origin);

    if (request.method === 'GET' && url.pathname === '/')
      return new Response('Shooting Star community timer worker is running.', {
        status: 200,
        headers: corsHeaders(origin),
      });

    return json({ ok: false, error: 'Not found.' }, 404, origin);
  },
};
