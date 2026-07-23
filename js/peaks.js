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
  const DEFAULT_COL_WIDTH = 96;
  const DEFAULT_ROW_HEIGHT = 26;
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

  let numRows = 0;
  let numCols = 0;
  const colWidths = [];
  const rowHeights = [];
  const cellsEl = [];      // cellsEl[r][c] -> td
  const rowHeaderEls = []; // rowHeaderEls[r] -> th
  const colHeaderEls = []; // colHeaderEls[c] -> th

  let selection = null;   // { r1, c1, r2, c2 }
  let anchor = null;      // { r, c } — where the current drag/selection began
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

  function addColumns(count) {
    for (let i = 0; i < count; i++) {
      const c = numCols;
      colWidths[c] = DEFAULT_COL_WIDTH;

      const col = document.createElement('col');
      col.style.width = DEFAULT_COL_WIDTH + 'px';
      colgroup.appendChild(col);

      const th = document.createElement('th');
      th.className = 'peaks-colhead';
      th.scope = 'col';
      th.dataset.col = c;
      th.textContent = colLabel(c);
      const handle = document.createElement('div');
      handle.className = 'peaks-colhead__resize';
      th.appendChild(handle);
      headerRow.appendChild(th);
      colHeaderEls[c] = th;

      for (let r = 0; r < numRows; r++) addCellToRow(r, c);
      numCols++;
    }
  }

  function addRows(count) {
    for (let i = 0; i < count; i++) {
      const r = numRows;
      rowHeights[r] = DEFAULT_ROW_HEIGHT;
      cellsEl[r] = [];

      const tr = document.createElement('tr');
      tr.style.height = DEFAULT_ROW_HEIGHT + 'px';

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
    if (selection) {
      paintSelection(selection, false);
      if (anchor) cellsEl[anchor.r][anchor.c].classList.remove('peaks-cell--primary');
    }
    selection = {
      r1: Math.min(r1, r2), r2: Math.max(r1, r2),
      c1: Math.min(c1, c2), c2: Math.max(c1, c2)
    };
    paintSelection(selection, true);
    cellsEl[r1][c1].classList.add('peaks-cell--primary');
    updateCellRef();
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

  function forEachSelectedCell(fn) {
    if (!selection) return;
    forRange(selection, (r, c) => fn(cellsEl[r][c], r, c));
  }

  // ============================================================
  // Editing
  // ============================================================

  function startEditing(r, c, opts) {
    opts = opts || {};
    if (editingCell) commitEdit();
    const td = cellsEl[r][c];
    editingCell = { r, c, td, previousValue: td.textContent };
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
    editingCell.td.contentEditable = 'false';
    editingCell.td.classList.remove('peaks-cell--editing');
    editingCell = null;
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
    const r = Math.min(Math.max(anchor.r + dr, 0), numRows - 1);
    const c = Math.min(Math.max(anchor.c + dc, 0), numCols - 1);
    anchor = { r, c };
    setSelection(r, c, r, c);
    cellsEl[r][c].focus({ preventScroll: false });
  }

  // ============================================================
  // Mouse interaction — click / drag selection (Section 3.1)
  // ============================================================

  tbody.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('peaks-colhead__resize') || e.target.classList.contains('peaks-rowhead__resize')) return;

    const td = e.target.closest('td.peaks-cell');
    if (td) {
      if (editingCell && editingCell.td !== td) commitEdit();
      const r = +td.dataset.row, c = +td.dataset.col;
      e.preventDefault();
      isSelecting = true;
      anchor = { r, c };
      setSelection(r, c, r, c);
      td.focus();
      return;
    }

    const rowHead = e.target.closest('th.peaks-rowhead');
    if (rowHead) {
      if (editingCell) commitEdit();
      const r = +rowHead.dataset.row;
      anchor = { r, c: 0 };
      setSelection(r, 0, r, numCols - 1);
      cellsEl[r][0].focus();
    }
  });

  headerRow.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('peaks-colhead__resize')) return;
    const colHead = e.target.closest('th.peaks-colhead');
    if (!colHead) return;
    if (editingCell) commitEdit();
    const c = +colHead.dataset.col;
    anchor = { r: 0, c };
    setSelection(0, c, numRows - 1, c);
    cellsEl[0][c].focus();
  });

  corner.addEventListener('click', () => {
    if (editingCell) commitEdit();
    anchor = { r: 0, c: 0 };
    setSelection(0, 0, numRows - 1, numCols - 1);
    cellsEl[0][0].focus();
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

  headerRow.addEventListener('mousedown', (e) => {
    if (!e.target.classList.contains('peaks-colhead__resize')) return;
    const th = e.target.parentElement;
    const c = +th.dataset.col;
    colResize = { c, startX: e.clientX, startWidth: colWidths[c] };
    scrollEl.classList.add('is-resizing');
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

  document.addEventListener('mousemove', (e) => {
    if (colResize) {
      const dx = e.clientX - colResize.startX;
      const w = Math.max(MIN_COL_WIDTH, colResize.startWidth + dx);
      colWidths[colResize.c] = w;
      colgroup.children[colResize.c].style.width = w + 'px';
    } else if (rowResize) {
      const dy = e.clientY - rowResize.startY;
      const h = Math.max(MIN_ROW_HEIGHT, rowResize.startHeight + dy);
      rowHeights[rowResize.r] = h;
      tbody.children[rowResize.r].style.height = h + 'px';
    }
  });

  document.addEventListener('mouseup', () => {
    if (colResize || rowResize) scrollEl.classList.remove('is-resizing');
    colResize = null;
    rowResize = null;
  });

  // ============================================================
  // Keyboard — navigation, editing, clearing (Section 3.1)
  // ============================================================

  grid.addEventListener('keydown', (e) => {
    if (editingCell) {
      if (e.key === 'Enter') {
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
      forEachSelectedCell((td) => { td.textContent = ''; });
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      startEditing(anchor.r, anchor.c, { clear: true, char: e.key });
    }
  });

  grid.addEventListener('focusout', (e) => {
    if (editingCell && e.target === editingCell.td) commitEdit();
  });

  // ============================================================
  // Fill colour & borders (Section 3.2)
  // ============================================================

  fillInput.addEventListener('input', () => {
    fillGlyph.style.background = fillInput.value;
    forEachSelectedCell((td) => { td.style.backgroundColor = fillInput.value; });
  });

  function borderCss(style) {
    if (style === 'thick') return '3px solid var(--ink)';
    if (style === 'dashed') return '1px dashed var(--ink)';
    return '1px solid var(--ink)';
  }

  function applyBorder(edge) {
    if (!selection) return;
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
  }

  document.querySelectorAll('.peaks-toolbar [data-border-edge]').forEach((btn) => {
    btn.addEventListener('click', () => applyBorder(btn.dataset.borderEdge));
  });

  document.getElementById('peaks-fill-clear').addEventListener('click', () => {
    forEachSelectedCell((td) => { td.style.backgroundColor = ''; });
  });

  // ============================================================
  // Init
  // ============================================================

  scrollEl.addEventListener('scroll', checkGrow);

  addColumns(COLS_INITIAL);
  addRows(ROWS_INITIAL);
  anchor = { r: 0, c: 0 };
  selection = { r1: 0, c1: 0, r2: 0, c2: 0 };
  paintSelection(selection, true);
  cellsEl[0][0].classList.add('peaks-cell--primary');
  updateCellRef();
})();
