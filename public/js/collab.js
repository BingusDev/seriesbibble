/* Accounts, sharing and presence for the Series Bible client. Loaded before app.js. */
(function () {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function call(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? null : await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.error) || res.statusText);
    return data;
  }

  const initials = (u) =>
    (u.displayName || u.username)
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  // A stable colour per person so collaborators are easy to tell apart.
  const hue = (u) => [...u.username].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const avatar = (u, extra = '') =>
    `<span class="avatar" style="--hue:${hue(u)}" title="${esc(u.displayName)}${extra ? ` · ${esc(extra)}` : ''}">${esc(initials(u))}</span>`;

  const SB = {
    user: null,
    onSignedIn: null,

    // Checks for a session, then either runs the app or shows the sign-in screen.
    async start(onSignedIn) {
      this.onSignedIn = onSignedIn;
      const s = await call('GET', '/api/auth/state');
      if (s.user) {
        this.user = s.user;
        this.renderAccount();
        onSignedIn();
      } else {
        this.renderLogin(s);
      }
    },

    // Called by the app whenever the server says the session is gone.
    async signedOut() {
      if (!this.user && $('#login-form')) return;
      this.user = null;
      this.renderLogin(await call('GET', '/api/auth/state'));
    },

    isOwner(bible) {
      return !!this.user && bible.ownerId === this.user.id;
    },

    renderLogin(s) {
      const main = $('#main');
      $('#sidebar').hidden = true;
      $('#rightbar').hidden = true;
      $('#crumbs').innerHTML = '';
      $('#topbar-actions').innerHTML = '';
      $('#account').innerHTML = '';
      document.title = 'Sign in · Series Bible';
      let mode = s.firstRun ? 'register' : 'login';
      const draw = () => {
        const reg = mode === 'register';
        main.innerHTML = `
          <div class="login">
            <h1>${reg ? (s.firstRun ? 'Set up Series Bible' : 'Create an account') : 'Sign in'}</h1>
            <p class="lede">${
              s.firstRun
                ? 'Create the first account. Any bibles already on this server will belong to it.'
                : reg
                ? 'Pick a username. Collaborators share bibles with you by this name.'
                : 'Sign in to open your series bibles.'
            }</p>
            <form id="login-form">
              <label>Username<input name="username" autocomplete="username" required maxlength="32" autocapitalize="none" spellcheck="false"></label>
              ${reg ? '<label>Your name <small>(shown to collaborators)</small><input name="displayName" autocomplete="name" maxlength="80"></label>' : ''}
              <label>Password<input name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required minlength="${reg ? 8 : 1}"></label>
              <p class="login-error" id="login-error" hidden></p>
              <button class="btn primary">${reg ? 'Create account' : 'Sign in'}</button>
            </form>
            ${
              s.firstRun
                ? ''
                : reg
                ? '<p class="login-switch">Already have an account? <a href="#" id="login-switch">Sign in</a></p>'
                : s.signupOpen
                ? '<p class="login-switch">New here? <a href="#" id="login-switch">Create an account</a></p>'
                : '<p class="login-switch">Ask whoever runs this server to create an account for you.</p>'
            }
          </div>`;
        const sw = $('#login-switch');
        if (sw) {
          sw.onclick = (e) => {
            e.preventDefault();
            mode = reg ? 'login' : 'register';
            draw();
          };
        }
        $('#login-form').username.focus();
        $('#login-form').onsubmit = async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const err = $('#login-error');
          try {
            const { user } = await call('POST', reg ? '/api/auth/register' : '/api/auth/login', Object.fromEntries(fd));
            this.user = user;
            this.renderAccount();
            if (this.onSignedIn) this.onSignedIn();
          } catch (ex) {
            err.textContent = ex.message;
            err.hidden = false;
          }
        };
      };
      draw();
    },

    renderAccount() {
      const el = $('#account');
      const u = this.user;
      el.innerHTML = `
        <span class="presence" id="presence"></span>
        <div class="menu">
          <button class="btn account-btn" id="account-btn" title="Signed in as ${esc(u.username)}">${avatar(u)}<span>${esc(u.displayName)}</span></button>
          <div class="menu-list" id="account-menu" hidden>
            <button id="acct-password">Change password<small>Signs out your other devices</small></button>
            <button id="acct-logout">Sign out<small>Signed in as ${esc(u.username)}</small></button>
          </div>
        </div>`;
      const menu = $('#account-menu');
      $('#account-btn').onclick = (e) => {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
      };
      document.addEventListener('click', () => (menu.hidden = true));
      $('#acct-logout').onclick = async () => {
        await call('POST', '/api/auth/logout');
        location.hash = '#/';
        this.signedOut();
      };
      $('#acct-password').onclick = () => this.openPassword();
    },

    // Shows who else has this bible open; on a page, also who is on the same page.
    renderPresence(viewers, pageId) {
      const el = $('#presence');
      if (el) {
        el.innerHTML = viewers
          .map((v) => avatar(v, v.pageId === pageId && pageId ? 'on this page' : 'viewing this bible'))
          .join('');
      }
      const here = $('#page-presence');
      if (here) {
        const same = pageId ? viewers.filter((v) => v.pageId === pageId) : [];
        here.hidden = !same.length;
        here.innerHTML = same.length
          ? `${same.map((v) => avatar(v)).join('')} ${esc(same.map((v) => v.displayName).join(', '))} ${same.length === 1 ? 'is' : 'are'} also on this page. Saves from either of you are checked, so nobody's work is silently overwritten.`
          : '';
      }
    },

    dialog(title, html) {
      let el = $('#collab-modal');
      if (!el) {
        el = document.createElement('div');
        el.className = 'modal-backdrop';
        el.id = 'collab-modal';
        document.body.appendChild(el);
        el.addEventListener('click', (e) => {
          if (e.target === el || e.target.closest('[data-close]')) el.hidden = true;
        });
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') el.hidden = true;
        });
      }
      el.innerHTML = `
        <div class="modal dialog" role="dialog" aria-modal="true">
          <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">×</button></div>
          <div class="dialog-body">${html}</div>
        </div>`;
      el.hidden = false;
      return el;
    },

    async openShare(bible, onLeft) {
      const draw = (sh) => {
        const owner = this.isOwner(bible);
        const el = this.dialog(`Share “${bible.title}”`, `
          <ul class="people">
            <li>${avatar(sh.owner)}<span><b>${esc(sh.owner.displayName)}</b> <small>@${esc(sh.owner.username)}</small></span><em>Owner</em></li>
            ${sh.collaborators
              .map(
                (u) => `<li>${avatar(u)}<span><b>${esc(u.displayName)}</b> <small>@${esc(u.username)}</small></span>
                  ${
                    owner
                      ? `<button class="btn small" data-remove="${u.id}">Remove</button>`
                      : u.id === this.user.id
                      ? `<button class="btn small danger" data-remove="${u.id}">Leave</button>`
                      : '<em>Can edit</em>'
                  }</li>`
              )
              .join('')}
          </ul>
          ${
            owner
              ? `<form id="share-form" class="share-form">
                  <input name="username" placeholder="Their username" required autocapitalize="none" spellcheck="false">
                  <button class="btn primary">Share</button>
                </form>
                <p class="modal-hint">People you share with can read, edit, add and export everything in this bible. Only you can share it or delete it. They need an account on this server first.</p>`
              : '<p class="modal-hint">Only the owner can add or remove people.</p>'
          }
          <p class="login-error" id="share-error" hidden></p>`);
        const err = $('#share-error', el);
        const fail = (ex) => {
          err.textContent = ex.message;
          err.hidden = false;
        };
        const form = $('#share-form', el);
        if (form) {
          form.username.focus();
          form.onsubmit = async (e) => {
            e.preventDefault();
            try {
              draw(await call('POST', `/api/bibles/${bible.id}/sharing`, { username: form.username.value }));
            } catch (ex) {
              fail(ex);
            }
          };
        }
        el.querySelectorAll('[data-remove]').forEach((btn) => {
          btn.onclick = async () => {
            const self = btn.dataset.remove === this.user.id;
            if (self && !confirm(`Leave “${bible.title}”? You will lose access until the owner shares it again.`)) return;
            try {
              const next = await call('DELETE', `/api/bibles/${bible.id}/sharing/${btn.dataset.remove}`);
              if (self) {
                el.hidden = true;
                if (onLeft) onLeft();
              } else draw(next);
            } catch (ex) {
              fail(ex);
            }
          };
        });
      };
      draw(await call('GET', `/api/bibles/${bible.id}/sharing`));
    },

    async leave(bibleId) {
      await call('DELETE', `/api/bibles/${bibleId}/sharing/${this.user.id}`);
    },

    openPassword() {
      const el = this.dialog('Change password', `
        <form id="pw-form" class="stack-form">
          <label>Current password<input name="current" type="password" autocomplete="current-password" required></label>
          <label>New password<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
          <p class="login-error" id="pw-error" hidden></p>
          <button class="btn primary">Change password</button>
        </form>`);
      const form = $('#pw-form', el);
      form.current.focus();
      form.onsubmit = async (e) => {
        e.preventDefault();
        try {
          await call('POST', '/api/auth/password', { current: form.current.value, password: form.password.value });
          el.hidden = true;
          const t = $('#toast');
          t.textContent = 'Password changed. Your other devices were signed out.';
          t.hidden = false;
          setTimeout(() => (t.hidden = true), 2600);
        } catch (ex) {
          const err = $('#pw-error', el);
          err.textContent = ex.message;
          err.hidden = false;
        }
      };
    },

    avatar,
  };

  window.SBCollab = SB;
})();
