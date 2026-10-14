// Builds a single print-ready HTML document from a bible, then renders it to PDF or Word.
const fs = require('fs');
const HTMLtoDOCX = require('html-to-docx');
const JSZip = require('jszip');
const { slugify } = require('../public/js/slug');
const images = require('./images');
const relmap = require('./relmap-export');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const pageAnchor = (pid) => `p-${pid}`;
const headingAnchor = (pid, slug) => `p-${pid}-${slug}`;
const sectionAnchor = (sid) => `s-${sid}`;

// Quill 2 stores every list as <ol><li data-list="bullet|ordered">; turn them into real ul/ol.
function normalizeLists(html) {
  return html.replace(/<ol>([\s\S]*?)<\/ol>/g, (_, inner) => {
    const items = [...inner.matchAll(/<li([^>]*)>([\s\S]*?)<\/li>/g)].map((m) => {
      const type = /data-list="bullet"/.test(m[1]) ? 'ul' : 'ol';
      const indent = Number((m[1].match(/ql-indent-(\d+)/) || [])[1] || 0);
      return { type, indent, body: m[2] };
    });
    let out = '';
    let open = null;
    for (const item of items) {
      if (item.type !== open) {
        if (open) out += `</${open}>`;
        out += `<${item.type}>`;
        open = item.type;
      }
      const style = item.indent ? ` style="margin-left:${item.indent * 1.5}em"` : '';
      out += `<li${style}>${item.body}</li>`;
    }
    if (open) out += `</${open}>`;
    return out;
  });
}

// The printable area of a Letter page with 1in margins, in CSS pixels.
const PAGE_W = 624;
const PAGE_H = 816;

// Width and height that fit a picture inside a box without enlarging it.
function fit(w, h, maxW, maxH) {
  const scale = Math.min(1, maxW / w, maxH / h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

// Word reads a picture's size from its style, browsers from the attributes; give both.
const sized = (size) => `width="${size.width}" height="${size.height}" style="width:${size.width}px;height:${size.height}px"`;

// Page pictures are served from behind sign-in, so the exporter embeds them as data: URLs with
// a size that fits the page. Pictures from the web stay links for PDF; Word cannot fetch them.
function prepareImages(html, bible, assets, forWord) {
  return html.replace(/<img\b([^>]*)>/g, (tag, attrs) => {
    const src = (attrs.match(/\ssrc="([^"]*)"/) || [])[1] || '';
    const local = src.match(/^\/api\/bibles\/([a-f0-9]{12})\/images\/([a-f0-9]{12}\.(?:jpg|png))$/);
    const alt = (attrs.match(/\salt="([^"]*)"/) || [])[1] || '';
    if (local) {
      const img = local[1] === bible.id && assets.images && assets.images.get(local[2]);
      if (!img) return '';
      const size = fit(img.width, img.height, PAGE_W, PAGE_H * 0.5);
      return `<img src="${img.src}" alt="${alt}" ${sized(size)}>`;
    }
    if (forWord || !/^https?:\/\//.test(src)) return '';
    return `<img src="${src}" alt="${alt}">`;
  });
}

function leadImageHtml(page, assets) {
  const img = page.leadImage && assets.images && assets.images.get(page.leadImage);
  if (!img) return '';
  const size = fit(img.width, img.height, 220, 280);
  return `<p class="lead-image"><img src="${img.src}" alt="${esc(page.title)}" ${sized(size)}></p>`;
}

// Gives every heading an id and rewrites in-app links (#/b/:bid/p/:pid[/h/:slug]) to document anchors.
function preparePageHtml(page, bible, assets = {}, forWord = false) {
  let html = page.content || '';
  html = html.replace(/<span class="ql-ui"[^>]*><\/span>/g, '');
  html = prepareImages(html, bible, assets, forWord);
  html = normalizeLists(html);
  const seen = {};
  html = html.replace(/<h([1-3])([^>]*)>([\s\S]*?)<\/h\1>/g, (_, level, attrs, inner) => {
    const base = slugify(inner.replace(/<[^>]+>/g, '')) || 'heading';
    seen[base] = (seen[base] || 0) + 1;
    const slug = seen[base] > 1 ? `${base}-${seen[base]}` : base;
    // Page title is h2 in the export, so page headings sit one level below.
    const lvl = Math.min(Number(level) + 2, 6);
    return `<h${lvl}${attrs} id="${headingAnchor(page.id, slug)}">${inner}</h${lvl}>`;
  });
  html = html.replace(/href="#\/b\/([a-f0-9]+)\/p\/([a-f0-9]+)(?:\/h\/([^"]+))?"/g, (m, bid, pid, slug) => {
    if (bid !== bible.id) return m;
    return `href="#${slug ? headingAnchor(pid, decodeURIComponent(slug)) : pageAnchor(pid)}"`;
  });
  html = html.replace(/href="#\/b\/([a-f0-9]+)\/s\/([a-f0-9]+)"/g, (m, bid, sid) =>
    bid === bible.id ? `href="#${sectionAnchor(sid)}"` : m
  );
  html = dropEmptyHeadings(html);
  // Quill paragraphs that are only a line break print as blank lines; keep them small.
  html = html.replace(/<p><br><\/p>/g, '<p>&nbsp;</p>');
  return html;
}

