/* Relationship map: an interactive graph of the characters and how they connect.
   app.js calls RelMap.render() for #/b/:bid/map and RelMap.panel() for the page right bar. */
(function () {
  'use strict';

  const TYPES = [
    { key: 'family', label: 'Family', color: '#2f7d4f' },
    { key: 'romance', label: 'Romance', color: '#c2185b' },
    { key: 'ally', label: 'Friend / ally', color: '#1a4fa0' },
    { key: 'rival', label: 'Rival / enemy', color: '#c0392b', dash: '7 5' },
    { key: 'work', label: 'Work', color: '#7a5c99' },
    { key: 'other', label: 'Other', color: '#6b675f' },
  ];
  const typeOf = (k) => TYPES.find((t) => t.key === k) || TYPES[TYPES.length - 1];
  const SUGGESTIONS = [
    'sibling', 'parent of', 'child of', 'married to', 'ex', 'in love with', 'best friend', 'friend',
    'mentor of', 'rival', 'enemy', 'boss of', 'partner', 'betrayed', 'owes a debt to', 'secretly protects',
  ];
  const R = 26; // node radius
  const hidden = {}; // legend toggles, kept while the page is open

  const relmapOf = (b) => {
    b.relmap = b.relmap || {};
    b.relmap.relationships = b.relmap.relationships || [];
    b.relmap.positions = b.relmap.positions || {};
    return b.relmap;
  };

  function allPages(b) {
    const out = new Map();
    for (const s of b.sections) for (const p of s.pages) out.set(p.id, { page: p, section: s });
    return out;
  }

  // Character pages, plus any other page someone has related to a character.
  function nodesOf(b) {
    const pages = allPages(b);
    const rels = relmapOf(b).relationships.filter((r) => pages.has(r.from) && pages.has(r.to));
    const ids = new Set();
    for (const s of b.sections) if (s.kind === 'characters') s.pages.forEach((p) => ids.add(p.id));
    rels.forEach((r) => { ids.add(r.from); ids.add(r.to); });
    return { nodes: [...ids].map((id) => ({ id, ...pages.get(id) })), rels, pages };
  }

  function initials(title) {
    const words = String(title).trim().split(/\s+/).filter(Boolean);
    return ((words[0] || '?')[0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
  }

  function describe(rel, pages, esc) {
    const a = esc(pages.get(rel.from).page.title);
    const b = esc(pages.get(rel.to).page.title);
    const label = esc(rel.label || typeOf(rel.type).label.toLowerCase());
    return rel.mutual ? `${a} <span class="rm-arrow">↔</span> ${b} <span class="rm-lbl">${label}</span>` : `${a} <span class="rm-lbl">${label}</span> <span class="rm-arrow">→</span> ${b}`;
  }

  // ---------- Add / edit dialog ----------
  function openEditor(ctx, rel, onDone) {
    if (document.querySelector('dialog.rm-dialog[open]')) return;
    const { bible: b, api, esc, toast } = ctx;
    const { pages } = nodesOf(b);
    const editing = Boolean(rel.id);
    const chars = [];
    const others = [];
    for (const s of b.sections) for (const p of s.pages) (s.kind === 'characters' ? chars : others).push({ p, s });
    const options = (sel) =>
      `<optgroup label="Characters">${chars.map(({ p }) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}</optgroup>` +
      (others.length ? `<optgroup label="Other pages">${others.map(({ p, s }) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.title)} (${esc(s.name)})</option>`).join('')}</optgroup>` : '');

    if (pages.size < 2) {
      toast('Add at least two characters first.');
      return;
    }
    const dlg = document.createElement('dialog');
    dlg.className = 'rm-dialog';
    dlg.innerHTML = `
      <form method="dialog">
        <h2>${editing ? 'Edit relationship' : 'New relationship'}</h2>
        <div class="rm-row">
          <label>Character<select name="from" required>${options(rel.from)}</select></label>
          <label>Relationship<input name="label" list="rm-suggest" maxlength="80" placeholder="e.g. mentor of, sibling, rival" value="${esc(rel.label || '')}"></label>
          <label>To<select name="to" required>${options(rel.to)}</select></label>
        </div>
        <datalist id="rm-suggest">${SUGGESTIONS.map((s) => `<option value="${s}">`).join('')}</datalist>
        <fieldset class="rm-types"><legend>Kind</legend>
          ${TYPES.map((t) => `<label class="rm-chip" style="--c:${t.color}"><input type="radio" name="type" value="${t.key}" ${t.key === (rel.type || 'other') ? 'checked' : ''}><span>${t.label}</span></label>`).join('')}
        </fieldset>
        <label class="rm-check"><input type="checkbox" name="mutual" ${rel.mutual === false ? '' : 'checked'}> Goes both ways (like siblings). Untick for one-way, like “mentor of”.</label>
        <label>Note<textarea name="note" rows="3" maxlength="2000" placeholder="What's the history? What do they want from each other?">${esc(rel.note || '')}</textarea></label>
        <p class="rm-error" hidden></p>
        <div class="rm-actions">
          ${editing ? '<button type="button" class="btn danger" data-act="delete">Delete</button>' : ''}
          <span></span>
          <button type="button" class="btn" data-act="cancel">Cancel</button>
          <button type="submit" class="btn primary">${editing ? 'Save' : 'Add relationship'}</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector('form');
    const errEl = dlg.querySelector('.rm-error');
    // Pick a sensible second character when starting from one page.
    if (!editing && !rel.to) {
      const other = chars.find(({ p }) => p.id !== form.from.value) || others.find(({ p }) => p.id !== form.from.value);
      if (other) form.to.value = other.p.id;
    }
    const close = () => { dlg.close(); dlg.remove(); };
    dlg.addEventListener('cancel', () => setTimeout(() => dlg.remove()));
    dlg.querySelector('[data-act="cancel"]').onclick = close;
    const del = dlg.querySelector('[data-act="delete"]');
    if (del) {
      del.onclick = async () => {
        await api('DELETE', `/api/bibles/${b.id}/relationships/${rel.id}`);
        const map = relmapOf(b);
        map.relationships = map.relationships.filter((r) => r.id !== rel.id);
        close();
        toast('Relationship deleted');
        onDone();
      };
    }
    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = {
        from: form.from.value,
        to: form.to.value,
        label: form.label.value,
        type: form.type.value,
        mutual: form.mutual.checked,
        note: form.note.value,
      };
      if (body.from === body.to) {
        errEl.textContent = 'Pick two different characters.';
        errEl.hidden = false;
        return;
      }
      try {
        const saved = editing
          ? await api('PATCH', `/api/bibles/${b.id}/relationships/${rel.id}`, body)
          : await api('POST', `/api/bibles/${b.id}/relationships`, body);
        const map = relmapOf(b);
        const existing = map.relationships.find((r) => r.id === saved.id);
        if (existing) Object.assign(existing, saved);
        else map.relationships.push(saved);
        close();
        onDone();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    };
    dlg.showModal();
    form.label.focus();
  }

  // ---------- Layout ----------
  // Force-directed layout; nodes the writer has dragged stay where they put them.
  function layout(nodes, rels, saved) {
    const n = nodes.length;
    const pos = {};
    nodes.forEach((node, i) => {
      const p = saved[node.id];
      const a = (2 * Math.PI * i) / Math.max(n, 1);
      const r = 60 + 40 * Math.sqrt(n);
      pos[node.id] = p ? { x: p.x, y: p.y, pinned: true } : { x: Math.cos(a) * r, y: Math.sin(a) * r, pinned: false };
    });
    if (nodes.every((x) => pos[x.id].pinned)) return pos;
    // Fruchterman-Reingold with a gentle pull toward the centre so loose characters stay close.
    const k = 210;
    for (let it = 0; it < 300; it++) {
      const temp = 40 * (1 - it / 300) + 1;
      const f = {};
      nodes.forEach((x) => (f[x.id] = { x: 0, y: 0 }));
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = pos[nodes[i].id];
          const b = pos[nodes[j].id];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d = Math.hypot(dx, dy);
          if (d < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d = 1; }
          const rep = (k * k) / d / d;
          f[nodes[i].id].x += dx * rep; f[nodes[i].id].y += dy * rep;
          f[nodes[j].id].x -= dx * rep; f[nodes[j].id].y -= dy * rep;
        }
      }
      for (const r of rels) {
        const a = pos[r.from];
        const b = pos[r.to];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const att = d / k;
        f[r.from].x += dx * att; f[r.from].y += dy * att;
        f[r.to].x -= dx * att; f[r.to].y -= dy * att;
      }
      for (const x of nodes) {
        const p = pos[x.id];
        if (p.pinned) continue;
        f[x.id].x -= p.x * 0.05;
        f[x.id].y -= p.y * 0.05;
        const len = Math.hypot(f[x.id].x, f[x.id].y) || 1;
        const step = Math.min(len, temp);
        p.x += (f[x.id].x / len) * step;
        p.y += (f[x.id].y / len) * step;
      }
    }
    return pos;
  }

  // Curved path between two nodes; parallel relationships fan out instead of overlapping.
  function edgeGeometry(a, b, offset, oneWay) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const nx = -dy / d;
    const ny = dx / d;
    const c = { x: (a.x + b.x) / 2 + nx * offset, y: (a.y + b.y) / 2 + ny * offset };
    const trim = (from, toward, by) => {
      const ex = toward.x - from.x;
      const ey = toward.y - from.y;
      const el = Math.hypot(ex, ey) || 1;
      return { x: from.x + (ex / el) * by, y: from.y + (ey / el) * by };
    };
    const s = trim(a, c, R + 2);
    const e = trim(b, c, R + (oneWay ? 6 : 2));
    const mid = { x: 0.25 * s.x + 0.5 * c.x + 0.25 * e.x, y: 0.25 * s.y + 0.5 * c.y + 0.25 * e.y };
    return { d: `M${s.x.toFixed(1)},${s.y.toFixed(1)} Q${c.x.toFixed(1)},${c.y.toFixed(1)} ${e.x.toFixed(1)},${e.y.toFixed(1)}`, mid };
  }

  // ---------- Map page ----------
  function render(ctx) {
    const { bible: b, main, rightbar, api, esc, link, toast } = ctx;
    rightbar.hidden = true;
    document.title = `Relationship map · ${b.title}`;

    const refresh = () => render(ctx);
    const { nodes, rels, pages } = nodesOf(b);
    const map = relmapOf(b);
    const visible = rels.filter((r) => !hidden[r.type || 'other']);
    const counts = {};
    rels.forEach((r) => (counts[r.type || 'other'] = (counts[r.type || 'other'] || 0) + 1));
    const charSection = b.sections.find((s) => s.kind === 'characters');

    main.innerHTML = `
      <div class="relmap">
        <div class="rm-head">
          <div>
            <a class="eyebrow" href="${link.bible(b.id)}">${esc(b.title)}</a>
            <h1>Relationship map</h1>
            <p class="rm-sub">Drag characters to arrange them, click one to open their page, and click a line to edit it.</p>
          </div>
          <div class="rm-tools">
            <button class="btn primary" id="rm-add">＋ Add relationship</button>
            <button class="btn" id="rm-fit" title="Fit everything in view">Fit</button>
            <button class="btn" id="rm-tidy" title="Forget dragged positions and lay the map out again">Re-arrange</button>
          </div>
        </div>
        <div class="rm-legend">${TYPES.map((t) => `<button class="rm-chip ${hidden[t.key] ? 'off' : ''}" data-type="${t.key}" style="--c:${t.color}" aria-pressed="${!hidden[t.key]}"><i${t.dash ? ' class="dash"' : ''}></i>${t.label}<small>${counts[t.key] || 0}</small></button>`).join('')}</div>
        ${nodes.length ? '<div class="rm-canvas"><svg id="rm-svg" role="img" aria-label="Character relationship map"></svg></div>' : `
          <div class="rm-empty">
            <p>No characters yet. Add character pages to ${charSection ? `the <a href="${link.section(b.id, charSection.id)}">${esc(charSection.name)}</a> section` : 'a Characters section'}, then connect them here.</p>
          </div>`}
        <h2 class="rm-list-title">All relationships <small>${rels.length}</small></h2>
        <ul class="rm-list">${rels.length
          ? rels.map((r) => `<li style="--c:${typeOf(r.type).color}"><button data-edit="${r.id}"><i></i><span>${describe(r, pages, esc)}</span>${r.note ? `<small>${esc(r.note)}</small>` : ''}</button></li>`).join('')
          : '<li class="none">No relationships yet. Press “Add relationship” to connect two characters.</li>'}</ul>
      </div>`;

    main.querySelector('#rm-add').onclick = () => openEditor(ctx, {}, refresh);
    main.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.onclick = () => openEditor(ctx, map.relationships.find((r) => r.id === btn.dataset.edit), refresh);
    });
    main.querySelectorAll('.rm-legend [data-type]').forEach((btn) => {
      btn.onclick = () => { hidden[btn.dataset.type] = !hidden[btn.dataset.type]; refresh(); };
    });
    main.querySelector('#rm-tidy').onclick = async () => {
      if (Object.keys(map.positions).length && !confirm('Forget where you placed the characters and lay the map out again?')) return;
      map.positions = (await api('PUT', `/api/bibles/${b.id}/relmap/positions`, { reset: true })).positions;
      refresh();
    };

    const svg = main.querySelector('#rm-svg');
    if (!svg) {
      main.querySelector('#rm-fit').disabled = true;
      return;
    }
    const pos = layout(nodes, rels, map.positions);

    // Group parallel edges per pair so they can fan out.
    const pairs = {};
    visible.forEach((r) => {
      const key = [r.from, r.to].sort().join('|');
      (pairs[key] = pairs[key] || []).push(r);
    });
    const offsetOf = {};
    for (const list of Object.values(pairs)) {
      list.forEach((r, i) => {
        // Offsets are relative to the from→to direction, so flip for edges stored the other way round.
        const base = (i - (list.length - 1) / 2) * 64;
        offsetOf[r.id] = r.from < r.to ? base : -base;
      });
    }

    const markers = TYPES.map((t) => `<marker id="rm-end-${t.key}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${t.color}"/></marker>`).join('');
    svg.innerHTML = `<defs>${markers}</defs><g class="rm-view"><g class="rm-edges"></g><g class="rm-nodes"></g></g>`;
    const edgesG = svg.querySelector('.rm-edges');
    const nodesG = svg.querySelector('.rm-nodes');

    function drawEdges() {
      edgesG.innerHTML = visible
        .map((r) => {
          const t = typeOf(r.type);
          const g = edgeGeometry(pos[r.from], pos[r.to], offsetOf[r.id], !r.mutual);
          const text = esc(r.label || t.label);
          const w = Math.min(text.length, 28) * 6.4 + 12;
          return `<g class="rm-edge" data-rel="${r.id}" data-a="${r.from}" data-b="${r.to}" tabindex="0" role="button" aria-label="${esc(pages.get(r.from).page.title)} ${text} ${esc(pages.get(r.to).page.title)}">
            <path class="rm-hit" d="${g.d}"/>
            <path class="rm-line" d="${g.d}" stroke="${t.color}" ${t.dash ? `stroke-dasharray="${t.dash}"` : ''} ${r.mutual ? '' : `marker-end="url(#rm-end-${t.key})"`}/>
            <rect x="${(g.mid.x - w / 2).toFixed(1)}" y="${(g.mid.y - 10).toFixed(1)}" width="${w.toFixed(1)}" height="20" rx="10" stroke="${t.color}"/>
            <text x="${g.mid.x.toFixed(1)}" y="${(g.mid.y + 4).toFixed(1)}" fill="${t.color}">${text.length > 28 ? text.slice(0, 27) + '…' : text}</text>
          </g>`;
        })
        .join('');
    }
    function drawNodes() {
      nodesG.innerHTML = nodes
        .map((x) => {
          const p = pos[x.id];
          const isChar = x.section.kind === 'characters';
          return `<g class="rm-node ${isChar ? '' : 'other'}" data-pid="${x.id}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})" tabindex="0" role="link" aria-label="Open ${esc(x.page.title)}">
            <title>${esc(x.page.title)}${isChar ? '' : ` (${esc(x.section.name)})`}</title>
            <circle r="${R}"/>
            <text class="rm-initials" y="5">${esc(initials(x.page.title))}</text>
            <text class="rm-name" y="${R + 17}">${esc(x.page.title.length > 24 ? x.page.title.slice(0, 23) + '…' : x.page.title)}</text>
          </g>`;
        })
        .join('');
    }
    drawEdges();
    drawNodes();

    // ---- view box: pan and zoom ----
    const view = { x: 0, y: 0, w: 800, h: 600 };
    const applyView = () => svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    // Frame every character, never zooming in past life size.
    function fit() {
      const rect = svg.getBoundingClientRect();
      const xs = nodes.map((x) => pos[x.id].x);
      const ys = nodes.map((x) => pos[x.id].y);
      const pad = 70;
      const minX = Math.min(...xs) - pad;
      const maxX = Math.max(...xs) + pad;
      const minY = Math.min(...ys) - pad;
      const maxY = Math.max(...ys) + pad + 20;
      const scale = Math.max((maxX - minX) / rect.width, (maxY - minY) / rect.height, 1);
      view.w = rect.width * scale;
      view.h = rect.height * scale;
      view.x = (minX + maxX) / 2 - view.w / 2;
      view.y = (minY + maxY) / 2 - view.h / 2;
      applyView();
    }
    fit();
    main.querySelector('#rm-fit').onclick = fit;

    const toSvg = (e) => {
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      return pt.matrixTransform(svg.getScreenCTM().inverse());
    };
    const unitsPerPx = () => {
      const rect = svg.getBoundingClientRect();
      return Math.max(view.w / rect.width, view.h / rect.height);
    };

    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = toSvg(e);
      const f = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 100) * 0.0015);
      const w = Math.min(Math.max(view.w * f, 150), 20000);
      const k = w / view.w;
      view.x = p.x - (p.x - view.x) * k;
      view.y = p.y - (p.y - view.y) * k;
      view.w *= k;
      view.h *= k;
      applyView();
    }, { passive: false });

    // ---- hover highlight ----
    const highlight = (pid) => {
      svg.classList.toggle('focus', Boolean(pid));
      svg.querySelectorAll('.rm-edge').forEach((el) => el.classList.toggle('lit', el.dataset.a === pid || el.dataset.b === pid));
      svg.querySelectorAll('.rm-node').forEach((el) => {
        const linked = el.dataset.pid === pid || visible.some((r) => (r.from === pid && r.to === el.dataset.pid) || (r.to === pid && r.from === el.dataset.pid));
        el.classList.toggle('lit', linked);
      });
    };
    svg.addEventListener('pointerover', (e) => {
      const n = e.target.closest('.rm-node');
      if (n && !drag) highlight(n.dataset.pid);
    });
    svg.addEventListener('pointerout', (e) => {
      const n = e.target.closest('.rm-node');
      if (n && !drag && !n.contains(e.relatedTarget)) highlight(null);
    });

    // ---- drag nodes, pan background, click to open ----
    let drag = null;
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const node = e.target.closest('.rm-node');
      const edge = e.target.closest('.rm-edge');
      if (edge && !node) return;
      const start = toSvg(e);
      drag = node
        ? { kind: 'node', pid: node.dataset.pid, el: node, start, orig: { ...pos[node.dataset.pid] }, moved: false }
        : { kind: 'pan', sx: e.clientX, sy: e.clientY, orig: { ...view }, upp: unitsPerPx(), moved: false };
      svg.setPointerCapture(e.pointerId);
      svg.classList.add('grabbing');
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (drag.kind === 'pan') {
        const dx = e.clientX - drag.sx;
        const dy = e.clientY - drag.sy;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        view.x = drag.orig.x - dx * drag.upp;
        view.y = drag.orig.y - dy * drag.upp;
        applyView();
        return;
      }
      const p = toSvg(e);
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      if (!drag.moved && Math.hypot(dx, dy) * (1 / unitsPerPx()) < 4) return;
      drag.moved = true;
      const np = pos[drag.pid];
      np.x = drag.orig.x + dx;
      np.y = drag.orig.y + dy;
      np.pinned = true;
      drag.el.setAttribute('transform', `translate(${np.x.toFixed(1)},${np.y.toFixed(1)})`);
      drawEdges();
      highlight(drag.pid);
    });
    const endDrag = async (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      svg.classList.remove('grabbing');
      if (d.kind !== 'node') return;
      if (!d.moved) {
        if (e.type === 'pointerup') location.hash = link.page(b.id, d.pid);
        return;
      }
      // Pin every node where it currently sits so the layout stays as the writer sees it.
      const positions = {};
      nodes.forEach((x) => (positions[x.id] = { x: pos[x.id].x, y: pos[x.id].y }));
      try {
        map.positions = (await api('PUT', `/api/bibles/${b.id}/relmap/positions`, { positions })).positions;
      } catch (err) {
        toast(`Could not save the layout: ${err.message}`);
      }
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);

    const editEdge = (el) => openEditor(ctx, map.relationships.find((r) => r.id === el.dataset.rel), refresh);
    svg.addEventListener('click', (e) => {
      const edge = e.target.closest('.rm-edge');
      if (edge) editEdge(edge);
    });
    svg.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const edge = e.target.closest('.rm-edge');
      const node = e.target.closest('.rm-node');
      if (edge) { e.preventDefault(); editEdge(edge); }
      else if (node) { e.preventDefault(); location.hash = link.page(b.id, node.dataset.pid); }
    });
  }

  // ---------- Right-bar panel on a page ----------
  function panel(ctx, pid) {
    const { bible: b, esc, link } = ctx;
    const { rels, pages } = nodesOf(b);
    const here = pages.get(pid);
    if (!here) return '';
    const mine = rels.filter((r) => r.from === pid || r.to === pid);
    if (here.section.kind !== 'characters' && !mine.length) return '';
    const items = mine.map((r) => {
      const otherId = r.from === pid ? r.to : r.from;
      const other = pages.get(otherId).page;
      const label = r.label || typeOf(r.type).label.toLowerCase();
      // Spell out one-way relationships so it is clear who is whose mentor.
      const phrase = r.mutual ? label : r.from === pid ? `${here.page.title} ${label} ${other.title}` : `${other.title} ${label} ${here.page.title}`;
      return `<li style="--c:${typeOf(r.type).color}"><a href="${link.page(b.id, otherId)}"><i class="rm-dot"></i>${esc(other.title)}<small>${esc(phrase)}</small></a></li>`;
    });
    return `
      <h3>Relationships</h3>
      <ul class="rm-panel">${items.join('') || '<li class="none">No relationships yet.</li>'}</ul>
      <p class="rm-panel-actions"><button class="btn small" data-rm-add="${pid}">＋ Add</button> <a href="${link.map(b.id)}">Open map</a></p>`;
  }

  function wirePanel(ctx, root, onChange) {
    const btn = root.querySelector('[data-rm-add]');
    if (btn) btn.onclick = () => openEditor(ctx, { from: btn.dataset.rmAdd }, onChange);
  }

  window.RelMap = { render, panel, wirePanel, openEditor, TYPES };
})();
