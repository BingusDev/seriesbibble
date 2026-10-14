/* Series Bible client: hash-routed single page app on top of the JSON API. */
(function () {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const els = {
    crumbs: $('#crumbs'),
    actions: $('#topbar-actions'),
    sidebar: $('#sidebar'),
    main: $('#main'),
    rightbar: $('#rightbar'),
    modal: $('#modal'),
    toast: $('#toast'),
  };

  // ---------- API ----------
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let data = {};
      try { data = await res.json(); } catch (_) { /* not json */ }
      if (res.status === 401) {
        state.bible = null;
        window.SBCollab.signedOut();
      }
      throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
    }
    return res.status === 204 ? null : res.json();
  }

  // ---------- State ----------
  const state = {
    bible: null,        // full bible currently open
    route: null,
    quill: null,
    pageId: null,       // page loaded in the editor
    collapsed: loadCollapsed(),
    filter: '',
    sig: null,          // server's fingerprint of the bible's sections and pages
    templates: [],      // section templates from /api/templates
  };

  // Template for a section kind; unknown kinds fall back to a blank page.
  function templateFor(kind) {
    return (
      state.templates.find((t) => t.kind === kind) ||
      state.templates.find((t) => t.kind === 'custom') || { kind: 'custom', name: 'Blank', singular: 'page', headings: [] }
    );
  }

  function loadCollapsed() {
    try { return JSON.parse(localStorage.getItem('sb.collapsed') || '{}'); } catch (_) { return {}; }
  }
  function saveCollapsed() {
    try { localStorage.setItem('sb.collapsed', JSON.stringify(state.collapsed)); } catch (_) { /* ignore */ }
  }

  const link = {
    bible: (bid) => `#/b/${bid}`,
    section: (bid, sid) => `#/b/${bid}/s/${sid}`,
    page: (bid, pid, slug) => `#/b/${bid}/p/${pid}` + (slug ? `/h/${encodeURIComponent(slug)}` : ''),
    map: (bid) => `#/b/${bid}/map`,
    trash: (bid) => `#/b/${bid}/trash`,
  };

  function findPage(pid) {
    if (!state.bible) return null;
    for (const section of state.bible.sections) {
      const page = section.pages.find((p) => p.id === pid);
      if (page) return { section, page };
    }
    return null;
  }

  // Heading list for a page's HTML, with the same de-duplicated slugs the exporter uses.
  function headingsOf(html) {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    return assignSlugs($$('h1, h2, h3', doc.body));
  }
  function assignSlugs(nodes) {
    const seen = {};
    return nodes
      .map((h) => {
        const text = h.textContent.trim();
        const base = slugify(text) || 'heading';
        seen[base] = (seen[base] || 0) + 1;
        return { el: h, text, level: Number(h.tagName[1]), slug: seen[base] > 1 ? `${base}-${seen[base]}` : base };
      })
      .filter((h) => h.text);
  }
  // Each section gets a binder-tab colour by its place in the bible, so neighbours never share one.
  function tab(section) {
    const i = Math.max(0, state.bible.sections.indexOf(section));
    return `--tab: var(--tab-${i % 8})`;
  }

  function excerpt(html, n = 160) {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    $$('h1, h2, h3', doc.body).forEach((h) => h.remove());
    const text = doc.body.textContent.replace(/\s+/g, ' ').trim();
    return text.length > n ? text.slice(0, n) + '…' : text;
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (els.toast.hidden = true), 2600);
  }

  // ---------- Saving ----------
  const saver = {
    timer: null,
    pending: null,
    inflight: null,     // promise of the save on the wire, so saves never overlap
    conflict: null,     // page id whose save was refused because someone else changed it
    status(text) {
      const el = $('#save-state');
      if (el) el.textContent = text;
    },
    queue(pid, patch, delay = 700) {
      if (this.pending && this.pending.pid !== pid) this.flush();
      this.pending = { pid, patch: Object.assign(this.pending ? this.pending.patch : {}, patch) };
      this.status('Unsaved…');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), delay);
    },
    async flush() {
      clearTimeout(this.timer);
      while (this.inflight) await this.inflight;
      const job = this.pending;
      if (!job || !state.bible) return;
      if (this.conflict === job.pid) return; // waits for the person to pick a version
      this.pending = null;
      this.status('Saving…');
      const found = findPage(job.pid);
      const patch = { ...job.patch, baseRev: found ? found.page.rev || 0 : undefined };
      const bid = state.bible.id;
      this.inflight = (async () => {
        try {
          const page = await api('PATCH', `/api/bibles/${bid}/pages/${job.pid}`, patch);
          const now = findPage(job.pid);
          if (now) Object.assign(now.page, { rev: page.rev, updatedBy: page.updatedBy, updatedAt: page.updatedAt });
          if (!this.pending) this.status('Saved');
        } catch (err) {
          if (err.status === 409 && err.data && err.data.page) {
            // Put the edit back so "Keep mine" can send it again.
            this.pending = { pid: job.pid, patch: Object.assign(job.patch, this.pending ? this.pending.patch : {}) };
            this.conflict = job.pid;
            this.status('Not saved');
            showConflict(job.pid, err.data.page);
          } else {
            this.status('Save failed');
            toast(`Could not save: ${err.message}`);
          }
        }
      })();
      try {
        await this.inflight;
      } finally {
        this.inflight = null;
      }
    },
    busyWith(pid) {
      return !!((this.pending && this.pending.pid === pid) || this.inflight || this.conflict === pid);
    },
  };
  window.addEventListener('beforeunload', (e) => {
    if (saver.pending) {
      saver.flush();
      e.preventDefault();
    }
  });

  // ---------- Router ----------
  function parseRoute() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (parts[0] !== 'b' || !parts[1]) return { name: 'home' };
    const r = { bid: parts[1], name: 'bible' };
    if (parts[2] === 's' && parts[3]) Object.assign(r, { name: 'section', sid: parts[3] });
    if (parts[2] === 'p' && parts[3]) Object.assign(r, { name: 'page', pid: parts[3] });
    if (parts[2] === 'map') r.name = 'map';
    if (parts[2] === 'trash') r.name = 'trash';
    if (r.name === 'page' && parts[4] === 'h' && parts[5]) r.slug = decodeURIComponent(parts[5]);
    return r;
  }

  async function route() {
    const r = parseRoute();
    const prev = state.route;
    state.route = r;
    document.body.classList.remove('side-open');
    await saver.flush();
    // A refused save has to be settled on its own page before going elsewhere.
    if (saver.conflict && state.bible && !(r.name === 'page' && r.pid === saver.conflict)) {
      toast('Choose which version of this page to keep first.');
      location.hash = link.page(state.bible.id, saver.conflict);
      return;
    }

    if (r.name === 'home') {
      setFocusMode(false);
      state.bible = null;
      return renderHome();
    }
    if (!state.bible || state.bible.id !== r.bid) {
      try {
        state.bible = await api('GET', `/api/bibles/${r.bid}`);
        state.sig = null;
      } catch (err) {
        if (err.status === 401) return;
        toast('That series bible could not be found.');
        location.hash = '#/';
        return;
      }
    }
    renderSidebar();
    renderTopbar();
    if (r.name !== 'page') setFocusMode(false);
    if (r.name === 'page') {
      // Jumping between headings on the open page should not reload the editor.
      if (prev && prev.name === 'page' && prev.pid === r.pid && state.quill && state.pageId === r.pid) {
        scrollToHeading(r.slug);
        renderCrumbs();
        return;
      }
      return renderPage(r.pid, r.slug);
    }
    if (r.name === 'section') return renderSection(r.sid);
    if (r.name === 'map') {
      teardownEditor();
      return RelMap.render(relCtx());
    }
    if (r.name === 'trash') {
      teardownEditor();
      els.rightbar.hidden = true;
      return SBHistory.renderTrash(historyCtx());
    }
    return renderOverview();
  }
  window.addEventListener('hashchange', route);

  // ---------- Theme (paper or night draft) ----------
  // index.html sets the starting theme before paint; this keeps the toggle and the system setting in sync.
  const ICONS = {
    moon: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
    sun: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></svg>',
  };
  const themeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#1c1915' : '#f7f3ea';
    const btn = $('#theme-btn');
    const next = theme === 'dark' ? 'paper' : 'night draft';
    btn.innerHTML = theme === 'dark' ? ICONS.sun : ICONS.moon;
    btn.title = `Switch to ${next}`;
    btn.setAttribute('aria-label', `Switch to ${next}`);
  }
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  $('#theme-btn').onclick = () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('sb-theme', theme); } catch {}
    applyTheme(theme);
  };
  themeQuery.addEventListener('change', (e) => {
    let saved = null;
    try { saved = localStorage.getItem('sb-theme'); } catch {}
    if (!saved) applyTheme(e.matches ? 'dark' : 'light');
  });

  // ---------- Top bar ----------
  function renderCrumbs() {
    const r = state.route;
    const b = state.bible;
    const bits = [];
    if (b) bits.push(`<a href="${link.bible(b.id)}">${esc(b.title)}</a>`);
    if (b && r.name === 'section') {
      const s = b.sections.find((x) => x.id === r.sid);
      if (s) bits.push(`<span>${esc(s.name)}</span>`);
    }
    if (b && r.name === 'map') bits.push('<span>Relationship map</span>');
    if (b && r.name === 'trash') bits.push('<span>Trash</span>');
    if (b && r.name === 'page') {
      const f = findPage(r.pid);
      if (f) {
        bits.push(`<a href="${link.section(b.id, f.section.id)}">${esc(f.section.name)}</a>`);
        bits.push(`<span>${esc(f.page.title)}</span>`);
      }
    }
    els.crumbs.innerHTML = bits.join('<span class="sep">›</span>');
  }

  function renderTopbar() {
    renderCrumbs();
    if (!state.bible) {
      els.actions.innerHTML = '';
      return;
    }
    const id = state.bible.id;
    els.actions.innerHTML = `
      <button class="btn side-toggle" id="side-toggle" aria-label="Sections">☰<span class="lbl"> Sections</span></button>
      <span class="save-state" id="save-state"></span>
      <button class="btn" id="jump-btn" title="Jump to (Ctrl+K)" aria-label="Jump to"><svg class="btn-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.5-4.5"/></svg><span class="lbl">Jump to…</span><kbd>${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K"}</kbd></button>
      <button class="btn" id="share-btn" title="Share this bible with other people">Share</button>
      <div class="menu">
        <button class="btn primary" id="export-btn">Export ▾</button>
        <div class="menu-list" id="export-menu" hidden>
          <a href="/api/bibles/${id}/export.pdf" data-export>PDF<small>Print-ready, links stay clickable</small></a>
          <a href="/api/bibles/${id}/export.docx" data-export>Word (.docx)<small>Editable, with cross-reference links</small></a>
          <a href="/api/bibles/${id}/export.json" data-export>Backup (.json)<small>Full copy of this bible's data</small></a>
        </div>
      </div>`;
    $('#side-toggle').onclick = () => document.body.classList.toggle('side-open');
    $('#jump-btn').onclick = () => openPicker('jump');
    $('#share-btn').onclick = () =>
      window.SBCollab.openShare(state.bible, () => {
        state.bible = null;
        location.hash = '#/';
      });
    const menu = $('#export-menu');
    $('#export-btn').onclick = (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    };
    $$('[data-export]', menu).forEach((a) =>
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        menu.hidden = true;
        await saver.flush();
        toast('Preparing your export…');
        try {
          const res = await fetch(a.getAttribute('href'));
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
          const name = (res.headers.get('Content-Disposition') || '').match(/filename="?([^";]+)"?/);
          const url = URL.createObjectURL(await res.blob());
          const tmp = Object.assign(document.createElement('a'), { href: url, download: name ? name[1] : 'series-bible' });
          document.body.appendChild(tmp);
          tmp.click();
          tmp.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          toast('Export ready');
        } catch (err) {
          toast(`Export failed: ${err.message}`);
        }
      })
    );
  }
  document.addEventListener('click', () => {
    const m = $('#export-menu');
    if (m) m.hidden = true;
  });

  // ---------- Home ----------
  async function renderHome() {
    els.sidebar.hidden = true;
    els.rightbar.hidden = true;
    state.quill = null;
    state.pageId = null;
    renderTopbar();
    els.crumbs.innerHTML = '';
    document.title = 'Series Bible';
    const bibles = await api('GET', '/api/bibles');
    els.main.innerHTML = `
      <div class="home">
        <h1>Your series bibles</h1>
        <p class="lede">Each bible starts with Characters and World sections. Add any other sections you need.</p>
        <form class="new-bible" id="new-bible">
          <input name="title" placeholder="Series title, e.g. The Lighthouse Keepers" required maxlength="200">
          <input name="logline" placeholder="Logline (optional)" maxlength="500">
          <button class="btn primary">Create bible</button>
        </form>
        <div class="bible-list">
          ${bibles.length ? '' : '<p class="lede">No bibles yet. Create your first one above.</p>'}
          ${bibles
            .map(
              (b) => `
            <div class="bible-card">
              <a href="${link.bible(b.id)}"><span class="tp-kicker">Series Bible</span><h3>${esc(b.title)}</h3>
              ${b.logline ? `<p>${esc(b.logline)}</p>` : ''}
              <small><span>${
                b.role === 'owner'
                  ? b.collaboratorCount ? `Shared with ${b.collaboratorCount} ${b.collaboratorCount === 1 ? 'person' : 'people'}` : ''
                  : `Shared by ${esc(b.owner ? b.owner.displayName : 'someone')}`
              }</span><span title="${esc(new Date(b.updatedAt).toLocaleString())}">Edited ${new Date(b.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span></small></a>
              ${
                b.role === 'owner'
                  ? `<button class="icon-btn" data-delete="${b.id}" data-title="${esc(b.title)}" title="Delete">🗑</button>`
                  : `<button class="icon-btn leave" data-leave="${b.id}" data-title="${esc(b.title)}" title="Stop seeing this shared bible">Leave</button>`
              }
            </div>`
            )
            .join('')}
        </div>
      </div>`;
    $('#new-bible').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const b = await api('POST', '/api/bibles', { title: fd.get('title'), logline: fd.get('logline') });
      location.hash = link.bible(b.id);
    };
    $$('[data-delete]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm(`Delete "${btn.dataset.title}" and everything in it? This cannot be undone.`)) return;
        await api('DELETE', `/api/bibles/${btn.dataset.delete}`);
        renderHome();
      };
    });
    $$('[data-leave]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm(`Leave "${btn.dataset.title}"? You will lose access until the owner shares it again.`)) return;
        await window.SBCollab.leave(btn.dataset.leave);
        renderHome();
      };
    });
  }

  // ---------- Sidebar ----------
  function renderSidebar() {
    const b = state.bible;
    const r = state.route;
    const activeSection = r.name === 'section' ? r.sid : r.name === 'page' ? (findPage(r.pid) || {}).section?.id : null;
    const q = state.filter.toLowerCase();
    els.sidebar.hidden = false;
    els.sidebar.innerHTML = `
      <div class="side-head">
        <a class="side-title" href="${link.bible(b.id)}"><small>Series Bible</small><span>${esc(b.title)}</span></a>
        <input class="side-filter" id="side-filter" type="search" placeholder="Filter pages…" value="${esc(state.filter)}">
        <a class="side-map ${r.name === 'map' ? 'active' : ''}" href="${link.map(b.id)}">◎ Relationship map</a>
      </div>
      ${b.sections
        .map((s) => {
          const pages = q ? s.pages.filter((p) => p.title.toLowerCase().includes(q)) : s.pages;
          const collapsed = state.collapsed[s.id] && !q;
          return `
        <div class="section ${s.id === activeSection ? 'active' : ''} ${collapsed ? 'collapsed' : ''}" data-sid="${s.id}" style="${tab(s)}">
          <div class="section-head">
            <button class="icon-btn twisty" data-toggle="${s.id}" aria-label="Collapse">${collapsed ? '▶' : '▼'}</button><span class="tab"></span>
            <a href="${link.section(b.id, s.id)}" title="${esc(s.name)}">${esc(s.name)}</a>
            <span class="count">${s.pages.length}</span>
            <button class="icon-btn" data-add-page="${s.id}" title="Add page to ${esc(s.name)}">＋</button>
          </div>
          <ul class="pages">
            ${pages
              .map(
                (p) => `<li draggable="true" data-pid="${p.id}" class="${r.pid === p.id ? 'active' : ''}">
                  <a href="${link.page(b.id, p.id)}">${esc(p.title)}</a></li>`
              )
              .join('') || `<li class="empty">${q ? 'No matches' : 'No pages yet'}</li>`}
          </ul>
        </div>`;
        })
        .join('')}
      <button class="btn add-section" id="add-section">＋ Add section</button>
      <a class="side-trash ${r.name === 'trash' ? 'active' : ''}" href="${link.trash(b.id)}">Trash</a>`;

    const filter = $('#side-filter');
    filter.oninput = () => {
      state.filter = filter.value;
      renderSidebar();
      const f = $('#side-filter');
      f.focus();
      f.setSelectionRange(f.value.length, f.value.length);
    };
    $$('[data-toggle]', els.sidebar).forEach((btn) => {
      btn.onclick = () => {
        state.collapsed[btn.dataset.toggle] = !state.collapsed[btn.dataset.toggle];
        saveCollapsed();
        renderSidebar();
      };
    });
    $$('[data-add-page]', els.sidebar).forEach((btn) => (btn.onclick = () => addPage(btn.dataset.addPage)));
    $('#add-section').onclick = addSection;
    wireDragAndDrop();
  }

  function wireDragAndDrop() {
    let dragPid = null;
    const clear = () => $$('.drop-before, .drop-into', els.sidebar).forEach((el) => el.classList.remove('drop-before', 'drop-into'));
    $$('.pages li[data-pid]', els.sidebar).forEach((li) => {
      li.addEventListener('dragstart', (e) => {
        dragPid = li.dataset.pid;
        li.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragPid);
      });
      li.addEventListener('dragend', () => {
        li.classList.remove('dragging');
        clear();
      });
      li.addEventListener('dragover', (e) => {
        if (!dragPid) return;
        e.preventDefault();
        clear();
        li.classList.add('drop-before');
      });
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const sid = li.closest('.section').dataset.sid;
        const section = state.bible.sections.find((s) => s.id === sid);
        let position = section.pages.findIndex((p) => p.id === li.dataset.pid);
        const from = section.pages.findIndex((p) => p.id === dragPid);
        if (from > -1 && from < position) position -= 1;
        movePage(dragPid, sid, position);
      });
    });
    $$('.section', els.sidebar).forEach((sec) => {
      sec.addEventListener('dragover', (e) => {
        if (!dragPid || e.target.closest('li[data-pid]')) return;
        e.preventDefault();
        clear();
        sec.classList.add('drop-into');
      });
      sec.addEventListener('drop', (e) => {
        if (!dragPid) return;
        e.preventDefault();
        const section = state.bible.sections.find((s) => s.id === sec.dataset.sid);
        movePage(dragPid, section.id, section.pages.filter((p) => p.id !== dragPid).length);
      });
    });
  }

  async function movePage(pid, sectionId, position) {
    await saver.flush();
    await api('PATCH', `/api/bibles/${state.bible.id}/pages/${pid}`, { sectionId, position });
    state.bible = await api('GET', `/api/bibles/${state.bible.id}`);
    renderSidebar();
    renderCrumbs();
  }

  async function addPage(sid) {
    const section = state.bible.sections.find((s) => s.id === sid);
    const singular = templateFor(section.kind).singular;
    const title = prompt(`Name of the new ${singular} in ${section.name}:`);
    if (!title || !title.trim()) return;
    const page = await api('POST', `/api/bibles/${state.bible.id}/sections/${sid}/pages`, { title: title.trim() });
    section.pages.push(page);
    state.collapsed[sid] = false;
    location.hash = link.page(state.bible.id, page.id);
  }

  // Add-section dialog: pick a template, which also suggests the section name.
  function addSection() {
    const b = state.bible;
    const choices = state.templates.length ? state.templates : [templateFor('custom')];
    const used = new Set(b.sections.map((s) => s.kind));
    const first = choices.find((t) => !used.has(t.kind)) || choices[choices.length - 1];
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <form class="modal tmpl-modal" role="dialog" aria-modal="true" aria-labelledby="tmpl-title">
        <div class="modal-head">
          <h2 id="tmpl-title">Add a section</h2>
          <button type="button" class="icon-btn" data-close aria-label="Close">×</button>
        </div>
        <div class="tmpl-body">
          <p class="tmpl-label">Template</p>
          <div class="tmpl-grid">
            ${choices
              .map(
                (t) => `
              <label class="tmpl-card">
                <input type="radio" name="kind" value="${esc(t.kind)}" ${t === first ? 'checked' : ''}>
                <strong>${esc(t.name)}${used.has(t.kind) && t.kind !== 'custom' ? ' <small>in use</small>' : ''}</strong>
                <span>${esc(t.description || '')}</span>
                ${t.headings.length ? `<em>${t.headings.map((h) => esc(h.title)).join(' · ')}</em>` : ''}
              </label>`
              )
              .join('')}
          </div>
          <label class="tmpl-label" for="tmpl-name">Section name</label>
          <input class="modal-search tmpl-name" id="tmpl-name" name="name" required maxlength="200" autocomplete="off">
        </div>
        <div class="modal-foot">
          <button type="button" class="btn" data-close>Cancel</button>
          <button class="btn primary">Add section</button>
        </div>
      </form>`;
    document.body.appendChild(wrap);
    const form = $('form', wrap);
    const nameInput = $('#tmpl-name', wrap);
    let suggested = first.kind === 'custom' ? '' : first.name;
    nameInput.value = suggested;
    // Picking a template renames the section unless the writer typed their own name.
    form.onchange = (e) => {
      if (e.target.name !== 'kind') return;
      const t = templateFor(e.target.value);
      const next = t.kind === 'custom' ? '' : t.name;
      if (!nameInput.value.trim() || nameInput.value === suggested) nameInput.value = next;
      suggested = next;
    };
    const close = () => wrap.remove();
    wrap.onclick = (e) => {
      if (e.target === wrap || e.target.closest('[data-close]')) close();
    };
    wrap.onkeydown = (e) => {
      if (e.key === 'Escape') close();
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return;
      const kind = new FormData(form).get('kind');
      try {
        const section = await api('POST', `/api/bibles/${b.id}/sections`, { name, kind });
        close();
        b.sections.push(section);
        location.hash = link.section(b.id, section.id);
      } catch (err) {
        toast(`Could not add section: ${err.message}`);
      }
    };
    nameInput.focus();
    nameInput.select();
  }

  // ---------- Overview ----------
  function renderOverview() {
    const b = state.bible;
    teardownEditor();
    els.rightbar.hidden = true;
    document.title = `${b.title} · Series Bible`;
    els.main.innerHTML = `
      <div class="sheet overview">
        <span class="eyebrow">Series Bible</span>
        <h1><input class="inline-edit" id="bible-title" value="${esc(b.title)}" maxlength="200" aria-label="Series title"></h1>
        <textarea class="inline-edit logline" id="bible-logline" placeholder="Add a logline…" maxlength="2000">${esc(b.logline)}</textarea>
        ${b.sections
          .map(
            (s) => `
          <div class="section-block" style="${tab(s)}">
            <h2><a href="${link.section(b.id, s.id)}">${esc(s.name)}</a><span class="count">${s.pages.length} ${s.pages.length === 1 ? 'page' : 'pages'}</span></h2>
            <div class="cards">
              ${s.pages
                .map(
                  (p) => `<a class="card" href="${link.page(b.id, p.id)}"><strong>${esc(p.title)}</strong><span>${esc(excerpt(p.content)) || '<em>Empty</em>'}</span></a>`
                )
                .join('')}
              <button class="card add" data-add-page="${s.id}">＋ Add to ${esc(s.name)}</button>
            </div>
          </div>`
          )
          .join('')}
      </div>`;
    const saveMeta = debounce(async () => {
      const t = $('#bible-title').value.trim() || 'Untitled Series';
      const updated = await api('PATCH', `/api/bibles/${b.id}`, { title: t, logline: $('#bible-logline').value });
      b.title = updated.title;
      b.logline = updated.logline;
      $('.side-title span').textContent = b.title;
      renderCrumbs();
    }, 600);
    $('#bible-title').oninput = saveMeta;
    $('#bible-logline').oninput = saveMeta;
    $$('[data-add-page]', els.main).forEach((btn) => (btn.onclick = () => addPage(btn.dataset.addPage)));
  }

  // ---------- Section ----------
  function renderSection(sid) {
    const b = state.bible;
    const s = b.sections.find((x) => x.id === sid);
    teardownEditor();
    els.rightbar.hidden = true;
    if (!s) {
      els.main.innerHTML = '<div class="sheet"><p>This section no longer exists.</p></div>';
      return;
    }
    document.title = `${s.name} · ${b.title}`;
    els.main.innerHTML = `
      <div class="sheet overview" style="${tab(s)}">
        <a class="eyebrow" href="${link.bible(b.id)}">${esc(b.title)}</a>
        <h1><input class="inline-edit" id="section-name" value="${esc(s.name)}" maxlength="200" aria-label="Section name"></h1>
        <div class="page-meta"><span>${s.pages.length} ${s.pages.length === 1 ? 'page' : 'pages'} · drag pages in the sidebar to reorder</span>
          <span>
            <button class="btn small" id="sec-up" ${b.sections[0] === s ? 'disabled' : ''}>Move up</button>
            <button class="btn small" id="sec-down" ${b.sections[b.sections.length - 1] === s ? 'disabled' : ''}>Move down</button>
            <button class="btn small danger" id="sec-delete">Delete section</button>
          </span></div>
        <div class="tmpl-row">
          <label class="tmpl-select">New pages use
            <select id="sec-kind">${(state.templates.length ? state.templates : [templateFor(s.kind)])
              .map((t) => `<option value="${esc(t.kind)}" ${t.kind === templateFor(s.kind).kind ? 'selected' : ''}>${esc(t.name)} template</option>`)
              .join('')}</select>
          </label>
        </div>
        <div class="cards">
          ${s.pages
            .map(
              (p) => `<a class="card" href="${link.page(b.id, p.id)}"><strong>${esc(p.title)}</strong><span>${esc(excerpt(p.content)) || '<em>Empty</em>'}</span></a>`
            )
            .join('')}
          <button class="card add" id="sec-add">＋ Add to ${esc(s.name)}</button>
        </div>
      </div>`;
    $('#sec-add').onclick = () => addPage(s.id);
    $('#sec-kind').onchange = async (e) => {
      const kind = e.target.value;
      await api('PATCH', `/api/bibles/${b.id}/sections/${s.id}`, { kind });
      s.kind = kind;
      toast(`New pages in ${s.name} will use the ${templateFor(kind).name} template.`);
    };
    $('#section-name').oninput = debounce(async () => {
      const name = $('#section-name').value.trim();
      if (!name) return;
      await api('PATCH', `/api/bibles/${b.id}/sections/${s.id}`, { name });
      s.name = name;
      renderSidebar();
      renderCrumbs();
    }, 600);
    const move = async (delta) => {
      const pos = b.sections.indexOf(s) + delta;
      await api('PATCH', `/api/bibles/${b.id}/sections/${s.id}`, { position: pos });
      b.sections.splice(b.sections.indexOf(s), 1);
      b.sections.splice(pos, 0, s);
      renderSidebar();
      renderSection(s.id);
    };
    $('#sec-up').onclick = () => move(-1);
    $('#sec-down').onclick = () => move(1);
    $('#sec-delete').onclick = async () => {
      const n = s.pages.length;
      if (!confirm(`Delete the "${s.name}" section${n ? `? Its ${n} page${n === 1 ? '' : 's'} will go to the trash, where you can restore ${n === 1 ? 'it' : 'them'}.` : '?'}`)) return;
      await api('DELETE', `/api/bibles/${b.id}/sections/${s.id}`);
      b.sections = b.sections.filter((x) => x !== s);
      location.hash = link.bible(b.id);
    };
  }

  // ---------- Page editor ----------
  function teardownEditor() {
    state.quill = null;
    state.pageId = null;
    promptStyle.textContent = '';
    promptsOnResize = null;
  }

  // Formats the toolbar offers. Anything else a paste brings along (colours, highlights,
  // fonts, sizes) is dropped, so text from Word or the web matches the page and night draft.
  const EDITOR_FORMATS = ['header', 'bold', 'italic', 'underline', 'strike', 'list', 'indent', 'blockquote', 'align', 'link', 'image'];

  // Writing prompts show as faint text in the blank line under each template heading, until
  // the writer types there. They live in a generated stylesheet, never in the page itself.
  const promptStyle = document.head.appendChild(document.createElement('style'));
  let promptsOnResize = null;
  window.addEventListener('resize', () => promptsOnResize && promptsOnResize());
  const cssString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
  function renderPrompts(quill, tmpl) {
    if (state.quill !== quill) return;
    const prompts = new Map(tmpl.headings.map((h) => [h.title.trim().toLowerCase(), h.prompt]));
    if (!prompts.size) return (promptStyle.textContent = '');
    const targets = [];
    [...quill.root.children].forEach((el, i) => {
      if (!/^H[1-3]$/.test(el.tagName)) return;
      const text = prompts.get(el.textContent.trim().toLowerCase());
      const next = el.nextElementSibling;
      if (!text || !next || next.tagName !== 'P' || next.textContent || next.querySelector('img')) return;
      targets.push({ sel: `.editor-wrap .ql-editor > :nth-child(${i + 1}) + p:has(> br:only-child)`, text, p: next });
    });
    promptStyle.textContent = targets.map((t) => `${t.sel}::before { content: ${cssString(t.text)}; }`).join('\n');
    // The prompt floats over its blank line like a placeholder, so the caret sits at the start
    // of the line; a prompt that wraps gets the line stretched to fit, so it never covers the next heading.
    const extra = targets
      .map((t) => ({ ...t, h: parseFloat(getComputedStyle(t.p, '::before').height) }))
      .filter((t) => t.h > t.p.offsetHeight)
      .map((t) => `${t.sel} { min-height: ${Math.ceil(t.h)}px; }`);
    if (extra.length) promptStyle.textContent += '\n' + extra.join('\n');
  }

  // Puts the caret on the first line that isn't a heading, so a new page's first sentence
  // doesn't land in its "Overview" heading.
  function caretToBody(quill) {
    const line = quill.getLines().find((l) => l.statics.blotName !== 'header');
    quill.focus();
    quill.setSelection(line ? quill.getIndex(line) : quill.getLength() - 1, 0, 'silent');
  }

  const bodyIsEmpty = (quill) =>
    !quill.getLines().some((l) => l.statics.blotName !== 'header' && /\S/.test(quill.getText(quill.getIndex(l), l.length())));

  const countWords = (text) => (text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []).length;
  function renderWordCount(quill) {
    const el = $('#word-count');
    if (!el || state.quill !== quill) return;
    // Headings are the page's scaffolding, so only the writing under them counts.
    const total = quill
      .getLines()
      .filter((l) => l.statics.blotName !== 'header')
      .reduce((n, l) => n + countWords(quill.getText(quill.getIndex(l), l.length())), 0);
    const sel = quill.getSelection();
    const picked = sel && sel.length ? countWords(quill.getText(sel.index, sel.length)) : 0;
    const n = (x) => x.toLocaleString();
    el.textContent = picked ? `${n(picked)} of ${n(total)} words` : `${n(total)} ${total === 1 ? 'word' : 'words'}`;
  }

  // Focus mode hides everything but the page. It stays on while moving between pages.
  function setFocusMode(on) {
    document.body.classList.toggle('focus-mode', on);
    const btn = $('#focus-btn');
    if (btn) btn.setAttribute('aria-pressed', String(on));
    if (on && state.quill) state.quill.focus();
  }

  function renderPage(pid, slug) {
    const b = state.bible;
    const found = findPage(pid);
    teardownEditor();
    if (!found) {
      els.rightbar.hidden = true;
      els.main.innerHTML = `<div class="sheet"><h2>Page not found</h2><p>This link points to a page that was deleted or moved to another bible. Deleted pages can be restored from the <a href="${link.trash(b.id)}">Trash</a>.</p><p><a href="${link.bible(b.id)}">Back to ${esc(b.title)}</a></p></div>`;
      return;
    }
    const { page, section } = found;
    const tmpl = templateFor(section.kind);
    document.title = `${page.title} · ${b.title}`;
    els.main.innerHTML = `
      <div class="sheet editor-wrap" style="${tab(section)}">
        <a class="eyebrow" href="${link.section(b.id, section.id)}">${esc(section.name)}</a>
        <input class="page-title-input" id="page-title" value="${esc(page.title)}" maxlength="200" aria-label="Page title">
        <div class="page-meta">
          <span>Tip: select text and press <b>§ Link</b> to link it to any section, page or heading.</span>
          <span class="last-edit" id="last-edit">${page.updatedBy ? `Last edited by ${esc(page.updatedBy)}` : ''}</span>
          <span class="word-count" id="word-count" aria-live="off"></span>
          <button class="btn small" id="focus-btn" aria-pressed="false" title="Hide everything but the page (Ctrl+Shift+F)">Focus</button>
          <button class="btn small" id="page-history" title="See and restore earlier versions of this page">History</button>
          <button class="btn small danger" id="page-delete">Delete page</button>
        </div>
        <div class="page-presence" id="page-presence" hidden></div>
        <div class="conflict" id="conflict" hidden></div>
        <div id="toolbar">
          <span class="ql-formats">
            <select class="ql-header"><option value="1">Heading 1</option><option value="2">Heading 2</option><option value="3">Heading 3</option><option selected>Body</option></select>
          </span>
          <span class="ql-formats"><button class="ql-bold"></button><button class="ql-italic"></button><button class="ql-underline"></button><button class="ql-strike"></button></span>
          <span class="ql-formats"><button class="ql-list" value="ordered"></button><button class="ql-list" value="bullet"></button><button class="ql-blockquote"></button></span>
          <span class="ql-formats"><button class="ql-align" value=""></button><button class="ql-align" value="center"></button></span>
          <span class="ql-formats"><button class="ql-link" title="Web link"></button><button class="ql-xref" title="Link to a section, page or heading in this bible (Ctrl+L)">§ Link</button></span>
          <span class="ql-formats"><button class="ql-clean"></button></span>
        </div>
        <div id="editor"></div>
      </div>
      <button class="btn small focus-exit" id="focus-exit" type="button" title="Leave focus mode (Esc)">Exit focus</button>`;

    const quill = new Quill('#editor', {
      theme: 'snow',
      placeholder: 'Start writing…',
      formats: EDITOR_FORMATS,
      modules: {
        toolbar: { container: '#toolbar', handlers: { xref: () => openPicker('link') } },
        keyboard: {
          bindings: {
            xref: { key: 'l', shortKey: true, handler: () => { openPicker('link'); return false; } },
            focus: { key: 'f', shortKey: true, shiftKey: true, handler: () => { setFocusMode(!document.body.classList.contains('focus-mode')); return false; } },
          },
        },
      },
    });
    // Pasted headings deeper than the toolbar's three levels become Heading 3.
    quill.clipboard.addMatcher(Node.ELEMENT_NODE, (node, delta) => {
      for (const op of delta.ops) if (op.attributes && op.attributes.header > 3) op.attributes.header = 3;
      return delta;
    });
    quill.clipboard.dangerouslyPasteHTML(page.content || '');
    quill.history.clear();
    state.quill = quill;
    state.pageId = pid;

    const refreshPrompts = debounce(() => renderPrompts(quill, tmpl), 60);
    const refreshCount = debounce(() => renderWordCount(quill), 200);
    renderPrompts(quill, tmpl);
    renderWordCount(quill);
    promptsOnResize = refreshPrompts;
    quill.on('text-change', (delta, old, source) => {
      refreshPrompts();
      refreshCount();
      if (source !== 'user') return;
      page.content = quill.root.innerHTML;
      saver.queue(pid, { content: page.content });
      renderOutline();
    });
    quill.on('selection-change', refreshCount);

    // Internal links navigate inside the app instead of opening a new tab.
    quill.root.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#/"]');
      if (!a) return;
      e.preventDefault();
      location.hash = a.getAttribute('href');
    });
    const preview = $('.ql-tooltip a.ql-preview', els.main);
    if (preview) {
      preview.addEventListener('click', (e) => {
        const href = preview.getAttribute('href') || '';
        const internal = href.indexOf('#/') > -1 ? href.slice(href.indexOf('#/')) : null;
        if (internal) {
          e.preventDefault();
          location.hash = internal;
        }
      });
    }

    const titleInput = $('#page-title');
    titleInput.oninput = () => {
      const t = titleInput.value.trim();
      if (!t) return;
      page.title = t;
      saver.queue(pid, { title: t });
      const li = $(`.pages li[data-pid="${pid}"] a`, els.sidebar);
      if (li) li.textContent = t;
      renderCrumbs();
      document.title = `${t} · ${b.title}`;
    };
    titleInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        caretToBody(quill);
      }
    };
    $('#focus-btn').onclick = () => setFocusMode(!document.body.classList.contains('focus-mode'));
    $('#focus-exit').onclick = () => setFocusMode(false);
    setFocusMode(document.body.classList.contains('focus-mode'));
    $('#page-delete').onclick = async () => {
      if (!confirm(`Move "${page.title}" to the trash? Links to it stop working until it is restored.`)) return;
      await saver.flush();
      saver.pending = null;
      await api('DELETE', `/api/bibles/${b.id}/pages/${pid}`);
      section.pages = section.pages.filter((p) => p.id !== pid);
      location.hash = link.section(b.id, section.id);
      toast(`Moved "${page.title}" to the trash.`);
    };
    $('#page-history').onclick = () =>
      SBHistory.openHistory({
        ...historyCtx(),
        page,
        flush: () => saver.flush(),
        onRestore: (fresh) => {
          if (state.pageId !== pid) return Object.assign(page, fresh);
          loadIntoEditor(page, fresh);
          saver.status('Saved');
          renderSidebar();
          renderCrumbs();
          document.title = `${page.title} · ${b.title}`;
        },
      });

    renderOutline();
    els.main.scrollTop = 0;
    if (slug) requestAnimationFrame(() => scrollToHeading(slug));
    else if (bodyIsEmpty(quill)) caretToBody(quill);
  }

  function editorHeadings() {
    return state.quill ? assignSlugs($$('h1, h2, h3', state.quill.root)) : [];
  }

  function scrollToHeading(slug) {
    if (!slug) {
      els.main.scrollTop = 0;
      return;
    }
    const h = editorHeadings().find((x) => x.slug === slug);
    if (!h) {
      toast('That heading no longer exists on this page.');
      return;
    }
    const top = h.el.getBoundingClientRect().top - els.main.getBoundingClientRect().top + els.main.scrollTop - 70;
    els.main.scrollTo({ top, behavior: 'smooth' });
    h.el.classList.remove('flash');
    void h.el.offsetWidth;
    h.el.classList.add('flash');
    setTimeout(() => h.el.classList.remove('flash'), 1700);
  }

  // Right bar: headings on this page, and which pages link here.
  const renderOutline = debounce(() => {
    if (!state.quill || !state.bible) return;
    const b = state.bible;
    const pid = state.pageId;
    const heads = editorHeadings();
    const back = [];
    for (const s of b.sections) {
      for (const p of s.pages) {
        if (p.id !== pid && (p.content || '').includes(`#/b/${b.id}/p/${pid}`)) back.push({ s, p });
      }
    }
    els.rightbar.hidden = false;
    els.rightbar.innerHTML = `
      <h3>On this page</h3>
      <ul>${heads.map((h) => `<li class="h${h.level}"><a href="${link.page(b.id, pid, h.slug)}">${esc(h.text)}</a></li>`).join('') || '<li class="none">Add headings to build an outline.</li>'}</ul>
      <h3>Linked from</h3>
      <ul>${back.map(({ s, p }) => `<li><a href="${link.page(b.id, p.id)}">${esc(p.title)}<small>${esc(s.name)}</small></a></li>`).join('') || '<li class="none">No other pages link here yet.</li>'}</ul>
      ${RelMap.panel(relCtx(), pid)}`;
    RelMap.wirePanel(relCtx(), els.rightbar, renderOutline);
  }, 150);

  // ---------- Picker (jump to / insert cross-reference) ----------
  // Every section, page and heading, plus each page's text split into blocks that
  // remember the heading above them, so a text match can jump straight to its heading.
  function pickerItems() {
    const b = state.bible;
    const items = [];
    for (const s of b.sections) {
      items.push({ kind: 'Section', label: s.name, where: `${s.pages.length} pages`, href: link.section(b.id, s.id) });
      for (const p of s.pages) {
        const content = p.id === state.pageId && state.quill ? state.quill.root.innerHTML : p.content;
        const doc = new DOMParser().parseFromString(content || '', 'text/html');
        const heads = assignSlugs($$('h1, h2, h3', doc.body));
        const slugOf = new Map(heads.map((h) => [h.el, h.slug]));
        const blocks = [];
        let slug = null;
        for (const el of doc.body.children) {
          if (slugOf.has(el)) { slug = slugOf.get(el); continue; }
          const text = el.textContent.replace(/\s+/g, ' ').trim();
          if (text) blocks.push({ text, slug });
        }
        items.push({ kind: 'Page', label: p.title, where: s.name, href: link.page(b.id, p.id), page: p, section: s, blocks });
        for (const h of heads) {
          items.push({ kind: 'Heading', label: h.text, where: `${p.title}`, href: link.page(b.id, p.id, h.slug), heading: true });
        }
      }
    }
    return items;
  }

  // Escapes text and wraps each occurrence of the search words in <mark>.
  function highlight(text, words) {
    const lower = text.toLowerCase();
    const hits = [];
    for (const w of words) {
      for (let i = lower.indexOf(w); i > -1; i = lower.indexOf(w, i + w.length)) hits.push([i, i + w.length]);
    }
    hits.sort((a, b) => a[0] - b[0]);
    let out = '';
    let at = 0;
    for (const [from, to] of hits) {
      if (from < at) continue;
      out += esc(text.slice(at, from)) + `<mark>${esc(text.slice(from, to))}</mark>`;
      at = to;
    }
    return out + esc(text.slice(at));
  }

  // A page whose text holds every search word: a snippet around the first hit,
  // linked to the heading above it.
  function textMatch(item, words) {
    const all = item.blocks.map((x) => x.text).join(' ').toLowerCase();
    if (!words.every((w) => all.includes(w))) return null;
    const block = item.blocks.find((x) => words.some((w) => x.text.toLowerCase().includes(w)));
    const lower = block.text.toLowerCase();
    const at = Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i > -1));
    let from = Math.max(0, at - 50);
    if (from > 0) from = block.text.indexOf(' ', from) + 1 || from;
    let snip = block.text.slice(from, from + 140);
    if (from + 140 < block.text.length) snip = snip.replace(/\s+\S*$/, '') + '…';
    if (from > 0) snip = '…' + snip;
    return {
      kind: 'Text', label: item.label, where: item.where, snippet: highlight(snip, words),
      href: block.slug ? link.page(state.bible.id, item.page.id, block.slug) : item.href,
    };
  }

  function openPicker(mode) {
    if (!state.bible) return;
    const quill = state.quill;
    if (mode === 'link' && !quill) return;
    const range = mode === 'link' ? quill.getSelection(true) : null;
    const selected = range && range.length ? quill.getText(range.index, range.length).replace(/\s+/g, ' ').trim() : '';
    const all = pickerItems();
    const list = $('#modal-list');
    const search = $('#modal-search');
    let shown = [];
    let active = 0;
    let busy = false;

    $('#modal-title').textContent = mode === 'link' ? 'Link to…' : 'Jump to…';
    search.placeholder = mode === 'link' ? 'Search sections, pages and headings…' : 'Search titles and page text…';
    $('#modal-hint').textContent =
      mode === 'link'
        ? range && range.length
          ? 'The selected text will become a link. ↑↓ to choose, Enter to insert. No page yet? Create one from the bottom of the list.'
          : 'No text selected: the name of what you pick will be inserted as a link.'
        : '↑↓ to choose, Enter to open. Searches page text too. Press Ctrl+K anywhere to open this.';

    function draw() {
      const raw = search.value.trim();
      const words = raw.toLowerCase().split(/\s+/).filter(Boolean);
      const titled = all.filter((i) => words.every((w) => `${i.label} ${i.where}`.toLowerCase().includes(w)));
      shown = titled.slice(0, 200);
      if (mode === 'jump' && words.length) {
        // Pages already listed by title still show a text hit if their body matches too.
        shown = shown.concat(all.filter((i) => i.blocks).map((i) => textMatch(i, words)).filter(Boolean).slice(0, 50));
      }
      if (mode === 'link' && raw && !all.some((i) => i.kind === 'Page' && i.label.trim().toLowerCase() === raw.toLowerCase())) {
        for (const s of state.bible.sections) {
          shown.push({ kind: 'New', label: raw.slice(0, 200), where: `New ${templateFor(s.kind).singular} in ${s.name}`, create: s });
        }
      }
      active = Math.min(active, Math.max(shown.length - 1, 0));
      list.innerHTML =
        shown
          .map(
            (i, n) => `<li data-n="${n}" class="${i.heading ? 'heading' : ''} ${i.create ? 'create' : ''} ${n === active ? 'active' : ''}">
              <span class="kind">${i.kind}</span><span class="label">${i.create ? `Create “${esc(i.label)}”` : esc(i.label)}${
                i.snippet ? `<span class="snippet">${i.snippet}</span>` : ''
              }</span><span class="where">${esc(i.where)}</span></li>`
          )
          .join('') || '<li>No matches</li>';
      const el = $('li.active', list);
      if (el) el.scrollIntoView({ block: 'nearest' });
    }

    // Makes the page in the chosen section, then links to it like any other item.
    async function create(item) {
      if (busy) return;
      busy = true;
      try {
        const s = item.create;
        const page = await api('POST', `/api/bibles/${state.bible.id}/sections/${s.id}/pages`, { title: item.label });
        s.pages.push(page);
        renderSidebar();
        choose({ kind: 'Page', label: page.title, href: link.page(state.bible.id, page.id) }, `Created “${page.title}” in ${s.name} and linked to it`);
      } catch (err) {
        busy = false;
        toast(`Could not create the page: ${err.message}`);
      }
    }

    function choose(item, message) {
      if (item && item.create) return create(item);
      close();
      if (!item) return;
      if (mode === 'jump') {
        location.hash = item.href;
        return;
      }
      if (range && range.length) {
        quill.formatText(range.index, range.length, 'link', item.href, 'user');
        quill.setSelection(range.index + range.length, 0, 'silent');
      } else {
        const at = range ? range.index : quill.getLength() - 1;
        quill.insertText(at, item.label, 'link', item.href, 'user');
        quill.setSelection(at + item.label.length, 0, 'silent');
        quill.format('link', false, 'silent');
      }
      toast(message || `Linked to ${item.kind.toLowerCase()} “${item.label}”`);
    }

    function close() {
      els.modal.hidden = true;
      search.oninput = search.onkeydown = list.onclick = els.modal.onclick = null;
      if (mode === 'link' && quill) quill.focus();
    }

    // Linking selected text starts from that text, so a missing page is one Enter away from the create row.
    search.value = selected.length <= 200 ? selected : '';
    active = 0;
    draw();
    els.modal.hidden = false;
    search.focus();
    search.select();
    search.oninput = () => {
      active = 0;
      draw();
    };
    search.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { active = Math.min(active + 1, shown.length - 1); draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); draw(); e.preventDefault(); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(shown[active]); }
      else if (e.key === 'Escape') close();
    };
    list.onclick = (e) => {
      const li = e.target.closest('li[data-n]');
      if (li) choose(shown[Number(li.dataset.n)]);
    };
    els.modal.onclick = (e) => {
      if (e.target === els.modal || e.target.closest('[data-close]')) close();
    };
  }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && state.bible) {
      e.preventDefault();
      if (els.modal.hidden) openPicker('jump');
    }
    // The editor has its own binding; this one works from the title and elsewhere on the page.
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f' && state.quill && !e.defaultPrevented) {
      e.preventDefault();
      setFocusMode(!document.body.classList.contains('focus-mode'));
    }
    if (e.key === 'Escape' && document.body.classList.contains('focus-mode') && els.modal.hidden && !e.defaultPrevented) {
      setFocusMode(false);
    }
  });

  // ---------- Collaboration ----------
  // Loads a page version from the server into the open editor without saving it back.
  function loadIntoEditor(page, fresh) {
    Object.assign(page, fresh);
    if (!state.quill || state.pageId !== page.id) return;
    const sel = state.quill.getSelection();
    state.quill.setContents([], 'silent');
    state.quill.clipboard.dangerouslyPasteHTML(page.content || '', 'silent');
    if (sel) state.quill.setSelection(Math.min(sel.index, state.quill.getLength() - 1), 0, 'silent');
    if (promptsOnResize) promptsOnResize();
    renderWordCount(state.quill);
    // Always show their title, even mid-focus, or typing would save over their rename.
    const title = $('#page-title');
    if (title && title.value !== page.title) {
      const caret = title.selectionStart;
      title.value = page.title;
      if (document.activeElement === title) title.setSelectionRange(caret, caret);
    }
    const last = $('#last-edit');
    if (last) last.textContent = page.updatedBy ? `Last edited by ${page.updatedBy}` : '';
    renderOutline();
  }

  // Someone else saved this page after we loaded it: let the person choose a version.
  function showConflict(pid, theirs) {
    const box = $('#conflict');
    const found = findPage(pid);
    if (!box || !found || state.pageId !== pid) return;
    box.hidden = false;
    box.innerHTML = `
      <p><b>${esc(theirs.updatedBy || 'Someone')}</b> saved changes to this page while you were editing, so your latest changes are not saved yet.</p>
      <button class="btn small primary" id="keep-mine">Keep my version</button>
      <button class="btn small" id="take-theirs">Load their version</button>`;
    const done = () => {
      box.hidden = true;
      saver.conflict = null;
    };
    $('#keep-mine').onclick = () => {
      done();
      found.page.rev = theirs.rev;
      saver.queue(pid, { content: state.quill.root.innerHTML, title: found.page.title }, 0);
    };
    $('#take-theirs').onclick = async () => {
      const mine = state.quill.getText();
      done();
      saver.pending = null;
      loadIntoEditor(found.page, theirs);
      renderSidebar();
      renderCrumbs();
      saver.status('Saved');
      try {
        await navigator.clipboard.writeText(mine);
        toast('Loaded their version. Your text is on the clipboard.');
      } catch (_) {
        toast('Loaded their version.');
      }
    };
  }

  // Re-reads the bible after someone else changed it, keeping the open editor intact.
  async function refreshBible() {
    const old = state.bible;
    const fresh = await api('GET', `/api/bibles/${old.id}`);
    if (state.bible !== old) return;
    const pid = state.pageId;
    const openOld = pid && findPage(pid);
    state.bible = fresh;
    if (openOld) {
      const now = findPage(pid);
      if (!now) {
        if (saver.busyWith(pid)) {
          state.bible = old; // keep our copy so the person can still copy their text out
          return toast('A collaborator deleted this page. Your latest changes cannot be saved.');
        }
        toast('A collaborator deleted this page.');
        location.hash = link.section(fresh.id, openOld.section.id);
        return;
      }
      // The editor closures hold the old page object; keep using it.
      now.section.pages[now.section.pages.indexOf(now.page)] = openOld.page;
      if (!saver.busyWith(pid) && (now.page.rev || 0) !== (openOld.page.rev || 0)) {
        loadIntoEditor(openOld.page, now.page);
        toast(`${now.page.updatedBy || 'A collaborator'} updated this page.`);
      } else if (!saver.busyWith(pid)) {
        Object.assign(openOld.page, { ...now.page, content: openOld.page.content });
      }
    }
    const focus = document.activeElement;
    const focusId = focus && focus.id;
    const caret = focus && 'selectionStart' in focus ? focus.selectionStart : null;
    if (!$('.dragging', els.sidebar)) renderSidebar();
    renderCrumbs();
    const r = state.route;
    const typing = focus && els.main.contains(focus) && /^(INPUT|TEXTAREA)$/.test(focus.tagName);
    if (!typing && r.name === 'section') renderSection(r.sid);
    if (!typing && r.name === 'bible') renderOverview();
    if (r.name === 'page') renderOutline();
    const back = focusId && document.getElementById(focusId);
    if (back && back !== focus) {
      back.focus();
      if (caret !== null) back.setSelectionRange(caret, caret);
    }
  }

  // Every few seconds: report where we are, see who else is here, and pick up their changes.
  async function poll() {
    const b = state.bible;
    if (!b || document.visibilityState !== 'visible' || !window.SBCollab.user) return;
    let act;
    try {
      act = await api('GET', `/api/bibles/${b.id}/activity${state.pageId ? `?page=${state.pageId}` : ''}`);
    } catch (err) {
      if (err.status === 404 && state.bible === b) {
        state.bible = null;
        toast('This bible was deleted or is no longer shared with you.');
        location.hash = '#/';
      }
      return;
    }
    if (state.bible !== b) return;
    window.SBCollab.renderPresence(act.viewers, state.pageId);
    const known = state.sig;
    state.sig = act.sig;
    const changed = b.sections.some((s) => s.pages.some((p) => act.pages[p.id] && act.pages[p.id].rev !== (p.rev || 0)));
    // The first poll has nothing to compare with, so it re-reads once to catch changes made
    // between opening the bible and now.
    if (changed || known !== act.sig) await refreshBible().catch(() => {});
  }
  setInterval(poll, 4000);
  document.addEventListener('visibilitychange', poll);

  // What the relationship map (relmap.js) needs from the app.
  function relCtx() {
    return { bible: state.bible, main: els.main, rightbar: els.rightbar, api, esc, link, toast };
  }

  // What page history and the trash (history.js) need from the app.
  function historyCtx() {
    return {
      get bible() { return state.bible; },
      main: els.main, api, esc, link, toast,
      reload: () => refreshBible(),
    };
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // Templates only drive optional UI, so the app still starts if they fail to load.
  // They are behind sign-in, so they load once the person is signed in.
  window.SBCollab.start(() =>
    api('GET', '/api/templates')
      .then((t) => (state.templates = t))
      .catch(() => {})
      .finally(route)
  );
})();