const hasText = (html) => /<img\b/i.test(html) || /\S/.test(html.replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/g, ' '));

// Template headings nobody wrote under would print as a stack of empty titles, so a heading
// goes when nothing but blank lines sits under it (counting its own subheadings' text).
function dropEmptyHeadings(html) {
  const parts = [];
  const re = /<h([1-6])\b[^>]*>[\s\S]*?<\/h\1>/g;
  let last = 0;
  for (const m of html.matchAll(re)) {
    parts.push({ html: html.slice(last, m.index) });
    parts.push({ html: m[0], level: Number(m[1]) });
    last = m.index + m[0].length;
  }
  parts.push({ html: html.slice(last) });
  parts.forEach((p, i) => {
    if (!p.level) return;
    let filled = false;
    for (let j = i + 1; j < parts.length; j++) {
      if (parts[j].level && parts[j].level <= p.level) break;
      if (!parts[j].level && hasText(parts[j].html)) { filled = true; break; }
    }
    p.drop = !filled;
  });
  // The blank lines under a dropped heading go with it.
  return parts
    .filter((p, i) => !p.drop && !(!p.level && i > 0 && parts[i - 1].drop && !hasText(p.html)))
    .map((p) => p.html)
    .join('');
}

// Links to a heading that was left out point at its page instead.
function retargetMissing(html) {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  return html.replace(/href="#(p-([a-f0-9]+)-[^"]+)"/g, (m, id, pid) => (ids.has(id) ? m : `href="#${pageAnchor(pid)}"`));
}

const STYLES = `
  body { font-family: 'Courier Prime', 'Courier New', Courier, monospace; font-size: 12pt; color: #111; line-height: 1.45; }
  h1, h2, h3, h4, h5 { font-family: Georgia, 'Times New Roman', serif; }
  .title-page { text-align: center; padding-top: 30vh; page-break-after: always; }
  .title-page h1 { font-size: 30pt; margin: 0 0 12pt; }
  .title-page p { font-size: 13pt; font-style: italic; }
  .toc { page-break-after: always; }
  .toc ul { list-style: none; padding-left: 0; }
  .toc ul ul { padding-left: 1.5em; }
  .toc a { color: #111; text-decoration: none; }
  .section-title { font-size: 22pt; border-bottom: 2px solid #111; padding-bottom: 4pt; page-break-before: always; }
  .page-title { font-size: 16pt; margin-top: 18pt; }
  .page-body h3 { font-size: 15pt; }
  .page-body h4 { font-size: 13pt; border-bottom: 1px solid #ccc; padding-bottom: 2pt; }
  .page-body h5 { font-size: 12pt; }
  a { color: #1a4fa0; }
  blockquote { border-left: 3px solid #999; margin-left: 0; padding-left: 10pt; color: #444; }
  img { max-width: 100%; height: auto; page-break-inside: avoid; }
  .lead-image { float: right; margin: 0 0 10pt 16pt; }
  .lead-image img { border: 1px solid #ccc; }
  .page-body { clear: none; }
  .page-title { clear: both; }
  .rel-map { text-align: center; page-break-inside: avoid; }
  .rel-map svg { max-width: 100%; max-height: 8in; height: auto; }
  .rel-name { font-size: 13pt; margin-bottom: 4pt; }
  .rel-list { margin-top: 0; }
  .rel-list small { color: #666; }
`;

