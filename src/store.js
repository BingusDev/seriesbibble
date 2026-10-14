// File-backed storage: one JSON document per bible under DATA_DIR/bibles.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const templates = require('./templates');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const BIBLE_DIR = path.join(DATA_DIR, 'bibles');
fs.mkdirSync(BIBLE_DIR, { recursive: true });

const newId = () => crypto.randomBytes(6).toString('hex');
const now = () => new Date().toISOString();

function fileFor(id) {
  if (!/^[a-f0-9]{12}$/.test(id)) return null;
  return path.join(BIBLE_DIR, `${id}.json`);
}

function read(id) {
  const f = fileFor(id);
  if (!f || !fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function write(bible) {
  bible.updatedAt = now();
  const f = fileFor(bible.id);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(bible, null, 2));
  fs.renameSync(tmp, f);
  return bible;
}

function list() {
  return fs
    .readdirSync(BIBLE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const b = JSON.parse(fs.readFileSync(path.join(BIBLE_DIR, f), 'utf8'));
      return {
        id: b.id, title: b.title, logline: b.logline, updatedAt: b.updatedAt,
        ownerId: b.ownerId, collaborators: b.collaborators || [],
      };
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

function makePage(title, kind) {
  return { id: newId(), title, content: templates.pageContent(kind), updatedAt: now() };
}

function makeSection(name, kind) {
  if (!templates.isKind(kind)) kind = templates.kindForName(name);
  return { id: newId(), name, kind, pages: [] };
}

function create({ title, logline, ownerId }) {
  const characters = makeSection('Characters', 'characters');
  const world = makeSection('World', 'world');
  const bible = {
    id: newId(),
    title: title || 'Untitled Series',
    logline: logline || '',
    ownerId,
    collaborators: [],
    createdAt: now(),
    updatedAt: now(),
    sections: [characters, world],
  };
  return write(bible);
}

function remove(id) {
  const f = fileFor(id);
  if (f && fs.existsSync(f)) fs.unlinkSync(f);
}

function findPage(bible, pageId) {
  for (const section of bible.sections) {
    const page = section.pages.find((p) => p.id === pageId);
    if (page) return { section, page };
  }
  return null;
}

module.exports = { DATA_DIR, read, write, list, create, remove, makePage, makeSection, findPage, newId, now };
