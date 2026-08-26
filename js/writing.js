/* ---------------------------------------------------------
   Summit — writing.js
   Section 10: Writing tab — a verb bank built from every
   template's own text, so you can pick a verb pitched at the
   right register (Polite / Friendly / Neutral / Firm / Casual)
   for a given reply.

   HOW VERBS ARE FOUND
   There's no real part-of-speech tagger available in this
   environment (no NLP library, no network access to fetch
   one), so detection is pattern-based rather than grammatical:
     - Modal verbs (can/could/will/would/shall/should/may/
       might/must) are matched directly wherever they appear —
       these are a closed, unambiguous list.
     - Action verbs are guessed from the word immediately after
       a subject pronoun ("we CONFIRM…"), a modal ("would
       ASSIST…"), "to" ("to ARRANGE…"), or an imperative opener
       ("kindly NOTE…"). A stop-word filter removes the common
       false positives that heuristic picks up (e.g. "you ARE",
       "we THE").
   This will occasionally miscatch a word or miss a real verb
   it has no context clue for — that's inherent to a pattern-
   based approach without real grammar analysis. Anything not
   in the curated dictionary below is labelled "Unreviewed" and
   ranked below confirmed matches, and a click lets you confirm
   or move it to a different tone — that correction is remembered
   for the rest of the session.

   Reads window.Summit.state.draft (Section 5) — never writes
   to it. Keeps its own state at window.Summit.state.writing
   (tone overrides only). Must load after draft.js.
--------------------------------------------------------- */

