// Page history and the trash. Both live beside the bibles rather than inside them,
// so bible files, exports and the editor never carry the extra weight:
//   DATA_DIR/history/<bibleId>/<pageId>.json  -> [{ id, at, by, title, content }]  oldest first
//   DATA_DIR/trash/<bibleId>.json             -> [{ page, sectionId, sectionName, sectionKind, position,
//                                                   deletedAt, deletedBy, relationships, mapPosition }]
const express = require('express');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const relationships = require('./relationships');

const HISTORY_DIR = path.join(store.DATA_DIR, 'history');
const TRASH_DIR = path.join(store.DATA_DIR, 'trash');

const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
// A new version is kept when the last one is this old, or when someone else starts editing.
const INTERVAL_MS = num(process.env.HISTORY_INTERVAL_MINUTES, 10) * 60e3;
// Versions kept per page; the oldest drop off first.
const MAX_VERSIONS = Math.floor(num(process.env.HISTORY_MAX_VERSIONS, 50));
// Pages in the trash are removed for good after this many days.
const TRASH_DAYS = num(process.env.TRASH_DAYS, 30);

const validId = (id) => typeof id === 'string' && /^[a-f0-9]{12}$/.test(id);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

// ---------- Versions ----------
const historyFile = (bid, pid) => (validId(bid) && validId(pid) ? path.join(HISTORY_DIR, bid, `${pid}.json`) : null);

function versionsOf(bid, pid) {
  const f = historyFile(bid, pid);
  return f ? readJson(f, []) : [];
}

function saveVersions(bid, pid, versions) {
  const f = historyFile(bid, pid);
  if (!f) return;
  writeJson(f, versions.slice(-MAX_VERSIONS));
}

// Keeps the page as it is now (before an edit) as a version, unless a recent one already covers it.
// `force` keeps it regardless of age, as long as it differs from the newest version.
// Display names are not unique, so a handoff between people is judged by account id.
function snapshot(bid, page, editor, force = false) {
  const versions = versionsOf(bid, page.id);
  const last = versions[versions.length - 1];
  if (last && last.content === page.content && last.title === page.title) return null;
  const takenAt = last ? Date.parse(last.takenAt || last.at) : 0;
  const lastEditor = page.updatedById || page.updatedBy;
  const handoff = !!editor && !!lastEditor && lastEditor !== (page.updatedById ? editor.id : editor.displayName || editor.username);
  const due = !last || force || Date.now() - takenAt >= INTERVAL_MS || handoff;
  if (!due) return null;
  const version = {
    id: store.newId(),
    at: page.updatedAt || store.now(),
    takenAt: store.now(),
    by: page.updatedBy || null,
    title: page.title,
    content: page.content,
  };
  versions.push(version);
  saveVersions(bid, page.id, versions);
  return version;
}

function dropHistory(bid, pid) {
  const f = historyFile(bid, pid);
  if (f) fs.rmSync(f, { force: true });
}

// ---------- Trash ----------
const trashFile = (bid) => (validId(bid) ? path.join(TRASH_DIR, `${bid}.json`) : null);

function trashOf(bid) {
  const f = trashFile(bid);
  if (!f) return [];
  const all = readJson(f, []);
  const cutoff = Date.now() - TRASH_DAYS * 864e5;
  const keep = all.filter((e) => Date.parse(e.deletedAt) >= cutoff);
  if (keep.length !== all.length) {
    for (const e of all) if (!keep.includes(e)) dropHistory(bid, e.page.id);
    writeJson(f, keep);
  }
  return keep;
}

function saveTrash(bid, entries) {
  const f = trashFile(bid);
  if (f) writeJson(f, entries);
}

// Moves pages out of the bible into its trash, remembering where they were and the
// relationships they took part in. The caller writes the bible afterwards.
function trashPages(bible, pageIds, user) {
  const ids = new Set(pageIds);
  if (!ids.size) return [];
  const map = bible.relmap || {};
  const rels = Array.isArray(map.relationships) ? map.relationships : [];
  const positions = map.positions || {};
  const entries = trashOf(bible.id).filter((e) => !ids.has(e.page.id));
  const moved = [];
  for (const section of bible.sections) {
    section.pages.forEach((page, position) => {
      if (!ids.has(page.id)) return;
      moved.push({
        page,
        sectionId: section.id,
        sectionName: section.name,
        sectionKind: section.kind,
        position,
        deletedAt: store.now(),
        deletedBy: user ? user.displayName || user.username : null,
        relationships: rels.filter((r) => r.from === page.id || r.to === page.id),
        mapPosition: positions[page.id] || null,
      });
    });
    section.pages = section.pages.filter((p) => !ids.has(p.id));
  }
  relationships.prune(bible);
  saveTrash(bible.id, entries.concat(moved));
  return moved;
}

