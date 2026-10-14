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
      let msg = res.statusText;
      try { msg = (await res.json()).error || msg; } catch (_) { /* not json */ }
      throw new Error(msg);
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
  };

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
      const job = this.pending;
      this.pending = null;
      if (!job || !state.bible) return;
      this.status('Saving…');
      try {
        const page = await api('PATCH', `/api/bibles/${state.bible.id}/pages/${job.pid}`, job.patch);
        const found = findPage(job.pid);
        if (found) Object.assign(found.page, page);
        if (!this.pending) this.status('Saved');
      } catch (err) {
        this.status('Save failed');
        toast(`Could not save: ${err.message}`);
      }
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
    if (r.name === 'page' && parts[4] === 'h' && parts[5]) r.slug = decodeURIComponent(parts[5]);
    return r;
  }

  async function route() {
    const r = parseRoute();
    const prev = state.route;
    state.route = r;
    document.body.classList.remove('side-open');
    await saver.flush();

    if (r.name === 'home') {
      state.bible = null;
      return renderHome();
    }
    if (!state.bible || state.bible.id !== r.bid) {
      try {
        state.bible = await api('GET', `/api/bibles/${r.bid}`);
      } catch (err) {
        toast('That series bible could not be found.');
        location.hash = '#/';
        return;
      }
    }
    renderSidebar();
    renderTopbar();
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
    return renderOverview();
  }
  window.addEventListener('hashchange', route);

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
      <button class="btn small side-toggle" id="side-toggle">☰ Sections</button>
      <span class="save-state" id="save-state"></span>
      <button class="btn" id="jump-btn" title="Jump to (Ctrl+K)">Jump to…</button>
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
              <a href="${link.bible(b.id)}"><h3>${esc(b.title)}</h3>
              ${b.logline ? `<p>${esc(b.logline)}</p>` : ''}
              <small>Edited ${new Date(b.updatedAt).toLocaleString()}</small></a>
              <button class="icon-btn" data-delete="${b.id}" data-title="${esc(b.title)}" title="Delete">🗑</button>
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
        <a class="side-title" href="${link.bible(b.id)}">${esc(b.title)}</a>
        <input class="side-filter" id="side-filter" type="search" placeholder="Filter pages…" value="${esc(state.filter)}">
      </div>
      ${b.sections
        .map((s) => {
          const pages = q ? s.pages.filter((p) => p.title.toLowerCase().includes(q)) : s.pages;
          const collapsed = state.collapsed[s.id] && !q;
          return `
        <div class="section ${s.id === activeSection ? 'active' : ''} ${collapsed ? 'collapsed' : ''}" data-sid="${s.id}">
          <div class="section-head">
            <button class="icon-btn twisty" data-toggle="${s.id}" aria-label="Collapse">${collapsed ? '▶' : '▼'}</button>
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
      <button class="btn add-section" id="add-section">＋ Add section</button>`;

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
    const singular = { Characters: 'character', World: 'world entry' }[section.name] || 'page';
    const title = prompt(`Name of the new ${singular} in ${section.name}:`);
    if (!title || !title.trim()) return;
    const page = await api('POST', `/api/bibles/${state.bible.id}/sections/${sid}/pages`, { title: title.trim() });
    section.pages.push(page);
    state.collapsed[sid] = false;
    location.hash = link.page(state.bible.id, page.id);
  }

  async function addSection() {
    const name = prompt('Name of the new section (e.g. Episodes, Themes, Tone & Style):');
    if (!name || !name.trim()) return;
    const section = await api('POST', `/api/bibles/${state.bible.id}/sections`, { name: name.trim() });
    state.bible.sections.push(section);
    location.hash = link.section(state.bible.id, section.id);
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
          <div class="section-block">
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
      $('.side-title').textContent = b.title;
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
      <div class="sheet overview">
        <a class="eyebrow" href="${link.bible(b.id)}">${esc(b.title)}</a>
        <h1><input class="inline-edit" id="section-name" value="${esc(s.name)}" maxlength="200" aria-label="Section name"></h1>
        <div class="page-meta"><span>${s.pages.length} ${s.pages.length === 1 ? 'page' : 'pages'} · drag pages in the sidebar to reorder</span>
          <span>
            <button class="btn small" id="sec-up" ${b.sections[0] === s ? 'disabled' : ''}>Move up</button>
            <button class="btn small" id="sec-down" ${b.sections[b.sections.length - 1] === s ? 'disabled' : ''}>Move down</button>
            <button class="btn small danger" id="sec-delete">Delete section</button>
          </span></div>
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
      if (!confirm(`Delete the "${s.name}" section${n ? ` and its ${n} page${n === 1 ? '' : 's'}` : ''}? This cannot be undone.`)) return;
      await api('DELETE', `/api/bibles/${b.id}/sections/${s.id}`);
      b.sections = b.sections.filter((x) => x !== s);
      location.hash = link.bible(b.id);
    };
  }

  // ---------- Page editor ----------
  function teardownEditor() {
    state.quill = null;
    state.pageId = null;
  }

  function renderPage(pid, slug) {
    const b = state.bible;
    const found = findPage(pid);
    teardownEditor();
    if (!found) {
      els.rightbar.hidden = true;
      els.main.innerHTML = `<div class="sheet"><h2>Page not found</h2><p>This link points to a page that was deleted or moved to another bible.</p><p><a href="${link.bible(b.id)}">Back to ${esc(b.title)}</a></p></div>`;
      return;
    }
    const { page, section } = found;
    document.title = `${page.title} · ${b.title}`;
    els.main.innerHTML = `
      <div class="sheet editor-wrap">
        <a class="eyebrow" href="${link.section(b.id, section.id)}">${esc(section.name)}</a>
        <input class="page-title-input" id="page-title" value="${esc(page.title)}" maxlength="200" aria-label="Page title">
        <div class="page-meta">
          <span>Tip: select text and press <b>§ Link</b> to link it to any section, page or heading.</span>
          <button class="btn small danger" id="page-delete">Delete page</button>
        </div>
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
      </div>`;

    const quill = new Quill('#editor', {
      theme: 'snow',
      placeholder: 'Start writing…',
      modules: {
        toolbar: { container: '#toolbar', handlers: { xref: () => openPicker('link') } },
        keyboard: {
          bindings: {
            xref: { key: 'l', shortKey: true, handler: () => { openPicker('link'); return false; } },
          },
        },
      },
    });
    quill.clipboard.dangerouslyPasteHTML(page.content || '');
    quill.history.clear();
    state.quill = quill;
    state.pageId = pid;

    quill.on('text-change', (delta, old, source) => {
      if (source !== 'user') return;
      page.content = quill.root.innerHTML;
      saver.queue(pid, { content: page.content });
      renderOutline();
    });

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
        quill.focus();
      }
    };
    $('#page-delete').onclick = async () => {
      if (!confirm(`Delete "${page.title}"? Links to it from other pages will stop working.`)) return;
      saver.pending = null;
      await api('DELETE', `/api/bibles/${b.id}/pages/${pid}`);
      section.pages = section.pages.filter((p) => p.id !== pid);
      location.hash = link.section(b.id, section.id);
    };

    renderOutline();
    els.main.scrollTop = 0;
    if (slug) requestAnimationFrame(() => scrollToHeading(slug));
    else if (!page.content || page.content === '<p><br></p>') quill.focus();
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
      <ul>${back.map(({ s, p }) => `<li><a href="${link.page(b.id, p.id)}">${esc(p.title)}<small>${esc(s.name)}</small></a></li>`).join('') || '<li class="none">No other pages link here yet.</li>'}</ul>`;
  }, 150);

  // ---------- Picker (jump to / insert cross-reference) ----------
  function pickerItems() {
    const b = state.bible;
    const items = [];
    for (const s of b.sections) {
      items.push({ kind: 'Section', label: s.name, where: `${s.pages.length} pages`, href: link.section(b.id, s.id) });
      for (const p of s.pages) {
        items.push({ kind: 'Page', label: p.title, where: s.name, href: link.page(b.id, p.id) });
        const content = p.id === state.pageId && state.quill ? state.quill.root.innerHTML : p.content;
        for (const h of headingsOf(content)) {
          items.push({ kind: 'Heading', label: h.text, where: `${p.title}`, href: link.page(b.id, p.id, h.slug), heading: true });
        }
      }
    }
    return items;
  }

  function openPicker(mode) {
    if (!state.bible) return;
    const quill = state.quill;
    if (mode === 'link' && !quill) return;
    const range = mode === 'link' ? quill.getSelection(true) : null;
    const all = pickerItems();
    const list = $('#modal-list');
    const search = $('#modal-search');
    let shown = [];
    let active = 0;

    $('#modal-title').textContent = mode === 'link' ? 'Link to…' : 'Jump to…';
    $('#modal-hint').textContent =
      mode === 'link'
        ? range && range.length
          ? 'The selected text will become a link. ↑↓ to choose, Enter to insert.'
          : 'No text selected: the name of what you pick will be inserted as a link.'
        : '↑↓ to choose, Enter to open. Press Ctrl+K anywhere to open this.';

    function draw() {
      const q = search.value.trim().toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      shown = all.filter((i) => words.every((w) => `${i.label} ${i.where}`.toLowerCase().includes(w))).slice(0, 200);
      active = Math.min(active, Math.max(shown.length - 1, 0));
      list.innerHTML =
        shown
          .map(
            (i, n) => `<li data-n="${n}" class="${i.heading ? 'heading' : ''} ${n === active ? 'active' : ''}">
              <span class="kind">${i.kind}</span><span class="label">${esc(i.label)}</span><span class="where">${esc(i.where)}</span></li>`
          )
          .join('') || '<li>No matches</li>';
      const el = $('li.active', list);
      if (el) el.scrollIntoView({ block: 'nearest' });
    }

    function choose(item) {
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
      toast(`Linked to ${item.kind.toLowerCase()} “${item.label}”`);
    }

    function close() {
      els.modal.hidden = true;
      search.oninput = search.onkeydown = list.onclick = els.modal.onclick = null;
      if (mode === 'link' && quill) quill.focus();
    }

    search.value = '';
    active = 0;
    draw();
    els.modal.hidden = false;
    search.focus();
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
  });

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  route();
})();