(function () {
  'use strict';

  window.Summit = window.Summit || { state: { mountain: {}, peaks: {}, draft: {} } };
  window.Summit.state.writing = window.Summit.state.writing || {};
  const wState = window.Summit.state.writing;
  wState.overrides = wState.overrides || {}; // "type:verb" -> band id, set by manual re-tagging

  // ============================================================
  // 10.1 — Tone bands
  // ============================================================

  const BANDS = [
    {
      id: 'polite',
      label: 'Polite',
      desc: 'Deferential and formal — softens a request or shows extra courtesy. Good for sensitive, formal, or first-contact replies.'
    },
    {
      id: 'friendly',
      label: 'Friendly',
      desc: 'Warm and approachable — reads like a helpful person, not a form letter. Good for routine, positive-outcome replies.'
    },
    {
      id: 'neutral',
      label: 'Neutral',
      desc: 'Plain and informative — states what\u2019s happening without extra warmth or edge. Good for procedural or status-update replies.'
    },
    {
      id: 'firm',
      label: 'Firm',
      desc: 'Direct and assertive — makes an obligation or boundary clear. Good for policy limits, deadlines, or declines.'
    },
    {
      id: 'casual',
      label: 'Casual',
      desc: 'Relaxed, conversational phrasing with light contractions. Few templates should sit here \u2014 most membership replies read better at Neutral or above.'
    }
  ];
  const BAND_IDS = new Set(BANDS.map((b) => b.id));
  const BAND_LABEL = {};
  BANDS.forEach((b) => { BAND_LABEL[b.id] = b.label; });

  // ============================================================
  // 10.2 — Curated verb dictionary (lemma -> band)
  // A starting point, not exhaustive — anything the scan finds
  // outside this list still shows up, just tagged "Unreviewed".
  // ============================================================

  const DICTIONARY_BY_BAND = {
    polite: ['appreciate', 'advise', 'welcome', 'encourage', 'recommend', 'suggest', 'trust', 'hope',
      'apologise', 'apologize', 'regret', 'acknowledge', 'extend', 'offer', 'invite', 'accommodate',
      'facilitate', 'value', 'permit', 'grant', 'reassure', 'clarify', 'elaborate', 'assure', 'respect',
      'entrust', 'commend', 'honour', 'honor', 'endeavour', 'endeavor', 'oblige', 'consider', 'convey',
      'express', 'request', 'assist'],
    friendly: ['help', 'share', 'reach', 'join', 'check', 'remind', 'support', 'guide', 'sort', 'wish',
      'celebrate', 'chat', 'pop', 'keep', 'let', 'touch', 'follow', 'connect', 'enjoy', 'walk', 'swing',
      'ping', 'drop', 'catch'],
    neutral: ['confirm', 'provide', 'process', 'submit', 'complete', 'review', 'note', 'record', 'forward',
      'send', 'attach', 'include', 'outline', 'summarise', 'summarize', 'indicate', 'state', 'specify',
      'apply', 'proceed', 'arrange', 'schedule', 'issue', 'prepare', 'verify', 'file', 'register', 'notify',
      'inform', 'update', 'handle', 'manage', 'organise', 'organize', 'list'],
    firm: ['need', 'require', 'ensure', 'insist', 'demand', 'enforce', 'mandate', 'instruct', 'direct',
      'warn', 'deny', 'reject', 'decline', 'withdraw', 'terminate', 'cancel', 'revoke', 'suspend',
      'restrict', 'prohibit', 'refuse'],
    casual: ['get', 'give', 'put', 'take', 'grab', 'fix', 'tweak', 'bump', 'shoot', 'hit', 'run', 'wrap',
      'flag', 'circle', 'loop']
  };
  const VERB_DICTIONARY = {}; // lemma -> band
  Object.keys(DICTIONARY_BY_BAND).forEach((band) => {
    DICTIONARY_BY_BAND[band].forEach((verb) => { VERB_DICTIONARY[verb] = band; });
  });

  // Modals are a closed set, so they're classified directly rather
  // than through the dictionary above.
  const MODAL_BAND = {
    could: 'polite', would: 'polite', might: 'polite', may: 'polite',
    can: 'friendly',
    will: 'neutral', should: 'neutral',
    shall: 'firm', must: 'firm'
  };
  const MODALS = new Set(Object.keys(MODAL_BAND));

  const SUBJECT_PRONOUNS = new Set(['i', 'we', 'you', 'he', 'she', 'they', 'it', 'who', 'one']);
  const IMPERATIVE_CUES = new Set(['please', 'kindly']);

  // Words that should never be treated as an action-verb candidate,
  // even though they can sit right after a trigger word ("you ARE",
  // "we THE team", "to THE office").
  const STOPWORDS = new Set([
    'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'his', 'her', 'its', 'their',
    'some', 'any', 'all', 'no', 'not',
    'is', 'are', 'was', 'were', 'am', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
    'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
    'i', 'we', 'you', 'he', 'she', 'they', 'it', 'who', 'whom', 'whose', 'one', 'us', 'me', 'him', 'them',
    'of', 'in', 'on', 'at', 'by', 'for', 'with', 'about', 'into', 'through', 'during', 'before', 'after',
    'above', 'below', 'from', 'up', 'down', 'out', 'off', 'over', 'under', 'again', 'further', 'once',
    'than', 'then', 'there', 'here', 'so', 'also', 'just', 'still', 'only', 'more', 'most', 'much', 'many',
    'other', 'same', 'such', 'and', 'or', 'but', 'if', 'because', 'while', 'when', 'where', 'why', 'how',
    'what', 'which', 'very', 'too', 'well', 'now', 'soon', 'already', 'yet', 'ever', 'never', 'always',
    'often', 'sometimes', 'yes', 'no', 'ok', 'okay', 'please', 'kindly', 'thank', 'thanks', 'sincerely',
    'regards', 'best', 'dear', 'hi', 'hello', 'ms', 'mr', 'mrs', 'dr', 'sc', 'pr'
  ]);

  function isLikelyVerb(word) {
    return !!word && word.length >= 2 && /^[a-z]+$/.test(word) && !STOPWORDS.has(word);
  }

  // Best-effort match of a surface form ("confirming", "confirmed",
  // "confirms") back to a dictionary lemma ("confirm"). Not a real
  // stemmer — just enough regular-inflection coverage to stop every
  // tense of a known verb showing up as a separate "unreviewed" entry.
  function lookupDictionary(word) {
    if (VERB_DICTIONARY[word]) return word;
    const tries = [];
    if (word.endsWith('ies')) tries.push(word.slice(0, -3) + 'y');
    if (word.endsWith('ing')) { tries.push(word.slice(0, -3)); tries.push(word.slice(0, -3) + 'e'); }
    if (word.endsWith('ed')) { tries.push(word.slice(0, -2)); tries.push(word.slice(0, -1)); tries.push(word.slice(0, -2) + 'e'); }
    if (word.endsWith('es')) tries.push(word.slice(0, -2));
    if (word.endsWith('s') && !word.endsWith('ss')) tries.push(word.slice(0, -1));
    for (let i = 0; i < tries.length; i++) {
      if (VERB_DICTIONARY[tries[i]]) return tries[i];
    }
    return null;
  }

  // Fallback tone guess for a verb the dictionary doesn't recognise,
  // using whatever context clue triggered the match in the first place.
  function guessBand(trigger, contextWord, sentenceLower) {
    if (trigger === 'modal') return MODAL_BAND[contextWord] || 'neutral';
    if (trigger === 'imperative') return 'polite';
    if (/\b(must|immediately|asap|required|urgently)\b/.test(sentenceLower)) return 'firm';
    if (/'(ll|re|m|ve)\b|n't\b/.test(sentenceLower)) return 'casual';
    return 'neutral';
  }

  // ============================================================
  // 10.3 — Reading templates (read-only access to Section 5's state)
  // ============================================================

  function getSubTemplates(sub) {
    if (!sub) return [];
    if (sub.templates) return sub.templates;
    if (sub.template) return [{ name: 'Template 1', template: sub.template }];
    return [];
  }

  function splitSentences(text) {
    return text.replace(/\r/g, '').split(/(?:\n)+|(?<=[.!?])\s+(?=[A-Z0-9])/).map((s) => s.trim()).filter(Boolean);
  }

  function addHit(counts, verb, type, guessedBand, isAutoGuess, sentence, path) {
    const key = type + ':' + verb;
    const override = wState.overrides[key];
    const band = BAND_IDS.has(override) ? override : (guessedBand || 'neutral');
    if (!counts.has(key)) {
      counts.set(key, {
        key,
        verb,
        type, // 'action' | 'modal'
        band,
        isAuto: isAutoGuess && !override,
        overridden: !!override,
        count: 0,
        example: { sentence: sentence.trim(), path }
      });
    }
    counts.get(key).count += 1;
  }

  function scanText(text, path, counts) {
    const sentences = splitSentences(text);
    sentences.forEach((sentence) => {
      const tokens = sentence.match(/[A-Za-z']+/g);
      if (!tokens) return;
      const lower = tokens.map((t) => t.toLowerCase().replace(/^'+|'+$/g, ''));
      const sentenceLower = sentence.toLowerCase();
      for (let i = 0; i < lower.length; i++) {
        const w = lower[i];
        if (MODALS.has(w)) {
          addHit(counts, w, 'modal', MODAL_BAND[w], false, sentence, path);
        }
        let trigger = null;
        if (SUBJECT_PRONOUNS.has(w)) trigger = 'pronoun';
        else if (MODALS.has(w)) trigger = 'modal';
        else if (w === 'to') trigger = 'infinitive';
        else if (IMPERATIVE_CUES.has(w)) trigger = 'imperative';
        if (trigger && i + 1 < lower.length) {
          const next = lower[i + 1];
          if (isLikelyVerb(next)) {
            const dictKey = lookupDictionary(next);
            const band = dictKey ? VERB_DICTIONARY[dictKey] : guessBand(trigger, w, sentenceLower);
            addHit(counts, dictKey || next, 'action', band, !dictKey, sentence, path);
          }
        }
      }
    });
  }

  function subPath(subId) {
    if (window.Summit.draft && typeof window.Summit.draft.getSubEnquiry === 'function') {
      const info = window.Summit.draft.getSubEnquiry(subId);
      if (info) return info.path;
    }
    return '';
  }

  function buildVerbIndex() {
    const draftState = window.Summit.state.draft || {};
    const subEnquiries = draftState.subEnquiries || {};
    const counts = new Map();
    let templatesScanned = 0;
    let templatesWithText = 0;

    Object.keys(subEnquiries).forEach((subId) => {
      const sub = subEnquiries[subId];
      const path = subPath(subId);
      getSubTemplates(sub).forEach((tpl) => {
        templatesScanned += 1;
        const text = (tpl.template || '').trim();
        if (!text) return;
        templatesWithText += 1;
        const label = tpl.name ? (path ? path + ' \u2014 ' + tpl.name : tpl.name) : path;
        scanText(text, label, counts);
      });
    });

    return {
      entries: Array.from(counts.values()),
      templatesScanned,
      templatesWithText,
      builtAt: new Date()
    };
  }

  // ============================================================
  // 10.4 — UI
  // ============================================================

  let verbIndex = null;
  let currentBand = 'polite';
  let hasScanned = false;

  const scanBtn = document.getElementById('writing-scan-btn');
  const scanStatusEl = document.getElementById('writing-scan-status');
  const toneListEl = document.getElementById('writing-tone-list');
  const searchInput = document.getElementById('writing-search');
  const typeFilterSel = document.getElementById('writing-type-filter');
  const hideAutoCheckbox = document.getElementById('writing-hide-auto');
  const resultsEl = document.getElementById('writing-results');
  const resultsCountEl = document.getElementById('writing-results-count');
  const resultsTitleEl = document.getElementById('writing-results-title');
  const bandDescEl = document.getElementById('writing-band-desc');

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function bandCount(bandId) {
    if (!verbIndex) return 0;
    let n = 0;
    verbIndex.entries.forEach((e) => { if (e.band === bandId) n += 1; });
    return n;
  }

  function renderToneList() {
    if (!toneListEl) return;
    toneListEl.innerHTML = BANDS.map((b) => {
      const count = verbIndex ? bandCount(b.id) : null;
      const selected = b.id === currentBand;
      return '<button type="button" class="writing-tone-btn writing-tone-btn--' + b.id + '" ' +
        'role="tab" aria-selected="' + selected + '" data-band="' + b.id + '">' +
        '<span class="writing-tone-btn__dot"></span>' +
        '<span class="writing-tone-btn__label">' + b.label + '</span>' +
        (count === null ? '' : '<span class="writing-tone-btn__count">' + count + '</span>') +
        '</button>';
    }).join('');
    Array.from(toneListEl.querySelectorAll('.writing-tone-btn')).forEach((btn) => {
      btn.addEventListener('click', () => {
        currentBand = btn.dataset.band;
        renderToneList();
        renderResults();
      });
    });
  }

  function currentBandInfo() {
    return BANDS.find((b) => b.id === currentBand) || BANDS[0];
  }

  function renderResults() {
    const info = currentBandInfo();
    if (resultsTitleEl) resultsTitleEl.textContent = info.label + ' verbs';
    if (bandDescEl) bandDescEl.textContent = info.desc;

    if (!verbIndex) {
      resultsEl.innerHTML = '<p class="draft-empty-note" id="writing-empty">Click \u201cScan all templates\u201d to build the verb bank.</p>';
      if (resultsCountEl) resultsCountEl.textContent = '';
      return;
    }

    const query = (searchInput && searchInput.value || '').trim().toLowerCase();
    const typeFilter = typeFilterSel ? typeFilterSel.value : 'all';
    const hideAuto = !!(hideAutoCheckbox && hideAutoCheckbox.checked);

    let rows = verbIndex.entries.filter((e) => e.band === currentBand);
    if (typeFilter !== 'all') rows = rows.filter((e) => e.type === typeFilter);
    if (hideAuto) rows = rows.filter((e) => !e.isAuto);
    if (query) rows = rows.filter((e) => e.verb.indexOf(query) !== -1);

    rows = rows.slice().sort((a, b) => {
      if (a.isAuto !== b.isAuto) return a.isAuto ? 1 : -1;
      if (b.count !== a.count) return b.count - a.count;
      return a.verb.localeCompare(b.verb);
    });

    if (resultsCountEl) resultsCountEl.textContent = rows.length ? (rows.length + ' verb' + (rows.length === 1 ? '' : 's')) : '';

    if (!rows.length) {
      resultsEl.innerHTML = '<p class="draft-empty-note">No ' + info.label.toLowerCase() + ' verbs match yet' +
        (query ? ' for \u201c' + escapeHtml(query) + '\u201d' : '') + '.</p>';
      return;
    }

    resultsEl.innerHTML = rows.map((e) => {
      const optionsHtml = BANDS.map((b) => '<option value="' + b.id + '"' + (b.id === e.band ? ' selected' : '') + '>' + b.label + '</option>').join('');
      return '<div class="writing-row" data-key="' + escapeHtml(e.key) + '">' +
        '<div class="writing-row__main">' +
        '<button type="button" class="writing-row__verb" data-copy="' + escapeHtml(e.verb) + '" title="Click to copy">' + escapeHtml(e.verb) + '</button>' +
        '<span class="writing-row__type writing-row__type--' + e.type + '">' + (e.type === 'modal' ? 'Modal' : 'Action') + '</span>' +
        (e.isAuto ? '<span class="writing-row__auto" title="Not in the curated list \u2014 best guess from context. Reassign it below to confirm.">Unreviewed</span>' : '') +
        '<span class="writing-row__count">\u00D7' + e.count + '</span>' +
        '</div>' +
        (e.example.sentence ? '<p class="writing-row__example">\u201C' + escapeHtml(e.example.sentence) + '\u201D</p>' : '') +
        (e.example.path ? '<p class="writing-row__path">' + escapeHtml(e.example.path) + '</p>' : '') +
        '<label class="writing-row__reassign">Tone: <select class="writing-row__select" data-key="' + escapeHtml(e.key) + '">' + optionsHtml + '</select></label>' +
        '</div>';
    }).join('');
  }

  function runScan() {
    verbIndex = buildVerbIndex();
    hasScanned = true;
    if (scanStatusEl) {
      if (!verbIndex.templatesWithText) {
        scanStatusEl.textContent = 'No template text found yet \u2014 add templates in the Tag view first.';
      } else {
        scanStatusEl.textContent = 'Scanned ' + verbIndex.templatesWithText + ' template' +
          (verbIndex.templatesWithText === 1 ? '' : 's') + ', found ' + verbIndex.entries.length + ' distinct verbs.';
      }
    }
    renderToneList();
    renderResults();
  }

  if (scanBtn) scanBtn.addEventListener('click', runScan);
  if (searchInput) searchInput.addEventListener('input', renderResults);
  if (typeFilterSel) typeFilterSel.addEventListener('change', renderResults);
  if (hideAutoCheckbox) hideAutoCheckbox.addEventListener('change', renderResults);

  if (resultsEl) {
    resultsEl.addEventListener('change', (ev) => {
      const sel = ev.target.closest('.writing-row__select');
      if (!sel || !verbIndex) return;
      const key = sel.dataset.key;
      const entry = verbIndex.entries.find((e) => e.key === key);
      if (!entry) return;
      const newBand = sel.value;
      wState.overrides[key] = newBand;
      entry.band = newBand;
      entry.isAuto = false;
      entry.overridden = true;
      renderToneList();
      renderResults();
      renderMemoryStatus();
    });

    resultsEl.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.writing-row__verb');
      if (!btn) return;
      const text = btn.dataset.copy || '';
      const restore = btn.textContent;
      const flash = () => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = restore; }, 900); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(flash).catch(flash);
      } else {
        flash();
      }
    });
  }

  // ============================================================
  // 10.5 — Reviewed-tag memory (export / copy / import)
  // Nothing in this app survives a page reload on its own — same as
  // the Hierarchy (see draft.js) and Smart Match's training data,
  // this needs an explicit Export/Copy, and an Import to bring it
  // back later or share it with a colleague. Kept as its own small
  // JSON blob, independent of the Hierarchy's PATH:/TEMPLATE: export,
  // since re-tagging a verb has nothing to do with any one template.
  // ============================================================

  const memoryStatusEl = document.getElementById('writing-memory-status');
  const exportBtn = document.getElementById('writing-export-btn');
  const copyBtn = document.getElementById('writing-copy-btn');
  const importInput = document.getElementById('writing-import-input');

  function pad2(n) { return String(n).padStart(2, '0'); }
  function writingTimestamp() {
    const d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      '-' + pad2(d.getHours()) + pad2(d.getMinutes());
  }

  function overrideCount() {
    return Object.keys(wState.overrides).length;
  }

  function renderMemoryStatus() {
    const n = overrideCount();
    if (memoryStatusEl) {
      memoryStatusEl.textContent = n === 0
        ? 'No verbs reassigned yet \u2014 export to back up your tags once you\u2019ve reviewed some.'
        : n + ' verb' + (n === 1 ? '' : 's') + ' reassigned so far, kept separate from the Hierarchy export.';
    }
    if (exportBtn) exportBtn.disabled = n === 0;
    if (copyBtn) copyBtn.disabled = n === 0;
  }

  function overridesPayload() {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      overrides: wState.overrides
    }, null, 2);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function exportOverrides() {
    downloadBlob(new Blob([overridesPayload()], { type: 'application/json' }),
      'summit-writing-tags-' + writingTimestamp() + '.json');
  }

  function flashMemoryStatus(message) {
    if (!memoryStatusEl) return;
    const restore = memoryStatusEl.textContent;
    memoryStatusEl.textContent = message;
    setTimeout(renderMemoryStatus, 1800);
  }

  async function copyOverrides() {
    try {
      await navigator.clipboard.writeText(overridesPayload());
      flashMemoryStatus('Copied to clipboard.');
    } catch (err) {
      flashMemoryStatus('Could not copy \u2014 try Export instead.');
    }
  }

  // Reapplies any override onto an already-built verbIndex without a
  // full rescan, so importing tags immediately reflects in the list
  // that's currently on screen.
  function reapplyOverridesToIndex() {
    if (!verbIndex) return;
    verbIndex.entries.forEach((e) => {
      const override = wState.overrides[e.key];
      if (BAND_IDS.has(override)) {
        e.band = override;
        e.isAuto = false;
        e.overridden = true;
      }
    });
  }

  function importOverrides(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (err) {
        flashMemoryStatus('Could not read that file \u2014 is it a Writing tags export?');
        return;
      }
      const incoming = (parsed && parsed.overrides) || {};
      let imported = 0;
      Object.keys(incoming).forEach((key) => {
        if (BAND_IDS.has(incoming[key])) {
          wState.overrides[key] = incoming[key];
          imported += 1;
        }
      });
      reapplyOverridesToIndex();
      renderToneList();
      renderResults();
      renderMemoryStatus();
      flashMemoryStatus('Imported ' + imported + ' tag' + (imported === 1 ? '' : 's') + '.');
    };
    reader.readAsText(file);
  }

  if (exportBtn) exportBtn.addEventListener('click', exportOverrides);
  if (copyBtn) copyBtn.addEventListener('click', copyOverrides);
  if (importInput) {
    importInput.addEventListener('change', () => {
      const file = importInput.files && importInput.files[0];
      if (file) importOverrides(file);
      importInput.value = '';
    });
  }

  renderMemoryStatus();

  renderToneList();
  renderResults();

  // ---------- Public hook, called by draft.js when this subtab opens ----------
  window.Summit.writing = {
    // Scans on first open only; the "Scan all templates" button
    // handles picking up edits made afterwards.
    onActivate() {
      if (!hasScanned) runScan();
    }
  };

}());