// Puts a trashed page back where it was: its old section if that still exists,
// else a section with the same name, else a new one. Returns the page, or null.
function restorePage(bible, pid) {
  const entries = trashOf(bible.id);
  const entry = entries.find((e) => e.page.id === pid);
  if (!entry) return null;
  let section =
    bible.sections.find((s) => s.id === entry.sectionId) ||
    bible.sections.find((s) => s.name === entry.sectionName);
  if (!section) {
    section = store.makeSection(entry.sectionName || 'Restored', entry.sectionKind);
    bible.sections.push(section);
  }
  if (!store.findPage(bible, pid)) {
    section.pages.splice(Math.min(entry.position, section.pages.length), 0, entry.page);
  }
  const map = relationships.prune(bible);
  const present = new Set(map.relationships.map((r) => r.id));
  for (const rel of entry.relationships || []) {
    if (present.has(rel.id)) continue;
    if (store.findPage(bible, rel.from) && store.findPage(bible, rel.to)) {
      map.relationships.push(rel);
      continue;
    }
    // The other character is still in the trash: hand the relationship to its entry
    // so restoring that page brings it back.
    const other = entries.find((e) => e !== entry && (e.page.id === rel.from || e.page.id === rel.to));
    if (other && !(other.relationships || []).some((r) => r.id === rel.id)) {
      other.relationships = (other.relationships || []).concat(rel);
    }
  }
  if (entry.mapPosition && !map.positions[pid]) map.positions[pid] = entry.mapPosition;
  saveTrash(bible.id, entries.filter((e) => e !== entry));
  return { page: entry.page, sectionId: section.id };
}

function purge(bid, pid) {
  const entries = trashOf(bid);
  const gone = pid ? entries.filter((e) => e.page.id === pid) : entries;
  for (const e of gone) dropHistory(bid, e.page.id);
  saveTrash(bid, entries.filter((e) => !gone.includes(e)));
  return gone.length;
}

// Everything kept for a bible that has been deleted.
function removeBible(bid) {
  if (!validId(bid)) return;
  fs.rmSync(path.join(HISTORY_DIR, bid), { recursive: true, force: true });
  fs.rmSync(trashFile(bid), { force: true });
}

// ---------- Routes ----------
const router = express.Router();

function withBible(handler) {
  return (req, res) => {
    const bible = store.read(req.params.id);
    if (!bible) return res.status(404).json({ error: 'Bible not found' });
    return handler(req, res, bible);
  };
}

const ENTITIES = { '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
const plain = (html) =>
  String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(nbsp|lt|gt|quot|#39|amp);/g, (m) => ENTITIES[m])
    .replace(/\s+/g, ' ')
    .trim();
const words = (html) => (plain(html) ? plain(html).split(' ').length : 0);
const summary = (v) => ({ id: v.id, at: v.at, by: v.by, title: v.title, words: words(v.content) });

router.get('/api/bibles/:id/pages/:pid/versions', withBible((req, res, bible) => {
  const found = store.findPage(bible, req.params.pid);
  if (!found) return res.status(404).json({ error: 'Page not found' });
  res.json(versionsOf(bible.id, req.params.pid).map(summary).reverse());
}));

router.get('/api/bibles/:id/pages/:pid/versions/:vid', withBible((req, res, bible) => {
  if (!store.findPage(bible, req.params.pid)) return res.status(404).json({ error: 'Page not found' });
  const version = versionsOf(bible.id, req.params.pid).find((v) => v.id === req.params.vid);
  if (!version) return res.status(404).json({ error: 'Version not found' });
  res.json(version);
}));

// Brings an earlier version back. The page as it was just before is kept as a version too,
// so restoring is itself undoable.
router.post('/api/bibles/:id/pages/:pid/versions/:vid/restore', withBible((req, res, bible) => {
  const found = store.findPage(bible, req.params.pid);
  if (!found) return res.status(404).json({ error: 'Page not found' });
  const version = versionsOf(bible.id, req.params.pid).find((v) => v.id === req.params.vid);
  if (!version) return res.status(404).json({ error: 'Version not found' });
  const { page } = found;
  snapshot(bible.id, page, null, true);
  page.title = version.title;
  page.content = version.content;
  page.updatedAt = store.now();
  page.rev = (page.rev || 0) + 1;
  page.updatedBy = req.user.displayName || req.user.username;
  page.updatedById = req.user.id;
  store.write(bible);
  res.json(page);
}));

router.get('/api/bibles/:id/trash', withBible((req, res, bible) => {
  res.json(
    trashOf(bible.id)
      .map((e) => ({
        id: e.page.id,
        title: e.page.title,
        sectionName: e.sectionName,
        sectionExists: bible.sections.some((s) => s.id === e.sectionId || s.name === e.sectionName),
        deletedAt: e.deletedAt,
        deletedBy: e.deletedBy,
        words: words(e.page.content),
        excerpt: plain(e.page.content).slice(0, 160),
        purgeAt: new Date(Date.parse(e.deletedAt) + TRASH_DAYS * 864e5).toISOString(),
      }))
      .reverse()
  );
}));

router.post('/api/bibles/:id/trash/:pid/restore', withBible((req, res, bible) => {
  const restored = restorePage(bible, req.params.pid);
  if (!restored) return res.status(404).json({ error: 'That page is not in the trash' });
  store.write(bible);
  res.json(restored);
}));

router.delete('/api/bibles/:id/trash/:pid', withBible((req, res, bible) => {
  if (!purge(bible.id, req.params.pid)) return res.status(404).json({ error: 'That page is not in the trash' });
  res.status(204).end();
}));

router.delete('/api/bibles/:id/trash', withBible((req, res, bible) => {
  purge(bible.id);
  res.status(204).end();
}));

module.exports = { router, snapshot, trashPages, restorePage, purge, removeBible, versionsOf, trashOf, MAX_VERSIONS, TRASH_DAYS };