const MAP_ANCHOR = 'relationship-map';

// The relationship map chapter: the diagram, then every relationship as a list.
function mapChapter(bible, assets, forWord) {
  const list = relmap.listHtml(bible, pageAnchor);
  if (!list) return '';
  let picture = '';
  const map = assets.map;
  if (map && forWord && map.png) {
    const size = fit(map.width, map.height, PAGE_W, PAGE_H * 0.85);
    picture = `<p class="rel-map"><img src="${map.png}" alt="Relationship map" ${sized(size)}></p>`;
  } else if (map && !forWord && map.svg) {
    picture = `<div class="rel-map">${map.svg}</div>`;
  }
  return `<h1 class="section-title" id="${MAP_ANCHOR}">Relationships</h1>${picture}${list}`;
}

function buildHtml(bible, { forWord = false, assets = {} } = {}) {
  const chapter = mapChapter(bible, assets, forWord);
  const toc = bible.sections
    .map(
      (s) =>
        `<li><a href="#${sectionAnchor(s.id)}">${esc(s.name)}</a>` +
        (s.pages.length
          ? `<ul>${s.pages.map((p) => `<li><a href="#${pageAnchor(p.id)}">${esc(p.title)}</a></li>`).join('')}</ul>`
          : '') +
        '</li>'
    )
    .join('') + (chapter ? `<li><a href="#${MAP_ANCHOR}">Relationships</a></li>` : '');

  const body = bible.sections
    .map(
      (s) =>
        `<h1 class="section-title" id="${sectionAnchor(s.id)}">${esc(s.name)}</h1>` +
        s.pages
          .map(
            (p) =>
              `<h2 class="page-title" id="${pageAnchor(p.id)}">${esc(p.title)}</h2>` +
              leadImageHtml(p, assets) +
              `<div class="page-body">${preparePageHtml(p, bible, assets, forWord)}</div>`
          )
          .join('')
    )
    .join('') + chapter;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(bible.title)}</title>
