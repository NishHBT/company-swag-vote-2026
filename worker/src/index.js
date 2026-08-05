/**
 * Company Swag Vote 2026 — voting API (Cloudflare Worker + D1).
 *
 * Routes
 *   OPTIONS *                 CORS preflight
 *   POST    /votes            accept one anonymous ballot per browser id
 *   GET     /admin/export.csv Excel-ready CSV export (ADMIN_TOKEN header)
 *   GET     /health           liveness probe
 *
 * Bindings (see wrangler.toml.example)
 *   DB              D1 database binding
 *   ALLOWED_ORIGIN  comma-separated list of allowed browser origins
 *   ADMIN_TOKEN     secret; required in the X-Admin-Token request header
 */

import { CATALOG_BY_ID, VOTE_VALUES } from './catalog.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_FEEDBACK_CHARS = 1200;

/* ------------------------------------------------------------------- CORS */

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = allowedOrigins(env);
  const headers = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && allowed.includes(origin.replace(/\/+$/, ''))) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function json(body, status, request, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(request, env),
    },
  });
}

/* -------------------------------------------------------------- utilities */

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a || ''));
  const y = enc.encode(String(b || ''));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Validate the posted ballot against the server-side catalog copy. */
function validateBallot(payload) {
  if (!payload || typeof payload !== 'object') return { error: 'body must be a JSON object' };

  const browserId = payload.browserId;
  if (typeof browserId !== 'string' || browserId.length < 8 || browserId.length > 128) {
    return { error: 'browserId must be a string of 8-128 characters' };
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(browserId)) {
    return { error: 'browserId contains unsupported characters' };
  }

  const votes = payload.votes;
  if (!Array.isArray(votes) || votes.length === 0) {
    return { error: 'votes must be a non-empty array' };
  }
  if (votes.length > CATALOG_BY_ID.size) {
    return { error: `votes may not exceed ${CATALOG_BY_ID.size} entries` };
  }

  const seen = new Set();
  const clean = [];
  for (const entry of votes) {
    if (!entry || typeof entry !== 'object') return { error: 'each vote must be an object' };
    const { productId, vote } = entry;
    if (!CATALOG_BY_ID.has(productId)) return { error: `unknown productId: ${String(productId)}` };
    if (!VOTE_VALUES.includes(vote)) return { error: `unknown vote value: ${String(vote)}` };
    if (seen.has(productId)) return { error: `duplicate productId: ${productId}` };
    seen.add(productId);
    clean.push({ productId, vote });
  }

  let feedback = null;
  if (payload.feedback !== undefined && payload.feedback !== null) {
    if (typeof payload.feedback !== 'string') {
      return { error: 'feedback must be a text value' };
    }
    feedback = payload.feedback.trim();
    if (feedback.length > MAX_FEEDBACK_CHARS) {
      return { error: `feedback may not exceed ${MAX_FEEDBACK_CHARS} characters` };
    }
    if (!feedback) feedback = null;
  }

  return { browserId, votes: clean, feedback };
}

/* ----------------------------------------------------------------- routes */

async function postVotes(request, env) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('application/json')) {
    return json({ accepted: false, error: 'Content-Type must be application/json' }, 415, request, env);
  }
  if (!corsHeaders(request, env)['Access-Control-Allow-Origin']) {
    return json({ accepted: false, error: 'origin not allowed' }, 403, request, env);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json({ accepted: false, error: 'payload too large' }, 413, request, env);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    return json({ accepted: false, error: 'invalid JSON' }, 400, request, env);
  }

  const parsed = validateBallot(payload);
  if (parsed.error) {
    return json({ accepted: false, error: parsed.error }, 400, request, env);
  }

  const existing = await env.DB.prepare(
    'SELECT id, (SELECT COUNT(*) FROM votes WHERE ballot_id = ballots.id) AS n FROM ballots WHERE browser_id = ?'
  )
    .bind(parsed.browserId)
    .first();

  if (existing) {
    return json(
      { accepted: false, error: 'already_voted', ballotId: existing.id, recorded: existing.n },
      409,
      request,
      env
    );
  }

  const ballotId = crypto.randomUUID();
  const submittedUtc = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const statements = [
    env.DB
      .prepare('INSERT INTO ballots (id, browser_id, submitted_utc, feedback) VALUES (?, ?, ?, ?)')
      .bind(
      ballotId,
      parsed.browserId,
      submittedUtc,
      parsed.feedback
    ),
    ...parsed.votes.map((v) =>
      env.DB.prepare('INSERT INTO votes (ballot_id, product_id, vote) VALUES (?, ?, ?)').bind(
        ballotId,
        v.productId,
        v.vote
      )
    ),
  ];

  try {
    await env.DB.batch(statements);
  } catch (err) {
    const message = String((err && err.message) || err);
    // The UNIQUE constraint on ballots.browser_id is the authoritative guard
    // against a double submission racing two requests at once.
    if (/UNIQUE|constraint/i.test(message)) {
      return json({ accepted: false, error: 'already_voted' }, 409, request, env);
    }
    return json({ accepted: false, error: 'storage failure' }, 500, request, env);
  }

  return json(
    { accepted: true, ballotId, recorded: parsed.votes.length, submittedUtc },
    201,
    request,
    env
  );
}

async function exportCsv(request, env) {
  const token = request.headers.get('X-Admin-Token');
  if (!env.ADMIN_TOKEN || !timingSafeEqual(token, env.ADMIN_TOKEN)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...corsHeaders(request, env),
      },
    });
  }

  const { results } = await env.DB.prepare(
    `SELECT v.ballot_id AS ballot_id,
            b.submitted_utc AS submitted_utc,
            v.product_id AS product_id,
            v.vote AS vote,
            b.feedback AS feedback
       FROM votes v
       JOIN ballots b ON b.id = v.ballot_id
      ORDER BY b.submitted_utc ASC, v.ballot_id ASC, v.product_id ASC`
  ).all();

  const header = [
    'ballot_id',
    'submitted_utc',
    'product_id',
    'product_name',
    'category',
    'price',
    'vote',
    'feedback',
  ];

  const lines = [header.join(',')];
  for (const row of results || []) {
    const product = CATALOG_BY_ID.get(row.product_id) || {};
    lines.push(
      [
        row.ballot_id,
        row.submitted_utc,
        row.product_id,
        product.name || '',
        product.category || '',
        product.price === undefined || product.price === null ? '' : product.price,
        row.vote,
        row.feedback || '',
      ]
        .map(csvCell)
        .join(',')
    );
  }

  const stamp = new Date().toISOString().slice(0, 10);
  // UTF-8 BOM so Excel opens accented product names correctly on double-click.
  const body = '\uFEFF' + lines.join('\r\n') + '\r\n';

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="swag-vote-2026-votes-${stamp}.csv"`,
      'Cache-Control': 'no-store',
      ...corsHeaders(request, env),
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, products: CATALOG_BY_ID.size }, 200, request, env);
    }

    if (request.method === 'POST' && url.pathname === '/votes') {
      return postVotes(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/admin/export.csv') {
      return exportCsv(request, env);
    }

    return json({ error: 'not found' }, 404, request, env);
  },
};
