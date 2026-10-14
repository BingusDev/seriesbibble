const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-collab-'));
// A bible written before accounts existed.
fs.mkdirSync(path.join(process.env.DATA_DIR, 'bibles'), { recursive: true });
fs.writeFileSync(
  path.join(process.env.DATA_DIR, 'bibles', 'aaaaaaaaaaaa.json'),
  JSON.stringify({ id: 'aaaaaaaaaaaa', title: 'Old Show', logline: '', updatedAt: '2026-01-01T00:00:00Z', sections: [] })
);
const app = require('../src/server');

let server;
let base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// A tiny client that keeps its own session cookie.
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
}

const ana = client();
const ben = client();
const cat = client();

test('the API needs a signed-in user', async () => {
  const anon = client();
  assert.strictEqual((await anon('GET', '/api/bibles')).status, 401);
  assert.strictEqual((await anon('GET', '/api/health')).status, 200);
  assert.deepStrictEqual((await anon('GET', '/api/auth/state')).body, { user: null, signupOpen: true, firstRun: true });
});

test('accounts: register, sign out, sign in, bad passwords', async () => {
  assert.strictEqual((await ana('POST', '/api/auth/register', { username: 'x', password: 'longenough' })).status, 400);
  assert.strictEqual((await ana('POST', '/api/auth/register', { username: 'ana', password: 'short' })).status, 400);
  const reg = await ana('POST', '/api/auth/register', { username: 'Ana', password: 'ana-password', displayName: 'Ana R.' });
  assert.strictEqual(reg.status, 201);
  assert.strictEqual(reg.body.user.username, 'ana');
  assert.strictEqual((await ben('POST', '/api/auth/register', { username: 'ana', password: 'whatever123' })).status, 409);
  assert.strictEqual((await ben('POST', '/api/auth/register', { username: 'ben', password: 'ben-password' })).status, 201);
  assert.strictEqual((await cat('POST', '/api/auth/register', { username: 'cat', password: 'cat-password' })).status, 201);

  assert.strictEqual((await ana('POST', '/api/auth/logout')).status, 204);
  assert.strictEqual((await ana('GET', '/api/bibles')).status, 401);
  assert.strictEqual((await ana('POST', '/api/auth/login', { username: 'ana', password: 'nope-nope' })).status, 401);
  assert.strictEqual((await ana('POST', '/api/auth/login', { username: 'ANA', password: 'ana-password' })).status, 200);
  assert.strictEqual((await ana('GET', '/api/auth/state')).body.user.displayName, 'Ana R.');

  const users = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'users.json'), 'utf8'));
  assert.ok(!JSON.stringify(users).includes('ana-password'), 'passwords are not stored in plain text');
});

test('existing bibles go to the first account', async () => {
  assert.ok((await ana('GET', '/api/bibles')).body.some((b) => b.id === 'aaaaaaaaaaaa' && b.role === 'owner'));
  assert.ok(!(await ben('GET', '/api/bibles')).body.some((b) => b.id === 'aaaaaaaaaaaa'));
});

