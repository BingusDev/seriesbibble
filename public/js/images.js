/* Pictures on pages: uploading, pasting and the page's lead picture.
   app.js uses SBImages for the editor, the sidebar and overview cards; relmap.js for portraits. */
(function () {
  'use strict';

  // What the server can read. Others (HEIC from iPhones, say) are refused with a message.
  const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/tiff'];
  const MAX_BYTES = 25 * 1024 * 1024;

  const url = (bid, file) => `/api/bibles/${bid}/images/${file}`;
  const thumb = (bid, file) => `${url(bid, file)}?size=thumb`;

  // Sends a file or blob to the bible; resolves to { file, url, width, height }.
  async function upload(bid, blob) {
    if (blob.size > MAX_BYTES) throw new Error('That picture is over 25 MB.');
    const res = await fetch(`/api/bibles/${bid}/images`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* not json */ }
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  // Lets the writer pick a picture from their device; resolves to a File or null.
  function choose() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = () => resolve(input.files[0] || null);
      input.click();
    });
  }

  // Quill's uploader: toolbar button, dropped files and pasted screenshots all land here.
  function uploaderFor(getBible, toast) {
    return {
      mimetypes: TYPES,
      async handler(range, files) {
        const quill = this.quill;
        const b = getBible();
        if (!b) return;
        let index = range ? range.index : quill.getLength() - 1;
        toast(files.length > 1 ? `Adding ${files.length} pictures…` : 'Adding picture…');
        for (const file of files) {
          try {
            const saved = await upload(b.id, file);
            quill.insertEmbed(index, 'image', saved.url, 'user');
            index += 1;
          } catch (err) {
            toast(`Could not add ${file.name || 'the picture'}: ${err.message}`);
            return;
          }
        }
        quill.setSelection(index, 0, 'silent');
        toast(files.length > 1 ? 'Pictures added' : 'Picture added');
      },
    };
  }

  // Pictures pasted as part of rich text (from Word or a web page) arrive as data: URLs.
  // Each is uploaded once and swapped for its file, so the page never stores the raw bytes.
  const adopting = new WeakSet();
  async function adoptPasted(quill, bid, toast) {
    const imgs = [...quill.root.querySelectorAll('img[src^="data:"]')].filter((img) => !adopting.has(img));
    for (const img of imgs) {
      adopting.add(img);
      try {
        const blob = await (await fetch(img.src)).blob();
        const saved = await upload(bid, blob);
        const blot = Quill.find(img);
        if (!blot || !img.isConnected) continue;
        const index = quill.getIndex(blot);
        const sel = quill.getSelection();
        quill.updateContents({ ops: [{ retain: index }, { delete: 1 }, { insert: { image: saved.url } }] }, 'user');
        if (sel) quill.setSelection(sel, 'silent');
      } catch (err) {
        toast(`A pasted picture could not be saved: ${err.message}`);
      }
    }
  }

  // Pictures that point at the writer's own disk or a dead clipboard can never load for anyone else.
  function dropUnreachable(node, delta) {
    const src = node.getAttribute('src') || '';
    return /^(file|blob|webkit-fake-url):/i.test(src) ? { ops: [] } : delta;
  }

  // ---------- Lead picture ----------
  // The slot beside a page's title. `save(file|null)` stores the choice.
  function renderLead(slot, { bible, page, save, toast }) {
    const has = !!page.leadImage;
    slot.innerHTML = has
      ? `<button type="button" class="lead-pic" data-act="change" title="Change the page picture"><img src="${thumb(bible.id, page.leadImage)}" alt=""></button>
         <span class="lead-actions"><button type="button" class="link-btn" data-act="change">Change</button><button type="button" class="link-btn" data-act="remove">Remove</button></span>`
      : `<button type="button" class="lead-add" data-act="change" title="Add a picture for this page: a portrait, a location, a mood"><span aria-hidden="true">＋</span>Picture</button>`;
    slot.classList.toggle('has-pic', has);

    const use = async (file) => {
      if (!file) return;
      slot.classList.add('busy');
      try {
        const saved = await upload(bible.id, file);
        save(saved.file);
      } catch (err) {
        toast(`Could not add the picture: ${err.message}`);
      } finally {
        slot.classList.remove('busy');
      }
    };
    slot.querySelectorAll('[data-act="change"]').forEach((btn) => (btn.onclick = async () => use(await choose())));
    const remove = slot.querySelector('[data-act="remove"]');
    if (remove) remove.onclick = () => save(null);
    slot.ondragover = (e) => {
      if (![...e.dataTransfer.items].some((i) => i.kind === 'file')) return;
      e.preventDefault();
      slot.classList.add('drop');
    };
    slot.ondragleave = () => slot.classList.remove('drop');
    slot.ondrop = (e) => {
      e.preventDefault();
      slot.classList.remove('drop');
      const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
      if (file) use(file);
    };
  }

  // A picture in the page itself can become the page picture with a click.
  function pictureMenu(quill, { bible, onUse }) {
    let pop = null;
    const close = () => {
      if (pop) pop.remove();
      pop = null;
    };
    quill.root.addEventListener('click', (e) => {
      close();
      const img = e.target.closest('img');
      const m = img && (img.getAttribute('src') || '').match(/\/images\/([a-f0-9]{12}\.(?:jpg|png))$/);
      if (!m || !img.getAttribute('src').startsWith(`/api/bibles/${bible.id}/`)) return;
      pop = document.createElement('div');
      pop.className = 'pic-pop';
      pop.innerHTML = '<button type="button" class="btn small">Use as page picture</button>';
      const wrap = quill.root.closest('.editor-wrap');
      const w = wrap.getBoundingClientRect();
      pop.style.left = `${e.clientX - w.left + 6}px`;
      pop.style.top = `${e.clientY - w.top + 6}px`;
      wrap.appendChild(pop);
      pop.querySelector('button').onclick = () => {
        onUse(m[1]);
        close();
      };
    });
    quill.on('text-change', close);
    quill.root.addEventListener('keydown', (e) => e.key === 'Escape' && close());
    return close;
  }

  window.SBImages = { TYPES, url, thumb, upload, choose, uploaderFor, adoptPasted, dropUnreachable, renderLead, pictureMenu };
})();
