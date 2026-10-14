// A small, finished-looking sample bible, so a new writer can see what a bible looks like
// filled in: template headings with writing under them, cross-reference links, a picture-free
// relationship map, and a few extra sections. Pages refer to each other as [[Page Title]],
// which becomes an in-app link once every page has an id.
const store = require('./store');

const SAMPLE = {
  title: 'Low Tide',
  logline:
    'When the last lighthouse keeper on a fogbound island hears a drowned ship’s bell ringing under the water, she has one season to learn who sank it before the tide gives the secret back.',
  sections: [
    {
      name: 'Characters',
      kind: 'characters',
      pages: [
        {
          title: 'Mara Quill',
          body: {
            Overview: 'Keeper of [[The Lantern]] and the island’s reluctant memory. Mara is the last person on [[Saltcombe Island]] who still writes everything down, and the series follows her because she cannot stop asking questions the town settled years ago.',
            Appearance: 'Late thirties, weathered early. Oilskin coat two sizes too big (it was her father’s), ink on her fingers, a pencil behind one ear she forgets is there.',
            Personality: 'Dry, patient, stubborn past the point of sense. Under pressure she goes quiet and starts making lists. Generous with strangers, impossible with family.',
            Backstory: 'Her father kept the light before her and vanished in a storm when she was nineteen. The official story is that he fell. Mara has never believed it, and has never said so out loud.',
            Arc: 'Wants the truth about the bell. Needs to let other people carry some of the weight. By the finale she trusts [[Theo Quill]] with the logbook, and the town with the truth.',
            Relationships: 'Her brother [[Theo Quill]], who left and came back. [[Ada Brandt]], the inspector who reminds her of everything she dislikes about the mainland.',
          },
        },
        {
          title: 'Theo Quill',
          body: {
            Overview: 'Mara’s younger brother, back from the mainland with no money and a story that keeps changing. The charming one, and the one who knows more than he says.',
            Appearance: 'Early thirties. Good coat, bad boots. Smiles before he speaks.',
            Personality: 'Warm, funny, allergic to silence. Lies to make people comfortable, then believes the lie a little himself.',
            Backstory: 'Left Saltcombe the week after their father disappeared, and has avoided [[The Lantern]] ever since.',
            Arc: 'Starts the season running from the island. Ends it as the only person who can tell [[Mara Quill]] what happened the night of the storm.',
            Relationships: 'Adores [[Mara Quill]] and resents her in equal parts. Quietly feeding information to [[Ada Brandt]] from the second episode.',
          },
        },
        {
          title: 'Ada Brandt',
          body: {
            Overview: 'A mainland inspector sent to close an old file. Precise, polite, and the first outsider in years who takes Mara seriously.',
            Appearance: 'Forties, neat as a pin, never dressed for the weather.',
            Personality: 'Methodical and private. Uses kindness as a tool and is embarrassed when it turns out to be real.',
            Backstory: 'Grew up on a different island she does not talk about. Requested this posting.',
            Arc: 'Arrives to bury the case and ends up reopening it, at real cost to her career.',
            Relationships: 'Wary partnership with [[Mara Quill]]. Uses [[Theo Quill]] and feels bad about it.',
          },
        },
      ],
    },
    {
      name: 'World',
      kind: 'world',
      pages: [
        {
          title: 'Saltcombe Island',
          body: {
            Overview: 'A small island two hours from the mainland by ferry, when the ferry runs. Four hundred people, one pub, one road, and a great deal of fog.',
            History: 'Founded by three families who arrived on the same ship. The ship sank in the harbour a year later and nobody has ever agreed why.',
            'Key Locations': 'The harbour, the chapel with the empty bell tower, the pub, and [[The Lantern]] on the north point.',
            'Rules & Logic': 'Everyone knows everyone. News crosses the island faster than the road does. Nobody swims at low tide.',
          },
        },
        {
          title: 'The Lantern',
          body: {
            Overview: 'The lighthouse on the north point, and [[Mara Quill]]’s home. Automated on paper, kept by hand in practice.',
            History: 'Built by the founding families. Its logbooks go back a hundred and forty years, and one year is missing.',
            'Key Locations': 'The lamp room, the logbook shelf, the keeper’s kitchen, and the stairs down to the rocks.',
            'Rules & Logic': 'The light never goes out. The one time it did is the night the series is really about.',
          },
        },
      ],
    },
    {
      name: 'Episodes',
      kind: 'episodes',
      pages: [
        {
          title: '101 · The Bell',
          body: {
            Logline: 'During a storm, [[Mara Quill]] hears a bell ringing under the harbour, the same night her brother comes home.',
            'A Story': 'Mara tracks the sound and finds the wreck has shifted. She takes a rubbing of the bell’s inscription that should not exist.',
            'B Story': '[[Theo Quill]] arrives on the last ferry and moves into the spare room without asking.',
            'C Story': '[[Ada Brandt]] checks in at the pub and asks the wrong person about the missing logbook.',
            'Act Breakdown': 'Teaser: the bell. Act one: Theo. Act two: the wreck. Act three: Ada at the door of [[The Lantern]]. Tag: the light flickers.',
            'Character Moments': 'Mara lies to Theo for the first time. Theo tells his first truth.',
            'Setups & Payoffs': 'Plants the missing logbook year and the empty bell tower in [[Saltcombe Island]]’s chapel.',
          },
        },
      ],
    },
    {
      name: 'Tone & Style',
      kind: 'tone',
      pages: [
        {
          title: 'Look and Feel',
          body: {
            Tone: 'A slow-burn coastal mystery with a warm centre. Bleak weather, funny people.',
            Comparables: 'Broadchurch for the town, The Terror for the dread, Detectorists for the jokes.',
            'Visual Style': 'Long lenses, low light, the lamp as the only warm colour in most night scenes.',
            'Sound & Music': 'Foghorns, rope, wind. Score used sparingly, mostly strings.',
            'Dialogue & Voice': 'People talk around things. Nobody on the island says the word “drowned”.',
          },
        },
      ],
    },
  ],
  relationships: [
    { from: 'Mara Quill', to: 'Theo Quill', type: 'family', label: 'Siblings', mutual: true, note: 'Close once. Nineteen years of things unsaid.' },
    { from: 'Mara Quill', to: 'Ada Brandt', type: 'rival', label: 'Uneasy allies', mutual: true, note: 'Need each other, trust each other less.' },
    { from: 'Theo Quill', to: 'Ada Brandt', type: 'work', label: 'Informant', mutual: false, note: 'Theo passes her what he hears in the pub.' },
  ],
};

