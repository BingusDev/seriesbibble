// Character relationships for the relationship map.
// Stored on the bible as an optional `relmap` field so older bibles need no migration:
//   relmap: { relationships: [{ id, from, to, label, type, mutual, note }], positions: { [pageId]: { x, y } } }
const express = require('express');
const store = require('./store');

const TYPES = ['family', 'romance', 'ally', 'rival', 'work', 'other'];

const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max).trim() : undefined);

function relmapOf(bible) {
  if (!bible.relmap || typeof bible.relmap !== 'object') bible.relmap = {};
  if (!Array.isArray(bible.relmap.relationships)) bible.relmap.relationships = [];
  if (!bible.relmap.positions || typeof bible.relmap.positions !== 'object') bible.relmap.positions = {};
  return bible.relmap;
}

// Relationships whose pages were deleted are dropped rather than shown dangling.
function prune(bible) {
  const map = relmapOf(bible);
  const ids = new Set(bible.sections.flatMap((s) => s.pages.map((p) => p.id)));
  map.relationships = map.relationships.filter((r) => ids.has(r.from) && ids.has(r.to));
  for (const pid of Object.keys(map.positions)) if (!ids.has(pid)) delete map.positions[pid];
  return map;
}

// Applies user-supplied fields; returns an error message or null.
function apply(bible, rel, body, creating) {
  for (const key of ['from', 'to']) {
    if (body[key] === undefined && !creating) continue;
    if (typeof body[key] !== 'string' || !store.findPage(bible, body[key])) return `Unknown page for "${key}"`;
    rel[key] = body[key];
  }
  if (rel.from === rel.to) return 'A relationship needs two different characters';
  if (body.label !== undefined || creating) rel.label = str(body.label, 80) || '';
  if (body.note !== undefined || creating) rel.note = str(body.note, 2000) || '';
  if (body.type !== undefined || creating) rel.type = TYPES.includes(body.type) ? body.type : 'other';
  if (body.mutual !== undefined || creating) rel.mutual = body.mutual !== false;
  return null;
}

const router = express.Router();

function withBible(handler) {
  return (req, res) => {
    const bible = store.read(req.params.id);
    if (!bible) return res.status(404).json({ error: 'Bible not found' });
    return handler(req, res, bible);
  };
}

router.get('/api/bibles/:id/relmap', withBible((req, res, bible) => res.json(prune(bible))));

router.post('/api/bibles/:id/relationships', withBible((req, res, bible) => {
  const rel = { id: store.newId() };
  const err = apply(bible, rel, req.body || {}, true);
  if (err) return res.status(400).json({ error: err });
  prune(bible).relationships.push(rel);
  store.write(bible);
  res.status(201).json(rel);
}));

router.patch('/api/bibles/:id/relationships/:rid', withBible((req, res, bible) => {
  const rel = prune(bible).relationships.find((r) => r.id === req.params.rid);
  if (!rel) return res.status(404).json({ error: 'Relationship not found' });
  const draft = { ...rel };
  const err = apply(bible, draft, req.body || {}, false);
  if (err) return res.status(400).json({ error: err });
  Object.assign(rel, draft);
  store.write(bible);
  res.json(rel);
}));

router.delete('/api/bibles/:id/relationships/:rid', withBible((req, res, bible) => {
  const map = prune(bible);
  map.relationships = map.relationships.filter((r) => r.id !== req.params.rid);
  store.write(bible);
  res.status(204).end();
}));

// Saves where characters were dragged on the map. `null` for a page un-pins it.
router.put('/api/bibles/:id/relmap/positions', withBible((req, res, bible) => {
  const map = prune(bible);
  const incoming = (req.body && req.body.positions) || {};
  if (req.body && req.body.reset) map.positions = {};
  for (const [pid, pos] of Object.entries(incoming)) {
    if (!store.findPage(bible, pid)) continue;
    if (pos === null) delete map.positions[pid];
    else if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      map.positions[pid] = { x: Math.round(pos.x), y: Math.round(pos.y) };
    }
  }
  store.write(bible);
  res.json(map);
}));

module.exports = { router, TYPES, prune };
