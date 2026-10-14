const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-history-'));
process.env.HISTORY_MAX_VERSIONS = '3';
const app = require('../src/server');

let server;
let base;
const cookies = {};
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const username of ['writer', 'partner']) {
    const res = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'correct horse' }),
    });
    cookies[username] = res.headers.get('set-cookie').split(';')[0];
  }
});
after(() => server.close());

const as = (who) => async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json', cookie: cookies[who] } : { cookie: cookies[who] },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const call = as('writer');

async function setup(title) {
  const { body: b } = await call('POST', '/api/bibles', { title });
  const sid = b.sections[0].id;
  const { body: page } = await call('POST', `/api/bibles/${b.id}/sections/${sid}/pages`, { title: 'Ana' });
  return { b, sid, page };
}

test('edits keep earlier versions, without one per keystroke', async () => {
  const { b, page } = await setup('Versions');
  const url = `/api/bibles/${b.id}/pages/${page.id}`;
  await call('PATCH', url, { content: '<p>First draft</p>' });
  await call('PATCH', url, { content: '<p>First draft, more</p>' });
  await call('PATCH', url, { content: '<p>First draft, more still</p>' });
  const { body: versions } = await call('GET', `${url}/versions`);
  assert.strictEqual(versions.length, 1, 'quick saves share one version');
  const { body: v } = await call('GET', `${url}/versions/${versions[0].id}`);
  assert.match(v.content, /Backstory/, 'the version is the page as it was before the edits');
});

test('a different person editing keeps the previous writer\'s version', async () => {
  const { b, page } = await setup('Handoff');
  await call('POST', `/api/bibles/${b.id}/sharing`, { username: 'partner' });
  const url = `/api/bibles/${b.id}/pages/${page.id}`;
  await call('PATCH', url, { content: '<p>Mine</p>' });
  await as('partner')('PATCH', url, { content: '<p>Theirs</p>' });
  const { body: versions } = await call('GET', `${url}/versions`);
  assert.strictEqual(versions.length, 2);
  const { body: newest } = await call('GET', `${url}/versions/${versions[0].id}`);
  assert.strictEqual(newest.content, '<p>Mine</p>');
  assert.strictEqual(newest.by, 'writer');
});

test('restoring a version brings it back and keeps the current text as a version', async () => {
  const { b, page } = await setup('Restore');
  const url = `/api/bibles/${b.id}/pages/${page.id}`;
  await call('PATCH', url, { content: '<p>Later text</p>', title: 'Ana Reyes' });
  const { body: [original] } = await call('GET', `${url}/versions`);
  const { status, body: restored } = await call('POST', `${url}/versions/${original.id}/restore`);
  assert.strictEqual(status, 200);
  assert.strictEqual(restored.title, 'Ana');
  assert.match(restored.content, /Backstory/);
  assert.ok(restored.rev > 1, 'open editors see the restore as a new revision');
  const { body: versions } = await call('GET', `${url}/versions`);
  const { body: kept } = await call('GET', `${url}/versions/${versions[0].id}`);
  assert.strictEqual(kept.content, '<p>Later text</p>');
});

test('versions are capped per page', async () => {
  const { b, page } = await setup('Cap');
  await call('POST', `/api/bibles/${b.id}/sharing`, { username: 'partner' });
  const url = `/api/bibles/${b.id}/pages/${page.id}`;
  // Alternating writers forces a new version on every save.
  for (let i = 0; i < 6; i++) await as(i % 2 ? 'partner' : 'writer')('PATCH', url, { content: `<p>Draft ${i}</p>` });
  const { body: versions } = await call('GET', `${url}/versions`);
  assert.strictEqual(versions.length, 3);
  const { body: newest } = await call('GET', `${url}/versions/${versions[0].id}`);
  assert.strictEqual(newest.content, '<p>Draft 4</p>');
});

test('deleted pages go to the trash and can be restored with their relationships', async () => {
  const { b, sid, page } = await setup('Trash');
  const { body: ben } = await call('POST', `/api/bibles/${b.id}/sections/${sid}/pages`, { title: 'Ben' });
  await call('POST', `/api/bibles/${b.id}/relationships`, { from: page.id, to: ben.id, label: 'Siblings', type: 'family' });
  await call('POST', `/api/bibles/${b.id}/sections/${sid}/pages`, { title: 'Cy' });

  assert.strictEqual((await call('DELETE', `/api/bibles/${b.id}/pages/${page.id}`)).status, 204);
  let { body: full } = await call('GET', `/api/bibles/${b.id}`);
  assert.deepStrictEqual(full.sections[0].pages.map((p) => p.title), ['Ben', 'Cy']);
  assert.strictEqual(full.relmap.relationships.length, 0);

  const { body: trash } = await call('GET', `/api/bibles/${b.id}/trash`);
  assert.strictEqual(trash.length, 1);
  assert.strictEqual(trash[0].title, 'Ana');
  assert.strictEqual(trash[0].deletedBy, 'writer');

  const { status, body: restored } = await call('POST', `/api/bibles/${b.id}/trash/${page.id}/restore`);
  assert.strictEqual(status, 200);
  assert.strictEqual(restored.sectionId, sid);
  ({ body: full } = await call('GET', `/api/bibles/${b.id}`));
  assert.deepStrictEqual(full.sections[0].pages.map((p) => p.title), ['Ana', 'Ben', 'Cy'], 'back in its old place');
  assert.strictEqual(full.relmap.relationships[0].label, 'Siblings');
  assert.strictEqual((await call('GET', `/api/bibles/${b.id}/trash`)).body.length, 0);
});

