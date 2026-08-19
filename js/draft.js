/* ---------------------------------------------------------
   Summit — draft.js
   Section 5: Draft tab — keyword extraction & tagging.

   - 5.1 Paste & extract: stop-word-filtered keyword detection,
         manual per-keyword removal.
   - 5.2 Hierarchy: Scheme -> Category -> Enquiry -> Sub-Enquiry.
         Manual tree builder (add/rename/delete at every level)
         plus a quick-add "File keywords here" cascading picker
         that can create nodes inline while tagging.
   - 5.3 Template linking: a template (plain/rich text block) can
         be attached to a specific Sub-Enquiry, and stays attached
         until manually changed.

   State lives at window.Summit.state.draft so switching tabs
   (Section 1) never loses it. Sections 6-8 (template finder,
   reverse/deep search, import & export) will read this same
   hierarchy rather than keeping their own copy.
--------------------------------------------------------- */

(function () {
  'use strict';

  window.Summit = window.Summit || { state: { mountain: {}, peaks: {}, draft: {} } };

  const state = window.Summit.state.draft;
  state.schemeIds = state.schemeIds || [];
  state.schemes = state.schemes || {};       // id -> { id, name, categoryIds: [] }
  state.categories = state.categories || {}; // id -> { id, name, schemeId, enquiryIds: [] }
  state.enquiries = state.enquiries || {};   // id -> { id, name, categoryId, subEnquiryIds: [] }
  state.subEnquiries = state.subEnquiries || {}; // id -> { id, name, enquiryId, keywords: [], templates: [] }
  // Each template on a Sub-Enquiry carries its own Name/Term tags:
  // sub.templates = [{ id, name, template, templateHtml, templateLinks, keywords: [], labels: [] }].
  state.pendingKeywords = state.pendingKeywords || []; // current extract-session keyword list
  state.selectedSubEnquiryId = state.selectedSubEnquiryId || null;
  // Most-recent-first list of Name/Term labels actually saved against a
  // template (see recordLabelUsage()) — used by the Quick Template
  // Adder to guess which two labels to pre-fill.
  state.recentLabels = state.recentLabels || [];

  const expandedIds = new Set(); // runtime-only tree expand/collapse state

  // ---------- Hierarchy search toolbar ----------
  // Filters the tree to one level (Scheme/Category/Enquiry/Sub-Enquiry)
  // at a time. Ancestors of a match are force-shown/expanded so the
  // match is reachable even if the user had it collapsed; anything
  // below the searched level is untouched by the filter, so manually
  // expanding a matched node still shows its real children normally.
  let treeSearchQuery = '';
  let treeSearchLevel = 'subenquiry';
  const LEVEL_DEPTH = { scheme: 0, category: 1, enquiry: 2, subenquiry: 3 };
  const LEVEL_LABELS = { scheme: 'Schemes', category: 'Categories', enquiry: 'Enquiries', subenquiry: 'Sub-Enquiries' };

  // ============================================================
  // DOM references
  // ============================================================

  const pasteInput = document.getElementById('draft-paste-input');
  const extractBtn = document.getElementById('draft-extract-btn');
  const clearBtn = document.getElementById('draft-clear-btn');
  const keywordsEl = document.getElementById('draft-keywords');
  const keywordsEmptyNote = document.getElementById('draft-keywords-empty');

  const filePanel = document.getElementById('draft-file-panel');
  const fileSchemeSel = document.getElementById('draft-file-scheme');
  const fileCategorySel = document.getElementById('draft-file-category');
  const fileEnquirySel = document.getElementById('draft-file-enquiry');
  const fileSubSel = document.getElementById('draft-file-subenquiry');
  const fileTemplateSel = document.getElementById('draft-file-template');
  const fileBtn = document.getElementById('draft-file-btn');

  const addSchemeBtn = document.getElementById('draft-add-scheme-btn');
  const quickAddBtn = document.getElementById('draft-quick-add-btn');
  const treeEl = document.getElementById('draft-tree');
  const treeEmptyNote = document.getElementById('draft-tree-empty');
  const treeSearchInput = document.getElementById('draft-tree-search-input');
  const treeSearchLevelSelect = document.getElementById('draft-tree-search-level');
  const saveStatusEl = document.getElementById('draft-save-status');

  const detailEmpty = document.getElementById('draft-detail-empty');
  const detailContent = document.getElementById('draft-detail-content');
  const detailPath = document.getElementById('draft-detail-path');
  const detailKeywordsEl = document.getElementById('draft-detail-keywords');
  const detailKeywordsClearBtn = document.getElementById('draft-detail-keywords-clear-btn');
  const labelInput = document.getElementById('draft-label-input');
  const labelTagsEl = document.getElementById('draft-label-tags');
  const labelDatalist = document.getElementById('draft-label-datalist');
  const templateListEl = document.getElementById('draft-template-list');
  const templateAddBtn = document.getElementById('draft-template-add-btn');
  const quickTemplateBtn = document.getElementById('draft-quick-template-btn');
  const templateInput = document.getElementById('draft-template-input');
  const templateSaveBtn = document.getElementById('draft-template-save-btn');
  const templateClearBtn = document.getElementById('draft-template-clear-btn');
  const templateLinkBtn = document.getElementById('draft-template-link-btn');
  const templateBoldBtn = document.getElementById('draft-template-bold-btn');
  const templateItalicBtn = document.getElementById('draft-template-italic-btn');
  const templateUnderlineBtn = document.getElementById('draft-template-underline-btn');
  const templateStatus = document.getElementById('draft-template-status');
  const templateKeywordsEl = document.getElementById('draft-template-keywords');
  const templateKeywordsClearBtn = document.getElementById('draft-template-keywords-clear-btn');
  const templateKeywordInput = document.getElementById('draft-template-keyword-input');
  const templateExpandBtn = document.getElementById('draft-template-expand-btn');

  const toastEl = document.getElementById('summit-toast');
  let toastTimer = null;
  function showToast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.hidden = false;
    requestAnimationFrame(() => toastEl.classList.add('is-visible'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('is-visible');
      setTimeout(() => { toastEl.hidden = true; }, 220);
    }, 4000);
  }

  // ---------- Sub-tab nav (Tag / Find & Search / Import-Export) ----------
  const subtabs = Array.from(document.querySelectorAll('.draft-subnav > .draft-subtab'));
  const subpanels = {
    tag: document.getElementById('draft-subpanel-tag'),
    find: document.getElementById('draft-subpanel-find'),
    importexport: document.getElementById('draft-subpanel-importexport')
  };

  function activateSubtab(name) {
    if (!subpanels[name]) return;
    subtabs.forEach((tab) => {
      if (tab.dataset.subtab) tab.setAttribute('aria-selected', String(tab.dataset.subtab === name));
    });
    Object.keys(subpanels).forEach((key) => { subpanels[key].hidden = key !== name; });
    if (name === 'importexport') renderBatchList();
  }

  subtabs.forEach((tab) => {
    if (tab.disabled) return;
    tab.addEventListener('click', () => activateSubtab(tab.dataset.subtab));
  });

  // ---------- 6. Template Finder DOM references ----------
  const findQueryInput = document.getElementById('draft-find-query');
  const findSchemeSel = document.getElementById('draft-find-scheme');
  const findCategorySel = document.getElementById('draft-find-category');
  const findEnquirySel = document.getElementById('draft-find-enquiry');
  const findSubSel = document.getElementById('draft-find-subenquiry');
  const findLabelSel = document.getElementById('draft-find-label');
  const findResetBtn = document.getElementById('draft-find-reset-btn');
  const findResultsEl = document.getElementById('draft-find-results');
  const findEmptyNote = document.getElementById('draft-find-empty');
  const findCountEl = document.getElementById('draft-find-count');
  const findViewMoreBtn = document.getElementById('draft-find-viewmore-btn');
  const expandedResultIds = new Set();
  // Which result cards (by "subId::tplId") currently show the inline
  // text editor instead of the read-only snippet — mirrors
  // expandedResultIds above.
  const editingResultIds = new Set();

  const TEMPLATE_FINDER_PREVIEW_COUNT = 10;
  const TEMPLATE_FINDER_PAGE_SIZE = 20;
  // Cache of the last ranked/shuffled full result set, shared between the
  // small preview list and the "View more" full-page list so opening the
  // latter shows exactly what the former was drawn from (no re-shuffling
  // random picks mid-session).
  let findFullList = [];
  let findFullQuery = '';

  // ---------- 7. Reverse Search & Deep Thinking Search DOM references ----------
  const reverseInput = document.getElementById('draft-reverse-input');
  const reverseBtn = document.getElementById('draft-reverse-btn');
  const reverseClearBtn = document.getElementById('draft-reverse-clear-btn');
  const reverseKeywordsEl = document.getElementById('draft-reverse-keywords');
  const reverseKeywordsEmptyNote = document.getElementById('draft-reverse-keywords-empty');
  const reverseResultsEl = document.getElementById('draft-reverse-results');
  const reverseEmptyNote = document.getElementById('draft-reverse-empty');
  const reverseCountEl = document.getElementById('draft-reverse-count');
  let reverseKeywords = [];
  let reverseHasSearched = false;
  const expandedReverseIds = new Set();

  const deepQueryInput = document.getElementById('draft-deep-query');
  const deepRebuildBtn = document.getElementById('draft-deep-rebuild-btn');
  const deepIndexStatus = document.getElementById('draft-deep-index-status');
  const deepResultsEl = document.getElementById('draft-deep-results');
  const deepEmptyNote = document.getElementById('draft-deep-empty');
  const deepCountEl = document.getElementById('draft-deep-count');
  const deepLinksListEl = document.getElementById('draft-deep-links-list');
  const deepLinksEmptyNote = document.getElementById('draft-deep-links-empty');
  const deepLinksCountEl = document.getElementById('draft-deep-links-count');
  let deepIndex = []; // [{ subId, keywords: [...] }] — one entry per Sub-Enquiry with a template
  const expandedDeepIds = new Set();

  let uidCounter = 0;
  // Timestamp + counter was enough to be unique within one browser tab,
  // but template ids are now also written into exports and used to
  // merge data across machines/colleagues (see importEntryText) — the
  // random segment makes a same-millisecond collision between two
  // independently-generated ids practically impossible.
  function uid(prefix) {
    uidCounter += 1;
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '-' + uidCounter;
  }

  // Used whenever a new template is created with a default/guessed
  // name (a fresh "+ New template", or one materializing during
  // import) — if that name is already taken by a sibling, appends
  // " (2)", " (3)"... so two templates never sit side by side with
  // the same label, human-confusing even once they're correctly
  // tracked as separate templates internally.
  function uniqueTemplateName(templates, baseName) {
    const base = (baseName || 'Untitled').trim() || 'Untitled';
    const existingNames = new Set(templates.map((t) => t.name));
    if (!existingNames.has(base)) return base;
    let n = 2;
    while (existingNames.has(base + ' (' + n + ')')) n += 1;
    return base + ' (' + n + ')';
  }

  // ============================================================
  // 5.1 — Keyword extraction
  // ============================================================

  const STOP_WORDS = new Set([
    'a','an','the','and','or','but','if','then','else','so','because','as','of','at','by','for',
    'with','without','about','against','between','into','through','during','before','after',
    'above','below','to','from','up','down','in','out','on','off','over','under','again',
    'further','once','here','there','when','where','why','how','all','any','both','each','few',
    'more','most','other','some','such','no','nor','not','only','own','same','than','too','very',
    'can','will','just','don','should','now','is','are','was','were','be','been','being','have',
    'has','had','having','do','does','did','doing','would','could','ought','i','me','my','myself',
    'we','our','ours','ourselves','you','your','yours','yourself','yourselves','he','him','his',
    'himself','she','her','hers','herself','it','its','itself','they','them','their','theirs',
    'themselves','what','which','who','whom','this','that','these','those','am','it\'s','that\'s',
    'having','having','let','us','also','one','two','get','got','like','said','say','says','per'
  ]);

  function extractKeywords(text) {
    const tokens = (text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || []);
    const seen = new Set();
    const out = [];
    for (const tok of tokens) {
      const word = tok.replace(/'s$/, '');
      if (word.length < 3) continue;
      if (STOP_WORDS.has(word)) continue;
      if (seen.has(word)) continue;
      seen.add(word);
      out.push(word);
      if (out.length >= 40) break; // keep it a "short list" per spec
    }
    return out;
  }

  function renderPendingKeywords() {
    const chips = state.pendingKeywords.map((kw) => {
      const chip = document.createElement('span');
      chip.className = 'draft-chip';
      const label = document.createElement('span');
      label.textContent = kw;
      chip.appendChild(label);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'draft-chip__remove';
      remove.setAttribute('aria-label', 'Remove keyword ' + kw);
      remove.textContent = '\u00D7';
      remove.addEventListener('click', () => {
        state.pendingKeywords = state.pendingKeywords.filter((k) => k !== kw);
        renderPendingKeywords();
        updateFileButtonState();
      });
      chip.appendChild(remove);
      return chip;
    });

    keywordsEl.innerHTML = '';
    if (chips.length === 0) {
      keywordsEl.appendChild(keywordsEmptyNote);
    } else {
      chips.forEach((c) => keywordsEl.appendChild(c));
    }
    filePanel.hidden = state.pendingKeywords.length === 0;
    updateFileButtonState();
  }

  extractBtn.addEventListener('click', () => {
    const text = pasteInput.value || '';
    if (!text.trim()) {
      showToast('Paste some text first.');
      return;
    }
    const found = extractKeywords(text);
    if (found.length === 0) {
      showToast('No meaningful keywords found in that text.');
    }
    // Merge into any keywords already awaiting filing, rather than
    // silently discarding a previous extraction the user hasn't filed yet.
    const merged = state.pendingKeywords.slice();
    found.forEach((kw) => { if (!merged.includes(kw)) merged.push(kw); });
    state.pendingKeywords = merged;
    renderPendingKeywords();
    refreshFileSelects();
  });

  clearBtn.addEventListener('click', () => {
    pasteInput.value = '';
    state.pendingKeywords = [];
    renderPendingKeywords();
  });

  // ============================================================
  // Hierarchy data helpers
  // ============================================================

  function createScheme(name) {
    const id = uid('scheme');
    state.schemes[id] = { id, name, categoryIds: [] };
    state.schemeIds.push(id);
    return id;
  }
  function createCategory(schemeId, name) {
    const id = uid('category');
    state.categories[id] = { id, name, schemeId, enquiryIds: [] };
    state.schemes[schemeId].categoryIds.push(id);
    return id;
  }
  function createEnquiry(categoryId, name) {
    const id = uid('enquiry');
    state.enquiries[id] = { id, name, categoryId, subEnquiryIds: [] };
    state.categories[categoryId].enquiryIds.push(id);
    return id;
  }
  function createSubEnquiry(enquiryId, name) {
    const id = uid('subenquiry');
    state.subEnquiries[id] = { id, name, enquiryId, keywords: [], templates: [] };
    state.enquiries[enquiryId].subEnquiryIds.push(id);
    return id;
  }

  // Defensive accessor — every template built through subTemplates()
  // already has a labels array, but keep call sites safe regardless
  // (e.g. objects rebuilt during import).
  function templateLabels(tpl) { return (tpl && tpl.labels) || []; }

  // ---------- Template "folders" (by tag combo) ----------
  // Templates aren't just uniquely identified by their own id — they're
  // also grouped, for numbering and display, by the exact combination
  // of Name/Term tags they carry. {} (no tags) is its own folder,
  // {JohnSmith} is another, {JohnSmith, Urgent} another still, distinct
  // from either single-tag folder. Each folder gets its own independent
  // "Template 1"/"Template 2"/... numbering, so two templates tagged
  // completely differently never have to fight over a default name.
  function templateFolderKey(labels) {
    return JSON.stringify((labels || []).slice().sort((a, b) => a.localeCompare(b)));
  }
  function sameFolder(labelsA, labelsB) { return templateFolderKey(labelsA) === templateFolderKey(labelsB); }
  function templatesInFolder(templates, labels) {
    const key = templateFolderKey(labels);
    return templates.filter((t) => templateFolderKey(templateLabels(t)) === key);
  }
  // Ordered { labels, templates }[] for display — untagged first, then
  // tagged combos sorted alphabetically by their joined tags.
  function groupTemplatesByFolder(templates) {
    const map = new Map();
    templates.forEach((t) => {
      const labels = templateLabels(t).slice().sort((a, b) => a.localeCompare(b));
      const key = templateFolderKey(labels);
      if (!map.has(key)) map.set(key, { labels, templates: [] });
      map.get(key).templates.push(t);
    });
    return Array.from(map.values()).sort((a, b) => {
      if (a.labels.length === 0) return -1;
      if (b.labels.length === 0) return 1;
      return a.labels.join(', ').localeCompare(b.labels.join(', '));
    });
  }
  // Renames tpl (already carrying its final labels) only if its current
  // name actually collides with a sibling that landed in the same
  // folder — never touches a name that isn't clashing, so a
  // deliberately-chosen name like "Standard Reply" is never silently
  // renumbered just because its tags changed.
  function resolveTemplateNameCollision(templates, tpl) {
    const siblings = templatesInFolder(templates, templateLabels(tpl)).filter((t) => t !== tpl);
    if (siblings.some((t) => t.name === tpl.name)) {
      tpl.name = uniqueTemplateName(siblings, tpl.name);
    }
  }

  // ---------- Multiple templates per Sub-Enquiry ----------
  // Each Sub-Enquiry can carry any number of named templates:
  // sub.templates = [{ id, name, template, templateHtml, templateLinks, keywords: [], labels: [] }].
  // Older saved state (or an import) may still only have the legacy
  // singular sub.template/templateHtml/templateLinks fields — subTemplates()
  // is the one place that reads them, migrating them into a single-entry
  // templates array the first time the Sub-Enquiry is touched. Every
  // other function should go through subTemplates()/findTemplateById()
  // rather than reading sub.templates directly.
  function subTemplates(sub) {
    if (!sub) return [];
    if (!sub.templates) {
      sub.templates = [];
      if (sub.template) {
        sub.templates.push({
          id: uid('tpl'),
          name: 'Template 1',
          template: sub.template,
          templateHtml: sub.templateHtml || '',
          templateLinks: sub.templateLinks || [],
          keywords: []
        });
      }
      delete sub.template;
      delete sub.templateHtml;
      delete sub.templateLinks;
    }
    // Defensive: templates created before per-template keywords existed
    // (or restored from an older save) may not have a keywords array yet.
    sub.templates.forEach((t) => { if (!t.keywords) t.keywords = []; });
    // Migration: Name/Term tags used to live once on the Sub-Enquiry
    // (sub.labels) and applied to every template under it. Any template
    // that doesn't have its own labels array yet (older save, or an
    // import written before this change) inherits a copy of whatever
    // the Sub-Enquiry's shared tags were — safe because, before this
    // change, every template effectively shared that one set anyway.
    // A newly-created template with no legacy tags to inherit just
    // starts blank, same as sub.labels being absent.
    sub.templates.forEach((t) => { if (!t.labels) t.labels = (sub.labels || []).slice(); });
    delete sub.labels;
    return sub.templates;
  }
  function findTemplateById(sub, templateId) {
    return subTemplates(sub).find((t) => t.id === templateId) || null;
  }
  // A template's own filed keywords, plus the Sub-Enquiry's general
  // keyword pool — used anywhere we're deciding whether a *specific*
  // template matches, so a keyword filed generally against the Sub-
  // Enquiry still helps every template under it, while a keyword filed
  // to just one template doesn't bleed into its siblings.
  function effectiveTemplateKeywords(sub, tpl) {
    const general = (sub && sub.keywords) || [];
    const own = (tpl && tpl.keywords) || [];
    if (!own.length) return general.slice();
    const merged = general.slice();
    own.forEach((kw) => { if (!merged.includes(kw)) merged.push(kw); });
    return merged;
  }
  // Every hyperlink across every template on a Sub-Enquiry (used by the
  // "All hyperlinks" list and duplicateSubEnquiry).
  function subAllLinks(sub) {
    return subTemplates(sub).reduce((acc, t) => acc.concat(t.templateLinks || []), []);
  }
  // Plain text of every template on a Sub-Enquiry, concatenated — used
  // for the deep keyword index, which indexes a Sub-Enquiry's whole
  // template library rather than one template at a time.
  function subTemplateText(sub) {
    return subTemplates(sub).map((t) => t.template || '').filter(Boolean).join('\n');
  }
  function subHasTemplates(sub) {
    return subTemplates(sub).some((t) => t.template && t.template.trim());
  }

  function deleteScheme(id) {
    const scheme = state.schemes[id];
    if (!scheme) return;
    scheme.categoryIds.slice().forEach(deleteCategory);
    state.schemeIds = state.schemeIds.filter((sid) => sid !== id);
    delete state.schemes[id];
  }
  function deleteCategory(id) {
    const cat = state.categories[id];
    if (!cat) return;
    cat.enquiryIds.slice().forEach(deleteEnquiry);
    const scheme = state.schemes[cat.schemeId];
    if (scheme) scheme.categoryIds = scheme.categoryIds.filter((cid) => cid !== id);
    delete state.categories[id];
  }
  function deleteEnquiry(id) {
    const enq = state.enquiries[id];
    if (!enq) return;
    enq.subEnquiryIds.slice().forEach(deleteSubEnquiry);
    const cat = state.categories[enq.categoryId];
    if (cat) cat.enquiryIds = cat.enquiryIds.filter((eid) => eid !== id);
    delete state.enquiries[id];
  }
  function deleteSubEnquiry(id) {
    const sub = state.subEnquiries[id];
    if (!sub) return;
    const enq = state.enquiries[sub.enquiryId];
    if (enq) enq.subEnquiryIds = enq.subEnquiryIds.filter((sid) => sid !== id);
    delete state.subEnquiries[id];
    if (state.selectedSubEnquiryId === id) {
      state.selectedSubEnquiryId = null;
    }
  }

  function pathForSubEnquiry(id) {
    const sub = state.subEnquiries[id];
    if (!sub) return '';
    const enq = state.enquiries[sub.enquiryId];
    const cat = enq ? state.categories[enq.categoryId] : null;
    const scheme = cat ? state.schemes[cat.schemeId] : null;
    return [scheme && scheme.name, cat && cat.name, enq && enq.name, sub.name]
      .filter(Boolean).join(' \u203A ');
  }

  // Same as pathForSubEnquiry but for an Enquiry itself — used by
  // Summit Bot's Move picker to show which folder each destination
  // sits in.
  function pathForEnquiry(id) {
    const enq = state.enquiries[id];
    if (!enq) return '';
    const cat = state.categories[enq.categoryId];
    const scheme = cat ? state.schemes[cat.schemeId] : null;
    return [scheme && scheme.name, cat && cat.name, enq.name].filter(Boolean).join(' \u203A ');
  }

  // ============================================================
  // 5.2 — Hierarchy tree (manual builder)
  // ============================================================

  // Default display order for every level of the tree (schemes,
  // categories, enquiries, sub-enquiries) is alphabetical by name.
  // This only affects render order — the underlying id arrays keep
  // their original (creation) order, so nothing else that relies on
  // them (export outline, quick-add dropdowns, etc.) is affected.
  function sortedByName(ids, map) {
    return ids.slice().sort((a, b) =>
      map[a].name.localeCompare(map[b].name, undefined, { sensitivity: 'base', numeric: true })
    );
  }

  // Builds the match/visibility sets for the current search box + level.
  // Returns null when the box is empty (renderTree then renders as if
  // there were no search at all).
  function computeSearchVisibility() {
    const q = treeSearchQuery.trim().toLowerCase();
    if (!q) return null;
    const depth = LEVEL_DEPTH[treeSearchLevel];
    const matchIds = new Set();
    const visibleIds = new Set();
    const forceExpand = new Set();
    const addAncestors = (ids) => { ids.forEach((id) => { visibleIds.add(id); forceExpand.add(id); }); };

    if (treeSearchLevel === 'scheme') {
      Object.keys(state.schemes).forEach((id) => {
        if (state.schemes[id].name.toLowerCase().includes(q)) { matchIds.add(id); visibleIds.add(id); }
      });
    } else if (treeSearchLevel === 'category') {
      Object.keys(state.categories).forEach((id) => {
        const cat = state.categories[id];
        if (cat.name.toLowerCase().includes(q)) {
          matchIds.add(id); visibleIds.add(id);
          addAncestors([cat.schemeId]);
        }
      });
    } else if (treeSearchLevel === 'enquiry') {
      Object.keys(state.enquiries).forEach((id) => {
        const enq = state.enquiries[id];
        if (enq.name.toLowerCase().includes(q)) {
          matchIds.add(id); visibleIds.add(id);
          const cat = state.categories[enq.categoryId];
          addAncestors([cat.schemeId, enq.categoryId]);
        }
      });
    } else {
      Object.keys(state.subEnquiries).forEach((id) => {
        const sub = state.subEnquiries[id];
        if (sub.name.toLowerCase().includes(q)) {
          matchIds.add(id); visibleIds.add(id);
          const enq = state.enquiries[sub.enquiryId];
          const cat = state.categories[enq.categoryId];
          addAncestors([cat.schemeId, enq.categoryId, sub.enquiryId]);
        }
      });
    }

    return { depth, matchIds, visibleIds, forceExpand };
  }

  // At the searched level itself, only matches survive; above it, only
  // branches leading toward a match survive; below it, the search
  // doesn't apply (normal expand/collapse takes over again).
  function filterIdsForDepth(ids, depth, search) {
    if (!search) return ids;
    if (depth < search.depth) return ids.filter((id) => search.visibleIds.has(id));
    if (depth === search.depth) return ids.filter((id) => search.matchIds.has(id));
    return ids;
  }

  function isForceExpanded(id, depth, search) {
    return !!search && depth < search.depth && search.forceExpand.has(id);
  }


  function renderTree() {
    treeEl.innerHTML = '';
    if (state.schemeIds.length === 0) {
      treeEl.appendChild(treeEmptyNote);
      return;
    }
    const search = computeSearchVisibility();
    if (search && search.matchIds.size === 0) {
      const note = document.createElement('p');
      note.className = 'draft-empty-note';
      note.textContent = 'No ' + LEVEL_LABELS[treeSearchLevel] + ' match "' + treeSearchQuery.trim() + '".';
      treeEl.appendChild(note);
      return;
    }
    const schemeIds = filterIdsForDepth(state.schemeIds, 0, search);
    sortedByName(schemeIds, state.schemes).forEach((schemeId) => {
      treeEl.appendChild(renderSchemeNode(schemeId, search));
    });
  }

  function makeActionButton(symbol, label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'draft-node__action';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.textContent = symbol;
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return btn;
  }

  // ---------- Copy-to-clipboard for sub-enquiry names ----------
  // navigator.clipboard needs a secure context (https/localhost, which
  // GitHub Pages satisfies); falls back to the old execCommand trick
  // for anything else so the button still works everywhere.
  const COPY_ICON_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"></rect><path d="M3.5 10.5h-1a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1"></path></svg>';
  const CHECK_ICON_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3 3 7-7"></path></svg>';

  function fallbackCopyToClipboard(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopyToClipboard(text));
    }
    return Promise.resolve(fallbackCopyToClipboard(text));
  }

  // `getText()` is called at click time (not render time) so the copy
  // always reflects the current name, even if it was renamed since
  // this row was last drawn.
  function makeCopyButton(getText) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'draft-node__action draft-node__action--copy';
    btn.title = 'Copy name';
    btn.setAttribute('aria-label', 'Copy sub-enquiry name to clipboard');
    btn.innerHTML = COPY_ICON_SVG;

    let resetTimer = null;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = getText();
      copyToClipboard(text).then((ok) => {
        if (!ok) { showToast('Could not copy — clipboard unavailable'); return; }
        btn.innerHTML = CHECK_ICON_SVG;
        btn.classList.add('is-copied');
        showToast('Copied "' + text + '" to clipboard');
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          btn.innerHTML = COPY_ICON_SVG;
          btn.classList.remove('is-copied');
        }, 1100);
      });
    });
    return btn;
  }

  // The Sub-Enquiry bullet doubles as a "send to Sherpa" button: it
  // sits still as a small dot until hovered, when it swaps to a plus
  // sign. Clicking it hands the Sub-Enquiry to Summit Bot, which
  // offers Duplicate / Move / Duplicate then Move (Section bot.js).
  function makeBulletButton(name, onSend) {
    const bullet = document.createElement('button');
    bullet.type = 'button';
    bullet.className = 'draft-node__bullet';
    bullet.title = 'Add to Sherpa chat';
    bullet.setAttribute('aria-label', 'Add "' + name + '" to Sherpa chat');
    bullet.innerHTML =
      '<span class="draft-node__bullet-dot" aria-hidden="true"></span>' +
      '<span class="draft-node__bullet-plus" aria-hidden="true">+</span>';
    bullet.addEventListener('click', (e) => { e.stopPropagation(); onSend(); });
    return bullet;
  }

  function makeNodeRow({ id, level, name, hasChildren, childCount, isSelected, isOpen, isMatch, onToggle, onSelect, onAdd, onRename, onDelete, onCopy, onSend }) {
    const row = document.createElement('div');
    row.className = 'draft-node__row' + (isSelected ? ' is-selected' : '') + (isMatch ? ' is-search-match' : '');
    row.setAttribute('role', 'treeitem');

    if (onSend) row.appendChild(makeBulletButton(name, onSend));

    const open = typeof isOpen === 'boolean' ? isOpen : expandedIds.has(id);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'draft-node__toggle' + (hasChildren ? '' : ' is-leaf');
    toggle.setAttribute('aria-label', hasChildren ? 'Expand/collapse' : '');
    toggle.textContent = hasChildren ? (open ? '\u25BE' : '\u25B8') : '\u25B8';
    if (hasChildren) {
      toggle.addEventListener('click', (e) => { e.stopPropagation(); onToggle(); });
    }
    row.appendChild(toggle);

    if (typeof childCount === 'number') {
      const count = document.createElement('span');
      count.className = 'draft-node__count';
      count.textContent = String(childCount);
      row.appendChild(count);
    }

    const label = document.createElement('span');
    label.className = 'draft-node__label';
    label.textContent = name;
    label.tabIndex = 0;
    label.addEventListener('click', () => { onSelect(); });
    label.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
    });
    row.appendChild(label);

    const actions = document.createElement('div');
    actions.className = 'draft-node__actions';
    if (onCopy) actions.appendChild(makeCopyButton(onCopy));
    if (onAdd) actions.appendChild(makeActionButton('+', 'Add child', onAdd));
    actions.appendChild(makeActionButton('\u270E', 'Rename', onRename));
    actions.appendChild(makeActionButton('\u2715', 'Delete', onDelete));
    row.appendChild(actions);

    return row;
  }

  function renderSchemeNode(schemeId, search) {
    const scheme = state.schemes[schemeId];
    const wrap = document.createElement('div');
    wrap.className = 'draft-node';
    wrap.dataset.level = 'scheme';
    wrap.dataset.id = schemeId;

    const hasChildren = scheme.categoryIds.length > 0;
    const isOpen = expandedIds.has(schemeId) || isForceExpanded(schemeId, 0, search);
    const isMatch = !!search && search.matchIds.has(schemeId);
    const row = makeNodeRow({
      id: schemeId, level: 'scheme', name: scheme.name, hasChildren, isOpen, isMatch,
      onToggle: () => { toggleExpand(schemeId); },
      onSelect: () => { toggleExpand(schemeId); },
      onAdd: () => {
        const name = window.prompt('New category name:');
        if (name && name.trim()) {
          createCategory(schemeId, name.trim());
          expandedIds.add(schemeId);
          renderAll();
        }
      },
      onRename: () => {
        const name = window.prompt('Rename scheme:', scheme.name);
        if (name && name.trim()) { scheme.name = name.trim(); renderAll(); }
      },
      onDelete: () => {
        if (window.confirm('Delete scheme "' + scheme.name + '" and everything inside it?')) {
          deleteScheme(schemeId);
          renderAll();
        }
      }
    });
    wrap.appendChild(row);

    if (hasChildren && isOpen) {
      const children = document.createElement('div');
      children.className = 'draft-node__children';
      const catIds = filterIdsForDepth(scheme.categoryIds, 1, search);
      sortedByName(catIds, state.categories).forEach((catId) => children.appendChild(renderCategoryNode(catId, search)));
      wrap.appendChild(children);
    }
    return wrap;
  }

  function renderCategoryNode(categoryId, search) {
    const cat = state.categories[categoryId];
    const wrap = document.createElement('div');
    wrap.className = 'draft-node';
    wrap.dataset.level = 'category';
    wrap.dataset.id = categoryId;

    const hasChildren = cat.enquiryIds.length > 0;
    const isOpen = expandedIds.has(categoryId) || isForceExpanded(categoryId, 1, search);
    const isMatch = !!search && search.matchIds.has(categoryId);
    const row = makeNodeRow({
      id: categoryId, level: 'category', name: cat.name, hasChildren, isOpen, isMatch,
      onToggle: () => { toggleExpand(categoryId); },
      onSelect: () => { toggleExpand(categoryId); },
      onAdd: () => {
        const name = window.prompt('New enquiry name:');
        if (name && name.trim()) {
          createEnquiry(categoryId, name.trim());
          expandedIds.add(categoryId);
          renderAll();
        }
      },
      onRename: () => {
        const name = window.prompt('Rename category:', cat.name);
        if (name && name.trim()) { cat.name = name.trim(); renderAll(); }
      },
      onDelete: () => {
        if (window.confirm('Delete category "' + cat.name + '" and everything inside it?')) {
          deleteCategory(categoryId);
          renderAll();
        }
      }
    });
    wrap.appendChild(row);

    if (hasChildren && isOpen) {
      const children = document.createElement('div');
      children.className = 'draft-node__children';
      const enqIds = filterIdsForDepth(cat.enquiryIds, 2, search);
      sortedByName(enqIds, state.enquiries).forEach((enqId) => children.appendChild(renderEnquiryNode(enqId, search)));
      wrap.appendChild(children);
    }
    return wrap;
  }

  function renderEnquiryNode(enquiryId, search) {
    const enq = state.enquiries[enquiryId];
    const wrap = document.createElement('div');
    wrap.className = 'draft-node';
    wrap.dataset.level = 'enquiry';
    wrap.dataset.id = enquiryId;

    const hasChildren = enq.subEnquiryIds.length > 0;
    const isOpen = expandedIds.has(enquiryId) || isForceExpanded(enquiryId, 2, search);
    const isMatch = !!search && search.matchIds.has(enquiryId);
    const row = makeNodeRow({
      id: enquiryId, level: 'enquiry', name: enq.name, hasChildren, isOpen, isMatch,
      onToggle: () => { toggleExpand(enquiryId); },
      onSelect: () => { toggleExpand(enquiryId); },
      onAdd: () => {
        openNameHelper('', (name) => {
          const subId = createSubEnquiry(enquiryId, name);
          expandedIds.add(enquiryId);
          state.selectedSubEnquiryId = subId;
          renderAll();
        });
      },
      onRename: () => {
        const name = window.prompt('Rename enquiry:', enq.name);
        if (name && name.trim()) { enq.name = name.trim(); renderAll(); }
      },
      onDelete: () => {
        if (window.confirm('Delete enquiry "' + enq.name + '" and everything inside it?')) {
          deleteEnquiry(enquiryId);
          renderAll();
        }
      }
    });
    wrap.appendChild(row);

    if (hasChildren && isOpen) {
      const children = document.createElement('div');
      children.className = 'draft-node__children';
      const subIds = filterIdsForDepth(enq.subEnquiryIds, 3, search);
      sortedByName(subIds, state.subEnquiries).forEach((subId) => children.appendChild(renderSubEnquiryNode(subId, search)));
      wrap.appendChild(children);
    }
    return wrap;
  }

  function renderSubEnquiryNode(subId, search) {
    const sub = state.subEnquiries[subId];
    const wrap = document.createElement('div');
    wrap.className = 'draft-node';
    wrap.dataset.level = 'subenquiry';
    wrap.dataset.id = subId;

    const isMatch = !!search && search.matchIds.has(subId);
    const row = makeNodeRow({
      id: subId, level: 'subenquiry', name: sub.name, hasChildren: false,
      childCount: sub.keywords.length,
      isSelected: state.selectedSubEnquiryId === subId,
      isMatch,
      onToggle: () => {},
      onSelect: () => {
        state.selectedSubEnquiryId = subId;
        renderAll();
      },
      onCopy: () => sub.name,
      onSend: () => {
        if (window.Summit.bot && typeof window.Summit.bot.sendSubEnquiry === 'function') {
          window.Summit.bot.sendSubEnquiry(subId);
        }
      },
      onRename: () => {
        openNameHelper(sub.name, (name) => {
          sub.name = name;
          renderAll();
        });
      },
      onDelete: () => {
        if (window.confirm('Delete sub-enquiry "' + sub.name + '"? Its templates and keywords will be removed.')) {
          deleteSubEnquiry(subId);
          renderAll();
        }
      }
    });
    wrap.appendChild(row);
    return wrap;
  }

  function toggleExpand(id) {
    if (expandedIds.has(id)) expandedIds.delete(id); else expandedIds.add(id);
    renderTree();
  }

  if (treeSearchInput) {
    treeSearchInput.addEventListener('input', () => {
      treeSearchQuery = treeSearchInput.value;
      renderTree();
    });
  }
  if (treeSearchLevelSelect) {
    treeSearchLevelSelect.value = treeSearchLevel;
    treeSearchLevelSelect.addEventListener('change', () => {
      treeSearchLevel = treeSearchLevelSelect.value;
      renderTree();
    });
  }

  addSchemeBtn.addEventListener('click', () => {
    const name = window.prompt('New scheme name:');
    if (name && name.trim()) {
      const id = createScheme(name.trim());
      expandedIds.add(id);
      renderAll();
    }
  });

  // ============================================================
  // Quick-add: "File keywords here" cascading picker
  // ============================================================

  const NEW_VALUE = '__new__';

  function fillSelect(select, items, placeholder, newLabel) {
    select.innerHTML = '';
    const placeholderOpt = document.createElement('option');
    placeholderOpt.value = '';
    placeholderOpt.textContent = placeholder;
    select.appendChild(placeholderOpt);
    items.forEach(({ id, name }) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = name;
      select.appendChild(opt);
    });
    const newOpt = document.createElement('option');
    newOpt.value = NEW_VALUE;
    newOpt.textContent = newLabel;
    select.appendChild(newOpt);
  }

  function refreshFileSelects() {
    fillSelect(
      fileSchemeSel,
      state.schemeIds.map((id) => ({ id, name: state.schemes[id].name })),
      'Select scheme\u2026', '+ New scheme\u2026'
    );
    fileSchemeSel.disabled = false;
    if (!applySelectedChainToFileSelects()) resetDownstreamSelects('category');
  }

  // If a Sub-Enquiry is already selected in the Hierarchy (the person
  // clicked it before pasting/extracting), mirror that same Scheme /
  // Category / Enquiry / Sub-Enquiry chain into the "File these
  // keywords" cascade automatically, instead of leaving it blank and
  // making them reselect everything by hand. Returns true if it found
  // a valid chain to apply.
  function applySelectedChainToFileSelects() {
    const subId = state.selectedSubEnquiryId;
    const sub = subId ? state.subEnquiries[subId] : null;
    if (!sub) return false;
    const enq = state.enquiries[sub.enquiryId];
    const cat = enq ? state.categories[enq.categoryId] : null;
    const scheme = cat ? state.schemes[cat.schemeId] : null;
    if (!enq || !cat || !scheme) return false;

    fileSchemeSel.value = scheme.id;

    fillSelect(
      fileCategorySel,
      scheme.categoryIds.map((id) => ({ id, name: state.categories[id].name })),
      'Select category\u2026', '+ New category\u2026'
    );
    fileCategorySel.disabled = false;
    fileCategorySel.value = cat.id;

    fillSelect(
      fileEnquirySel,
      cat.enquiryIds.map((id) => ({ id, name: state.enquiries[id].name })),
      'Select enquiry\u2026', '+ New enquiry\u2026'
    );
    fileEnquirySel.disabled = false;
    fileEnquirySel.value = enq.id;

    fillSelect(
      fileSubSel,
      enq.subEnquiryIds.map((id) => ({ id, name: state.subEnquiries[id].name })),
      'Select sub-enquiry\u2026', '+ New sub-enquiry\u2026'
    );
    fileSubSel.disabled = false;
    fileSubSel.value = sub.id;
    fillFileTemplateSelect(sub.id);

    updateFileButtonState();
    return true;
  }

  function resetDownstreamSelects(fromLevel) {
    if (fromLevel === 'category' || fromLevel === 'scheme') {
      fileCategorySel.innerHTML = '';
      fileCategorySel.disabled = true;
    }
    if (fromLevel === 'category' || fromLevel === 'scheme' || fromLevel === 'enquiry') {
      fileEnquirySel.innerHTML = '';
      fileEnquirySel.disabled = true;
    }
    fileSubSel.innerHTML = '';
    fileSubSel.disabled = true;
    resetFileTemplateSelect();
    updateFileButtonState();
  }

  // ---------- 5th cascade step: which template (if any) these
  // keywords should be filed against. Filing "General" keeps the old
  // behaviour (keywords live on the Sub-Enquiry as a whole and apply
  // to every template under it); picking a template files them onto
  // just that template's own keyword list instead. ----------
  function resetFileTemplateSelect() {
    fileTemplateSel.innerHTML = '';
    fileTemplateSel.disabled = true;
  }

  function fillFileTemplateSelect(subId) {
    const sub = subId ? state.subEnquiries[subId] : null;
    fileTemplateSel.innerHTML = '';
    if (!sub) { fileTemplateSel.disabled = true; return; }
    const generalOpt = document.createElement('option');
    generalOpt.value = '';
    generalOpt.textContent = 'General (Sub-Enquiry \u2014 all templates)';
    fileTemplateSel.appendChild(generalOpt);
    subTemplates(sub).forEach((tpl) => {
      const opt = document.createElement('option');
      opt.value = tpl.id;
      opt.textContent = tpl.name || 'Untitled';
      fileTemplateSel.appendChild(opt);
    });
    const newOpt = document.createElement('option');
    newOpt.value = NEW_VALUE;
    newOpt.textContent = '+ New template\u2026';
    fileTemplateSel.appendChild(newOpt);
    fileTemplateSel.disabled = false;
    fileTemplateSel.value = '';
  }

  fileTemplateSel.addEventListener('change', () => {
    if (fileTemplateSel.value !== NEW_VALUE) return;
    const subId = fileSubSel.value;
    const sub = subId ? state.subEnquiries[subId] : null;
    if (!sub) { fileTemplateSel.value = ''; return; }
    const templates = subTemplates(sub);
    const untagged = templatesInFolder(templates, []);
    const name = window.prompt('New template name:', 'Template ' + (untagged.length + 1));
    if (!name || !name.trim()) { fileTemplateSel.value = ''; return; }
    const tpl = { id: uid('tpl'), name: uniqueTemplateName(untagged, name.trim()), template: '', templateHtml: '', templateLinks: [], keywords: [], labels: [] };
    templates.push(tpl);
    fillFileTemplateSelect(subId);
    fileTemplateSel.value = tpl.id;
  });

  function updateFileButtonState() {
    const subId = fileSubSel.value;
    fileBtn.disabled = !subId || subId === NEW_VALUE || state.pendingKeywords.length === 0;
  }

  fileSchemeSel.addEventListener('change', () => {
    const val = fileSchemeSel.value;
    if (val === NEW_VALUE) {
      const name = window.prompt('New scheme name:');
      if (name && name.trim()) {
        const id = createScheme(name.trim());
        refreshFileSelects();
        fileSchemeSel.value = id;
      } else {
        fileSchemeSel.value = '';
        return;
      }
    }
    const schemeId = fileSchemeSel.value;
    if (!schemeId) { resetDownstreamSelects('category'); return; }
    const scheme = state.schemes[schemeId];
    fillSelect(
      fileCategorySel,
      scheme.categoryIds.map((id) => ({ id, name: state.categories[id].name })),
      'Select category\u2026', '+ New category\u2026'
    );
    fileCategorySel.disabled = false;
    fileEnquirySel.innerHTML = ''; fileEnquirySel.disabled = true;
    fileSubSel.innerHTML = ''; fileSubSel.disabled = true;
    resetFileTemplateSelect();
    updateFileButtonState();
  });

  fileCategorySel.addEventListener('change', () => {
    const schemeId = fileSchemeSel.value;
    let val = fileCategorySel.value;
    if (val === NEW_VALUE) {
      const name = window.prompt('New category name:');
      if (name && name.trim()) {
        val = createCategory(schemeId, name.trim());
        const scheme = state.schemes[schemeId];
        fillSelect(
          fileCategorySel,
          scheme.categoryIds.map((id) => ({ id, name: state.categories[id].name })),
          'Select category\u2026', '+ New category\u2026'
        );
        fileCategorySel.value = val;
      } else {
        fileCategorySel.value = '';
        return;
      }
    }
    const categoryId = fileCategorySel.value;
    if (!categoryId) { fileEnquirySel.innerHTML = ''; fileEnquirySel.disabled = true; fileSubSel.innerHTML = ''; fileSubSel.disabled = true; resetFileTemplateSelect(); updateFileButtonState(); return; }
    const cat = state.categories[categoryId];
    fillSelect(
      fileEnquirySel,
      cat.enquiryIds.map((id) => ({ id, name: state.enquiries[id].name })),
      'Select enquiry\u2026', '+ New enquiry\u2026'
    );
    fileEnquirySel.disabled = false;
    fileSubSel.innerHTML = ''; fileSubSel.disabled = true;
    resetFileTemplateSelect();
    updateFileButtonState();
  });

  fileEnquirySel.addEventListener('change', () => {
    const categoryId = fileCategorySel.value;
    let val = fileEnquirySel.value;
    if (val === NEW_VALUE) {
      const name = window.prompt('New enquiry name:');
      if (name && name.trim()) {
        val = createEnquiry(categoryId, name.trim());
        const cat = state.categories[categoryId];
        fillSelect(
          fileEnquirySel,
          cat.enquiryIds.map((id) => ({ id, name: state.enquiries[id].name })),
          'Select enquiry\u2026', '+ New enquiry\u2026'
        );
        fileEnquirySel.value = val;
      } else {
        fileEnquirySel.value = '';
        return;
      }
    }
    const enquiryId = fileEnquirySel.value;
    if (!enquiryId) { fileSubSel.innerHTML = ''; fileSubSel.disabled = true; updateFileButtonState(); return; }
    const enq = state.enquiries[enquiryId];
    fillSelect(
      fileSubSel,
      enq.subEnquiryIds.map((id) => ({ id, name: state.subEnquiries[id].name })),
      'Select sub-enquiry\u2026', '+ New sub-enquiry\u2026'
    );
    fileSubSel.disabled = false;
    resetFileTemplateSelect();
    updateFileButtonState();
  });

  fileSubSel.addEventListener('change', () => {
    const enquiryId = fileEnquirySel.value;
    const val = fileSubSel.value;
    if (val === NEW_VALUE) {
      fileSubSel.value = '';
      resetFileTemplateSelect();
      updateFileButtonState();
      openNameHelper('', (name) => {
        const subId = createSubEnquiry(enquiryId, name);
        const enq = state.enquiries[enquiryId];
        fillSelect(
          fileSubSel,
          enq.subEnquiryIds.map((id) => ({ id, name: state.subEnquiries[id].name })),
          'Select sub-enquiry\u2026', '+ New sub-enquiry\u2026'
        );
        fileSubSel.value = subId;
        fillFileTemplateSelect(subId);
        updateFileButtonState();
      });
      return;
    }
    fillFileTemplateSelect(val || null);
    updateFileButtonState();
  });

  // ============================================================
  // Quick Add: see the whole Scheme/Category/Enquiry/Sub-Enquiry
  // chain in one small window and build out a new set without
  // leaving the Hierarchy column. Each level is disabled until its
  // parent has a value, same rule as "File keywords here" above —
  // you can stop at any level (leave the rest blank) but you can
  // never skip one that doesn't exist yet. Creating a node happens
  // immediately when you pick "+ New…", so there's no separate
  // "Create" step to remember to click.
  // ============================================================

  let quickAddEl = null;
  let quickAddSel = null;

  function ensureQuickAddModal() {
    if (quickAddEl) return quickAddEl;

    const modal = document.createElement('div');
    modal.className = 'summit-modal draft-quick-add';
    modal.id = 'draft-quick-add-modal';
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML =
      '<div class="summit-modal__backdrop" data-quick-add-close></div>' +
      '<div class="summit-modal__panel draft-quick-add__panel" role="dialog" aria-modal="true" aria-labelledby="draft-quick-add-title">' +
        '<div class="summit-modal__header">' +
          '<h2 class="summit-modal__title" id="draft-quick-add-title">Quick Add</h2>' +
          '<button type="button" class="summit-modal__close" data-quick-add-close aria-label="Close">\u2715</button>' +
        '</div>' +
        '<p class="draft-name-helper__hint">Pick an existing level or add a new one. Leave the rest blank if you only need a Scheme or Category for now \u2014 the level before it just has to already exist.</p>' +

        '<label class="draft-field-label" for="draft-quick-add-scheme">Scheme</label>' +
        '<select class="summit-select" id="draft-quick-add-scheme"></select>' +

        '<label class="draft-field-label" for="draft-quick-add-category">Category</label>' +
        '<select class="summit-select" id="draft-quick-add-category" disabled></select>' +

        '<label class="draft-field-label" for="draft-quick-add-enquiry">Enquiry</label>' +
        '<select class="summit-select" id="draft-quick-add-enquiry" disabled></select>' +

        '<label class="draft-field-label" for="draft-quick-add-subenquiry">Sub-Enquiry</label>' +
        '<select class="summit-select" id="draft-quick-add-subenquiry" disabled></select>' +

        '<p class="draft-template-status" id="draft-quick-add-status" aria-live="polite"></p>' +

        '<div class="summit-modal__actions">' +
          '<button type="button" class="summit-btn summit-btn--primary" data-quick-add-close>Done</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    quickAddSel = {
      scheme: modal.querySelector('#draft-quick-add-scheme'),
      category: modal.querySelector('#draft-quick-add-category'),
      enquiry: modal.querySelector('#draft-quick-add-enquiry'),
      subenquiry: modal.querySelector('#draft-quick-add-subenquiry'),
      status: modal.querySelector('#draft-quick-add-status')
    };

    function refreshQuickScheme() {
      fillSelect(
        quickAddSel.scheme,
        state.schemeIds.map((id) => ({ id, name: state.schemes[id].name })),
        'Select scheme\u2026', '+ New scheme\u2026'
      );
      quickAddSel.category.innerHTML = ''; quickAddSel.category.disabled = true;
      quickAddSel.enquiry.innerHTML = ''; quickAddSel.enquiry.disabled = true;
      quickAddSel.subenquiry.innerHTML = ''; quickAddSel.subenquiry.disabled = true;
    }

    quickAddSel.scheme.addEventListener('change', () => {
      let val = quickAddSel.scheme.value;
      if (val === NEW_VALUE) {
        const name = window.prompt('New scheme name:');
        if (name && name.trim()) {
          val = createScheme(name.trim());
          expandedIds.add(val);
          renderAll();
          refreshQuickScheme();
          quickAddSel.scheme.value = val;
          quickAddSel.status.textContent = 'Added scheme \u201c' + name.trim() + '\u201d.';
        } else {
          quickAddSel.scheme.value = '';
          return;
        }
      }
      const schemeId = quickAddSel.scheme.value;
      quickAddSel.enquiry.innerHTML = ''; quickAddSel.enquiry.disabled = true;
      quickAddSel.subenquiry.innerHTML = ''; quickAddSel.subenquiry.disabled = true;
      if (!schemeId) { quickAddSel.category.innerHTML = ''; quickAddSel.category.disabled = true; return; }
      const scheme = state.schemes[schemeId];
      fillSelect(
        quickAddSel.category,
        scheme.categoryIds.map((id) => ({ id, name: state.categories[id].name })),
        'Select category\u2026', '+ New category\u2026'
      );
      quickAddSel.category.disabled = false;
    });

    quickAddSel.category.addEventListener('change', () => {
      const schemeId = quickAddSel.scheme.value;
      let val = quickAddSel.category.value;
      if (val === NEW_VALUE) {
        const name = window.prompt('New category name:');
        if (name && name.trim()) {
          val = createCategory(schemeId, name.trim());
          expandedIds.add(schemeId); expandedIds.add(val);
          renderAll();
          const scheme = state.schemes[schemeId];
          fillSelect(
            quickAddSel.category,
            scheme.categoryIds.map((id) => ({ id, name: state.categories[id].name })),
            'Select category\u2026', '+ New category\u2026'
          );
          quickAddSel.category.value = val;
          quickAddSel.status.textContent = 'Added category \u201c' + name.trim() + '\u201d.';
        } else {
          quickAddSel.category.value = '';
          return;
        }
      }
      const categoryId = quickAddSel.category.value;
      quickAddSel.subenquiry.innerHTML = ''; quickAddSel.subenquiry.disabled = true;
      if (!categoryId) { quickAddSel.enquiry.innerHTML = ''; quickAddSel.enquiry.disabled = true; return; }
      const cat = state.categories[categoryId];
      fillSelect(
        quickAddSel.enquiry,
        cat.enquiryIds.map((id) => ({ id, name: state.enquiries[id].name })),
        'Select enquiry\u2026', '+ New enquiry\u2026'
      );
      quickAddSel.enquiry.disabled = false;
    });

    quickAddSel.enquiry.addEventListener('change', () => {
      const categoryId = quickAddSel.category.value;
      let val = quickAddSel.enquiry.value;
      if (val === NEW_VALUE) {
        const name = window.prompt('New enquiry name:');
        if (name && name.trim()) {
          val = createEnquiry(categoryId, name.trim());
          const cat = state.categories[categoryId];
          expandedIds.add(cat.schemeId); expandedIds.add(categoryId); expandedIds.add(val);
          renderAll();
          fillSelect(
            quickAddSel.enquiry,
            cat.enquiryIds.map((id) => ({ id, name: state.enquiries[id].name })),
            'Select enquiry\u2026', '+ New enquiry\u2026'
          );
          quickAddSel.enquiry.value = val;
          quickAddSel.status.textContent = 'Added enquiry \u201c' + name.trim() + '\u201d.';
        } else {
          quickAddSel.enquiry.value = '';
          return;
        }
      }
      const enquiryId = quickAddSel.enquiry.value;
      if (!enquiryId) { quickAddSel.subenquiry.innerHTML = ''; quickAddSel.subenquiry.disabled = true; return; }
      const enq = state.enquiries[enquiryId];
      fillSelect(
        quickAddSel.subenquiry,
        enq.subEnquiryIds.map((id) => ({ id, name: state.subEnquiries[id].name })),
        'Select sub-enquiry\u2026', '+ New sub-enquiry\u2026'
      );
      quickAddSel.subenquiry.disabled = false;
    });

    quickAddSel.subenquiry.addEventListener('change', () => {
      const enquiryId = quickAddSel.enquiry.value;
      const val = quickAddSel.subenquiry.value;
      if (val === NEW_VALUE) {
        quickAddSel.subenquiry.value = '';
        openNameHelper('', (name) => {
          const subId = createSubEnquiry(enquiryId, name);
          const enq = state.enquiries[enquiryId];
          renderAll();
          fillSelect(
            quickAddSel.subenquiry,
            enq.subEnquiryIds.map((id) => ({ id, name: state.subEnquiries[id].name })),
            'Select sub-enquiry\u2026', '+ New sub-enquiry\u2026'
          );
          quickAddSel.subenquiry.value = subId;
          quickAddSel.status.textContent = 'Added sub-enquiry \u201c' + name + '\u201d.';
        });
      }
    });

    modal.querySelectorAll('[data-quick-add-close]').forEach((el) => {
      el.addEventListener('click', closeQuickAdd);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) closeQuickAdd();
    });

    quickAddEl = modal;
    quickAddEl._refreshScheme = refreshQuickScheme;
    return modal;
  }

  function openQuickAdd() {
    const modal = ensureQuickAddModal();
    modal._refreshScheme();
    quickAddSel.status.textContent = '';
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    quickAddSel.scheme.focus();
  }

  function closeQuickAdd() {
    if (!quickAddEl) return;
    quickAddEl.hidden = true;
    quickAddEl.setAttribute('aria-hidden', 'true');
  }

  if (quickAddBtn) quickAddBtn.addEventListener('click', openQuickAdd);

  // As a Scheme/Category/Enquiry/Sub-Enquiry list grows long, scanning
  // a plain <select> dropdown gets slow. This layers a type-to-filter
  // combobox over a <select> without touching any of the cascading
  // logic that already targets it: the native <select> stays in the
  // DOM (still driving .value/.disabled/change listeners exactly as
  // before, just visually hidden), and a text input + filtered list
  // sit in front of it. Picking a row sets the select's value and
  // dispatches a real 'change' event, so every existing listener
  // fires exactly as if the user had clicked the native option
  // directly.
  //
  // Two flavours of placeholder show up across the app's selects:
  //   - "File these keywords" (fillSelect): the blank option just
  //     means "nothing chosen yet" and there's a pinned "+ New…"
  //     sentinel (newValue) at the bottom.
  //   - Template Finder (fillFindSelect): the blank option is a real,
  //     meaningful choice ("All schemes" etc.), so it belongs in the
  //     filterable list too, and there's no "+ New…" row.
  function enhanceSearchableSelect(select, opts) {
    opts = opts || {};
    const includeEmptyOption = !!opts.includeEmptyOption;
    const newValue = opts.newValue || null;

    const wrap = document.createElement('div');
    wrap.className = 'draft-combobox';
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    select.classList.add('draft-combobox__native');
    select.setAttribute('tabindex', '-1');
    select.setAttribute('aria-hidden', 'true');

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'summit-select draft-combobox__input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    if (select.getAttribute('aria-label')) input.setAttribute('aria-label', select.getAttribute('aria-label'));
    wrap.appendChild(input);

    const menu = document.createElement('ul');
    menu.className = 'draft-combobox__menu';
    menu.hidden = true;
    wrap.appendChild(menu);

    function syncInputFromSelect() {
      const opt = select.options[select.selectedIndex];
      if (!opt || opt.value === newValue) { input.value = ''; return; }
      if (opt.value === '' && !includeEmptyOption) { input.value = ''; return; }
      input.value = opt.textContent;
    }

    function closeMenu() {
      menu.hidden = true;
      menu.innerHTML = '';
    }

    function chooseOption(opt) {
      select.value = opt.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      syncInputFromSelect();
      closeMenu();
    }

    function openMenu(filterText) {
      if (select.disabled) return;
      const q = (filterText || '').trim().toLowerCase();
      const all = Array.from(select.options);
      const newOpt = newValue ? all.find((o) => o.value === newValue) : null;
      let regular = all.filter((o) => o.value !== newValue);
      if (!includeEmptyOption) regular = regular.filter((o) => o.value !== '');
      const matches = regular.filter((o) => !q || o.textContent.toLowerCase().includes(q));

      menu.innerHTML = '';
      if (matches.length === 0 && !newOpt) {
        const li = document.createElement('li');
        li.className = 'draft-combobox__empty';
        li.textContent = 'No matches';
        menu.appendChild(li);
      } else {
        if (matches.length === 0) {
          const li = document.createElement('li');
          li.className = 'draft-combobox__empty';
          li.textContent = 'No matches';
          menu.appendChild(li);
        }
        matches.forEach((o) => {
          const li = document.createElement('li');
          li.className = 'draft-combobox__option';
          li.textContent = o.textContent;
          li.addEventListener('mousedown', (e) => { e.preventDefault(); chooseOption(o); });
          menu.appendChild(li);
        });
        if (newOpt) {
          const li = document.createElement('li');
          li.className = 'draft-combobox__option draft-combobox__option--new';
          li.textContent = newOpt.textContent;
          li.addEventListener('mousedown', (e) => { e.preventDefault(); chooseOption(newOpt); });
          menu.appendChild(li);
        }
      }
      menu.hidden = false;
    }

    input.addEventListener('focus', () => { input.select(); openMenu(''); });
    input.addEventListener('input', () => openMenu(input.value));
    input.addEventListener('blur', () => {
      // Deferred so a mousedown on an option registers before the menu closes.
      setTimeout(() => { closeMenu(); syncInputFromSelect(); }, 0);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeMenu(); input.blur(); }
      if (e.key === 'Enter') e.preventDefault();
    });

    // fillSelect()/fillFindSelect() replace the options wholesale
    // whenever the hierarchy or the cascade level changes — catch
    // that here so the visible input always reflects the select's
    // current state.
    new MutationObserver(() => { if (menu.hidden) syncInputFromSelect(); })
      .observe(select, { childList: true });
    new MutationObserver(() => { input.disabled = select.disabled; })
      .observe(select, { attributes: true, attributeFilter: ['disabled'] });
    select.addEventListener('change', syncInputFromSelect);

    input.disabled = select.disabled;
    syncInputFromSelect();
  }

  // A lighter-weight cousin of enhanceSearchableSelect for fields that
  // take free text (the value doesn't have to be one of the
  // suggestions — typing something brand new is the normal case, not
  // an edge case). Wraps `input` in the same scrollable dropdown look
  // as the selects above; `getSuggestions()` is called fresh every
  // time the menu opens so it always reflects the latest hierarchy.
  function enhanceSuggestInput(input, getSuggestions) {
    const wrap = document.createElement('div');
    wrap.className = 'draft-combobox draft-combobox--suggest';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.classList.add('draft-combobox__input');

    const menu = document.createElement('ul');
    menu.className = 'draft-combobox__menu';
    menu.hidden = true;
    wrap.appendChild(menu);

    function closeMenu() {
      menu.hidden = true;
      menu.innerHTML = '';
    }

    function chooseValue(value) {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      closeMenu();
      input.focus();
    }

    function openMenu() {
      const all = getSuggestions() || [];
      if (all.length === 0) { closeMenu(); return; }
      const q = input.value.trim().toLowerCase();
      const matches = q ? all.filter((v) => v.toLowerCase().includes(q)) : all;

      menu.innerHTML = '';
      if (matches.length === 0) {
        const li = document.createElement('li');
        li.className = 'draft-combobox__empty';
        li.textContent = 'No existing matches — your typed text will be used as-is';
        menu.appendChild(li);
      } else {
        matches.forEach((v) => {
          const li = document.createElement('li');
          li.className = 'draft-combobox__option';
          li.textContent = v;
          li.addEventListener('mousedown', (e) => { e.preventDefault(); chooseValue(v); });
          menu.appendChild(li);
        });
      }
      menu.hidden = false;
    }

    input.addEventListener('focus', openMenu);
    input.addEventListener('input', openMenu);
    input.addEventListener('blur', () => { setTimeout(closeMenu, 0); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeMenu(); input.blur(); }
    });

    // Belt-and-suspenders: close explicitly on any click that lands
    // outside this field's own input/menu, rather than relying only
    // on blur. Typing (no mousedown involved) never trips this, so
    // the menu still stays open and updates while the user types.
    document.addEventListener('mousedown', (e) => {
      if (!menu.hidden && e.target !== input && !menu.contains(e.target)) {
        closeMenu();
      }
    });
  }

  [fileSchemeSel, fileCategorySel, fileEnquirySel, fileSubSel].forEach((sel) => {
    enhanceSearchableSelect(sel, { newValue: NEW_VALUE });
  });

  fileBtn.addEventListener('click', () => {
    const subId = fileSubSel.value;
    if (!subId || subId === NEW_VALUE || state.pendingKeywords.length === 0) return;
    const sub = state.subEnquiries[subId];

    const templateChoice = fileTemplateSel.value;
    let targetTpl = null;
    if (templateChoice && templateChoice !== NEW_VALUE) {
      targetTpl = findTemplateById(sub, templateChoice);
    }

    if (targetTpl) {
      const merged = (targetTpl.keywords || []).slice();
      state.pendingKeywords.forEach((kw) => { if (!merged.includes(kw)) merged.push(kw); });
      targetTpl.keywords = merged;
      activeTemplateId = targetTpl.id;
    } else {
      const merged = sub.keywords.slice();
      state.pendingKeywords.forEach((kw) => { if (!merged.includes(kw)) merged.push(kw); });
      sub.keywords = merged;
    }
    state.selectedSubEnquiryId = subId;

    // Expand the tree down to the newly-filed sub-enquiry.
    const enq = state.enquiries[sub.enquiryId];
    const cat = state.categories[enq.categoryId];
    expandedIds.add(cat.schemeId);
    expandedIds.add(enq.categoryId);
    expandedIds.add(sub.enquiryId);

    showToast('Filed ' + state.pendingKeywords.length + ' keyword(s) to ' + pathForSubEnquiry(subId) +
      (targetTpl ? ' \u2014 ' + (targetTpl.name || 'Untitled') : ' (general)'));
    renderAll();
  });

  // ============================================================
  // 5.3 — Detail panel: filed keywords + template linking
  // ============================================================

  // Runtime-only: which of the selected Sub-Enquiry's templates is
  // currently loaded into the editor. Not persisted — like
  // pendingLabels, it resets whenever a different Sub-Enquiry is
  // selected (see renderDetail).
  let activeTemplateId = null;

  function renderDetail() {
    const subId = state.selectedSubEnquiryId;
    const sub = subId ? state.subEnquiries[subId] : null;
    if (!sub) {
      detailEmpty.hidden = false;
      detailContent.hidden = true;
      activeTemplateId = null;
      if (detailKeywordsClearBtn) detailKeywordsClearBtn.disabled = true;
      renderLabelChips([], false);
      return;
    }
    detailEmpty.hidden = true;
    detailContent.hidden = false;
    detailPath.textContent = pathForSubEnquiry(subId);

    detailKeywordsEl.innerHTML = '';
    if (sub.keywords.length === 0) {
      const note = document.createElement('p');
      note.className = 'draft-empty-note';
      note.textContent = 'No keywords filed here yet.';
      detailKeywordsEl.appendChild(note);
    } else {
      sub.keywords.forEach((kw) => {
        const chip = document.createElement('span');
        chip.className = 'draft-chip';
        const label = document.createElement('span');
        label.textContent = kw;
        chip.appendChild(label);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'draft-chip__remove';
        remove.setAttribute('aria-label', 'Remove keyword ' + kw);
        remove.textContent = '\u00D7';
        remove.addEventListener('click', () => {
          sub.keywords = sub.keywords.filter((k) => k !== kw);
          renderAll();
        });
        chip.appendChild(remove);
        detailKeywordsEl.appendChild(chip);
      });
    }
    if (detailKeywordsClearBtn) detailKeywordsClearBtn.disabled = sub.keywords.length === 0;

    renderTemplateList(sub); // normalizes activeTemplateId first, so...
    const tpl = findTemplateById(sub, activeTemplateId);
    renderLabelChips(templateLabels(tpl).slice(), !!tpl); // ...this loads the right template's own tags
    renderTemplateIntoEditor(tpl);
    updateTemplateStatus(sub, tpl);
    renderTemplateKeywords(sub, tpl);
  }

  if (detailKeywordsClearBtn) {
    detailKeywordsClearBtn.addEventListener('click', () => {
      const subId = state.selectedSubEnquiryId;
      const sub = subId ? state.subEnquiries[subId] : null;
      if (!sub || sub.keywords.length === 0) return;
      if (!window.confirm('Remove all ' + sub.keywords.length + ' keyword(s) filed here on ' + sub.name + '?')) return;
      sub.keywords = [];
      renderAll();
    });
  }

  // ---------- Per-template keywords: shown/edited alongside whichever
  // template tab is active. Kept separate from the general Sub-Enquiry
  // "Keywords filed here" list above — see effectiveTemplateKeywords()
  // for how the two combine when matching. ----------
  function renderTemplateKeywords(sub, tpl) {
    if (!templateKeywordsEl) return;
    templateKeywordsEl.innerHTML = '';
    if (!tpl) {
      const note = document.createElement('p');
      note.className = 'draft-empty-note';
      note.textContent = 'Select or add a template to give it its own keywords.';
      templateKeywordsEl.appendChild(note);
      if (templateKeywordInput) templateKeywordInput.disabled = true;
      if (templateKeywordsClearBtn) templateKeywordsClearBtn.disabled = true;
      return;
    }
    if (templateKeywordInput) templateKeywordInput.disabled = false;
    const keywords = tpl.keywords || [];
    if (templateKeywordsClearBtn) templateKeywordsClearBtn.disabled = keywords.length === 0;
    if (keywords.length === 0) {
      const note = document.createElement('p');
      note.className = 'draft-empty-note';
      note.textContent = 'No keywords filed to this template yet \u2014 it still matches on the Sub-Enquiry\u2019s general keywords above.';
      templateKeywordsEl.appendChild(note);
    } else {
      keywords.forEach((kw) => {
        const chip = document.createElement('span');
        chip.className = 'draft-chip';
        const label = document.createElement('span');
        label.textContent = kw;
        chip.appendChild(label);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'draft-chip__remove';
        remove.setAttribute('aria-label', 'Remove template keyword ' + kw);
        remove.textContent = '\u00D7';
        remove.addEventListener('click', () => {
          tpl.keywords = (tpl.keywords || []).filter((k) => k !== kw);
          renderAll();
        });
        chip.appendChild(remove);
        templateKeywordsEl.appendChild(chip);
      });
    }
  }

  if (templateKeywordInput) {
    templateKeywordInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const sub = state.selectedSubEnquiryId ? state.subEnquiries[state.selectedSubEnquiryId] : null;
      const tpl = sub ? findTemplateById(sub, activeTemplateId) : null;
      const value = templateKeywordInput.value.trim();
      if (!sub || !tpl || !value) return;
      const merged = tpl.keywords || [];
      if (!merged.includes(value)) merged.push(value);
      tpl.keywords = merged;
      templateKeywordInput.value = '';
      renderAll();
    });
  }

  if (templateKeywordsClearBtn) {
    templateKeywordsClearBtn.addEventListener('click', () => {
      const sub = state.selectedSubEnquiryId ? state.subEnquiries[state.selectedSubEnquiryId] : null;
      const tpl = sub ? findTemplateById(sub, activeTemplateId) : null;
      if (!tpl || !(tpl.keywords || []).length) return;
      if (!window.confirm('Remove all ' + tpl.keywords.length + ' keyword(s) from ' + (tpl.name || 'this template') + '?')) return;
      tpl.keywords = [];
      renderAll();
    });
  }

  // ---------- Template list (tabs) — pick which template is being
  // edited, add a new one, rename, or delete the active one. ----------

  function updateTemplateStatus(sub, tpl) {
    const count = subTemplates(sub).length;
    if (!tpl) {
      templateStatus.textContent = count ? 'No template selected.' : 'No template attached yet.';
      templateStatus.classList.remove('is-saved');
      return;
    }
    templateStatus.textContent = (tpl.template ? 'Template attached' : 'Empty template — not yet saved') +
      (count > 1 ? ' \u2014 ' + count + ' templates total.' : '.');
    templateStatus.classList.toggle('is-saved', !!tpl.template);
  }

  function renderTemplateList(sub) {
    const templates = subTemplates(sub);
    if (!templates.some((t) => t.id === activeTemplateId)) {
      activeTemplateId = templates.length ? templates[0].id : null;
    }
    if (!templateListEl) return;
    templateListEl.innerHTML = '';
    if (templates.length === 0) {
      const note = document.createElement('p');
      note.className = 'draft-empty-note';
      note.textContent = 'No templates yet \u2014 click "+ New template" to add one.';
      templateListEl.appendChild(note);
      return;
    }
    const folders = groupTemplatesByFolder(templates);
    folders.forEach((folder, i) => {
      const folderEl = document.createElement('div');
      folderEl.className = 'draft-template-folder';

      // Always labelled — "Folder 1", "Folder 2"... — so the grouping
      // itself is visible even when everything's still untagged and
      // there's only the one folder so far.
      const heading = document.createElement('p');
      heading.className = 'draft-template-folder__label';
      heading.textContent = 'Folder ' + (i + 1) + ' \u2014 ' +
        (folder.labels.length ? folder.labels.map((l) => '#' + l).join(' ') : 'No tags');
      folderEl.appendChild(heading);

      const chipsRow = document.createElement('div');
      chipsRow.className = 'draft-template-folder__chips';

      folder.templates.forEach((tpl) => {
        const chip = document.createElement('span');
        chip.className = 'draft-template-tab' + (tpl.id === activeTemplateId ? ' is-active' : '');

        const label = document.createElement('span');
        label.className = 'draft-template-tab__label';
        label.textContent = tpl.name || 'Untitled';
        label.title = 'Click to select this template, double-click to rename';
        chip.appendChild(label);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'draft-chip__remove';
        remove.setAttribute('aria-label', 'Delete template ' + (tpl.name || ''));
        remove.textContent = '\u00D7';
        remove.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteTemplate(sub, tpl);
        });
        chip.appendChild(remove);

        chip.addEventListener('click', () => {
          if (activeTemplateId === tpl.id) return;
          activeTemplateId = tpl.id;
          renderTemplateList(sub);
          renderTemplateIntoEditor(tpl);
          updateTemplateStatus(sub, tpl);
          renderTemplateKeywords(sub, tpl);
          renderLabelChips(templateLabels(tpl).slice(), true);
        });
        label.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          const next = window.prompt('Rename this template:', tpl.name || '');
          if (next === null) return;
          const trimmed = next.trim();
          if (!trimmed) return;
          tpl.name = trimmed;
          renderTemplateList(sub);
        });

        chipsRow.appendChild(chip);
      });

      folderEl.appendChild(chipsRow);
      templateListEl.appendChild(folderEl);
    });
  }

  // Core removal logic shared by every place a template can be deleted
  // from (the Tag view's template tabs, and the Find & Search results
  // list / "View more" modal). Mutates sub.templates, keeps the tree
  // badges and deep search index in sync. Since Name/Term tags now
  // live on the template itself, deleting it takes its tags with it —
  // returns true when the deleted template actually had any, so
  // callers can mention it in their toast and refresh the label
  // filter/datalist (which are built from what's left).
  function deleteTemplateCore(sub, tpl) {
    if (!tpl) return false;
    const hadLabels = templateLabels(tpl).length > 0;
    sub.templates = subTemplates(sub).filter((t) => t.id !== tpl.id);
    if (hadLabels) {
      refreshLabelDatalist();
      refreshFindLabelSelect();
    }
    renderTree(); // badge counts etc. stay in sync
    buildDeepIndex();
    return hadLabels;
  }

  // Shared by "Clear template" and each template tab's own \u00D7 —
  // removes one template slot outright (as opposed to just emptying
  // the editor), same as the old single-template "Clear template"
  // behaviour when there was only ever one slot to remove.
  function deleteTemplate(sub, tpl) {
    if (!tpl) return;
    if (!window.confirm('Remove the template "' + (tpl.name || 'Untitled') + '" from "' + sub.name + '"?')) return;
    const hadLabels = deleteTemplateCore(sub, tpl);
    if (activeTemplateId === tpl.id) {
      activeTemplateId = sub.templates.length ? sub.templates[0].id : null;
    }
    const nextTpl = findTemplateById(sub, activeTemplateId);
    renderTemplateList(sub);
    renderTemplateIntoEditor(nextTpl);
    updateTemplateStatus(sub, nextTpl);
    renderTemplateKeywords(sub, nextTpl);
    renderLabelChips(templateLabels(nextTpl).slice(), !!nextTpl);
    showToast('Template removed from ' + sub.name +
      (hadLabels ? ' \u2014 its Name/Term tags were removed with it.' : ''));
  }

  // Delete/rename entry points used by the Find & Search results list
  // (and its "View more" modal) — these act on whichever Sub-Enquiry
  // the result card belongs to, which may not be the one currently
  // open in the Tag view, so they only touch the Tag view's own DOM
  // when that happens to be the same Sub-Enquiry.
  function deleteTemplateFromResults(sub, tpl, rerender) {
    if (!tpl) return;
    if (!window.confirm('Remove the template "' + (tpl.name || 'Untitled') + '" from "' + sub.name + '"?')) return;
    const wasOpenInTagView = sub.id === state.selectedSubEnquiryId;
    const hadLabels = deleteTemplateCore(sub, tpl);
    if (wasOpenInTagView && activeTemplateId === tpl.id) {
      activeTemplateId = sub.templates.length ? sub.templates[0].id : null;
      const nextTpl = findTemplateById(sub, activeTemplateId);
      renderTemplateList(sub);
      renderTemplateIntoEditor(nextTpl);
      updateTemplateStatus(sub, nextTpl);
      renderTemplateKeywords(sub, nextTpl);
      renderLabelChips(templateLabels(nextTpl).slice(), !!nextTpl);
    }
    showToast('Template removed from ' + sub.name +
      (hadLabels ? ' \u2014 its Name/Term tags were removed with it.' : ''));
    rerender();
  }

  function renameTemplateFromResults(sub, tpl, rerender) {
    const next = window.prompt('Rename this template:', tpl.name || '');
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    tpl.name = trimmed;
    if (sub.id === state.selectedSubEnquiryId) renderTemplateList(sub);
    rerender();
  }

  if (templateAddBtn) {
    templateAddBtn.addEventListener('click', () => {
      const subId = state.selectedSubEnquiryId;
      if (!subId) return;
      const sub = state.subEnquiries[subId];
      const templates = subTemplates(sub);
      const untagged = templatesInFolder(templates, []);
      const tpl = { id: uid('tpl'), name: uniqueTemplateName(untagged, 'Template ' + (untagged.length + 1)), template: '', templateHtml: '', templateLinks: [], keywords: [], labels: [] };
      templates.push(tpl);
      activeTemplateId = tpl.id;
      renderTemplateList(sub);
      renderTemplateIntoEditor(tpl);
      updateTemplateStatus(sub, tpl);
      renderTemplateKeywords(sub, tpl);
      renderLabelChips(templateLabels(tpl).slice(), true);
      templateInput.focus();
    });
  }

  // ============================================================
  // Quick Template Adder — paste a raw two-column block (as copied
  // straight out of a Word table: the member's enquiry, a tab, then
  // the officer's reply) and have it:
  //   1. split into enquiry text / reply text,
  //   2. run the enquiry text through the same extractKeywords() used
  //      by Paste & extract, filing the result as this template's own
  //      keywords,
  //   3. find the next template slot on the *currently selected*
  //      Sub-Enquiry that doesn't already have saved text yet (1, 2,
  //      3… creating a new one if every existing slot is full),
  //   4. pre-fill Name/Term with the two most recently used labels
  //      (or, failing any usage history, the two used most often
  //      overall),
  //   5. drop the reply text into the template editor, unsaved — same
  //      as typing it in by hand — so "Save template" still applies.
  // ============================================================

  let quickTplEl = null;

  function ensureQuickTemplateModal() {
    if (quickTplEl) return quickTplEl;

    const modal = document.createElement('div');
    modal.className = 'summit-modal draft-quicktpl';
    modal.id = 'draft-quicktpl-modal';
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML =
      '<div class="summit-modal__backdrop" data-quicktpl-close></div>' +
      '<div class="summit-modal__panel draft-quicktpl__panel" role="dialog" aria-modal="true" aria-labelledby="draft-quicktpl-title">' +
        '<div class="summit-modal__header">' +
          '<h2 class="summit-modal__title" id="draft-quicktpl-title">Quick template adder</h2>' +
          '<button type="button" class="summit-modal__close" data-quicktpl-close aria-label="Close">\u2715</button>' +
        '</div>' +
        '<p class="draft-name-helper__hint" id="draft-quicktpl-target"></p>' +
        '<p class="draft-search-help">Paste the two-column block copied straight from your table \u2014 the member\u2019s enquiry, then a tab, then the reply. If the tab gets lost in the paste, this falls back to splitting at the 2nd \u201cDear\u201d. Bold, italics, underline and hyperlinks in the reply are kept when pasting from a table or Word.</p>' +
        '<label class="draft-name-helper__check draft-quicktpl__ignoremid" for="draft-quicktpl-ignoremiddle">' +
          '<input type="checkbox" id="draft-quicktpl-ignoremiddle" />' +
          ' Ignore middle column' +
        '</label>' +
        '<p class="draft-search-help draft-quicktpl__ignoremid-hint">For a 3-column paste (enquiry, then a middle column, then the reply) \u2014 skips the middle column, treats the first column as the enquiry and the last as the reply. When the tab is lost, splits at the very last \u201cDear\u201d instead of the 2nd, since the middle column has one too.</p>' +
        '<textarea class="draft-textarea" id="draft-quicktpl-input" placeholder="Paste the raw enquiry + reply block here\u2026" aria-label="Raw enquiry and reply text to parse"></textarea>' +
        '<div class="summit-modal__actions">' +
          '<button type="button" class="summit-btn" data-quicktpl-close>Cancel</button>' +
          '<button type="button" class="summit-btn summit-btn--primary" id="draft-quicktpl-apply-btn">Extract &amp; fill template</button>' +
        '</div>' +
        '<p class="draft-template-status" id="draft-quicktpl-status" aria-live="polite"></p>' +
      '</div>';
    document.body.appendChild(modal);

    const targetEl = modal.querySelector('#draft-quicktpl-target');
    const inputEl = modal.querySelector('#draft-quicktpl-input');
    const applyBtn = modal.querySelector('#draft-quicktpl-apply-btn');
    const statusEl = modal.querySelector('#draft-quicktpl-status');
    const ignoreMiddleEl = modal.querySelector('#draft-quicktpl-ignoremiddle');

    // Sticks for the rest of the browser session (sessionStorage, not
    // localStorage) — stays on across re-opens of this modal and page
    // navigations within the tab, but resets once the browser/tab is
    // actually closed, per how the toggle is meant to behave.
    const IGNORE_MIDDLE_KEY = 'draft-quicktpl-ignore-middle';
    try {
      ignoreMiddleEl.checked = sessionStorage.getItem(IGNORE_MIDDLE_KEY) === '1';
    } catch (err) { /* sessionStorage unavailable — default unchecked */ }
    ignoreMiddleEl.addEventListener('change', () => {
      try {
        sessionStorage.setItem(IGNORE_MIDDLE_KEY, ignoreMiddleEl.checked ? '1' : '0');
      } catch (err) { /* ignore — storage may be blocked */ }
    });

    // Plain <textarea>s only ever receive the clipboard's text/plain
    // representation, so a straight paste has already lost any bold/
    // italic/underline/hyperlink formatting before applyQuickTemplate
    // ever sees it. We don't switch this box to a contenteditable
    // (it stays simple to type/select in), and instead just siphon
    // the richer text/html representation off the same paste event
    // into quickTplEl._lastHtml, leaving the textarea's own paste
    // behaviour untouched. applyQuickTemplate uses that cached HTML
    // (when present) to do the enquiry/reply split with formatting
    // intact, and falls back to the plain-text-only split otherwise.
    // A stray flag distinguishes the 'input' event a paste itself
    // fires from a genuine subsequent edit, so nudging the cursor
    // around with the arrow keys after pasting doesn't invalidate it,
    // but actually changing the text does.
    let justPastedHtml = false;
    inputEl.addEventListener('paste', (e) => {
      const cd = e.clipboardData || window.clipboardData;
      const html = cd && cd.getData('text/html');
      quickTplEl._lastHtml = html || '';
      justPastedHtml = true;
    });
    inputEl.addEventListener('input', () => {
      if (justPastedHtml) { justPastedHtml = false; return; }
      quickTplEl._lastHtml = '';
    });

    applyBtn.addEventListener('click', () => {
      const raw = inputEl.value;
      if (!raw || !raw.trim()) {
        statusEl.textContent = 'Paste some text first.';
        statusEl.classList.remove('is-saved');
        return;
      }
      const result = applyQuickTemplate(raw, quickTplEl._lastHtml, ignoreMiddleEl.checked);
      statusEl.textContent = result.message;
      statusEl.classList.toggle('is-saved', result.ok);
      if (result.ok) {
        inputEl.value = '';
        quickTplEl._lastHtml = '';
        showToast(result.message);
      }
    });

    modal.querySelectorAll('[data-quicktpl-close]').forEach((el) => {
      el.addEventListener('click', closeQuickTemplateModal);
    });

    quickTplEl = modal;
    quickTplEl._target = targetEl;
    quickTplEl._input = inputEl;
    quickTplEl._apply = applyBtn;
    quickTplEl._status = statusEl;
    quickTplEl._ignoreMiddle = ignoreMiddleEl;
    quickTplEl._lastHtml = '';
    return modal;
  }

  function openQuickTemplateModal() {
    const modal = ensureQuickTemplateModal();
    const subId = state.selectedSubEnquiryId;
    const sub = subId ? state.subEnquiries[subId] : null;
    modal._status.textContent = '';
    modal._status.classList.remove('is-saved');
    modal._lastHtml = '';
    if (sub) {
      modal._target.textContent = 'Will fill the next available template on: ' + pathForSubEnquiry(subId);
      modal._apply.disabled = false;
    } else {
      modal._target.textContent = 'Select a Sub-Enquiry in the Hierarchy first, then reopen this.';
      modal._apply.disabled = true;
    }
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    modal._input.focus();
  }

  function closeQuickTemplateModal() {
    if (!quickTplEl) return;
    quickTplEl.hidden = true;
    quickTplEl.setAttribute('aria-hidden', 'true');
  }

  if (quickTemplateBtn) quickTemplateBtn.addEventListener('click', openQuickTemplateModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && quickTplEl && !quickTplEl.hidden) closeQuickTemplateModal();
  });

  // Splits a raw pasted block into { enquiryText, templateText }.
  // Primary rule: split at the first literal tab character (the
  // column boundary when copying a row straight out of a Word/Excel
  // table) — or, with ignoreMiddle on and a 3rd column present (a 2nd
  // tab), at the *last* tab instead, dropping whatever's between the
  // first and last tab as the ignored middle column. Fallback, for
  // when a paste strips tabs: split right before the 2nd whole-word
  // "Dear" in the text (or the *last* "Dear" with ignoreMiddle on,
  // since the middle column's own "Dear" would otherwise get
  // mistaken for the reply's), since these table exports always
  // start the enquiry with a greeting and the reply with another.
  function parseQuickTemplateBlock(raw, ignoreMiddle) {
    const text = raw.replace(/\r\n/g, '\n');
    let enquiryPart;
    let replyPart;
    const tabIndex = text.indexOf('\t');
    const lastTabIndex = text.lastIndexOf('\t');
    if (tabIndex !== -1) {
      enquiryPart = text.slice(0, tabIndex);
      replyPart = ignoreMiddle && lastTabIndex !== tabIndex
        ? text.slice(lastTabIndex + 1)
        : text.slice(tabIndex + 1);
    } else {
      const splitIndex = findDearSplitIndex(text, ignoreMiddle);
      if (splitIndex === -1) return null;
      enquiryPart = text.slice(0, splitIndex);
      replyPart = text.slice(splitIndex);
    }
    enquiryPart = enquiryPart.trim();
    replyPart = replyPart.trim();
    if (!enquiryPart || !replyPart) return null;
    return { enquiryText: enquiryPart, templateText: replyPart };
  }

  // Returns the innerHTML of the enquiry/reply <td>/<th> cells of the
  // first table row shaped like that, or null if the pasted HTML
  // doesn't contain a usable table. Normally that's the first two
  // cells. With ignoreMiddle on and a 3rd (or later) column present,
  // it's the first cell and the *last* cell instead, skipping
  // whatever's in between. Checked separately from
  // htmlToTemplateFragment because that function unwraps
  // <table>/<tr>/<td> entirely with no separator between cells, so by
  // the time it's run the column boundary that matters here is
  // already gone.
  function firstTwoTableCells(html, ignoreMiddle) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = Array.from(doc.querySelectorAll('table tr'));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td, th'));
      if (ignoreMiddle && cells.length >= 3) {
        return [cells[0].innerHTML, cells[cells.length - 1].innerHTML];
      }
      if (cells.length >= 2) return [cells[0].innerHTML, cells[1].innerHTML];
    }
    return null;
  }

  // Raw concatenated text of every text node under `root`, in
  // document order, with no newline substitution for <br>/block
  // boundaries — deliberately not plainTextFromElement's flattening,
  // so a character index found in this string lines up exactly with
  // what splitFragmentAtOffset below walks.
  function flattenRawText(root) {
    let text = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) text += node.nodeValue;
    return text;
  }

  function nthTextNode(root, index) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    let i = 0;
    while ((node = walker.nextNode())) {
      if (i === index) return node;
      i++;
    }
    return null;
  }

  // Finds which text node (by index among root's text nodes, in
  // document order) and local offset within it a raw-text character
  // offset falls on.
  function locateTextOffset(root, offset) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    let consumed = 0;
    let index = 0;
    while ((node = walker.nextNode())) {
      const len = node.nodeValue.length;
      if (consumed + len >= offset) return { index, localOffset: offset - consumed };
      consumed += len;
      index++;
    }
    return null;
  }

  // Index of the 2nd whole-word "Dear" in text, or — with ignoreMiddle
  // on, since a 3-column paste's middle column has a "Dear" of its
  // own — the *last* whole-word "Dear" instead. Returns -1 if there
  // aren't enough occurrences to split on.
  function findDearSplitIndex(text, ignoreMiddle) {
    const dearRe = /\bDear\b/g;
    let match;
    let count = 0;
    let lastIndex = -1;
    while ((match = dearRe.exec(text))) {
      count += 1;
      lastIndex = match.index;
      if (!ignoreMiddle && count === 2) return match.index;
    }
    if (ignoreMiddle && count >= 2) return lastIndex;
    return -1;
  }

  // Splits a sanitized template fragment (text + <br> + <a>/<b>/<i>/<u>,
  // arbitrarily nested \u2014 the shape htmlToTemplateFragment produces)
  // into two DOM containers at a raw-text character offset, so a tag
  // that straddles the split point (a sentence in bold running across
  // the "Dear" boundary, say) still closes correctly on both sides.
  // Uses the same clone-and-Range.deleteContents() trick a browser's
  // own contenteditable relies on internally, just run on a detached
  // element instead of the live DOM.
  function splitFragmentAtOffset(fragment, offset) {
    const probe = document.createElement('div');
    probe.appendChild(document.importNode(fragment, true));
    const loc = locateTextOffset(probe, offset);

    const beforeContainer = document.createElement('div');
    beforeContainer.appendChild(document.importNode(fragment, true));
    const afterContainer = document.createElement('div');
    afterContainer.appendChild(document.importNode(fragment, true));
    if (!loc) return { beforeEl: beforeContainer, afterEl: afterContainer };

    const beforeNode = nthTextNode(beforeContainer, loc.index);
    const afterNode = nthTextNode(afterContainer, loc.index);

    const rangeBefore = document.createRange();
    rangeBefore.selectNodeContents(beforeContainer);
    rangeBefore.setStart(beforeNode, loc.localOffset);
    rangeBefore.deleteContents();

    const rangeAfter = document.createRange();
    rangeAfter.selectNodeContents(afterContainer);
    rangeAfter.setEnd(afterNode, loc.localOffset);
    rangeAfter.deleteContents();

    return { beforeEl: beforeContainer, afterEl: afterContainer };
  }

  // HTML-aware counterpart to parseQuickTemplateBlock: tries to split
  // pasted rich text into enquiry/reply DOM containers (each holding
  // sanitized text + <br> + <a>/<b>/<i>/<u>) with formatting intact.
  // Prefers an actual table's first two cells (the normal case \u2014
  // copied straight out of a Word/Excel row); falls back to the same
  // 2nd-"Dear" boundary the plain-text path uses, applied to the
  // fragment itself so the split lands on the right character.
  // Returns null if neither approach finds a usable split, so the
  // caller can fall back to the plain-text-only parse.
  function parseQuickTemplateHtml(html, ignoreMiddle) {
    const tableCells = firstTwoTableCells(html, ignoreMiddle);
    if (tableCells) {
      const enquiryEl = document.createElement('div');
      enquiryEl.appendChild(htmlToTemplateFragment(tableCells[0]));
      const replyEl = document.createElement('div');
      replyEl.appendChild(htmlToTemplateFragment(tableCells[1]));
      return { enquiryEl, replyEl };
    }

    const fragment = htmlToTemplateFragment(html);
    const splitIndex = findDearSplitIndex(flattenRawText(fragment), ignoreMiddle);
    if (splitIndex === -1) return null;

    const { beforeEl, afterEl } = splitFragmentAtOffset(fragment, splitIndex);
    return { enquiryEl: beforeEl, replyEl: afterEl };
  }

  function applyQuickTemplate(raw, html, ignoreMiddle) {
    const subId = state.selectedSubEnquiryId;
    const sub = subId ? state.subEnquiries[subId] : null;
    if (!sub) return { ok: false, message: 'Select a Sub-Enquiry in the Hierarchy first.' };

    let enquiryText = '';
    let templateText = '';
    let templateHtml = '';
    let templateLinks = [];

    const htmlParsed = html ? parseQuickTemplateHtml(html, ignoreMiddle) : null;
    if (htmlParsed) {
      enquiryText = plainTextFromElement(htmlParsed.enquiryEl).trim();
      templateText = plainTextFromElement(htmlParsed.replyEl).trim();
      if (enquiryText && templateText) {
        templateHtml = htmlParsed.replyEl.innerHTML;
        templateLinks = linksFromElement(htmlParsed.replyEl);
      }
    }

    if (!enquiryText || !templateText) {
      const parsed = parseQuickTemplateBlock(raw, ignoreMiddle);
      if (!parsed) {
        return {
          ok: false,
          message: 'Couldn\u2019t find a tab character or a 2nd \u201cDear\u201d to split the enquiry from the reply \u2014 paste the raw text copied straight from the table row.'
        };
      }
      enquiryText = parsed.enquiryText;
      templateText = parsed.templateText;
      templateHtml = '';
      templateLinks = [];
    }

    const templates = subTemplates(sub);
    let tpl = templates.find((t) => !t.template || !t.template.trim());
    const createdNew = !tpl;
    if (!tpl) {
      const untagged = templatesInFolder(templates, []);
      tpl = { id: uid('tpl'), name: uniqueTemplateName(untagged, 'Template ' + (untagged.length + 1)), template: '', templateHtml: '', templateLinks: [], keywords: [], labels: [] };
      templates.push(tpl);
    } else if (tpl.id === activeTemplateId) {
      // The empty slot is the one currently open in the editor — if it
      // already has unsaved draft text sitting in there, don't silently
      // clobber it.
      const currentDraft = editorPlainText().trim();
      if (currentDraft && !window.confirm('The template box already has unsaved text \u2014 overwrite it with the newly pasted reply?')) {
        return { ok: false, message: 'Cancelled \u2014 left the existing draft untouched.' };
      }
    }
    activeTemplateId = tpl.id;

    const keywords = extractKeywords(enquiryText);
    const mergedKw = (tpl.keywords || []).slice();
    keywords.forEach((kw) => { if (!mergedKw.includes(kw)) mergedKw.push(kw); });
    tpl.keywords = mergedKw;

    const recommended = recommendedLabels();
    if (recommended.length) {
      const mergedLabels = templateLabels(tpl).slice();
      recommended.forEach((l) => { if (!mergedLabels.includes(l)) mergedLabels.push(l); });
      renderLabelChips(mergedLabels, true);
    } else {
      renderLabelChips(templateLabels(tpl).slice(), true);
    }

    renderTemplateList(sub);
    renderTemplateIntoEditor({ template: templateText, templateHtml: templateHtml, templateLinks: templateLinks });
    updateTemplateStatus(sub, tpl);
    renderTemplateKeywords(sub, tpl);

    return {
      ok: true,
      message: 'Filled ' + tpl.name + (createdNew ? ' (new)' : '') + ' on ' + pathForSubEnquiry(subId) +
        ' \u2014 ' + keywords.length + ' keyword(s) extracted' +
        (recommended.length ? ', tagged ' + recommended.map((l) => '#' + l).join(' ') : '') +
        '. Review the template box, then click Save template.'
    };
  }

  // ---------- Template Labellers ----------
  // Every template can carry any number of free-text tags (a person's
  // name, a recurring term, etc.) — an extra axis of categorization
  // independent of the Scheme/Category/Enquiry/Sub-Enquiry hierarchy,
  // and independent of its siblings under the same Sub-Enquiry.
  // Persisted as tpl.labels (array), and rides along with the existing
  // PATH:/KEYWORDS:/TEMPLATE: import/export format via a LABEL: line
  // (comma-separated — see Section 8 below).
  //
  // Editing happens against a transient `pendingLabels` array — like
  // the Template textarea, changes only land on the active template
  // when "Save template" is clicked, so a half-typed tag or an
  // accidental removal can still be abandoned by switching templates
  // or Sub-Enquiries.

  let pendingLabels = [];

  // `hasTemplate` (defaults true) toggles the input itself — there's
  // nothing for a Name/Term tag to attach to until a template exists
  // to save it against.
  function renderLabelChips(labels, hasTemplate) {
    pendingLabels = labels;
    if (labelInput) {
      const enabled = hasTemplate !== false;
      labelInput.disabled = !enabled;
      labelInput.placeholder = enabled ? 'Type a tag, press Enter…' : 'Select or add a template first…';
    }
    if (!labelTagsEl) return;
    labelTagsEl.querySelectorAll('.draft-chip').forEach((el) => el.remove());
    pendingLabels.forEach((tag) => {
      const chip = document.createElement('span');
      chip.className = 'draft-chip';
      const label = document.createElement('span');
      label.textContent = tag;
      chip.appendChild(label);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'draft-chip__remove';
      remove.setAttribute('aria-label', 'Remove tag ' + tag);
      remove.textContent = '\u00D7';
      remove.addEventListener('click', () => {
        renderLabelChips(pendingLabels.filter((t) => t !== tag));
      });
      chip.appendChild(remove);
      labelTagsEl.insertBefore(chip, labelInput);
    });
  }

  function commitPendingLabelInput() {
    const raw = (labelInput.value || '').trim();
    labelInput.value = '';
    if (!raw) return;
    // A paste or fast typist may drop more than one tag in at once —
    // split on comma so "alice, bob" still becomes two tags.
    raw.split(',').map((t) => t.trim()).filter(Boolean).forEach((tag) => {
      if (!pendingLabels.includes(tag)) pendingLabels = pendingLabels.concat([tag]);
    });
    renderLabelChips(pendingLabels);
  }

  if (labelInput) {
    labelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        commitPendingLabelInput();
      } else if (e.key === 'Backspace' && !labelInput.value && pendingLabels.length) {
        renderLabelChips(pendingLabels.slice(0, -1));
      }
    });
    labelInput.addEventListener('blur', commitPendingLabelInput);
  }

  function allLabels() {
    const set = new Set();
    Object.values(state.subEnquiries).forEach((s) =>
      subTemplates(s).forEach((t) => templateLabels(t).forEach((l) => { if (l) set.add(l); })));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  // Bumps each of the given labels to the front of state.recentLabels
  // (most-recent-first, deduped) — called whenever a template's
  // labels are actually saved. Powers the Quick Template Adder's
  // "two most recently used" guess.
  function recordLabelUsage(labels) {
    if (!labels || !labels.length) return;
    state.recentLabels = state.recentLabels || [];
    labels.slice().reverse().forEach((label) => {
      if (!label) return;
      state.recentLabels = state.recentLabels.filter((l) => l !== label);
      state.recentLabels.unshift(label);
    });
    if (state.recentLabels.length > 50) state.recentLabels.length = 50;
  }

  // The two labels the Quick Template Adder should pre-fill: the most
  // recently saved ones if there's any history, otherwise the two used
  // on the most templates overall.
  function recommendedLabels() {
    const recent = (state.recentLabels || []).filter(Boolean);
    if (recent.length) return recent.slice(0, 2);
    const counts = {};
    Object.values(state.subEnquiries).forEach((s) =>
      subTemplates(s).forEach((t) => templateLabels(t).forEach((l) => { if (l) counts[l] = (counts[l] || 0) + 1; })));
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 2);
  }

  function refreshLabelDatalist() {
    if (!labelDatalist) return;
    labelDatalist.innerHTML = '';
    allLabels().forEach((label) => {
      const opt = document.createElement('option');
      opt.value = label;
      labelDatalist.appendChild(opt);
    });
  }

  // ---------- Template textarea: preserve pasted hyperlinks ----------
  // A plain <textarea> can only hold plain text, so a normal paste
  // takes the clipboard's text/plain representation. For a "rich"
  // link — display text that differs from its URL, e.g. copied from a
  // webpage or an email — that text/plain version is often just the
  // display text, with the actual destination silently dropped. When
  // the clipboard also carries text/html, we pull the href out of
  // every <a> ourselves and fold it into the inserted text as
  // "label (https://example.com)", so the destination survives.
  // Because the result is still plain text, it round-trips through
  // the existing save/export/import pipeline (.txt, .docx, batch
  // import/export, clipboard copy) with no changes needed there.
  // Word/Outlook doesn't describe a letter the way a browser would:
  //
  //  1. A plain visual line-wrap is very often its own
  //     <p class="MsoNormal" style="...mso-margin-top-alt:auto;...">
  //     rather than living inside one flowing paragraph — Word hides
  //     the seam with zero visible spacing, so it reads as one
  //     paragraph on screen right up until it's read back out as
  //     plain text, where every one of those becomes a real newline.
  //  2. A bulleted/numbered list isn't a real <ul>/<ol> — each item is
  //     a <p style="mso-list:l# level# lfo#"> whose bullet/number is a
  //     plain character in a leading <span style="mso-list:Ignore">,
  //     usually styled with font-family:Symbol or Wingdings so it
  //     renders as a bullet. Since we don't preserve font-family, that
  //     character survives but renders in whatever font is active
  //     instead — which is how a Word bullet turns into a random
  //     dingbat (a clock, a smiley, ...) instead of a bullet or number.
  //
  // Both need to run on the untouched parsed HTML, before anything
  // strips the mso- markers that identify them.
  function convertWordListParagraphs(root) {
    const paras = Array.from(root.querySelectorAll('p'));
    let i = 0;
    while (i < paras.length) {
      const style = paras[i].getAttribute('style') || '';
      const head = /mso-list\s*:\s*l(\S+)\s+level(\d+)/i.exec(style);
      if (!head) { i++; continue; }

      const listId = head[1];
      const run = [];
      let j = i;
      while (j < paras.length) {
        const s = paras[j].getAttribute('style') || '';
        const m = /mso-list\s*:\s*l(\S+)\s+level(\d+)/i.exec(s);
        if (!m || m[1] !== listId) break;
        run.push({ el: paras[j], level: parseInt(m[2], 10) || 1 });
        j++;
      }

      const holder = document.createElement('div');
      const stack = []; // { level, listEl }
      run.forEach(({ el, level }) => {
        const marker = el.querySelector('span[style*="mso-list"]');
        let markerText = '';
        if (marker) {
          markerText = marker.textContent.replace(/\s+/g, '');
          marker.remove();
        }
        const ordered = /^[0-9]+[.)]$|^[a-zA-Z][.)]$|^[ivxlcdm]+[.)]$/i.test(markerText);

        while (stack.length && stack[stack.length - 1].level > level) stack.pop();
        let top = stack[stack.length - 1];
        if (!top || top.level < level) {
          const listEl = document.createElement(ordered ? 'ol' : 'ul');
          if (top) {
            (top.listEl.lastElementChild || top.listEl).appendChild(listEl);
          } else {
            holder.appendChild(listEl);
          }
          stack.push({ level, listEl });
          top = stack[stack.length - 1];
        }

        const li = document.createElement('li');
        while (el.firstChild) li.appendChild(el.firstChild);
        top.listEl.appendChild(li);
      });

      if (holder.firstChild) run[0].el.replaceWith(holder.firstChild);
      else run[0].el.remove();
      run.slice(1).forEach(({ el }) => el.remove());
      i = j;
    }
  }

  function mergeWordLineWraps(root) {
    const isSoftParagraph = (el) => {
      if (!el || el.nodeType !== 1 || (el.tagName !== 'P' && el.tagName !== 'DIV')) return false;
      const style = el.getAttribute('style') || '';
      const cls = el.getAttribute('class') || '';
      return /mso-margin-(top|bottom)-alt/i.test(style) || /\bMsoNormal\b/i.test(cls);
    };

    function mergeRun(container) {
      const kids = Array.from(container.childNodes);
      let i = 0;
      while (i < kids.length) {
        if (!isSoftParagraph(kids[i])) { i++; continue; }
        const run = [kids[i]];
        let j = i + 1;
        while (j < kids.length) {
          if (isSoftParagraph(kids[j])) { run.push(kids[j]); j++; }
          else if (kids[j].nodeType === 3 && !kids[j].textContent.trim()) { j++; }
          else break;
        }
        if (run.length > 1) {
          const merged = document.createElement('p');
          run.forEach((p) => {
            const text = p.textContent.replace(/\u00a0/g, ' ').trim();
            if (!text) {
              if (merged.lastChild) merged.appendChild(document.createElement('br'));
              merged.appendChild(document.createElement('br'));
              return;
            }
            const prevIsBr = merged.lastChild && merged.lastChild.nodeType === 1 && merged.lastChild.tagName === 'BR';
            if (merged.childNodes.length && !prevIsBr) merged.appendChild(document.createTextNode(' '));
            while (p.firstChild) merged.appendChild(p.firstChild);
          });
          run[0].replaceWith(merged);
          run.slice(1).forEach((p) => p.remove());
        }
        i = j;
      }
    }

    mergeRun(root);
    Array.from(root.querySelectorAll('p, div')).forEach(mergeRun);

    Array.from(root.querySelectorAll('br')).forEach((br) => {
      const prev = br.previousSibling;
      const next = br.nextSibling;
      const prevIsBr = prev && prev.nodeType === 1 && prev.tagName === 'BR';
      const nextIsBr = next && next.nodeType === 1 && next.tagName === 'BR';
      if (!prevIsBr && !nextIsBr) br.replaceWith(' ');
    });
  }

  function normalizeWordPasteArtifacts(root) {
    convertWordListParagraphs(root);
    mergeWordLineWraps(root);
  }

  // See collapseInsignificantWhitespace in mountain.js for why this is
  // needed: Word's pretty-printed HTML often carries stray
  // newlines/tabs inside text nodes that a browser would normally
  // collapse away when rendering, but textContent doesn't.
  function collapseInsignificantWhitespace(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      node.nodeValue = node.nodeValue.replace(/[ \t\n\r\u00a0]+/g, ' ');
    }
  }

  // Pretty-printed source HTML (Word above all) puts a newline/indent
  // right after an opening block tag and right before its closing tag.
  // collapseInsignificantWhitespace above turns that into a single
  // literal space, but only a browser's own layout would then discard
  // a leading/trailing space at a block edge — our DOM text nodes keep
  // it. Left in place, that stray space survives past the block's own
  // </p> and lands right after the <br> we insert for it, i.e. as a
  // one-space gap before the first word of the next paragraph. Trim it
  // here, at the block level, before markers/<br>s are added.
  function trimBlockEdgeWhitespace(root, blockSelector) {
    Array.from(root.querySelectorAll(blockSelector)).forEach((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      let firstText = null;
      while ((node = walker.nextNode())) {
        if (node.nodeValue !== '') { firstText = node; break; }
      }
      if (firstText) firstText.nodeValue = firstText.nodeValue.replace(/^ +/, '');

      const walker2 = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let lastText = null;
      while ((node = walker2.nextNode())) {
        if (node.nodeValue !== '') lastText = node;
      }
      if (lastText) lastText.nodeValue = lastText.nodeValue.replace(/ +$/, '');
    });
  }

  // Runs after every block has been unwrapped down to flat text/<a>/<br>
  // content. Trimming/normalizing earlier can leave behind zero-length
  // text nodes (e.g. a blank-line paragraph whose only content was
  // whitespace, once that whitespace is trimmed away). An empty node
  // sitting between a <br> and the next real text would otherwise hide
  // that text from the "am I right after a line break" check below, so
  // clear those out first — the <br>s themselves are left exactly as
  // they were, one per source paragraph break, so a blank line in the
  // pasted source stays a blank line here.
  function removeEmptyTextNodes(root) {
    Array.from(root.childNodes).forEach((n) => {
      if (n.nodeType === 3 && n.nodeValue === '') n.remove();
    });
  }

  // Trims the space that's still left sitting right at a line boundary
  // once the content is flat — the first word after any <br> (not just
  // after a whole paragraph) and the last word right before one.
  function trimAroundBreaksFlat(root) {
    Array.from(root.childNodes).forEach((node) => {
      if (node.nodeType !== 3) return;
      const prev = node.previousSibling;
      const next = node.nextSibling;
      if (!prev || (prev.nodeType === 1 && prev.tagName === 'BR')) {
        node.nodeValue = node.nodeValue.replace(/^ +/, '');
      }
      if (!next || (next.nodeType === 1 && next.tagName === 'BR')) {
        node.nodeValue = node.nodeValue.replace(/ +$/, '');
      }
    });
  }

  // ---------- Template editor: hyperlinks stay live ----------
  // draft-template-input is a contenteditable div (not a textarea) so
  // that a pasted hyperlink — or one added with "Insert link" — can
  // render as real, clickable link text ("cpf.gov.sg") rather than the
  // old bracketed "cpf.gov.sg (www.cpf.gov.sg)" form. The full URL
  // never disappears: it's read straight off each <a href> at Save
  // time into sub.templateLinks, which is what Deep thinking search's
  // "All hyperlinks" list and the import/export LINKS: lines use.

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Turns stored plain text + a links list back into editor HTML,
  // wrapping every occurrence of each link's display text in a real
  // <a>. Longest texts are matched first so one link's text can't
  // eat into a longer, overlapping one.
  const NO_FORMAT = { bold: false, italic: false, underline: false };

  // Legacy fallback: reconstructs segments from plain text + a flat
  // links list (the pre-formatting storage shape). Never carries
  // bold/italic/underline since that data never existed for these —
  // used only for Sub-Enquiries saved before rich formatting shipped.
  function templateSegmentsFor(text, links) {
    if (!links || links.length === 0) return [Object.assign({ type: 'text', value: text }, NO_FORMAT)];
    const textToUrl = new Map();
    links.forEach((l) => { if (l.text && !textToUrl.has(l.text)) textToUrl.set(l.text, l.url); });
    const uniqueTexts = Array.from(textToUrl.keys()).sort((a, b) => b.length - a.length);
    if (uniqueTexts.length === 0) return [Object.assign({ type: 'text', value: text }, NO_FORMAT)];
    const pattern = new RegExp(uniqueTexts.map(escapeRegExp).join('|'), 'g');
    const segments = [];
    let lastIndex = 0;
    let m;
    while ((m = pattern.exec(text))) {
      if (m.index > lastIndex) segments.push(Object.assign({ type: 'text', value: text.slice(lastIndex, m.index) }, NO_FORMAT));
      segments.push(Object.assign({ type: 'link', text: m[0], url: textToUrl.get(m[0]) }, NO_FORMAT));
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < text.length) segments.push(Object.assign({ type: 'text', value: text.slice(lastIndex) }, NO_FORMAT));
    return segments;
  }

  // Walks sanitized template HTML (text + <br> + <a> + <b> + <i> + <u>,
  // arbitrarily nested) into a flat list of segments, each carrying
  // which of bold/italic/underline apply to it. This is the canonical
  // path once a Sub-Enquiry has been saved with rich formatting.
  function htmlToSegments(html) {
    if (!html) return [];
    const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
    const root = doc.body.firstChild;
    const segments = [];
    (function walk(node, fmt) {
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === 3) {
          if (child.textContent) segments.push(Object.assign({ type: 'text', value: child.textContent }, fmt));
          return;
        }
        if (child.nodeType !== 1) return;
        const tag = child.tagName;
        if (tag === 'BR') { segments.push(Object.assign({ type: 'text', value: '\n' }, NO_FORMAT)); return; }
        if (tag === 'A') {
          segments.push(Object.assign({ type: 'link', text: child.textContent, url: child.getAttribute('href') || '' }, fmt));
          return;
        }
        const nextFmt = {
          bold: fmt.bold || tag === 'B',
          italic: fmt.italic || tag === 'I',
          underline: fmt.underline || tag === 'U'
        };
        walk(child, nextFmt);
      });
    }(root, NO_FORMAT));
    return segments;
  }

  // Canonical segment list for a single template: uses the stored rich
  // HTML when present, otherwise falls back to reconstructing plain
  // segments from the legacy text+links shape. `tpl` is one entry from
  // subTemplates(sub), i.e. { template, templateHtml, templateLinks }.
  function templateSegments(tpl) {
    if (tpl && tpl.templateHtml) return htmlToSegments(tpl.templateHtml);
    return templateSegmentsFor((tpl && tpl.template) || '', (tpl && tpl.templateLinks) || []);
  }

  function templateToHtml(tpl) {
    const segments = templateSegments(tpl);
    return segments.map((seg) => {
      let inner = seg.type === 'link'
        ? '<a href="' + escapeHtmlLocal(seg.url) + '" target="_blank" rel="noopener">' + escapeHtmlLocal(seg.text) + '</a>'
        : escapeHtmlLocal(seg.value).replace(/\n/g, '<br>');
      if (seg.bold) inner = '<b>' + inner + '</b>';
      if (seg.italic) inner = '<i>' + inner + '</i>';
      if (seg.underline) inner = '<u>' + inner + '</u>';
      return inner;
    }).join('');
  }

  // Clipboard-only variant of templateToHtml. The editor's own model
  // (and templateToHtml above) is deliberately flat — every line,
  // bulleted or not, is inline text separated by <br> (see
  // wireRichTextEditing's comment on why). That's fine for rendering
  // inside this editor and for pasting into Mountain, which parses
  // this app's own flat model correctly. But a run of <br>-only lines
  // with no paragraph boundary reads as ONE paragraph to Word — so a
  // copied bullet list lands in Word as a single bullet holding every
  // line's text, instead of one bullet per line, because Word's
  // list-autoformat only fires per-paragraph. Wrapping each line in
  // its own <div> for the clipboard gives Word (and anything else) a
  // real paragraph break to key off, while still rendering identically
  // everywhere the flat version already worked. Only used at copy
  // time — never fed back into the editor or into storage.
  function templateToClipboardHtml(tpl) {
    const segments = templateSegments(tpl);
    const lines = [[]];
    segments.forEach((seg) => {
      if (seg.type === 'text' && seg.value === '\n') { lines.push([]); return; }
      lines[lines.length - 1].push(seg);
    });
    return lines.map((lineSegs) => {
      if (lineSegs.length === 0) return '<div><br></div>';
      const inner = lineSegs.map((seg) => {
        let segHtml = seg.type === 'link'
          ? '<a href="' + escapeHtmlLocal(seg.url) + '" target="_blank" rel="noopener">' + escapeHtmlLocal(seg.text) + '</a>'
          : escapeHtmlLocal(seg.value).replace(/\n/g, '<br>');
        if (seg.bold) segHtml = '<b>' + segHtml + '</b>';
        if (seg.italic) segHtml = '<i>' + segHtml + '</i>';
        if (seg.underline) segHtml = '<u>' + segHtml + '</u>';
        return segHtml;
      }).join('');
      return '<div>' + inner + '</div>';
    }).join('');
  }

  function renderTemplateIntoEditor(tpl) {
    templateInput.innerHTML = tpl ? (tpl.templateHtml ? tpl.templateHtml : (tpl.template ? templateToHtml(tpl) : '')) : '';
  }

  // Editor -> plain text, preserving line breaks the same way the
  // rest of the app already does (br -> \n, block-level -> \n).
  function plainTextFromElement(el) {
    const clone = el.cloneNode(true);
    Array.from(clone.querySelectorAll('br')).forEach((br) => br.replaceWith('\n'));
    Array.from(clone.querySelectorAll('div, p')).forEach((elx) => elx.insertAdjacentText('afterend', '\n'));
    return (clone.textContent || '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+|\n+$/g, '');
  }
  function editorPlainText() { return plainTextFromElement(templateInput); }

  // Editor -> the hyperlinks currently live inside it, in document
  // order, deduped by (text, url) pair.
  function linksFromElement(el) {
    const seen = new Set();
    const links = [];
    Array.from(el.querySelectorAll('a[href]')).forEach((a) => {
      const text = (a.textContent || '').trim();
      const url = (a.getAttribute('href') || '').trim();
      if (!text || !url) return;
      const key = text + '\u0001' + url;
      if (seen.has(key)) return;
      seen.add(key);
      links.push({ text, url });
    });
    return links;
  }
  function editorLinks() { return linksFromElement(templateInput); }

  function insertNodeInto(el, node) {
    el.focus();
    const sel = window.getSelection();
    let range;
    if (sel && sel.rangeCount && el.contains(sel.anchorNode)) {
      range = sel.getRangeAt(0);
      range.deleteContents();
    } else {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    // A DocumentFragment empties itself into the document the moment
    // it's inserted, so `node` itself is unusable as a cursor anchor
    // afterwards — grab its last child first and anchor on that
    // instead. A plain element (e.g. the Insert Link <a>) stays valid.
    const isFragment = node.nodeType === 11;
    const anchor = isFragment ? node.lastChild : node;
    range.insertNode(node);
    if (anchor && anchor.parentNode) {
      range.setStartAfter(anchor);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
  function insertNodeAtCursor(node) { insertNodeInto(templateInput, node); }

  // Sanitizes pasted HTML down to just text + <a href> + <br>,
  // reusing the same Word paste-artifact cleanup as everywhere else
  // in the app, but — unlike the old htmlAnchorsToPlainText — keeps
  // anchors as real elements instead of collapsing them to bracketed
  // text, so the pasted hyperlink stays genuinely clickable.
  // Renames an element in place (e.g. <strong> -> <b>), keeping its
  // children and position, and returns the replacement element so
  // callers can keep operating on it.
  function renameElement(el, tagName) {
    if (el.tagName.toLowerCase() === tagName) return el;
    const repl = el.ownerDocument.createElement(tagName);
    while (el.firstChild) repl.appendChild(el.firstChild);
    el.replaceWith(repl);
    return repl;
  }

  // Word/Outlook's clipboard HTML always carries one of these markers.
  // Gating normalizeWordPasteArtifacts on it means its "a lone <br> is
  // really just a Word line-wrap" cleanup only touches genuine Word
  // paste. Without this, pasting *any* content that legitimately uses
  // one <br> per line — including a template copied out of this very
  // editor, or out of Mountain — had every line break collapsed into a
  // single space, which is what was causing lines to run together.
  const WORD_HTML_SIGNATURE = /mso-|urn:schemas-microsoft-com:office|\bMsoNormal\b/i;

  function htmlToTemplateFragment(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const blockSelector = 'p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote';
    if (WORD_HTML_SIGNATURE.test(html)) normalizeWordPasteArtifacts(doc.body);
    collapseInsignificantWhitespace(doc.body);
    trimBlockEdgeWhitespace(doc.body, blockSelector);

    // Bold/italic come in under a few different tag names depending on
    // the source (Word, Google Docs, browser default) — normalize all
    // of them down to <b>/<i> so storage and rendering only ever deal
    // with one canonical tag per style. <u> already only has one name.
    Array.from(doc.body.querySelectorAll('strong, b')).forEach((el) => renameElement(el, 'b'));
    Array.from(doc.body.querySelectorAll('em, i')).forEach((el) => renameElement(el, 'i'));

    Array.from(doc.body.querySelectorAll('a[href]')).forEach((a) => {
      const href = (a.getAttribute('href') || '').trim();
      const label = a.textContent.trim();
      if (!href || !label) { a.replaceWith(document.createTextNode(label)); return; }
      const clean = document.createElement('a');
      clean.setAttribute('href', href);
      clean.setAttribute('target', '_blank');
      clean.setAttribute('rel', 'noopener');
      clean.textContent = label;
      a.replaceWith(clean);
    });

    Array.from(doc.body.querySelectorAll('li')).forEach((li) => {
      const ordered = li.parentElement && li.parentElement.tagName === 'OL';
      let marker = '\u2022 ';
      if (ordered) {
        const siblings = Array.from(li.parentElement.children).filter((c) => c.tagName === 'LI');
        marker = (siblings.indexOf(li) + 1) + '. ';
      }
      li.insertBefore(document.createTextNode(marker), li.firstChild);
    });

    Array.from(doc.body.querySelectorAll(blockSelector)).forEach((el) => {
      el.insertAdjacentHTML('afterend', '<br>');
    });

    // Unwrap everything that isn't A, BR, B, I, or U, keeping their
    // contents (which may include real anchors or nested formatting)
    // in place.
    const KEEP_TAGS = new Set(['A', 'BR', 'B', 'I', 'U']);
    (function unwrap(node) {
      Array.from(node.children).forEach((child) => {
        unwrap(child);
        if (!KEEP_TAGS.has(child.tagName)) {
          while (child.firstChild) child.parentNode.insertBefore(child.firstChild, child);
          child.remove();
        }
      });
    }(doc.body));

    removeEmptyTextNodes(doc.body);
    trimAroundBreaksFlat(doc.body);

    const frag = document.createDocumentFragment();
    Array.from(doc.body.childNodes).forEach((n) => frag.appendChild(n.cloneNode(true)));
    return frag;
  }

  // Sanitizes the editor's current live content down to the same
  // whitelist as pasted content (text + <br> + <a href> + <b> + <i> +
  // <u>, arbitrarily nested) before it's stored. Typed/execCommand
  // formatting and our own paste handler should already produce only
  // these tags, but this is a defensive pass so nothing stray (e.g. a
  // browser inserting a <div> for a line, or a <span style="...">)
  // ever reaches storage.
  function sanitizeElementHtml(el) {
    const clone = el.cloneNode(true);
    (function clean(node) {
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === 3) return;
        if (child.nodeType !== 1) { child.remove(); return; }
        let tag = child.tagName;
        if (tag === 'BR') return;
        if (tag === 'A') {
          const href = (child.getAttribute('href') || '').trim();
          Array.from(child.attributes).forEach((attr) => child.removeAttribute(attr.name));
          if (href) {
            child.setAttribute('href', href);
            child.setAttribute('target', '_blank');
            child.setAttribute('rel', 'noopener');
            clean(child);
          } else {
            // No href survived cleanup — keep the text, drop the tag.
            while (child.firstChild) child.parentNode.insertBefore(child.firstChild, child);
            child.remove();
          }
          return;
        }
        if (tag === 'STRONG') child = renameElement(child, 'b');
        else if (tag === 'EM') child = renameElement(child, 'i');
        if (child.tagName === 'B' || child.tagName === 'I' || child.tagName === 'U') {
          Array.from(child.attributes).forEach((attr) => child.removeAttribute(attr.name));
          clean(child);
          return;
        }
        // Anything else (DIV/SPAN/font styling/etc.) — unwrap, keep contents.
        clean(child);
        while (child.firstChild) child.parentNode.insertBefore(child.firstChild, child);
        child.remove();
      });
    }(clone));
    return clone.innerHTML;
  }
  function sanitizeEditorHtml() { return sanitizeElementHtml(templateInput); }

  // Same whitelist cleanup as sanitizeEditorHtml, but for an arbitrary
  // HTML string (e.g. a FORMAT: line coming from an imported file) —
  // used so imported HTML can't smuggle in anything beyond
  // text/<br>/<a href>/<b>/<i>/<u>.
  function sanitizeHtmlString(html) {
    if (!html) return '';
    const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
    const root = doc.body.firstChild;
    (function clean(node) {
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === 3) return;
        if (child.nodeType !== 1) { child.remove(); return; }
        let tag = child.tagName;
        if (tag === 'BR') return;
        if (tag === 'A') {
          const href = (child.getAttribute('href') || '').trim();
          Array.from(child.attributes).forEach((attr) => child.removeAttribute(attr.name));
          if (href) {
            child.setAttribute('href', href);
            child.setAttribute('target', '_blank');
            child.setAttribute('rel', 'noopener');
            clean(child);
          } else {
            while (child.firstChild) child.parentNode.insertBefore(child.firstChild, child);
            child.remove();
          }
          return;
        }
        if (tag === 'STRONG') child = renameElement(child, 'b');
        else if (tag === 'EM') child = renameElement(child, 'i');
        if (child.tagName === 'B' || child.tagName === 'I' || child.tagName === 'U') {
          Array.from(child.attributes).forEach((attr) => child.removeAttribute(attr.name));
          clean(child);
          return;
        }
        clean(child);
        while (child.firstChild) child.parentNode.insertBefore(child.firstChild, child);
        child.remove();
      });
    }(root));
    return root.innerHTML;
  }

  if (templateBoldBtn) templateBoldBtn.addEventListener('click', () => { templateInput.focus(); document.execCommand('bold'); });
  if (templateItalicBtn) templateItalicBtn.addEventListener('click', () => { templateInput.focus(); document.execCommand('italic'); });
  if (templateUnderlineBtn) templateUnderlineBtn.addEventListener('click', () => { templateInput.focus(); document.execCommand('underline'); });

  // Attaches the same paste-cleanup + Ctrl+B/I/U + Enter\u2192<br> handling
  // used by the main Tag view template editor to any contenteditable
  // element — used for the main templateInput and for the inline
  // per-card editors in the Find & Search results list.
  function wireRichTextEditing(el) {
    el.addEventListener('paste', (e) => {
      const cd = e.clipboardData || window.clipboardData;
      if (!cd) return;
      const html = cd.getData('text/html');
      if (!html) return; // fall through to default plain-text paste
      e.preventDefault();
      const frag = htmlToTemplateFragment(html);
      insertNodeInto(el, frag);
    });

    // The rest of the editor treats content as flat text + <a> + <br> (see
    // editorPlainText/editorLinks above and htmlToTemplateFragment). Left
    // to the browser's own Enter handling, a new line can come in wrapped
    // in a <div> or <p> instead — which one varies by browser — and that
    // element carries its own default margin, so it renders with a taller
    // gap than the single <br> lines from a paste use, and backspacing
    // across the boundary between the two models behaves inconsistently.
    // Inserting a plain <br> ourselves keeps every line, typed or pasted,
    // on the same model.
    el.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault(); document.execCommand('bold'); return;
      }
      if (mod && !e.shiftKey && !e.altKey && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault(); document.execCommand('italic'); return;
      }
      if (mod && !e.shiftKey && !e.altKey && (e.key === 'u' || e.key === 'U')) {
        e.preventDefault(); document.execCommand('underline'); return;
      }
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      insertNodeInto(el, document.createElement('br'));
    });
  }
  wireRichTextEditing(templateInput);

  if (templateLinkBtn) {
    templateLinkBtn.addEventListener('click', () => {
      const sel = window.getSelection();
      const selectedText = (sel && sel.rangeCount && templateInput.contains(sel.anchorNode))
        ? sel.toString() : '';
      const url = window.prompt('Link URL:');
      if (!url || !url.trim()) return;
      const label = window.prompt('Link text (leave blank to show the URL itself):', selectedText || '');
      const trimmedUrl = url.trim();
      const trimmedLabel = (label || '').trim() || trimmedUrl;
      const a = document.createElement('a');
      a.setAttribute('href', trimmedUrl);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
      a.textContent = trimmedLabel;
      insertNodeAtCursor(a);
    });
  }

  // ---------- Expanded template editor ----------
  // The template box above is a rich-text contenteditable, and its
  // caret/selection handling for typing, Backspace, and arrow-key
  // navigation is entirely native browser behaviour — this app never
  // intercepts those keys (only Enter and Ctrl+B/I/U, see
  // wireRichTextEditing above). A bigger contenteditable box still
  // runs on the same browser caret engine, so it inherits the exact
  // same bugs — bigger isn't different. A plain <textarea> is a
  // genuinely different, much simpler native text model with none of
  // contenteditable's caret/Range complexity, so this modal uses one
  // for real reliability rather than just more room.
  //
  // Formatting/links have to travel through that plain text somehow,
  // so they're shown as literal bracket markers — ⟦B⟧/⟦/B⟧,
  // ⟦I⟧/⟦/I⟧, ⟦U⟧/⟦/U⟧, ⟦L:url⟧/⟦/L⟧ — using ⟦ ⟧ (U+27E6/27E7)
  // specifically because they're nothing anyone would ever type in
  // normal correspondence, so round-tripping through them is
  // unambiguous. The toolbar buttons below wrap the current selection
  // in the right markers using textarea.selectionStart/End (a plain,
  // reliable API — no contenteditable Range involved), so most people
  // never have to type the markers by hand. Changes only land back in
  // the template box (still unsaved until "Save template") when Apply
  // is clicked; Cancel/close discards them.
  const templateExpandModal = document.getElementById('draft-template-expand-modal');
  const templateExpandInput = document.getElementById('draft-template-expand-input');
  const templateExpandApplyBtn = document.getElementById('draft-template-expand-apply-btn');
  const templateExpandBoldBtn = document.getElementById('draft-template-expand-bold-btn');
  const templateExpandItalicBtn = document.getElementById('draft-template-expand-italic-btn');
  const templateExpandUnderlineBtn = document.getElementById('draft-template-expand-underline-btn');
  const templateExpandLinkBtn = document.getElementById('draft-template-expand-link-btn');

  // HTML (from templateInput.innerHTML) -> marker plain text.
  // Reuses htmlToSegments (already the canonical HTML -> flat
  // segments walk used elsewhere in this file) so this stays in sync
  // with however the main editor's model evolves.
  if (templateExpandModal && templateExpandInput) {

    function segmentsToMarkupText(segments) {
      return segments.map((seg) => {
        let core = seg.type === 'link'
          ? '\u27e6L:' + seg.url + '\u27e7' + seg.text + '\u27e6/L\u27e7'
          : seg.value;
        if (seg.bold) core = '\u27e6B\u27e7' + core + '\u27e6/B\u27e7';
        if (seg.italic) core = '\u27e6I\u27e7' + core + '\u27e6/I\u27e7';
        if (seg.underline) core = '\u27e6U\u27e7' + core + '\u27e6/U\u27e7';
        return core;
      }).join('');
    }

    // Marker plain text -> a { type, ... }[] node tree (text / wrap /
    // link nodes, wrap/link nodes carrying their own children so B
    // inside a link or a link inside B both round-trip). Malformed or
    // stray markers (an unmatched ⟦B⟧ with no closing tag, say) fall
    // back to being kept as literal text rather than silently
    // dropping content — a broken marker is recoverable by the user
    // seeing it in the text; silently eaten text is not.
    function parseMarkupText(text) {
      let i = 0;
      const n = text.length;
      function parseUntil(closeTag) {
        const nodes = [];
        let buf = '';
        const flush = () => { if (buf) { nodes.push({ type: 'text', value: buf }); buf = ''; } };
        while (i < n) {
          if (text[i] === '\u27e6') {
            const closeIdx = text.indexOf('\u27e7', i);
            if (closeIdx === -1) { buf += text[i]; i += 1; continue; }
            const tagContent = text.slice(i + 1, closeIdx);
            if (tagContent.charAt(0) === '/') {
              const tagName = tagContent.slice(1);
              if (closeTag && tagName === closeTag) {
                flush();
                i = closeIdx + 1;
                return nodes;
              }
              // Closing tag with no matching open in this scope — treat literally.
              buf += text.slice(i, closeIdx + 1);
              i = closeIdx + 1;
              continue;
            }
            if (tagContent === 'B' || tagContent === 'I' || tagContent === 'U') {
              flush();
              i = closeIdx + 1;
              nodes.push({ type: 'wrap', tag: tagContent, children: parseUntil(tagContent) });
              continue;
            }
            if (tagContent.slice(0, 2) === 'L:') {
              flush();
              const url = tagContent.slice(2);
              i = closeIdx + 1;
              nodes.push({ type: 'link', url, children: parseUntil('L') });
              continue;
            }
            // Unrecognized marker — treat literally.
            buf += text.slice(i, closeIdx + 1);
            i = closeIdx + 1;
            continue;
          }
          buf += text[i];
          i += 1;
        }
        flush();
        return nodes;
      }
      return parseUntil(null);
    }

    function appendMarkupNodes(el, nodes) {
      nodes.forEach((node) => {
        if (node.type === 'text') {
          const lines = node.value.split('\n');
          lines.forEach((line, idx) => {
            if (line) el.appendChild(document.createTextNode(line));
            if (idx < lines.length - 1) el.appendChild(document.createElement('br'));
          });
        } else if (node.type === 'wrap') {
          const wrapEl = document.createElement(node.tag.toLowerCase());
          appendMarkupNodes(wrapEl, node.children);
          el.appendChild(wrapEl);
        } else if (node.type === 'link') {
          const a = document.createElement('a');
          a.setAttribute('href', node.url);
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener');
          // Link text is flat in this app's model (see htmlToSegments)
          // — plain-text the children rather than nesting further tags.
          a.textContent = node.children.map((c) => (c.type === 'text' ? c.value : (c.text || ''))).join('');
          el.appendChild(a);
        }
      });
    }

    function markupTextToHtml(text) {
      const nodes = parseMarkupText(text);
      const container = document.createElement('div');
      appendMarkupNodes(container, nodes);
      return container.innerHTML;
    }

    // Wraps (or, with nothing selected, inserts a placeholder inside)
    // the current textarea selection in marker tags — plain
    // setRangeText-based string editing, not a DOM Range, so it can't
    // hit any contenteditable caret bug.
    function wrapSelection(openTag, closeTag, placeholder) {
      const start = templateExpandInput.selectionStart;
      const end = templateExpandInput.selectionEnd;
      const value = templateExpandInput.value;
      const selected = value.slice(start, end) || placeholder;
      const replacement = openTag + selected + closeTag;
      templateExpandInput.setRangeText(replacement, start, end, 'select');
      templateExpandInput.focus();
      // Select just the inner text (not the markers) so typing over a
      // placeholder or existing selection replaces the right thing.
      templateExpandInput.setSelectionRange(start + openTag.length, start + openTag.length + selected.length);
    }

    if (templateExpandBoldBtn) templateExpandBoldBtn.addEventListener('click', () => wrapSelection('\u27e6B\u27e7', '\u27e6/B\u27e7', 'bold text'));
    if (templateExpandItalicBtn) templateExpandItalicBtn.addEventListener('click', () => wrapSelection('\u27e6I\u27e7', '\u27e6/I\u27e7', 'italic text'));
    if (templateExpandUnderlineBtn) templateExpandUnderlineBtn.addEventListener('click', () => wrapSelection('\u27e6U\u27e7', '\u27e6/U\u27e7', 'underlined text'));
    if (templateExpandLinkBtn) {
      templateExpandLinkBtn.addEventListener('click', () => {
        const start = templateExpandInput.selectionStart;
        const end = templateExpandInput.selectionEnd;
        const selected = templateExpandInput.value.slice(start, end);
        const url = window.prompt('Link URL:');
        if (!url || !url.trim()) return;
        const trimmedUrl = url.trim();
        const label = window.prompt('Link text (leave blank to show the URL itself):', selected || '');
        const trimmedLabel = (label || '').trim() || trimmedUrl;
        const replacement = '\u27e6L:' + trimmedUrl + '\u27e7' + trimmedLabel + '\u27e6/L\u27e7';
        templateExpandInput.setRangeText(replacement, start, end, 'end');
        templateExpandInput.focus();
      });
    }

    function openTemplateExpandModal() {
      templateExpandInput.value = segmentsToMarkupText(htmlToSegments(templateInput.innerHTML));
      templateExpandModal.hidden = false;
      templateExpandModal.setAttribute('aria-hidden', 'false');
      templateExpandInput.focus();
    }

    function closeTemplateExpandModal() {
      templateExpandModal.hidden = true;
      templateExpandModal.setAttribute('aria-hidden', 'true');
    }

    function applyTemplateExpandModal() {
      templateInput.innerHTML = markupTextToHtml(templateExpandInput.value);
      closeTemplateExpandModal();
    }

    if (templateExpandBtn) templateExpandBtn.addEventListener('click', openTemplateExpandModal);
    if (templateExpandApplyBtn) templateExpandApplyBtn.addEventListener('click', applyTemplateExpandModal);
    templateExpandModal.querySelectorAll('[data-template-expand-close]').forEach((el) => {
      el.addEventListener('click', closeTemplateExpandModal);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !templateExpandModal.hidden) closeTemplateExpandModal();
    });
  }

  templateSaveBtn.addEventListener('click', () => {
    const subId = state.selectedSubEnquiryId;
    if (!subId) return;
    const sub = state.subEnquiries[subId];
    const templates = subTemplates(sub);
    let tpl = findTemplateById(sub, activeTemplateId);
    if (!tpl) {
      // Nothing selected yet (fresh Sub-Enquiry) — Save creates the
      // first template slot rather than silently doing nothing. It
      // starts untagged (nothing to tag it with yet), so it's numbered
      // within the untagged folder.
      const untagged = templatesInFolder(templates, []);
      tpl = { id: uid('tpl'), name: uniqueTemplateName(untagged, 'Template ' + (untagged.length + 1)), template: '', templateHtml: '', templateLinks: [], keywords: [], labels: [] };
      templates.push(tpl);
      activeTemplateId = tpl.id;
    }
    tpl.template = editorPlainText();
    tpl.templateLinks = editorLinks();
    tpl.templateHtml = sanitizeEditorHtml();
    commitPendingLabelInput();
    tpl.labels = pendingLabels.slice();
    recordLabelUsage(tpl.labels);
    // Tags may have just changed, moving this template into a
    // different folder — keep its name unique within that folder,
    // but only if it's actually now colliding with a sibling there.
    resolveTemplateNameCollision(templates, tpl);
    renderTemplateList(sub);
    renderTemplateKeywords(sub, tpl);
    templateStatus.textContent = 'Saved \u2014 linked to ' + sub.name +
      (tpl.labels.length ? ' \u2014 tagged ' + tpl.labels.map((l) => '#' + l).join(' ') + '.' : '.');
    templateStatus.classList.add('is-saved');
    renderTree(); // badge counts etc. stay in sync
    refreshLabelDatalist();
    refreshFindLabelSelect();
    buildDeepIndex(); // keeps "All hyperlinks" and the keyword index in sync
    showToast('Template saved for ' + sub.name);
  });

  templateClearBtn.addEventListener('click', () => {
    const subId = state.selectedSubEnquiryId;
    if (!subId) return;
    const sub = state.subEnquiries[subId];
    const tpl = findTemplateById(sub, activeTemplateId);
    if (!tpl) return;
    deleteTemplate(sub, tpl);
  });

  // ============================================================
  // 6. Template Finder
  // ============================================================

  function fillFindSelect(select, items, placeholder) {
    const prevValue = select.value;
    select.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = placeholder;
    select.appendChild(allOpt);
    items.forEach(({ id, name }) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = name;
      select.appendChild(opt);
    });
    if (items.some((i) => i.id === prevValue)) select.value = prevValue;
  }

  function refreshFindSchemeSelect() {
    fillFindSelect(
      findSchemeSel,
      state.schemeIds.map((id) => ({ id, name: state.schemes[id].name })),
      'All schemes'
    );
  }

  function refreshFindCategorySelect() {
    const schemeId = findSchemeSel.value;
    if (!schemeId) {
      findCategorySel.innerHTML = '';
      findCategorySel.disabled = true;
      return;
    }
    const scheme = state.schemes[schemeId];
    fillFindSelect(
      findCategorySel,
      scheme.categoryIds.map((id) => ({ id, name: state.categories[id].name })),
      'All categories'
    );
    findCategorySel.disabled = false;
  }

  function refreshFindEnquirySelect() {
    const categoryId = findCategorySel.value;
    if (!categoryId) {
      findEnquirySel.innerHTML = '';
      findEnquirySel.disabled = true;
      return;
    }
    const cat = state.categories[categoryId];
    fillFindSelect(
      findEnquirySel,
      cat.enquiryIds.map((id) => ({ id, name: state.enquiries[id].name })),
      'All enquiries'
    );
    findEnquirySel.disabled = false;
  }

  function refreshFindSubSelect() {
    const enquiryId = findEnquirySel.value;
    if (!enquiryId) {
      findSubSel.innerHTML = '';
      findSubSel.disabled = true;
      return;
    }
    const enq = state.enquiries[enquiryId];
    fillFindSelect(
      findSubSel,
      enq.subEnquiryIds.map((id) => ({ id, name: state.subEnquiries[id].name })),
      'All sub-enquiries'
    );
    findSubSel.disabled = false;
  }

  function refreshFindLabelSelect() {
    if (!findLabelSel) return;
    fillFindSelect(
      findLabelSel,
      allLabels().map((label) => ({ id: label, name: label })),
      'All labels'
    );
  }

  findSchemeSel.addEventListener('change', () => {
    refreshFindCategorySelect();
    findEnquirySel.innerHTML = ''; findEnquirySel.disabled = true;
    findSubSel.innerHTML = ''; findSubSel.disabled = true;
    renderFindResults();
  });
  findCategorySel.addEventListener('change', () => {
    refreshFindEnquirySelect();
    findSubSel.innerHTML = ''; findSubSel.disabled = true;
    renderFindResults();
  });
  findEnquirySel.addEventListener('change', () => {
    refreshFindSubSelect();
    renderFindResults();
  });
  findSubSel.addEventListener('change', renderFindResults);
  if (findLabelSel) findLabelSel.addEventListener('change', renderFindResults);
  findQueryInput.addEventListener('input', renderFindResults);

  findResetBtn.addEventListener('click', () => {
    findQueryInput.value = '';
    findSchemeSel.value = '';
    findCategorySel.innerHTML = ''; findCategorySel.disabled = true;
    findEnquirySel.innerHTML = ''; findEnquirySel.disabled = true;
    findSubSel.innerHTML = ''; findSubSel.disabled = true;
    if (findLabelSel) findLabelSel.value = '';
    renderFindResults();
  });

  [findSchemeSel, findCategorySel, findEnquirySel, findSubSel, findLabelSel]
    .filter(Boolean)
    .forEach((sel) => enhanceSearchableSelect(sel, { includeEmptyOption: true }));

  // Search matches Scheme/Category/Enquiry/Sub-Enquiry names (browse/filter),
  // keywords, and the template text itself (Section 6, bullet 2).
  // Returns the filtered candidate set, unordered — ranking/shuffling
  // happens in rankFindResults() so the same logic can serve both the
  // small preview list and the full "View more" list.
  function findCandidates() {
    const q = findQueryInput.value.trim().toLowerCase();
    const filters = {
      schemeId: findSchemeSel.value || null,
      categoryId: findCategorySel.value || null,
      enquiryId: findEnquirySel.value || null,
      subId: findSubSel.value || null,
      label: (findLabelSel && findLabelSel.value) || null
    };

    const results = [];
    Object.values(state.subEnquiries).forEach((sub) => {
      const enq = state.enquiries[sub.enquiryId];
      const cat = enq ? state.categories[enq.categoryId] : null;
      const scheme = cat ? state.schemes[cat.schemeId] : null;

      if (filters.subId && sub.id !== filters.subId) return;
      if (filters.enquiryId && (!enq || enq.id !== filters.enquiryId)) return;
      if (filters.categoryId && (!cat || cat.id !== filters.categoryId)) return;
      if (filters.schemeId && (!scheme || scheme.id !== filters.schemeId)) return;

      // Template Finder surfaces one card per template, not per Sub-Enquiry.
      subTemplates(sub).forEach((tpl) => {
        if (!tpl.template) return;
        if (filters.label && !templateLabels(tpl).includes(filters.label)) return;
        if (q) {
          const haystack = [scheme && scheme.name, cat && cat.name, enq && enq.name, sub.name, tpl.name,
            effectiveTemplateKeywords(sub, tpl).join(' '), templateLabels(tpl).join(' '), tpl.template].filter(Boolean).join(' \u2022 ').toLowerCase();
          if (!haystack.includes(q)) return;
        }
        results.push({ sub, tpl, enq, cat, scheme });
      });
    });

    return { results, q };
  }

  function shuffledCopy(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  // With a search term: rank by closeness (keyword overlap with the
  // query, plus a boost for the query text appearing in the name or
  // template body). Blank search: no notion of "closest", so just
  // randomize — every render call reshuffles, which is what happens
  // naturally whenever a filter changes.
  function rankFindResults(results, q) {
    if (!q) return shuffledCopy(results);
    const queryKeywords = extractKeywords(q);
    const lowerQ = q.toLowerCase();
    const scored = results.map((r) => {
      const kwScore = queryKeywords.length
        ? keywordOverlapScore(queryKeywords, effectiveTemplateKeywords(r.sub, r.tpl)).score
        : 0;
      const nameHit = r.sub.name.toLowerCase().includes(lowerQ) ? 1 : 0;
      const textHits = Math.min(5, r.tpl.template.toLowerCase().split(lowerQ).length - 1);
      const score = (kwScore * 2) + (nameHit * 0.5) + (textHits * 0.1);
      return Object.assign({}, r, { score });
    });
    scored.sort((a, b) => b.score - a.score || pathForSubEnquiry(a.sub.id).localeCompare(pathForSubEnquiry(b.sub.id)));
    return scored;
  }

  function findMatches() {
    const { results, q } = findCandidates();
    findFullList = rankFindResults(results, q);
    findFullQuery = q;
    return { results: findFullList.slice(0, TEMPLATE_FINDER_PREVIEW_COUNT), q, total: findFullList.length };
  }

  // Builds text nodes with <mark> around case-insensitive matches of `q`,
  // without ever using innerHTML on user-supplied text.
  function highlightedFragment(text, q) {
    const frag = document.createDocumentFragment();
    if (!q) { frag.appendChild(document.createTextNode(text)); return frag; }
    const lower = text.toLowerCase();
    let i = 0;
    let idx = lower.indexOf(q, i);
    if (idx === -1) { frag.appendChild(document.createTextNode(text)); return frag; }
    while (idx !== -1) {
      if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(idx, idx + q.length);
      frag.appendChild(mark);
      i = idx + q.length;
      idx = lower.indexOf(q, i);
    }
    if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
    return frag;
  }

  // Truncates a templateSegmentsFor() segment list to `maxLen` plain-text
  // characters without cutting a <a> segment's URL away from its label —
  // the link stays a real, clickable link even when its display text has
  // to be shortened at the cut point.
  function truncateTemplateSegments(segments, maxLen) {
    let total = 0;
    const out = [];
    for (const seg of segments) {
      const val = seg.type === 'link' ? seg.text : seg.value;
      if (total + val.length <= maxLen) {
        out.push(seg);
        total += val.length;
        continue;
      }
      const remaining = maxLen - total;
      if (remaining > 0) {
        out.push(seg.type === 'link'
          ? { type: 'link', text: val.slice(0, remaining), url: seg.url, bold: seg.bold, italic: seg.italic, underline: seg.underline }
          : { type: 'text', value: val.slice(0, remaining), bold: seg.bold, italic: seg.italic, underline: seg.underline });
      }
      return out;
    }
    return out;
  }

  // Wraps a text/link node in <b>/<i>/<u> per a segment's formatting
  // flags. Accepts either a plain Node or a DocumentFragment (its
  // children get moved into the wrapper, same end result).
  function applySegmentFormatting(node, seg) {
    let el = node;
    if (seg.underline) { const u = document.createElement('u'); u.appendChild(el); el = u; }
    if (seg.italic) { const i = document.createElement('i'); i.appendChild(el); el = i; }
    if (seg.bold) { const b = document.createElement('b'); b.appendChild(el); el = b; }
    return el;
  }

  // Shared by the Template Finder cards and the Deep-thinking/Reverse
  // search cards: renders a template preview that keeps stored
  // hyperlinks live (real, clickable <a> tags) instead of the flattened
  // plain text those cards used to show, while still supporting the
  // existing truncate/expand and search-term highlighting. Returns
  // whether the full template is longer than the preview length.
  function renderTemplateSnippetInto(container, tpl, q, expanded) {
    container.innerHTML = '';
    const fullText = (tpl && tpl.template) || '';
    const isLong = fullText.length > 160;
    const segments = templateSegments(tpl);
    const shown = (expanded || !isLong) ? segments : truncateTemplateSegments(segments, 160);
    shown.forEach((seg) => {
      if (seg.type === 'link') {
        const a = document.createElement('a');
        a.setAttribute('href', seg.url);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener');
        a.appendChild(highlightedFragment(seg.text, q));
        container.appendChild(applySegmentFormatting(a, seg));
      } else {
        container.appendChild(applySegmentFormatting(highlightedFragment(seg.value, q), seg));
      }
    });
    if (!expanded && isLong) container.appendChild(document.createTextNode('\u2026'));
    return isLong;
  }

  // Rich copy: puts both text/html (real <a> links) and a plain-text
  // fallback on the clipboard, so pasting into a rich editor keeps the
  // hyperlinks and pasting into a plain text field still gets the text.
  async function copyTemplateRich(tpl) {
    const plain = (tpl && tpl.template) || '';
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      try {
        const html = templateToClipboardHtml(tpl);
        const item = new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' })
        });
        await navigator.clipboard.write([item]);
        return true;
      } catch (err) {
        // fall through to plain-text copy below
      }
    }
    await navigator.clipboard.writeText(plain);
    return false;
  }

  function findResultsCountText(shown, total, q) {
    if (total === 0) return '';
    if (q) {
      if (total <= shown) return total + (total === 1 ? ' result' : ' results');
      return 'Top ' + shown + ' of ' + total + ' closest results';
    }
    if (total <= shown) return 'Showing all ' + total + (total === 1 ? ' template' : ' templates') + ' (random order)';
    return 'Showing ' + shown + ' random of ' + total + ' templates';
  }

  function renderFindResults() {
    const { results, q, total } = findMatches();
    findResultsEl.innerHTML = '';
    findCountEl.textContent = findResultsCountText(results.length, total, q);

    if (total === 0) {
      const hasAnyTemplates = Object.values(state.subEnquiries).some(subHasTemplates);
      findEmptyNote.textContent = hasAnyTemplates
        ? 'No templates match your search or filters.'
        : 'No templates yet — attach one to a Sub-Enquiry in the Tag view.';
      findResultsEl.appendChild(findEmptyNote);
      findViewMoreBtn.hidden = true;
      return;
    }

    results.forEach(({ sub, tpl }) => {
      findResultsEl.appendChild(renderResultCard(sub, tpl, q));
    });

    findViewMoreBtn.hidden = total <= results.length;
  }

  // ---------- Template Finder: "View more" full-page results ----------
  // Opens the same ranked/shuffled list the small preview drew its top
  // 10 from (findFullList), showing every match for the current filters
  // + search term, loading 20 more at a time as the user scrolls.

  let viewMoreEl = null;
  let viewMoreResultsEl = null;
  let viewMoreMetaEl = null;
  let viewMoreLoadingEl = null;
  let viewMoreRenderedCount = 0;

  function ensureViewMoreModal() {
    if (viewMoreEl) return viewMoreEl;

    const modal = document.createElement('div');
    modal.className = 'summit-modal draft-viewmore';
    modal.id = 'draft-find-viewmore-modal';
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML =
      '<div class="summit-modal__backdrop" data-viewmore-close></div>' +
      '<div class="summit-modal__panel draft-viewmore__panel" role="dialog" aria-modal="true" aria-labelledby="draft-viewmore-title">' +
        '<div class="summit-modal__header">' +
          '<h2 class="summit-modal__title" id="draft-viewmore-title">All matching templates</h2>' +
          '<button type="button" class="summit-modal__close" data-viewmore-close aria-label="Close">\u2715</button>' +
        '</div>' +
        '<p class="draft-viewmore__meta" id="draft-viewmore-meta"></p>' +
        '<div class="draft-viewmore__body" id="draft-viewmore-body">' +
          '<div class="draft-find-results draft-viewmore__results" id="draft-viewmore-results" role="list"></div>' +
          '<p class="draft-viewmore__loading" id="draft-viewmore-loading" hidden>Loading more\u2026</p>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    viewMoreResultsEl = modal.querySelector('#draft-viewmore-results');
    viewMoreMetaEl = modal.querySelector('#draft-viewmore-meta');
    viewMoreLoadingEl = modal.querySelector('#draft-viewmore-loading');
    const body = modal.querySelector('#draft-viewmore-body');

    body.addEventListener('scroll', () => {
      if (viewMoreRenderedCount >= findFullList.length) return;
      if (body.scrollTop + body.clientHeight >= body.scrollHeight - 200) {
        renderViewMoreBatch();
      }
    });

    modal.querySelectorAll('[data-viewmore-close]').forEach((el) => {
      el.addEventListener('click', closeViewMore);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) closeViewMore();
    });

    viewMoreEl = modal;
    return modal;
  }

  // Re-draws just the cards already loaded into the modal (used when a
  // card's own "Show full template" toggle changes) without touching
  // scroll position via a full app-wide rerender.
  function rerenderViewMoreLoaded() {
    const target = viewMoreRenderedCount;
    viewMoreResultsEl.innerHTML = '';
    viewMoreRenderedCount = 0;
    while (viewMoreRenderedCount < target) renderViewMoreBatch();
  }

  function renderViewMoreBatch() {
    const start = viewMoreRenderedCount;
    const end = Math.min(start + TEMPLATE_FINDER_PAGE_SIZE, findFullList.length);
    for (let i = start; i < end; i++) {
      viewMoreResultsEl.appendChild(renderResultCard(findFullList[i].sub, findFullList[i].tpl, findFullQuery, rerenderViewMoreLoaded));
    }
    viewMoreRenderedCount = end;
    viewMoreLoadingEl.hidden = viewMoreRenderedCount >= findFullList.length;
  }

  function findScopeDescription() {
    const parts = [];
    if (findSchemeSel.value) parts.push(state.schemes[findSchemeSel.value].name);
    if (!findCategorySel.disabled && findCategorySel.value) parts.push(state.categories[findCategorySel.value].name);
    if (!findEnquirySel.disabled && findEnquirySel.value) parts.push(state.enquiries[findEnquirySel.value].name);
    if (!findSubSel.disabled && findSubSel.value) parts.push(state.subEnquiries[findSubSel.value].name);
    return parts.length ? parts.join(' \u203A ') : 'all schemes';
  }

  function openViewMore() {
    const modal = ensureViewMoreModal();
    viewMoreResultsEl.innerHTML = '';
    viewMoreRenderedCount = 0;

    const scope = findScopeDescription();
    const queryPart = findFullQuery
      ? ('matching \u201c' + findFullQuery + '\u201d, closest first')
      : 'in random order (no search term entered)';
    viewMoreMetaEl.textContent = findFullList.length + (findFullList.length === 1 ? ' template ' : ' templates ') +
      'in ' + scope + ', ' + queryPart + '.';

    renderViewMoreBatch();
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    modal.querySelector('#draft-viewmore-body').scrollTop = 0;
  }

  function closeViewMore() {
    if (!viewMoreEl) return;
    viewMoreEl.hidden = true;
    viewMoreEl.setAttribute('aria-hidden', 'true');
  }

  findViewMoreBtn.addEventListener('click', openViewMore);

  function makeLabelBadge(tpl) {
    const labels = templateLabels(tpl);
    if (!labels.length) return null;
    const wrap = document.createElement('div');
    wrap.className = 'draft-result__labels';
    labels.forEach((tag) => {
      const badge = document.createElement('span');
      badge.className = 'draft-result__label';
      badge.textContent = tag;
      wrap.appendChild(badge);
    });
    return wrap;
  }

  function renderResultCard(sub, tpl, q, onChange) {
    const rerender = onChange || renderFindResults;
    const resultKey = sub.id + '::' + tpl.id;
    const card = document.createElement('div');
    card.className = 'draft-result';
    card.setAttribute('role', 'listitem');

    const path = document.createElement('p');
    path.className = 'draft-result__path';
    path.textContent = pathForSubEnquiry(sub.id) +
      (subTemplates(sub).length > 1 ? ' \u2014 ' + (tpl.name || 'Untitled') : '');
    card.appendChild(path);

    const labelBadge = makeLabelBadge(tpl);
    if (labelBadge) card.appendChild(labelBadge);

    if (sub.keywords.length > 0) {
      const kwWrap = document.createElement('div');
      kwWrap.className = 'draft-result__keywords';
      sub.keywords.forEach((kw) => {
        const chip = document.createElement('span');
        chip.className = 'draft-chip';
        chip.appendChild(highlightedFragment(kw, q));
        kwWrap.appendChild(chip);
      });
      card.appendChild(kwWrap);
    }
    if ((tpl.keywords || []).length > 0) {
      const tplKwWrap = document.createElement('div');
      tplKwWrap.className = 'draft-result__keywords';
      tpl.keywords.forEach((kw) => {
        const chip = document.createElement('span');
        chip.className = 'draft-chip draft-chip--match';
        chip.title = 'Filed to this template specifically';
        chip.appendChild(highlightedFragment(kw, q));
        tplKwWrap.appendChild(chip);
      });
      card.appendChild(tplKwWrap);
    }

    const expanded = expandedResultIds.has(resultKey);
    const editing = editingResultIds.has(resultKey);

    let getEditorValue = null; // set while editing; reads back the live editor content on Save

    if (editing) {
      const editorWrap = document.createElement('div');
      editorWrap.className = 'draft-result__editor-wrap';

      const toolbar = document.createElement('div');
      toolbar.className = 'draft-result__editor-toolbar';

      const editorBox = document.createElement('div');
      editorBox.className = 'draft-textarea draft-textarea--template draft-result__editor';
      editorBox.contentEditable = 'true';
      editorBox.setAttribute('role', 'textbox');
      editorBox.setAttribute('aria-multiline', 'true');
      editorBox.setAttribute('aria-label', 'Edit template text for ' + sub.name);
      editorBox.innerHTML = tpl.templateHtml ? tpl.templateHtml : (tpl.template ? templateToHtml(tpl) : '');
      wireRichTextEditing(editorBox);

      const makeToolBtn = (html, title, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'summit-btn';
        b.innerHTML = html;
        b.title = title;
        b.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus/selection in editorBox
        b.addEventListener('click', onClick);
        return b;
      };
      toolbar.appendChild(makeToolBtn('<b>B</b>', 'Bold (Ctrl+B)', () => { editorBox.focus(); document.execCommand('bold'); }));
      toolbar.appendChild(makeToolBtn('<i>I</i>', 'Italic (Ctrl+I)', () => { editorBox.focus(); document.execCommand('italic'); }));
      toolbar.appendChild(makeToolBtn('<u>U</u>', 'Underline (Ctrl+U)', () => { editorBox.focus(); document.execCommand('underline'); }));
      toolbar.appendChild(makeToolBtn('Insert link', 'Insert a link at the cursor', () => {
        const sel = window.getSelection();
        const selectedText = (sel && sel.rangeCount && editorBox.contains(sel.anchorNode)) ? sel.toString() : '';
        const url = window.prompt('Link URL:');
        if (!url || !url.trim()) return;
        const label = window.prompt('Link text (leave blank to show the URL itself):', selectedText || '');
        const trimmedUrl = url.trim();
        const trimmedLabel = (label || '').trim() || trimmedUrl;
        const a = document.createElement('a');
        a.setAttribute('href', trimmedUrl);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener');
        a.textContent = trimmedLabel;
        insertNodeInto(editorBox, a);
      }));

      editorWrap.appendChild(toolbar);
      editorWrap.appendChild(editorBox);
      card.appendChild(editorWrap);
      getEditorValue = () => editorBox;
      // Cursor in, ready to type, as soon as the card renders.
      requestAnimationFrame(() => editorBox.focus());
    } else {
      const snippet = document.createElement('p');
      snippet.className = 'draft-result__snippet';
      const isLong = renderTemplateSnippetInto(snippet, tpl, q, expanded);
      card.appendChild(snippet);

      if (isLong) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'draft-result__toggle';
        toggle.textContent = expanded ? 'Show less' : 'Show full template';
        toggle.addEventListener('click', () => {
          if (expanded) expandedResultIds.delete(resultKey); else expandedResultIds.add(resultKey);
          rerender();
        });
        card.appendChild(toggle);
      }
    }

    const actions = document.createElement('div');
    actions.className = 'draft-result__actions';

    if (editing) {
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'summit-btn summit-btn--primary';
      saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', () => {
        const editorBox = getEditorValue();
        tpl.template = plainTextFromElement(editorBox);
        tpl.templateLinks = linksFromElement(editorBox);
        tpl.templateHtml = sanitizeElementHtml(editorBox);
        editingResultIds.delete(resultKey);
        if (sub.id === state.selectedSubEnquiryId && activeTemplateId === tpl.id) {
          renderTemplateIntoEditor(tpl);
          updateTemplateStatus(sub, tpl);
        }
        renderTree();
        buildDeepIndex();
        showToast('Template updated for ' + sub.name);
        rerender();
      });
      actions.appendChild(saveBtn);

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'summit-btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => {
        editingResultIds.delete(resultKey);
        rerender();
      });
      actions.appendChild(cancelBtn);

      card.appendChild(actions);
      return card;
    }

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'summit-btn';
    editBtn.textContent = 'Edit text';
    editBtn.setAttribute('aria-label', 'Edit text of template ' + (tpl.name || 'Untitled'));
    editBtn.addEventListener('click', () => {
      editingResultIds.add(resultKey);
      rerender();
    });
    actions.appendChild(editBtn);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'summit-btn';
    copyBtn.textContent = 'Copy template';
    copyBtn.addEventListener('click', async () => {
      try {
        const rich = await copyTemplateRich(tpl);
        showToast(rich ? 'Template copied to clipboard (links kept).' : 'Template copied to clipboard.');
      } catch (err) {
        showToast('Could not copy — select and copy manually.');
      }
    });
    actions.appendChild(copyBtn);

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'summit-btn summit-btn--primary';
    openBtn.textContent = 'Open in Tag view';
    openBtn.addEventListener('click', () => {
      state.selectedSubEnquiryId = sub.id;
      activeTemplateId = tpl.id;
      const enq = state.enquiries[sub.enquiryId];
      const cat = state.categories[enq.categoryId];
      expandedIds.add(cat.schemeId);
      expandedIds.add(enq.categoryId);
      expandedIds.add(sub.enquiryId);
      renderAll();
      activateSubtab('tag');
    });
    actions.appendChild(openBtn);

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'summit-btn';
    renameBtn.textContent = 'Rename';
    renameBtn.setAttribute('aria-label', 'Rename template ' + (tpl.name || 'Untitled'));
    renameBtn.addEventListener('click', () => renameTemplateFromResults(sub, tpl, rerender));
    actions.appendChild(renameBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'summit-btn summit-btn--danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.setAttribute('aria-label', 'Delete template ' + (tpl.name || 'Untitled') + ' from ' + sub.name);
    deleteBtn.addEventListener('click', () => deleteTemplateFromResults(sub, tpl, rerender));
    actions.appendChild(deleteBtn);

    card.appendChild(actions);
    return card;
  }

  function refreshFindFilters() {
    refreshFindLabelSelect();
    const prevScheme = findSchemeSel.value;
    refreshFindSchemeSelect();
    if (findSchemeSel.value !== prevScheme) {
      findCategorySel.innerHTML = ''; findCategorySel.disabled = true;
      findEnquirySel.innerHTML = ''; findEnquirySel.disabled = true;
      findSubSel.innerHTML = ''; findSubSel.disabled = true;
      return;
    }
    if (!findCategorySel.disabled) {
      const prevCat = findCategorySel.value;
      refreshFindCategorySelect();
      if (findCategorySel.value !== prevCat) {
        findEnquirySel.innerHTML = ''; findEnquirySel.disabled = true;
        findSubSel.innerHTML = ''; findSubSel.disabled = true;
        return;
      }
    }
    if (!findEnquirySel.disabled) {
      const prevEnq = findEnquirySel.value;
      refreshFindEnquirySelect();
      if (findEnquirySel.value !== prevEnq) {
        findSubSel.innerHTML = ''; findSubSel.disabled = true;
        return;
      }
    }
    if (!findSubSel.disabled) {
      refreshFindSubSelect();
    }
  }



  // ============================================================
  // 7. Reverse Search & Deep Thinking Search
  // ============================================================

  // Jaccard-style overlap: how much two keyword lists share, scaled 0..1,
  // so a query with a few keywords can still rank a small, precise
  // Sub-Enquiry above a large, loosely-related one.
  function keywordOverlapScore(a, b) {
    if (!a.length || !b.length) return { score: 0, matched: [] };
    const bSet = new Set(b);
    const matched = a.filter((kw) => bSet.has(kw));
    if (matched.length === 0) return { score: 0, matched: [] };
    const union = new Set(a.concat(b)).size;
    return { score: matched.length / union, matched };
  }

  function renderKeywordChips(container, emptyNote, keywords, { removable, highlightSet } = {}) {
    container.innerHTML = '';
    if (keywords.length === 0) {
      container.appendChild(emptyNote);
      return;
    }
    keywords.forEach((kw) => {
      const chip = document.createElement('span');
      chip.className = 'draft-chip';
      if (highlightSet && highlightSet.has(kw)) chip.classList.add('draft-chip--match');
      const label = document.createElement('span');
      label.textContent = kw;
      chip.appendChild(label);
      if (removable) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'draft-chip__remove';
        remove.setAttribute('aria-label', 'Remove keyword ' + kw);
        remove.textContent = '\u00D7';
        remove.addEventListener('click', () => {
          reverseKeywords = reverseKeywords.filter((k) => k !== kw);
          renderReverseKeywords();
          if (reverseHasSearched) renderReverseResults();
        });
        chip.appendChild(remove);
      }
      container.appendChild(chip);
    });
  }

  // ---------- 7.1 Reverse search ----------

  function renderReverseKeywords() {
    renderKeywordChips(reverseKeywordsEl, reverseKeywordsEmptyNote, reverseKeywords, { removable: true });
  }

  // Every keyword that could make a Sub-Enquiry match — its general
  // pool plus every one of its templates' own filed keywords. Reverse
  // search operates at the Sub-Enquiry level (one card per match, with
  // every template shown underneath), so unlike Template Finder it
  // needs the union rather than one template's effective set.
  function subAllKeywordsIncTemplates(sub) {
    const all = (sub.keywords || []).slice();
    subTemplates(sub).forEach((tpl) => {
      (tpl.keywords || []).forEach((kw) => { if (!all.includes(kw)) all.push(kw); });
    });
    return all;
  }

  function computeReverseMatches() {
    const matches = [];
    Object.values(state.subEnquiries).forEach((sub) => {
      const { score, matched } = keywordOverlapScore(reverseKeywords, subAllKeywordsIncTemplates(sub));
      if (score > 0) matches.push({ sub, score, matched });
    });
    matches.sort((a, b) => b.score - a.score || pathForSubEnquiry(a.sub.id).localeCompare(pathForSubEnquiry(b.sub.id)));
    return matches.slice(0, 15);
  }

  function renderMatchCard({ sub, score, matched }, expandedSet, onRefresh) {
    const card = document.createElement('div');
    card.className = 'draft-result';
    card.setAttribute('role', 'listitem');

    const header = document.createElement('div');
    header.className = 'draft-result__header';
    const path = document.createElement('p');
    path.className = 'draft-result__path';
    path.textContent = pathForSubEnquiry(sub.id);
    header.appendChild(path);
    const scoreBadge = document.createElement('span');
    scoreBadge.className = 'draft-result__score';
    scoreBadge.textContent = Math.round(score * 100) + '% match \u2022 ' + matched.length + ' keyword' + (matched.length === 1 ? '' : 's');
    header.appendChild(scoreBadge);
    card.appendChild(header);

    if (sub.keywords.length > 0) {
      const kwWrap = document.createElement('div');
      kwWrap.className = 'draft-result__keywords';
      renderKeywordChips(kwWrap, document.createElement('span'), sub.keywords, { highlightSet: new Set(matched) });
      card.appendChild(kwWrap);
    }

    const templates = subTemplates(sub).filter((t) => t.template);
    if (templates.length > 0) {
      templates.forEach((tpl) => {
        const key = sub.id + '::' + tpl.id;
        const expanded = expandedSet.has(key);
        const block = document.createElement('div');
        block.className = 'draft-result__template-block';

        if (templates.length > 1) {
          const tplName = document.createElement('p');
          tplName.className = 'draft-result__template-name';
          tplName.textContent = tpl.name || 'Untitled';
          block.appendChild(tplName);
        }
        const labelBadge = makeLabelBadge(tpl);
        if (labelBadge) block.appendChild(labelBadge);
        if ((tpl.keywords || []).length > 0) {
          const tplKwWrap = document.createElement('div');
          tplKwWrap.className = 'draft-result__keywords';
          renderKeywordChips(tplKwWrap, document.createElement('span'), tpl.keywords, { highlightSet: new Set(matched) });
          block.appendChild(tplKwWrap);
        }
        const snippet = document.createElement('p');
        snippet.className = 'draft-result__snippet';
        const isLong = renderTemplateSnippetInto(snippet, tpl, null, expanded);
        block.appendChild(snippet);

        if (isLong) {
          const toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'draft-result__toggle';
          toggle.textContent = expanded ? 'Show less' : 'Show full template';
          toggle.addEventListener('click', () => {
            if (expanded) expandedSet.delete(key); else expandedSet.add(key);
            onRefresh();
          });
          block.appendChild(toggle);
        }

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'summit-btn draft-result__template-copy';
        copyBtn.textContent = templates.length > 1 ? 'Copy "' + (tpl.name || 'Untitled') + '"' : 'Copy template';
        copyBtn.addEventListener('click', async () => {
          try {
            const rich = await copyTemplateRich(tpl);
            showToast(rich ? 'Template copied to clipboard (links kept).' : 'Template copied to clipboard.');
          } catch (err) {
            showToast('Could not copy — select and copy manually.');
          }
        });
        block.appendChild(copyBtn);

        card.appendChild(block);
      });
    } else {
      const note = document.createElement('p');
      note.className = 'draft-empty-note';
      note.textContent = 'No template attached to this Sub-Enquiry yet.';
      card.appendChild(note);
    }

    const actions = document.createElement('div');
    actions.className = 'draft-result__actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'summit-btn summit-btn--primary';
    openBtn.textContent = templates.length > 0 ? 'Open in Tag view' : 'Go to Sub-Enquiry';
    openBtn.addEventListener('click', () => {
      state.selectedSubEnquiryId = sub.id;
      activeTemplateId = templates.length ? templates[0].id : null;
      const enq = state.enquiries[sub.enquiryId];
      const cat = state.categories[enq.categoryId];
      expandedIds.add(cat.schemeId);
      expandedIds.add(enq.categoryId);
      expandedIds.add(sub.enquiryId);
      renderAll();
      activateSubtab('tag');
    });
    actions.appendChild(openBtn);

    card.appendChild(actions);
    return card;
  }

  function renderReverseResults() {
    const matches = computeReverseMatches();
    reverseResultsEl.innerHTML = '';
    reverseCountEl.textContent = !reverseHasSearched || matches.length === 0 ? '' :
      (matches.length === 1 ? '1 match' : matches.length + ' matches');

    if (!reverseHasSearched) {
      reverseEmptyNote.textContent = 'Paste some text on the left and click "Find matching Sub-Enquiries" to see ranked matches.';
      reverseResultsEl.appendChild(reverseEmptyNote);
      return;
    }
    if (reverseKeywords.length === 0) {
      reverseEmptyNote.textContent = 'No keywords left to match on — extract some text first.';
      reverseResultsEl.appendChild(reverseEmptyNote);
      return;
    }
    if (matches.length === 0) {
      reverseEmptyNote.textContent = 'No Sub-Enquiry shares any of these keywords yet.';
      reverseResultsEl.appendChild(reverseEmptyNote);
      return;
    }
    matches.forEach((m) => reverseResultsEl.appendChild(renderMatchCard(m, expandedReverseIds, renderReverseResults)));
  }

  reverseBtn.addEventListener('click', () => {
    const text = reverseInput.value || '';
    if (!text.trim()) {
      showToast('Paste some text first.');
      return;
    }
    reverseKeywords = extractKeywords(text);
    reverseHasSearched = true;
    renderReverseKeywords();
    renderReverseResults();
    if (reverseKeywords.length === 0) showToast('No meaningful keywords found in that text.');
  });

  reverseClearBtn.addEventListener('click', () => {
    reverseInput.value = '';
    reverseKeywords = [];
    reverseHasSearched = false;
    renderReverseKeywords();
    renderReverseResults();
  });

  // ---------- 7.2 Deep thinking search ----------

  function buildDeepIndex() {
    deepIndex = [];
    Object.values(state.subEnquiries).forEach((sub) => {
      if (!subHasTemplates(sub)) return;
      deepIndex.push({ subId: sub.id, keywords: extractKeywords(subTemplateText(sub)) });
    });
    const totalKeywords = deepIndex.reduce((sum, entry) => sum + entry.keywords.length, 0);
    deepIndexStatus.textContent = deepIndex.length === 0
      ? 'No templates to index yet \u2014 attach a template to a Sub-Enquiry in the Tag view first.'
      : 'Indexed ' + deepIndex.length + ' template' + (deepIndex.length === 1 ? '' : 's') + ' \u2022 ' + totalKeywords + ' keyword' + (totalKeywords === 1 ? '' : 's') + ' total.';
    renderDeepResults();
    renderDeepLinksList();
  }

  // Every hyperlink stored on every Sub-Enquiry's template, with its
  // display text, the full URL, and which Sub-Enquiry it lives on —
  // rebuilt any time a template is saved/cleared or the index is
  // manually rebuilt, so it never drifts from what's actually stored.
  //
  // The same link (or the same display text pointing at slightly
  // different URLs) tends to get pasted into many templates, so
  // instead of one row per occurrence, occurrences are merged into
  // groups: any two links sharing either a normalized URL or a
  // normalized display text land in the same group (transitively —
  // A can merge with C via a shared B even if A and C don't directly
  // match each other).
  function normalizeLinkText(t) {
    return (t || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }
  function normalizeLinkUrl(u) {
    return (u || '').trim().toLowerCase().replace(/\/+$/, '');
  }

  function groupLinkRows(rows) {
    const parent = rows.map((_, i) => i);
    function find(i) {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    }
    function union(a, b) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }
    const byUrl = new Map();
    const byText = new Map();
    rows.forEach((r, i) => {
      const nu = normalizeLinkUrl(r.link.url);
      const nt = normalizeLinkText(r.link.text);
      if (nu) { if (byUrl.has(nu)) union(i, byUrl.get(nu)); else byUrl.set(nu, i); }
      if (nt) { if (byText.has(nt)) union(i, byText.get(nt)); else byText.set(nt, i); }
    });

    const groupsByRoot = new Map();
    rows.forEach((r, i) => {
      const root = find(i);
      if (!groupsByRoot.has(root)) groupsByRoot.set(root, []);
      groupsByRoot.get(root).push(r);
    });

    // Within a group, the most common exact text/URL "wins" as the
    // representative shown in the header (first-seen breaks ties, so
    // it stays stable given `rows` is already sorted deterministically).
    function pickMode(values) {
      const counts = new Map();
      let best = values[0], bestCount = 0;
      values.forEach((v) => {
        const c = (counts.get(v) || 0) + 1;
        counts.set(v, c);
        if (c > bestCount) { bestCount = c; best = v; }
      });
      return best;
    }

    return Array.from(groupsByRoot.values()).map((members) => {
      const text = pickMode(members.map((m) => m.link.text));
      const url = pickMode(members.map((m) => m.link.url));
      const sourcesBySub = new Map();
      members.forEach((m) => { sourcesBySub.set(m.sub.id, m.sub); });
      const sources = Array.from(sourcesBySub.values())
        .map((sub) => ({ sub, path: pathForSubEnquiry(sub.id) }))
        .sort((a, b) => a.path.localeCompare(b.path));
      return { text, url, count: members.length, sources };
    });
  }

  // Rich copy for a single hyperlink entry: puts both text/html (a
  // real clickable <a>) and a plain-text fallback ("text (url)") on
  // the clipboard, mirroring copyTemplateRich's approach below.
  async function copyLinkRich(text, url) {
    const plain = text + ' (' + url + ')';
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      try {
        const html = '<a href="' + escapeHtmlLocal(url) + '">' + escapeHtmlLocal(text) + '</a>';
        const item = new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' })
        });
        await navigator.clipboard.write([item]);
        return true;
      } catch (err) {
        // fall through to plain-text copy below
      }
    }
    await navigator.clipboard.writeText(plain);
    return false;
  }

  // Runtime-only: which groups have their Sub-Enquiry source chain
  // expanded. Collapsed by default — the list is meant to be a quick
  // scan of link name + URL, not buried under every location it's
  // filed under. Keyed by the group's normalized text/url so it stays
  // stable across re-renders (a plain array index would drift as
  // links are added/removed elsewhere).
  const expandedLinkSources = new Set();

  function renderDeepLinksList() {
    if (!deepLinksListEl) return;
    const rows = [];
    Object.values(state.subEnquiries).forEach((sub) => {
      subAllLinks(sub).forEach((link) => rows.push({ sub, link }));
    });
    rows.sort((a, b) => pathForSubEnquiry(a.sub.id).localeCompare(pathForSubEnquiry(b.sub.id)) ||
      a.link.text.localeCompare(b.link.text));

    const groups = groupLinkRows(rows);
    groups.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));

    if (deepLinksCountEl) {
      deepLinksCountEl.textContent = rows.length === 0 ? '' :
        (groups.length === rows.length
          ? (rows.length === 1 ? '1 hyperlink' : rows.length + ' hyperlinks')
          : rows.length + ' hyperlink' + (rows.length === 1 ? '' : 's') +
            ' \u2014 ' + groups.length + ' unique after merging duplicates');
    }

    deepLinksListEl.innerHTML = '';
    if (rows.length === 0) {
      deepLinksListEl.appendChild(deepLinksEmptyNote);
      return;
    }
    groups.forEach((group) => {
      const groupKey = normalizeLinkText(group.text) + '::' + normalizeLinkUrl(group.url);
      const row = document.createElement('div');
      row.className = 'draft-link-row';

      const header = document.createElement('div');
      header.className = 'draft-link-row__header';

      const textEl = document.createElement('span');
      textEl.className = 'draft-link-row__text';
      textEl.textContent = group.text;
      header.appendChild(textEl);

      if (group.count > 1) {
        const countBadge = document.createElement('span');
        countBadge.className = 'draft-link-row__count';
        countBadge.textContent = group.count + ' duplicates merged';
        header.appendChild(countBadge);
      }
      row.appendChild(header);

      const urlEl = document.createElement('a');
      urlEl.className = 'draft-link-row__url';
      urlEl.href = group.url;
      urlEl.target = '_blank';
      urlEl.rel = 'noopener';
      urlEl.textContent = group.url;
      row.appendChild(urlEl);

      const actions = document.createElement('div');
      actions.className = 'draft-link-row__actions';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'summit-btn draft-link-row__copy';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', async () => {
        try {
          const rich = await copyLinkRich(group.text, group.url);
          showToast(rich ? 'Link copied to clipboard (stays clickable).' : 'Link copied to clipboard.');
        } catch (err) {
          showToast('Could not copy \u2014 select and copy manually.');
        }
      });
      actions.appendChild(copyBtn);

      const expanded = expandedLinkSources.has(groupKey);
      const sourcesToggle = document.createElement('button');
      sourcesToggle.type = 'button';
      sourcesToggle.className = 'draft-result__toggle draft-link-row__sources-toggle';
      sourcesToggle.textContent = (expanded ? 'Hide' : 'Show') + ' ' + group.sources.length +
        ' Sub-Enquir' + (group.sources.length === 1 ? 'y' : 'ies');
      sourcesToggle.addEventListener('click', () => {
        if (expanded) expandedLinkSources.delete(groupKey); else expandedLinkSources.add(groupKey);
        renderDeepLinksList();
      });
      actions.appendChild(sourcesToggle);

      row.appendChild(actions);

      if (expanded) {
        const sourcesWrap = document.createElement('div');
        sourcesWrap.className = 'draft-link-row__sources';
        group.sources.forEach(({ path }) => {
          const sourceEl = document.createElement('span');
          sourceEl.className = 'draft-link-row__source';
          sourceEl.textContent = path;
          sourcesWrap.appendChild(sourceEl);
        });
        row.appendChild(sourcesWrap);
      }

      deepLinksListEl.appendChild(row);
    });
  }

  function computeDeepMatches(queryKeywords) {
    const matches = [];
    deepIndex.forEach((entry) => {
      const sub = state.subEnquiries[entry.subId];
      if (!sub) return; // stale entry from a since-deleted Sub-Enquiry
      const { score, matched } = keywordOverlapScore(queryKeywords, entry.keywords);
      if (score > 0) matches.push({ sub, score, matched });
    });
    matches.sort((a, b) => b.score - a.score || pathForSubEnquiry(a.sub.id).localeCompare(pathForSubEnquiry(b.sub.id)));
    return matches.slice(0, 15);
  }

  function renderDeepResults() {
    const raw = deepQueryInput.value.trim();
    const queryKeywords = raw ? extractKeywords(raw) : [];
    const matches = queryKeywords.length ? computeDeepMatches(queryKeywords) : [];

    deepResultsEl.innerHTML = '';
    deepCountEl.textContent = !raw || matches.length === 0 ? '' :
      (matches.length === 1 ? '1 match' : matches.length + ' matches');

    if (!raw) {
      deepEmptyNote.textContent = 'Type a search above to query the template keyword index.';
      deepResultsEl.appendChild(deepEmptyNote);
      return;
    }
    if (deepIndex.length === 0) {
      deepEmptyNote.textContent = 'No templates to index yet \u2014 attach a template to a Sub-Enquiry in the Tag view first.';
      deepResultsEl.appendChild(deepEmptyNote);
      return;
    }
    if (matches.length === 0) {
      deepEmptyNote.textContent = 'No indexed template shares any keywords with that search.';
      deepResultsEl.appendChild(deepEmptyNote);
      return;
    }
    matches.forEach((m) => deepResultsEl.appendChild(renderMatchCard(m, expandedDeepIds, renderDeepResults)));
  }

  deepQueryInput.addEventListener('input', renderDeepResults);
  deepRebuildBtn.addEventListener('click', () => {
    buildDeepIndex();
    showToast('Template keyword index rebuilt.');
  });

  function renderAll() {
    renderTree();
    renderDetail();
    refreshLabelDatalist();
    refreshFindFilters();
    renderFindResults();
    buildDeepIndex();
    if (reverseHasSearched) renderReverseResults();
    if (subpanels.importexport && !subpanels.importexport.hidden) renderBatchList();
    syncFileSelectsToTreeSelection();
  }

  // Keeps the "File keywords here" cascade (Paste & extract panel)
  // pointed at whichever Sub-Enquiry is currently selected in the
  // Hierarchy. Previously this only happened once, at the moment
  // Extract was clicked — so clicking a *different* Sub-Enquiry
  // afterward (while keywords were still awaiting filing) left the
  // picker silently pointed at the old one, and "File keywords here"
  // would file against the wrong Sub-Enquiry. Runs after every render
  // but is a no-op unless the panel is open and out of sync, so it
  // doesn't fight the user mid-edit of the picker itself.
  function syncFileSelectsToTreeSelection() {
    if (!filePanel || filePanel.hidden) return;
    const subId = state.selectedSubEnquiryId;
    if (!subId || !state.subEnquiries[subId]) return;
    if (fileSubSel.value === subId) return; // already in sync
    applySelectedChainToFileSelects();
  }

  // ============================================================
  // 8. Draft Tab — Import & Export
  //
  // Import (8.1): file upload (.docx/.txt) into the paste box —
  // pasting straight into that box already covers the copy-paste
  // path, since it's a plain textarea.
  // Export (8.2): the whole template library — every Sub-Enquiry
  // with a template attached — as .txt/.docx or a clipboard copy.
  // Batch export: the same library split into fixed-size chunks
  // (10/50/100/150/200 templates, or a custom size), listed in a
  // scrollable menu, each copyable or downloadable on its own, plus
  // one "download all as .zip" shortcut.
  // Batch import: paste back any of the above (a single export, one
  // batch, or several concatenated) — entries are matched by their
  // Scheme/Category/Enquiry/Sub-Enquiry path and created or updated.
  //
  // Local helpers only (pad/timestamp/downloadBlob) rather than
  // reaching into data.js — Section 8 reads/writes the hierarchy
  // directly, same as Sections 6-7 above, per this file's own header.
  // ============================================================

  const importFileInput = document.getElementById('draft-import-file');
  const importFileBtn = document.getElementById('draft-import-file-btn');

  const exportTxtBtn = document.getElementById('draft-export-txt-btn');
  const exportDocxBtn = document.getElementById('draft-export-docx-btn');
  const exportCopyBtn = document.getElementById('draft-export-copy-btn');
  const exportStatusEl = document.getElementById('draft-export-status');

  const batchSizeSel = document.getElementById('draft-batch-size');
  const batchCustomInput = document.getElementById('draft-batch-custom');
  const batchGenerateBtn = document.getElementById('draft-batch-generate-btn');
  const batchZipBtn = document.getElementById('draft-batch-zip-btn');
  const batchListEl = document.getElementById('draft-batch-list');
  const batchEmptyNote = document.getElementById('draft-batch-empty');
  const batchCountEl = document.getElementById('draft-batch-count');

  const batchImportInput = document.getElementById('draft-batchimport-input');
  const batchImportBtn = document.getElementById('draft-batchimport-btn');
  const batchImportStatusEl = document.getElementById('draft-batchimport-status');

  let currentBatches = []; // [{ startIndex, entries: [sub, ...] }]

  function pad2(n, len) { return String(n).padStart(len, '0'); }
  function draftTimestamp() {
    const d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1, 2) + pad2(d.getDate(), 2) +
      '-' + pad2(d.getHours(), 2) + pad2(d.getMinutes(), 2);
  }

  // ---------- Hierarchy "saved" indicator ----------
  // Nothing in this app persists across a reload — Export .txt and
  // Copy to clipboard are the only ways the hierarchy actually leaves
  // the browser tab, so those two count as "saving" it. Tracked in
  // memory only, same lifetime as everything else here.
  const SAVE_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let lastHierarchySavedAt = null;

  function formatSavedAt(date) {
    const h = date.getHours();
    const displayHour = ((h + 11) % 12) + 1;
    const ampm = h < 12 ? 'AM' : 'PM';
    return SAVE_MONTH_NAMES[date.getMonth()] + ' ' + date.getDate() + ', ' +
      displayHour + ':' + pad2(date.getMinutes(), 2) + ' ' + ampm;
  }

  function updateSaveStatusDisplay() {
    if (!saveStatusEl) return;
    if (lastHierarchySavedAt) {
      saveStatusEl.textContent = 'Last saved ' + formatSavedAt(lastHierarchySavedAt);
      saveStatusEl.classList.add('is-saved');
    } else {
      saveStatusEl.textContent = 'Not saved recently yet.';
      saveStatusEl.classList.remove('is-saved');
    }
  }

  function markHierarchySaved() {
    lastHierarchySavedAt = new Date();
    updateSaveStatusDisplay();
  }

  updateSaveStatusDisplay();
  function downloadTextBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ---------- Entry format ----------
  // PATH: Scheme > Category > Enquiry > Sub-Enquiry
  // KEYWORDS: kw1, kw2
  // TEMPLATE_ID: tpl-xxxxx
  // TEMPLATE_KEYWORDS: kw3, kw4  (this one template's own keywords,
  //   separate from the Sub-Enquiry's general KEYWORDS: above)
  // LABEL: tag1, tag2
  // LINKS:
  // <link display text> => <full URL>
  // TEMPLATE:
  // <template text, verbatim — link display text appears inline here,
  //  the LINKS: block above is what maps it back to a full URL>
  // ###END###
  //
  // Plain ASCII '>' in PATH (distinct from the '\u203A' used for display
  // elsewhere) so import can split on it reliably. LABEL and LINKS are
  // each optional on import for backward compatibility with older
  // exports — a block missing either line leaves the existing value on
  // that template untouched rather than blanking it. LABEL is
  // comma-separated so it can carry any number of Name/Term tags, and
  // (like TEMPLATE_KEYWORDS) applies to this one template specifically —
  // older exports wrote the same LABEL value into every block for a
  // given Sub-Enquiry, which imports cleanly onto each template here too.
  // LINKS sits before TEMPLATE (not after) because TEMPLATE's own
  // regex reads everything to the end of the block, verbatim.
  //
  // TEMPLATE_ID is the template's real internal id, carried through so
  // re-importing an export (your own, or a colleague's built under the
  // same PATH) matches the *same* template again even if it's been
  // renamed — and, crucially, so two people's independently-created
  // "Template 1" don't collide into one just because they share a
  // display name. A block with no TEMPLATE_ID (an older export) falls
  // back to matching by TEMPLATE_NAME, same as before this existed.

  // Each exported entry is now one { sub, tpl } pair — a Sub-Enquiry
  // with more than one template produces one PATH/TEMPLATE block per
  // template, distinguished by an (optional, backward-compatible)
  // TEMPLATE_NAME: line.
  function entryBlock({ sub, tpl }) {
    const enq = state.enquiries[sub.enquiryId];
    const cat = enq ? state.categories[enq.categoryId] : null;
    const scheme = cat ? state.schemes[cat.schemeId] : null;
    const path = [scheme && scheme.name, cat && cat.name, enq && enq.name, sub.name].filter(Boolean).join(' > ');
    const links = tpl.templateLinks || [];
    const linksBlock = links.length
      ? 'LINKS:\n' + links.map((l) => l.text + ' => ' + l.url).join('\n') + '\n'
      : '';
    // FORMAT carries the bold/italic/underline-bearing HTML (<br> for
    // line breaks, so it's always a single physical line here) so
    // rich formatting round-trips through export/import. It's optional
    // on read — TEMPLATE stays the authoritative plain text either way.
    const formatBlock = tpl.templateHtml ? 'FORMAT: ' + tpl.templateHtml + '\n' : '';
    return 'PATH: ' + path + '\n' +
      'KEYWORDS: ' + sub.keywords.join(', ') + '\n' +
      'LABEL: ' + templateLabels(tpl).join(', ') + '\n' +
      'TEMPLATE_ID: ' + tpl.id + '\n' +
      'TEMPLATE_NAME: ' + (tpl.name || '') + '\n' +
      'TEMPLATE_KEYWORDS: ' + (tpl.keywords || []).join(', ') + '\n' +
      linksBlock +
      formatBlock +
      'TEMPLATE:\n' + tpl.template + '\n' +
      '###END###';
  }

  function getTemplateEntries() {
    // "Templates" = every non-empty template across every Sub-Enquiry,
    // same definition the Find/Search view uses (one card per template).
    const entries = [];
    Object.values(state.subEnquiries).forEach((sub) => {
      subTemplates(sub).forEach((tpl) => {
        if (tpl.template && tpl.template.trim()) entries.push({ sub, tpl });
      });
    });
    entries.sort((a, b) => pathForSubEnquiry(a.sub.id).localeCompare(pathForSubEnquiry(b.sub.id)) ||
      (a.tpl.name || '').localeCompare(b.tpl.name || ''));
    return entries;
  }

  function entriesToText(entries) {
    return entries.map(entryBlock).join('\n\n');
  }

  // ---------- 8.1 — File import into the paste box ----------

  if (importFileBtn && importFileInput) {
    importFileBtn.addEventListener('click', () => importFileInput.click());
    importFileInput.addEventListener('change', async () => {
      const file = importFileInput.files[0];
      if (!file) return;
      try {
        let text;
        if (/\.docx$/i.test(file.name)) {
          if (!window.mammoth) throw new Error('Document converter not loaded.');
          const buf = await file.arrayBuffer();
          const result = await window.mammoth.convertToHtml({ arrayBuffer: buf });
          const tmp = document.createElement('div');
          tmp.innerHTML = result.value || '';
          text = tmp.innerText || '';
        } else {
          text = await file.text();
        }
        pasteInput.value = text;
        showToast('Imported "' + file.name + '" into the paste box.');
      } catch (err) {
        showToast('Could not read that file: ' + (err && err.message ? err.message : err));
      } finally {
        importFileInput.value = '';
      }
    });
  }

  // ---------- 8.2 — Export (single: .txt / .docx / copy) ----------

  function exportPrecheck() {
    const entries = getTemplateEntries();
    if (entries.length === 0) {
      showToast('No templates yet — attach one to a Sub-Enquiry in the Tag view.');
      return null;
    }
    return entries;
  }

  if (exportTxtBtn) exportTxtBtn.addEventListener('click', () => {
    const entries = exportPrecheck();
    if (!entries) return;
    downloadTextBlob(new Blob([entriesToText(entries)], { type: 'text/plain' }),
      'draft-templates-' + draftTimestamp() + '.txt');
  });

  function draftHtmlDocument(bodyHTML) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Summit \u2014 Draft templates</title>' +
      '<style>body{font-family:Calibri,"Segoe UI",Arial,sans-serif;font-size:11pt;color:#24211d;}' +
      'h2{font-size:12pt;color:#7A4E23;} p{white-space:pre-wrap;margin:0 0 10pt;}</style></head><body>' +
      (bodyHTML || '<p></p>') + '</body></html>';
  }

  function escapeHtmlLocal(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  if (exportDocxBtn) exportDocxBtn.addEventListener('click', () => {
    const entries = exportPrecheck();
    if (!entries) return;
    if (!window.htmlDocx) { showToast('Document exporter not loaded.'); return; }
    const body = entries.map(({ sub, tpl }) => {
      const labels = templateLabels(tpl);
      const heading = pathForSubEnquiry(sub.id) + (entries.filter((e) => e.sub.id === sub.id).length > 1 ? ' \u2014 ' + (tpl.name || 'Untitled') : '');
      return '<h2>' + escapeHtmlLocal(heading) + '</h2>' +
        (sub.keywords.length ? '<p><em>Keywords: ' + escapeHtmlLocal(sub.keywords.join(', ')) + '</em></p>' : '') +
        ((tpl.keywords || []).length ? '<p><em>Template keywords: ' + escapeHtmlLocal(tpl.keywords.join(', ')) + '</em></p>' : '') +
        (labels.length ? '<p><em>Tags: ' + escapeHtmlLocal(labels.map((l) => '#' + l).join(' ')) + '</em></p>' : '') +
        // One <div> per line (not a single flat <p>) so a bulleted
        // list survives as one bullet per line once opened in Word —
        // see templateToClipboardHtml above for why.
        templateToClipboardHtml(tpl);
    }).join('');
    downloadTextBlob(window.htmlDocx.asBlob(draftHtmlDocument(body)), 'draft-templates-' + draftTimestamp() + '.docx');
  });

  if (exportCopyBtn) exportCopyBtn.addEventListener('click', async () => {
    const entries = exportPrecheck();
    if (!entries) return;
    try {
      await navigator.clipboard.writeText(entriesToText(entries));
      exportStatusEl.textContent = 'Copied ' + entries.length + ' template' + (entries.length === 1 ? '' : 's') + ' to clipboard.';
      showToast('Copied all templates to clipboard.');
    } catch (err) {
      showToast('Could not copy \u2014 try downloading instead.');
    }
  });

  // ---------- Batch export ----------

  if (batchSizeSel && batchCustomInput) {
    batchSizeSel.addEventListener('change', () => {
      batchCustomInput.hidden = batchSizeSel.value !== 'custom';
    });
  }

  function currentBatchSize() {
    const n = batchSizeSel.value === 'custom' ? parseInt(batchCustomInput.value, 10) : parseInt(batchSizeSel.value, 10);
    return (n && n > 0) ? n : null;
  }

  function renderBatchCard(batch, idx) {
    const start = batch.startIndex + 1;
    const end = start + batch.entries.length - 1;
    const card = document.createElement('div');
    card.className = 'draft-result';
    card.setAttribute('role', 'listitem');

    const label = document.createElement('p');
    label.className = 'draft-result__path';
    label.textContent = 'Batch ' + (idx + 1) + ' \u2014 templates ' + start + '\u2013' + end;
    card.appendChild(label);

    const actions = document.createElement('div');
    actions.className = 'draft-result__actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'summit-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(entriesToText(batch.entries));
        showToast('Batch ' + (idx + 1) + ' copied to clipboard.');
      } catch (err) {
        showToast('Could not copy \u2014 try downloading instead.');
      }
    });
    actions.appendChild(copyBtn);

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'summit-btn summit-btn--primary';
    downloadBtn.textContent = 'Download .txt';
    downloadBtn.addEventListener('click', () => {
      downloadTextBlob(new Blob([entriesToText(batch.entries)], { type: 'text/plain' }),
        'draft-templates-' + pad2(idx + 1, 3) + '-' + draftTimestamp() + '.txt');
    });
    actions.appendChild(downloadBtn);

    card.appendChild(actions);
    return card;
  }

  function renderBatchList() {
    if (!batchListEl) return;
    batchListEl.innerHTML = '';
    if (batchCountEl) {
      batchCountEl.textContent = currentBatches.length === 0 ? '' :
        (currentBatches.length === 1 ? '1 batch' : currentBatches.length + ' batches');
    }
    if (batchZipBtn) batchZipBtn.hidden = currentBatches.length <= 1;

    if (currentBatches.length === 0) {
      batchListEl.appendChild(batchEmptyNote);
      return;
    }
    currentBatches.forEach((batch, idx) => batchListEl.appendChild(renderBatchCard(batch, idx)));
  }

  if (batchGenerateBtn) batchGenerateBtn.addEventListener('click', () => {
    const size = currentBatchSize();
    if (!size) { showToast('Enter a valid number of templates per batch.'); return; }
    const entries = getTemplateEntries();
    if (entries.length === 0) {
      showToast('No templates yet \u2014 attach one to a Sub-Enquiry in the Tag view.');
      currentBatches = [];
      renderBatchList();
      return;
    }
    currentBatches = [];
    for (let i = 0; i < entries.length; i += size) {
      currentBatches.push({ startIndex: i, entries: entries.slice(i, i + size) });
    }
    renderBatchList();
    showToast('Generated ' + currentBatches.length + ' batch' + (currentBatches.length === 1 ? '' : 'es') + '.');
  });

  if (batchZipBtn) batchZipBtn.addEventListener('click', async () => {
    if (currentBatches.length === 0) return;
    if (!window.JSZip) { showToast('Zip library not loaded.'); return; }
    const zip = new JSZip();
    currentBatches.forEach((batch, idx) => {
      zip.file('draft-templates-' + pad2(idx + 1, 3) + '.txt', entriesToText(batch.entries));
    });
    downloadTextBlob(await zip.generateAsync({ type: 'blob' }), 'draft-batches-' + draftTimestamp() + '.zip');
  });

  // ---------- Batch import (paste PATH:/KEYWORDS:/TEMPLATE: blocks) ----------

  function findOrCreateScheme(name) {
    const existing = state.schemeIds.map((id) => state.schemes[id]).find((s) => s.name === name);
    return existing ? existing.id : createScheme(name);
  }
  function findOrCreateCategory(schemeId, name) {
    const scheme = state.schemes[schemeId];
    const existing = scheme.categoryIds.map((id) => state.categories[id]).find((c) => c.name === name);
    return existing ? existing.id : createCategory(schemeId, name);
  }
  function findOrCreateEnquiry(categoryId, name) {
    const cat = state.categories[categoryId];
    const existing = cat.enquiryIds.map((id) => state.enquiries[id]).find((e) => e.name === name);
    return existing ? existing.id : createEnquiry(categoryId, name);
  }
  function findOrCreateSubEnquiry(enquiryId, name) {
    const enq = state.enquiries[enquiryId];
    const existing = enq.subEnquiryIds.map((id) => state.subEnquiries[id]).find((s) => s.name === name);
    return existing ? existing.id : createSubEnquiry(enquiryId, name);
  }

  function parseEntryBlocks(text) {
    return text.split(/\n?###END###\n?/).map((b) => b.trim()).filter(Boolean);
  }

  function parseEntry(block) {
    const pathMatch = block.match(/^PATH:\s*(.+)$/m);
    const keywordsMatch = block.match(/^KEYWORDS:\s*(.*)$/m);
    const labelMatch = block.match(/^LABEL:\s*(.*)$/m);
    const templateIdMatch = block.match(/^TEMPLATE_ID:\s*(.*)$/m);
    const templateNameMatch = block.match(/^TEMPLATE_NAME:\s*(.*)$/m);
    const templateKeywordsMatch = block.match(/^TEMPLATE_KEYWORDS:\s*(.*)$/m);
    const linksMatch = block.match(/^LINKS:\n([\s\S]*?)(?=^(?:FORMAT:|TEMPLATE:))/m);
    const formatMatch = block.match(/^FORMAT:\s*(.*)$/m);
    const templateMatch = block.match(/^TEMPLATE:\n([\s\S]*)$/m);
    if (!pathMatch || !templateMatch) return null;
    const segments = pathMatch[1].split('>').map((s) => s.trim()).filter(Boolean);
    if (segments.length !== 4) return null;
    const keywords = keywordsMatch ? keywordsMatch[1].split(',').map((k) => k.trim()).filter(Boolean) : [];
    // null (no LABEL:/LINKS: line at all) vs '' / absent-block ("line
    // present but empty") are kept distinct so import can tell
    // "not specified" (leave existing value alone) from "cleared".
    const label = labelMatch ? labelMatch[1].trim() : null;
    const labels = label === null ? null : (label ? label.split(',').map((s) => s.trim()).filter(Boolean) : []);
    const links = linksMatch
      ? linksMatch[1].split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
          const idx = line.indexOf('=>');
          if (idx === -1) return null;
          return { text: line.slice(0, idx).trim(), url: line.slice(idx + 2).trim() };
        }).filter(Boolean)
      : null;
    // null (no FORMAT: line — older export, or a hand-written import)
    // means "no rich formatting known"; import falls back to plain
    // text same as before rich formatting existed.
    const templateHtml = formatMatch ? sanitizeHtmlString(formatMatch[1].trim()) : null;
    // No TEMPLATE_ID: line means an older export written before ids
    // were carried through — import falls back to TEMPLATE_NAME (and,
    // failing that, "the sub's one template") to find a match.
    const templateId = templateIdMatch ? templateIdMatch[1].trim() : null;
    // No TEMPLATE_NAME: line means an older, single-template export —
    // treated as "unnamed" so import can fall back to updating a Sub-
    // Enquiry's one existing template in place (see importEntryText).
    const templateName = templateNameMatch ? templateNameMatch[1].trim() : null;
    // Same null-vs-empty distinction as LABEL: above — no
    // TEMPLATE_KEYWORDS: line (older export) leaves the template's
    // existing keywords untouched rather than clearing them.
    const templateKeywords = templateKeywordsMatch
      ? templateKeywordsMatch[1].split(',').map((k) => k.trim()).filter(Boolean)
      : null;
    return { path: segments, keywords, labels, links, templateHtml, templateId, templateName, templateKeywords, template: templateMatch[1].replace(/\n$/, '') };
  }

  function importEntryText(text) {
    const blocks = parseEntryBlocks(text);
    let created = 0, updated = 0, skipped = 0;
    blocks.forEach((block) => {
      const entry = parseEntry(block);
      if (!entry) { skipped += 1; return; }
      const [schemeName, catName, enqName, subName] = entry.path;
      const schemeId = findOrCreateScheme(schemeName);
      const categoryId = findOrCreateCategory(schemeId, catName);
      const enquiryId = findOrCreateEnquiry(categoryId, enqName);
      const existed = state.enquiries[enquiryId].subEnquiryIds
        .map((id) => state.subEnquiries[id]).some((s) => s.name === subName);
      const subId = findOrCreateSubEnquiry(enquiryId, subName);
      const sub = state.subEnquiries[subId];
      sub.keywords = entry.keywords;

      // Match an existing template primarily by its carried-through id
      // — the only identity that's safe to merge across two people's
      // independently-built data, since a display name like
      // "Template 1" is just an auto-incrementing label and two
      // different templates (yours and a colleague's) can easily share
      // one. An older export with no TEMPLATE_ID: line falls back to
      // matching by name *within the same tag-combo folder* — so a
      // same-named "Template 1" tagged differently is correctly
      // treated as a different template, not merged. A nameless (older
      // still, single-template) export instead updates the
      // Sub-Enquiry's one existing template in place — same behaviour
      // as before ids, tags or multiple templates existed. Anything
      // else creates a new template slot rather than guessing which
      // one to overwrite.
      const templates = subTemplates(sub);
      let tpl = entry.templateId ? templates.find((t) => t.id === entry.templateId) : null;
      if (!tpl && !entry.templateId && entry.templateName) {
        tpl = templates.find((t) => t.name === entry.templateName &&
          (entry.labels === null || sameFolder(templateLabels(t), entry.labels)));
      }
      if (!tpl && !entry.templateId && !entry.templateName && templates.length === 1) tpl = templates[0];
      if (!tpl) {
        // New template — numbered within whichever tag-combo folder
        // it's arriving with (untagged if LABEL: wasn't specified).
        const folderLabels = entry.labels !== null ? entry.labels : [];
        const folderSiblings = templatesInFolder(templates, folderLabels);
        const name = uniqueTemplateName(folderSiblings, entry.templateName || ('Template ' + (folderSiblings.length + 1)));
        // Keep the imported id (when there is one) rather than minting
        // a fresh local one, so importing an updated version of the
        // same file later still lands on this same template.
        tpl = { id: entry.templateId || uid('tpl'), name, template: '', templateHtml: '', templateLinks: [], keywords: [], labels: [] };
        templates.push(tpl);
      } else if (entry.templateName) {
        tpl.name = entry.templateName;
      }
      tpl.template = entry.template;
      // A re-export of an older entry (no FORMAT: line) shouldn't wipe
      // out rich formatting this template already has locally — only
      // overwrite templateHtml when the import actually specifies one.
      if (entry.templateHtml !== null) tpl.templateHtml = entry.templateHtml;
      if (entry.links !== null) tpl.templateLinks = entry.links;
      // Same "not specified means leave alone" rule as LABEL: — a
      // TEMPLATE_KEYWORDS: line always sets this template's own
      // keywords (even to empty); no line at all keeps whatever it had.
      if (entry.templateKeywords !== null) tpl.keywords = entry.templateKeywords;
      // LABEL: applies to this template specifically (see comment
      // above entryBlock) — not specified leaves its tags untouched.
      if (entry.labels !== null) tpl.labels = entry.labels;
      // Its tags may have just moved it into a different folder —
      // keep its name unique within that folder, only if it's now
      // actually colliding with a sibling there.
      resolveTemplateNameCollision(templates, tpl);
      if (existed) updated += 1; else created += 1;
    });
    refreshLabelDatalist();
    refreshFindLabelSelect();
    return { created, updated, skipped, total: blocks.length };
  }

  if (batchImportBtn) batchImportBtn.addEventListener('click', () => {
    const text = batchImportInput.value || '';
    if (!text.trim()) { showToast('Paste some exported template blocks first.'); return; }
    const result = importEntryText(text);
    if (result.total === 0) {
      batchImportStatusEl.textContent = 'Nothing recognisable to import \u2014 expected PATH:/KEYWORDS:/TEMPLATE: blocks.';
    } else {
      batchImportStatusEl.textContent = 'Imported ' + result.total + ' block' + (result.total === 1 ? '' : 's') +
        ' \u2014 ' + result.created + ' created, ' + result.updated + ' updated' +
        (result.skipped ? ', ' + result.skipped + ' skipped (unrecognised)' : '') + '.';
      showToast('Batch import complete.');
      renderAll();
      buildDeepIndex();
    }
  });

  // ============================================================
  // Categorization Editor — outline import/export
  //
  // Not part of the original spec; added on request. Add/rename/
  // delete of individual Scheme/Category/Enquiry/Sub-Enquiry nodes
  // already lives in the Hierarchy tree above (each node's ✎/✕
  // buttons). This adds a bulk, text-based round trip for the
  // *structure only* — names, no keywords or templates — so the
  // whole tree can be edited outside the site (a .txt file, a
  // spreadsheet with find/replace, etc.) and pasted back in.
  //
  // Format: one name per line, indented 2 spaces per level —
  // Scheme (0), Category (1), Enquiry (2), Sub-Enquiry (3). Blank
  // lines are ignored. Tabs are treated as 2 spaces.
  //
  // Import only ever finds-or-creates, same as the PATH: importer
  // above — it never deletes or renames existing nodes, even if a
  // line is missing or reworded on re-import. That keeps a bad
  // paste harmless, but it does mean renaming a node by editing the
  // exported text and reimporting will add a new node rather than
  // rename the old one; use the tree's ✎ button to rename in place.
  // ============================================================

  const hierarchyIoInput = document.getElementById('draft-hierarchy-io-input');
  const hierarchyIoStatus = document.getElementById('draft-hierarchy-io-status');
  const hierarchyExportBtn = document.getElementById('draft-hierarchy-export-btn');
  const hierarchyCopyBtn = document.getElementById('draft-hierarchy-copy-btn');
  const hierarchyImportBtn = document.getElementById('draft-hierarchy-import-btn');
  const hierarchyImportFileBtn = document.getElementById('draft-hierarchy-import-file-btn');
  const hierarchyImportFileInput = document.getElementById('draft-hierarchy-import-file');

  // The outline import/export panel used to sit permanently open
  // beneath the tree; it's now a popup modal (opened from the
  // "Import" button next to the tree's ⚡/+ buttons) so it doesn't
  // eat into the vertical space the hierarchy needs as it grows.
  const hierarchyIoBtn = document.getElementById('draft-hierarchy-io-btn');
  const hierarchyIoModal = document.getElementById('draft-hierarchy-io-modal');

  function openHierarchyIoModal() {
    if (!hierarchyIoModal) return;
    hierarchyIoModal.hidden = false;
    hierarchyIoModal.setAttribute('aria-hidden', 'false');
    hierarchyIoInput.focus();
  }

  function closeHierarchyIoModal() {
    if (!hierarchyIoModal) return;
    hierarchyIoModal.hidden = true;
    hierarchyIoModal.setAttribute('aria-hidden', 'true');
  }

  if (hierarchyIoBtn) hierarchyIoBtn.addEventListener('click', openHierarchyIoModal);
  if (hierarchyIoModal) {
    hierarchyIoModal.querySelectorAll('[data-hierarchy-io-close]').forEach((el) => {
      el.addEventListener('click', closeHierarchyIoModal);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !hierarchyIoModal.hidden) closeHierarchyIoModal();
    });
  }

  function hierarchyToOutline() {
    const lines = [];
    state.schemeIds.forEach((schemeId) => {
      const scheme = state.schemes[schemeId];
      lines.push(scheme.name);
      scheme.categoryIds.forEach((catId) => {
        const cat = state.categories[catId];
        lines.push('  ' + cat.name);
        cat.enquiryIds.forEach((enqId) => {
          const enq = state.enquiries[enqId];
          lines.push('    ' + enq.name);
          enq.subEnquiryIds.forEach((subId) => {
            lines.push('      ' + state.subEnquiries[subId].name);
          });
        });
      });
    });
    return lines.join('\n');
  }

  function indentDepth(line) {
    const normalized = line.replace(/\t/g, '  ');
    const leading = normalized.match(/^ */)[0].length;
    return Math.min(3, Math.round(leading / 2));
  }

  function importCategorizationOutline(text) {
    const chain = [null, null, null]; // [schemeId, categoryId, enquiryId]
    const created = [0, 0, 0, 0]; // scheme, category, enquiry, sub-enquiry
    let skipped = 0;
    let lineCount = 0;

    text.split('\n').forEach((raw) => {
      const name = raw.trim();
      if (!name) return;
      lineCount += 1;
      const depth = indentDepth(raw);

      if (depth === 0) {
        const before = state.schemeIds.length;
        chain[0] = findOrCreateScheme(name);
        chain[1] = null; chain[2] = null;
        if (state.schemeIds.length > before) created[0] += 1;
        return;
      }
      if (depth === 1) {
        if (!chain[0]) { skipped += 1; return; }
        const scheme = state.schemes[chain[0]];
        const before = scheme.categoryIds.length;
        chain[1] = findOrCreateCategory(chain[0], name);
        chain[2] = null;
        if (scheme.categoryIds.length > before) created[1] += 1;
        return;
      }
      if (depth === 2) {
        if (!chain[1]) { skipped += 1; return; }
        const cat = state.categories[chain[1]];
        const before = cat.enquiryIds.length;
        chain[2] = findOrCreateEnquiry(chain[1], name);
        if (cat.enquiryIds.length > before) created[2] += 1;
        return;
      }
      // depth === 3
      if (!chain[2]) { skipped += 1; return; }
      const enq = state.enquiries[chain[2]];
      const before = enq.subEnquiryIds.length;
      findOrCreateSubEnquiry(chain[2], name);
      if (enq.subEnquiryIds.length > before) created[3] += 1;
    });

    return { created, skipped, lineCount };
  }

  function runHierarchyImport(text) {
    if (!text || !text.trim()) {
      hierarchyIoStatus.textContent = 'Paste or load an outline first.';
      return;
    }
    const result = importCategorizationOutline(text);
    const [s, c, e, sub] = result.created;
    if (s + c + e + sub === 0 && result.skipped === 0) {
      hierarchyIoStatus.textContent = 'Nothing new — every line already matched an existing node.';
    } else {
      hierarchyIoStatus.textContent = 'Added ' + s + ' scheme' + (s === 1 ? '' : 's') + ', ' +
        c + ' categor' + (c === 1 ? 'y' : 'ies') + ', ' + e + ' enquir' + (e === 1 ? 'y' : 'ies') +
        ', ' + sub + ' sub-enquir' + (sub === 1 ? 'y' : 'ies') +
        (result.skipped ? ' \u2014 ' + result.skipped + ' line' + (result.skipped === 1 ? '' : 's') + ' skipped (indented under a missing parent).' : '.');
      showToast('Categorization outline imported.');
      renderAll();
      refreshFileSelects();
      buildDeepIndex();
    }
  }

  if (hierarchyExportBtn) hierarchyExportBtn.addEventListener('click', () => {
    if (state.schemeIds.length === 0) { hierarchyIoStatus.textContent = 'No categorization yet to export.'; return; }
    downloadTextBlob(new Blob([hierarchyToOutline()], { type: 'text/plain' }),
      'summit-categorization-' + draftTimestamp() + '.txt');
    markHierarchySaved();
  });

  if (hierarchyCopyBtn) hierarchyCopyBtn.addEventListener('click', async () => {
    if (state.schemeIds.length === 0) { hierarchyIoStatus.textContent = 'No categorization yet to export.'; return; }
    try {
      await navigator.clipboard.writeText(hierarchyToOutline());
      hierarchyIoStatus.textContent = 'Outline copied to clipboard.';
      showToast('Categorization outline copied.');
      markHierarchySaved();
    } catch (err) {
      showToast('Could not copy \u2014 try Export .txt instead.');
    }
  });

  if (hierarchyImportBtn) hierarchyImportBtn.addEventListener('click', () => {
    runHierarchyImport(hierarchyIoInput.value || '');
  });

  if (hierarchyImportFileBtn && hierarchyImportFileInput) {
    hierarchyImportFileBtn.addEventListener('click', () => hierarchyImportFileInput.click());
    hierarchyImportFileInput.addEventListener('change', async () => {
      const file = hierarchyImportFileInput.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        hierarchyIoInput.value = text;
        runHierarchyImport(text);
      } catch (err) {
        hierarchyIoStatus.textContent = 'Could not read that file.';
      } finally {
        hierarchyImportFileInput.value = '';
      }
    });
  }

  renderBatchList();

  renderPendingKeywords();
  refreshFileSelects();
  renderAll();

  // ============================================================
  // Section 12: Sub-Enquiry Name Helper
  // ============================================================
  // Keeps a clean, consistent naming convention for Sub-Enquiries:
  //
  //   [SC/PR/Foreigner/Anonymous] - [Main Subject Matter] : [Specific Topic]
  //   - [More detailed information, if necessary]
  //
  // (the line break between the two lines above is flattened to a
  // dash, since Sub-Enquiry names are stored as a single line).
  // Used anywhere a Sub-Enquiry name is created or renamed: the
  // "+" add button on an Enquiry node, the "Rename" button on a
  // Sub-Enquiry node, and the "+ New sub-enquiry…" option in the
  // quick-add cascading picker.

  const NAME_HELPER_STATUSES = ['SC', 'PR', 'Foreigner', 'Anonymous'];
  const NAME_HELPER_REQUEST_TYPES = ['request', 'enquiry'];

  let nameHelperEl = null;
  let nameHelperFields = null;
  let nameHelperOnConfirm = null;

  // "2nd", "3rd", "11th", "22nd"... (the 11-13 exception is the only
  // irregular case in English ordinals).
  function ordinalSuffix(n) {
    const v = n % 100;
    if (v >= 11 && v <= 13) return n + 'th';
    switch (n % 10) {
      case 1: return n + 'st';
      case 2: return n + 'nd';
      case 3: return n + 'rd';
      default: return n + 'th';
    }
  }

  // Pulls a trailing "(2nd request)" / "(3rd enquiry)" tag off the end
  // of a name, if present, so the rest of the name still parses the
  // normal way. Tolerates it being joined either with " - " (the way
  // buildSubEnquiryName writes it) or with just a space.
  function extractRequestTag(name) {
    const pattern = /\s*-?\s*\((\d+)(?:st|nd|rd|th)\s+(request|enquiry)\)\s*$/i;
    const m = name.match(pattern);
    if (!m) return { rest: name, requestNumber: null, requestType: '' };
    return {
      rest: name.slice(0, m.index),
      requestNumber: parseInt(m[1], 10),
      requestType: m[2].toLowerCase()
    };
  }

  function buildSubEnquiryName({ status, subject, topic, detail, requestNumber, requestType }) {
    const statusList = Array.isArray(status) ? status : (status ? [status] : []);
    // Always output in a fixed SC / PR / Foreigner order regardless of
    // the order the checkboxes were ticked in.
    status = NAME_HELPER_STATUSES.filter((s) => statusList.includes(s)).join('/');
    subject = (subject || '').trim();
    topic = (topic || '').trim();
    detail = (detail || '').trim();

    let head = status;
    if (subject) head = head ? head + ' - ' + subject : subject;
    if (topic) head = head ? head + ' : ' + topic : ': ' + topic;

    const parts = [];
    if (head) parts.push(head);

    if (detail) {
      // Any line breaks the user typed into the detail box are
      // themselves flattened to dashes too, so the stored name
      // always stays a single clean line.
      const detailFlat = detail
        .split(/\r\n|\r|\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join(' - ');
      if (detailFlat) parts.push(detailFlat);
    }

    const num = parseInt(requestNumber, 10);
    if (num > 0 && NAME_HELPER_REQUEST_TYPES.includes(requestType)) {
      parts.push('(' + ordinalSuffix(num) + ' ' + requestType + ')');
    }

    return parts.join(' - ');
  }

  function parseSubEnquiryName(name) {
    const result = { status: [], subject: '', topic: '', detail: '', requestNumber: null, requestType: '' };
    if (!name) return result;

    const { rest, requestNumber, requestType } = extractRequestTag(name);
    result.requestNumber = requestNumber;
    result.requestType = requestType;

    const segments = rest.split(' - ').map((s) => s.trim()).filter(Boolean);
    const firstTokens = segments.length ? segments[0].split('/').map((t) => t.trim()) : [];
    const isStatusSegment = firstTokens.length > 0 && firstTokens.every((t) => NAME_HELPER_STATUSES.includes(t));
    if (isStatusSegment) {
      result.status = firstTokens;
      if (segments.length >= 2) {
        const colonIdx = segments[1].indexOf(':');
        if (colonIdx !== -1) {
          result.subject = segments[1].slice(0, colonIdx).trim();
          result.topic = segments[1].slice(colonIdx + 1).trim();
        } else {
          result.subject = segments[1];
        }
      }
      if (segments.length >= 3) {
        result.detail = segments.slice(2).join(' - ');
      }
    } else if (segments.length) {
      // Doesn't match the convention (e.g. an old free-typed name) —
      // drop it whole into Main Subject Matter so nothing is lost,
      // and let the user restructure it if they want to.
      result.subject = rest.trim();
    }
    return result;
  }

  // Scans every Sub-Enquiry already in the hierarchy and pulls out the
  // distinct "Main Subject Matter" and "Specific Topic" values that have
  // been used before (parsed the same way parseSubEnquiryName reads a
  // name back apart). Feeding these back into the Name Helper as
  // suggestions keeps naming consistent — e.g. everyone reuses "Housing"
  // rather than one person typing "housing" and another "HOUSING issue".
  function collectNameHelperFieldValues() {
    const subjects = new Map(); // lowercase -> first-seen display form
    const topics = new Map();
    Object.keys(state.subEnquiries).forEach((id) => {
      const parsed = parseSubEnquiryName(state.subEnquiries[id].name);
      if (parsed.subject && !subjects.has(parsed.subject.toLowerCase())) {
        subjects.set(parsed.subject.toLowerCase(), parsed.subject);
      }
      if (parsed.topic && !topics.has(parsed.topic.toLowerCase())) {
        topics.set(parsed.topic.toLowerCase(), parsed.topic);
      }
    });
    const sortFn = (a, b) => a.localeCompare(b);
    return {
      subjects: Array.from(subjects.values()).sort(sortFn),
      topics: Array.from(topics.values()).sort(sortFn)
    };
  }

  // Existing Subject/Topic values, kept in module scope so the
  // Subject/Topic suggestion dropdowns (built once, in
  // ensureNameHelperModal) always read the latest list via their
  // getSuggestions callback — refreshed fresh every time the modal
  // opens so brand-new imports show up too.
  let nameHelperSubjects = [];
  let nameHelperTopics = [];

  function refreshNameHelperSuggestions() {
    const { subjects, topics } = collectNameHelperFieldValues();
    nameHelperSubjects = subjects;
    nameHelperTopics = topics;
  }

  function ensureNameHelperModal() {
    if (nameHelperEl) return nameHelperEl;

    const modal = document.createElement('div');
    modal.className = 'summit-modal draft-name-helper';
    modal.id = 'draft-name-helper-modal';
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML =
      '<div class="summit-modal__backdrop" data-name-helper-close></div>' +
      '<div class="summit-modal__panel draft-name-helper__panel" role="dialog" aria-modal="true" aria-labelledby="draft-name-helper-title">' +
        '<div class="summit-modal__header">' +
          '<h2 class="summit-modal__title" id="draft-name-helper-title">Sub-Enquiry Name Helper</h2>' +
          '<button type="button" class="summit-modal__close" data-name-helper-close aria-label="Close">\u2715</button>' +
        '</div>' +
        '<p class="draft-name-helper__hint">Builds: <span>Status - Main Subject : Specific Topic - Details - (2nd request)</span></p>' +

        '<label class="draft-field-label">Status</label>' +
        '<div class="draft-name-helper__checks" id="draft-name-helper-status" role="group" aria-label="Status">' +
          '<label class="draft-name-helper__check"><input type="checkbox" value="SC" /> SC</label>' +
          '<label class="draft-name-helper__check"><input type="checkbox" value="PR" /> PR</label>' +
          '<label class="draft-name-helper__check"><input type="checkbox" value="Foreigner" /> Foreigner</label>' +
          '<label class="draft-name-helper__check"><input type="checkbox" value="Anonymous" /> Anonymous</label>' +
        '</div>' +

        '<label class="draft-field-label" for="draft-name-helper-subject">Main Subject Matter</label>' +
        '<input type="text" class="draft-search-input draft-name-helper__input" id="draft-name-helper-subject" placeholder="e.g. Housing" autocomplete="off" />' +

        '<label class="draft-field-label" for="draft-name-helper-topic">Specific Topic <span>(if any)</span></label>' +
        '<input type="text" class="draft-search-input draft-name-helper__input" id="draft-name-helper-topic" placeholder="e.g. HDB Resale" autocomplete="off" />' +

        '<label class="draft-field-label" for="draft-name-helper-detail">More Detailed Information <span>(if necessary)</span></label>' +
        '<textarea class="draft-search-input draft-name-helper__textarea" id="draft-name-helper-detail" rows="3" placeholder="Optional extra detail\u2026 new lines become dashes"></textarea>' +

        '<label class="draft-field-label" for="draft-name-helper-request-number">Repeat tag <span>(if this is a 2nd, 3rd\u2026 request or enquiry on the same matter)</span></label>' +
        '<div class="draft-name-helper__request-row">' +
          '<input type="number" min="1" step="1" class="draft-search-input draft-name-helper__input draft-name-helper__request-number" id="draft-name-helper-request-number" placeholder="e.g. 2" />' +
          '<select class="summit-select draft-name-helper__request-type" id="draft-name-helper-request-type" aria-label="Request or enquiry">' +
            '<option value="">No tag</option>' +
            '<option value="request">request</option>' +
            '<option value="enquiry">enquiry</option>' +
          '</select>' +
        '</div>' +

        '<label class="draft-field-label" for="draft-name-helper-preview">Resulting Name</label>' +
        '<input type="text" class="draft-search-input draft-name-helper__preview" id="draft-name-helper-preview" placeholder="Fill in the fields above\u2026" />' +

        '<div class="summit-modal__actions">' +
          '<button type="button" class="summit-btn" data-name-helper-close>Cancel</button>' +
          '<button type="button" class="summit-btn summit-btn--primary" id="draft-name-helper-confirm">Use This Name</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    nameHelperFields = {
      status: Array.from(modal.querySelectorAll('#draft-name-helper-status input[type="checkbox"]')),
      subject: modal.querySelector('#draft-name-helper-subject'),
      topic: modal.querySelector('#draft-name-helper-topic'),
      detail: modal.querySelector('#draft-name-helper-detail'),
      requestNumber: modal.querySelector('#draft-name-helper-request-number'),
      requestType: modal.querySelector('#draft-name-helper-request-type'),
      preview: modal.querySelector('#draft-name-helper-preview')
    };

    // Existing Subject/Topic values used elsewhere in the hierarchy no
    // longer render as a growing row of chips underneath the fields —
    // instead they live in a scrollable, type-to-filter dropdown on
    // each field itself (same look as the cascading selects
    // elsewhere), so the list stays exactly as tall as one field no
    // matter how many subjects/topics pile up. Typing anything not in
    // the list is still just fine — these stay free text.
    enhanceSuggestInput(nameHelperFields.subject, () => nameHelperSubjects);
    enhanceSuggestInput(nameHelperFields.topic, () => nameHelperTopics);

    function getCheckedStatuses() {
      return nameHelperFields.status.filter((cb) => cb.checked).map((cb) => cb.value);
    }

    function recompute() {
      nameHelperFields.preview.value = buildSubEnquiryName({
        status: getCheckedStatuses(),
        subject: nameHelperFields.subject.value,
        topic: nameHelperFields.topic.value,
        detail: nameHelperFields.detail.value,
        requestNumber: nameHelperFields.requestNumber.value,
        requestType: nameHelperFields.requestType.value
      });
    }

    nameHelperFields.status.forEach((cb) => cb.addEventListener('change', recompute));
    [nameHelperFields.subject, nameHelperFields.topic, nameHelperFields.detail, nameHelperFields.requestNumber]
      .forEach((el) => el.addEventListener('input', recompute));
    nameHelperFields.requestType.addEventListener('change', recompute);

    modal.querySelectorAll('[data-name-helper-close]').forEach((el) => {
      el.addEventListener('click', closeNameHelper);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) closeNameHelper();
    });

    modal.querySelector('#draft-name-helper-confirm').addEventListener('click', () => {
      const finalName = nameHelperFields.preview.value.trim();
      if (!finalName) {
        nameHelperFields.subject.focus();
        return;
      }
      const onConfirm = nameHelperOnConfirm;
      closeNameHelper();
      if (onConfirm) onConfirm(finalName);
    });

    nameHelperEl = modal;
    return modal;
  }

  // Opens the Name Helper. `existingName` (pass '' for a brand new
  // Sub-Enquiry) is best-effort parsed back into the four fields so
  // renaming an already-conventional name is a quick tweak rather
  // than starting over. `onConfirm(name)` fires once, only when the
  // user confirms with a non-empty result — cancelling never calls it.
  function openNameHelper(existingName, onConfirm) {
    const modal = ensureNameHelperModal();
    refreshNameHelperSuggestions();
    const parsed = parseSubEnquiryName(existingName || '');
    nameHelperFields.status.forEach((cb) => { cb.checked = parsed.status.includes(cb.value); });
    nameHelperFields.subject.value = parsed.subject;
    nameHelperFields.topic.value = parsed.topic;
    nameHelperFields.detail.value = parsed.detail;
    nameHelperFields.requestNumber.value = parsed.requestNumber || '';
    nameHelperFields.requestType.value = parsed.requestType || '';
    nameHelperFields.preview.value = buildSubEnquiryName(parsed);
    nameHelperOnConfirm = onConfirm;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    if (nameHelperFields.status[0]) nameHelperFields.status[0].focus();
  }

  function closeNameHelper() {
    if (!nameHelperEl) return;
    nameHelperEl.hidden = true;
    nameHelperEl.setAttribute('aria-hidden', 'true');
    nameHelperOnConfirm = null;
  }

  // ============================================================
  // Public API (mirrors window.Summit.mountain / .peaks) — lets
  // Sections 6-8 read the same hierarchy without duplicating state.
  // ============================================================

  window.Summit.draft = {
    getHierarchy: () => state,
    isEmpty: () => state.schemeIds.length === 0,

    // Flat list of every Sub-Enquiry with its full breadcrumb path —
    // used by Summit Bot's /duplicate picker so it doesn't need to
    // walk the hierarchy itself.
    listSubEnquiries() {
      return Object.keys(state.subEnquiries).map((id) => ({
        id,
        name: state.subEnquiries[id].name,
        path: pathForSubEnquiry(id)
      })).sort((a, b) => a.name.localeCompare(b.name));
    },

    // Single Sub-Enquiry lookup with its breadcrumb path — used by
    // Summit Bot when the tree's + bullet hands one over to the chat.
    getSubEnquiry(id) {
      const sub = state.subEnquiries[id];
      if (!sub) return null;
      return { id, name: sub.name, path: pathForSubEnquiry(id), enquiryId: sub.enquiryId };
    },

    // Flat list of every Enquiry (folder) with its own breadcrumb path
    // — the destination list for Summit Bot's Move picker.
    listEnquiries() {
      return Object.keys(state.enquiries).map((id) => ({
        id,
        name: state.enquiries[id].name,
        path: pathForEnquiry(id)
      })).sort((a, b) => a.name.localeCompare(b.name));
    },

    // Moves a Sub-Enquiry into a different Enquiry folder in place —
    // no copy, no rename, keywords/template/label travel with it.
    // Returns true on success (including a no-op move to its current
    // folder), false if the Sub-Enquiry or target folder is gone.
    moveSubEnquiry(id, targetEnquiryId) {
      const sub = state.subEnquiries[id];
      const target = state.enquiries[targetEnquiryId];
      if (!sub || !target) return false;
      const oldEnq = state.enquiries[sub.enquiryId];
      if (oldEnq && oldEnq.id === target.id) return true;
      if (oldEnq) oldEnq.subEnquiryIds = oldEnq.subEnquiryIds.filter((sid) => sid !== id);
      sub.enquiryId = targetEnquiryId;
      target.subEnquiryIds.push(id);
      showToast('Moved "' + sub.name + '" to "' + target.name + '"');
      window.Summit.draft.focusSubEnquiry(id);
      return true;
    },

    // Duplicates a Sub-Enquiry in place (same Enquiry parent). By
    // default this is a bare copy: only the name carries over (as
    // "X (Copy)"), with empty keywords/templates/labels — same shape
    // as a freshly created Sub-Enquiry. Pass { withContents: true } to
    // also copy its keywords/templates/labels. Returns the new id, or
    // null if the source no longer exists. Refreshes the tree/detail
    // so the copy is visible immediately, whichever tab is showing.
    duplicateSubEnquiry(id, options) {
      const withContents = !!(options && options.withContents);
      const source = state.subEnquiries[id];
      if (!source) return null;
      const newId = uid('subenquiry');
      let name = source.name + ' (Copy)';
      const enq = state.enquiries[source.enquiryId];
      const siblingNames = new Set(enq.subEnquiryIds.map((sid) => state.subEnquiries[sid].name));
      let n = 2;
      while (siblingNames.has(name)) { name = source.name + ' (Copy ' + n + ')'; n += 1; }
      state.subEnquiries[newId] = {
        id: newId,
        name,
        enquiryId: source.enquiryId,
        keywords: withContents ? (source.keywords || []).slice() : [],
        templates: withContents ? subTemplates(source).map((t) => ({
          id: uid('tpl'),
          name: t.name,
          template: t.template || '',
          templateHtml: t.templateHtml || '',
          templateLinks: (t.templateLinks || []).map((l) => ({ text: l.text, url: l.url })),
          keywords: (t.keywords || []).slice(),
          labels: (t.labels || []).slice()
        })) : []
      };
      enq.subEnquiryIds.push(newId);
      const sourceIndex = enq.subEnquiryIds.indexOf(id);
      if (sourceIndex !== -1) {
        enq.subEnquiryIds.splice(enq.subEnquiryIds.indexOf(newId), 1);
        enq.subEnquiryIds.splice(sourceIndex + 1, 0, newId);
      }
      showToast(withContents ? 'Duplicated "' + name + '" with all contents' : 'Duplicated "' + name + '"');
      window.Summit.draft.focusSubEnquiry(newId);
      return newId;
    },

    // Exposed so other tabs can reuse the exact same stop-word/keyword
    // logic instead of re-implementing it (Section 9: Smart Sub-Enquiry
    // suggestions in Peaks).
    extractKeywords,

    // Given free text, returns the best-matching Sub-Enquiries ranked by
    // keyword overlap with each Sub-Enquiry's own tagged keywords — the
    // same Jaccard-style scoring Section 7's reverse search uses.
    matchSubEnquiries(text, limit) {
      const cap = limit || 3;
      const queryKeywords = extractKeywords(text || '');
      if (!queryKeywords.length) return [];
      const results = [];
      Object.keys(state.subEnquiries).forEach((id) => {
        const sub = state.subEnquiries[id];
        const { score } = keywordOverlapScore(queryKeywords, sub.keywords || []);
        if (score > 0) {
          results.push({
            id: sub.id,
            name: sub.name,
            path: pathForSubEnquiry(id),
            hasTemplate: subHasTemplates(sub),
            score
          });
        }
      });
      results.sort((a, b) => b.score - a.score);
      return results.slice(0, cap);
    },

    // Switches to the Draft tab, expands the tree to reveal `id`, and
    // selects it — used when a suggestion elsewhere in the app (e.g. a
    // Peaks cell link) is clicked.
    focusSubEnquiry(id) {
      const sub = state.subEnquiries[id];
      if (!sub) return false;
      const enq = state.enquiries[sub.enquiryId];
      const cat = enq ? state.categories[enq.categoryId] : null;
      const scheme = cat ? state.schemes[cat.schemeId] : null;
      [scheme, cat, enq].forEach((node) => { if (node) expandedIds.add(node.id); });
      state.selectedSubEnquiryId = id;

      const draftTabBtn = document.querySelector('.summit-tab[data-tab="draft"]');
      if (draftTabBtn) draftTabBtn.click();
      activateSubtab('tag');
      renderTree();

      requestAnimationFrame(() => {
        const row = treeEl.querySelector('.draft-node__row.is-selected');
        if (row) row.scrollIntoView({ block: 'center' });
      });
      return true;
    }
  };
})();
