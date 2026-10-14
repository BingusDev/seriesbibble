// The relationship map for exports: the same graph the app draws, as a static SVG, plus a
// plain list of every relationship so the printed bible reads well without the picture.
const relationships = require('./relationships');

// Print colours, matching the app's day-mode --rel-* tokens.
const TYPES = {
  family: { label: 'Family', color: '#2f7d4f' },
  romance: { label: 'Romance', color: '#c2185b' },
  ally: { label: 'Friend / ally', color: '#1a4fa0' },
  rival: { label: 'Rival / enemy', color: '#c0392b', dash: '7 5' },
  work: { label: 'Work', color: '#7a5c99' },
  other: { label: 'Other', color: '#6b675f' },
};
const typeOf = (k) => TYPES[k] || TYPES.other;
const R = 26;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Character pages, plus any other page related to one (as public/js/relmap.js does).
function graphOf(bible) {
  const map = relationships.prune(JSON.parse(JSON.stringify(bible)));
  const pages = new Map();
  for (const s of bible.sections) for (const p of s.pages) pages.set(p.id, { page: p, section: s });
  const rels = map.relationships.filter((r) => pages.has(r.from) && pages.has(r.to));
  const ids = new Set();
  for (const s of bible.sections) if (s.kind === 'characters') s.pages.forEach((p) => ids.add(p.id));
  rels.forEach((r) => { ids.add(r.from); ids.add(r.to); });
  return { nodes: [...ids].map((id) => ({ id, ...pages.get(id) })), rels, pages, positions: map.positions };
}

// The app's force-directed layout, made repeatable: dragged characters stay where the writer put them.
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
        if (d < 1) { dx = ((i * 7 + j) % 5) - 2 || 1; dy = ((i + j * 3) % 5) - 2 || 1; d = Math.hypot(dx, dy); }
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

function initials(title) {
  const words = String(title).trim().split(/\s+/).filter(Boolean);
  return ((words[0] || '?')[0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Returns { svg, width, height } or null when there is nothing to draw.
// `portrait(page)` may return a data: URL to show a character's lead image in their circle.
function toSvg(bible, { portrait = () => null } = {}) {
  const { nodes, rels, positions } = graphOf(bible);
  if (!rels.length) return null;
  const pos = layout(nodes, rels, positions);

  const pairs = {};
  rels.forEach((r) => {
    const key = [r.from, r.to].sort().join('|');
    (pairs[key] = pairs[key] || []).push(r);
  });
  const offsetOf = {};
  for (const list of Object.values(pairs)) {
    list.forEach((r, i) => {
      const base = (i - (list.length - 1) / 2) * 64;
      offsetOf[r.id] = r.from < r.to ? base : -base;
    });
  }

  const xs = nodes.map((x) => pos[x.id].x);
  const ys = nodes.map((x) => pos[x.id].y);
  const pad = 80;
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const width = Math.round(Math.max(...xs) + pad - minX);
  const height = Math.round(Math.max(...ys) + pad + 20 - minY);

  const font = "font-family=\"Georgia, 'Times New Roman', serif\"";
  const markers = Object.entries(TYPES)
    .map(([k, t]) => `<marker id="end-${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${t.color}"/></marker>`)
    .join('');
  const clips = [];
  const edges = rels
    .map((r) => {
      const t = typeOf(r.type);
      const g = edgeGeometry(pos[r.from], pos[r.to], offsetOf[r.id], !r.mutual);
      const text = clip(r.label || t.label, 28);
      const w = text.length * 6.4 + 14;
      return `<path d="${g.d}" fill="none" stroke="${t.color}" stroke-width="2"${t.dash ? ` stroke-dasharray="${t.dash}"` : ''}${r.mutual ? '' : ` marker-end="url(#end-${r.type in TYPES ? r.type : 'other'})"`}/>
<rect x="${(g.mid.x - w / 2).toFixed(1)}" y="${(g.mid.y - 10).toFixed(1)}" width="${w.toFixed(1)}" height="20" rx="10" fill="#ffffff" stroke="${t.color}"/>
<text x="${g.mid.x.toFixed(1)}" y="${(g.mid.y + 4).toFixed(1)}" text-anchor="middle" font-size="11" ${font} fill="${t.color}">${esc(text)}</text>`;
    })
    .join('\n');
  const circles = nodes
    .map((x, i) => {
      const p = pos[x.id];
      const isChar = x.section.kind === 'characters';
      const img = portrait(x.page);
      let face = `<text y="5" text-anchor="middle" font-size="15" font-weight="bold" ${font} fill="#23201b">${esc(initials(x.page.title))}</text>`;
      if (img) {
        clips.push(`<clipPath id="face-${i}"><circle r="${R - 1}"/></clipPath>`);
        face = `<image href="${img}" x="${-R}" y="${-R}" width="${2 * R}" height="${2 * R}" preserveAspectRatio="xMidYMid slice" clip-path="url(#face-${i})"/>`;
      }
      return `<g transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">
<circle r="${R}" fill="${isChar ? '#f3e3db' : '#efeae0'}" stroke="${isChar ? '#8a2c1d' : '#736c60'}" stroke-width="2"${isChar ? '' : ' stroke-dasharray="4 3"'}/>
${face}
<text y="${R + 17}" text-anchor="middle" font-size="12.5" ${font} fill="#23201b">${esc(clip(x.page.title, 24))}</text>
</g>`;
    })
    .join('\n');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX.toFixed(1)} ${minY.toFixed(1)} ${width} ${height}">
<defs>${markers}${clips.join('')}</defs>
<rect x="${minX.toFixed(1)}" y="${minY.toFixed(1)}" width="${width}" height="${height}" fill="#ffffff"/>
${edges}
${circles}
</svg>`;
  return { svg, width, height };
}

// One entry per character: what they are to each of the others, with the notes.
// `anchor(pid)` gives the export's anchor for a page so names link to their pages.
function listHtml(bible, anchor) {
  const { nodes, rels, pages } = graphOf(bible);
  if (!rels.length) return '';
  const name = (pid) => `<a href="#${anchor(pid)}">${esc(pages.get(pid).page.title)}</a>`;
  const items = nodes
    .map((x) => {
      const mine = rels.filter((r) => r.from === x.id || r.to === x.id);
      if (!mine.length) return '';
      const lines = mine.map((r) => {
        const t = typeOf(r.type);
        const label = esc(r.label || t.label.toLowerCase());
        const line = r.mutual
          ? `${name(r.from)} ↔ ${name(r.to)}: ${label}`
          : `${name(r.from)} → ${name(r.to)}: ${label}`;
        const note = r.note ? `<br><em>${esc(r.note)}</em>` : '';
        return `<li>${line} <small>(${esc(t.label)}${r.mutual ? '' : ', one way'})</small>${note}</li>`;
      });
      return `<h3 class="rel-name">${esc(x.page.title)}</h3><ul class="rel-list">${lines.join('')}</ul>`;
    })
    .join('');
  return items;
}

module.exports = { toSvg, listHtml, graphOf, layout, TYPES };