test('deleting a section trashes its pages, and restoring one brings the section back', async () => {
  const { b } = await setup('Sections');
  const { body: eps } = await call('POST', `/api/bibles/${b.id}/sections`, { name: 'Episodes' });
  const { body: pilot } = await call('POST', `/api/bibles/${b.id}/sections/${eps.id}/pages`, { title: 'Pilot' });
  await call('DELETE', `/api/bibles/${b.id}/sections/${eps.id}`);
  const { body: trash } = await call('GET', `/api/bibles/${b.id}/trash`);
  assert.deepStrictEqual(trash.map((e) => [e.title, e.sectionName, e.sectionExists]), [['Pilot', 'Episodes', false]]);
  await call('POST', `/api/bibles/${b.id}/trash/${pilot.id}/restore`);
  const { body: full } = await call('GET', `/api/bibles/${b.id}`);
  const back = full.sections.find((s) => s.name === 'Episodes');
  assert.ok(back, 'section recreated');
  assert.strictEqual(back.kind, eps.kind);
  assert.strictEqual(back.pages[0].id, pilot.id, 'same page id, so links to it work again');
});

test('pages can be removed from the trash for good', async () => {
  const { b, sid, page } = await setup('Purge');
  const { body: other } = await call('POST', `/api/bibles/${b.id}/sections/${sid}/pages`, { title: 'Ben' });
  await call('PATCH', `/api/bibles/${b.id}/pages/${page.id}`, { content: '<p>Text</p>' });
  await call('DELETE', `/api/bibles/${b.id}/pages/${page.id}`);
  await call('DELETE', `/api/bibles/${b.id}/pages/${other.id}`);
  const historyFile = path.join(process.env.DATA_DIR, 'history', b.id, `${page.id}.json`);
  assert.ok(fs.existsSync(historyFile));
  assert.strictEqual((await call('DELETE', `/api/bibles/${b.id}/trash/${page.id}`)).status, 204);
  assert.ok(!fs.existsSync(historyFile), 'its history goes with it');
  assert.strictEqual((await call('POST', `/api/bibles/${b.id}/trash/${page.id}/restore`)).status, 404);
  assert.strictEqual((await call('DELETE', `/api/bibles/${b.id}/trash`)).status, 204);
  assert.strictEqual((await call('GET', `/api/bibles/${b.id}/trash`)).body.length, 0);
});

test('old trash is cleared automatically and deleting a bible removes its history', async () => {
  const { b, page } = await setup('Expiry');
  await call('PATCH', `/api/bibles/${b.id}/pages/${page.id}`, { content: '<p>Text</p>' });
  await call('DELETE', `/api/bibles/${b.id}/pages/${page.id}`);
  const trashFile = path.join(process.env.DATA_DIR, 'trash', `${b.id}.json`);
  const entries = JSON.parse(fs.readFileSync(trashFile, 'utf8'));
  entries[0].deletedAt = new Date(Date.now() - 31 * 864e5).toISOString();
  fs.writeFileSync(trashFile, JSON.stringify(entries));
  assert.strictEqual((await call('GET', `/api/bibles/${b.id}/trash`)).body.length, 0);

  const { b: b2, page: p2 } = await setup('Doomed');
  await call('PATCH', `/api/bibles/${b2.id}/pages/${p2.id}`, { content: '<p>Text</p>' });
  await call('DELETE', `/api/bibles/${b2.id}/pages/${p2.id}`);
  await call('DELETE', `/api/bibles/${b2.id}`);
  assert.ok(!fs.existsSync(path.join(process.env.DATA_DIR, 'history', b2.id)));
  assert.ok(!fs.existsSync(path.join(process.env.DATA_DIR, 'trash', `${b2.id}.json`)));
});

test('history and trash follow bible access rules', async () => {
  const { b, page } = await setup('Private');
  const stranger = as('partner');
  assert.strictEqual((await stranger('GET', `/api/bibles/${b.id}/pages/${page.id}/versions`)).status, 404);
  assert.strictEqual((await stranger('GET', `/api/bibles/${b.id}/trash`)).status, 404);
});

test('a relationship survives when both characters are deleted and restored one at a time', async () => {
  const { b, sid, page } = await setup('Pair');
  const { body: ben } = await call('POST', `/api/bibles/${b.id}/sections/${sid}/pages`, { title: 'Ben' });
  await call('POST', `/api/bibles/${b.id}/relationships`, { from: page.id, to: ben.id, label: 'Siblings', type: 'family' });
  await call('DELETE', `/api/bibles/${b.id}/pages/${page.id}`);
  await call('DELETE', `/api/bibles/${b.id}/pages/${ben.id}`);
  await call('POST', `/api/bibles/${b.id}/trash/${page.id}/restore`);
  await call('POST', `/api/bibles/${b.id}/trash/${ben.id}/restore`);
  const { body: full } = await call('GET', `/api/bibles/${b.id}`);
  assert.deepStrictEqual(full.relmap.relationships.map((r) => r.label), ['Siblings']);
});

test('two people with the same display name still count as a handoff', async () => {
  const { b, page } = await setup('Namesakes');
  await call('POST', `/api/bibles/${b.id}/sharing`, { username: 'partner' });
  // Give both accounts the same display name.
  const users = path.join(process.env.DATA_DIR, 'users.json');
  const data = JSON.parse(fs.readFileSync(users, 'utf8'));
  for (const u of data) u.displayName = 'Sam';
  fs.writeFileSync(users, JSON.stringify(data));
  const url = `/api/bibles/${b.id}/pages/${page.id}`;
  await call('PATCH', url, { content: '<p>Mine</p>' });
  await as('partner')('PATCH', url, { content: '<p>Theirs</p>' });
  const { body: versions } = await call('GET', `${url}/versions`);
  assert.strictEqual(versions.length, 2);
});
