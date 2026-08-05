/**
 * Dependency-free smoke test for the Worker's request handling.
 *
 * It exercises the real `src/index.js` fetch handler against a small in-memory
 * stand-in for the D1 binding that mirrors the statements the Worker issues and
 * the UNIQUE constraints declared in schema.sql. This is not a substitute for
 * `wrangler dev` against real D1 — it is a fast guard against regressions in
 * routing, CORS, validation, one-ballot enforcement, and CSV shape.
 *
 * Run: node test/smoke.test.mjs
 */
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const ORIGIN = 'https://example-org.github.io';
const ADMIN_TOKEN = 'test-token-not-a-secret';

function makeDB() {
  const ballots = [];
  const votes = [];

  function exec(sql, args) {
    if (sql.includes('FROM ballots WHERE browser_id')) {
      const b = ballots.find((x) => x.browser_id === args[0]);
      return b ? { id: b.id, n: votes.filter((v) => v.ballot_id === b.id).length } : null;
    }
    if (sql.startsWith('INSERT INTO ballots')) {
      if (ballots.some((x) => x.browser_id === args[1])) {
        throw new Error('UNIQUE constraint failed: ballots.browser_id');
      }
      ballots.push({ id: args[0], browser_id: args[1], submitted_utc: args[2], feedback: args[3] });
      return null;
    }
    if (sql.startsWith('INSERT INTO votes')) {
      if (votes.some((v) => v.ballot_id === args[0] && v.product_id === args[1])) {
        throw new Error('UNIQUE constraint failed: votes.ballot_id, votes.product_id');
      }
      votes.push({ ballot_id: args[0], product_id: args[1], vote: args[2] });
      return null;
    }
    if (sql.includes('SELECT v.ballot_id')) {
      const rows = votes.map((v) => ({
        ballot_id: v.ballot_id,
        submitted_utc: (ballots.find((b) => b.id === v.ballot_id) || {}).submitted_utc,
        product_id: v.product_id,
        vote: v.vote,
        feedback: (ballots.find((b) => b.id === v.ballot_id) || {}).feedback,
      }));
      return { results: rows };
    }
    throw new Error('unexpected SQL: ' + sql);
  }

  return {
    prepare(sql) {
      let bound = [];
      const stmt = {
        bind(...args) {
          bound = args;
          return stmt;
        },
        async first() {
          return exec(sql, bound);
        },
        async all() {
          return exec(sql, bound);
        },
        _run() {
          return exec(sql, bound);
        },
      };
      return stmt;
    },
    async batch(stmts) {
      for (const s of stmts) s._run();
      return stmts.map(() => ({ success: true }));
    },
  };
}

const env = { DB: makeDB(), ALLOWED_ORIGIN: ORIGIN, ADMIN_TOKEN };

function post(body, origin = ORIGIN) {
  return new Request('https://api.test/votes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  });
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['pass', name]);
  } catch (err) {
    results.push(['FAIL', name + ' — ' + err.message]);
  }
}

await check('health reports the server catalog size', async () => {
  const res = await worker.fetch(new Request('https://api.test/health'), env);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.products, 60);
});

await check('preflight returns 204 with CORS headers for the allowed origin', async () => {
  const res = await worker.fetch(
    new Request('https://api.test/votes', { method: 'OPTIONS', headers: { Origin: ORIGIN } }),
    env
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

await check('rejects a disallowed origin', async () => {
  const res = await worker.fetch(post({ browserId: 'browser-aaaa1111', votes: [{ productId: 'P01', vote: 'Love' }] }, 'https://evil.test'), env);
  assert.equal(res.status, 403);
});

await check('rejects an unknown product id', async () => {
  const res = await worker.fetch(post({ browserId: 'browser-aaaa1111', votes: [{ productId: 'P99', vote: 'Love' }] }), env);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown productId/);
});

await check('rejects an unknown vote value', async () => {
  const res = await worker.fetch(post({ browserId: 'browser-aaaa1111', votes: [{ productId: 'P01', vote: 'Meh' }] }), env);
  assert.equal(res.status, 400);
});

await check('rejects a short browser id and an empty ballot', async () => {
  assert.equal((await worker.fetch(post({ browserId: 'short', votes: [{ productId: 'P01', vote: 'Love' }] }), env)).status, 400);
  assert.equal((await worker.fetch(post({ browserId: 'browser-aaaa1111', votes: [] }), env)).status, 400);
});

await check('accepts a valid ballot once', async () => {
  const res = await worker.fetch(
    post({
      browserId: 'browser-aaaa1111',
      votes: [
        { productId: 'P01', vote: 'Love' },
        { productId: 'P22', vote: 'Like' },
        { productId: 'P60', vote: "Don't Like" },
      ],
      feedback: 'Please consider a lanyard.',
    }),
    env
  );
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.accepted, true);
  assert.equal(body.recorded, 3);
});

await check('rejects a second ballot from the same browser id with 409', async () => {
  const res = await worker.fetch(post({ browserId: 'browser-aaaa1111', votes: [{ productId: 'P02', vote: 'Love' }] }), env);
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.equal(body.error, 'already_voted');
  assert.equal(body.recorded, 3);
});

await check('export requires the admin token', async () => {
  const res = await worker.fetch(new Request('https://api.test/admin/export.csv'), env);
  assert.equal(res.status, 401);
  const bad = await worker.fetch(
    new Request('https://api.test/admin/export.csv', { headers: { 'X-Admin-Token': 'wrong' } }),
    env
  );
  assert.equal(bad.status, 401);
});

await check('export returns one CSV row per product vote with the expected header', async () => {
  const res = await worker.fetch(
    new Request('https://api.test/admin/export.csv', { headers: { 'X-Admin-Token': ADMIN_TOKEN } }),
    env
  );
  assert.equal(res.status, 200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xef, 0xbb, 0xbf], 'expected a UTF-8 BOM for Excel');
  const text = new TextDecoder('utf-8').decode(bytes);
  const lines = text.replace(/^\uFEFF/, '').trim().split('\r\n');
  assert.equal(lines[0], 'ballot_id,submitted_utc,product_id,product_name,category,price,vote,feedback');
  assert.equal(lines.length, 4);
  assert.match(lines[1], /,P01,High-Capacity Travel Bag,Duffle Bags,50,Love,Please consider a lanyard\.$/);
  assert.match(lines[3], /,P60,.*,Women's Apparel,30,Don't Like,Please consider a lanyard\.$/);
  assert.match(res.headers.get('Content-Disposition'), /attachment; filename="swag-vote-2026-votes-/);
});

await check('unknown routes 404', async () => {
  const res = await worker.fetch(new Request('https://api.test/nope'), env);
  assert.equal(res.status, 404);
});

let failed = 0;
for (const [status, name] of results) {
  if (status === 'FAIL') failed += 1;
  console.log(`${status}  ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