<style>${forWord ? '' : STYLES}</style></head><body>
<div class="title-page"><h1>${esc(bible.title)}</h1>${bible.logline ? `<p>${esc(bible.logline)}</p>` : ''}<p>Series Bible</p></div>
<div class="toc"><h1>Contents</h1><ul>${toc}</ul></div>
${retargetMissing(body)}
</body></html>`;
}

// Reads every picture the bible's pages show and draws the relationship map, ready to embed.
async function loadAssets(bible, { forWord = false } = {}) {
  const files = new Set();
  for (const s of bible.sections) {
    for (const p of s.pages) {
      for (const f of images.filesIn(bible.id, p.content)) files.add(f);
      if (p.leadImage) files.add(p.leadImage);
    }
  }
  const loaded = new Map();
  for (const file of files) {
    if (!images.exists(bible.id, file)) continue;
    try {
      const { width, height } = await images.dimensions(bible.id, file);
      const type = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
      const data = fs.readFileSync(images.fileFor(bible.id, file)).toString('base64');
      loaded.set(file, { src: `data:${type};base64,${data}`, width, height });
    } catch (err) {
      console.error(`Could not read picture ${file}`, err.message);
    }
  }
  const assets = { images: loaded };
  const portrait = (page) => {
    const img = page.leadImage && loaded.get(page.leadImage);
    return img ? img.src : null;
  };
  const drawn = relmap.toSvg(bible, { portrait });
  if (drawn) {
    assets.map = { svg: drawn.svg, width: drawn.width, height: drawn.height };
    if (forWord) {
      try {
        const png = await require('sharp')(Buffer.from(drawn.svg), { density: 192 }).png().toBuffer();
        assets.map.png = `data:image/png;base64,${png.toString('base64')}`;
      } catch (err) {
        console.error('Could not draw the relationship map for Word', err.message);
      }
    }
  }
  return assets;
}

const CHROME_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/opt/pw-browsers/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean);

async function toPdf(bible) {
  const puppeteer = require('puppeteer-core');
  const executablePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!executablePath) throw new Error('No Chromium found; set CHROMIUM_PATH');
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(buildHtml(bible, { assets: await loadAssets(bible) }), { waitUntil: 'load' });
    return Buffer.from(
      await page.pdf({
        format: 'Letter',
        printBackground: true,
        margin: { top: '1in', bottom: '1in', left: '1in', right: '1in' },
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate: `<div style="font-size:9pt;width:100%;text-align:center;color:#666;font-family:Georgia,serif">${esc(
          bible.title
        )} — <span class="pageNumber"></span></div>`,
      })
    );
  } finally {
    await browser.close();
  }
}

// html-to-docx turns every link into an external hyperlink and drops element ids. To keep
// cross references clickable in Word, headings carry a marker that becomes a bookmark, and
// links to "#anchor" are rewritten into internal w:anchor hyperlinks.
const MARK = (id) => `[[BM:${id}]]`;

async function toDocx(bible) {
  let html = buildHtml(bible, { forWord: true, assets: await loadAssets(bible, { forWord: true }) });
  html = html.replace(/<(h[1-6])([^>]*?)\sid="([^"]+)"([^>]*)>/g, (_, tag, a, id, b) => `<${tag}${a}${b}>${MARK(id)}`);
  html = html.replace(/<div class="title-page">/, '<div class="title-page" style="text-align:center">');
  html = html.replace(/<div class="toc">/, '<div class="toc" style="page-break-before:always">');
  html = html.replace(/<h1 class="section-title"/g, '<h1 class="section-title" style="page-break-before:always"');

  const buf = await HTMLtoDOCX(html, null, {
    title: bible.title,
    font: 'Courier New',
    fontSize: 24,
    pageNumber: true,
    footer: true,
    margins: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
  });

  const zip = await JSZip.loadAsync(buf);
  const relsPath = 'word/_rels/document.xml.rels';
  const rels = await zip.file(relsPath).async('string');
  const anchorRels = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*?\/>/g)) {
    const id = (m[0].match(/Id="([^"]+)"/) || [])[1];
    const target = (m[0].match(/Target="#([^"]+)"/) || [])[1];
    if (id && target && /hyperlink/.test(m[0])) anchorRels[id] = target;
  }

  // Word bookmark names must be short and alphanumeric, so map each anchor to bm1, bm2, ...
  const names = {};
  const nameFor = (anchor) => (names[anchor] = names[anchor] || `bm${Object.keys(names).length + 1}`);
  let doc = await zip.file('word/document.xml').async('string');
  let bm = 0;
  doc = doc.replace(/\[\[BM:([^\]]+)\]\]/g, (_, id) => {
    bm += 1;
    // Close the current text run, drop the bookmark in, then reopen the run.
    return `</w:t></w:r><w:bookmarkStart w:id="${bm}" w:name="${nameFor(id)}"/><w:bookmarkEnd w:id="${bm}"/><w:r><w:t xml:space="preserve">`;
  });
  doc = doc.replace(/<w:hyperlink\b([^>]*?)r:id="([^"]+)"([^>]*)>/g, (m, a, rid, b) =>
    anchorRels[rid] && names[anchorRels[rid]] ? `<w:hyperlink${a}w:anchor="${names[anchorRels[rid]]}"${b}>` : m
  );
  zip.file('word/document.xml', doc);
  return zip.generateAsync({ type: 'nodebuffer' });
}

module.exports = { buildHtml, loadAssets, toPdf, toDocx, preparePageHtml };