const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Creates the sample bible for a person and returns it.
function createSample(ownerId) {
  const bible = store.create({ title: SAMPLE.title, logline: SAMPLE.logline, ownerId });
  bible.sample = true; // so the home screen stops offering another copy
  bible.sections = SAMPLE.sections.map((s) => {
    const section = store.makeSection(s.name, s.kind);
    section.pages = s.pages.map((p) => ({ ...store.makePage(p.title, s.kind), body: p.body }));
    return section;
  });
  const ids = new Map(bible.sections.flatMap((s) => s.pages.map((p) => [p.title, p.id])));
  const linkify = (text) =>
    escHtml(text).replace(/\[\[([^\]]+)\]\]/g, (m, title) =>
      ids.has(title) ? `<a href="#/b/${bible.id}/p/${ids.get(title)}">${title}</a>` : title
    );
  for (const section of bible.sections) {
    for (const page of section.pages) {
      page.content = Object.entries(page.body)
        .map(([heading, text]) => `<h2>${escHtml(heading)}</h2><p>${linkify(text)}</p>`)
        .join('');
      delete page.body;
    }
  }
  bible.relmap = {
    relationships: SAMPLE.relationships.map((r) => ({ id: store.newId(), ...r, from: ids.get(r.from), to: ids.get(r.to) })),
    positions: {},
  };
  return store.write(bible);
}

module.exports = { createSample, SAMPLE };
