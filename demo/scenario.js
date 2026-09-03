/* ---------------------------------------------------------------------------
   The script the demo plays.

   Three kinds of thing live in here and they are deliberately kept apart:

     cast / beats      staging. Who is standing in the room, what the humans
                       say, what order it happens in. This is presentation and
                       it is authored, exactly like a screenplay.

     PROTECTED         the values the invariant is about. app.js counts how many
                       of these appear in the rendered transcript. It must be 0.

     FIXTURES          stand-in tool results, used ONLY when no MCP server is
                       reachable. When the server is up, every one of these is
                       ignored and the real tool result is rendered instead.
                       The connection badge in the header always says which.

   The tool NAMES and ARGUMENTS below are the real ones from docs/SPEC.md, so
   the same beat list drives both modes without editing.
--------------------------------------------------------------------------- */

window.EARSHOT_SCENARIO = (function () {
  'use strict';

  /* The same household src/domain/seed.ts seeds, so the scripted fallback and
     a live server tell one story instead of two. */
  const cast = {
    alexa:    { name: 'Alexa',    initials: 'A', role: '' },
    sarah:    { name: 'Sarah',    initials: 'S', role: 'daughter · linked' },
    dana:     { name: 'Dana',     initials: 'D', role: 'health aide · Tue & Fri' },
    margaret: { name: 'Margaret', initials: 'M', role: '82 · being cared for' },
  };

  /* Everyone the Echo is broadcasting to. None of them chose to be an
     audience; that is the whole problem. */
  const presence = [
    { who: 'margaret' },
    { who: 'sarah', asker: true },
    { who: 'dana' },
    { tail: '+ whoever else is standing there' },
  ];

  /* The values that must never reach the spoken channel. `alts` are the other
     spellings a text-to-speech layer might plausibly produce, so the counter
     cannot be beaten by writing "forty milligrams" instead of "40 mg". */
  const PROTECTED = [
    { id: 'med',  label: 'Medication name', value: 'Furosemide', alts: [] },
    { id: 'dose', label: 'Dose',            value: '40 mg',
      alts: ['40mg', '40 milligrams', 'forty milligrams'] },
    { id: 'dx',   label: 'Diagnosis',       value: 'Congestive heart failure',
      alts: ['heart failure', 'atrial fibrillation'] },
    { id: 'dr',   label: 'Prescriber',      value: 'Dr. Alan Whitfield',
      alts: ['Whitfield', 'Bay Cardiology'] },
    { id: 'chart', label: 'Full chart',     value: 'BCBSCA-7742-118-903',
      alts: ['Alameda de las Pulgas'] },
  ];

  /* Offered under the search box, so a sceptic does not have to think of a
     query. Every one of these is a real protected value. */
  const QUERIES = ['Furosemide', '40 mg', 'heart failure', 'Whitfield', 'BCBSCA'];

  const beats = [
    {
      id: 'open',
      at: '14:36',
      note: 'One Echo, three people, one of whom is not family. Nobody consented to be an audience.',
    },
    {
      id: 'adherence',
      at: '14:38',
      ask: { who: 'sarah', text: 'Alexa, did Mom take her medication today?' },
      tool: 'check_adherence',
      args: { window: 'today' },
      note: 'The question is answered in full. The answerable part is spoken; the identifying part is not.',
    },
    {
      id: 'provocation',
      at: '14:38',
      ask: { who: 'sarah', text: 'Say the medication name out loud.' },
      // Same tool, same arguments, on purpose. There is no `speak_detail`
      // flag to set: the detail is not in the response and no argument can
      // put it there. Asking twice gets the same answer, which IS the answer.
      tool: 'check_adherence',
      args: { window: 'today' },
      note: 'Ordered to read it out. It does not refuse the question — it refuses the channel.',
    },
    {
      id: 'bystander',
      at: '14:39',
      ask: { who: 'dana', text: 'Alexa, what is she taking? I need it for my notes.' },
      tool: 'check_adherence',
      args: { window: 'today' },
      note: 'No voiceprint, no guessing who spoke. Private detail goes to the linked device or nowhere.',
    },
    {
      id: 'whocansee',
      at: '14:40',
      ask: { who: 'sarah', text: 'Who can see Mom’s information?' },
      tool: 'who_can_see',
      args: {},
      note: 'Not a refuse-everything bot. Who holds access is exactly the thing that should be said aloud.',
    },
    {
      id: 'symptom',
      at: '14:41',
      ask: { who: 'sarah', text: 'She’s been dizzy standing up.' },
      tool: 'report_symptom',
      args: { description: 'dizzy when she stands up', severity: 2 },
      note: 'Writes as well as reads. The confirmation is audible, the clinical detail is not.',
    },
    {
      id: 'sealed',
      at: '14:42',
      ask: { who: 'sarah', text: 'Read me her full record.' },
      tool: 'care_summary',
      args: {},
      note: 'A third tier. Some things do not travel on the private channel either.',
    },
    {
      id: 'solo-open',
      at: '14:43',
      ask: { who: 'sarah', text: 'Alexa, I’m alone now.' },
      tool: 'open_solo_window',
      args: {},
      solo: 'open',
      note: 'The spec has exactly one exception, and it is logged the moment it opens.',
    },
    {
      id: 'solo-close',
      at: '14:44',
      tool: 'open_solo_window',
      args: { close: true },
      solo: 'close',
      system: true,
      note: 'Opened, logged, expired, used for nothing. The 0 is not an artefact of dodging the hard case — that was two minutes ago.',
    },
    {
      id: 'verify',
      at: '14:44',
      verify: 'Furosemide',
      note: 'Search the transcript yourself. The value is in the system; it is not in the room.',
    },
  ];

  /* ------------------------------------------------------------- FIXTURES --
     Stand-ins, used only with no MCP server reachable. Shape matches what
     adapter.js normalises a real tool result into, so the renderer cannot tell
     the difference and therefore cannot be written to favour one over the
     other. Latency is deliberately absent: a made-up millisecond count would
     be the one lie that actually matters here, so scripted mode shows a dash.
  ----------------------------------------------------------------------- */
  const FIXTURES = {
    adherence: {
      spoken: 'Yes. This morning’s dose went in at 8:04, right on time. ' +
              'There’s one detail I’ve put on your phone.',
      tier: 'private',
      private: {
        title: 'This morning’s dose',
        source: 'check_adherence',
        rows: [
          { k: 'Medication', v: 'Furosemide', hero: true },
          { k: 'Dose',       v: '40 mg, oral' },
          { k: 'Taken',      v: '08:04 — 4 minutes early' },
          { k: 'For',        v: 'Congestive heart failure' },
          { k: 'Prescriber', v: 'Dr. Alan Whitfield' },
        ],
      },
      disclosures: [
        { state: 'spoken',  what: 'Adherence and time', detail: 'taken, 8:04, on time' },
        { state: 'shifted', what: 'Medication, dose, indication', detail: '→ Sarah’s phone' },
      ],
    },

    provocation: {
      spoken: 'I can’t put that one in the room. It’s on your phone.',
      tier: 'private',
      refused: {
        reason: 'The spoken return type is a plain string built from the ' +
                'spoken-tier fields only. There is no code path that reaches ' +
                'a private field from it.',
      },
      private: null,
      disclosures: [
        { state: 'refused', what: 'Medication name, for the room', detail: 'structurally unavailable' },
        { state: 'shifted', what: 'Already delivered', detail: 'card is still on her phone' },
      ],
    },

    bystander: {
      spoken: 'Private detail goes to the account holder’s device, never ' +
              'into the room — whoever is asking.',
      tier: 'private',
      refused: {
        reason: 'No voiceprint and no device-id inference, so the speaker is ' +
                'unknown by design. Authorisation comes from the OAuth token ' +
                'on the session, not from the sound of a voice.',
      },
      private: null,
      disclosures: [
        { state: 'refused', what: 'Unlinked requester', detail: 'no grant on this token' },
      ],
    },

    whocansee: {
      spoken: 'Three people. You, your brother Daniel, and the agency’s ' +
              'on-call nurse — that one expires on Friday.',
      tier: 'spoken',
      private: null,
      disclosures: [
        { state: 'spoken', what: 'Full access list', detail: 'deliberately audible' },
      ],
    },

    symptom: {
      spoken: 'Logged at 2:41. I’ve flagged it to Daniel as well. ' +
              'The detail’s on your phone.',
      tier: 'private',
      private: {
        title: 'Symptom logged',
        source: 'report_symptom',
        rows: [
          { k: 'Symptom',  v: 'Dizziness on standing', hero: true },
          { k: 'Pattern',  v: '3rd episode in 8 days' },
          { k: 'May relate to', v: '40 mg Furosemide — orthostatic hypotension' },
          { k: 'Sent to',  v: 'Daniel (linked) · agency nurse line' },
        ],
      },
      disclosures: [
        { state: 'spoken',  what: 'Logged, and who was told', detail: '2:41, Daniel notified' },
        { state: 'shifted', what: 'Symptom detail and drug link', detail: '→ Sarah’s phone' },
      ],
    },

    sealed: {
      spoken: 'That one never leaves the app. It’s the first thing on the ' +
              'Earshot home screen.',
      tier: 'sealed',
      private: {
        title: 'Full care record',
        source: 'care_summary',
        tier: 'sealed',
        rows: [
          { k: 'Record',   v: '•••• •••••••', masked: true },
          { k: 'Contents', v: '41 pages · Bay Cardiology Associates' },
        ],
        action: 'Open in Earshot',
      },
      disclosures: [
        { state: 'sealed', what: 'Full record', detail: 'neither channel carries it' },
      ],
    },

    'solo-open': {
      spoken: 'Solo window open for five minutes. It goes in the ledger either way.',
      tier: 'spoken',
      private: null,
      disclosures: [
        { state: 'solo', what: 'Solo window opened', detail: '5:00 · single device · single asker' },
      ],
    },

    'solo-close': {
      spoken: 'Solo window closed. Back to assuming the room is full.',
      tier: 'spoken',
      private: null,
      disclosures: [
        { state: 'solo', what: 'Solo window closed', detail: 'nothing was disclosed under it' },
      ],
    },
  };

  return { cast, presence, PROTECTED, QUERIES, beats, FIXTURES };
})();
