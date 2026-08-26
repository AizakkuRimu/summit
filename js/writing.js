/* ---------------------------------------------------------
   Summit — writing.js
   Section 9: Draft tab — Writing (verb finder).

   Scans every template stored under the Draft hierarchy
   (window.Summit.state.draft) for verbs, ranks them by tone
   (Polite / Friendly / Firm-Neutral / Casual), and gives you an
   Unreviewed bucket for anything it can't confidently classify.

   Kept in its own file/closure on purpose — it only ever *reads*
   window.Summit.state.draft (schemes/categories/enquiries/
   sub-enquiries/templates) and keeps its own extra bits (custom
   tone overrides, dismissed non-verbs) under
   window.Summit.state.draft.writing. draft.js calls
   window.Summit.writing.render() when the Writing sub-tab is
   opened; nothing else in draft.js needs to know how this works.

   How verbs are found (heuristic, not a real POS tagger):
     1. Contractions are expanded first ("won't" -> "will not",
        "he's" -> "he is", ...) so pronouns and modals aren't
        hidden inside a single token.
     2. Walk the token stream. Whenever a pronoun (he/she/it/you/
        we/they) turns up, look at what follows it:
          - a negation word ("not"/"never") is skipped over
          - a modal ("will", "should", "can", ...) is recorded
            separately as a modal verb, then we keep looking
          - a helper verb ("is"/"has"/"was"/"does", ...) is
            skipped over so we land on the real verb
          - whatever's left is treated as the candidate verb
     3. Candidate verbs are looked up in a curated tone lexicon
        (falling back to any custom tone the user has already
        assigned). Anything left over lands in "Unreviewed".
--------------------------------------------------------- */