test('bibles are private until shared, and only the owner can delete', async () => {
  const { body: b } = await ana('POST', '/api/bibles', { title: 'Shared Show' });
  assert.strictEqual((await ben('GET', `/api/bibles/${b.id}`)).status, 404);
  assert.strictEqual((await ben('GET', `/api/bibles/${b.id}/export.json`)).status, 404);
  assert.strictEqual((await ben('POST', `/api/bibles/${b.id}/sharing`, { username: 'ben' })).status, 404);

  assert.strictEqual((await ana('POST', `/api/bibles/${b.id}/sharing`, { username: 'nobody' })).status, 404);
  const shared = await ana('POST', `/api/bibles/${b.id}/sharing`, { username: 'ben' });
  assert.strictEqual(shared.status, 201);
  assert.deepStrictEqual(shared.body.collaborators.map((u) => u.username), ['ben']);

  const list = (await ben('GET', '/api/bibles')).body;
  assert.deepStrictEqual(list.find((x) => x.id === b.id).role, 'editor');
  assert.strictEqual((await ben('POST', `/api/bibles/${b.id}/sections`, { name: 'Episodes' })).status, 201);
  assert.strictEqual((await ben('POST', `/api/bibles/${b.id}/sharing`, { username: 'cat' })).status, 403);
  assert.strictEqual((await ben('DELETE', `/api/bibles/${b.id}`)).status, 403);
  assert.strictEqual((await cat('GET', `/api/bibles/${b.id}`)).status, 404);

  // Ben leaves; Ana deletes.
  const { body: me } = await ben('GET', '/api/auth/state');
  assert.strictEqual((await ben('DELETE', `/api/bibles/${b.id}/sharing/${me.user.id}`)).status, 200);
  assert.strictEqual((await ben('GET', `/api/bibles/${b.id}`)).status, 404);
  assert.strictEqual((await ana('DELETE', `/api/bibles/${b.id}`)).status, 204);
});

test('a stale save is refused instead of overwriting someone else', async () => {
  const { body: b } = await ana('POST', '/api/bibles', { title: 'Race' });
  await ana('POST', `/api/bibles/${b.id}/sharing`, { username: 'ben' });
  const { body: page } = await ana('POST', `/api/bibles/${b.id}/sections/${b.sections[0].id}/pages`, { title: 'Hero' });
  assert.strictEqual(page.rev, undefined);

  const first = await ana('PATCH', `/api/bibles/${b.id}/pages/${page.id}`, { content: '<p>Ana</p>', baseRev: 0 });
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.rev, 1);
  assert.strictEqual(first.body.updatedBy, 'Ana R.');

  const stale = await ben('PATCH', `/api/bibles/${b.id}/pages/${page.id}`, { content: '<p>Ben</p>', baseRev: 0 });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.body.page.content, '<p>Ana</p>');

  const ok = await ben('PATCH', `/api/bibles/${b.id}/pages/${page.id}`, { content: '<p>Ben</p>', baseRev: 1 });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.rev, 2);

  // Moving a page is not a text edit and never conflicts.
  assert.strictEqual((await ana('PATCH', `/api/bibles/${b.id}/pages/${page.id}`, { position: 0, baseRev: 0 })).status, 200);

  const act = await ana('GET', `/api/bibles/${b.id}/activity?page=${page.id}`);
  assert.deepStrictEqual(act.body.pages[page.id], { rev: 2, updatedBy: 'ben' });
  const seen = await ben('GET', `/api/bibles/${b.id}/activity`);
  assert.deepStrictEqual(seen.body.viewers.map((v) => [v.username, v.pageId]), [['ana', page.id]]);
});

test('changing a password ends old sessions', async () => {
  const other = client();
  await other('POST', '/api/auth/login', { username: 'cat', password: 'cat-password' });
  assert.strictEqual((await cat('POST', '/api/auth/password', { current: 'wrong', password: 'new-cat-password' })).status, 403);
  assert.strictEqual((await cat('POST', '/api/auth/password', { current: 'cat-password', password: 'new-cat-password' })).status, 204);
  assert.strictEqual((await other('GET', '/api/bibles')).status, 401);
  assert.strictEqual((await cat('GET', '/api/bibles')).status, 200, 'the device that changed it stays signed in');
});

test('repeated wrong passwords lock that username for a while, whatever address is claimed', async () => {
  const guess = client();
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.0.${i}` },
      body: JSON.stringify({ username: 'ben', password: `guess-${i}` }),
    });
    assert.strictEqual(res.status, 401);
  }
  assert.strictEqual((await guess('POST', '/api/auth/login', { username: 'ben', password: 'ben-password' })).status, 429);
  assert.strictEqual((await guess('POST', '/api/auth/login', { username: 'ana', password: 'ana-password' })).status, 200);
});
