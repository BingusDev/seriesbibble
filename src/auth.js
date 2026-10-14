// Accounts and sessions, stored as JSON files next to the bibles in DATA_DIR.
// Passwords are hashed with scrypt; session cookies carry a random token and
// only its SHA-256 hash is written to disk.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./store');

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const COOKIE = 'sb_session';
const SESSION_DAYS = 30;
const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{1,31}$/;

// Cached file contents, re-read whenever the file changes on disk (for example
// after `node src/users-cli.js` resets a password while the server runs).
const cache = {};
function load(file, fallback) {
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const c = cache[file];
  if (c && c.mtime === mtime) return c.data;
  const data = mtime ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
  cache[file] = { mtime, data };
  return data;
}
function save(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  cache[file] = { mtime: fs.statSync(file).mtimeMs, data };
}

const allUsers = () => load(USERS_FILE, []);
const allSessions = () => load(SESSIONS_FILE, {});

const publicUser = (u) => u && { id: u.id, username: u.username, displayName: u.displayName || u.username };
const normalize = (name) => (typeof name === 'string' ? name.trim().toLowerCase() : '');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function checkPassword(user, password) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

function validate(username, password) {
  if (!USERNAME_RE.test(username)) {
    return 'Usernames are 2 to 32 characters: lowercase letters, numbers, dots, dashes or underscores.';
  }
  if (typeof password !== 'string' || password.length < 8) return 'Passwords need at least 8 characters.';
  if (password.length > 200) return 'That password is too long.';
  return null;
}

const userCount = () => allUsers().length;
const firstUser = () => allUsers()[0] || null;
const findById = (id) => allUsers().find((u) => u.id === id);
const findByName = (name) => allUsers().find((u) => u.username === normalize(name));

function createUser({ username, password, displayName }) {
  username = normalize(username);
  const problem = validate(username, password);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });
  if (findByName(username)) throw Object.assign(new Error('That username is taken.'), { status: 409 });
  const user = {
    id: crypto.randomBytes(8).toString('hex'),
    username,
    displayName: (typeof displayName === 'string' && displayName.trim().slice(0, 80)) || username,
    ...hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  const users = allUsers();
  users.push(user);
  save(USERS_FILE, users);
  return user;
}

function setPassword(user, password) {
  const problem = validate(user.username, password);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });
  const users = allUsers();
  Object.assign(users.find((u) => u.id === user.id), hashPassword(password));
  save(USERS_FILE, users);
  // Changing a password signs out every device.
  const sessions = allSessions();
  for (const [k, s] of Object.entries(sessions)) if (s.userId === user.id) delete sessions[k];
  save(SESSIONS_FILE, sessions);
}

const tokenKey = (token) => crypto.createHash('sha256').update(token).digest('hex');

function startSession(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const sessions = allSessions();
  sessions[tokenKey(token)] = { userId: user.id, expires: Date.now() + SESSION_DAYS * 864e5 };
  save(SESSIONS_FILE, sessions);
  return token;
}

function endSession(token) {
  const sessions = allSessions();
  if (token && sessions[tokenKey(token)]) {
    delete sessions[tokenKey(token)];
    save(SESSIONS_FILE, sessions);
  }
}

// Resolves a cookie token to a user, sliding the expiry forward at most once a day.
function userForToken(token) {
  if (!token) return null;
  const key = tokenKey(token);
  const sessions = allSessions();
  const s = sessions[key];
  if (!s) return null;
  if (s.expires < Date.now()) {
    delete sessions[key];
    save(SESSIONS_FILE, sessions);
    return null;
  }
  const user = findById(s.userId);
  if (!user) return null;
  const fresh = Date.now() + SESSION_DAYS * 864e5;
  if (fresh - s.expires > 864e5) {
    s.expires = fresh;
    save(SESSIONS_FILE, sessions);
  }
  return user;
}

function readCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setCookie(req, res, token) {
  const bits = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${token ? SESSION_DAYS * 86400 : 0}`];
  if (req.secure) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

// Slows down password guessing, per 15 minutes: 10 failed logins for one username
// (so a faked client address does not help) and 50 from one address.
const failures = new Map();
const LIMITS = { user: 10, ip: 50 };
const keysFor = (ip, username) => [['ip', `ip:${ip}`], ['user', `user:${normalize(username)}`]];
function tooManyFailures(ip, username) {
  return keysFor(ip, username).some(([kind, key]) => {
    const f = failures.get(key);
    return f && f.until > Date.now() && f.count >= LIMITS[kind];
  });
}
function noteFailure(ip, username) {
  for (const [, key] of keysFor(ip, username)) {
    const f = failures.get(key);
    if (!f || f.until < Date.now()) failures.set(key, { count: 1, until: Date.now() + 15 * 60e3 });
    else f.count += 1;
  }
}

const resetFailures = () => failures.clear();

module.exports = {
  COOKIE,
  publicUser,
  userCount,
  findById,
  findByName,
  createUser,
  checkPassword,
  setPassword,
  startSession,
  endSession,
  userForToken,
  readCookie,
  setCookie,
  tooManyFailures,
  noteFailure,
  resetFailures,
  allUsers,
  firstUser,
};
