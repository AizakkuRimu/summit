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
  state.subEnquiries = state.subEnquiries || {}; // id -> { id, name, enquiryId, keywords: [], template: '' }
  state.pendingKeywords = state.pendingKeywords || []; // current extract-session keyword list
  state.selectedSubEnquiryId = state.selectedSubEnquiryId || null;

  const expandedIds = new Set(); // runtime-only tree expand/collapse state

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
  const fileBtn = document.getElementById('draft-file-btn');

  const addSchemeBtn = document.getElementById('draft-add-scheme-btn');
  const quickAddBtn = document.getElementById('draft-quick-add-btn');
  const treeEl = document.getElementById('draft-tree');
  const treeEmptyNote = document.getElementById('draft-tree-empty');

  const detailEmpty = document.getElementById('draft-detail-empty');
  const detailContent = document.getElementById('draft-detail-content');
  const detailPath = document.getElementById('draft-detail-path');
  const detailKeywordsEl = document.getElementById('draft-detail-keywords');
  const labelInput = document.getElementById('draft-label-input');
  const labelDatalist = document.getElementById('draft-label-datalist');
  const templateInput = document.getElementById('draft-template-input');
  const templateSaveBtn = document.getElementById('draft-template-save-btn');
  const templateClearBtn = document.getElementById('draft-template-clear-btn');
  const templateLinkBtn = document.getElementById('draft-template-link-btn');
  const templateStatus = document.getElementById('draft-template-status');

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
  const expandedResultIds = new Set();

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
  let deepIndex = []; // [{ subId, keywords: [...] }] — one entry per Sub-Enquiry with a template
  const expandedDeepIds = new Set();

  let uidCounter = 0;
  function uid(prefix) {
    uidCounter += 1;
    return prefix + '-' + Date.now().toString(36) + '-' + uidCounter;
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
    state.subEnquiries[id] = { id, name, enquiryId, keywords: [], template: '', label: '' };
    state.enquiries[enquiryId].subEnquiryIds.push(id);
    return id;
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

  // ============================================================
  // 5.2 — Hierarchy tree (manual builder)
  // ============================================================

  function renderTree() {
    treeEl.innerHTML = '';
    if (state.schemeIds.length === 0) {
      treeEl.appendChild(treeEmptyNote);
      return;
    }
    state.schemeIds.forEach((schemeId) => {
      treeEl.appendChild(renderSchemeNode(schemeId));
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

  function makeNodeRow({ id, level, name, hasChildren, childCount, isSelected, onToggle, onSelect, onAdd, onRename, onDelete }) {
    const row = document.createElement('div');
    row.className = 'draft-node__row' + (isSelected ? ' is-selected' : '');
    row.setAttribute('role', 'treeitem');

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'draft-node__toggle' + (hasChildren ? '' : ' is-leaf');
    toggle.setAttribute('aria-label', hasChildren ? 'Expand/collapse' : '');
    toggle.textContent = hasChildren ? (expandedIds.has(id) ? '\u25BE' : '\u25B8') : '\u25B8';
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
    if (onAdd) actions.appendChild(makeActionButton('+', 'Add child', onAdd));
    actions.appendChild(makeActionButton('\u270E', 'Rename', onRename));
    actions.appendChild(makeActionButton('\u2715', 'Delete', onDelete));
    row.appendChild(actions);

    return row;
  }

  function renderSchemeNode(schemeId) {
    const scheme = state.schemes[schemeId];
    const wrap = document.createElement('div');
    wrap.className = 'draft-node';
    wrap.dataset.level = 'scheme';
    wrap.dataset.id = schemeId;

    const hasChildren = scheme.categoryIds.length > 0;
    const row = makeNodeRow({
      id: schemeId, level: 'scheme', name: scheme.name, hasChildren,
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

    if (hasChildren && expandedIds.has(schemeId)) {
      const children = document.createElement('div');
      children.className = 'draft-node__children';
      scheme.categoryIds.forEach((catId) => children.appendChild(renderCategoryNode(catId)));
      wrap.appendChild(children);
    }
    return wrap;
  }

  function renderCategoryNode(categoryId) {
    const cat = state.categories[categoryId];
    const wrap = document.createElement('div');
    wrap.className = 'draft-node';
    wrap.dataset.level = 'category';
    wrap.dataset.id = categoryId;

    const hasChildren = cat.enquiryIds.length > 0;
    const row = makeNodeRow({
      id: categoryId, level: 'category', name: cat.name, hasChildren,
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

    if (hasChildren && expandedIds.has(categoryId)) {
      const children = document.createElement('div');
      children.className = 'draft-node__children';
      cat.enquiryIds.forEach((enqId) => children.appendChild(renderEnquiryNode(enqId)));
      wrap.appendChild(children);
    }
    return wrap;
  }

  function renderEnquiryNode(enquiryId) {
    const enq = state.enquiries[enquiryId];
    const wrap = document.createElement('div');
    wrap.className = 'draft-node';
    wrap.dataset.level = 'enquiry';
    wrap.dataset.id = enquiryId;

    const hasChildren = enq.subEnquiryIds.length > 0;
    const row = makeNodeRow({
      id: enquiryId, level: 'enquiry', name: enq.name, hasChildren,
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

    if (hasChildren && expandedIds.has(enquiryId)) {
      const children = document.createElement('div');
      children.className = 'draft-node__children';
      enq.subEnquiryIds.forEach((subId) => children.appendChild(renderSubEnquiryNode(subId)));
      wrap.appendChild(children);
    }
    return wrap;
  }

  function renderSubEnquiryNode(subId) {
    const sub = state.subEnquiries[subId];
    const wrap = document.createElement('div');
    wrap.className = 'draft-node';
    wrap.dataset.level = 'subenquiry';
    wrap.dataset.id = subId;

    const row = makeNodeRow({
      id: subId, level: 'subenquiry', name: sub.name, hasChildren: false,
      childCount: sub.keywords.length,
      isSelected: state.selectedSubEnquiryId === subId,
      onToggle: () => {},
      onSelect: () => {
        state.selectedSubEnquiryId = subId;
        renderAll();
      },
      onRename: () => {
        openNameHelper(sub.name, (name) => {
          sub.name = name;
          renderAll();
        });
      },
      onDelete: () => {
        if (window.confirm('Delete sub-enquiry "' + sub.name + '"? Its template and keywords will be removed.')) {
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
    resetDownstreamSelects('category');
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
    updateFileButtonState();
  }

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
    if (!categoryId) { fileEnquirySel.innerHTML = ''; fileEnquirySel.disabled = true; fileSubSel.innerHTML = ''; fileSubSel.disabled = true; updateFileButtonState(); return; }
    const cat = state.categories[categoryId];
    fillSelect(
      fileEnquirySel,
      cat.enquiryIds.map((id) => ({ id, name: state.enquiries[id].name })),
      'Select enquiry\u2026', '+ New enquiry\u2026'
    );
    fileEnquirySel.disabled = false;
    fileSubSel.innerHTML = ''; fileSubSel.disabled = true;
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
    updateFileButtonState();
  });

  fileSubSel.addEventListener('change', () => {
    const enquiryId = fileEnquirySel.value;
    const val = fileSubSel.value;
    if (val === NEW_VALUE) {
      fileSubSel.value = '';
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
        updateFileButtonState();
      });
      return;
    }
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

  [fileSchemeSel, fileCategorySel, fileEnquirySel, fileSubSel].forEach((sel) => {
    enhanceSearchableSelect(sel, { newValue: NEW_VALUE });
  });

  fileBtn.addEventListener('click', () => {
    const subId = fileSubSel.value;
    if (!subId || subId === NEW_VALUE || state.pendingKeywords.length === 0) return;
    const sub = state.subEnquiries[subId];
    const merged = sub.keywords.slice();
    state.pendingKeywords.forEach((kw) => { if (!merged.includes(kw)) merged.push(kw); });
    sub.keywords = merged;
    state.selectedSubEnquiryId = subId;

    // Expand the tree down to the newly-filed sub-enquiry.
    const enq = state.enquiries[sub.enquiryId];
    const cat = state.categories[enq.categoryId];
    expandedIds.add(cat.schemeId);
    expandedIds.add(enq.categoryId);
    expandedIds.add(sub.enquiryId);

    showToast('Filed ' + state.pendingKeywords.length + ' keyword(s) to ' + pathForSubEnquiry(subId));
    renderAll();
  });

  // ============================================================
  // 5.3 — Detail panel: filed keywords + template linking
  // ============================================================

  function renderDetail() {
    const subId = state.selectedSubEnquiryId;
    const sub = subId ? state.subEnquiries[subId] : null;
    if (!sub) {
      detailEmpty.hidden = false;
      detailContent.hidden = true;
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

    labelInput.value = sub.label || '';
    templateInput.value = sub.template || '';
    templateStatus.textContent = sub.template ? 'Template attached.' : 'No template attached yet.';
    templateStatus.classList.toggle('is-saved', !!sub.template);
  }

  // ---------- Template Labellers ----------
  // Every Sub-Enquiry can carry a free-text label (a person's name or
  // a term) alongside its template — an extra axis of categorization
  // independent of the Scheme/Category/Enquiry/Sub-Enquiry hierarchy.
  // Persisted like everything else in state.subEnquiries, and rides
  // along with the existing PATH:/KEYWORDS:/TEMPLATE: import/export
  // format via a new LABEL: line (see Section 8 below).

  function allLabels() {
    return Array.from(new Set(
      Object.values(state.subEnquiries).map((s) => s.label).filter(Boolean)
    )).sort((a, b) => a.localeCompare(b));
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

  function htmlAnchorsToPlainText(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    normalizeWordPasteArtifacts(doc.body);
    collapseInsignificantWhitespace(doc.body);
    Array.from(doc.body.querySelectorAll('a[href]')).forEach((a) => {
      const href = (a.getAttribute('href') || '').trim();
      if (!href) return;
      const label = a.textContent.trim();
      const display = (label && label !== href) ? (label + ' (' + href + ')') : href;
      a.replaceWith(document.createTextNode(display));
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
    Array.from(doc.body.querySelectorAll('br')).forEach((br) => br.replaceWith('\n'));
    const blockSelector = 'p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote';
    Array.from(doc.body.querySelectorAll(blockSelector)).forEach((el) => {
      el.insertAdjacentText('afterend', '\n');
    });
    return (doc.body.textContent || '')
      .replace(/ {2,}/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+|\n+$/g, '')
      .trim();
  }

  function insertAtCursor(textarea, text) {
    const start = textarea.selectionStart == null ? textarea.value.length : textarea.selectionStart;
    const end = textarea.selectionEnd == null ? textarea.value.length : textarea.selectionEnd;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    textarea.value = before + text + after;
    const caret = start + text.length;
    textarea.setSelectionRange(caret, caret);
  }

  templateInput.addEventListener('paste', (e) => {
    const cd = e.clipboardData || window.clipboardData;
    if (!cd) return;
    const html = cd.getData('text/html');
    // Only bail to the default plain-text paste when there's no rich
    // markup to worry about at all. We used to only intervene when a
    // link was present, but Word/Outlook line-wrap and list artifacts
    // (see normalizeWordPasteArtifacts above) need the same cleanup
    // even when nothing in the paste is a hyperlink.
    if (!html) return;
    e.preventDefault();
    const text = htmlAnchorsToPlainText(html);
    let inserted = false;
    try { inserted = document.execCommand && document.execCommand('insertText', false, text); } catch (err) { inserted = false; }
    if (!inserted) insertAtCursor(templateInput, text);
  });

  if (templateLinkBtn) {
    templateLinkBtn.addEventListener('click', () => {
      const url = window.prompt('Link URL:');
      if (!url || !url.trim()) return;
      const label = window.prompt('Link text (leave blank to show the URL itself):', '');
      const trimmedUrl = url.trim();
      const trimmedLabel = (label || '').trim();
      const display = (trimmedLabel && trimmedLabel !== trimmedUrl)
        ? (trimmedLabel + ' (' + trimmedUrl + ')')
        : trimmedUrl;
      templateInput.focus();
      insertAtCursor(templateInput, display);
    });
  }

  templateSaveBtn.addEventListener('click', () => {
    const subId = state.selectedSubEnquiryId;
    if (!subId) return;
    const sub = state.subEnquiries[subId];
    sub.template = templateInput.value;
    sub.label = (labelInput.value || '').trim();
    templateStatus.textContent = 'Saved \u2014 linked to ' + sub.name +
      (sub.label ? ' \u2014 labelled "' + sub.label + '".' : '.');
    templateStatus.classList.add('is-saved');
    renderTree(); // badge counts etc. stay in sync
    refreshLabelDatalist();
    refreshFindLabelSelect();
    showToast('Template saved for ' + sub.name);
  });

  templateClearBtn.addEventListener('click', () => {
    const subId = state.selectedSubEnquiryId;
    if (!subId) return;
    const sub = state.subEnquiries[subId];
    if (!sub.template) return;
    if (!window.confirm('Remove the template attached to "' + sub.name + '"?')) return;
    sub.template = '';
    templateInput.value = '';
    templateStatus.textContent = 'No template attached yet.';
    templateStatus.classList.remove('is-saved');
    showToast('Template removed from ' + sub.name);
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
  function findMatches() {
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
      if (!sub.template) return; // Template Finder surfaces templates
      const enq = state.enquiries[sub.enquiryId];
      const cat = enq ? state.categories[enq.categoryId] : null;
      const scheme = cat ? state.schemes[cat.schemeId] : null;

      if (filters.subId && sub.id !== filters.subId) return;
      if (filters.enquiryId && (!enq || enq.id !== filters.enquiryId)) return;
      if (filters.categoryId && (!cat || cat.id !== filters.categoryId)) return;
      if (filters.schemeId && (!scheme || scheme.id !== filters.schemeId)) return;
      if (filters.label && sub.label !== filters.label) return;

      if (q) {
        const haystack = [scheme && scheme.name, cat && cat.name, enq && enq.name, sub.name,
          sub.keywords.join(' '), sub.label, sub.template].filter(Boolean).join(' \u2022 ').toLowerCase();
        if (!haystack.includes(q)) return;
      }

      results.push({ sub, enq, cat, scheme });
    });

    results.sort((a, b) => pathForSubEnquiry(a.sub.id).localeCompare(pathForSubEnquiry(b.sub.id)));
    return { results, q };
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

  function renderFindResults() {
    const { results, q } = findMatches();
    findResultsEl.innerHTML = '';
    findCountEl.textContent = results.length === 0 ? '' :
      (results.length === 1 ? '1 result' : results.length + ' results');

    if (results.length === 0) {
      const hasAnyTemplates = Object.values(state.subEnquiries).some((s) => s.template);
      findEmptyNote.textContent = hasAnyTemplates
        ? 'No templates match your search or filters.'
        : 'No templates yet — attach one to a Sub-Enquiry in the Tag view.';
      findResultsEl.appendChild(findEmptyNote);
      return;
    }

    results.forEach(({ sub }) => {
      findResultsEl.appendChild(renderResultCard(sub, q));
    });
  }

  function makeLabelBadge(sub) {
    if (!sub.label) return null;
    const badge = document.createElement('span');
    badge.className = 'draft-result__label';
    badge.textContent = sub.label;
    return badge;
  }

  function renderResultCard(sub, q) {
    const card = document.createElement('div');
    card.className = 'draft-result';
    card.setAttribute('role', 'listitem');

    const path = document.createElement('p');
    path.className = 'draft-result__path';
    path.textContent = pathForSubEnquiry(sub.id);
    card.appendChild(path);

    const labelBadge = makeLabelBadge(sub);
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

    const expanded = expandedResultIds.has(sub.id);
    const snippet = document.createElement('p');
    snippet.className = 'draft-result__snippet';
    const fullText = sub.template;
    const isLong = fullText.length > 160;
    const shown = expanded || !isLong ? fullText : fullText.slice(0, 160) + '\u2026';
    snippet.appendChild(highlightedFragment(shown, q));
    card.appendChild(snippet);

    if (isLong) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'draft-result__toggle';
      toggle.textContent = expanded ? 'Show less' : 'Show full template';
      toggle.addEventListener('click', () => {
        if (expanded) expandedResultIds.delete(sub.id); else expandedResultIds.add(sub.id);
        renderFindResults();
      });
      card.appendChild(toggle);
    }

    const actions = document.createElement('div');
    actions.className = 'draft-result__actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'summit-btn';
    copyBtn.textContent = 'Copy template';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(sub.template);
        showToast('Template copied to clipboard.');
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

  function computeReverseMatches() {
    const matches = [];
    Object.values(state.subEnquiries).forEach((sub) => {
      const { score, matched } = keywordOverlapScore(reverseKeywords, sub.keywords);
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

    const labelBadge = makeLabelBadge(sub);
    if (labelBadge) card.appendChild(labelBadge);

    if (sub.keywords.length > 0) {
      const kwWrap = document.createElement('div');
      kwWrap.className = 'draft-result__keywords';
      renderKeywordChips(kwWrap, document.createElement('span'), sub.keywords, { highlightSet: new Set(matched) });
      card.appendChild(kwWrap);
    }

    if (sub.template) {
      const expanded = expandedSet.has(sub.id);
      const snippet = document.createElement('p');
      snippet.className = 'draft-result__snippet';
      const isLong = sub.template.length > 160;
      snippet.textContent = expanded || !isLong ? sub.template : sub.template.slice(0, 160) + '\u2026';
      card.appendChild(snippet);

      if (isLong) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'draft-result__toggle';
        toggle.textContent = expanded ? 'Show less' : 'Show full template';
        toggle.addEventListener('click', () => {
          if (expanded) expandedSet.delete(sub.id); else expandedSet.add(sub.id);
          onRefresh();
        });
        card.appendChild(toggle);
      }
    } else {
      const note = document.createElement('p');
      note.className = 'draft-empty-note';
      note.textContent = 'No template attached to this Sub-Enquiry yet.';
      card.appendChild(note);
    }

    const actions = document.createElement('div');
    actions.className = 'draft-result__actions';

    if (sub.template) {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'summit-btn';
      copyBtn.textContent = 'Copy template';
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(sub.template);
          showToast('Template copied to clipboard.');
        } catch (err) {
          showToast('Could not copy — select and copy manually.');
        }
      });
      actions.appendChild(copyBtn);
    }

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'summit-btn summit-btn--primary';
    openBtn.textContent = sub.template ? 'Open in Tag view' : 'Go to Sub-Enquiry';
    openBtn.addEventListener('click', () => {
      state.selectedSubEnquiryId = sub.id;
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
      if (!sub.template || !sub.template.trim()) return;
      deepIndex.push({ subId: sub.id, keywords: extractKeywords(sub.template) });
    });
    const totalKeywords = deepIndex.reduce((sum, entry) => sum + entry.keywords.length, 0);
    deepIndexStatus.textContent = deepIndex.length === 0
      ? 'No templates to index yet \u2014 attach a template to a Sub-Enquiry in the Tag view first.'
      : 'Indexed ' + deepIndex.length + ' template' + (deepIndex.length === 1 ? '' : 's') + ' \u2022 ' + totalKeywords + ' keyword' + (totalKeywords === 1 ? '' : 's') + ' total.';
    renderDeepResults();
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
  // LABEL: person's name or term
  // TEMPLATE:
  // <template text, verbatim>
  // ###END###
  //
  // Plain ASCII '>' in PATH (distinct from the '\u203A' used for display
  // elsewhere) so import can split on it reliably. LABEL is optional on
  // import for backward compatibility with exports made before Template
  // Labellers existed — a block without a LABEL: line leaves any
  // existing label on that Sub-Enquiry untouched rather than blanking it.

  function entryBlock(sub) {
    const enq = state.enquiries[sub.enquiryId];
    const cat = enq ? state.categories[enq.categoryId] : null;
    const scheme = cat ? state.schemes[cat.schemeId] : null;
    const path = [scheme && scheme.name, cat && cat.name, enq && enq.name, sub.name].filter(Boolean).join(' > ');
    return 'PATH: ' + path + '\n' +
      'KEYWORDS: ' + sub.keywords.join(', ') + '\n' +
      'LABEL: ' + (sub.label || '') + '\n' +
      'TEMPLATE:\n' + sub.template + '\n' +
      '###END###';
  }

  function getTemplateEntries() {
    // "Templates" = Sub-Enquiries with a template attached, same
    // definition the Find/Search views use.
    return Object.values(state.subEnquiries)
      .filter((sub) => sub.template && sub.template.trim())
      .sort((a, b) => pathForSubEnquiry(a.id).localeCompare(pathForSubEnquiry(b.id)));
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
    const body = entries.map((sub) => {
      return '<h2>' + escapeHtmlLocal(pathForSubEnquiry(sub.id)) + '</h2>' +
        (sub.keywords.length ? '<p><em>Keywords: ' + escapeHtmlLocal(sub.keywords.join(', ')) + '</em></p>' : '') +
        '<p>' + escapeHtmlLocal(sub.template) + '</p>';
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
    const templateMatch = block.match(/^TEMPLATE:\n([\s\S]*)$/m);
    if (!pathMatch || !templateMatch) return null;
    const segments = pathMatch[1].split('>').map((s) => s.trim()).filter(Boolean);
    if (segments.length !== 4) return null;
    const keywords = keywordsMatch ? keywordsMatch[1].split(',').map((k) => k.trim()).filter(Boolean) : [];
    // null (no LABEL: line at all) vs '' (LABEL: present but empty) are
    // kept distinct so import can tell "not specified" from "cleared".
    const label = labelMatch ? labelMatch[1].trim() : null;
    return { path: segments, keywords, label, template: templateMatch[1].replace(/\n$/, '') };
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
      sub.template = entry.template;
      if (entry.label !== null) sub.label = entry.label;
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
  });

  if (hierarchyCopyBtn) hierarchyCopyBtn.addEventListener('click', async () => {
    if (state.schemeIds.length === 0) { hierarchyIoStatus.textContent = 'No categorization yet to export.'; return; }
    try {
      await navigator.clipboard.writeText(hierarchyToOutline());
      hierarchyIoStatus.textContent = 'Outline copied to clipboard.';
      showToast('Categorization outline copied.');
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
  //   [SC/PR or Foreigner] - [Main Subject Matter] : [Specific Topic]
  //   - [More detailed information, if necessary]
  //
  // (the line break between the two lines above is flattened to a
  // dash, since Sub-Enquiry names are stored as a single line).
  // Used anywhere a Sub-Enquiry name is created or renamed: the
  // "+" add button on an Enquiry node, the "Rename" button on a
  // Sub-Enquiry node, and the "+ New sub-enquiry…" option in the
  // quick-add cascading picker.

  const NAME_HELPER_STATUSES = ['SC', 'PR', 'Foreigner'];

  let nameHelperEl = null;
  let nameHelperFields = null;
  let nameHelperOnConfirm = null;

  function buildSubEnquiryName({ status, subject, topic, detail }) {
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

    return parts.join(' - ');
  }

  function parseSubEnquiryName(name) {
    const result = { status: [], subject: '', topic: '', detail: '' };
    if (!name) return result;

    const segments = name.split(' - ').map((s) => s.trim()).filter(Boolean);
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
    } else {
      // Doesn't match the convention (e.g. an old free-typed name) —
      // drop it whole into Main Subject Matter so nothing is lost,
      // and let the user restructure it if they want to.
      result.subject = name;
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

  // Repopulates the Subject/Topic <datalist> options (native
  // type-ahead) and the row of clickable chips underneath the fields
  // (one-tap reuse) from whatever is currently in the hierarchy. Called
  // fresh every time the modal opens so brand-new imports show up too.
  function refreshNameHelperSuggestions() {
    if (!nameHelperFields) return;
    const { subjects, topics } = collectNameHelperFieldValues();

    nameHelperFields.subjectList.innerHTML = subjects
      .map((s) => '<option value="' + escapeHtmlLocal(s) + '"></option>').join('');
    nameHelperFields.topicList.innerHTML = topics
      .map((t) => '<option value="' + escapeHtmlLocal(t) + '"></option>').join('');

    const chip = (field, value) =>
      '<button type="button" class="draft-name-helper__chip" data-fill-field="' + field +
      '" data-fill-value="' + escapeHtmlLocal(value) + '">' + escapeHtmlLocal(value) + '</button>';

    if (!subjects.length && !topics.length) {
      nameHelperFields.existingHint.innerHTML = '';
      return;
    }
    let html = '';
    if (subjects.length) {
      html += '<span class="draft-name-helper__chip-label">Existing subjects:</span> ' +
        subjects.slice(0, 20).map((s) => chip('subject', s)).join(' ');
    }
    if (topics.length) {
      html += '<br><span class="draft-name-helper__chip-label">Existing topics:</span> ' +
        topics.slice(0, 20).map((t) => chip('topic', t)).join(' ');
    }
    nameHelperFields.existingHint.innerHTML = html;
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
        '<p class="draft-name-helper__hint">Builds: <span>Status - Main Subject : Specific Topic - Details</span></p>' +

        '<label class="draft-field-label">Status</label>' +
        '<div class="draft-name-helper__checks" id="draft-name-helper-status" role="group" aria-label="Status">' +
          '<label class="draft-name-helper__check"><input type="checkbox" value="SC" /> SC</label>' +
          '<label class="draft-name-helper__check"><input type="checkbox" value="PR" /> PR</label>' +
          '<label class="draft-name-helper__check"><input type="checkbox" value="Foreigner" /> Foreigner</label>' +
        '</div>' +

        '<label class="draft-field-label" for="draft-name-helper-subject">Main Subject Matter</label>' +
        '<input type="text" class="draft-search-input draft-name-helper__input" id="draft-name-helper-subject" placeholder="e.g. Housing" list="draft-name-helper-subject-list" autocomplete="off" />' +
        '<datalist id="draft-name-helper-subject-list"></datalist>' +

        '<label class="draft-field-label" for="draft-name-helper-topic">Specific Topic <span>(if any)</span></label>' +
        '<input type="text" class="draft-search-input draft-name-helper__input" id="draft-name-helper-topic" placeholder="e.g. HDB Resale" list="draft-name-helper-topic-list" autocomplete="off" />' +
        '<datalist id="draft-name-helper-topic-list"></datalist>' +
        '<p class="draft-name-helper__existing-hint" id="draft-name-helper-existing-hint"></p>' +

        '<label class="draft-field-label" for="draft-name-helper-detail">More Detailed Information <span>(if necessary)</span></label>' +
        '<textarea class="draft-search-input draft-name-helper__textarea" id="draft-name-helper-detail" rows="3" placeholder="Optional extra detail\u2026 new lines become dashes"></textarea>' +

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
      preview: modal.querySelector('#draft-name-helper-preview'),
      subjectList: modal.querySelector('#draft-name-helper-subject-list'),
      topicList: modal.querySelector('#draft-name-helper-topic-list'),
      existingHint: modal.querySelector('#draft-name-helper-existing-hint')
    };

    nameHelperFields.existingHint.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-fill-field]');
      if (!chip) return;
      const field = chip.getAttribute('data-fill-field');
      const value = chip.getAttribute('data-fill-value') || '';
      if (field === 'subject') nameHelperFields.subject.value = value;
      if (field === 'topic') nameHelperFields.topic.value = value;
      recompute();
    });

    function getCheckedStatuses() {
      return nameHelperFields.status.filter((cb) => cb.checked).map((cb) => cb.value);
    }

    function recompute() {
      nameHelperFields.preview.value = buildSubEnquiryName({
        status: getCheckedStatuses(),
        subject: nameHelperFields.subject.value,
        topic: nameHelperFields.topic.value,
        detail: nameHelperFields.detail.value
      });
    }

    nameHelperFields.status.forEach((cb) => cb.addEventListener('change', recompute));
    [nameHelperFields.subject, nameHelperFields.topic, nameHelperFields.detail]
      .forEach((el) => el.addEventListener('input', recompute));

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
            hasTemplate: Boolean(sub.template),
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
