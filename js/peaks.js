/* ---------------------------------------------------------
   Summit — peaks.js
   Section 3: Peaks tab (Excel-style grid editor).

   - 3.1 Grid interaction — click/drag cell & range selection,
         column letters (A, B, ... AA, AB, ...) and row numbers,
         always-visible sticky headers, grid that grows as the
         user scrolls near an edge.
   - 3.2 Cell sizing & appearance — draggable column/row resize,
         cell background colour, per-edge border styling.

   (3.3 data lifecycle/import-export hooks land with Section 4.)

   Section 9 (future development, built early): Smart Sub-Enquiry
   suggestions. Selecting a single cell reads the cell immediately to
   its left and, if Draft has any tagged Sub-Enquiries, shows the
   closest keyword matches in a small popover. Picking one turns the
   current cell into an internal link back to that Sub-Enquiry in the
   Draft tab, reusing the existing peaks-link machinery (Section 2.4 /
   6.2) rather than inventing a second link type.

   Content lives directly in the DOM under #peaks-grid, which
   sits inside the (hidden-not-removed) Peaks panel — so
   switching tabs (Section 1) never loses this tab's work.
--------------------------------------------------------- */

(function () {
  'use strict';

  const ROWS_INITIAL = 50;
  const COLS_INITIAL = 30;
  const ROWS_CHUNK = 25;
  const COLS_CHUNK = 10;
  const DEFAULT_COL_WIDTH = 220; // fits ~5 average words per wrapped line, incl. padding
  const DEFAULT_ROW_HEIGHT = 26;
  const WRAP_ROW_HEIGHT = 100; // auto-height applied the first time a row is wrapped
  const MIN_COL_WIDTH = 32;
  const MIN_ROW_HEIGHT = 18;
  const GROW_THRESHOLD = 300; // px from edge that triggers growth

  const scrollEl = document.getElementById('peaks-scroll');
  const grid = document.getElementById('peaks-grid');
  const colgroup = document.getElementById('peaks-colgroup');
  const headerRow = document.getElementById('peaks-header-row');
  const corner = document.getElementById('peaks-corner');
  const tbody = document.getElementById('peaks-body');
  const cellRefEl = document.getElementById('peaks-cellref');
  const fillInput = document.getElementById('peaks-fill-color');
  const fillGlyph = document.getElementById('peaks-fill-glyph');
  const borderStyleSelect = document.getElementById('peaks-border-style');
  const clipTrap = document.getElementById('peaks-clip-trap');
  const undoBtn = document.getElementById('peaks-undo');
  const redoBtn = document.getElementById('peaks-redo');
  const suggestBox = document.getElementById('peaks-suggest');
  const suggestList = document.getElementById('peaks-suggest-list');
  const suggestSourceEl = document.getElementById('peaks-suggest-source');
  const suggestDismissBtn = document.getElementById('peaks-suggest-dismiss');
  const generateBtn = document.getElementById('peaks-generate-btn');
  const generateStatusEl = document.getElementById('peaks-generate-status');
  const splitToggle = document.getElementById('peaks-split-toggle');
  const splitView = document.getElementById('peaks-split-view');

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

  let numRows = 0;
  let numCols = 0;
  const colWidths = [];
  const rowHeights = [];
  const cellsEl = [];      // cellsEl[r][c] -> td
  const rowHeaderEls = []; // rowHeaderEls[r] -> th
  const colHeaderEls = []; // colHeaderEls[c] -> th

  let selection = null;   // { r1, c1, r2, c2 } — the active/most-recent range
  let extraRanges = [];   // additional ranges frozen in via Shift+click, forming a multi-selection
  let anchor = null;      // { r, c } — where the current drag/selection began
  let primaryCell = null; // { r, c } — the cell currently showing the primary ring
  let isSelecting = false;
  let editingCell = null; // { r, c, td, previousValue }
  let colResize = null;   // { c, startX, startWidth }
  let rowResize = null;   // { r, startY, startHeight }

  // ============================================================
  // Column labelling — A, B, ... Z, AA, AB, ... (Section 3.1)
  // ============================================================

  function colLabel(index) {
    let n = index + 1;
    let s = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  // ============================================================
  // Grid construction & growth
  // ============================================================

  function addCellToRow(r, c) {
    const tr = tbody.children[r];
    const td = document.createElement('td');
    td.className = 'peaks-cell';
    td.tabIndex = -1;
    td.dataset.row = r;
    td.dataset.col = c;
    tr.appendChild(td);
    cellsEl[r][c] = td;
  }

  // A sticky <th> (position: sticky; top: 0) only reliably keeps a column's
  // width if the width is set on the <th> itself. Relying solely on the
  // <colgroup><col> width — which is all addColumns/resizing used to do —
  // works fine for the body cells (table-layout: fixed honours it there
  // because they aren't sticky) but sticky header cells can re-layout to
  // fit their content (the bare column letter) as they repaint while
  // scrolling past, which is exactly the "shrinking column lines" bug.
  // Row headers never had this problem because row height is already set
  // directly on the <tr> itself. Routing every width change through this
  // one function keeps <col> and <th> in sync, the same way rows already
  // work.
  function setColWidth(c, w) {
    colWidths[c] = w;
    const col = colgroup.children[c + 1];
    if (col) col.style.width = w + 'px';
    const th = colHeaderEls[c];
    if (th) {
      th.style.width = w + 'px';
      th.style.minWidth = w + 'px';
      th.style.maxWidth = w + 'px';
    }
  }

  function setRowHeight(r, h) {
    rowHeights[r] = h;
    const tr = tbody.children[r];
    if (tr) tr.style.height = h + 'px';
  }

  function addColumns(count) {
    for (let i = 0; i < count; i++) {
      const c = numCols;

      const col = document.createElement('col');
      colgroup.appendChild(col);

      const th = document.createElement('th');
      th.className = 'peaks-colhead';
      th.scope = 'col';
      th.dataset.col = c;
      const label = document.createElement('span');
      label.className = 'peaks-colhead__label';
      label.textContent = colLabel(c);
      th.appendChild(label);
      const handle = document.createElement('div');
      handle.className = 'peaks-colhead__resize';
      th.appendChild(handle);
      headerRow.appendChild(th);
      colHeaderEls[c] = th;
      setColWidth(c, DEFAULT_COL_WIDTH);

      for (let r = 0; r < numRows; r++) addCellToRow(r, c);
      numCols++;
    }
  }

  function addRows(count) {
    for (let i = 0; i < count; i++) {
      const r = numRows;
      cellsEl[r] = [];

      const tr = document.createElement('tr');

      const th = document.createElement('th');
      th.className = 'peaks-rowhead';
      th.scope = 'row';
      th.dataset.row = r;
      th.textContent = String(r + 1);
      const handle = document.createElement('div');
      handle.className = 'peaks-rowhead__resize';
      th.appendChild(handle);
      tr.appendChild(th);

      tbody.appendChild(tr);
      rowHeaderEls[r] = th;
      setRowHeight(r, DEFAULT_ROW_HEIGHT);

      for (let c = 0; c < numCols; c++) addCellToRow(r, c);
      numRows++;
    }
  }

  let growPending = false;
  function checkGrow() {
    if (growPending) return;
    growPending = true;
    requestAnimationFrame(() => {
      const distBottom = scrollEl.scrollHeight - (scrollEl.scrollTop + scrollEl.clientHeight);
      const distRight = scrollEl.scrollWidth - (scrollEl.scrollLeft + scrollEl.clientWidth);
      if (distBottom < GROW_THRESHOLD) addRows(ROWS_CHUNK);
      if (distRight < GROW_THRESHOLD) addColumns(COLS_CHUNK);
      growPending = false;
    });
  }

  // ============================================================
  // Selection (Section 3.1)
  // ============================================================

  function forRange(sel, fn) {
    for (let r = sel.r1; r <= sel.r2; r++) {
      for (let c = sel.c1; c <= sel.c2; c++) fn(r, c);
    }
  }

  function paintSelection(sel, add) {
    forRange(sel, (r, c) => {
      cellsEl[r][c].classList.toggle('peaks-cell--selected', add);
    });
    for (let c = sel.c1; c <= sel.c2; c++) colHeaderEls[c].classList.toggle('peaks-header--active', add);
    for (let r = sel.r1; r <= sel.r2; r++) rowHeaderEls[r].classList.toggle('peaks-header--active', add);
  }

  function setSelection(r1, c1, r2, c2) {
    hideCutGapMenu();
    if (selection) paintSelection(selection, false);
    if (primaryCell) cellsEl[primaryCell.r][primaryCell.c].classList.remove('peaks-cell--primary');

    selection = {
      r1: Math.min(r1, r2), r2: Math.max(r1, r2),
      c1: Math.min(c1, c2), c2: Math.max(c1, c2)
    };
    paintSelection(selection, true);
    primaryCell = { r: r1, c: c1 };
    cellsEl[r1][c1].classList.add('peaks-cell--primary');
    updateCellRef();
    syncToolbarState();
    updateSmartSuggestions();
  }

  function primaryTd() {
    return primaryCell ? cellsEl[primaryCell.r][primaryCell.c] : null;
  }

  // Focuses `td` just long enough to trigger the browser's normal
  // scroll-into-view behaviour, then hands real DOM focus to the hidden
  // clipboard-trap textarea. Cell *selection* (as opposed to actively
  // editing a cell) should never leave a plain, non-editable <td> holding
  // focus — some browsers won't fire paste/copy/cut on that, only on a
  // genuinely editable element. See .peaks-clip-trap in peaks.css.
  function focusCellVisually(td) {
    if (!td) return;
    td.focus({ preventScroll: false });
    if (clipTrap) clipTrap.focus({ preventScroll: true });
  }

  function updateCellRef() {
    if (!selection) { cellRefEl.textContent = ''; return; }
    const a = colLabel(selection.c1) + (selection.r1 + 1);
    if (selection.r1 === selection.r2 && selection.c1 === selection.c2) {
      cellRefEl.textContent = a;
    } else {
      cellRefEl.textContent = a + ':' + colLabel(selection.c2) + (selection.r2 + 1);
    }
  }

  // Every currently-selected range: the live/active `selection` plus any
  // ranges frozen in via Shift+click (Section 3.1 multi-selection).
  function allSelectedRanges() {
    return selection ? extraRanges.concat([selection]) : extraRanges.slice();
  }

  function forEachSelectedCell(fn) {
    const seen = new Set();
    allSelectedRanges().forEach((sel) => {
      forRange(sel, (r, c) => {
        const key = r + '_' + c;
        if (seen.has(key)) return;
        seen.add(key);
        fn(cellsEl[r][c], r, c);
      });
    });
  }

  function coordsForSelection(sel) {
    const list = [];
    if (!sel) return list;
    forRange(sel, (r, c) => list.push({ r, c }));
    return list;
  }

  // Union of coordinates across every selected range (active + frozen),
  // de-duplicated — used so formatting/edit actions cover a whole
  // Shift+click multi-selection, not just the most recently clicked range.
  function coordsForAllSelections() {
    const seen = new Set();
    const list = [];
    allSelectedRanges().forEach((sel) => {
      forRange(sel, (r, c) => {
        const key = r + '_' + c;
        if (seen.has(key)) return;
        seen.add(key);
        list.push({ r, c });
      });
    });
    return list;
  }

  // Unpaints and discards any frozen multi-selection ranges — called
  // whenever a plain (non-Shift) click/drag starts a fresh selection.
  function clearExtraRanges() {
    if (!extraRanges.length) return;
    extraRanges.forEach((r) => paintSelection(r, false));
    extraRanges = [];
  }

  // Moves the current active `selection` into the frozen extraRanges list
  // so a following setSelection() call for the new range leaves it (and
  // every other already-frozen range) highlighted rather than clearing it.
  function freezeCurrentSelection() {
    if (selection) extraRanges.push(selection);
  }

  // setSelection() always unpaints whatever the active `selection` was
  // before painting the new one — including a range that was just frozen
  // into extraRanges by the call above. Re-painting every frozen range
  // afterward keeps the whole multi-selection visibly highlighted.
  function repaintExtraRanges() {
    extraRanges.forEach((r) => paintSelection(r, true));
  }

  // ============================================================
  // Undo / redo history
  //
  // Granularity matches Excel/Sheets: one step per *committed*
  // action (a finished cell edit, a formatting button click, a
  // paste, etc.) rather than per keystroke. Every mutating action
  // in the app funnels through withHistory()/beginHistory()+
  // commitHistory() below so Ctrl+Z / Ctrl+Y undoes it uniformly,
  // whether it touched content, styling, merges, or a paste.
  // ============================================================

  const HISTORY_LIMIT = 100;
  const TRANSIENT_CLASSES = new Set(['peaks-cell--selected', 'peaks-cell--primary', 'peaks-cell--editing']);
  let undoStack = [];
  let redoStack = [];
  let isApplyingHistory = false;

  function snapshotCell(r, c) {
    const td = cellsEl[r][c];
    return {
      r, c,
      html: td.innerHTML,
      style: td.getAttribute('style') || '',
      dataClasses: Array.from(td.classList).filter((cls) => !TRANSIENT_CLASSES.has(cls)),
      rowSpan: td.rowSpan || 1,
      colSpan: td.colSpan || 1
    };
  }

  function snapshotCells(coords) {
    return coords.map(({ r, c }) => snapshotCell(r, c));
  }

  function snapshotsEqual(a, b) {
    return a.html === b.html && a.style === b.style && a.rowSpan === b.rowSpan &&
      a.colSpan === b.colSpan && a.dataClasses.join(' ') === b.dataClasses.join(' ');
  }

  function restoreCellSnapshot(snap) {
    const td = cellsEl[snap.r][snap.c];
    td.innerHTML = snap.html;
    if (snap.style) td.setAttribute('style', snap.style); else td.removeAttribute('style');
    // Keep whatever transient selection/editing classes are currently on
    // the cell — those describe the *current* UI state, not the data,
    // and restoring an old snapshot shouldn't fight with live selection.
    const transientNow = Array.from(td.classList).filter((cls) => TRANSIENT_CLASSES.has(cls));
    td.className = snap.dataClasses.concat(transientNow).join(' ');
    td.rowSpan = snap.rowSpan;
    td.colSpan = snap.colSpan;
  }

  // ---------- Cut: shifting neighbouring cells into the vacated gap ----------
  //
  // Used right after a Cut has cleared its source range, if the person
  // picks "Shift cells left" / "Shift cells up" from the small chooser
  // that appears afterward. Moves each cell's full appearance (text,
  // links, styling) — reuses the same snapshot/restore shape as undo.

  function moveCellContent(fromR, fromC, toR, toC) {
    const snap = snapshotCell(fromR, fromC);
    snap.r = toR;
    snap.c = toC;
    restoreCellSnapshot(snap);
  }

  function clearCellContent(r, c) {
    const td = cellsEl[r][c];
    td.innerHTML = '';
    td.removeAttribute('style');
    const transientNow = Array.from(td.classList).filter((cls) => TRANSIENT_CLASSES.has(cls));
    td.className = ['peaks-cell'].concat(transientNow).join(' ');
    td.rowSpan = 1;
    td.colSpan = 1;
  }

  // Pulls every cell to the right of `range` (within its row-span) left by
  // the range's width, leaving the trailing columns blank — mirrors
  // Excel's "Delete → Shift cells left".
  function shiftRangeLeft(range) {
    const width = range.c2 - range.c1 + 1;
    for (let r = range.r1; r <= range.r2; r++) {
      for (let c = range.c1; c < numCols; c++) {
        const srcC = c + width;
        if (srcC < numCols) moveCellContent(r, srcC, r, c);
        else clearCellContent(r, c);
      }
    }
  }

  // Pulls every cell below `range` (within its col-span) up by the
  // range's height, leaving the trailing rows blank — mirrors Excel's
  // "Delete → Shift cells up".
  function shiftRangeUp(range) {
    const height = range.r2 - range.r1 + 1;
    for (let c = range.c1; c <= range.c2; c++) {
      for (let r = range.r1; r < numRows; r++) {
        const srcR = r + height;
        if (srcR < numRows) moveCellContent(srcR, c, r, c);
        else clearCellContent(r, c);
      }
    }
  }

  function coordsForShiftLeft(range) {
    const list = [];
    for (let r = range.r1; r <= range.r2; r++) {
      for (let c = range.c1; c < numCols; c++) list.push({ r, c });
    }
    return list;
  }

  function coordsForShiftUp(range) {
    const list = [];
    for (let c = range.c1; c <= range.c2; c++) {
      for (let r = range.r1; r < numRows; r++) list.push({ r, c });
    }
    return list;
  }

  function syncMergedMastersFor(coords) {
    coords.forEach(({ r, c }) => {
      const td = cellsEl[r][c];
      const key = r + ',' + c;
      if (td.classList.contains('peaks-cell--merge-master')) mergedMasters.add(key);
      else mergedMasters.delete(key);
    });
  }

  function updateHistoryButtons() {
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
  }

  function pushHistoryEntry(before, after) {
    const changed = before.some((b, i) => !snapshotsEqual(b, after[i]));
    if (!changed) return;
    undoStack.push({ before, after });
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
    updateHistoryButtons();
  }

  // For actions that happen in one synchronous call (button clicks, paste,
  // delete, etc.) — snapshots before and after `fn()` runs, in one go.
  function withHistory(coords, fn) {
    if (isApplyingHistory || !coords || !coords.length) { fn(); return; }
    const before = snapshotCells(coords);
    fn();
    pushHistoryEntry(before, snapshotCells(coords));
  }

  // For actions that stream over time (dragging the fill-colour picker) —
  // call beginHistory() once at the start of the gesture and commitHistory()
  // once it ends, so the whole drag becomes a single undo step.
  function beginHistory(coords) {
    return { coords, before: snapshotCells(coords) };
  }

  function commitHistory(pending) {
    if (!pending || !pending.coords.length) return;
    pushHistoryEntry(pending.before, snapshotCells(pending.coords));
  }

  function applySnapshotSet(list) {
    isApplyingHistory = true;
    list.forEach(restoreCellSnapshot);
    isApplyingHistory = false;
    syncMergedMastersFor(list);
    syncToolbarState();
  }

  function undo() {
    if (editingCell) commitEdit();
    if (!undoStack.length) return;
    const entry = undoStack.pop();
    applySnapshotSet(entry.before);
    redoStack.push(entry);
    updateHistoryButtons();
  }

  function redo() {
    if (editingCell) commitEdit();
    if (!redoStack.length) return;
    const entry = redoStack.pop();
    applySnapshotSet(entry.after);
    undoStack.push(entry);
    updateHistoryButtons();
  }

  // ============================================================
  // Editing
  // ============================================================

  function startEditing(r, c, opts) {
    opts = opts || {};
    if (editingCell) commitEdit();
    const td = cellsEl[r][c];
    editingCell = { r, c, td, previousValue: td.textContent, beforeSnapshot: snapshotCell(r, c) };
    hideSuggestions();
    td.contentEditable = 'true';
    td.classList.add('peaks-cell--editing');
    if (opts.clear) td.textContent = opts.char || '';
    td.focus();
    const range = document.createRange();
    range.selectNodeContents(td);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function commitEdit() {
    if (!editingCell) return;
    const { r, c, td, beforeSnapshot } = editingCell;
    td.contentEditable = 'false';
    td.classList.remove('peaks-cell--editing');
    editingCell = null;
    if (!isApplyingHistory) pushHistoryEntry([beforeSnapshot], [snapshotCell(r, c)]);
  }

  function cancelEdit() {
    if (!editingCell) return;
    editingCell.td.textContent = editingCell.previousValue;
    editingCell.td.contentEditable = 'false';
    editingCell.td.classList.remove('peaks-cell--editing');
    editingCell = null;
  }

  function moveSelection(dr, dc) {
    if (!anchor) return;
    clearExtraRanges();
    const r = Math.min(Math.max(anchor.r + dr, 0), numRows - 1);
    const c = Math.min(Math.max(anchor.c + dc, 0), numCols - 1);
    anchor = { r, c };
    setSelection(r, c, r, c);
    focusCellVisually(cellsEl[r][c]);
  }

  // ============================================================
  // Mouse interaction — click / drag selection (Section 3.1)
  // ============================================================

  tbody.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('peaks-colhead__resize') || e.target.classList.contains('peaks-rowhead__resize')) return;

    const td = e.target.closest('td.peaks-cell');
    if (td) {
      const linkEl = e.target.closest('a.peaks-link');
      if ((e.ctrlKey || e.metaKey) && linkEl) {
        e.preventDefault();
        const subId = linkEl.dataset.subenquiryId;
        if (subId) {
          const draftApi = window.Summit && window.Summit.draft;
          if (draftApi && typeof draftApi.focusSubEnquiry === 'function') draftApi.focusSubEnquiry(subId);
        } else {
          window.open(linkEl.getAttribute('href'), '_blank', 'noopener');
        }
        return;
      }
      // While actively editing this exact cell, leave the mouse alone —
      // let the browser place a caret or drag out a text highlight
      // natively. Hijacking the drag into cell-range selection here is
      // what was breaking "highlight a word, then click Bold."
      if (editingCell && editingCell.td === td) return;

      if (editingCell) commitEdit();
      const r = +td.dataset.row, c = +td.dataset.col;
      e.preventDefault();
      // Shift+click/drag freezes whatever was already selected (single
      // range or an existing multi-selection) and starts a new range
      // additively; a plain click/drag replaces the selection entirely.
      if (e.shiftKey && selection) freezeCurrentSelection();
      else clearExtraRanges();
      isSelecting = true;
      anchor = { r, c };
      setSelection(r, c, r, c);
      repaintExtraRanges();
      focusCellVisually(td);
      return;
    }

    const rowHead = e.target.closest('th.peaks-rowhead');
    if (rowHead) {
      if (editingCell) commitEdit();
      const r = +rowHead.dataset.row;
      if (e.shiftKey && selection) freezeCurrentSelection();
      else clearExtraRanges();
      anchor = { r, c: 0 };
      setSelection(r, 0, r, numCols - 1);
      repaintExtraRanges();
      focusCellVisually(cellsEl[r][0]);
    }
  });

  headerRow.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('peaks-colhead__resize')) return;
    const colHead = e.target.closest('th.peaks-colhead');
    if (!colHead) return;
    if (editingCell) commitEdit();
    const c = +colHead.dataset.col;
    if (e.shiftKey && selection) freezeCurrentSelection();
    else clearExtraRanges();
    anchor = { r: 0, c };
    setSelection(0, c, numRows - 1, c);
    repaintExtraRanges();
    focusCellVisually(cellsEl[0][c]);
  });

  corner.addEventListener('click', () => {
    if (editingCell) commitEdit();
    clearExtraRanges();
    anchor = { r: 0, c: 0 };
    setSelection(0, 0, numRows - 1, numCols - 1);
    focusCellVisually(cellsEl[0][0]);
  });

  tbody.addEventListener('mouseover', (e) => {
    if (!isSelecting || !anchor) return;
    const td = e.target.closest('td.peaks-cell');
    if (!td) return;
    setSelection(anchor.r, anchor.c, +td.dataset.row, +td.dataset.col);
  });

  document.addEventListener('mouseup', () => {
    isSelecting = false;
  });

  grid.addEventListener('dblclick', (e) => {
    const td = e.target.closest('td.peaks-cell');
    if (!td) return;
    startEditing(+td.dataset.row, +td.dataset.col, { clear: false });
  });

  // ============================================================
  // Column / row resizing (Section 3.2)
  // ============================================================

  // ---- Content measuring, for real "fit to content" autofit (Excel-style
  //      double-click), independent of any current word-wrap setting. ----

  let measureCanvasCtx = null;
  function getTextWidth(text) {
    if (!measureCanvasCtx) {
      measureCanvasCtx = document.createElement('canvas').getContext('2d');
    }
    // Match td.peaks-cell's font exactly, reading it from a live cell so
    // this stays correct even if the stylesheet changes later.
    const sample = (cellsEl[0] && cellsEl[0][0]) || tbody.querySelector('td.peaks-cell');
    if (sample) {
      const s = getComputedStyle(sample);
      measureCanvasCtx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    }
    return measureCanvasCtx.measureText(text).width;
  }

  let measureDiv = null;
  function getWrappedHeight(text, width) {
    if (!measureDiv) {
      measureDiv = document.createElement('div');
      measureDiv.style.position = 'absolute';
      measureDiv.style.visibility = 'hidden';
      measureDiv.style.left = '-9999px';
      measureDiv.style.top = '0';
      measureDiv.style.boxSizing = 'border-box';
      measureDiv.style.padding = '0 6px';
      measureDiv.style.whiteSpace = 'normal';
      measureDiv.style.wordBreak = 'break-word';
      document.body.appendChild(measureDiv);
    }
    const sample = (cellsEl[0] && cellsEl[0][0]) || tbody.querySelector('td.peaks-cell');
    if (sample) {
      const s = getComputedStyle(sample);
      measureDiv.style.fontFamily = s.fontFamily;
      measureDiv.style.fontSize = s.fontSize;
      measureDiv.style.fontWeight = s.fontWeight;
      measureDiv.style.lineHeight = s.lineHeight;
    }
    measureDiv.style.width = width + 'px';
    measureDiv.textContent = text;
    return measureDiv.offsetHeight;
  }

  const CELL_H_PADDING = 12; // td.peaks-cell padding: 0 6px, left + right
  const AUTOFIT_COL_BUFFER = 6;

  // Sets column c to the narrowest width that fits its longest single line
  // of content across every row currently in the grid (mirrors Excel's
  // double-click-the-column-line behaviour).
  function autoFitColumn(c) {
    let maxWidth = 0;
    for (let r = 0; r < numRows; r++) {
      const td = cellsEl[r][c];
      if (!td || !td.textContent) continue;
      const w = getTextWidth(td.textContent);
      if (w > maxWidth) maxWidth = w;
    }
    const target = Math.ceil(maxWidth + CELL_H_PADDING + AUTOFIT_COL_BUFFER);
    setColWidth(c, Math.max(MIN_COL_WIDTH, target));
  }

  // Sets row r to the shortest height that fits its tallest cell, taking
  // each cell's own column width and wrap state into account.
  function autoFitRow(r) {
    let maxHeight = DEFAULT_ROW_HEIGHT;
    for (let c = 0; c < numCols; c++) {
      const td = cellsEl[r][c];
      if (!td || !td.textContent) continue;
      if (td.classList.contains('peaks-cell--wrap')) {
        const h = getWrappedHeight(td.textContent, colWidths[c]);
        if (h > maxHeight) maxHeight = h;
      }
    }
    setRowHeight(r, Math.max(MIN_ROW_HEIGHT, Math.ceil(maxHeight)));
  }

  headerRow.addEventListener('mousedown', (e) => {
    if (!e.target.classList.contains('peaks-colhead__resize')) return;
    const th = e.target.parentElement;
    const c = +th.dataset.col;
    colResize = { c, startX: e.clientX, startWidth: colWidths[c] };
    e.target.classList.add('is-resizing');
    scrollEl.classList.add('is-resizing');
    e.preventDefault();
  });

  // Double-clicking a column's resize line resets just that column back to
  // the default width — other columns are never touched. (A true
  // Excel-style "fit to longest line of content" was tried here, but in
  // practice it tended to stretch the whole column out further than felt
  // useful; snapping back to the default width is the simpler, more
  // predictable behaviour.)
  headerRow.addEventListener('dblclick', (e) => {
    if (!e.target.classList.contains('peaks-colhead__resize')) return;
    const th = e.target.parentElement;
    const c = +th.dataset.col;
    setColWidth(c, DEFAULT_COL_WIDTH);
    e.preventDefault();
  });

  tbody.addEventListener('mousedown', (e) => {
    if (!e.target.classList.contains('peaks-rowhead__resize')) return;
    const th = e.target.parentElement;
    const r = +th.dataset.row;
    rowResize = { r, startY: e.clientY, startHeight: rowHeights[r] };
    scrollEl.classList.add('is-resizing');
    e.preventDefault();
  });

  // Double-clicking a row's resize line auto-fits just that row to its own
  // tallest cell — other rows are never touched.
  tbody.addEventListener('dblclick', (e) => {
    if (!e.target.classList.contains('peaks-rowhead__resize')) return;
    const th = e.target.parentElement;
    const r = +th.dataset.row;
    autoFitRow(r);
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (colResize) {
      const dx = e.clientX - colResize.startX;
      const w = Math.max(MIN_COL_WIDTH, colResize.startWidth + dx);
      setColWidth(colResize.c, w);
    } else if (rowResize) {
      const dy = e.clientY - rowResize.startY;
      const h = Math.max(MIN_ROW_HEIGHT, rowResize.startHeight + dy);
      setRowHeight(rowResize.r, h);
    }
  });

  document.addEventListener('mouseup', () => {
    if (colResize || rowResize) scrollEl.classList.remove('is-resizing');
    if (colResize) headerRow.querySelectorAll('.peaks-colhead__resize.is-resizing').forEach((el) => el.classList.remove('is-resizing'));
    colResize = null;
    rowResize = null;
  });

  // ============================================================
  // Keyboard — navigation, editing, clearing (Section 3.1)
  // ============================================================

  scrollEl.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault();
      redo();
      return;
    }

    if (editingCell) {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        document.execCommand('insertText', false, '\n');
      } else if (e.key === 'Enter') {
        e.preventDefault();
        commitEdit();
        moveSelection(1, 0);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        commitEdit();
        moveSelection(0, e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
      }
      return;
    }

    if (!anchor) return;

    if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1, 0); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1, 0); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); moveSelection(0, -1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); moveSelection(0, 1); }
    else if (e.key === 'Tab') { e.preventDefault(); moveSelection(0, e.shiftKey ? -1 : 1); }
    else if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); startEditing(anchor.r, anchor.c, { clear: false }); }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      withHistory(coordsForAllSelections(), () => {
        forEachSelectedCell((td) => { td.textContent = ''; });
      });
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      startEditing(anchor.r, anchor.c, { clear: true, char: e.key });
    }
  });

  grid.addEventListener('focusout', (e) => {
    if (editingCell && e.target === editingCell.td) commitEdit();
  });

  // ============================================================
  // Clipboard — copy / cut / paste
  //
  // Previously there was no paste handler at all: pasting only did
  // anything once a cell was contentEditable (i.e. after a double-
  // click), and even then the browser just dumped the raw clipboard
  // text into that one cell instead of spreading a table across
  // cells. This adds a real Excel/Sheets-style round trip: copy/cut
  // serialise the selection as tab/newline-delimited text, and paste
  // parses that same shape back out and distributes it across cells,
  // growing the grid if needed.
  // ============================================================

  function selectionToTSV(sel) {
    const rows = [];
    for (let r = sel.r1; r <= sel.r2; r++) {
      const cols = [];
      for (let c = sel.c1; c <= sel.c2; c++) {
        const td = cellsEl[r][c];
        cols.push(td.classList.contains('peaks-cell--merge-slave') ? '' : (td.textContent || ''));
      }
      rows.push(cols.join('\t'));
    }
    return rows.join('\n');
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Renders one cell's content as HTML, preserving <a href> links and
  // explicit line breaks (as <br>) — the counterpart to cellRunsFromNode
  // below, which reads this same shape back out on paste.
  function cellInnerHTMLForClipboard(td) {
    let html = '';
    td.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        html += escapeHtml(node.textContent).replace(/\n/g, '<br>');
      } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'A') {
        html += '<a href="' + escapeHtml(node.getAttribute('href') || '') + '">' + escapeHtml(node.textContent) + '</a>';
      } else {
        html += escapeHtml(node.textContent || '');
      }
    });
    return html;
  }

  // A second, HTML clipboard flavour alongside the plain-text TSV one —
  // this is what lets a copy/paste round trip (within Peaks, or out to an
  // app that reads HTML clipboard data) keep hyperlinks intact instead of
  // flattening every cell down to its bare display text.
  function selectionToHTML(sel) {
    const rows = [];
    for (let r = sel.r1; r <= sel.r2; r++) {
      const cells = [];
      for (let c = sel.c1; c <= sel.c2; c++) {
        const td = cellsEl[r][c];
        cells.push('<td>' + (td.classList.contains('peaks-cell--merge-slave') ? '' : cellInnerHTMLForClipboard(td)) + '</td>');
      }
      rows.push('<tr>' + cells.join('') + '</tr>');
    }
    return '<table><tbody>' + rows.join('') + '</tbody></table>';
  }

  function parseClipboardText(text) {
    const rows = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    // Drop one trailing empty row some apps append after the last real row.
    if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
    return rows.map((row) => row.split('\t'));
  }

  // Pulls an ordered list of {text, href} runs out of a pasted <td>,
  // turning <br>/<div>/<p> block breaks into literal "\n" text runs and
  // <a href> elements into linked runs. This is the read-side counterpart
  // to cellInnerHTMLForClipboard/selectionToHTML above.
  function cellRunsFromNode(node) {
    const runs = [];
    function walk(n) {
      if (n.nodeType === Node.TEXT_NODE) {
        if (n.textContent) runs.push({ text: n.textContent, href: null });
        return;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const tag = n.tagName;
      if (tag === 'A') {
        const href = n.getAttribute('href') || '';
        if (n.textContent) runs.push({ text: n.textContent, href });
        return;
      }
      if (tag === 'BR') { runs.push({ text: '\n', href: null }); return; }
      const blockLevel = tag === 'DIV' || tag === 'P';
      n.childNodes.forEach(walk);
      if (blockLevel && runs.length && runs[runs.length - 1].text !== '\n') runs.push({ text: '\n', href: null });
    }
    node.childNodes.forEach(walk);
    while (runs.length && runs[runs.length - 1].text === '\n') runs.pop();
    return runs;
  }

  // Parses an HTML clipboard payload's first <table> into a matrix of
  // per-cell run arrays, or returns null if the payload has no table to
  // read (e.g. HTML copied from a web page) so callers can fall back to
  // the plain-text flavour.
  function parseClipboardHTML(html) {
    if (!html) return null;
    const container = document.createElement('div');
    container.innerHTML = html;
    const table = container.querySelector('table');
    if (!table) return null;
    const matrix = [];
    table.querySelectorAll('tr').forEach((tr) => {
      const row = [];
      tr.querySelectorAll('td,th').forEach((cell) => { row.push(cellRunsFromNode(cell)); });
      if (row.length) matrix.push(row);
    });
    return matrix.length ? matrix : null;
  }

  function writeRunsToCell(td, runs) {
    td.textContent = '';
    runs.forEach((run) => {
      if (run.href) {
        const a = makeLinkEl(run.href);
        a.textContent = run.text;
        td.appendChild(a);
      } else {
        td.appendChild(document.createTextNode(run.text));
      }
    });
  }

  function ensureGridSize(minRows, minCols) {
    if (minRows > numRows) addRows(Math.max(minRows - numRows, ROWS_CHUNK));
    if (minCols > numCols) addColumns(Math.max(minCols - numCols, COLS_CHUNK));
  }

  scrollEl.addEventListener('copy', (e) => handleCopyOrCut(e, false));
  scrollEl.addEventListener('cut', (e) => handleCopyOrCut(e, true));

  function handleCopyOrCut(e, isCut) {
    if (editingCell) return; // let the browser copy/cut the in-place text highlight normally
    if (!selection) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', selectionToTSV(selection));
    e.clipboardData.setData('text/html', selectionToHTML(selection));
    if (isCut) performCut();
  }

  // ---------- Cut: clear the source, then offer to shift neighbours in ----------
  //
  // Cutting clears the source range immediately (as it always did). Right
  // after, a small chooser appears offering to pull the surrounding cells
  // left or up to close the gap — Excel's "Delete → Shift cells left/up" —
  // or it can simply be left blank (dismissing it, or doing nothing, keeps
  // that default).

  const cutGapMenu = document.getElementById('peaks-cut-gap-menu');
  let pendingCutRange = null;
  let pendingCutGapTimer = null;

  function hideCutGapMenu() {
    if (cutGapMenu) cutGapMenu.hidden = true;
    pendingCutRange = null;
    clearTimeout(pendingCutGapTimer);
  }

  function showCutGapMenu(range) {
    pendingCutRange = range;
    if (!cutGapMenu) return;
    cutGapMenu.hidden = false;
    clearTimeout(pendingCutGapTimer);
    pendingCutGapTimer = setTimeout(hideCutGapMenu, 8000);
  }

  function performCut() {
    const range = { r1: selection.r1, c1: selection.c1, r2: selection.r2, c2: selection.c2 };
    withHistory(coordsForAllSelections(), () => {
      forEachSelectedCell((td) => { td.textContent = ''; });
    });
    showCutGapMenu(range);
  }

  if (cutGapMenu) {
    cutGapMenu.querySelectorAll('[data-cut-gap]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.cutGap;
        const range = pendingCutRange;
        hideCutGapMenu();
        if (!range || mode === 'none') return;
        if (mode === 'left') {
          withHistory(coordsForShiftLeft(range), () => shiftRangeLeft(range));
        } else if (mode === 'up') {
          withHistory(coordsForShiftUp(range), () => shiftRangeUp(range));
        }
      });
    });
  }

  // ============================================================
  // Paste modes — vertical / raw / auto-link
  //
  // A context-menu click never fires the browser's native 'paste'
  // event, so it has no reliable way to get real clipboard content
  // without falling back to the async navigator.clipboard.read()/
  // readText() API — and that needs a permission grant that a lot
  // of browsers/setups flatly refuse for a plain button click.
  // Ctrl+V never has that problem: it's the one universally-trusted
  // paste gesture, and the browser hands its handler real
  // clipboardData for free, no permission involved.
  //
  // So rather than reading the clipboard ourselves, "arming" a mode
  // (via the keyboard shortcut below, or via the context-menu items
  // further down) just sets a flag and shows a brief on-screen hint.
  // The very next real Ctrl+V (or Cmd+V) consumes that flag and
  // pastes accordingly, then disarms itself. Nothing to block.
  // ============================================================

  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  const modLabel = isMac ? '⌘' : 'Ctrl';
  const pasteHint = document.getElementById('peaks-paste-hint');
  let pendingPasteMode = null; // null (default/horizontal) | 'vertical' | 'raw' | 'autolink'
  let pendingPasteTimer = null;

  function armPasteMode(mode, label) {
    pendingPasteMode = mode;
    pasteHint.textContent = `${label} — press ${modLabel}+V now`;
    pasteHint.hidden = false;
    clearTimeout(pendingPasteTimer);
    pendingPasteTimer = setTimeout(disarmPasteMode, 8000);
  }

  function disarmPasteMode() {
    pendingPasteMode = null;
    pasteHint.hidden = true;
    clearTimeout(pendingPasteTimer);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pendingPasteMode) disarmPasteMode();
    if (e.key === 'Escape' && pendingCutRange) hideCutGapMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.key.toLowerCase() !== 'v') return;
    // Most browsers don't treat Ctrl/Cmd+Shift+V as a native paste
    // gesture on their own — this just arms vertical mode. (A few
    // browsers do fire a real paste from it too; if so the handler
    // below consumes the mode immediately and the hint never shows.)
    e.preventDefault();
    armPasteMode('vertical', 'Vertical paste armed');
  }, true);

  scrollEl.addEventListener('paste', (e) => {
    e.preventDefault();
    const mode = pendingPasteMode;
    disarmPasteMode();

    const cd = e.clipboardData || window.clipboardData;
    const text = cd.getData('text/plain');
    if (!text) return;

    if (mode === 'raw') {
      if (editingCell) commitEdit();
      if (!selection) return;
      pasteRawIntoCell(selection.r1, selection.c1, text);
      return;
    }

    let matrix = parseClipboardText(text);
    const singleValue = matrix.length === 1 && matrix[0].length === 1;

    if (editingCell) {
      if (singleValue && !mode) {
        document.execCommand('insertText', false, matrix[0][0]);
        return;
      }
      // A real multi-cell paste landing mid-edit: commit first, then
      // distribute it starting at that same cell.
      commitEdit();
    }

    if (!selection) return;

    // Prefer the HTML clipboard flavour (skipped for a vertical paste,
    // which would need transposing runs too) so hyperlinks and explicit
    // line breaks survive a copy/paste round trip instead of flattening
    // down to their bare display text. Falls back to the plain-text path
    // below when there's no HTML table to read (nothing copied from
    // Peaks, or a source with no HTML clipboard flavour at all).
    const richMatrix = mode !== 'vertical' ? parseClipboardHTML(cd.getData('text/html')) : null;

    if (richMatrix) {
      if (!mode && richMatrix.length === 1 && richMatrix[0].length === 1 &&
          (selection.r1 !== selection.r2 || selection.c1 !== selection.c2)) {
        // A single copied cell pasted onto a multi-cell selection fills
        // the whole selection with it, same as Excel/Sheets.
        const runs = richMatrix[0][0];
        withHistory(coordsForAllSelections(), () => {
          forEachSelectedCell((td) => { writeRunsToCell(td, runs); });
        });
        return;
      }
      pasteRichMatrix(selection.r1, selection.c1, richMatrix);
      return;
    }

    if (singleValue && !mode && (selection.r1 !== selection.r2 || selection.c1 !== selection.c2)) {
      // A single copied value pasted onto a multi-cell selection fills
      // the whole selection with it, same as Excel/Sheets.
      withHistory(coordsForAllSelections(), () => {
        forEachSelectedCell((td) => { td.textContent = matrix[0][0]; });
      });
      return;
    }

    if (mode === 'vertical') matrix = transposeMatrix(matrix);
    pasteMatrix(selection.r1, selection.c1, matrix, { autolink: mode === 'autolink' });
  });

  // ============================================================
  // Right-click context menu
  //
  // Every paste item here just calls armPasteMode() (defined above)
  // and lets the user's next real Ctrl+V do the actual pasting —
  // see the big comment above the paste handler for why. "Copy" /
  // "Copy cell" / "Cut" do act immediately, via writeClipboardText()
  // below, which is a plain synchronous clipboard *write* and has a
  // safe fallback even where the async API is blocked.
  // ============================================================

  const ctxMenu = document.getElementById('peaks-ctxmenu');
  let contextCell = null; // { r, c } — cell under the cursor when the menu was opened

  const shortcutFor = {
    'paste-horizontal': `${modLabel}+V`,
    'paste-vertical': `${modLabel}+Shift+V`
  };
  Object.keys(shortcutFor).forEach((name) => {
    const hint = ctxMenu.querySelector(`[data-ctx-hint="${name}"]`);
    if (hint) hint.textContent = shortcutFor[name];
  });

  function hideContextMenu() {
    ctxMenu.hidden = true;
  }

  function showContextMenu(x, y) {
    ctxMenu.hidden = false;
    const rect = ctxMenu.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    ctxMenu.style.left = left + 'px';
    ctxMenu.style.top = top + 'px';
  }

  scrollEl.addEventListener('contextmenu', (e) => {
    const td = e.target.closest('td.peaks-cell');

    // While actively typing inside a cell, leave the browser's own
    // context menu alone (spellcheck, native copy/cut/paste of the
    // in-place text highlight) — same carve-out the keyboard
    // copy/cut handlers above make for an active edit.
    if (editingCell && td === editingCell.td) { hideContextMenu(); return; }

    e.preventDefault();
    if (!td) { hideContextMenu(); return; }
    if (editingCell) commitEdit();

    const r = Number(td.dataset.row), c = Number(td.dataset.col);
    contextCell = { r, c };

    // Right-clicking outside the current selection collapses it to
    // just that cell, same as Excel/Sheets. Right-clicking inside an
    // existing multi-cell selection leaves it alone, so "Copy" /
    // "Paste table" still act on the whole range.
    const inSelection = selection && r >= selection.r1 && r <= selection.r2 && c >= selection.c1 && c <= selection.c2;
    if (!inSelection) {
      setSelection(r, c, r, c);
      focusCellVisually(td);
    }

    showContextMenu(e.clientX, e.clientY);
  });

  document.addEventListener('click', (e) => {
    if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) hideContextMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !ctxMenu.hidden) hideContextMenu();
  });
  scrollEl.addEventListener('scroll', hideContextMenu);
  window.addEventListener('resize', hideContextMenu);
  window.addEventListener('blur', hideContextMenu);

  async function writeClipboardText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      // Fallback for contexts without Clipboard-API write permission:
      // drive the legacy synchronous copy command off the hidden trap.
      clipTrap.value = text;
      clipTrap.focus();
      clipTrap.select();
      const ok = document.execCommand('copy');
      clipTrap.value = '';
      return ok;
    }
  }

  function transposeMatrix(matrix) {
    const cols = Math.max(...matrix.map((row) => row.length));
    const out = [];
    for (let c = 0; c < cols; c++) {
      const row = [];
      for (let r = 0; r < matrix.length; r++) row.push(matrix[r][c] ?? '');
      out.push(row);
    }
    return out;
  }

  function pasteRichMatrix(startR, startC, matrix) {
    const endR = startR + matrix.length - 1;
    const endC = startC + Math.max(...matrix.map((row) => row.length)) - 1;
    ensureGridSize(endR + 1, endC + 1);

    const coords = [];
    for (let i = 0; i < matrix.length; i++) {
      for (let j = 0; j < matrix[i].length; j++) coords.push({ r: startR + i, c: startC + j });
    }
    withHistory(coords, () => {
      for (let i = 0; i < matrix.length; i++) {
        for (let j = 0; j < matrix[i].length; j++) {
          const r = startR + i, c = startC + j;
          if (r >= numRows || c >= numCols) continue;
          writeRunsToCell(cellsEl[r][c], matrix[i][j] || []);
        }
      }
    });
    setSelection(startR, startC, endR, endC);
  }

  const URL_RE = /^(https?:\/\/|www\.)\S+$/i;

  function pasteMatrix(startR, startC, matrix, { autolink = false } = {}) {
    const endR = startR + matrix.length - 1;
    const endC = startC + Math.max(...matrix.map((row) => row.length)) - 1;
    ensureGridSize(endR + 1, endC + 1);

    const coords = [];
    for (let i = 0; i < matrix.length; i++) {
      for (let j = 0; j < matrix[i].length; j++) coords.push({ r: startR + i, c: startC + j });
    }
    withHistory(coords, () => {
      for (let i = 0; i < matrix.length; i++) {
        for (let j = 0; j < matrix[i].length; j++) {
          const r = startR + i, c = startC + j;
          if (r >= numRows || c >= numCols) continue;
          const td = cellsEl[r][c];
          const value = matrix[i][j] ?? '';
          const trimmed = value.trim();
          if (autolink && URL_RE.test(trimmed)) {
            const href = /^www\./i.test(trimmed) ? 'https://' + trimmed : trimmed;
            td.textContent = '';
            const a = makeLinkEl(href);
            a.textContent = value;
            td.appendChild(a);
          } else {
            td.textContent = value;
          }
        }
      }
    });
    setSelection(startR, startC, endR, endC);
  }

  function pasteRawIntoCell(r, c, text) {
    withHistory([{ r, c }], () => {
      cellsEl[r][c].textContent = text;
    });
    setSelection(r, c, r, c);
  }

  function ctxAction(name) {
    hideContextMenu();
    if (!contextCell) return;
    const { r, c } = contextCell;

    if (name === 'copy-text') {
      writeClipboardText(selectionToTSV(selection));
      return;
    }
    if (name === 'copy-cell') {
      writeClipboardText(cellsEl[r][c].classList.contains('peaks-cell--merge-slave') ? '' : (cellsEl[r][c].textContent || ''));
      return;
    }
    if (name === 'cut') {
      writeClipboardText(selectionToTSV(selection)).then(() => { performCut(); });
      return;
    }

    if (name === 'paste-horizontal') {
      alert(`That's already the default — just press ${modLabel}+V.`);
      return;
    }
    if (name === 'paste-vertical') { armPasteMode('vertical', 'Vertical paste armed'); return; }
    if (name === 'paste-autolink') { armPasteMode('autolink', 'Auto-link paste armed'); return; }
    if (name === 'paste-raw') { armPasteMode('raw', 'Raw text paste armed'); return; }
  }

  ctxMenu.querySelectorAll('[data-ctx-action]').forEach((btn) => {
    btn.addEventListener('click', () => ctxAction(btn.dataset.ctxAction));
  });

  // ============================================================
  // Fill colour & borders (Section 3.2)
  // ============================================================

  let fillHistoryPending = null;
  fillInput.addEventListener('input', () => {
    if (!fillHistoryPending) fillHistoryPending = beginHistory(coordsForAllSelections());
    fillGlyph.style.background = fillInput.value;
    forEachSelectedCell((td) => { td.style.backgroundColor = fillInput.value; });
  });
  fillInput.addEventListener('change', () => {
    commitHistory(fillHistoryPending);
    fillHistoryPending = null;
  });

  function borderCss(style) {
    if (style === 'thick') return '3px solid var(--ink)';
    if (style === 'dashed') return '1px dashed var(--ink)';
    return '1px solid var(--ink)';
  }

  function applyBorder(edge) {
    if (!selection) return;
    withHistory(coordsForAllSelections(), () => {
      if (edge === 'none') {
        forEachSelectedCell((td) => {
          td.style.borderTop = '';
          td.style.borderBottom = '';
          td.style.borderLeft = '';
          td.style.borderRight = '';
        });
        return;
      }

      const css = borderCss(borderStyleSelect.value);

      if (edge === 'all') {
        forEachSelectedCell((td) => {
          td.style.borderTop = css;
          td.style.borderBottom = css;
          td.style.borderLeft = css;
          td.style.borderRight = css;
        });
        return;
      }

      forEachSelectedCell((td, r, c) => {
        if ((edge === 'outside' || edge === 'top') && r === selection.r1) td.style.borderTop = css;
        if ((edge === 'outside' || edge === 'bottom') && r === selection.r2) td.style.borderBottom = css;
        if ((edge === 'outside' || edge === 'left') && c === selection.c1) td.style.borderLeft = css;
        if ((edge === 'outside' || edge === 'right') && c === selection.c2) td.style.borderRight = css;
      });
    });
  }

  document.querySelectorAll('.peaks-toolbar [data-border-edge]').forEach((btn) => {
    btn.addEventListener('click', () => applyBorder(btn.dataset.borderEdge));
  });

  document.getElementById('peaks-fill-clear').addEventListener('click', () => {
    withHistory(coordsForAllSelections(), () => {
      forEachSelectedCell((td) => { td.style.backgroundColor = ''; });
    });
  });

  // ============================================================
  // Text formatting (bold/italic/underline/strike, size, colour,
  // case, alignment, wrap, merge, lists, links, clear-format)
  //
  // Design: bold/italic/underline/strike/size/colour/case/links all
  // apply to just the highlighted text when the user has an active
  // text selection inside a cell that's being edited. With no
  // highlight (including "just clicked the cell"), they apply to
  // the whole cell instead — the previous behaviour.
  //
  // Alignment, wrap, and merge stay whole-cell only everywhere,
  // since — same as in Excel — those are properties of the cell
  // itself, not of a run of text within it.
  // ============================================================

  const DEFAULT_FONT_SIZE = 12.5; // matches .peaks-grid base font-size in peaks.css
  const mergedMasters = new Set(); // "r,c" keys of cells currently acting as a merge master

  const boldBtn = document.getElementById('peaks-bold');
  const italicBtn = document.getElementById('peaks-italic');
  const underlineBtn = document.getElementById('peaks-underline');
  const strikeBtn = document.getElementById('peaks-strike');
  const forecolorInput = document.getElementById('peaks-forecolor');
  const forecolorGlyph = document.getElementById('peaks-forecolor-glyph');
  const fontSizeInput = document.getElementById('peaks-fontsize-input');
  const wrapBtn = document.getElementById('peaks-wrap');
  const mergeBtn = document.getElementById('peaks-merge');

  function setPressed(btn, val) {
    if (btn) btn.setAttribute('aria-pressed', val ? 'true' : 'false');
  }

  function rgbToHex(rgb) {
    if (!rgb) return null;
    if (rgb.startsWith('#')) return rgb;
    const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    const toHex = (n) => Number(n).toString(16).padStart(2, '0');
    return '#' + toHex(m[1]) + toHex(m[2]) + toHex(m[3]);
  }

  function currentDecorations(td) {
    const deco = td.style.textDecorationLine || '';
    return deco.split(' ').filter(Boolean);
  }

  function getFontSizePx(td) {
    return td.style.fontSize ? parseFloat(td.style.fontSize) : DEFAULT_FONT_SIZE;
  }

  // ---------- Highlighted-text-vs-whole-cell plumbing ----------

  let savedRange = null; // last non-empty text selection seen inside the cell being edited

  document.addEventListener('selectionchange', () => {
    if (!editingCell) { savedRange = null; return; }
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const r = sel.getRangeAt(0);
      if (editingCell.td.contains(r.commonAncestorContainer)) savedRange = r.cloneRange();
    }
    syncToolbarState();
  });

  function activeEditingSelection() {
    if (!editingCell) return null;
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const r = sel.getRangeAt(0);
      if (editingCell.td.contains(r.commonAncestorContainer)) return r;
    }
    // Fall back to the last highlighted range in this cell, in case focus
    // moved to a toolbar control (e.g. opening the colour picker) and the
    // browser cleared the live selection as a result.
    if (savedRange && editingCell.td.contains(savedRange.commonAncestorContainer)) return savedRange;
    return null;
  }

  function restoreSelection(range) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Runs `runFn(range)` against the current text highlight inside an
  // editing cell if one exists, otherwise runs `cellFn()` against the
  // whole selected cell(s).
  function withRunOrCell(runFn, cellFn) {
    const range = activeEditingSelection();
    if (range) {
      const coords = [{ r: editingCell.r, c: editingCell.c }];
      withHistory(coords, () => {
        editingCell.td.focus();
        restoreSelection(range);
        runFn(range);
        editingCell.td.normalize();
      });
    } else {
      withHistory(coordsForAllSelections(), cellFn);
    }
    syncToolbarState();
  }

  function transformRangeText(range, fn) {
    if (range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset > 0) {
      range.setStart(range.startContainer.splitText(range.startOffset), 0);
    }
    if (range.endContainer.nodeType === Node.TEXT_NODE && range.endOffset < range.endContainer.length) {
      range.endContainer.splitText(range.endOffset);
    }
    const root = range.commonAncestorContainer;
    const nodes = [];
    if (root.nodeType === Node.TEXT_NODE) {
      nodes.push(root);
    } else {
      (function collect(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (range.intersectsNode(node)) nodes.push(node);
        } else {
          node.childNodes.forEach(collect);
        }
      })(root);
    }
    nodes.forEach((node) => { node.nodeValue = fn(node.nodeValue); });
  }

  function transformAllTextIn(el, fn) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach((node) => { node.nodeValue = fn(node.nodeValue); });
  }

  function wrapRangeStyle(range, prop, value) {
    const span = document.createElement('span');
    span.style[prop] = value;
    try {
      range.surroundContents(span);
    } catch (e) {
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
    const newRange = document.createRange();
    newRange.selectNodeContents(span);
    restoreSelection(newRange);
    savedRange = newRange.cloneRange();
  }

  function currentRunFontSize(range) {
    const node = range.startContainer;
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return (el && parseFloat(window.getComputedStyle(el).fontSize)) || DEFAULT_FONT_SIZE;
  }

  // ---------- Cell-level style helpers (used as the "no highlight" fallback) ----------

  function toggleCellStyle(prop, onValue) {
    const p = primaryTd();
    if (!p) return;
    if (editingCell) commitEdit();
    const turnOn = p.style[prop] !== onValue;
    forEachSelectedCell((td) => { td.style[prop] = turnOn ? onValue : ''; });
  }

  function toggleDecoration(kind) {
    const p = primaryTd();
    if (!p) return;
    if (editingCell) commitEdit();
    const has = currentDecorations(p).includes(kind);
    forEachSelectedCell((td) => {
      const decos = currentDecorations(td).filter((d) => d !== kind);
      if (!has) decos.push(kind);
      td.style.textDecorationLine = decos.join(' ');
    });
  }

  function setCellFontSize(px) {
    px = Math.max(6, Math.min(96, Math.round(px)));
    if (editingCell) commitEdit();
    forEachSelectedCell((td) => { td.style.fontSize = px + 'px'; });
  }

  function bumpCellFontSize(delta) {
    const p = primaryTd();
    if (!p) return;
    setCellFontSize(getFontSizePx(p) + delta);
  }

  // ---------- Alignment / wrap (always whole-cell) ----------

  function setHAlign(value) {
    withHistory(coordsForAllSelections(), () => {
      forEachSelectedCell((td) => { td.style.textAlign = value; });
    });
    syncToolbarState();
  }

  function setVAlign(value) {
    withHistory(coordsForAllSelections(), () => {
      forEachSelectedCell((td) => { td.style.verticalAlign = value; });
    });
    syncToolbarState();
  }

  function toggleWrap() {
    const p = primaryTd();
    if (!p) return;
    const turnOn = !p.classList.contains('peaks-cell--wrap');
    withHistory(coordsForAllSelections(), () => {
      forEachSelectedCell((td, r) => {
        td.classList.toggle('peaks-cell--wrap', turnOn);
        if (turnOn && rowHeights[r] <= DEFAULT_ROW_HEIGHT) {
          setRowHeight(r, WRAP_ROW_HEIGHT);
        }
      });
    });
    syncToolbarState();
  }

  // ---------- Lists (whole-cell — a bullet/number is a line-level thing,
  // not a run-of-text thing, so this one stays cell-scoped even when
  // text is highlighted). Uses dedicated marker spans rather than
  // rewriting textContent, so any links or styled runs already in the
  // cell survive untouched. ----------

  function collectLineStarts(td) {
    const starts = [];
    let atLineStart = true;
    const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (!node.parentElement || !node.parentElement.closest('.peaks-list-marker')) {
        const text = node.nodeValue;
        if (atLineStart) { starts.push({ node, idx: 0 }); atLineStart = false; }
        let searchFrom = 0, nlIdx;
        while ((nlIdx = text.indexOf('\n', searchFrom)) !== -1) {
          if (nlIdx + 1 < text.length) {
            starts.push({ node, idx: nlIdx + 1 });
            searchFrom = nlIdx + 1;
          } else {
            atLineStart = true;
            searchFrom = nlIdx + 1;
          }
        }
      }
      node = walker.nextNode();
    }
    return starts;
  }

  function removeListMarkers(td) {
    td.querySelectorAll('span.peaks-list-marker').forEach((m) => m.remove());
  }

  function addListMarkers(td, kind) {
    const starts = collectLineStarts(td);
    starts.forEach((s, i) => { s.number = i + 1; });
    for (let i = starts.length - 1; i >= 0; i--) {
      const { node, idx, number } = starts[i];
      const targetNode = idx > 0 ? node.splitText(idx) : node;
      const marker = document.createElement('span');
      marker.className = 'peaks-list-marker';
      marker.dataset.kind = kind;
      marker.textContent = kind === 'bullet' ? '\u2022 ' : number + '. ';
      targetNode.parentNode.insertBefore(marker, targetNode);
    }
  }

  function toggleList(kind) {
    if (editingCell) commitEdit();
    withHistory(coordsForAllSelections(), () => {
      forEachSelectedCell((td) => {
        const existingMarker = td.querySelector('span.peaks-list-marker');
        const existingKind = existingMarker ? existingMarker.dataset.kind : null;
        removeListMarkers(td);
        if (existingKind === kind) return; // was already this kind — toggle off
        addListMarkers(td, kind);
        td.classList.add('peaks-cell--wrap');
      });
    });
    syncToolbarState();
  }

  // ---------- Links ----------

  function unwrapLinksIn(td) {
    td.querySelectorAll('a.peaks-link').forEach((a) => {
      const parent = a.parentNode;
      while (a.firstChild) parent.insertBefore(a.firstChild, a);
      parent.removeChild(a);
    });
    td.normalize();
  }

  function unwrapLinksIntersecting(range, root) {
    Array.from(root.querySelectorAll('a.peaks-link')).forEach((a) => {
      if (range.intersectsNode(a)) {
        const parent = a.parentNode;
        while (a.firstChild) parent.insertBefore(a.firstChild, a);
        parent.removeChild(a);
      }
    });
    root.normalize();
  }

  function makeLinkEl(url) {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'peaks-link';
    return a;
  }

  function insertLink() {
    const range = activeEditingSelection();

    if (range) {
      // Highlighted text inside the cell being edited — link just that text.
      const url = window.prompt('Enter URL for the highlighted text:', 'https://');
      if (!url) return;
      withHistory([{ r: editingCell.r, c: editingCell.c }], () => {
        editingCell.td.focus();
        restoreSelection(range);
        const a = makeLinkEl(url);
        try {
          range.surroundContents(a);
        } catch (e) {
          const frag = range.extractContents();
          a.appendChild(frag);
          range.insertNode(a);
        }
        editingCell.td.normalize();
      });
      return;
    }

    // No active text highlight — link the whole cell(s), as before.
    const p = primaryTd();
    if (!p) return;
    const existingLink = p.querySelector('a.peaks-link');
    const existing = existingLink ? existingLink.getAttribute('href') : 'https://';
    const url = window.prompt('Enter URL for the selected cell(s):', existing);
    if (!url) return;
    if (editingCell) commitEdit();
    withHistory(coordsForAllSelections(), () => {
      forEachSelectedCell((td) => {
        unwrapLinksIn(td);
        const text = td.textContent;
        td.textContent = '';
        const a = makeLinkEl(url);
        a.textContent = text;
        td.appendChild(a);
      });
    });
    syncToolbarState();
  }

  function removeLink() {
    const range = activeEditingSelection();
    if (range) {
      withHistory([{ r: editingCell.r, c: editingCell.c }], () => {
        let node = range.commonAncestorContainer;
        while (node && node !== editingCell.td && node.nodeName !== 'A') node = node.parentNode;
        if (node && node.nodeName === 'A') {
          const parent = node.parentNode;
          while (node.firstChild) parent.insertBefore(node.firstChild, node);
          parent.removeChild(node);
          parent.normalize();
        } else {
          unwrapLinksIntersecting(range, editingCell.td);
        }
      });
      return;
    }

    if (editingCell) commitEdit();
    withHistory(coordsForAllSelections(), () => {
      forEachSelectedCell((td) => unwrapLinksIn(td));
    });
    syncToolbarState();
  }

  // ============================================================
  // Section 9 (built early) — Smart Sub-Enquiry suggestions
  //
  // Selecting a single cell reads the cell to its left and asks the
  // Draft tab (window.Summit.draft) for the closest-matching
  // Sub-Enquiries by keyword overlap. Picking a suggestion links the
  // current cell to that Sub-Enquiry using the same a.peaks-link
  // markup as a normal hyperlink, just flagged as internal via
  // data-subenquiry-id so a click can jump into Draft instead of
  // opening a URL.
  // ============================================================

  let suggestMatches = [];

  function hideSuggestions() {
    if (!suggestBox) return;
    suggestBox.hidden = true;
    suggestMatches = [];
  }

  function positionSuggestBox(td) {
    const rect = td.getBoundingClientRect();
    suggestBox.hidden = false;
    const boxRect = suggestBox.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 4;
    left = Math.max(8, Math.min(left, window.innerWidth - boxRect.width - 8));
    top = Math.min(top, window.innerHeight - boxRect.height - 8);
    suggestBox.style.left = left + 'px';
    suggestBox.style.top = top + 'px';
  }

  function applySuggestion(match) {
    const td = primaryTd();
    if (!td || !primaryCell) return;
    if (editingCell) commitEdit();
    withHistory([{ r: primaryCell.r, c: primaryCell.c }], () => {
      unwrapLinksIn(td);
      const label = td.textContent.trim() || match.name;
      td.textContent = '';
      const a = makeLinkEl('#');
      a.removeAttribute('target');
      a.classList.add('peaks-link--internal');
      a.dataset.subenquiryId = match.id;
      a.title = 'Sub-Enquiry: ' + match.path + (match.hasTemplate ? '' : ' (no template attached yet)');
      a.textContent = label;
      td.appendChild(a);
    });
    hideSuggestions();
    syncToolbarState();
  }

  function renderSuggestions(leftText) {
    if (!suggestBox || !suggestList) return;
    suggestList.innerHTML = '';
    suggestMatches.forEach((match) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'peaks-suggest__item';
      item.setAttribute('role', 'option');

      const name = document.createElement('span');
      name.className = 'peaks-suggest__name';
      name.textContent = match.name;
      item.appendChild(name);

      const path = document.createElement('span');
      path.className = 'peaks-suggest__path';
      path.textContent = match.path;
      item.appendChild(path);

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        applySuggestion(match);
      });
      suggestList.appendChild(item);
    });
    if (suggestSourceEl) suggestSourceEl.textContent = leftText;
    positionSuggestBox(primaryTd());
  }

  function updateSmartSuggestions() {
    if (!suggestBox) return;
    if (editingCell || isSelecting) { hideSuggestions(); return; }
    if (!selection || selection.r1 !== selection.r2 || selection.c1 !== selection.c2) { hideSuggestions(); return; }
    const { r, c } = selection;
    if (c === 0) { hideSuggestions(); return; }

    const draftApi = window.Summit && window.Summit.draft;
    if (!draftApi || typeof draftApi.matchSubEnquiries !== 'function') { hideSuggestions(); return; }

    const leftTd = cellsEl[r][c - 1];
    const leftText = leftTd ? leftTd.textContent.trim() : '';
    if (!leftText) { hideSuggestions(); return; }

    const matches = draftApi.matchSubEnquiries(leftText, 3);
    if (!matches.length) { hideSuggestions(); return; }

    suggestMatches = matches;
    renderSuggestions(leftText);
  }

  if (suggestDismissBtn) suggestDismissBtn.addEventListener('click', hideSuggestions);
  scrollEl.addEventListener('scroll', hideSuggestions);
  window.addEventListener('resize', hideSuggestions);
  window.addEventListener('blur', hideSuggestions);
  document.addEventListener('click', (e) => {
    if (suggestBox && !suggestBox.hidden && !suggestBox.contains(e.target) && !e.target.closest('td.peaks-cell')) {
      hideSuggestions();
    }
  });

  function clearFormatting() {
    const range = activeEditingSelection();
    if (range) {
      withHistory([{ r: editingCell.r, c: editingCell.c }], () => {
        editingCell.td.focus();
        restoreSelection(range);
        document.execCommand('removeFormat');
        const sel = window.getSelection();
        unwrapLinksIntersecting(sel.rangeCount ? sel.getRangeAt(0) : range, editingCell.td);
      });
      return;
    }

    if (editingCell) commitEdit();
    withHistory(coordsForAllSelections(), () => {
      forEachSelectedCell((td) => {
        td.style.cssText = '';
        td.classList.remove('peaks-cell--wrap');
        removeListMarkers(td);
        unwrapLinksIn(td);
      });
    });
    syncToolbarState();
  }

  // ---------- Merge & centre (always whole-cell) ----------

  function rectOverlap(a, b) {
    return a.r1 <= b.r2 && a.r2 >= b.r1 && a.c1 <= b.c2 && a.c2 >= b.c1;
  }

  function unmergeCell(r, c) {
    const td = cellsEl[r][c];
    const rowSpan = td.rowSpan || 1;
    const colSpan = td.colSpan || 1;
    if (rowSpan === 1 && colSpan === 1) return;
    for (let rr = r; rr < r + rowSpan; rr++) {
      for (let cc = c; cc < c + colSpan; cc++) {
        if (rr === r && cc === c) continue;
        const slave = cellsEl[rr][cc];
        slave.style.display = '';
        slave.classList.remove('peaks-cell--merge-slave');
      }
    }
    td.rowSpan = 1;
    td.colSpan = 1;
    td.classList.remove('peaks-cell--merge-master');
    mergedMasters.delete(r + ',' + c);
  }

  function unmergeOverlapping(target) {
    Array.from(mergedMasters).forEach((key) => {
      const [r, c] = key.split(',').map(Number);
      const td = cellsEl[r][c];
      const region = { r1: r, c1: c, r2: r + (td.rowSpan || 1) - 1, c2: c + (td.colSpan || 1) - 1 };
      if (rectOverlap(region, target)) unmergeCell(r, c);
    });
  }

  function mergeCenter() {
    if (!selection) return;
    const sel = selection;

    const topLeft = cellsEl[sel.r1][sel.c1];
    const alreadyThisMerge = mergedMasters.has(sel.r1 + ',' + sel.c1) &&
      (topLeft.rowSpan || 1) === (sel.r2 - sel.r1 + 1) &&
      (topLeft.colSpan || 1) === (sel.c2 - sel.c1 + 1);

    if (alreadyThisMerge) {
      withHistory(coordsForSelection(sel), () => unmergeCell(sel.r1, sel.c1));
      syncToolbarState();
      return;
    }

    if (sel.r1 === sel.r2 && sel.c1 === sel.c2) {
      setHAlign('center');
      setVAlign('middle');
      return;
    }

    if (editingCell) commitEdit();
    withHistory(coordsForSelection(sel), () => {
      unmergeOverlapping({ r1: sel.r1, c1: sel.c1, r2: sel.r2, c2: sel.c2 });

      const master = cellsEl[sel.r1][sel.c1];
      for (let r = sel.r1; r <= sel.r2; r++) {
        for (let c = sel.c1; c <= sel.c2; c++) {
          if (r === sel.r1 && c === sel.c1) continue;
          const slave = cellsEl[r][c];
          slave.textContent = '';
          slave.style.display = 'none';
          slave.classList.add('peaks-cell--merge-slave');
        }
      }
      master.rowSpan = sel.r2 - sel.r1 + 1;
      master.colSpan = sel.c2 - sel.c1 + 1;
      master.classList.add('peaks-cell--merge-master');
      master.style.textAlign = 'center';
      master.style.verticalAlign = 'middle';
      mergedMasters.add(sel.r1 + ',' + sel.c1);
    });
    syncToolbarState();
  }

  // ---------- Toolbar state sync ----------

  function syncToolbarState() {
    const p = primaryTd();
    if (!p) return;

    const range = activeEditingSelection();
    if (range) {
      setPressed(boldBtn, document.queryCommandState('bold'));
      setPressed(italicBtn, document.queryCommandState('italic'));
      setPressed(underlineBtn, document.queryCommandState('underline'));
      setPressed(strikeBtn, document.queryCommandState('strikeThrough'));
      const node = range.startContainer;
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      if (el) {
        const cs = window.getComputedStyle(el);
        if (fontSizeInput) fontSizeInput.value = Math.round(parseFloat(cs.fontSize));
        const hex = rgbToHex(cs.color);
        if (hex && forecolorInput) forecolorInput.value = hex;
        if (forecolorGlyph) forecolorGlyph.style.color = hex || forecolorInput.value;
      }
    } else {
      setPressed(boldBtn, p.style.fontWeight === 'bold');
      setPressed(italicBtn, p.style.fontStyle === 'italic');
      const decos = currentDecorations(p);
      setPressed(underlineBtn, decos.includes('underline'));
      setPressed(strikeBtn, decos.includes('line-through'));
      if (fontSizeInput) fontSizeInput.value = Math.round(getFontSizePx(p));
      const hex = rgbToHex(p.style.color);
      if (hex && forecolorInput) forecolorInput.value = hex;
      if (forecolorGlyph) forecolorGlyph.style.color = hex || forecolorInput.value;
    }

    // Alignment / wrap / merge always reflect the cell itself.
    const hAlign = p.style.textAlign || 'left';
    document.querySelectorAll('[data-peaks-halign]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.peaksHalign === hAlign);
    });
    const vAlign = p.style.verticalAlign || 'middle';
    document.querySelectorAll('[data-peaks-valign]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.peaksValign === vAlign);
    });
    setPressed(wrapBtn, p.classList.contains('peaks-cell--wrap'));
    setPressed(mergeBtn, primaryCell ? mergedMasters.has(primaryCell.r + ',' + primaryCell.c) : false);
  }

  // ---------- Wire up buttons ----------

  // Prevent toolbar buttons from stealing focus away from a cell being
  // edited — otherwise clicking, say, Bold would collapse/clear the text
  // highlight before the click handler even runs.
  document.querySelectorAll('.peaks-toolbar button').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
  });

  if (undoBtn) undoBtn.addEventListener('click', undo);
  if (redoBtn) redoBtn.addEventListener('click', redo);

  if (boldBtn) {
    boldBtn.addEventListener('click', () => withRunOrCell(
      () => document.execCommand('bold'),
      () => toggleCellStyle('fontWeight', 'bold')
    ));
  }
  if (italicBtn) {
    italicBtn.addEventListener('click', () => withRunOrCell(
      () => document.execCommand('italic'),
      () => toggleCellStyle('fontStyle', 'italic')
    ));
  }
  if (underlineBtn) {
    underlineBtn.addEventListener('click', () => withRunOrCell(
      () => document.execCommand('underline'),
      () => toggleDecoration('underline')
    ));
  }
  if (strikeBtn) {
    strikeBtn.addEventListener('click', () => withRunOrCell(
      () => document.execCommand('strikeThrough'),
      () => toggleDecoration('line-through')
    ));
  }

  if (forecolorInput) {
    // Live swatch preview only — the actual colour is applied on 'change'
    // (see below) so we don't yank focus away mid-drag in the picker.
    forecolorInput.addEventListener('input', () => {
      if (forecolorGlyph) forecolorGlyph.style.color = forecolorInput.value;
    });
    forecolorInput.addEventListener('change', () => {
      withRunOrCell(
        () => document.execCommand('foreColor', false, forecolorInput.value),
        () => {
          if (editingCell) commitEdit();
          forEachSelectedCell((td) => { td.style.color = forecolorInput.value; });
        }
      );
    });
  }

  const fsDecrease = document.getElementById('peaks-fontsize-decrease');
  const fsIncrease = document.getElementById('peaks-fontsize-increase');
  if (fsDecrease) {
    fsDecrease.addEventListener('click', () => withRunOrCell(
      (range) => wrapRangeStyle(range, 'fontSize', Math.max(6, Math.min(96, Math.round(currentRunFontSize(range) - 1))) + 'px'),
      () => bumpCellFontSize(-1)
    ));
  }
  if (fsIncrease) {
    fsIncrease.addEventListener('click', () => withRunOrCell(
      (range) => wrapRangeStyle(range, 'fontSize', Math.max(6, Math.min(96, Math.round(currentRunFontSize(range) + 1))) + 'px'),
      () => bumpCellFontSize(1)
    ));
  }
  if (fontSizeInput) {
    fontSizeInput.addEventListener('change', () => {
      const v = parseFloat(fontSizeInput.value);
      if (isNaN(v)) return;
      const px = Math.max(6, Math.min(96, Math.round(v)));
      withRunOrCell(
        (range) => wrapRangeStyle(range, 'fontSize', px + 'px'),
        () => setCellFontSize(px)
      );
    });
  }

  const upperBtn = document.getElementById('peaks-uppercase');
  const lowerBtn = document.getElementById('peaks-lowercase');
  if (upperBtn) {
    upperBtn.addEventListener('click', () => withRunOrCell(
      (range) => transformRangeText(range, (s) => s.toUpperCase()),
      () => { if (editingCell) commitEdit(); forEachSelectedCell((td) => transformAllTextIn(td, (s) => s.toUpperCase())); }
    ));
  }
  if (lowerBtn) {
    lowerBtn.addEventListener('click', () => withRunOrCell(
      (range) => transformRangeText(range, (s) => s.toLowerCase()),
      () => { if (editingCell) commitEdit(); forEachSelectedCell((td) => transformAllTextIn(td, (s) => s.toLowerCase())); }
    ));
  }

  document.querySelectorAll('[data-peaks-halign]').forEach((btn) => {
    btn.addEventListener('click', () => setHAlign(btn.dataset.peaksHalign));
  });
  document.querySelectorAll('[data-peaks-valign]').forEach((btn) => {
    btn.addEventListener('click', () => setVAlign(btn.dataset.peaksValign));
  });

  if (wrapBtn) wrapBtn.addEventListener('click', toggleWrap);
  if (mergeBtn) mergeBtn.addEventListener('click', mergeCenter);

  document.querySelectorAll('[data-peaks-list]').forEach((btn) => {
    btn.addEventListener('click', () => toggleList(btn.dataset.peaksList));
  });

  const linkInsertBtn = document.getElementById('peaks-link-insert');
  const linkRemoveBtn = document.getElementById('peaks-link-remove');
  if (linkInsertBtn) linkInsertBtn.addEventListener('click', insertLink);
  if (linkRemoveBtn) linkRemoveBtn.addEventListener('click', removeLink);

  const clearFormatBtn = document.getElementById('peaks-clear-format');
  if (clearFormatBtn) clearFormatBtn.addEventListener('click', clearFormatting);

  // ============================================================
  // Init
  // ============================================================

  scrollEl.addEventListener('scroll', checkGrow);

  addColumns(COLS_INITIAL);
  addRows(ROWS_INITIAL);
  anchor = { r: 0, c: 0 };
  selection = { r1: 0, c1: 0, r2: 0, c2: 0 };
  primaryCell = { r: 0, c: 0 };
  paintSelection(selection, true);
  cellsEl[0][0].classList.add('peaks-cell--primary');
  updateCellRef();
  syncToolbarState();
  updateHistoryButtons();
  if (clipTrap) clipTrap.focus({ preventScroll: true });

  // ============================================================
  // Data lifecycle & export/import hooks (Section 4)
  // ============================================================

  // Bounding box of cells that actually hold text, 0-indexed and
  // exclusive-safe (rows/cols are *counts*, so a sheet with data only
  // in A1 reports { rows: 1, cols: 1 }). Ignores styling-only cells —
  // matches "sheet has no data" the way a spreadsheet user would mean it.
  function getUsedRange() {
    let maxR = -1, maxC = -1;
    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < numCols; c++) {
        if (cellsEl[r][c].textContent.trim() !== '') {
          if (r > maxR) maxR = r;
          if (c > maxC) maxC = c;
        }
      }
    }
    return { rows: maxR + 1, cols: maxC + 1 };
  }

  // Plain-text values for a rectangular range (inclusive), row-major —
  // the shape both the .xlsx export and batch export slice from.
  function getMatrix(r1, r2, c1, c2) {
    const out = [];
    for (let r = r1; r <= r2; r++) {
      const row = [];
      for (let c = c1; c <= c2; c++) row.push(cellsEl[r][c] ? cellsEl[r][c].textContent : '');
      out.push(row);
    }
    return out;
  }

  // Resets every allocated cell to its default state (content, styling,
  // merges) without shrinking the grid, and drops undo/redo history —
  // a fresh import shouldn't let Ctrl+Z resurrect the sheet it replaced.
  function clearGrid() {
    Array.from(mergedMasters).forEach((key) => {
      const [r, c] = key.split(',').map(Number);
      unmergeCell(r, c);
    });
    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < numCols; c++) {
        const td = cellsEl[r][c];
        td.textContent = '';
        td.removeAttribute('style');
        td.className = 'peaks-cell';
        td.rowSpan = 1;
        td.colSpan = 1;
      }
    }
    undoStack = [];
    redoStack = [];
    updateHistoryButtons();
  }

  // ============================================================
  // Generate Template — builds a CPF reply letter in column N from
  // columns D-L on every row that has data, per Summit's spec:
  //
  //   D = registered email, E = case email, F = registered mobile,
  //   H = enquiry date/ref, J/K = salutation (title/name), L = free
  //   text that may say "Prisoner", N = output.
  //
  // Reply channel:      D or E present -> Email
  //                      no D/E, F present -> Mailbox
  //                      no D/E/F -> Hardcopy (Prisoner/Non-Prisoner per L)
  // Additionally-liner:  no D, no E -> "no registered and no case email"
  //                      E only -> "no registered email"
  //                      D and E present but differ -> "email differs"
  //                      D present (E absent, or D and E match) -> none
  // End-liner: fixed text per channel (Hardcopy Non-Prisoner reuses Email's).
  //
  // "Prisoner" in L also swaps the referral line's wording, independent
  // of channel. Only the first "Account settings" in the whole letter
  // gets hyperlinked.
  // ============================================================

  const GEN_COL = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9, K: 10, L: 11, M: 12, N: 13 };
  const ACCOUNT_SETTINGS_URL = 'http://www.cpf.gov.sg/member/ds/account-settings';
  const CONTACT_US_URL = 'https://cpf.gov.sg/membercontactus';
  const CPF_HOMEPAGE_URL = 'https://www.cpf.gov.sg';

  // Every marker below gets hyperlinked at most once per generated letter
  // (its first occurrence, wherever that lands) — same rule the original
  // "Account settings" link already followed, just generalised.
  const AUTO_LINK_RULES = [
    { marker: 'Account settings', url: ACCOUNT_SETTINGS_URL },
    { marker: 'Contact Us', url: CONTACT_US_URL },
    { marker: 'cpf.gov.sg', url: CPF_HOMEPAGE_URL }
  ];

  const LINER_NO_REG_NO_CASE =
    'Additionally, we note that you have not registered your contact details with us. Please update your preferred email address and contact number with us at your Account settings (Singpass required) to receive timely notifications about your CPF account and account-specific responses in future.\n\n' +
    'If you do not have an email address, you may like to know that you can create a Gmail, Yahoo mail, Outlook or Hotmail address for free.';
  const LINER_NO_REG_EMAIL =
    'Additionally, we note that you have not registered your email address with us. Where possible, please register your email address at Account settings using your Singpass to ensure you can receive account-specific responses and email notifications on your CPF account in future.';
  const LINER_EMAIL_DIFFERS =
    'Additionally, we note that your email address is different from the one maintained in our records. Please update your email address with us at your Account settings with your Singpass if you would like to receive notifications about your CPF account and account-specific responses to this email address.';

  const ENDLINER_EMAIL = 'We would be pleased to help if you require further assistance. For more information on CPF, please visit cpf.gov.sg.';
  const ENDLINER_MAILBOX = 'We would be pleased to help if you require further assistance. If you have further clarifications, you can Contact Us and provide your email address.';
  const ENDLINER_HARDCOPY_NONPRISONER = ENDLINER_EMAIL;
  const ENDLINER_HARDCOPY_PRISONER = 'We would be pleased to help if you require further assistance.\nThank you.';

  function genCellText(r, colLetter) {
    const c = GEN_COL[colLetter];
    const td = cellsEl[r] && cellsEl[r][c];
    return td ? td.textContent.trim() : '';
  }

  // Formats a date typed in column H (d/m/yyyy, d-m-yyyy, or d.m.yyyy —
  // same separators parseSplitDate accepts below) as "8 July 2026" for
  // the generated letter. Anything that doesn't match that shape (blank,
  // already-worded text, a different format) is left exactly as typed.
  const LONG_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  function formatLongDate(text) {
    const m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(text.trim());
    if (!m) return text;
    const d = +m[1], mo = +m[2];
    let y = +m[3];
    if (y < 100) y += 2000;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return text;
    return d + ' ' + LONG_MONTH_NAMES[mo - 1] + ' ' + y;
  }

  // "Non-Prisoner" contains the substring "Prisoner" too, so this only
  // counts a bare "Prisoner" mention, not a "Non-Prisoner" one.
  function isPrisonerFlag(lText) {
    const low = lText.toLowerCase();
    return low.includes('prisoner') && !low.includes('non-prisoner') && !low.includes('non prisoner');
  }

  // Returns the generated letter text for a row, or null if the row has
  // nothing in D/E/F/H/J/K/L worth generating from.
  function buildTemplateForRow(r) {
    const d = genCellText(r, 'D');
    const e = genCellText(r, 'E');
    const f = genCellText(r, 'F');
    const h = genCellText(r, 'H');
    const j = genCellText(r, 'J');
    const k = genCellText(r, 'K');
    const l = genCellText(r, 'L');
    if (!d && !e && !f && !h && !j && !k && !l) return null;

    const hasD = !!d, hasE = !!e, hasF = !!f;
    const prisoner = isPrisonerFlag(l);

    let channel;
    if (hasD || hasE) channel = 'email';
    else if (hasF) channel = 'mailbox';
    else channel = prisoner ? 'hardcopy-prisoner' : 'hardcopy-nonprisoner';

    let liner = null;
    if (!hasD && !hasE) liner = LINER_NO_REG_NO_CASE;
    else if (!hasD && hasE) liner = LINER_NO_REG_EMAIL;
    else if (hasD && hasE && d.toLowerCase() !== e.toLowerCase()) liner = LINER_EMAIL_DIFFERS;
    // hasD with no E, or hasD/hasE matching: already fully registered, no liner.

    const endLiner = channel === 'email' ? ENDLINER_EMAIL
      : channel === 'mailbox' ? ENDLINER_MAILBOX
      : channel === 'hardcopy-prisoner' ? ENDLINER_HARDCOPY_PRISONER
      : ENDLINER_HARDCOPY_NONPRISONER;

    const hFormatted = formatLongDate(h);
    const refLine = prisoner ? 'We refer to your letter request received on ' + hFormatted : 'We refer to your enquiry of ' + hFormatted;
    const salutation = 'Dear ' + [j, k].filter(Boolean).join(' ');

    const lines = [salutation, refLine];
    if (liner) lines.push(liner);
    lines.push(endLiner);
    return lines.join('\n');
  }

  // Writes the letter into column N, hyperlinking the first occurrence of
  // each marker in AUTO_LINK_RULES (Account settings / Contact Us /
  // cpf.gov.sg), wherever in the letter it happens to fall.
  function writeTemplateToCell(r, text) {
    const td = cellsEl[r][GEN_COL.N];
    td.textContent = '';

    const hits = [];
    AUTO_LINK_RULES.forEach(({ marker, url }) => {
      const idx = text.indexOf(marker);
      if (idx !== -1) hits.push({ idx, end: idx + marker.length, marker, url });
    });
    hits.sort((a, b) => a.idx - b.idx);

    let cursor = 0;
    hits.forEach((hit) => {
      if (hit.idx < cursor) return; // overlaps an already-linked span; skip it
      if (hit.idx > cursor) td.appendChild(document.createTextNode(text.slice(cursor, hit.idx)));
      const a = makeLinkEl(hit.url);
      a.textContent = hit.marker;
      td.appendChild(a);
      cursor = hit.end;
    });
    if (cursor < text.length) td.appendChild(document.createTextNode(text.slice(cursor)));

    td.classList.add('peaks-cell--wrap');
    if (rowHeights[r] <= DEFAULT_ROW_HEIGHT) {
      setRowHeight(r, WRAP_ROW_HEIGHT);
    }
  }

  function generateTemplates() {
    const used = getUsedRange();
    if (used.rows === 0) { showToast('Nothing to generate \u2014 the sheet looks empty.'); return; }
    const rowsToWrite = [];
    for (let r = 0; r < used.rows; r++) {
      const text = buildTemplateForRow(r);
      if (text !== null) rowsToWrite.push({ r, text });
    }
    if (rowsToWrite.length === 0) {
      showToast('No rows with data in columns D\u2013L to generate from.');
      return;
    }
    const coords = rowsToWrite.map(({ r }) => ({ r, c: GEN_COL.N }));
    withHistory(coords, () => {
      rowsToWrite.forEach(({ r, text }) => writeTemplateToCell(r, text));
    });
    const n = rowsToWrite.length;
    if (generateStatusEl) {
      const msg = 'Generated ' + n + ' template' + (n === 1 ? '' : 's') + ' into column N.';
      generateStatusEl.textContent = msg;
      generateStatusEl.title = msg;
    }
    showToast('Generated ' + n + ' reply template' + (n === 1 ? '' : 's') + '.');
  }

  if (generateBtn) generateBtn.addEventListener('click', () => {
    if (editingCell) commitEdit();
    generateTemplates();
  });

  // ============================================================
  // Split by Date (a Peaks-only view, not an Excel feature)
  //
  // Groups every row that has a date in column H into its own table —
  // rows with nothing in H simply don't appear anywhere in this view.
  // Only columns G–N are shown/copied; A–F are omitted entirely here.
  // This is a read-only derived view: toggling it on swaps the editable
  // grid out for this rendering, toggling it off brings the grid back
  // exactly as it was. Each group gets its own "Copy" button that copies
  // just that date's heading + table, built so pasting into Word turns
  // the heading into a real "Heading 2" paragraph followed by a table.
  // ============================================================

  const SPLIT_COL_LETTERS = ['G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'];

  // Recognises d/m/yyyy (and d-m-yyyy, d.m.yyyy) so same-day entries
  // written slightly differently (30/7/2026 vs 30/07/2026) still land in
  // one group. Anything that doesn't parse still gets its own group,
  // keyed on its literal text, and sorts after every real date.
  function parseSplitDate(text) {
    const m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(text.trim());
    if (!m) return null;
    let d = +m[1], mo = +m[2], y = +m[3];
    if (y < 100) y += 2000;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return y * 10000 + mo * 100 + d;
  }

  function buildDateGroups() {
    const used = getUsedRange();
    const groups = new Map(); // groupKey -> { label, sortKey, order, rows: [] }
    let order = 0;
    for (let r = 0; r < used.rows; r++) {
      const td = cellsEl[r][GEN_COL.H];
      const text = td ? td.textContent.trim() : '';
      if (!text) continue;
      const sortKey = parseSplitDate(text);
      const groupKey = sortKey !== null ? 'd:' + sortKey : 't:' + text.toLowerCase();
      if (!groups.has(groupKey)) {
        groups.set(groupKey, { label: text, sortKey, order: order++, rows: [] });
      }
      groups.get(groupKey).rows.push(r);
    }
    return Array.from(groups.values()).sort((a, b) => {
      if (a.sortKey !== null && b.sortKey !== null) return a.sortKey - b.sortKey;
      if (a.sortKey !== null) return -1;
      if (b.sortKey !== null) return 1;
      return a.order - b.order;
    });
  }

  // ---------- Split-view column sizing ----------
  //
  // G–J are forced onto a single line each (their column is sized to fit
  // the longest value in that column, no wrapping). K is allowed to wrap,
  // but sized so nothing needs more than 2 lines. Whatever width is left
  // over after G–K are settled is split across L / M / N as roughly
  // 30% / 35% / 35%. Keeps the split tables from turning into a wall of
  // near-equal, mostly-empty columns.

  const SPLIT_NOWRAP_COLS = ['G', 'H', 'I', 'J'];
  const SPLIT_MIN_COL_WIDTH = 50;
  const SPLIT_CELL_H_PADDING = 18; // .peaks-split__table td padding (6px 8px) + border, roughly

  let splitMeasureCtx = null;
  function getSplitTextWidth(text, sampleEl) {
    if (!splitMeasureCtx) splitMeasureCtx = document.createElement('canvas').getContext('2d');
    const s = getComputedStyle(sampleEl);
    splitMeasureCtx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    let max = 0;
    String(text).split('\n').forEach((line) => {
      const w = splitMeasureCtx.measureText(line).width;
      if (w > max) max = w;
    });
    return max;
  }

  let splitProbeEl = null;
  function splitLineCount(sampleEl, text, width) {
    if (!splitProbeEl) {
      splitProbeEl = document.createElement('div');
      splitProbeEl.style.position = 'absolute';
      splitProbeEl.style.visibility = 'hidden';
      splitProbeEl.style.left = '-9999px';
      splitProbeEl.style.top = '0';
      splitProbeEl.style.boxSizing = 'border-box';
      splitProbeEl.style.whiteSpace = 'pre-line';
      splitProbeEl.style.wordBreak = 'break-word';
      document.body.appendChild(splitProbeEl);
    }
    const s = getComputedStyle(sampleEl);
    splitProbeEl.style.padding = s.padding;
    splitProbeEl.style.fontFamily = s.fontFamily;
    splitProbeEl.style.fontSize = s.fontSize;
    splitProbeEl.style.fontWeight = s.fontWeight;
    splitProbeEl.style.lineHeight = s.lineHeight;
    splitProbeEl.style.width = width + 'px';
    splitProbeEl.textContent = text;
    const lh = parseFloat(s.lineHeight);
    const lineHeightPx = isNaN(lh) ? parseFloat(s.fontSize) * 1.3 : lh;
    return Math.max(1, Math.round(splitProbeEl.scrollHeight / lineHeightPx));
  }

  // Smallest width (within [minW, maxW]) at which every text in `texts`
  // wraps to no more than `maxLines` lines.
  function minWidthForMaxLines(sampleEl, texts, maxLines, minW, maxW) {
    let lo = Math.max(1, Math.round(minW));
    let hi = Math.max(lo, Math.round(maxW));
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const ok = texts.every((t) => splitLineCount(sampleEl, t, mid) <= maxLines);
      if (ok) hi = mid; else lo = mid + 1;
    }
    return lo;
  }

  // Computes pixel widths for G–N per the rules above, stashes them on
  // `group.colWidths` (so the Copy buttons can reuse the same widths in
  // the exported table), and applies them to the live <table> via a
  // <colgroup> + table-layout: fixed so the browser doesn't re-flex them.
  function applySplitColumnWidths(table, group) {
    const cols = SPLIT_COL_LETTERS.map((k) => GEN_COL[k]);
    const headRowEl = table.querySelector('thead tr');
    const bodyRows = table.querySelectorAll('tbody tr');
    const sampleTd = (bodyRows[0] && bodyRows[0].children[0]) || (headRowEl && headRowEl.children[0]);
    if (!sampleTd) return;

    const textsByLetter = {};
    SPLIT_COL_LETTERS.forEach((letter, i) => {
      const c = cols[i];
      textsByLetter[letter] = group.rows.map((r) => (cellsEl[r][c] ? cellsEl[r][c].textContent : ''));
    });

    const widths = {};
    let usedWidth = 0;

    SPLIT_NOWRAP_COLS.forEach((letter) => {
      const maxTextW = textsByLetter[letter].reduce((m, t) => Math.max(m, getSplitTextWidth(t, sampleTd)), 0);
      const w = Math.max(SPLIT_MIN_COL_WIDTH, Math.ceil(maxTextW) + SPLIT_CELL_H_PADDING);
      widths[letter] = w;
      usedWidth += w;
    });

    {
      const texts = textsByLetter.K;
      const naturalMax = texts.reduce((m, t) => Math.max(m, getSplitTextWidth(t, sampleTd)), 0) + SPLIT_CELL_H_PADDING;
      const w = minWidthForMaxLines(sampleTd, texts, 2, SPLIT_MIN_COL_WIDTH, Math.max(SPLIT_MIN_COL_WIDTH, naturalMax));
      widths.K = w;
      usedWidth += w;
    }

    const totalWidth = table.clientWidth || table.getBoundingClientRect().width || 0;
    let remaining = totalWidth - usedWidth - (SPLIT_COL_LETTERS.length + 1); // rough border allowance
    if (remaining < 3 * SPLIT_MIN_COL_WIDTH) remaining = 3 * SPLIT_MIN_COL_WIDTH; // let it scroll rather than crush L/M/N

    widths.L = Math.round(remaining * 0.30);
    widths.M = Math.round(remaining * 0.35);
    widths.N = remaining - widths.L - widths.M; // exact remainder to N

    const colgroup = document.createElement('colgroup');
    SPLIT_COL_LETTERS.forEach((letter) => {
      const col = document.createElement('col');
      col.style.width = widths[letter] + 'px';
      colgroup.appendChild(col);
    });
    table.insertBefore(colgroup, table.firstChild);
    table.style.tableLayout = 'fixed';

    SPLIT_NOWRAP_COLS.forEach((letter) => {
      const i = SPLIT_COL_LETTERS.indexOf(letter);
      if (headRowEl && headRowEl.children[i]) headRowEl.children[i].classList.add('peaks-split__col--nowrap');
      bodyRows.forEach((tr) => { if (tr.children[i]) tr.children[i].classList.add('peaks-split__col--nowrap'); });
    });

    group.colWidths = widths;
  }

  // Word's "Merge Formatting" paste mode (the default a lot of people
  // have) discards the source's paragraph/character *styles* entirely
  // and substitutes whatever style is active at the destination cursor —
  // that's why "Heading 2" pasted onto an existing Heading 2 came through
  // in the destination's own font. What Merge Formatting does keep is
  // *direct* character formatting layered on top of a style (the same
  // way manually selecting text and clicking a font/colour button in
  // Word survives a style change). So each run below carries its
  // font-family/size/colour as an explicit inline override, not just a
  // style name, precisely so it survives Merge Formatting too.
  const CLIPBOARD_STYLE_BLOCK =
    '<style>' +
    'h2.peaksHeading2{mso-style-name:"Heading 2";font-family:"Aptos Serif",serif;font-size:12.0pt;color:#0F4761;}' +
    'p.peaksNoSpacing,li.peaksNoSpacing,div.peaksNoSpacing' +
    '{mso-style-name:"No Spacing";mso-style-unhide:no;mso-style-priority:1;mso-style-qformat:yes;' +
    'mso-style-parent:"";margin:0in;margin-bottom:.0001pt;mso-pagination:widow-orphan;' +
    'font-size:10.0pt;font-family:"Aptos Serif",serif;color:black;}' +
    '</style>';

  const CLIPBOARD_HEADING_RUN_STYLE = 'font-family:"Aptos Serif",serif;font-size:12.0pt;color:#0F4761;';
  const CLIPBOARD_BODY_RUN_STYLE = 'font-family:"Aptos Serif",serif;font-size:10.0pt;color:black;font-weight:normal;font-style:normal;text-decoration:none;';
  const CLIPBOARD_LINK_RUN_STYLE = 'font-family:"Aptos Serif",serif;font-size:10.0pt;color:#0F4761;font-weight:normal;font-style:normal;text-decoration:underline;';

  // Same shape as cellInnerHTMLForClipboard (plain text -> escaped text,
  // <a> -> a link), but every run carries its own direct inline style —
  // CLIPBOARD_LINK_RUN_STYLE for hyperlinks, CLIPBOARD_BODY_RUN_STYLE for
  // everything else — so Merge Formatting has real character formatting
  // to preserve instead of just an inherited paragraph style.
  function cellInnerHTMLForWordExport(td) {
    let html = '';
    td.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        html += '<span style="' + CLIPBOARD_BODY_RUN_STYLE + '">' + escapeHtml(node.textContent).replace(/\n/g, '<br>') + '</span>';
      } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'A') {
        html += '<a href="' + escapeHtml(node.getAttribute('href') || '') + '" style="' + CLIPBOARD_LINK_RUN_STYLE + '">'
          + escapeHtml(node.textContent) + '</a>';
      } else {
        html += '<span style="' + CLIPBOARD_BODY_RUN_STYLE + '">' + escapeHtml(node.textContent || '') + '</span>';
      }
    });
    return html;
  }

  function buildGroupClipboardHTML(group) {
    const cols = SPLIT_COL_LETTERS.map((k) => GEN_COL[k]);
    let html = '<h2 class="peaksHeading2"><span style="' + CLIPBOARD_HEADING_RUN_STYLE + '">'
      + escapeHtml(formatLongDate(group.label)) + '</span></h2>';
    const tableStyle = 'border-collapse:collapse;' + (group.colWidths ? ' table-layout:fixed;' : '');
    html += '<table border="1" cellspacing="0" cellpadding="4" style="' + tableStyle + '">';
    if (group.colWidths) {
      html += '<colgroup>' + SPLIT_COL_LETTERS.map((letter) => '<col style="width:' + group.colWidths[letter] + 'px">').join('') + '</colgroup>';
    }
    html += '<tbody>';
    group.rows.forEach((r) => {
      html += '<tr>' + cols.map((c) => {
        const td = cellsEl[r][c];
        const inner = td ? cellInnerHTMLForWordExport(td) : '';
        return '<td><p class="peaksNoSpacing" style="margin:0in;margin-bottom:.0001pt;mso-pagination:widow-orphan;font-size:10.0pt;font-family:&quot;Aptos Serif&quot;,serif;color:black;">'
          + inner + '</p></td>';
      }).join('') + '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  // Wraps a body fragment (one or more h2+table groups) as a full HTML
  // document, including the class definitions above in <head> — Word's
  // HTML importer needs those class rules present in the same document
  // it's parsing, not just referenced by name.
  function wordClipboardDocument(bodyHtml) {
    return '<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" '
      + 'xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">'
      + '<head><meta charset="utf-8">' + CLIPBOARD_STYLE_BLOCK + '</head><body>' + bodyHtml + '</body></html>';
  }

  function buildGroupClipboardText(group) {
    const cols = SPLIT_COL_LETTERS.map((k) => GEN_COL[k]);
    const lines = [formatLongDate(group.label)];
    group.rows.forEach((r) => {
      lines.push(cols.map((c) => (cellsEl[r][c] ? cellsEl[r][c].textContent : '')).join('\t'));
    });
    return lines.join('\n');
  }


  // Copies pre-built HTML (with real hyperlinks/line breaks) to the
  // clipboard as both text/html and text/plain, since neither of the
  // button clicks below fire a native 'copy' event to hand us
  // e.clipboardData the way Ctrl+C does elsewhere in Peaks.
  async function copyRichHTML(html, plainText) {
    if (navigator.clipboard && window.ClipboardItem) {
      try {
        const item = new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plainText], { type: 'text/plain' })
        });
        await navigator.clipboard.write([item]);
        return true;
      } catch (err) {
        // Fall through to the legacy path below (older browsers, or a
        // permission-less context that rejects the async Clipboard API).
      }
    }
    const holder = document.createElement('div');
    holder.setAttribute('contenteditable', 'true');
    holder.style.position = 'fixed';
    holder.style.left = '-9999px';
    holder.style.top = '0';
    holder.innerHTML = html;
    document.body.appendChild(holder);
    const range = document.createRange();
    range.selectNodeContents(holder);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    sel.removeAllRanges();
    document.body.removeChild(holder);
    return ok;
  }

  function renderSplitView() {
    if (!splitView) return;
    splitView.innerHTML = '';
    const groups = buildDateGroups();

    if (groups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'peaks-split__empty';
      empty.textContent = 'No rows have a date in column H yet \u2014 uncheck this, fill in column H, then check it again.';
      splitView.appendChild(empty);
      return;
    }

    if (groups.length > 1) {
      const topbar = document.createElement('div');
      topbar.className = 'peaks-split__topbar';
      const label = document.createElement('span');
      label.className = 'peaks-split__topbar-label';
      label.textContent = groups.length + ' date groups';
      topbar.appendChild(label);
      const copyAllBtn = document.createElement('button');
      copyAllBtn.type = 'button';
      copyAllBtn.className = 'summit-btn';
      copyAllBtn.textContent = 'Copy All Groups';
      copyAllBtn.title = 'Copy every date group \u2014 each as its own Heading 2 + table \u2014 in one paste';
      copyAllBtn.addEventListener('click', async () => {
        const html = wordClipboardDocument(groups.map(buildGroupClipboardHTML).join(''));
        const text = groups.map(buildGroupClipboardText).join('\n\n');
        const ok = await copyRichHTML(html, text);
        showToast(ok ? ('Copied all ' + groups.length + ' date groups.') : 'Copy failed \u2014 try again.');
      });
      topbar.appendChild(copyAllBtn);
      splitView.appendChild(topbar);
    }

    const cols = SPLIT_COL_LETTERS.map((k) => GEN_COL[k]);
    groups.forEach((group) => {
      const section = document.createElement('section');
      section.className = 'peaks-split__group';

      const headerBar = document.createElement('div');
      headerBar.className = 'peaks-split__headerbar';
      const heading = document.createElement('h2');
      heading.className = 'peaks-split__heading';
      heading.textContent = formatLongDate(group.label);
      headerBar.appendChild(heading);

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'summit-btn peaks-split__copy';
      copyBtn.textContent = 'Copy';
      copyBtn.title = 'Copy just this date\u2019s table \u2014 pastes into Word as a Heading 2 followed by a table';
      copyBtn.addEventListener('click', async () => {
        const html = wordClipboardDocument(buildGroupClipboardHTML(group));
        const text = buildGroupClipboardText(group);
        const ok = await copyRichHTML(html, text);
        const n = group.rows.length;
        showToast(ok ? ('Copied ' + formatLongDate(group.label) + ' (' + n + ' row' + (n === 1 ? '' : 's') + ').') : 'Copy failed \u2014 try again.');
      });
      headerBar.appendChild(copyBtn);
      section.appendChild(headerBar);

      const table = document.createElement('table');
      table.className = 'peaks-split__table';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      cols.forEach((c) => {
        const th = document.createElement('th');
        th.textContent = colLabel(c);
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbodyEl = document.createElement('tbody');
      group.rows.forEach((r) => {
        const tr = document.createElement('tr');
        cols.forEach((c) => {
          const td = document.createElement('td');
          const sourceTd = cellsEl[r][c];
          if (sourceTd) td.innerHTML = cellInnerHTMLForClipboard(sourceTd);
          tr.appendChild(td);
        });
        tbodyEl.appendChild(tr);
      });
      table.appendChild(tbodyEl);
      section.appendChild(table);

      splitView.appendChild(section);
      applySplitColumnWidths(table, group);
    });
  }

  if (splitToggle) {
    splitToggle.addEventListener('change', () => {
      const on = splitToggle.checked;
      if (on && editingCell) commitEdit();
      scrollEl.hidden = on;
      splitView.hidden = !on;
      if (on) renderSplitView();
    });
  }

  window.Summit = window.Summit || { state: { mountain: {}, peaks: {}, draft: {} } };
  window.Summit.peaks = {
    getUsedRange,
    getMatrix,

    // True when no cell anywhere on the sheet holds text — used to skip
    // export/auto-download on an unused tab.
    isEmpty: () => getUsedRange().rows === 0,

    // Replaces the whole sheet with a 2D array of string values
    // (Section 4.4 import — file upload or paste; rows may be ragged).
    loadFromMatrix: (matrix) => {
      clearGrid();
      if (matrix && matrix.length) pasteMatrix(0, 0, matrix);
    }
  };
})();
