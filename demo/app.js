/* ---------------------------------------------------------------------------
   Earshot demo — the engine.

   Two rules this file exists to enforce, and they are worth stating because
   they are the difference between a demo and a claim:

   1. The transcript element is the ONLY place spoken text is ever written, and
      the only string it is ever given is `result.spoken`. `result.private` is
      not in scope in the function that writes it.

   2. The "0" in the bottom strip is not a variable anybody increments. After
      every render it is recomputed by reading the rendered transcript back out
      of the DOM and searching it for the protected values. If the number is 0,
      it is 0 because the characters are not on the screen — the same thing the
      viewer can check by hand with the search box next to it.

   If a protected value ever does land in the transcript, the whole screen goes
   red. A demo that cannot fail is not evidence of anything.
--------------------------------------------------------------------------- */

(function () {
  'use strict';

  const S = window.EARSHOT_SCENARIO;
  const A = window.EarshotAdapter;
  const params = new URLSearchParams(location.search);

  const $ = (id) => document.getElementById(id);
  const el = {
    now: $('now'), nowK: $('now-k'), nowV: $('now-v'),
    conn: $('conn'), connTxt: $('conn-txt'),
    presence: $('presence'), transcript: $('transcript'),
    solo: $('solo'), soloT: $('solo-t'),
    railSpoken: $('rail-spoken'), railPrivate: $('rail-private'), pill: $('pill'),
    cards: $('cards'), screenEmpty: $('screen-empty'),
    ledger: $('ledger'), ledgerEmpty: $('ledger-empty'),
    counter: $('counter'), counterBox: document.querySelector('.counter-box'),
    counterSub: $('counter-sub'),
    q: $('q'), chips: $('chips'),
    vRoom: $('v-room'), vRoomSub: $('v-room-sub'), vRoomCol: document.querySelector('.vcol-room'),
    vPhone: $('v-phone'), vPhoneSub: $('v-phone-sub'), vPhoneCol: document.querySelector('.vcol-phone'),
    rawBtn: $('raw-btn'), raw: $('raw'), rawPre: $('raw-pre'),
    rawMeta: $('raw-meta'), rawFoot: $('raw-foot'), rawClose: $('raw-close'),
    breach: $('breach'), breachTxt: $('breach-txt'),
    hint: $('hint'),
  };

  const SPEED = Number(params.get('speed') || 1);
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, REDUCED ? 0 : ms / SPEED));

  const state = { cursor: -1, busy: false, auto: false, soloEnd: 0, soloTimer: 0,
                  declared: [], spokenBy: {} };

  /* Which values the invariant is about.

     Scripted mode has no server, so it falls back to the list in scenario.js.
     A live server ships its own list on every result, and that one wins: a page
     grading itself against protected values it chose is not evidence, and a
     real server's data has nothing to do with this demo's fixtures anyway. */
  function activeProtected() {
    return state.declared.length ? state.declared : S.PROTECTED;
  }

  function absorbDeclared(res) {
    if (!res || !Array.isArray(res.protected)) return false;
    let added = false;
    for (const p of res.protected) {
      if (!p || typeof p.value !== 'string') continue;
      if (state.declared.some((d) => d.value === p.value)) continue;
      state.declared.push({ label: p.label || 'Protected value', value: p.value,
                            alts: Array.isArray(p.alts) ? p.alts : [],
                            chip: p.chip === true });
      added = true;
    }
    return added;
  }

  /* ------------------------------------------------------------ icons ---- */

  const ICON = {
    spoken:  '<path d="M3 7h2.6L9 4v12l-3.4-3H3z" fill="currentColor"/>' +
             '<path d="M12.4 6.6a4.4 4.4 0 0 1 0 6.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    shifted: '<path d="M2.5 10h9" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>' +
             '<path d="M8.6 6.6 12 10l-3.4 3.4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>' +
             '<rect x="13.6" y="3.6" width="4.4" height="12.8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.9"/>',
    refused: '<circle cx="10" cy="10" r="6.6" fill="none" stroke="currentColor" stroke-width="1.9"/>' +
             '<path d="M5.6 5.6 14.4 14.4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    sealed:  '<rect x="4" y="8.6" width="12" height="7.6" rx="2" fill="currentColor"/>' +
             '<path d="M6.8 8.6V6.4a3.2 3.2 0 0 1 6.4 0v2.2" fill="none" stroke="currentColor" stroke-width="1.9"/>',
    solo:    '<circle cx="10" cy="10" r="6.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="3 2.6"/>' +
             '<path d="M10 6.2V10l2.6 1.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  };
  const WORD = { spoken: 'Spoken', shifted: 'Shifted', refused: 'Refused',
                 sealed: 'Sealed', solo: 'Solo window' };

  function chip(kind) {
    return '<span class="chip" data-s="' + kind + '">' +
           '<svg viewBox="0 0 20 20" aria-hidden="true">' + (ICON[kind] || '') + '</svg>' +
           WORD[kind] + '</span>';
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* -------------------------------------------------------- chrome setup -- */

  function renderPresence() {
    el.presence.innerHTML = S.presence.map((p) => {
      if (p.tail) return '<li class="tail">' + esc(p.tail) + '</li>';
      const c = S.cast[p.who];
      return '<li' + (p.asker ? ' class="asker"' : '') + '>' +
             '<span class="av">' + esc(c.initials) + '</span>' +
             '<b>' + esc(c.name) + '</b>&nbsp;<span>' + esc(c.role) + '</span></li>';
    }).join('');
  }

  function renderChips() {
    // With a live server there may be dozens of protected strings; only the
    // short high-signal ones make usable buttons.
    const marked = state.declared.filter((p) => p.chip);
    const qs = state.declared.length
      ? (marked.length ? marked : state.declared).map((p) => p.value)
      : S.QUERIES;
    el.chips.innerHTML = qs.map((q) =>
      '<button class="qchip" type="button" aria-pressed="false" data-q="' + esc(q) + '">' +
      esc(q) + '</button>').join('');
  }

  function wireChips() {
    el.chips.addEventListener('click', (e) => {
      const b = e.target.closest('.qchip');
      if (!b) return;
      el.q.value = el.q.value === b.dataset.q ? '' : b.dataset.q;
      verify();
    });
  }

  function badge(mode, text) {
    el.conn.dataset.mode = mode;
    el.connTxt.textContent = text;
  }

  /* -------------------------------------------------------- the corpora -- */

  /* Everything the room has heard, as one string, read back out of the DOM
     that is on screen. Built from the .said nodes only -- the chips and pane
     labels around them are our commentary, not something anyone heard, and
     padding the corpus with our own words would make the character count a
     lie. This is what the counter, the search box and the raw view all read. */
  function roomCorpus() {
    const NL = String.fromCharCode(10);
    return Array.from(el.transcript.querySelectorAll('.utt')).map((li) =>
      li.dataset.speaker + '  ' + li.dataset.at + NL +
      li.querySelector('.said').textContent).join(NL + NL);
  }
  function phoneCorpus() { return el.cards.innerText || ''; }

  const rx = (term) =>
    new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

  function countIn(corpus, terms) {
    let n = 0;
    for (const t of terms) {
      if (!t) continue;
      const m = corpus.match(rx(t));
      if (m) n += m.length;
    }
    return n;
  }

  const allTerms = () =>
    activeProtected().reduce((a, p) => a.concat([p.value], p.alts || []), []);

  /* ------------------------------------------------- the invariant check -- */

  function audit() {
    const corpus = roomCorpus();
    const list = activeProtected();
    const breached = list.filter((p) =>
      [p.value].concat(p.alts || []).some((t) => rx(t).test(corpus)));

    el.counter.textContent = String(breached.length);
    el.counterBox.dataset.breach = breached.length ? '1' : '0';
    el.counterSub.textContent = breached.length
      ? 'found in the rendered transcript'
      : state.declared.length
        ? list.length + ' values the server marked protected, checked against the ' +
          'rendered transcript'
        : 'counted by scanning the rendered transcript, not by trusting a variable';

    if (breached.length) {
      el.breachTxt.textContent =
        'A protected value reached the spoken channel: ' +
        breached.map((p) => p.label + ' (' + p.value + ')').join(', ');
      el.breach.hidden = false;
    }
    return breached.length;
  }

  /* -------------------------------------------------------- the verifier -- */

  function verify() {
    const q = el.q.value.trim();
    const terms = q ? [q] : allTerms();
    const room = roomCorpus();
    const phone = phoneCorpus();
    const hitsRoom = countIn(room, terms);
    const hitsPhone = countIn(phone, terms);
    const chars = room.replace(/\s+/g, ' ').length;

    el.vRoom.textContent = String(hitsRoom);
    el.vRoomCol.dataset.hit = hitsRoom ? '1' : '0';
    el.vRoomSub.textContent = 'in ' + chars.toLocaleString() + ' characters heard';

    el.vPhone.textContent = String(hitsPhone);
    el.vPhoneCol.dataset.hit = hitsPhone ? '1' : '0';
    el.vPhoneSub.textContent = q
      ? (hitsPhone ? 'the value does exist' : 'not on this card yet')
      : 'across ' + activeProtected().length + ' protected values';

    for (const b of el.chips.querySelectorAll('.qchip')) {
      b.setAttribute('aria-pressed', String(b.dataset.q === q));
    }
    if (!el.raw.hidden) paintRaw();
  }

  function paintRaw() {
    const q = el.q.value.trim();
    const terms = q ? [q] : allTerms();
    const corpus = roomCorpus();
    let html = esc(corpus);
    for (const t of terms) {
      if (t) html = html.replace(rx(esc(t)), (m) => '<mark>' + m + '</mark>');
    }
    el.rawPre.innerHTML = html || '<em>nothing spoken yet</em>';
    const hits = countIn(corpus, terms);
    el.rawMeta.textContent = corpus.replace(/\s+/g, ' ').length.toLocaleString() +
      ' characters · searching for ' +
      (q ? '"' + q + '"' : 'all ' + activeProtected().length + ' protected values');
    el.rawFoot.dataset.hit = hits ? '1' : '0';
    el.rawFoot.textContent = hits
      ? hits + ' match' + (hits === 1 ? '' : 'es') + ' — the invariant is broken'
      : 'No match. Not one protected value was ever spoken in this room.';
  }

  /* -------------------------------------------------------------- render -- */

  function utterance(who, text, opts) {
    const c = S.cast[who];
    const li = document.createElement('li');
    li.className = 'utt ' + (who === 'alexa' ? 'utt-alexa' : 'utt-human');
    li.dataset.speaker = c.name;
    li.dataset.at = (opts && opts.at) || '';
    if (opts && opts.refused) li.dataset.refused = '1';
    li.innerHTML =
      '<div class="who"><span class="av' + (who === 'alexa' ? ' av-alexa' : '') + '">' +
      esc(c.initials) + '</span>' + esc(c.name) +
      '<span class="sep">·</span><span class="ts">' + esc(opts && opts.at || '') + '</span></div>' +
      '<p class="said"></p>' +
      (opts && opts.tags ? '<div class="tags">' + opts.tags + '</div>' : '');
    // Assigned as text, never as HTML, and only ever from `spoken`.
    li.querySelector('.said').textContent = text;
    el.transcript.appendChild(li);
    el.transcript.scrollTop = el.transcript.scrollHeight;
    audit();
    verify();
  }

  /* Her question, echoed on her own device. Only when she is the one asking:
     a bystander's question happens in the room, and putting it on her screen
     would imply the device knows who spoke, which is exactly the inference
     this product refuses to make. */
  function bubble(text) {
    el.screenEmpty.hidden = true;
    const d = document.createElement('div');
    d.className = 'bubble';
    d.textContent = '“' + text + '”';
    el.cards.appendChild(d);
    el.cards.scrollTop = el.cards.scrollHeight;
  }

  /* Not every turn sends something. Without a line saying so, her phone reads
     as three unanswered questions in a row, which is a worse lie than the one
     we are trying to avoid. */
  function phoneNote(text) {
    el.screenEmpty.hidden = true;
    const d = document.createElement('p');
    d.className = 'pnote';
    d.textContent = text;
    el.cards.appendChild(d);
    el.cards.scrollTop = el.cards.scrollHeight;
  }

  function card(priv, at, ms) {
    el.screenEmpty.hidden = true;
    const sealed = (priv.tier || '') === 'sealed';
    const art = document.createElement('article');
    art.className = 'card';
    art.dataset.tier = sealed ? 'sealed' : 'private';
    art.innerHTML =
      '<header><span class="tier ' + (sealed ? 'tier-sealed' : 'tier-private') + '">' +
      (sealed ? 'Sealed · app only' : 'Private · this device') + '</span>' +
      '<time>' + esc(at || '') + '</time></header>' +
      '<h3>' + esc(priv.title || '') + '</h3>' +
      '<dl>' + (priv.rows || []).map((r) =>
        '<div class="row"><dt>' + esc(r.k) + '</dt>' +
        '<dd class="' + (r.hero ? 'hero' : '') + (r.masked ? ' masked' : '') + '">' +
        esc(r.v) + '</dd></div>').join('') + '</dl>' +
      (priv.action ? '<button class="openapp" type="button">' +
        '<svg viewBox="0 0 20 20" class="gl" aria-hidden="true">' + ICON.sealed + '</svg>' +
        esc(priv.action) + '</button>' : '') +
      '<footer><span>' + esc(priv.source || '') + '</span>' +
      '<span>' + (typeof ms === 'number' ? ms + ' ms' : '—') + '</span></footer>';
    el.cards.appendChild(art);
    el.cards.scrollTop = el.cards.scrollHeight;
    verify();
  }

  function ledgerRow(d, at, ms) {
    el.ledgerEmpty.hidden = true;
    const li = document.createElement('li');
    li.className = 'lrow';
    li.dataset.state = d.state;
    li.innerHTML = chip(d.state) +
      '<span class="lwhat"><b>' + esc(d.what) + '</b>' +
      (d.detail ? ' — ' + esc(d.detail) : '') + '</span>' +
      '<span class="lms">' + (typeof ms === 'number' ? ms + ' ms' : (at || '')) + '</span>';
    el.ledger.appendChild(li);
    el.ledger.scrollTop = el.ledger.scrollHeight;
  }

  /* ------------------------------------------------------------- gutter -- */

  async function rails(spoken, priv) {
    el.railSpoken.classList.toggle('hot', !!spoken);
    el.railSpoken.classList.toggle('cold', !spoken);
    el.railPrivate.classList.toggle('hot', !!priv);
    el.railPrivate.classList.toggle('cold', !priv);
    if (priv && !REDUCED) {
      el.pill.hidden = false;
      el.pill.classList.remove('run');
      void el.pill.offsetWidth;
      el.pill.classList.add('run');
      await sleep(700);
      el.pill.hidden = true;
    }
  }

  function coolRails() {
    for (const r of [el.railSpoken, el.railPrivate]) r.classList.remove('hot', 'cold');
  }

  /* --------------------------------------------------------- solo window -- */

  function soloTick() {
    const left = Math.max(0, state.soloEnd - Date.now());
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    el.soloT.textContent = m + ':' + String(s).padStart(2, '0');
    if (left <= 0) stopSolo();
  }
  function startSolo() {
    state.soloEnd = Date.now() + 5 * 60 * 1000;
    el.solo.hidden = false;
    soloTick();
    clearInterval(state.soloTimer);
    state.soloTimer = setInterval(soloTick, 250);
  }
  function stopSolo() {
    clearInterval(state.soloTimer);
    state.soloTimer = 0;
    el.solo.hidden = true;
  }

  /* ---------------------------------------------------------- beat runner -- */

  function say(kind, text) {
    el.now.dataset.k = kind;
    el.nowK.textContent = { ask: 'Asked', calling: 'Calling', done: 'Answered', refused: 'Refused',
                            ready: 'Ready', end: 'Done' }[kind] || kind;
    el.nowV.textContent = text;
  }

  async function play(beat) {
    if (beat.ask) {
      say('ask', beat.ask.text);
      utterance(beat.ask.who, beat.ask.text, { at: beat.at });
      if (beat.ask.who === 'sarah') bubble(beat.ask.text);
      await sleep(750);
    }

    if (beat.verify) {
      say('done', 'Searching the transcript for “' + beat.verify + '”');
      el.q.focus({ preventScroll: true });
      el.q.value = '';
      for (const ch of beat.verify) { el.q.value += ch; verify(); await sleep(55); }
      await sleep(400);
      openRaw();
      return;
    }

    const willCall = !!(beat.tool || window.EARSHOT_SCENARIO.FIXTURES[beat.id]);
    if (!willCall) { say('ready', beat.note || ''); return; }

    // An injection beat puts the attack string dead centre of the frame at the
    // moment it goes on the wire. It is the most important thing on screen for
    // those two seconds and it belongs where a viewer is already looking.
    if (beat.meta && beat.meta.note) {
      say('calling', beat.tool + ' _meta: “' + beat.meta.note + '”');
    } else {
      say('calling', beat.tool ? beat.tool + '(' + Object.keys(beat.args || {}).join(', ') + ')'
                               : 'room event');
    }
    const res = await A.call(beat);
    if (!res) { say('done', beat.note || ''); return; }
    if (absorbDeclared(res)) renderChips();

    await rails(!!res.spoken, !!res.private);

    if (res.spoken) {
      const tags = (res.disclosures || [])
        .map((d) => chip(d.state)).slice(0, 3).join('');
      utterance('alexa', res.spoken, {
        at: beat.at, tags: tags, refused: !!res.refused,
      });
    }
    if (res.private) {
      card(res.private, beat.at, res.ms);
    } else if (beat.ask && beat.ask.who === 'sarah') {
      phoneNote(res.refused
        ? 'Refused for the room. Nothing new to send — the card above already has it.'
        : 'Answered out loud. Nothing in this one was private.');
    }

    let first = true;
    for (const d of res.disclosures || []) {
      ledgerRow(d, beat.at, first ? res.ms : null);
      first = false;
    }

    /* The injection beat. `compareWith` names an earlier beat that called the
       same tool without an attack; if this answer is byte-identical, the
       injection reached nothing. Compared here rather than asserted, and the
       byte count is printed so it can be checked against the raw view. */
    state.spokenBy[beat.id] = res.spoken;
    if (beat.compareWith) {
      const before = state.spokenBy[beat.compareWith];
      const same = typeof before === 'string' && before === res.spoken;
      ledgerRow({
        state: same ? 'refused' : 'spoken',
        what: same ? 'Injection changed nothing'
                   : 'SPOKEN LINE CHANGED UNDER INJECTION',
        detail: same
          ? 'byte-identical, ' + res.spoken.length + ' chars'
          : 'a finding, not a demo',
      }, beat.at, null);
      if (same) {
        const li = el.transcript.lastElementChild;
        const tags = li && li.querySelector('.tags');
        if (tags) {
          tags.insertAdjacentHTML('beforeend',
            '<span class="chip" data-s="refused">' +
            '<svg viewBox="0 0 20 20" aria-hidden="true">' + ICON.refused + '</svg>' +
            'Unchanged under injection</span>');
        }
      }
    }

    if (beat.solo === 'open') startSolo();
    if (beat.solo === 'close') stopSolo();

    // Live mode has no synthetic refusal: the server's own `note` field is the
    // instruction the assistant is given, so show that rather than our gloss.
    say(res.refused ? 'refused' : 'done',
        res.refused ? res.refused.reason : (res.note || beat.note || ''));
    setTimeout(coolRails, 900);
  }

  async function next() {
    if (state.busy || state.cursor >= S.beats.length - 1) return;
    state.busy = true;
    state.cursor += 1;
    try { await play(S.beats[state.cursor]); } finally { state.busy = false; }
    if (state.cursor === S.beats.length - 1) {
      // Counted off the ledger that is on screen rather than written by hand,
      // because a summary line that drifts from the rows above it is exactly
      // the kind of small lie a sceptical viewer goes looking for.
      const n = (st) => el.ledger.querySelectorAll('.lrow[data-state="' + st + '"]').length;
      say('end', n('spoken') + ' spoken · ' + n('shifted') + ' shifted · ' +
                 n('refused') + ' refused · ' + n('sealed') + ' sealed · ' +
                 'protected values spoken aloud: ' + el.counter.textContent);
    }
  }

  function reset() {
    state.cursor = -1;
    state.declared = [];
    state.spokenBy = {};
    renderChips();
    el.transcript.innerHTML = '';
    for (const c of Array.from(el.cards.querySelectorAll('.card'))) c.remove();
    el.screenEmpty.hidden = false;
    el.ledger.innerHTML = '';
    el.ledgerEmpty.hidden = false;
    el.q.value = '';
    stopSolo();
    coolRails();
    closeRaw();
    el.breach.hidden = true;
    say('ready', 'Press Space to begin');
    audit();
    verify();
  }

  async function back() {
    if (state.busy) return;
    const target = state.cursor - 1;
    reset();
    for (let i = 0; i <= target; i++) await next();
  }

  async function gotoBeat(n) {
    reset();
    for (let i = 0; i <= n && i < S.beats.length; i++) await next();
  }

  /* ------------------------------------------------------------ overlays -- */

  function openRaw() { el.raw.hidden = false; paintRaw(); }
  function closeRaw() { el.raw.hidden = true; }

  /* -------------------------------------------------------------- wiring -- */

  function keys(e) {
    if (e.target === el.q) {
      if (e.key === 'Escape') { el.q.blur(); }
      return;
    }
    if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'Enter') {
      e.preventDefault(); next();
    } else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    else if (e.key === 'r' || e.key === 'R') { reset(); }
    else if (e.key === 'a' || e.key === 'A') { autoplay(!state.auto); }
    else if (e.key === '/') { e.preventDefault(); el.q.focus(); }
    else if (e.key === 'Escape') { closeRaw(); }
  }

  async function autoplay(on) {
    state.auto = on;
    if (!on) return;
    while (state.auto && state.cursor < S.beats.length - 1) {
      await next();
      await sleep(2600);
    }
    state.auto = false;
  }

  async function boot() {
    renderPresence();
    wireChips();
    reset();

    el.q.addEventListener('input', verify);
    el.rawBtn.addEventListener('click', openRaw);
    el.rawClose.addEventListener('click', closeRaw);
    el.raw.addEventListener('click', (e) => { if (e.target === el.raw) closeRaw(); });
    document.addEventListener('keydown', keys);
    window.addEventListener('earshot:degraded', (e) =>
      badge('scripted', 'server dropped mid-run — ' + e.detail));

    badge('probing', 'probing ' + A.candidates.length + ' local MCP endpoint' +
                     (A.candidates.length === 1 ? '' : 's') + '…');
    await A.probe();

    if (A.state.mode === 'live') {
      const name = (A.state.server && A.state.server.name) || 'MCP server';
      badge('live', 'LIVE · ' + name + ' · ' + A.state.tools.length + ' tools');
    } else {
      badge('scripted', 'SCRIPTED · no MCP server found' +
                        String.fromCharCode(10) + 'responses below are fixtures');
    }

    if (params.has('still')) {
      document.body.dataset.still = '1';
      await gotoBeat(Number(params.get('still')));
      if (params.get('raw') === '1') openRaw(); else closeRaw();
    } else if (params.get('auto') === '1') {
      await sleep(900);
      autoplay(true);
    }
    window.EarshotReady = true;
  }

  window.EarshotApp = { next, back, reset, gotoBeat, verify, openRaw, closeRaw,
                        audit, state, roomCorpus, phoneCorpus };
  boot();
})();