(function () {
  'use strict';

  window.Summit = window.Summit || { state: { mountain: {}, peaks: {}, draft: {} } };
  window.Summit.state.draft = window.Summit.state.draft || {};
  const draftState = window.Summit.state.draft;

  // Own little corner of draft state — survives switching tabs, gone on
  // reload, same as everything else in this app until it's exported.
  draftState.writing = draftState.writing || {
    customTone: {},   // verb -> 'polite' | 'friendly' | 'firm' | 'casual' (manual overrides)
    dismissed: []      // verbs the user has marked "Not a verb"
  };
  const wState = draftState.writing;

  // ============================================================
  // 9.1 — Tokenizing & pronoun/modal/verb detection
  // ============================================================

  const PRONOUNS = new Set(['i', 'you', 'he', 'she', 'we', 'they', 'it']);
  const MODALS = new Set(['will', 'would', 'can', 'could', 'should', 'shall', 'must', 'might', 'may']);
  const NEGATIONS = new Set(['not', 'never', 'no', 'also', 'just', 'still', 'already', 'only', 'so', 'then', 'kindly', 'please']);
  const HELPERS = new Set(['is', 'are', 'was', 'were', 'am', 'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did']);
  // Not useful as a "verb to use in an email" even though it can sit
  // right after a pronoun — filtered out of candidates entirely.
  const SKIP_CANDIDATES = new Set(['not', 'no', 'never', 'so', 'also', 'too', 'here', 'there', 'now', 'then']);
  // How many tokens after the pronoun we're willing to look through
  // (pronoun + negation + modal + negation + helper + verb, at most).
  const MAX_LOOKAHEAD = 5;

  // Expanded before tokenizing so a pronoun/modal/helper hiding inside
  // a contraction ("he's", "won't") still gets picked up as its own word.
  const CONTRACTION_EXPANSIONS = [
    [/\bwon't\b/gi, 'will not'], [/\bwouldn't\b/gi, 'would not'],
    [/\bcan't\b/gi, 'can not'], [/\bcouldn't\b/gi, 'could not'],
    [/\bshouldn't\b/gi, 'should not'], [/\bshan't\b/gi, 'shall not'],
    [/\bmightn't\b/gi, 'might not'], [/\bmustn't\b/gi, 'must not'],
    [/\bdoesn't\b/gi, 'does not'], [/\bdon't\b/gi, 'do not'], [/\bdidn't\b/gi, 'did not'],
    [/\bisn't\b/gi, 'is not'], [/\baren't\b/gi, 'are not'], [/\bwasn't\b/gi, 'was not'], [/\bweren't\b/gi, 'were not'],
    [/\bhasn't\b/gi, 'has not'], [/\bhaven't\b/gi, 'have not'], [/\bhadn't\b/gi, 'had not'],
    [/\bhe's\b/gi, 'he is'], [/\bshe's\b/gi, 'she is'], [/\bit's\b/gi, 'it is'], [/\bthat's\b/gi, 'that is'],
    [/\bthey're\b/gi, 'they are'], [/\bwe're\b/gi, 'we are'], [/\byou're\b/gi, 'you are'], [/\bi'm\b/gi, 'i am'],
    [/\bhe'll\b/gi, 'he will'], [/\bshe'll\b/gi, 'she will'], [/\bthey'll\b/gi, 'they will'],
    [/\bwe'll\b/gi, 'we will'], [/\byou'll\b/gi, 'you will'], [/\bi'll\b/gi, 'i will'], [/\bit'll\b/gi, 'it will'],
    [/\bhe'd\b/gi, 'he would'], [/\bshe'd\b/gi, 'she would'], [/\bthey'd\b/gi, 'they would'],
    [/\bwe'd\b/gi, 'we would'], [/\byou'd\b/gi, 'you would'], [/\bi'd\b/gi, 'i would']
  ];

  function expandContractions(text) {
    let out = text;
    CONTRACTION_EXPANSIONS.forEach(([re, rep]) => { out = out.replace(re, rep); });
    return out;
  }

  function tokenize(text) {
    return (expandContractions(text.toLowerCase()).match(/[a-z]+/g) || []);
  }

  // Walks one token stream, returns { verbs: [...], modals: [...] } —
  // both are arrays with repeats (frequency is tallied by the caller).
  function scanTokensForVerbs(tokens) {
    const verbs = [];
    const modals = [];
    for (let i = 0; i < tokens.length; i += 1) {
      if (!PRONOUNS.has(tokens[i])) continue;
      let j = i + 1;
      const limit = Math.min(tokens.length, i + 1 + MAX_LOOKAHEAD);
      let sawModal = false;
      while (j < limit) {
        const tok = tokens[j];
        if (NEGATIONS.has(tok)) { j += 1; continue; }
        if (MODALS.has(tok)) { modals.push(tok); sawModal = true; j += 1; continue; }
        if (HELPERS.has(tok)) { j += 1; continue; }
        // First real candidate we land on.
        if (!SKIP_CANDIDATES.has(tok) && tok.length >= 3) verbs.push(tok);
        break;
      }
      // sawModal is unused beyond documentation intent — kept for clarity
      // that modal-only sentences ("you should.") still count the modal.
      void sawModal;
    }
    return { verbs, modals };
  }

  // ============================================================
  // 9.2 — Tone lexicon
  // ============================================================
  // Curated, not exhaustive. Anything not listed here (and not already
  // given a custom tone by the user) falls into Unreviewed rather than
  // being guessed at.

  const TONE_LABELS = { polite: 'Polite', friendly: 'Friendly', firm: 'Firm / Neutral', casual: 'Casual' };
  const TONE_ORDER = ['polite', 'friendly', 'firm', 'casual'];

  const VERB_LEXICON = {
    // ---- Polite: softened, deferential, formal-courteous ----
    appreciate: 'polite', apologize: 'polite', apologise: 'polite', advise: 'polite',
    request: 'polite', invite: 'polite', welcome: 'polite', thank: 'polite',
    assist: 'polite', accommodate: 'polite', recommend: 'polite', suggest: 'polite',
    encourage: 'polite', trust: 'polite', hope: 'polite', acknowledge: 'polite',
    regret: 'polite', value: 'polite', reassure: 'polite', apprise: 'polite',
    understand: 'polite', clarify: 'polite',

    // ---- Friendly: warm, approachable, personable ----
    help: 'friendly', share: 'friendly', chat: 'friendly', let: 'friendly',
    love: 'friendly', enjoy: 'friendly', join: 'friendly', celebrate: 'friendly',
    connect: 'friendly', glad: 'friendly', reach: 'friendly', meet: 'friendly',
    catch: 'friendly', pop: 'friendly', hang: 'friendly', wish: 'friendly',

    // ---- Firm / Neutral: direct, formal, obligatory ----
    require: 'firm', ensure: 'firm', need: 'firm', instruct: 'firm', direct: 'firm',
    mandate: 'firm', comply: 'firm', submit: 'firm', provide: 'firm',
    complete: 'firm', process: 'firm', review: 'firm', verify: 'firm',
    notify: 'firm', inform: 'firm', proceed: 'firm', issue: 'firm', action: 'firm',
    escalate: 'firm', reject: 'firm', deny: 'firm', decline: 'firm', refuse: 'firm',
    terminate: 'firm', cancel: 'firm', revoke: 'firm', confirm: 'firm', state: 'firm',
    note: 'firm', attach: 'firm', enclose: 'firm', forward: 'firm', return: 'firm',
    contact: 'firm', respond: 'firm', reply: 'firm', arrange: 'firm', schedule: 'firm',

    // ---- Casual: relaxed, everyday, informal ----
    get: 'casual', check: 'casual', fix: 'casual', sort: 'casual', look: 'casual',
    try: 'casual', go: 'casual', come: 'casual', put: 'casual', take: 'casual',
    give: 'casual', drop: 'casual', hit: 'casual', ping: 'casual', bounce: 'casual',
    swing: 'casual', chase: 'casual', grab: 'casual', run: 'casual', sit: 'casual'
  };

  function toneOf(verb) {
    if (wState.customTone[verb]) return wState.customTone[verb];
    if (VERB_LEXICON[verb]) return VERB_LEXICON[verb];
    return null; // unreviewed
  }

  // ============================================================
  // 9.3 — Walking the Draft hierarchy for template text
  // ============================================================

  // Deliberately doesn't call draft.js's subTemplates() (it's private to
  // that file's closure) — reads templates defensively instead, covering
  // both the current sub.templates[] array shape and the older singular
  // sub.template field for hierarchies that haven't been touched yet
  // this session.
  function allTemplateTexts() {
    const texts = [];
    (draftState.subEnquiries ? Object.values(draftState.subEnquiries) : []).forEach((sub) => {
      if (!sub) return;
      if (Array.isArray(sub.templates)) {
        sub.templates.forEach((t) => { if (t && t.template) texts.push(t.template); });
      }
      if (sub.template) texts.push(sub.template);
    });
    return texts;
  }

  // ============================================================
  // 9.4 — Scan + tally
  // ============================================================

  let lastScan = null; // { verbCounts: Map, modalCounts: Map, templateCount, scannedAt }

  function runScan() {
    const verbCounts = new Map();
    const modalCounts = new Map();
    const texts = allTemplateTexts();
    texts.forEach((text) => {
      const tokens = tokenize(text);
      const { verbs, modals } = scanTokensForVerbs(tokens);
      verbs.forEach((v) => {
        if (wState.dismissed.includes(v)) return;
        verbCounts.set(v, (verbCounts.get(v) || 0) + 1);
      });
      modals.forEach((m) => modalCounts.set(m, (modalCounts.get(m) || 0) + 1));
    });
    lastScan = { verbCounts, modalCounts, templateCount: texts.length, scannedAt: new Date() };
    return lastScan;
  }

  function sortedEntries(map) {
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  // ============================================================
  // 9.5 — DOM references & rendering
  // ============================================================

  const rescanBtn = document.getElementById('writing-rescan-btn');
  const scanStatusEl = document.getElementById('writing-scan-status');
  const modalsListEl = document.getElementById('writing-modals-list');
  const modalsEmptyNote = document.getElementById('writing-modals-empty');
  const modalsCountEl = document.getElementById('writing-modals-count');
  const toneGroupsEl = document.getElementById('writing-tone-groups');
  const tonesCountEl = document.getElementById('writing-tones-count');
  const unreviewedListEl = document.getElementById('writing-unreviewed-list');
  const unreviewedEmptyNote = document.getElementById('writing-unreviewed-empty');
  const unreviewedCountEl = document.getElementById('writing-unreviewed-count');
  const exportTxtBtn = document.getElementById('writing-export-txt-btn');
  const exportCopyBtn = document.getElementById('writing-export-copy-btn');
  const exportStatusEl = document.getElementById('writing-export-status');

  function makeChip(label, count, extraClass) {
    const chip = document.createElement('span');
    chip.className = 'draft-chip draft-writing-chip' + (extraClass ? ' ' + extraClass : '');
    const text = document.createElement('span');
    text.textContent = label;
    chip.appendChild(text);
    if (count) {
      const badge = document.createElement('span');
      badge.className = 'draft-writing-chip__count';
      badge.textContent = String(count);
      chip.appendChild(badge);
    }
    return chip;
  }

  function renderModals() {
    if (!lastScan) return;
    const entries = sortedEntries(lastScan.modalCounts);
    modalsCountEl.textContent = entries.length ? String(entries.length) : '';
    modalsListEl.innerHTML = '';
    if (entries.length === 0) {
      modalsListEl.appendChild(modalsEmptyNote);
      return;
    }
    entries.forEach(([word, count]) => modalsListEl.appendChild(makeChip(word, count, 'draft-writing-chip--modal')));
  }

  function renderToneGroups() {
    toneGroupsEl.innerHTML = '';
    if (!lastScan) return;
    let totalClassified = 0;

    TONE_ORDER.forEach((toneKey) => {
      const entries = sortedEntries(lastScan.verbCounts).filter(([word]) => toneOf(word) === toneKey);
      totalClassified += entries.length;

      const group = document.createElement('div');
      group.className = 'draft-writing-group draft-writing-group--' + toneKey;

      const header = document.createElement('div');
      header.className = 'draft-col__subtitle-row';
      const title = document.createElement('h3');
      title.className = 'draft-col__subtitle';
      title.textContent = TONE_LABELS[toneKey];
      const count = document.createElement('span');
      count.className = 'draft-find-count';
      count.textContent = entries.length ? String(entries.length) : '';
      header.appendChild(title);
      header.appendChild(count);
      group.appendChild(header);

      const chipsWrap = document.createElement('div');
      chipsWrap.className = 'draft-writing-chips';
      if (entries.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'draft-empty-note';
        empty.textContent = 'None found yet.';
        chipsWrap.appendChild(empty);
      } else {
        entries.forEach(([word, wcount]) => {
          chipsWrap.appendChild(makeChip(word, wcount, 'draft-writing-chip--' + toneKey));
        });
      }
      group.appendChild(chipsWrap);
      toneGroupsEl.appendChild(group);
    });

    tonesCountEl.textContent = totalClassified ? String(totalClassified) : '';
  }

  function assignTone(word, toneKey) {
    wState.customTone[word] = toneKey;
    renderAll();
  }

  function dismissWord(word) {
    if (!wState.dismissed.includes(word)) wState.dismissed.push(word);
    if (lastScan) lastScan.verbCounts.delete(word);
    renderAll();
  }

  function renderUnreviewed() {
    if (!lastScan) return;
    const entries = sortedEntries(lastScan.verbCounts).filter(([word]) => toneOf(word) === null);
    unreviewedCountEl.textContent = entries.length ? String(entries.length) : '';
    unreviewedListEl.innerHTML = '';
    if (entries.length === 0) {
      unreviewedListEl.appendChild(unreviewedEmptyNote);
      return;
    }
    entries.forEach(([word, count]) => {
      const row = document.createElement('div');
      row.className = 'draft-writing-unreviewed-row';

      const label = document.createElement('span');
      label.className = 'draft-writing-unreviewed-row__word';
      label.textContent = word + ' (' + count + ')';
      row.appendChild(label);

      const actions = document.createElement('div');
      actions.className = 'draft-writing-unreviewed-row__actions';
      TONE_ORDER.forEach((toneKey) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'draft-writing-tagbtn draft-writing-tagbtn--' + toneKey;
        btn.textContent = TONE_LABELS[toneKey];
        btn.title = 'Classify "' + word + '" as ' + TONE_LABELS[toneKey];
        btn.addEventListener('click', () => assignTone(word, toneKey));
        actions.appendChild(btn);
      });
      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'draft-writing-tagbtn draft-writing-tagbtn--dismiss';
      dismissBtn.textContent = 'Not a verb';
      dismissBtn.title = 'Hide "' + word + '" from future scans';
      dismissBtn.addEventListener('click', () => dismissWord(word));
      actions.appendChild(dismissBtn);

      row.appendChild(actions);
      unreviewedListEl.appendChild(row);
    });
  }

  function renderAll() {
    renderModals();
    renderToneGroups();
    renderUnreviewed();
  }

  function rescan() {
    runScan();
    renderAll();
    if (scanStatusEl) {
      const n = lastScan.verbCounts.size;
      scanStatusEl.textContent = lastScan.templateCount === 0
        ? 'No templates found yet — attach some in the Tag view first.'
        : 'Scanned ' + lastScan.templateCount + ' template' + (lastScan.templateCount === 1 ? '' : 's') +
          ', found ' + n + ' distinct verb' + (n === 1 ? '' : 's') + '.';
    }
  }

  // Called by draft.js whenever the Writing sub-tab is opened. Re-scans
  // every time so it always reflects the current hierarchy — cheap
  // enough (plain string scanning) not to bother caching across visits.
  function render() {
    rescan();
  }

  // ============================================================
  // 9.6 — Export (same pattern as the Hierarchy export in draft.js)
  // ============================================================

  function writingTimestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
  }

  function downloadTextBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function reportText() {
    if (!lastScan) rescan();
    const lines = [];
    lines.push('Summit \u2014 Verb Tone Report');
    lines.push('Generated ' + new Date().toLocaleString());
    lines.push('Templates scanned: ' + lastScan.templateCount);
    lines.push('');

    const modalEntries = sortedEntries(lastScan.modalCounts);
    lines.push('MODAL VERBS');
    lines.push(modalEntries.length ? modalEntries.map(([w, c]) => w + ' (' + c + ')').join(', ') : '(none found)');
    lines.push('');

    TONE_ORDER.forEach((toneKey) => {
      const entries = sortedEntries(lastScan.verbCounts).filter(([word]) => toneOf(word) === toneKey);
      lines.push(TONE_LABELS[toneKey].toUpperCase());
      lines.push(entries.length ? entries.map(([w, c]) => w + ' (' + c + ')').join(', ') : '(none found)');
      lines.push('');
    });

    const unreviewed = sortedEntries(lastScan.verbCounts).filter(([word]) => toneOf(word) === null);
    lines.push('UNREVIEWED (needs classification)');
    lines.push(unreviewed.length ? unreviewed.map(([w, c]) => w + ' (' + c + ')').join(', ') : '(none)');

    return lines.join('\n');
  }

  if (rescanBtn) rescanBtn.addEventListener('click', rescan);

  if (exportTxtBtn) exportTxtBtn.addEventListener('click', () => {
    downloadTextBlob(new Blob([reportText()], { type: 'text/plain' }), 'summit-verb-report-' + writingTimestamp() + '.txt');
    if (exportStatusEl) exportStatusEl.textContent = 'Downloaded.';
  });

  if (exportCopyBtn) exportCopyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(reportText());
      if (exportStatusEl) exportStatusEl.textContent = 'Verb report copied to clipboard.';
    } catch (err) {
      if (exportStatusEl) exportStatusEl.textContent = 'Could not copy \u2014 try Download .txt instead.';
    }
  });

  // ---------- Public API for draft.js to call on tab activation ----------
  window.Summit.writing = { render };
})();
