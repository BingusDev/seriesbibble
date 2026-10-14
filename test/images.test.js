const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const JSZip = require('jszip');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-images-'));
const app = require('../src/server');
const store = require('../src/store');
const { buildHtml, loadAssets, toDocx } = require('../src/export');

let server;
let base;
const cookies = {};
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const username of ['writer', 'stranger']) {
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

const picture = (w, h, alpha = false) =>
  sharp({ create: { width: w, height: h, channels: alpha ? 4 : 3, background: alpha ? { r: 200, g: 40, b: 40, alpha: 0.5 } : { r: 40, g: 90, b: 160 } } })
    .png()
    .toBuffer();

async function upload(bid, buf, who = 'writer', type = 'image/png') {
  const res = await fetch(`${base}/api/bibles/${bid}/images`, { method: 'POST', headers: { 'Content-Type': type, cookie: cookies[who] }, body: buf });
  return { status: res.status, body: await res.json() };
}

async function setup(title) {
  const { body: b } = await call('POST', '/api/bibles', { title });
  const sid = b.sections[0].id;
  const { body: page } = await call('POST', `/api/bibles/${b.id}/sections/${sid}/pages`, { title: 'Ana' });
  return { b, sid, page };
}

const imageDir = (bid) => path.join(process.env.DATA_DIR, 'images', bid);

test('uploads are shrunk, kept as files and only shown to people who can open the bible', async () => {
  const { b } = await setup('Upload');
  const { status, body: img } = await upload(b.id, await picture(3000, 1500));
  assert.strictEqual(status, 201);
  assert.match(img.file, /^[a-f0-9]{12}\.jpg$/, 'pictures without transparency are stored as JPEG');
  assert.strictEqual(img.width, 2000);
  assert.strictEqual(img.height, 1000);
  assert.ok(fs.existsSync(path.join(imageDir(b.id), img.file)));

  const full = await fetch(base + img.url, { headers: { cookie: cookies.writer } });
  assert.strictEqual(full.status, 200);
  assert.strictEqual(full.headers.get('content-type'), 'image/jpeg');
  const small = await fetch(`${base}${img.url}?size=thumb`, { headers: { cookie: cookies.writer } });
  const meta = await sharp(Buffer.from(await small.arrayBuffer())).metadata();
  assert.ok(meta.width <= 320, 'the thumbnail is small');

  assert.strictEqual((await fetch(base + img.url, { headers: { cookie: cookies.stranger } })).status, 404);
  assert.strictEqual((await upload(b.id, await picture(10, 10), 'stranger')).status, 404);

  const { body: logo } = await upload(b.id, await picture(50, 50, true));
  assert.match(logo.file, /\.png$/, 'transparent pictures stay PNG');
});

test('files that are not pictures are refused', async () => {
  const { b } = await setup('Refuse');
  const { status, body } = await upload(b.id, Buffer.from('not a picture at all'), 'writer', 'image/png');
  assert.strictEqual(status, 400);
  assert.match(body.error, /not a picture/);
});

test('pictures pasted into a page as data URLs are saved as files, once', async () => {
  const { b, page } = await setup('Paste');
  const data = `data:image/png;base64,${(await picture(40, 30)).toString('base64')}`;
  const url = `/api/bibles/${b.id}/pages/${page.id}`;
  const { body: saved } = await call('PATCH', url, { content: `<p>Her house:</p><p><img src="${data}"></p>` });
  assert.doesNotMatch(saved.content, /data:image/);
  const m = saved.content.match(new RegExp(`/api/bibles/${b.id}/images/([a-f0-9]{12}\\.jpg)`));
  assert.ok(m, 'the page points at the stored file');
  const { body: again } = await call('PATCH', url, { content: `<p>Her house:</p><p><img src="${data}"></p><p>More.</p>` });
  assert.ok(again.content.includes(m[1]), 'the same picture sent again is the same file');
  assert.strictEqual(fs.readdirSync(imageDir(b.id)).filter((f) => /^[a-f0-9]{12}\.jpg$/.test(f)).length, 1);
});

test('a page can have a lead picture from its own bible', async () => {
  const { b, page } = await setup('Lead');
  const other = await setup('Other');
  const { body: img } = await upload(b.id, await picture(300, 400));
  const { body: foreign } = await upload(other.b.id, await picture(20, 20));
  const url = `/api/bibles/${b.id}/pages/${page.id}`;
  assert.strictEqual((await call('PATCH', url, { leadImage: foreign.file })).status, 400);
  assert.strictEqual((await call('PATCH', url, { leadImage: '../../users.json' })).status, 400);
  const { body: set } = await call('PATCH', url, { leadImage: img.file });
  assert.strictEqual(set.leadImage, img.file);
  const { body: cleared } = await call('PATCH', url, { leadImage: null });
  assert.strictEqual(cleared.leadImage, undefined);
});

test('trashed pages keep their pictures until the trash is emptied', async () => {
  const { b, page } = await setup('Trash');
  const { body: inline } = await upload(b.id, await picture(60, 60));
  const { body: lead } = await upload(b.id, await picture(70, 70));
  const url = `/api/bibles/${b.id}/pages/${page.id}`;
  await call('PATCH', url, { content: `<p><img src="${inline.url}"></p>`, leadImage: lead.file });
  // Old enough that the clean-up does not treat them as just uploaded.
  const old = new Date(Date.now() - 3 * 864e5);
  for (const f of [inline.file, lead.file]) fs.utimesSync(path.join(imageDir(b.id), f), old, old);

  await call('DELETE', url);
  require('../src/images').sweep(b.id);
  assert.ok(fs.existsSync(path.join(imageDir(b.id), inline.file)), 'pictures stay while the page is in the trash');
  await call('POST', `/api/bibles/${b.id}/trash/${page.id}/restore`);
  const { body: restored } = await call('GET', `/api/bibles/${b.id}`);
  const back = restored.sections.flatMap((s) => s.pages).find((p) => p.id === page.id);
  assert.strictEqual(back.leadImage, lead.file);
  assert.strictEqual((await fetch(base + inline.url, { headers: { cookie: cookies.writer } })).status, 200);

  await call('DELETE', url);
  await call('DELETE', `/api/bibles/${b.id}/trash/${page.id}`);
  assert.ok(!fs.existsSync(path.join(imageDir(b.id), inline.file)), 'emptying the trash removes the page\'s pictures');
  assert.ok(!fs.existsSync(path.join(imageDir(b.id), lead.file)));
});

test('deleting a bible deletes its pictures', async () => {
  const { b } = await setup('Gone');
  await upload(b.id, await picture(20, 20));
  assert.ok(fs.existsSync(imageDir(b.id)));
  await call('DELETE', `/api/bibles/${b.id}`);
  assert.ok(!fs.existsSync(imageDir(b.id)));
});

test('exports carry page pictures, lead pictures and the relationship map', async () => {
  const { b, sid, page } = await setup('Export');
  const { body: other } = await call('POST', `/api/bibles/${b.id}/sections/${sid}/pages`, { title: 'Ben Ortiz' });
  const { body: inline } = await upload(b.id, await picture(1600, 900));
  const { body: lead } = await upload(b.id, await picture(300, 400));
  await call('PATCH', `/api/bibles/${b.id}/pages/${page.id}`, { content: `<h2>Look</h2><p><img src="${inline.url}"></p>`, leadImage: lead.file });
  await call('POST', `/api/bibles/${b.id}/relationships`, { from: page.id, to: other.id, label: 'mentor of', type: 'work', mutual: false, note: 'Since the academy.' });

  const bible = store.read(b.id);
  const html = buildHtml(bible, { assets: await loadAssets(bible) });
  assert.doesNotMatch(html, /\/api\/bibles\//, 'no picture points back at the server');
  assert.match(html, /<img src="data:image\/jpeg;base64,[^"]+" alt="" width="624" height="351" style="width:624px;height:351px">/, 'wide pictures fit the page width');
  assert.match(html, /class="lead-image"/);
  assert.match(html, /<a href="#relationship-map">Relationships<\/a>/, 'the map is in the contents');
  assert.match(html, /<svg[\s\S]*mentor of[\s\S]*<\/svg>/, 'the PDF gets the diagram');
  assert.match(html, /Ana<\/a> → <a href="#p-[a-f0-9]+">Ben Ortiz<\/a>: mentor of/);
  assert.match(html, /Since the academy\./);

  const zip = await JSZip.loadAsync(await toDocx(bible));
  const media = Object.keys(zip.files).filter((f) => f.startsWith('word/media/'));
  assert.ok(media.length >= 3, `Word gets the picture, the lead picture and the map (got ${media.join(', ')})`);
  const doc = await zip.file('word/document.xml').async('string');
  assert.match(doc, /mentor of/);
});

test('a bible with no relationships has no relationship chapter', async () => {
  const { b } = await setup('Plain');
  const bible = store.read(b.id);
  assert.doesNotMatch(buildHtml(bible, { assets: await loadAssets(bible) }), /Relationships/);
});
