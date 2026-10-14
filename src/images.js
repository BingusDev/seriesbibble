// Pictures on pages: character portraits, location references, mood boards.
// Stored as files beside the bibles so they survive rebuilds and get backed up with the data dir:
//   DATA_DIR/images/<bibleId>/<imageId>.jpg|png        the picture, at most MAX_SIDE px on its long side
//   DATA_DIR/images/<bibleId>/<imageId>.thumb.jpg      a small copy for the sidebar and overview cards
// Pages point at them by URL (/api/bibles/<bibleId>/images/<file>) in their HTML, and by file name in
// page.leadImage. A picture stays on disk while anything still points at it: a page, a page in the
// trash or an older version in its history, so deleting and restoring pages never loses pictures.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const IMAGE_DIR = path.join(store.DATA_DIR, 'images');
const MAX_SIDE = 2000;
const THUMB_SIDE = 320;
const MAX_UPLOAD = 25 * 1024 * 1024;
// Pictures nobody points at are kept this long, so one just uploaded survives until its page saves.
const ORPHAN_GRACE_MS = 24 * 3600e3;

const validId = (id) => typeof id === 'string' && /^[a-f0-9]{12}$/.test(id);
const FILE_RE = /^([a-f0-9]{12})\.(jpg|png)$/;
const validFile = (f) => typeof f === 'string' && FILE_RE.test(f);
// Image URLs inside page HTML. The bible id is captured so pictures from another bible can be copied over.
const URL_RE = /\/api\/bibles\/([a-f0-9]{12})\/images\/([a-f0-9]{12}\.(?:jpg|png))/g;

const dirFor = (bid) => (validId(bid) ? path.join(IMAGE_DIR, bid) : null);
const urlFor = (bid, file) => `/api/bibles/${bid}/images/${file}`;
const thumbName = (file) => file.replace(/\.(jpg|png)$/, '.thumb.jpg');

function fileFor(bid, file) {
  const dir = dirFor(bid);
  return dir && validFile(file) ? path.join(dir, file) : null;
}

const exists = (bid, file) => {
  const f = fileFor(bid, file);
  return !!f && fs.existsSync(f);
};

// sharp is loaded on first use so the rest of the app starts even where it is missing.
let sharpLib;
const sharp = (...args) => (sharpLib = sharpLib || require('sharp'))(...args);

// Decodes any common picture format, turns it upright, shrinks it to MAX_SIDE and saves it as
// PNG when it has transparency (logos, cut-outs) or JPEG otherwise. Returns { file, url, width, height }.
// The name comes from the picture's bytes, so the same picture sent twice is stored once.
async function save(bid, buf) {
  const dir = dirFor(bid);
  if (!dir) throw Object.assign(new Error('Bible not found'), { status: 404 });
  let meta;
  try {
    meta = await sharp(buf, { animated: false }).metadata();
  } catch (_) {
    throw Object.assign(new Error('That file is not a picture this app can read.'), { status: 400 });
  }
  const alpha = !!meta.hasAlpha;
  const ext = alpha ? 'png' : 'jpg';
  const file = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12)}.${ext}`;
  const full = path.join(dir, file);
  if (fs.existsSync(full)) {
    const now = new Date();
    fs.utimesSync(full, now, now); // counts as new for the clean-up's grace period
    return { file, url: urlFor(bid, file), ...(await dimensions(bid, file)) };
  }
  fs.mkdirSync(dir, { recursive: true });
  let pipeline = sharp(buf, { animated: false }).rotate().resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true });
  pipeline = alpha ? pipeline.png({ compressionLevel: 9 }) : pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 85, mozjpeg: true });
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  const tmp = `${full}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, full);
  await makeThumb(bid, file);
  return { file, url: urlFor(bid, file), width: info.width, height: info.height };
}

async function makeThumb(bid, file) {
  const out = path.join(dirFor(bid), thumbName(file));
  await sharp(fileFor(bid, file))
    .resize(THUMB_SIDE, THUMB_SIDE, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 80 })
    .toFile(out);
  return out;
}

async function dimensions(bid, file) {
  const meta = await sharp(fileFor(bid, file)).metadata();
  return { width: meta.width, height: meta.height };
}

