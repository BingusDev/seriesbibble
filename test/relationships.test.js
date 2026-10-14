const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-rel-test-'));
const app = require('../src/server');

let server;
let base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

async function bibleWithCharacters(...names) {
  const { body: b } = await call('POST', '/api/bibles', { title: 'Rels' });
  const pages = [];
  for (const title of names) {
    pages.push((await call('POST', `/api/bibles/${b.id}/sections/${b.sections[0].id}/pages`, { title })).body);
  }
  return { b, pages };
}

test('relationships can be added, edited and deleted', async () => {
  const { b, pages: [ana, ben] } = await bibleWithCharacters('Ana', 'Ben');
  assert.deepStrictEqual((await call('GET', `/api/bibles/${b.id}/relmap`)).body, { relationships: [], positions: {} });

  const { status, body: rel } = await call('POST', `/api/bibles/${b.id}/relationships`, {
    from: ben.id, to: ana.id, label: 'mentor of', type: 'work', mutual: false, note: 'Taught her to fly',
  });
  assert.strictEqual(status, 201);
  assert.strictEqual(rel.mutual, false);

  const { body: edited } = await call('PATCH', `/api/bibles/${b.id}/relationships/${rel.id}`, { type: 'rival', label: 'betrayed' });
  assert.strictEqual(edited.type, 'rival');
  assert.strictEqual(edited.from, ben.id, 'unchanged fields are kept');

  const { body: full } = await call('GET', `/api/bibles/${b.id}`);
  assert.strictEqual(full.relmap.relationships[0].label, 'betrayed');

  assert.strictEqual((await call('DELETE', `/api/bibles/${b.id}/relationships/${rel.id}`)).status, 204);
  assert.strictEqual((await call('GET', `/api/bibles/${b.id}/relmap`)).body.relationships.length, 0);
});

test('relationships must join two different existing pages', async () => {
  const { b, pages: [ana] } = await bibleWithCharacters('Ana');
  assert.strictEqual((await call('POST', `/api/bibles/${b.id}/relationships`, { from: ana.id, to: ana.id })).status, 400);
  assert.strictEqual((await call('POST', `/api/bibles/${b.id}/relationships`, { from: ana.id, to: 'nope' })).status, 400);
  const { body: rel } = await call('POST', `/api/bibles/${b.id}/relationships`, { from: ana.id, to: b.sections[0].id });
  assert.ok(rel.error, 'a section id is not a page');
});

test('unknown types fall back to other, and deleted pages drop their relationships', async () => {
  const { b, pages: [ana, ben] } = await bibleWithCharacters('Ana', 'Ben');
  const { body: rel } = await call('POST', `/api/bibles/${b.id}/relationships`, { from: ana.id, to: ben.id, type: 'frenemy' });
  assert.strictEqual(rel.type, 'other');
  assert.strictEqual(rel.mutual, true);
  await call('PUT', `/api/bibles/${b.id}/relmap/positions`, { positions: { [ben.id]: { x: 10.4, y: -3 } } });
  await call('DELETE', `/api/bibles/${b.id}/pages/${ben.id}`);
  const { body: full } = await call('GET', `/api/bibles/${b.id}`);
  assert.strictEqual(full.relmap.relationships.length, 0, 'deleting a page cleans up the saved file');
  assert.deepStrictEqual(full.relmap.positions, {});
});

test('map positions are saved, rounded, and can be reset', async () => {
  const { b, pages: [ana, ben] } = await bibleWithCharacters('Ana', 'Ben');
  let { body: map } = await call('PUT', `/api/bibles/${b.id}/relmap/positions`, {
    positions: { [ana.id]: { x: 12.6, y: 40 }, [ben.id]: { x: 'left', y: 0 }, bogus: { x: 1, y: 1 } },
  });
  assert.deepStrictEqual(map.positions, { [ana.id]: { x: 13, y: 40 } });
  ({ body: map } = await call('PUT', `/api/bibles/${b.id}/relmap/positions`, { reset: true }));
  assert.deepStrictEqual(map.positions, {});
});

test('deleting a section drops relationships to its pages', async () => {
  const { b, pages: [ana] } = await bibleWithCharacters('Ana');
  const { body: place } = await call('POST', `/api/bibles/${b.id}/sections/${b.sections[1].id}/pages`, { title: 'Harbor' });
  await call('POST', `/api/bibles/${b.id}/relationships`, { from: ana.id, to: place.id, label: 'lives at' });
  await call('DELETE', `/api/bibles/${b.id}/sections/${b.sections[1].id}`);
  const { body: full } = await call('GET', `/api/bibles/${b.id}`);
  assert.strictEqual(full.relmap.relationships.length, 0);
});
