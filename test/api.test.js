const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-'));
const app = require('../src/server');
const { buildHtml } = require('../src/export');

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

test('new bible starts with Characters and World', async () => {
  const { status, body } = await call('POST', '/api/bibles', { title: 'Pilot' });
  assert.strictEqual(status, 201);
  assert.deepStrictEqual(body.sections.map((s) => s.name), ['Characters', 'World']);
});

test('sections and pages can be added, moved and deleted', async () => {
  const { body: b } = await call('POST', '/api/bibles', { title: 'Moves' });
  const { body: eps } = await call('POST', `/api/bibles/${b.id}/sections`, { name: 'Episodes' });
  const { body: p1 } = await call('POST', `/api/bibles/${b.id}/sections/${b.sections[0].id}/pages`, { title: 'Ana' });
  assert.match(p1.content, /Backstory/, 'character pages get the character template');
  await call('PATCH', `/api/bibles/${b.id}/pages/${p1.id}`, { sectionId: eps.id });
  let { body: full } = await call('GET', `/api/bibles/${b.id}`);
  assert.strictEqual(full.sections[0].pages.length, 0);
  assert.strictEqual(full.sections[2].pages[0].id, p1.id);
  await call('PATCH', `/api/bibles/${b.id}/sections/${eps.id}`, { position: 0 });
  await call('DELETE', `/api/bibles/${b.id}/pages/${p1.id}`);
  ({ body: full } = await call('GET', `/api/bibles/${b.id}`));
  assert.strictEqual(full.sections[0].name, 'Episodes');
  assert.strictEqual(full.sections[0].pages.length, 0);
});

test('unknown ids return 404', async () => {
  assert.strictEqual((await call('GET', '/api/bibles/..%2F..%2Fetc')).status, 404);
  assert.strictEqual((await call('GET', '/api/bibles/000000000000')).status, 404);
});

test('export turns in-app links into document anchors', async () => {
  const { body: b } = await call('POST', '/api/bibles', { title: 'Links' });
  const { body: a } = await call('POST', `/api/bibles/${b.id}/sections/${b.sections[0].id}/pages`, { title: 'A' });
  const { body: w } = await call('POST', `/api/bibles/${b.id}/sections/${b.sections[1].id}/pages`, { title: 'W' });
  await call('PATCH', `/api/bibles/${b.id}/pages/${a.id}`, {
    content: `<p>See <a href="#/b/${b.id}/p/${w.id}/h/key-locations">places</a></p>`,
  });
  const { body: full } = await call('GET', `/api/bibles/${b.id}`);
  const html = buildHtml(full);
  assert.ok(html.includes(`href="#p-${w.id}-key-locations"`));
  assert.ok(html.includes(`id="p-${w.id}-key-locations"`));
});

test('word export is a valid docx with internal links', async () => {
  const { body: b } = await call('POST', '/api/bibles', { title: 'Docx' });
  const res = await fetch(`${base}/api/bibles/${b.id}/export.docx`);
  assert.strictEqual(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.strictEqual(buf.subarray(0, 2).toString(), 'PK');
  const JSZip = require('jszip');
  const doc = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
  assert.match(doc, /w:hyperlink w:anchor="bm\d+"/);
  assert.match(doc, /w:bookmarkStart/);
  assert.doesNotMatch(doc, /\[\[BM:/);
});
