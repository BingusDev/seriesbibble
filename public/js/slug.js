// Shared by the browser and the exporter so heading anchors match on both sides.
(function (root) {
  function slugify(text) {
    return String(text)
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { slugify };
  else root.slugify = slugify;
})(this);
