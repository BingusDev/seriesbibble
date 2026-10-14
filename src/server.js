const express = require('express');
const path = require('path');
const store = require('./store');
const { toDocx, toPdf } = require('./export');
const collab = require('./collab');

const app = express();
// Caddy (or another proxy on this machine or network) terminates HTTPS.
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.use(express.json({ limit: '25mb' }));

const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub));
app.use('/vendor/quill', express.static(path.join(__dirname, '..', 'node_modules', 'quill', 'dist')));

// Loads the bible named in the URL or answers 404.
function withBible(handler) {
  return (req, res) => {
    const bible = store.read(req.params.id);
    if (!bible) return res.status(404).json({ error: 'Bible not found' });
    return handler(req, res, bible);
  };
}

// Sign-in, ownership and sharing checks run before every bible route below.
app.use(collab.router);

const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : undefined);

app.get('/api/bibles', (req, res) => {
  const mine = store.list().filter((b) => collab.canAccess(req.user, b));
  res.json(mine.map((b) => collab.summaryFor(req.user, b)));
});

app.post('/api/bibles', (req, res) => {
  res.status(201).json(store.create({ title: str(req.body.title), logline: str(req.body.logline, 2000), ownerId: req.user.id }));
});

app.get('/api/bibles/:id', withBible((req, res, bible) => res.json(bible)));

app.patch('/api/bibles/:id', withBible((req, res, bible) => {
  if (str(req.body.title) !== undefined) bible.title = str(req.body.title);
  if (str(req.body.logline, 2000) !== undefined) bible.logline = str(req.body.logline, 2000);
  res.json(store.write(bible));
}));

app.delete('/api/bibles/:id', (req, res) => {
  store.remove(req.params.id);
  res.status(204).end();
});

// Sections
app.post('/api/bibles/:id/sections', withBible((req, res, bible) => {
  const section = store.makeSection(str(req.body.name) || 'New Section');
  bible.sections.push(section);
  store.write(bible);
  res.status(201).json(section);
}));

app.patch('/api/bibles/:id/sections/:sid', withBible((req, res, bible) => {
  const section = bible.sections.find((s) => s.id === req.params.sid);
  if (!section) return res.status(404).json({ error: 'Section not found' });
  if (str(req.body.name)) section.name = str(req.body.name);
  if (Number.isInteger(req.body.position)) {
    bible.sections.splice(bible.sections.indexOf(section), 1);
    const pos = Math.max(0, Math.min(req.body.position, bible.sections.length));
    bible.sections.splice(pos, 0, section);
  }
  store.write(bible);
  res.json(section);
}));

app.delete('/api/bibles/:id/sections/:sid', withBible((req, res, bible) => {
  bible.sections = bible.sections.filter((s) => s.id !== req.params.sid);
  store.write(bible);
  res.status(204).end();
}));

// Pages
app.post('/api/bibles/:id/sections/:sid/pages', withBible((req, res, bible) => {
  const section = bible.sections.find((s) => s.id === req.params.sid);
  if (!section) return res.status(404).json({ error: 'Section not found' });
  const page = store.makePage(str(req.body.title) || 'Untitled', section.kind);
  section.pages.push(page);
  store.write(bible);
  res.status(201).json(page);
}));

app.patch('/api/bibles/:id/pages/:pid', withBible((req, res, bible) => {
  const found = store.findPage(bible, req.params.pid);
  if (!found) return res.status(404).json({ error: 'Page not found' });
  const { page, section } = found;
  // Someone else saved this page since the editor loaded it: refuse rather than overwrite.
  const editsText = str(req.body.title) || typeof req.body.content === 'string';
  if (editsText && Number.isInteger(req.body.baseRev) && req.body.baseRev !== (page.rev || 0)) {
    return res.status(409).json({ error: 'This page was changed by someone else.', page });
  }
  if (str(req.body.title)) page.title = str(req.body.title);
  if (typeof req.body.content === 'string') page.content = req.body.content;
  if (req.body.sectionId && req.body.sectionId !== section.id) {
    const target = bible.sections.find((s) => s.id === req.body.sectionId);
    if (!target) return res.status(400).json({ error: 'Target section not found' });
    section.pages.splice(section.pages.indexOf(page), 1);
    target.pages.push(page);
  }
  if (Number.isInteger(req.body.position)) {
    const owner = bible.sections.find((s) => s.pages.includes(page));
    owner.pages.splice(owner.pages.indexOf(page), 1);
    const pos = Math.max(0, Math.min(req.body.position, owner.pages.length));
    owner.pages.splice(pos, 0, page);
  }
  page.updatedAt = store.now();
  if (editsText) {
    page.rev = (page.rev || 0) + 1;
    page.updatedBy = req.user.displayName || req.user.username;
  }
  store.write(bible);
  res.json(page);
}));

app.delete('/api/bibles/:id/pages/:pid', withBible((req, res, bible) => {
  for (const s of bible.sections) s.pages = s.pages.filter((p) => p.id !== req.params.pid);
  store.write(bible);
  res.status(204).end();
}));

// Exports
const fileName = (bible, ext) => `${(bible.title || 'series-bible').replace(/[^\w\- ]+/g, '').trim() || 'series-bible'}.${ext}`;

app.get('/api/bibles/:id/export.docx', withBible(async (req, res, bible) => {
  try {
    const buf = await toDocx(bible);
    res.attachment(fileName(bible, 'docx'));
    res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Word export failed' });
  }
}));

app.get('/api/bibles/:id/export.pdf', withBible(async (req, res, bible) => {
  try {
    const buf = await toPdf(bible);
    res.attachment(fileName(bible, 'pdf'));
    res.type('application/pdf').send(buf);
  } catch (err) {
    console.error(err);
    const missing = /No Chromium/.test(err.message);
    res.status(500).json({ error: missing ? 'PDF export needs Chromium on the server (included in the Docker image)' : 'PDF export failed' });
  }
}));

app.get('/api/bibles/:id/export.json', withBible((req, res, bible) => {
  res.attachment(fileName(bible, 'json'));
  res.json(bible);
}));

app.get('/api/health', (req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(port, () => console.log(`Series Bible running on http://localhost:${port}`));
}

module.exports = app;