// ---------- Page HTML ----------
// Pictures pasted as data: URLs (from Word or another site) are saved as files, and pictures
// copied from another bible this person can open are copied into this one, so a page only ever
// points at its own bible's pictures. Returns the rewritten HTML.
async function adoptImages(bid, html, canRead) {
  if (typeof html !== 'string' || !html.includes('<img')) return html;
  const out = [];
  let last = 0;
  const re = /(<img\b[^>]*?\ssrc=")([^"]*)(")/g;
  for (const m of html.matchAll(re)) {
    out.push(html.slice(last, m.index));
    last = m.index + m[0].length;
    const src = m[2];
    let next = src;
    const data = src.match(/^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i);
    const foreign = src.match(/^\/api\/bibles\/([a-f0-9]{12})\/images\/([a-f0-9]{12}\.(?:jpg|png))$/);
    try {
      if (data) {
        next = (await save(bid, Buffer.from(data[1], 'base64'))).url;
      } else if (foreign && foreign[1] !== bid && canRead(foreign[1]) && exists(foreign[1], foreign[2])) {
        next = (await save(bid, fs.readFileSync(fileFor(foreign[1], foreign[2])))).url;
      }
    } catch (_) {
      next = data ? '' : src; // an unreadable pasted picture is dropped rather than stored in the page
    }
    out.push(m[1] + next + m[3]);
  }
  out.push(html.slice(last));
  return out.join('').replace(/<img\b[^>]*?\ssrc=""[^>]*>/g, '');
}

// File names of this bible's pictures that a piece of HTML points at.
function filesIn(bid, html) {
  const files = new Set();
  for (const m of String(html || '').matchAll(URL_RE)) if (m[1] === bid) files.add(m[2]);
  return files;
}

// ---------- Clean-up ----------
function referenced(bible) {
  const history = require('./history');
  const keep = new Set();
  const addPage = (page) => {
    if (!page) return;
    for (const f of filesIn(bible.id, page.content)) keep.add(f);
    if (page.leadImage) keep.add(page.leadImage);
  };
  for (const s of bible.sections) for (const p of s.pages) addPage(p);
  for (const e of history.trashOf(bible.id)) {
    addPage(e.page);
    for (const v of history.versionsOf(bible.id, e.page.id)) addPage(v);
  }
  for (const s of bible.sections) for (const p of s.pages) for (const v of history.versionsOf(bible.id, p.id)) addPage(v);
  return keep;
}

// Removes pictures nothing points at any more (after the grace period). Returns how many went.
function sweep(bid, { graceMs = ORPHAN_GRACE_MS } = {}) {
  const dir = dirFor(bid);
  if (!dir || !fs.existsSync(dir)) return 0;
  const bible = store.read(bid);
  if (!bible) return 0;
  const keep = referenced(bible);
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(/^([a-f0-9]{12})\.(jpg|png)$/);
    if (!m || keep.has(name)) continue;
    const full = path.join(dir, name);
    if (Date.now() - fs.statSync(full).mtimeMs < graceMs) continue;
    fs.rmSync(full, { force: true });
    fs.rmSync(path.join(dir, thumbName(name)), { force: true });
    removed += 1;
  }
  return removed;
}

// Uploads tidy up now and then, so pictures that were added and then deleted don't pile up.
const lastSweep = new Map();
function maybeSweep(bid) {
  if (Date.now() - (lastSweep.get(bid) || 0) < 3600e3) return;
  lastSweep.set(bid, Date.now());
  try { sweep(bid); } catch (err) { console.error('Image clean-up failed', err); }
}

function removeBible(bid) {
  const dir = dirFor(bid);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- Routes ----------
const router = express.Router();

router.post(
  '/api/bibles/:id/images',
  express.raw({ type: () => true, limit: MAX_UPLOAD }),
  async (req, res) => {
    if (!req.bible) return res.status(404).json({ error: 'Bible not found' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No picture was sent.' });
    try {
      const saved = await save(req.bible.id, req.body);
      maybeSweep(req.bible.id);
      res.status(201).json(saved);
    } catch (err) {
      if (!err.status) console.error(err);
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not save the picture.' });
    }
  }
);

// ?size=thumb serves the small copy, making it on the spot for pictures that predate it.
router.get('/api/bibles/:id/images/:file', async (req, res) => {
  if (!req.bible) return res.status(404).json({ error: 'Bible not found' });
  const { file } = req.params;
  const full = fileFor(req.bible.id, file);
  if (!full || !fs.existsSync(full)) return res.status(404).json({ error: 'Picture not found' });
  let send = full;
  if (req.query.size === 'thumb') {
    send = path.join(dirFor(req.bible.id), thumbName(file));
    if (!fs.existsSync(send)) {
      try { await makeThumb(req.bible.id, file); } catch (_) { send = full; }
    }
  }
  // File names are never reused, so browsers may keep them for good.
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(send);
});

module.exports = { router, IMAGE_DIR, save, adoptImages, filesIn, sweep, removeBible, exists, fileFor, dimensions, urlFor, validFile, URL_RE };
