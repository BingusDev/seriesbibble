// Builds a single print-ready HTML document from a bible, then renders it to PDF or Word.
const fs = require('fs');
const HTMLtoDOCX = require('html-to-docx');
const JSZip = require('jszip');
const { slugify } = require('../public/js/slug');

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

// Gives every heading an id and rewrites in-app links (#/b/:bid/p/:pid[/h/:slug]) to document anchors.
function preparePageHtml(page, bible) {
  let html = page.content || '';
  html = html.replace(/<span class="ql-ui"[^>]*><\/span>/g, '');
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
  // Quill paragraphs that are only a line break print as blank lines; keep them small.
  html = html.replace(/<p><br><\/p>/g, '<p>&nbsp;</p>');
  return html;
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
`;

function buildHtml(bible, { forWord = false } = {}) {
  const toc = bible.sections
    .map(
      (s) =>
        `<li><a href="#${sectionAnchor(s.id)}">${esc(s.name)}</a>` +
        (s.pages.length
          ? `<ul>${s.pages.map((p) => `<li><a href="#${pageAnchor(p.id)}">${esc(p.title)}</a></li>`).join('')}</ul>`
          : '') +
        '</li>'
    )
    .join('');

  const body = bible.sections
    .map(
      (s) =>
        `<h1 class="section-title" id="${sectionAnchor(s.id)}">${esc(s.name)}</h1>` +
        s.pages
          .map(
            (p) =>
              `<h2 class="page-title" id="${pageAnchor(p.id)}">${esc(p.title)}</h2>` +
              `<div class="page-body">${preparePageHtml(p, bible)}</div>`
          )
          .join('')
    )
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(bible.title)}</title>
<style>${forWord ? '' : STYLES}</style></head><body>
<div class="title-page"><h1>${esc(bible.title)}</h1>${bible.logline ? `<p>${esc(bible.logline)}</p>` : ''}<p>Series Bible</p></div>
<div class="toc"><h1>Contents</h1><ul>${toc}</ul></div>
${body}
</body></html>`;
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
    await page.setContent(buildHtml(bible), { waitUntil: 'load' });
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
  let html = buildHtml(bible, { forWord: true });
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

module.exports = { buildHtml, toPdf, toDocx, preparePageHtml };
