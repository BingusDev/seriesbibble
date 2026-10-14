// Section templates: the headings each new page in a section starts with, and a
// writing prompt for each heading. Prompts are shown beside the editor, never
// stored in the page, so they stay out of exports.
const TEMPLATES = [
  {
    kind: 'characters',
    name: 'Characters',
    singular: 'character',
    description: 'One page per character: who they are, what they want, how they change.',
    headings: [
      { title: 'Overview', prompt: 'Who is this person in one or two sentences? Their role in the series and why we follow them.' },
      { title: 'Appearance', prompt: 'What does the audience notice first? Age, look, how they carry themselves, what they wear.' },
      { title: 'Personality', prompt: 'How do they talk and behave under pressure? Strengths, flaws, habits, contradictions.' },
      { title: 'Backstory', prompt: 'What happened before episode one that still shapes them? Wounds, secrets, turning points.' },
      { title: 'Arc', prompt: 'What do they want, what do they need, and how are they different by the end of the season?' },
      { title: 'Relationships', prompt: 'Who matters to them and why? Link to other character pages to keep the web connected.' },
    ],
  },
  {
    kind: 'world',
    name: 'World',
    singular: 'world entry',
    description: 'The setting: its history, places and the rules everything obeys.',
    headings: [
      { title: 'Overview', prompt: 'What is this world, place or system, and why does it matter to the story?' },
      { title: 'History', prompt: 'What past events made it the way it is? Note anything characters still argue about.' },
      { title: 'Key Locations', prompt: 'Where do scenes happen here? Give each place a look, a mood and a purpose.' },
      { title: 'Rules & Logic', prompt: 'What can and can not happen here? Laws, technology, magic, social codes and their costs.' },
    ],
  },
  {
    kind: 'episodes',
    name: 'Episodes',
    singular: 'episode',
    description: 'One page per episode: logline, beats and what it sets up.',
    headings: [
      { title: 'Logline', prompt: 'One or two sentences: who wants what in this episode, and what stands in the way?' },
      { title: 'A Story', prompt: 'The main plot. Whose story is it, what is the goal, and how does it resolve?' },
      { title: 'B Story', prompt: 'The secondary plot. How does it echo or complicate the A story?' },
      { title: 'C Story', prompt: 'Any runner or comic thread, or a seed for a later episode.' },
      { title: 'Act Breakdown', prompt: 'Teaser, act outs and tag. What is the cliffhanger at each break?' },
      { title: 'Character Moments', prompt: 'Which characters change, reveal something or make a choice here?' },
      { title: 'Setups & Payoffs', prompt: 'What does this episode plant for later, and what earlier setups does it pay off?' },
    ],
  },
  {
    kind: 'seasons',
    name: 'Season Arcs',
    singular: 'season',
    description: 'The shape of each season: its question, turning points and ending.',
    headings: [
      { title: 'Season Question', prompt: 'The dramatic question this season asks and answers.' },
      { title: 'Beginning', prompt: 'Where does everyone stand in the premiere? What disrupts it?' },
      { title: 'Midpoint', prompt: 'What changes halfway through that makes going back impossible?' },
      { title: 'Finale', prompt: 'How does the season end, and what is the hook for the next one?' },
      { title: 'Character Arcs', prompt: 'For each lead, where they start and where they end this season.' },
      { title: 'Episode Map', prompt: 'A line per episode, linked to its page, showing how the arc moves.' },
    ],
  },
  {
    kind: 'themes',
    name: 'Themes',
    singular: 'theme',
    description: 'The ideas the series explores and how the story dramatizes them.',
    headings: [
      { title: 'Statement', prompt: 'State the theme as a question or argument, not a single word. "Can loyalty survive ambition?"' },
      { title: 'Why It Matters', prompt: 'Why this story, and why now? What should the audience feel or wonder afterwards?' },
      { title: 'How Characters Embody It', prompt: 'Which characters take which side of the argument? Link to their pages.' },
      { title: 'Motifs & Imagery', prompt: 'Recurring images, objects, colors, music or lines of dialogue that carry the theme.' },
      { title: 'Key Scenes', prompt: 'Moments where the theme comes to the surface. Link to the episodes they happen in.' },
    ],
  },
  {
    kind: 'timeline',
    name: 'Timeline',
    singular: 'timeline',
    description: 'Events in the order they happened, in the past and on screen.',
    headings: [
      { title: 'Period', prompt: 'What span of time does this page cover? Give dates, years or relative markers like "Ten years before the pilot".' },
      { title: 'Before the Series', prompt: 'Backstory events in order, one line each. Note which ones the audience learns about and when.' },
      { title: 'During the Series', prompt: 'On-screen events in story order, each linked to the episode where it happens.' },
      { title: 'Open Questions', prompt: 'Dates or orders of events not decided yet, so continuity stays honest.' },
    ],
  },
  {
    kind: 'locations',
    name: 'Locations',
    singular: 'location',
    description: 'Recurring sets and places, written for both story and production.',
    headings: [
      { title: 'Description', prompt: 'What it looks, sounds and feels like. What do we see in the establishing shot?' },
      { title: 'Story Function', prompt: 'What kind of scenes happen here, and who belongs here or does not?' },
      { title: 'Who Is Here', prompt: 'Characters who live, work or turn up here. Link to their pages.' },
      { title: 'Production Notes', prompt: 'Practical notes: interior or exterior, day or night, stage or location, budget concerns.' },
    ],
  },
  {
    kind: 'tone',
    name: 'Tone & Style',
    singular: 'page',
    description: 'How the show looks, sounds and feels, for writers and directors.',
    headings: [
      { title: 'Tone', prompt: 'Describe the feel in a few words, then explain it. Where does it sit between comedy and drama?' },
      { title: 'Comparables', prompt: 'Shows and films this lives next to, and how it is different from each.' },
      { title: 'Visual Style', prompt: 'Camera, color, light, framing. What would a director need to know?' },
      { title: 'Sound & Music', prompt: 'Score, needle drops, silence, recurring sounds.' },
      { title: 'Dialogue & Voice', prompt: 'How do people talk in this world? What would never be said?' },
    ],
  },
  {
    kind: 'custom',
    name: 'Blank',
    singular: 'page',
    description: 'Empty pages with no headings, for anything else.',
    headings: [],
  },
];

const byKind = Object.fromEntries(TEMPLATES.map((t) => [t.kind, t]));

const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Starting HTML for a new page: each heading followed by an empty paragraph.
function pageContent(kind) {
  const t = byKind[kind] || byKind.custom;
  if (!t.headings.length) return '<p><br></p>';
  return t.headings.map((h) => `<h2>${escHtml(h.title)}</h2><p><br></p>`).join('');
}

// Picks the template whose name matches a section name, so a section typed as
// "Episodes" gets episode pages without the writer choosing it.
function kindForName(name) {
  const n = String(name || '').trim().toLowerCase();
  const t = TEMPLATES.find((x) => x.kind !== 'custom' && (x.name.toLowerCase() === n || x.kind === n));
  return t ? t.kind : 'custom';
}

const isKind = (kind) => Object.prototype.hasOwnProperty.call(byKind, kind);

module.exports = { TEMPLATES, pageContent, kindForName, isKind };
