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
      const label = document.createElement('span');
      label.className = 'peaks-colhead__label';
      label.textContent = colLabel(c);
      th.appendChild(label);
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
  }

  function primaryTd() {
    return primaryCell ? cellsEl[primaryCell.r][primaryCell.c] : null;
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
      const linkEl = e.target.closest('a.peaks-link');
      if ((e.ctrlKey || e.metaKey) && linkEl) {
        e.preventDefault();
        window.open(linkEl.getAttribute('href'), '_blank', 'noopener');
        return;
      }
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
      colgroup.children[colResize.c + 1].style.width = w + 'px';
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
      editingCell.td.focus();
      restoreSelection(range);
      runFn(range);
      editingCell.td.normalize();
    } else {
      cellFn();
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
    forEachSelectedCell((td) => { td.style.textAlign = value; });
    syncToolbarState();
  }

  function setVAlign(value) {
    forEachSelectedCell((td) => { td.style.verticalAlign = value; });
    syncToolbarState();
  }

  function toggleWrap() {
    const p = primaryTd();
    if (!p) return;
    const turnOn = !p.classList.contains('peaks-cell--wrap');
    forEachSelectedCell((td, r) => {
      td.classList.toggle('peaks-cell--wrap', turnOn);
      if (turnOn && rowHeights[r] <= DEFAULT_ROW_HEIGHT) {
        rowHeights[r] = 48;
        tbody.children[r].style.height = '48px';
      }
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
    forEachSelectedCell((td) => {
      const existingMarker = td.querySelector('span.peaks-list-marker');
      const existingKind = existingMarker ? existingMarker.dataset.kind : null;
      removeListMarkers(td);
      if (existingKind === kind) return; // was already this kind — toggle off
      addListMarkers(td, kind);
      td.classList.add('peaks-cell--wrap');
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
    forEachSelectedCell((td) => {
      unwrapLinksIn(td);
      const text = td.textContent;
      td.textContent = '';
      const a = makeLinkEl(url);
      a.textContent = text;
      td.appendChild(a);
    });
    syncToolbarState();
  }

  function removeLink() {
    const range = activeEditingSelection();
    if (range) {
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
      return;
    }

    if (editingCell) commitEdit();
    forEachSelectedCell((td) => unwrapLinksIn(td));
    syncToolbarState();
  }

  function clearFormatting() {
    const range = activeEditingSelection();
    if (range) {
      editingCell.td.focus();
      restoreSelection(range);
      document.execCommand('removeFormat');
      const sel = window.getSelection();
      unwrapLinksIntersecting(sel.rangeCount ? sel.getRangeAt(0) : range, editingCell.td);
      return;
    }

    if (editingCell) commitEdit();
    forEachSelectedCell((td) => {
      td.style.cssText = '';
      td.classList.remove('peaks-cell--wrap');
      removeListMarkers(td);
      unwrapLinksIn(td);
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
      unmergeCell(sel.r1, sel.c1);
      syncToolbarState();
      return;
    }

    if (sel.r1 === sel.r2 && sel.c1 === sel.c2) {
      setHAlign('center');
      setVAlign('middle');
      return;
    }

    if (editingCell) commitEdit();
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
})();
