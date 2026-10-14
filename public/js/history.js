/* Page history (earlier versions of a page) and the trash (deleted pages).
   app.js passes a context with the open bible and the helpers these views need. */
(function () {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

  const when = (iso) => {
    const d = new Date(iso);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric', hour: 'numeric', minute: '2-digit',
    });
  };
  const wordCount = (n) => `${n} word${n === 1 ? '' : 's'}`;

  // Shows stored page HTML through a read-only Quill, so it is cleaned the same way the editor cleans it.
  function preview(el, html) {
    el.innerHTML = '';
    const box = document.createElement('div');
    el.appendChild(box);
    const q = new Quill(box, { readOnly: true, modules: { toolbar: false } });
    q.clipboard.dangerouslyPasteHTML(html || '', 'silent');
  }

  // ---------- History ----------
  // ctx: { bible, page, api, esc, toast, flush(), onRestore(page) }
  async function openHistory(ctx) {
    const { bible: b, page, api, esc, toast } = ctx;
    await ctx.flush();
    let versions;
    try {
      versions = await api('GET', `/api/bibles/${b.id}/pages/${page.id}/versions`);
    } catch (err) {
      return toast(`Could not load the history: ${err.message}`);
    }
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal history-modal" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <div class="modal-head">
          <h2 id="history-title">Page history</h2>
          <button type="button" class="icon-btn" data-close aria-label="Close">×</button>
        </div>
        <div class="history-body">
          <ul class="history-list" role="listbox" aria-label="Versions">
            <li role="option" tabindex="0" data-vid="" aria-selected="true">
              <strong>Current version</strong>
              <small>${page.updatedBy ? `${esc(page.updatedBy)} · ` : ''}${page.updatedAt ? esc(when(page.updatedAt)) : ''}</small>
            </li>
            ${versions
              .map(
                (v) => `<li role="option" tabindex="-1" data-vid="${esc(v.id)}" aria-selected="false">
                  <strong>${esc(when(v.at))}</strong>
                  <small>${v.by ? `${esc(v.by)} · ` : ''}${wordCount(v.words)}${v.title !== page.title ? ` · “${esc(v.title)}”` : ''}</small>
                </li>`
              )
              .join('')}
          </ul>
          <div class="history-view">
            <h3 class="history-title" id="history-page-title"></h3>
            <div class="history-preview" id="history-preview"></div>
          </div>
        </div>
        <div class="modal-foot history-foot">
          <p class="history-hint">${
            versions.length
              ? 'A version is kept every 10 minutes while you write, and whenever someone else starts editing. Restoring keeps the current text as a version too.'
              : 'No earlier versions yet. One is kept every 10 minutes while you write, and whenever someone else starts editing.'
          }</p>
          <button type="button" class="btn" data-close>Close</button>
          <button type="button" class="btn primary" id="history-restore" disabled>Restore this version</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const restoreBtn = $('#history-restore', wrap);
    const titleEl = $('#history-page-title', wrap);
    const previewEl = $('#history-preview', wrap);
    let selected = '';
    const cache = {};

    async function show(li) {
      $$('.history-list li', wrap).forEach((x) => {
        const on = x === li;
        x.setAttribute('aria-selected', on);
        x.tabIndex = on ? 0 : -1;
      });
      selected = li.dataset.vid;
      restoreBtn.disabled = !selected;
      if (!selected) {
        titleEl.textContent = page.title;
        return preview(previewEl, page.content);
      }
      try {
        const v = cache[selected] || (cache[selected] = await api('GET', `/api/bibles/${b.id}/pages/${page.id}/versions/${selected}`));
        if (selected !== v.id) return; // another version was picked meanwhile
        titleEl.textContent = v.title;
        preview(previewEl, v.content);
      } catch (err) {
        toast(`Could not load that version: ${err.message}`);
      }
    }

    const list = $('.history-list', wrap);
    list.onclick = (e) => {
      const li = e.target.closest('li');
      if (li) show(li);
    };
    list.onkeydown = (e) => {
      const items = $$('li', list);
      const i = items.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown' ? items[i + 1] : e.key === 'ArrowUp' ? items[i - 1] : null;
      if (next) {
        e.preventDefault();
        next.focus();
        show(next);
      }
    };

    const close = () => wrap.remove();
    wrap.onclick = (e) => {
      if (e.target === wrap || e.target.closest('[data-close]')) close();
    };
    wrap.onkeydown = (e) => {
      if (e.key === 'Escape') close();
    };
    restoreBtn.onclick = async () => {
      if (!selected) return;
      restoreBtn.disabled = true;
      try {
        await ctx.flush();
        const fresh = await api('POST', `/api/bibles/${b.id}/pages/${page.id}/versions/${selected}/restore`);
        close();
        ctx.onRestore(fresh);
        toast('Version restored. The text it replaced is kept in the history.');
      } catch (err) {
        restoreBtn.disabled = false;
        toast(`Could not restore: ${err.message}`);
      }
    };

    show($('.history-list li', wrap));
    $('.history-list li', wrap).focus();
  }

  // ---------- Trash ----------
  // ctx: { bible, main, api, esc, link, toast, reload() }
  async function renderTrash(ctx) {
    const { bible: b, main, api, esc, link, toast } = ctx;
    document.title = `Trash · ${b.title}`;
    main.innerHTML = '<div class="sheet trash"><p class="trash-loading">Loading…</p></div>';
    let items;
    try {
      items = await api('GET', `/api/bibles/${b.id}/trash`);
    } catch (err) {
      main.innerHTML = `<div class="sheet trash"><p>Could not load the trash: ${esc(err.message)}</p></div>`;
      return;
    }
    if (ctx.bible !== b || !location.hash.endsWith('/trash')) return; // the person moved on
    const sheet = $('.sheet', main);
    sheet.innerHTML = `
      <div class="trash-head">
        <div>
          <p class="eyebrow">${esc(b.title)}</p>
          <h1>Trash</h1>
        </div>
        ${items.length ? '<button class="btn small danger" id="trash-empty">Empty trash</button>' : ''}
      </div>
      <p class="trash-lede">Deleted pages wait here for 30 days, then they are removed for good. Restoring a page puts it back in its section, and links to it work again.</p>
      ${
        items.length
          ? `<ul class="trash-list">${items
              .map(
                (t) => `
            <li data-pid="${esc(t.id)}">
              <div class="trash-info">
                <strong>${esc(t.title)}</strong>
                <small>From ${esc(t.sectionName || 'a section')}${t.sectionExists ? '' : ' (will be recreated)'} · deleted ${esc(when(t.deletedAt))}${t.deletedBy ? ` by ${esc(t.deletedBy)}` : ''} · ${wordCount(t.words)}</small>
                ${t.excerpt ? `<p>${esc(t.excerpt)}</p>` : ''}
              </div>
              <div class="trash-actions">
                <button class="btn small primary" data-restore="${esc(t.id)}">Restore</button>
                <button class="btn small danger" data-purge="${esc(t.id)}">Delete forever</button>
              </div>
            </li>`
              )
              .join('')}</ul>`
          : '<p class="trash-none">The trash is empty.</p>'
      }`;

    $$('[data-restore]', sheet).forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const { page, sectionId } = await api('POST', `/api/bibles/${b.id}/trash/${btn.dataset.restore}/restore`);
          await ctx.reload();
          const li = btn.closest('li');
          li.classList.add('restored');
          li.querySelector('.trash-actions').innerHTML = `<a class="btn small" href="${link.page(b.id, page.id)}">Open page</a>`;
          const section = (ctx.bible.sections || []).find((s) => s.id === sectionId);
          toast(`Restored “${page.title}”${section ? ` to ${section.name}` : ''}.`);
        } catch (err) {
          btn.disabled = false;
          toast(`Could not restore: ${err.message}`);
        }
      };
    });
    $$('[data-purge]', sheet).forEach((btn) => {
      btn.onclick = async () => {
        const title = btn.closest('li').querySelector('strong').textContent;
        if (!confirm(`Delete "${title}" for good? It and its history cannot be brought back.`)) return;
        try {
          await api('DELETE', `/api/bibles/${b.id}/trash/${btn.dataset.purge}`);
          renderTrash(ctx);
        } catch (err) {
          toast(`Could not delete: ${err.message}`);
        }
      };
    });
    const empty = $('#trash-empty', sheet);
    if (empty) {
      empty.onclick = async () => {
        if (!confirm(`Delete all ${items.length} page${items.length === 1 ? '' : 's'} in the trash for good? This cannot be undone.`)) return;
        try {
          await api('DELETE', `/api/bibles/${b.id}/trash`);
          renderTrash(ctx);
        } catch (err) {
          toast(`Could not empty the trash: ${err.message}`);
        }
      };
    }
  }

  window.SBHistory = { openHistory, renderTrash };
})();
