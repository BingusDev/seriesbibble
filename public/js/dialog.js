/* In-app dialogs that replace the browser's confirm() and prompt(), in the binder look.
   Each returns a promise: confirm resolves true or false, prompt resolves the text or null. */
(function () {
  'use strict';

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Builds a modal form, focuses its first field, and settles once it closes.
  function open({ title, body, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, read }) {
    return new Promise((resolve) => {
      const back = document.activeElement;
      const wrap = document.createElement('div');
      wrap.className = 'modal-backdrop';
      wrap.innerHTML = `
        <form class="modal ask-modal" role="dialog" aria-modal="true" aria-labelledby="ask-title">
          <div class="modal-head">
            <h2 id="ask-title">${esc(title)}</h2>
            <button type="button" class="icon-btn" data-close aria-label="Close">×</button>
          </div>
          <div class="ask-body">${body}</div>
          <div class="modal-foot">
            ${cancelLabel ? `<button type="button" class="btn" data-close>${esc(cancelLabel)}</button>` : ''}
            <button class="btn ${danger ? 'danger-solid' : 'primary'}">${esc(confirmLabel)}</button>
          </div>
        </form>`;
      document.body.appendChild(wrap);
      const form = wrap.querySelector('form');
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        wrap.remove();
        if (back && back.focus && document.contains(back)) back.focus();
        resolve(value);
      };
      wrap.addEventListener('mousedown', (e) => {
        if (e.target === wrap) finish(read ? null : false);
      });
      wrap.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) finish(read ? null : false);
      });
      wrap.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(read ? null : false);
        }
      });
      form.onsubmit = (e) => {
        e.preventDefault();
        const value = read ? read(form) : true;
        if (value === undefined) return; // the form is not ready to send yet
        finish(value);
      };
      const field = form.querySelector('input, textarea');
      if (field) {
        field.focus();
        field.select();
      } else {
        form.querySelector('.modal-foot .btn:last-child').focus();
      }
    });
  }

  const SBDialog = {
    // confirm({ title, message, confirmLabel, danger }) -> Promise<boolean>
    confirm({ title, message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
      return open({ title, body: message ? `<p class="ask-text">${esc(message)}</p>` : '', confirmLabel, cancelLabel, danger });
    },

    // prompt({ title, label, value, placeholder, hint, confirmLabel }) -> Promise<string | null>
    prompt({ title, label = '', value = '', placeholder = '', hint = '', confirmLabel = 'OK', maxlength = 200 }) {
      return open({
        title,
        confirmLabel,
        body: `
          <label class="ask-field">${label ? `<span>${esc(label)}</span>` : ''}
            <input name="value" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="${maxlength}" autocomplete="off" required>
          </label>
          ${hint ? `<p class="ask-hint">${esc(hint)}</p>` : ''}`,
        read: (form) => (form.value.value.trim() ? form.value.value.trim() : undefined),
      });
    },

    // form({ title, body, confirmLabel, read(form) }) -> Promise<whatever read returns | null>
    form: (opts) => open(opts),

    // An information dialog with a single close button.
    info({ title, body }) {
      return open({ title, body, confirmLabel: 'Done', cancelLabel: '' });
    },
  };

  window.SBDialog = SBDialog;
})();
