// Login, bible ownership and sharing, and live activity for collaborators.
// Mounted in front of the bible routes so they only ever see signed-in users
// who are allowed to open the bible in the URL.
const express = require('express');
const crypto = require('crypto');
const auth = require('./auth');
const store = require('./store');

const router = express.Router();
const signupOpen = () => process.env.ALLOW_SIGNUP !== 'false' || auth.userCount() === 0;

// Bibles made before accounts existed belong to the first account.
const ownerOf = (bible) => bible.ownerId || (auth.firstUser() || {}).id;
const isOwner = (user, bible) => !!user && ownerOf(bible) === user.id;
const canAccess = (user, bible) => isOwner(user, bible) || (!!user && (bible.collaborators || []).includes(user.id));

function claimUnownedBibles(user) {
  for (const summary of store.list()) {
    if (summary.ownerId) continue;
    const bible = store.read(summary.id);
    bible.ownerId = user.id;
    bible.collaborators = bible.collaborators || [];
    store.write(bible);
  }
}

router.use((req, res, next) => {
  req.user = auth.userForToken(auth.readCookie(req));
  next();
});

// ---------- Accounts ----------
router.get('/api/auth/state', (req, res) => {
  res.json({ user: auth.publicUser(req.user), signupOpen: signupOpen(), firstRun: auth.userCount() === 0 });
});

const body = (req) => req.body || {};

router.post('/api/auth/register', (req, res) => {
  if (!signupOpen()) return res.status(403).json({ error: 'New accounts are turned off on this server.' });
  const first = auth.userCount() === 0;
  try {
    const user = auth.createUser(body(req));
    if (first) claimUnownedBibles(user);
    auth.setCookie(req, res, auth.startSession(user));
    res.status(201).json({ user: auth.publicUser(user) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not create the account' });
  }
});

router.post('/api/auth/login', (req, res) => {
  if (auth.tooManyFailures(req.ip)) {
    return res.status(429).json({ error: 'Too many failed sign-ins. Try again in a few minutes.' });
  }
  const { username, password } = body(req);
  const user = auth.findByName(username);
  if (!user || typeof password !== 'string' || !auth.checkPassword(user, password)) {
    auth.noteFailure(req.ip);
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  auth.setCookie(req, res, auth.startSession(user));
  res.json({ user: auth.publicUser(user) });
});

router.post('/api/auth/logout', (req, res) => {
  auth.endSession(auth.readCookie(req));
  auth.setCookie(req, res, '');
  res.status(204).end();
});

// Everything else under /api needs a signed-in user.
router.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.user) return next();
  res.status(401).json({ error: 'Please sign in.' });
});

router.post('/api/auth/password', (req, res) => {
  const { current, password } = body(req);
  if (typeof current !== 'string' || !auth.checkPassword(req.user, current)) {
    return res.status(403).json({ error: 'Your current password is not right.' });
  }
  try {
    auth.setPassword(req.user, password);
    auth.setCookie(req, res, auth.startSession(req.user));
    res.status(204).end();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------- Access to one bible ----------
router.use('/api/bibles/:id', (req, res, next) => {
  const bible = store.read(req.params.id);
  if (!bible) return next(); // the bible routes answer 404
  if (!canAccess(req.user, bible)) return res.status(404).json({ error: 'Bible not found' });
  if (req.method === 'DELETE' && req.path === '/' && !isOwner(req.user, bible)) {
    return res.status(403).json({ error: 'Only the owner can delete this bible. You can leave it instead.' });
  }
  req.bible = bible;
  next();
});

// ---------- Sharing ----------
function sharingOf(bible) {
  return {
    owner: auth.publicUser(auth.findById(ownerOf(bible))),
    collaborators: (bible.collaborators || []).map((id) => auth.publicUser(auth.findById(id))).filter(Boolean),
  };
}

router.get('/api/bibles/:id/sharing', (req, res) => res.json(sharingOf(req.bible)));

router.post('/api/bibles/:id/sharing', (req, res) => {
  const bible = req.bible;
  if (!isOwner(req.user, bible)) return res.status(403).json({ error: 'Only the owner can share this bible.' });
  const other = auth.findByName(body(req).username);
  if (!other) return res.status(404).json({ error: 'No account has that username. They need to sign up first.' });
  if (other.id === ownerOf(bible)) return res.status(400).json({ error: 'That is the owner of this bible.' });
  bible.ownerId = ownerOf(bible);
  bible.collaborators = bible.collaborators || [];
  if (!bible.collaborators.includes(other.id)) bible.collaborators.push(other.id);
  store.write(bible);
  res.status(201).json(sharingOf(bible));
});

router.delete('/api/bibles/:id/sharing/:uid', (req, res) => {
  const bible = req.bible;
  if (!isOwner(req.user, bible) && req.params.uid !== req.user.id) {
    return res.status(403).json({ error: 'Only the owner can remove other people.' });
  }
  bible.collaborators = (bible.collaborators || []).filter((id) => id !== req.params.uid);
  store.write(bible);
  res.json(sharingOf(bible));
});

// ---------- Activity: who is here, and what changed ----------
// Polled by open editors every few seconds. Presence lives in memory only.
const presence = new Map(); // bibleId -> Map(userId -> { pageId, at })
const PRESENCE_MS = 20e3;

function structureSig(bible) {
  const shape = bible.sections.map((s) => [s.id, s.name, s.pages.map((p) => [p.id, p.title])]);
  return crypto.createHash('sha1').update(JSON.stringify([bible.title, bible.logline, shape])).digest('hex').slice(0, 16);
}

router.get('/api/bibles/:id/activity', (req, res) => {
  const bible = req.bible;
  if (!presence.has(bible.id)) presence.set(bible.id, new Map());
  const here = presence.get(bible.id);
  const pageId = typeof req.query.page === 'string' ? req.query.page.slice(0, 40) : null;
  here.set(req.user.id, { pageId, at: Date.now() });
  const viewers = [];
  for (const [uid, p] of here) {
    if (Date.now() - p.at > PRESENCE_MS) here.delete(uid);
    else if (uid !== req.user.id) {
      const u = auth.publicUser(auth.findById(uid));
      if (u) viewers.push({ ...u, pageId: p.pageId });
    }
  }
  const pages = {};
  for (const s of bible.sections) for (const p of s.pages) pages[p.id] = { rev: p.rev || 0, updatedBy: p.updatedBy || null };
  res.json({ sig: structureSig(bible), pages, viewers });
});

// What the home screen shows for one bible.
function summaryFor(user, b) {
  const owner = auth.publicUser(auth.findById(ownerOf(b)));
  return {
    id: b.id,
    title: b.title,
    logline: b.logline,
    updatedAt: b.updatedAt,
    role: isOwner(user, b) ? 'owner' : 'editor',
    owner,
    collaboratorCount: (b.collaborators || []).length,
  };
}

module.exports = { router, canAccess, isOwner, ownerOf, summaryFor };
