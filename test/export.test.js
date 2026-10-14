const { test } = require('node:test');
const assert = require('node:assert');
const { buildHtml, preparePageHtml } = require('../src/export');

const bible = (pages) => ({ id: 'b1', title: 'T', sections: [{ id: 's1', name: 'Characters', pages }] });

test('headings with nothing written under them are left out of exports', () => {
  const page = {
    id: 'a1',
    content:
      '<h2>Overview</h2><p>Ana runs the docks.</p><h2>Appearance</h2><p><br></p>' +
      '<h2>Backstory</h2><h3>Childhood</h3><p><br></p><h3>The Flood</h3><p>She nearly drowned.</p>' +
      '<h2>Arc</h2><h3>Empty</h3><p><br></p>',
  };
  const html = preparePageHtml(page, bible([page]));
  assert.match(html, /Overview/);
  assert.match(html, /Backstory/, 'a heading counts its subheadings\' text');
  assert.match(html, /The Flood/);
  assert.doesNotMatch(html, /Appearance/);
  assert.doesNotMatch(html, /Childhood/);
  assert.doesNotMatch(html, /Arc|Empty/);
});

test('a link to a left-out heading points at its page instead', () => {
  const a = { id: 'a1', title: 'A', content: '<p>See <a href="#/b/b1/p/a2/h/appearance">her</a></p>' };
  const w = { id: 'a2', title: 'W', content: '<h2>Appearance</h2><p><br></p><p></p>' };
  const html = buildHtml(bible([a, w]));
  assert.ok(html.includes('href="#p-a2"'));
  assert.ok(!html.includes('p-a2-appearance'));
});
