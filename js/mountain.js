/* ---------------------------------------------------------
   Summit — mountain.js
   Section 2: Mountain tab (Word-style editor).

   - 2.1 Paginated page canvas with automatic page breaks
   - 2.2 Text formatting (bold/italic/underline/strike, colour,
         highlight, font size, case conversion)
   - 2.3 Bullet / numbered lists with nested indent levels
   - 2.4 Links and paste-and-match-formatting clipboard support
   - 2.5 Clear formatting

   Content lives directly in the DOM under #mountain-pages,
   which sits inside the (hidden-not-removed) Mountain panel —
   so switching tabs (Section 1) never loses this tab's work.
--------------------------------------------------------- */

(function () {
  'use strict';

  const root = document.getElementById('mountain');
  const toolbar = root.querySelector('.mountain-toolbar');
  const pagesContainer = document.getElementById('mountain-pages');
  const pageSizeSelect = document.getElementById('mountain-page-size');

  const forecolorInput = document.getElementById('mountain-forecolor');
  const hilitecolorInput = document.getElementById('mountain-hilitecolor');
  const forecolorGlyph = document.getElementById('mountain-forecolor-glyph');
  const hilitecolorGlyph = document.getElementById('mountain-hilite-glyph');

  const undoBtn = document.getElementById('mountain-undo');
  const redoBtn = document.getElementById('mountain-redo');

  const linkPopover = document.getElementById('mountain-link-popover');
  const linkInput = document.getElementById('mountain-link-input');
  const fontSizeInput = document.getElementById('mountain-fontsize-input');

  const PLACEHOLDER = 'Start typing your document…';
  const MAX_REPAGINATION_PASSES = 40;

  let pages = [];         // [{ el, body, numberEl }]
  let activeBody = null;  // last-focused page body
  let paginationScheduled = false;
  let savedColorRange = null;
  let savedLinkRange = null;
  let editingLinkEl = null;
  let pasteMatchStyleArmed = false; // set by Ctrl/Cmd+Shift+V, consumed by the next paste

  // ============================================================
  // Page creation & pagination engine (Section 2.1)
  // ============================================================

  function createPageDOM() {
    const pageEl = document.createElement('div');
    pageEl.className = 'mountain-page';

    const body = document.createElement('div');
    body.className = 'mountain-page__body';
    body.setAttribute('contenteditable', 'true');
    body.setAttribute('spellcheck', 'true');
    body.setAttribute('data-placeholder', PLACEHOLDER);

    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    body.appendChild(p);

    const numberEl = document.createElement('div');
    numberEl.className = 'mountain-page__number';

    pageEl.appendChild(body);
    pageEl.appendChild(numberEl);

    attachPageListeners(body);

    return { el: pageEl, body, numberEl };
  }

  function ensurePage(index) {
    while (pages.length <= index) {
      const page = createPageDOM();
      pagesContainer.appendChild(page.el);
      pages.push(page);
    }
    return pages[index];
  }

  function isUndoRedoShortcut(e) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return false;
    const key = e.key.toLowerCase();
    return key === 'z' || key === 'y';
  }

  // ============================================================
  // Undo / redo history
  //
  // The browser's native undo is intentionally disabled (see the
  // keydown handler in attachPageListeners below) because repagination
  // moves paragraphs between page bodies with plain DOM calls, which
  // desyncs the browser's own undo stack from the DOM. Instead we keep
  // our own history: snapshots of every page body's innerHTML, taken
  // before and after each change.
  //
  // A snapshot is the whole set of page bodies rather than a single
  // page, since an edit (or its undo) can shift content across a page
  // boundary; restoring page-by-page keeps that in sync automatically.
  //
  // Typing is grouped: a burst of keystrokes with no pause longer than
  // HISTORY_IDLE_MS becomes a single undo step, the same way Word/most
  // editors batch typing rather than undoing one character at a time.
  // Toolbar actions (bold, lists, colour, links, paste...) each close
  // out any pending typing burst and become their own standalone step.
  // ============================================================

  const HISTORY_LIMIT = 100;
  const HISTORY_IDLE_MS = 600;

  let undoStack = [];
  let redoStack = [];
  let isApplyingHistory = false;
  let pendingBefore = null;
  let historyIdleTimer = null;

  function snapshotPages() {
    return pages.map((p) => p.body.innerHTML);
  }

  function snapshotsEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function restorePages(snapshot) {
    while (pages.length < snapshot.length) ensurePage(pages.length);
    while (pages.length > snapshot.length) {
      const last = pages.pop();
      pagesContainer.removeChild(last.el);
    }
    pages.forEach((p, i) => {
      p.body.innerHTML = snapshot[i];
      updateEmptyState(p.body);
    });
    renumberPages();

    // Land the cursor at the end of the document, focused, so typing
    // can continue right away — restoring the exact original caret
    // position isn't reliable once the underlying nodes have been
    // replaced wholesale.
    const last = pages[pages.length - 1];
    if (last) {
      last.body.focus();
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(last.body);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
      activeBody = last.body;
    }
  }

  function updateHistoryButtons() {
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
  }

  function pushHistoryEntry(before, after) {
    if (snapshotsEqual(before, after)) return;
    undoStack.push({ before, after });
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
    updateHistoryButtons();
  }

  // Marks the start of a change burst (first keystroke after idle).
  // Safe to call repeatedly — only the first call in a burst counts.
  function noteHistoryBefore() {
    if (isApplyingHistory) return;
    if (pendingBefore === null) pendingBefore = snapshotPages();
  }

  // Called after each change; closes the burst into one undo step once
  // HISTORY_IDLE_MS passes with no further changes.
  function noteHistoryAfter() {
    if (isApplyingHistory || pendingBefore === null) return;
    clearTimeout(historyIdleTimer);
    historyIdleTimer = setTimeout(() => {
      const after = snapshotPages();
      pushHistoryEntry(pendingBefore, after);
      pendingBefore = null;
    }, HISTORY_IDLE_MS);
  }

  // Closes out any in-progress typing burst immediately, so a toolbar
  // action or undo/redo itself doesn't get merged with prior typing.
  function flushHistory() {
    if (pendingBefore === null) return;
    clearTimeout(historyIdleTimer);
    const after = snapshotPages();
    pushHistoryEntry(pendingBefore, after);
    pendingBefore = null;
  }

  // Wraps a single discrete action (toolbar button, paste, link edit...)
  // as its own standalone undo step.
  function recordHistoryStep(fn) {
    flushHistory();
    const before = snapshotPages();
    isApplyingHistory = true;
    fn();
    isApplyingHistory = false;
    const after = snapshotPages();
    pushHistoryEntry(before, after);
  }

  function undo() {
    flushHistory();
    if (!undoStack.length) return;
    const entry = undoStack.pop();
    isApplyingHistory = true;
    restorePages(entry.before);
    isApplyingHistory = false;
    redoStack.push(entry);
    updateHistoryButtons();
    schedulePagination();
  }

  function redo() {
    if (!redoStack.length) return;
    const entry = redoStack.pop();
    isApplyingHistory = true;
    restorePages(entry.after);
    isApplyingHistory = false;
    undoStack.push(entry);
    updateHistoryButtons();
    schedulePagination();
  }

  if (undoBtn) undoBtn.addEventListener('click', undo);
  if (redoBtn) redoBtn.addEventListener('click', redo);

  // Ctrl+Shift+V / Cmd+Shift+V — "paste and match [page] formatting".
  // The browser still fires a normal `paste` event for this shortcut, so
  // we just flag it here and read the flag once, in handlePaste.
  function isPasteMatchStyleShortcut(e) {
    const mod = e.metaKey || e.ctrlKey;
    return mod && e.shiftKey && e.key.toLowerCase() === 'v';
  }

  function attachPageListeners(body) {
    // Captured before the DOM actually mutates, so it's a true "before"
    // snapshot — only takes effect at the start of a burst (see
    // noteHistoryBefore).
    body.addEventListener('beforeinput', (e) => {
      noteHistoryBefore();
      handleCrossPageBeforeInput(e);
    });
    body.addEventListener('input', () => {
      updateEmptyState(body);
      schedulePagination();
      noteHistoryAfter();
    });
    body.addEventListener('paste', handlePaste);
    body.addEventListener('copy', handleCopyOrCut);
    body.addEventListener('cut', handleCopyOrCut);
    // The browser's native undo/redo isn't aware that repagination moves
    // paragraphs between page bodies with plain DOM calls, not
    // execCommand. Letting the native version run against that can desync
    // the browser's internal edit state from the DOM — the editor then
    // stops responding to clicks until some other edit (e.g. a spelling
    // fix) forces a repagination pass that happens to resync things.
    // So the shortcut is still blocked from reaching the browser, but now
    // it drives our own history stack instead of just doing nothing.
    body.addEventListener('keydown', (e) => {
      if (isUndoRedoShortcut(e)) {
        e.preventDefault();
        if (e.shiftKey || e.key.toLowerCase() === 'y') redo();
        else undo();
        return;
      }
      if (isPasteMatchStyleShortcut(e)) pasteMatchStyleArmed = true;

      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectEntireDocument();
        return;
      }

      if ((e.key === 'Backspace' || e.key === 'Delete') && !mod) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount && !sel.isCollapsed) {
          const range = sel.getRangeAt(0);
          if (inMountain(range.commonAncestorContainer) && selectionSpansMultiplePages(range)) {
            e.preventDefault();
            noteHistoryBefore();
            collapseSelectionAcrossPages(sel, range);
            schedulePagination();
            noteHistoryAfter();
          }
        }
      }
    });
    body.addEventListener('focus', () => {
      activeBody = body;
    });
  }

  // ============================================================
  // Cross-page selection, Ctrl+A, and edits over a cross-page
  // selection (Section 2.1b)
  //
  // Each page body is its own contenteditable region — that's what
  // lets the pagination engine move whole paragraphs between page
  // divs with plain DOM calls. The trade-off is that a browser's own
  // click-and-drag selection, and its own Ctrl+A/Backspace handling,
  // normally stay confined to a single contenteditable root. The
  // pieces below make selection, "select all", copy, and delete treat
  // #mountain-pages as one continuous document instead, which is what
  // actually lets text flow, get selected, and get edited across a
  // page break the way it does in Word.
  // ============================================================

  function caretFromPoint(x, y) {
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      return r ? { node: r.startContainer, offset: r.startOffset } : null;
    }
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    return null;
  }

  let dragAnchor = null;
  let isDragSelecting = false;

  pagesContainer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('a')) return; // let link clicks behave normally
    const pos = caretFromPoint(e.clientX, e.clientY);
    dragAnchor = pos;
    isDragSelecting = false;
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragAnchor) return;
    if (e.buttons !== 1) { dragAnchor = null; isDragSelecting = false; return; }
    const pos = caretFromPoint(e.clientX, e.clientY);
    if (!pos) return;

    // Only step in once the drag actually needs to cross a page
    // boundary. Each page body is its own contenteditable region, so
    // the browser already handles an in-page drag itself — including
    // preserving double-/triple-click word/line selection granularity
    // (dragging after a double-click extends the selection one whole
    // word at a time, snapped to word boundaries). Overriding the
    // selection here unconditionally replaced that native word-drag
    // behaviour with a raw character-precise range instead, anchored
    // at the exact pixel of the original mousedown — which usually
    // lands partway through the first word rather than at its start,
    // so the whole highlighted selection reads as shifted right of
    // where the word actually begins. Stepping aside for in-page
    // drags leaves the browser's own (correct) behaviour in place;
    // the character-precise range below only kicks in for the
    // cross-page case it was actually written for.
    const anchorPage = pages.find((p) => p.body.contains(dragAnchor.node));
    const posPage = pages.find((p) => p.body.contains(pos.node));
    if (anchorPage && posPage && anchorPage === posPage) return;

    isDragSelecting = true;
    const sel = window.getSelection();
    try {
      sel.setBaseAndExtent(dragAnchor.node, dragAnchor.offset, pos.node, pos.offset);
      e.preventDefault();
    } catch (err) {
      // Anchor node went stale (e.g. a repagination pass moved it mid-drag).
      dragAnchor = pos;
    }
  });

  document.addEventListener('mouseup', () => {
    dragAnchor = null;
    isDragSelecting = false;
  });

  function selectionSpansMultiplePages(range) {
    const startPage = pages.find((p) => p.body.contains(range.startContainer));
    const endPage = pages.find((p) => p.body.contains(range.endContainer));
    return !!(startPage && endPage && startPage !== endPage);
  }

  function selectEntireDocument() {
    if (!pages.length) return;
    const firstBody = pages[0].body;
    const lastBody = pages[pages.length - 1].body;
    const range = document.createRange();
    range.setStart(firstBody, 0);
    range.setEnd(lastBody, lastBody.childNodes.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Deletes a selection that spans two or more page bodies. This uses
  // plain Range.deleteContents() rather than execCommand('delete', ...)
  // because execCommand only ever acts within the currently-focused
  // contenteditable — it can't reach across into a different page's
  // body — while Range operations work on the DOM directly regardless
  // of which element happens to be focused.
  function deleteRangeAcrossPages(range) {
    const startContainer = range.startContainer;
    const startOffset = range.startOffset;
    range.deleteContents();
    pages.forEach((p) => {
      if (!p.body.firstElementChild) {
        const el = document.createElement('p');
        el.appendChild(document.createElement('br'));
        p.body.appendChild(el);
      }
    });
    return { node: startContainer, offset: startOffset };
  }

  function collapseSelectionAcrossPages(sel, range) {
    const landed = deleteRangeAcrossPages(range);
    try {
      const collapsed = document.createRange();
      collapsed.setStart(landed.node, landed.offset);
      collapsed.collapse(true);
      sel.removeAllRanges();
      sel.addRange(collapsed);
    } catch (err) { /* the anchor was itself removed; leave selection as-is */ }
  }

  // Typing, pasting, or pressing Enter over a selection that spans two
  // page bodies needs the same manual-delete treatment as Backspace/
  // Delete above, since the browser's own "replace selection" behaviour
  // for beforeinput is likewise confined to one contenteditable root.
  const CROSS_PAGE_INPUT_TYPES = new Set([
    'insertText', 'insertReplacementText', 'insertParagraph', 'insertLineBreak',
    'deleteContentBackward', 'deleteContentForward', 'deleteWordBackward',
    'deleteWordForward', 'deleteSoftLineBackward', 'deleteSoftLineForward'
  ]);

  function handleCrossPageBeforeInput(e) {
    if (!CROSS_PAGE_INPUT_TYPES.has(e.inputType)) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!inMountain(range.commonAncestorContainer) || !selectionSpansMultiplePages(range)) return;

    e.preventDefault();
    const landed = deleteRangeAcrossPages(range);
    try {
      const collapsed = document.createRange();
      collapsed.setStart(landed.node, landed.offset);
      collapsed.collapse(true);
      sel.removeAllRanges();
      sel.addRange(collapsed);
    } catch (err) { /* fall through without re-inserting */ return; }

    if (e.inputType === 'insertText' && e.data) {
      document.execCommand('insertText', false, e.data);
    } else if (e.inputType === 'insertReplacementText' && e.dataTransfer) {
      document.execCommand('insertText', false, e.dataTransfer.getData('text/plain'));
    } else if (e.inputType === 'insertParagraph') {
      document.execCommand('insertParagraph', false, null);
    } else if (e.inputType === 'insertLineBreak') {
      document.execCommand('insertLineBreak', false, null);
    }
    schedulePagination();
  }

  function updateEmptyState(body) {
    const empty = body.textContent.trim() === '' && body.querySelectorAll('a, img, li').length === 0;
    body.classList.toggle('is-empty', empty);
  }

  function schedulePagination() {
    if (paginationScheduled) return;
    paginationScheduled = true;
    requestAnimationFrame(() => {
      paginationScheduled = false;
      repaginate();
    });
  }

  function repaginate() {
    if (!pages.length) ensurePage(0);

    const sel = window.getSelection();
    let savedRange = null;
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (pagesContainer.contains(r.startContainer)) savedRange = r.cloneRange();
    }

    let changed = true;
    let passes = 0;

    while (changed && passes < MAX_REPAGINATION_PASSES) {
      changed = false;
      passes++;

      // 1. Push overflowing trailing block nodes forward onto the next page.
      for (let i = 0; i < pages.length; i++) {
        const body = pages[i].body;
        while (body.scrollHeight > body.clientHeight + 1 && body.children.length > 1) {
          const nextBody = ensurePage(i + 1).body;
          nextBody.insertBefore(body.lastElementChild, nextBody.firstChild);
          changed = true;
        }
        // A single paragraph (or the last one after the loop above) can
        // still be taller than the whole page on its own — split it at
        // the line where the page runs out of room instead of letting
        // it overflow past the margin.
        if (body.scrollHeight > body.clientHeight + 1) {
          const nextBody = ensurePage(i + 1).body;
          if (trySplitLastParagraph(body, nextBody)) changed = true;
        }
      }

      // 2. Pull content back from the next page while there's room (reflow on delete).
      for (let i = 0; i < pages.length - 1; i++) {
        const body = pages[i].body;
        const nextBody = pages[i + 1].body;
        while (nextBody.firstElementChild) {
          const node = nextBody.firstElementChild;
          const prev = body.lastElementChild;
          const isContinuation = continuationParagraphs.has(node);

          if (isContinuation && prev && prev.tagName === node.tagName) {
            // This paragraph only exists because its source paragraph
            // was split across this page boundary — merge it back into
            // that paragraph rather than appending it as a new one, so
            // a shrink-edit doesn't leave a stray extra paragraph break
            // behind. If it still doesn't fit, trySplitLastParagraph
            // below finds the (now possibly different) break point
            // again instead of us guessing.
            if (prev.childNodes.length === 1 && prev.firstChild.nodeType === 1 && prev.firstChild.tagName === 'BR') prev.innerHTML = '';
            if (prev.lastChild) prev.appendChild(document.createTextNode(' '));
            while (node.firstChild) prev.appendChild(node.firstChild);
            nextBody.removeChild(node);
            prev.normalize();
            changed = true;
            if (body.scrollHeight > body.clientHeight + 1) {
              trySplitLastParagraph(body, nextBody);
              break;
            }
            continue;
          }

          body.appendChild(node);
          if (body.scrollHeight > body.clientHeight + 1) {
            nextBody.insertBefore(node, nextBody.firstChild);
            break;
          }
          changed = true;
        }
      }

      // 3. Drop trailing pages that have ended up empty.
      while (pages.length > 1) {
        const last = pages[pages.length - 1];
        const onlyChild = last.body.children.length === 1 ? last.body.firstElementChild : null;
        const isEmpty = last.body.children.length === 0 ||
          (onlyChild && onlyChild.tagName === 'P' && onlyChild.textContent.trim() === '');
        if (isEmpty && document.activeElement !== last.body) {
          pagesContainer.removeChild(last.el);
          pages.pop();
          changed = true;
        } else {
          break;
        }
      }
    }

    // Guarantee every page has somewhere for the caret to land.
    pages.forEach((page) => {
      if (!page.body.firstElementChild) {
        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        page.body.appendChild(p);
      }
      updateEmptyState(page.body);
    });

    renumberPages();

    if (savedRange) {
      try {
        sel.removeAllRanges();
        sel.addRange(savedRange);

        // Repagination can reparent the paragraph the caret was in onto a
        // different page's body div (see the push/pull passes above).
        // Restoring the Range doesn't move browser focus with it, so
        // without this, document.activeElement can stay pinned to the
        // old page while the caret visually shows up on the new one —
        // clicks/typing then land in the wrong place until something
        // forces a fresh focus.
        const landedNode = savedRange.startContainer;
        const landedEl = landedNode.nodeType === 1 ? landedNode : landedNode.parentElement;
        const landedPage = pages.find((p) => p.body.contains(landedEl));
        if (landedPage && document.activeElement !== landedPage.body) {
          landedPage.body.focus({ preventScroll: true });
          sel.removeAllRanges();
          sel.addRange(savedRange);
          activeBody = landedPage.body;
        }
      } catch (err) {
        // The saved anchor is no longer attached; leave selection as-is.
      }
    }
  }

  function renumberPages() {
    pages.forEach((page, i) => {
      page.numberEl.textContent = (i + 1) + ' / ' + pages.length;
    });
  }

  // ============================================================
  // Mid-paragraph splitting (Section 2.1a)
  //
  // The push/pull passes above move whole block elements (a <p>, an
  // <li>...) between pages. That's fine as long as no single paragraph
  // is taller than the space left on a page — but when one is (a long
  // paragraph, or simply the tail end of a page), there was previously
  // nothing to push it onto the next page WITHOUT leaving the page
  // empty, so it just sat there and visually overflowed past the page
  // margin, clipped by the page body's `overflow: hidden`. That's the
  // "overlapping/cut-off bottom line" behaviour.
  //
  // trySplitLastParagraph fixes this the way Word/Google Docs do: it
  // finds the exact point inside the paragraph's text where the page
  // runs out of room and physically splits the paragraph there, moving
  // the remainder onto the next page as a "continuation" paragraph
  // (tracked in continuationParagraphs so a later shrink-edit can
  // re-merge it — see the pull-back pass in repaginate()).
  // ============================================================

  // Tracks paragraphs that only exist because a longer paragraph was
  // split across a page boundary, so the pull-back pass can re-merge
  // them into their source paragraph once things shrink and everything
  // fits back on one page. A WeakSet (rather than a data-attribute)
  // so this bookkeeping never leaks into saved/exported/copied HTML.
  const continuationParagraphs = new WeakSet();

  function collectTextNodes(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  // Attempts to relieve an overflowing page by splitting its last
  // paragraph/div at the line where the page's available height runs
  // out, moving the remainder onto nextBody as a new paragraph. Falls
  // back to moving the whole block over if not even its first line
  // fits. Returns true if it changed anything.
  function trySplitLastParagraph(body, nextBody) {
    const last = body.lastElementChild;
    if (!last || (last.tagName !== 'P' && last.tagName !== 'DIV')) return false;
    // Lists, tables, and images aren't (yet) safe to cut mid-element —
    // leave those to the whole-block push/pull passes.
    if (last.querySelector('ul, ol, table, img')) return false;

    const textNodes = collectTextNodes(last);
    if (!textNodes.length) return false;
    const lengths = textNodes.map((n) => n.data.length);
    const total = lengths.reduce((a, b) => a + b, 0);
    if (total === 0) return false;

    function offsetToNode(globalOffset) {
      let remaining = globalOffset;
      for (let i = 0; i < textNodes.length; i++) {
        if (remaining <= lengths[i]) return { node: textNodes[i], offset: remaining };
        remaining -= lengths[i];
      }
      const li = textNodes.length - 1;
      return { node: textNodes[li], offset: lengths[li] };
    }

    const bodyRect = body.getBoundingClientRect();
    const availableBottom = bodyRect.top + body.clientHeight;

    function bottomAt(globalOffset) {
      if (globalOffset <= 0) {
        const r = document.createRange();
        r.setStart(last, 0);
        r.collapse(true);
        const rect = r.getBoundingClientRect();
        return rect.bottom || last.getBoundingClientRect().top;
      }
      const { node, offset } = offsetToNode(globalOffset);
      const r = document.createRange();
      r.setStart(last, 0);
      r.setEnd(node, offset);
      const rects = r.getClientRects();
      return rects.length ? rects[rects.length - 1].bottom : last.getBoundingClientRect().bottom;
    }

    // Not even the first character fits (the page is already full of
    // other content) — move the whole paragraph forward instead.
    if (bottomAt(1) > availableBottom) {
      nextBody.insertBefore(last, nextBody.firstChild);
      return true;
    }
    if (bottomAt(total) <= availableBottom) return false; // fits after all

    let lo = 0;
    let hi = total;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (bottomAt(mid) <= availableBottom) lo = mid; else hi = mid;
    }

    // Snap back to the previous word boundary so the break lands
    // between words rather than mid-word, the way Word wraps text.
    const flatText = textNodes.map((n) => n.data).join('');
    let snapped = lo;
    const windowStart = Math.max(0, lo - 120);
    const idx = flatText.lastIndexOf(' ', lo - 1);
    if (idx >= windowStart && idx >= 0) snapped = idx + 1;
    if (snapped <= 0) snapped = lo;

    const { node, offset } = offsetToNode(snapped);
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEndAfter(last.lastChild);
    const tailFrag = range.extractContents();

    // Trim the leading space left behind by the word-boundary snap.
    const firstText = collectTextNodes(tailFrag)[0];
    if (firstText) firstText.data = firstText.data.replace(/^ /, '');

    if (!tailFrag.firstChild) return false; // nothing left to move — treat as fitting

    const continuation = document.createElement(last.tagName);
    if (last.className) continuation.className = last.className;
    continuation.appendChild(tailFrag);
    continuationParagraphs.add(continuation);

    nextBody.insertBefore(continuation, nextBody.firstChild);

    if (!last.firstChild || last.textContent.trim() === '') {
      last.appendChild(document.createElement('br'));
    }
    return true;
  }

  // ============================================================
  // Toolbar: standard execCommand formatting (2.2, 2.3)
  // ============================================================

  function inMountain(node) {
    return !!node && pagesContainer.contains(node);
  }

  function currentRangeInMountain() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    return inMountain(range.commonAncestorContainer) ? range : null;
  }

  toolbar.addEventListener('mousedown', (e) => {
    const target = e.target.closest('[data-cmd], [data-action]');
    if (!target) return;
    // Colour swatches and the page-size select need their own native
    // focus/click behaviour, so don't hold selection for those.
    if (target.closest('.mountain-swatch') || target.tagName === 'SELECT') return;
    // Keep focus (and the current selection) inside the page body so the
    // upcoming execCommand/action applies to the right text.
    e.preventDefault();
  });

  toolbar.addEventListener('click', (e) => {
    const target = e.target.closest('[data-cmd], [data-action]');
    if (!target || target.closest('.mountain-swatch')) return;

    const cmd = target.dataset.cmd;
    const action = target.dataset.action;

    if (cmd) {
      recordHistoryStep(() => document.execCommand(cmd, false, null));
      updateToolbarState();
      schedulePagination();
      return;
    }

    switch (action) {
      case 'font-size-increase': recordHistoryStep(() => adjustFontSize(2)); break;
      case 'font-size-decrease': recordHistoryStep(() => adjustFontSize(-2)); break;
      case 'uppercase': recordHistoryStep(() => transformCase('upper')); break;
      case 'lowercase': recordHistoryStep(() => transformCase('lower')); break;
      case 'indent': recordHistoryStep(() => document.execCommand('indent', false, null)); break;
      case 'outdent': recordHistoryStep(() => document.execCommand('outdent', false, null)); break;
      case 'link': openLinkPopover(); break; // opens a popover; saveLink/removeLink record the step
      case 'unlink': recordHistoryStep(() => removeLink()); break;
      case 'clear-format': recordHistoryStep(() => clearFormatting()); break;
      default: break;
    }
    schedulePagination();
  });

  function updateToolbarState() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !inMountain(sel.anchorNode)) return;
    ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'].forEach((cmd) => {
      const btn = toolbar.querySelector('[data-cmd="' + cmd + '"]');
      if (!btn) return;
      let state = false;
      try { state = document.queryCommandState(cmd); } catch (err) { /* unsupported in this browser */ }
      btn.setAttribute('aria-pressed', String(state));
    });
  }

  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && inMountain(sel.anchorNode)) {
      updateToolbarState();
      updateFontSizeDisplay();
    }
  });

  // ============================================================
  // Colour swatches (2.2)
  // ============================================================

  function armColorInput(input) {
    input.addEventListener('mousedown', () => {
      const sel = window.getSelection();
      savedColorRange = (sel && sel.rangeCount) ? sel.getRangeAt(0).cloneRange() : null;
    });
    input.addEventListener('input', () => applyColor(input));
    input.addEventListener('change', () => applyColor(input));
  }

  function applyColor(input) {
    if (savedColorRange && inMountain(savedColorRange.commonAncestorContainer)) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedColorRange);
    } else {
      return;
    }

    const cmd = input.dataset.cmd;
    const value = input.value;
    recordHistoryStep(() => {
      let ok = false;
      try { ok = document.execCommand(cmd, false, value); } catch (err) { /* ignore */ }
      if (!ok && cmd === 'hiliteColor') {
        try { document.execCommand('backColor', false, value); } catch (err) { /* ignore */ }
      }
    });

    if (cmd === 'foreColor') {
      forecolorGlyph.style.color = value;
    } else {
      hilitecolorGlyph.style.setProperty('--current-hilite', value);
    }

    schedulePagination();
  }

  armColorInput(forecolorInput);
  armColorInput(hilitecolorInput);

  // ============================================================
  // Font size (2.2)
  // ============================================================

  function wrapRangeInFontSize(range, sizePx) {
    const frag = range.extractContents();
    const span = document.createElement('span');
    span.style.fontSize = sizePx + 'px';
    span.appendChild(frag);
    range.insertNode(span);

    const sel = window.getSelection();
    const newRange = document.createRange();
    newRange.selectNodeContents(span);
    sel.removeAllRanges();
    sel.addRange(newRange);
    return span;
  }

  function adjustFontSize(delta) {
    const range = currentRangeInMountain();
    if (!range || range.collapsed) return;

    const refEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const currentSize = parseFloat(getComputedStyle(refEl).fontSize) || 13;
    const newSize = Math.max(8, Math.min(96, Math.round(currentSize + delta)));

    wrapRangeInFontSize(range, newSize);
    updateFontSizeDisplay();
  }

  // Returns the selection's font size in px, or null if the selection
  // spans more than one size (so the toolbar box can show blank, the
  // same way Word's font-size box goes blank over a mixed selection).
  function computeSelectionFontSize(range) {
    if (range.collapsed) {
      const el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      const size = el ? parseFloat(getComputedStyle(el).fontSize) : NaN;
      return isNaN(size) ? null : Math.round(size);
    }

    const root = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentNode;
    if (!root) return null;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let size = null;
    let node = walker.nextNode();
    while (node) {
      if (range.intersectsNode(node) && node.data.trim() !== '') {
        const el = node.parentElement;
        const s = el ? Math.round(parseFloat(getComputedStyle(el).fontSize)) : NaN;
        if (!isNaN(s)) {
          if (size === null) size = s;
          else if (size !== s) return null; // mixed
        }
      }
      node = walker.nextNode();
    }
    return size;
  }

  function updateFontSizeDisplay() {
    const range = currentRangeInMountain();
    const size = range ? computeSelectionFontSize(range) : null;
    fontSizeInput.value = size == null ? '' : String(size);
  }

  let savedFontSizeRange = null;

  fontSizeInput.addEventListener('mousedown', () => {
    const sel = window.getSelection();
    savedFontSizeRange = (sel && sel.rangeCount && inMountain(sel.anchorNode)) ? sel.getRangeAt(0).cloneRange() : null;
  });

  function commitFontSizeInput() {
    const raw = parseFloat(fontSizeInput.value);
    if (isNaN(raw)) return;
    if (!savedFontSizeRange || !inMountain(savedFontSizeRange.commonAncestorContainer) || savedFontSizeRange.collapsed) return;

    const size = Math.max(8, Math.min(96, Math.round(raw)));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedFontSizeRange);

    recordHistoryStep(() => wrapRangeInFontSize(savedFontSizeRange, size));
    schedulePagination();
    updateFontSizeDisplay();
    fontSizeInput.blur();
  }

  fontSizeInput.addEventListener('change', commitFontSizeInput);
  fontSizeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitFontSizeInput(); }
    if (e.key === 'Escape') { e.preventDefault(); updateFontSizeDisplay(); fontSizeInput.blur(); }
  });

  // ============================================================
  // UPPERCASE / lowercase (2.2) — rewrites text node data only,
  // so surrounding bold/italic/link formatting is preserved.
  // ============================================================

  function transformCase(mode) {
    const range = currentRangeInMountain();
    if (!range || range.collapsed) return;

    const root = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentNode;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const targets = [];
    let node = walker.nextNode();
    while (node) {
      if (range.intersectsNode(node)) targets.push(node);
      node = walker.nextNode();
    }

    targets.forEach((textNode) => {
      const start = (textNode === range.startContainer) ? range.startOffset : 0;
      const end = (textNode === range.endContainer) ? range.endOffset : textNode.data.length;
      if (start >= end) return;
      const before = textNode.data.slice(0, start);
      const middle = textNode.data.slice(start, end);
      const after = textNode.data.slice(end);
      textNode.data = before + (mode === 'upper' ? middle.toUpperCase() : middle.toLowerCase()) + after;
    });
  }

  // ============================================================
  // Clear formatting (2.5)
  // ============================================================

  function clearFormatting() {
    const range = currentRangeInMountain();
    if (!range || range.collapsed) return;

    const container = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!container || !container.querySelectorAll) return;

    // Decide what to touch *before* mutating anything or calling
    // execCommand — some browsers collapse the selection once
    // removeFormat runs, so searching for leftovers afterwards can miss
    // most of what was actually selected. The still-live original range
    // is the reliable thing to test intersection against.
    //
    // Inline tags get unwrapped (tag removed, contents kept). Any other
    // element carrying a leftover inline style — including a pasted
    // <p style="font-size:...">, <div style="color:...">, or <li> —
    // just has that style attribute stripped, since paste sanitisation
    // allows style on any allowed tag, not only spans. Links keep their
    // tag (so the hyperlink itself survives) but lose custom styling too.
    const UNWRAP_SELECTOR = 'span[style], font, mark, b, strong, i, em, u, s, strike';
    const toUnwrap = [];
    const toStripStyle = [];

    function consider(el) {
      if (!el || el.nodeType !== 1 || !range.intersectsNode(el)) return;
      if (el.matches(UNWRAP_SELECTOR)) {
        if (toUnwrap.indexOf(el) === -1) toUnwrap.push(el);
      } else if (el.hasAttribute('style') && toStripStyle.indexOf(el) === -1) {
        toStripStyle.push(el);
      }
    }

    // querySelectorAll only returns descendants — container itself can
    // legitimately BE the formatted element (e.g. the selection exactly
    // covers one <span style="font-size:...">), so it must be checked too.
    consider(container);
    container.querySelectorAll('*').forEach(consider);

    toUnwrap.forEach((el) => {
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    });
    toStripStyle.forEach((el) => el.removeAttribute('style'));

    try { document.execCommand('removeFormat', false, null); } catch (err) { /* ignore */ }

    container.normalize();
    schedulePagination();
  }

  // ============================================================
  // Links (2.4)
  // ============================================================

  function getAncestorLink(node) {
    let el = node && node.nodeType === 1 ? node : (node && node.parentElement);
    while (el && el !== pagesContainer) {
      if (el.tagName === 'A') return el;
      el = el.parentElement;
    }
    return null;
  }

  function openLinkPopover() {
    const range = currentRangeInMountain();
    if (!range) return;

    editingLinkEl = getAncestorLink(range.startContainer);
    if (range.collapsed && !editingLinkEl) return; // need selected text to link

    savedLinkRange = range.cloneRange();
    linkInput.value = editingLinkEl ? (editingLinkEl.getAttribute('href') || '') : '';

    const rect = (editingLinkEl || range).getBoundingClientRect();
    linkPopover.style.top = (rect.bottom + window.scrollY + 8) + 'px';
    const maxLeft = window.innerWidth - 280;
    const left = Math.max(12, Math.min(rect.left + window.scrollX, maxLeft));
    linkPopover.style.left = left + 'px';

    linkPopover.hidden = false;
    linkInput.focus();
    linkInput.select();
  }

  function closeLinkPopover() {
    linkPopover.hidden = true;
    editingLinkEl = null;
    savedLinkRange = null;
  }

  function saveLink() {
    const url = linkInput.value.trim();
    if (!url) { closeLinkPopover(); return; }

    const sel = window.getSelection();
    if (savedLinkRange) {
      sel.removeAllRanges();
      sel.addRange(savedLinkRange);
    }

    recordHistoryStep(() => {
      if (editingLinkEl) {
        editingLinkEl.setAttribute('href', url);
        editingLinkEl.setAttribute('title', url);
      } else {
        document.execCommand('createLink', false, url);
        const sel2 = window.getSelection();
        if (sel2.rangeCount) {
          const link = getAncestorLink(sel2.getRangeAt(0).startContainer);
          if (link) {
            link.setAttribute('target', '_blank');
            link.setAttribute('rel', 'noopener noreferrer');
            link.setAttribute('title', url);
          }
        }
      }
    });

    closeLinkPopover();
    schedulePagination();
  }

  function removeLink() {
    const range = currentRangeInMountain();
    if (!range) return;
    const link = getAncestorLink(range.commonAncestorContainer);
    if (link) {
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(link);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    try { document.execCommand('unlink', false, null); } catch (err) { /* ignore */ }
  }

  linkPopover.querySelector('[data-action="link-save"]').addEventListener('click', saveLink);
  linkPopover.querySelector('[data-action="link-cancel"]').addEventListener('click', closeLinkPopover);

  linkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveLink(); }
    if (e.key === 'Escape') { e.preventDefault(); closeLinkPopover(); }
  });

  document.addEventListener('mousedown', (e) => {
    if (!linkPopover.hidden && !linkPopover.contains(e.target) && !e.target.closest('[data-action="link"]')) {
      closeLinkPopover();
    }
  });

  // ============================================================
  // Paste — match formatting, don't break the page layout (2.4)
  // ============================================================

  const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'A', 'UL', 'OL', 'LI', 'P', 'BR', 'SPAN', 'DIV']);
  const ALLOWED_STYLES = new Set(['color', 'background-color', 'font-weight', 'font-style', 'text-decoration', 'font-size']);
  // Removed outright (content and all) rather than unwrapped — their text
  // content (script/style source, embed markup) isn't real document text.
  const STRIP_ENTIRELY = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'NOSCRIPT']);
  const SAFE_URL = /^(https?:|mailto:|tel:|\/|#)/i;

  // ------------------------------------------------------------
  // Normalizing Word/Outlook paste artifacts (2.4a)
  //
  // Word/Outlook HTML doesn't describe a letter the way a browser
  // would. Two things it does that bite us specifically:
  //
  //  1. A simple visual line-wrap (typed at a fixed width, or just
  //     Word's own layout) is very often serialized as its own
  //     <p class="MsoNormal" style="...mso-margin-top-alt:auto;...">
  //     rather than living inside one flowing paragraph. Word hides
  //     the seam by rendering that "no extra spacing" pair with zero
  //     visible gap, so on screen — including once pasted in here,
  //     since we keep the structure — it reads as one paragraph. But
  //     it's still N separate paragraphs under the hood, and reading
  //     the content back out as plain text (Copy template, export,
  //     clipboard copy) turns every one of those into a real newline.
  //
  //  2. A bulleted/numbered list isn't a real <ul>/<ol> at all — each
  //     item is a <p style="mso-list:l# level# lfo#"> whose bullet or
  //     number is a plain character sitting in a leading
  //     <span style="mso-list:Ignore">, usually styled with
  //     font-family:Symbol or font-family:Wingdings so it renders as
  //     a bullet glyph. Our style allow-list strips font-family
  //     (see ALLOWED_STYLES below), so that character survives but
  //     renders in whatever font happens to be active instead —
  //     which is why a Word bullet can come out looking like a random
  //     dingbat (a clock, a smiley, ...) instead of a bullet or number.
  //
  // Both need to be resolved before sanitizeHTML/matchPageFormatting
  // strip the mso- styles and classes that mark them, so this runs
  // first, on the untouched parsed HTML.
  function normalizeWordPasteArtifacts(root) {
    convertWordListParagraphs(root);
    mergeWordLineWraps(root);
  }

  // Rebuilds Word's fake "list built from paragraphs" markup into a
  // real <ul>/<ol><li> tree, discarding the raw bullet/number marker
  // rather than trying to preserve a glyph that depends on a font we
  // don't ship (see note above).
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

  // Merges consecutive "no extra spacing" Word paragraphs (and lone
  // mid-paragraph <br>s, which Word also uses as wrap points) back
  // into one real paragraph, joined with a single space. A run that
  // includes an explicitly empty paragraph is treated as a genuine
  // blank line and kept as one.
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

    // A lone <br> (not part of a deliberate run of 2+) inside any
    // remaining paragraph is almost always a Word wrap point too.
    Array.from(root.querySelectorAll('br')).forEach((br) => {
      const prev = br.previousSibling;
      const next = br.nextSibling;
      const prevIsBr = prev && prev.nodeType === 1 && prev.tagName === 'BR';
      const nextIsBr = next && next.nodeType === 1 && next.tagName === 'BR';
      if (!prevIsBr && !nextIsBr) br.replaceWith(' ');
    });
  }

  // Word/Outlook's clipboard HTML always carries one of these markers
  // (the mso- prefixed styles/classes, or the Office XML namespace
  // declared on the document). Gating normalizeWordPasteArtifacts on
  // this means its "a lone <br> is really just a Word line-wrap"
  // heuristic only ever touches genuine Word paste — not, say, a
  // template copied out of Draft (which legitimately uses one <br>
  // per line), which was previously having every one of those line
  // breaks collapsed into a single space by this same pass.
  const WORD_HTML_SIGNATURE = /mso-|urn:schemas-microsoft-com:office|\bMsoNormal\b/i;

  // A page body's pagination logic (repaginate, above) moves whole
  // top-level *elements* between pages, so it needs every top-level
  // child to be a block (a <p>, <ul>, ...). Pasted content that isn't
  // wrapped in a block at all — e.g. Draft's templates, which are
  // just text + <br> + <a>/<b>/<i>/<u> with no wrapping <p> — would
  // otherwise land as loose text/inline nodes directly under the page
  // body. Besides being invalid for a contenteditable's block model,
  // that breaks pagination outright: `body.lastElementChild` would
  // pick out a bare <br> instead of a paragraph, so push/pull moves
  // individual line breaks between pages instead of whole paragraphs,
  // stranding their text — which is what "everything clumps together"
  // turned out to actually be. Wrapping any run of loose top-level
  // inline content in its own <p> keeps it inside the block model
  // pagination expects, with its <br>s intact as ordinary line breaks
  // inside that one paragraph.
  const BLOCK_TAGS = new Set(['P', 'DIV', 'UL', 'OL', 'LI', 'TABLE', 'TR', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE']);

  function wrapLooseInlineContent(root) {
    const kids = Array.from(root.childNodes);
    let i = 0;
    while (i < kids.length) {
      const node = kids[i];
      const isBlock = node.nodeType === 1 && BLOCK_TAGS.has(node.tagName);
      if (isBlock) { i++; continue; }

      const run = [node];
      let j = i + 1;
      while (j < kids.length) {
        const n = kids[j];
        const nb = n.nodeType === 1 && BLOCK_TAGS.has(n.tagName);
        if (nb) break;
        run.push(n);
        j++;
      }

      const hasContent = run.some((n) => n.nodeType === 1 || (n.nodeValue || '').trim() !== '');
      if (hasContent) {
        const p = document.createElement('p');
        root.insertBefore(p, run[0]);
        run.forEach((n) => p.appendChild(n));
      } else {
        run.forEach((n) => n.remove());
      }
      i = j;
    }
  }

  function sanitizeHTML(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (WORD_HTML_SIGNATURE.test(html)) normalizeWordPasteArtifacts(doc.body);
    cleanNode(doc.body);
    wrapLooseInlineContent(doc.body);
    return doc.body.innerHTML;
  }

  function cleanNode(node) {
    Array.from(node.childNodes).forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) return;
      if (child.nodeType !== Node.ELEMENT_NODE) { node.removeChild(child); return; }

      if (STRIP_ENTIRELY.has(child.tagName)) {
        node.removeChild(child);
        return;
      }

      if (!ALLOWED_TAGS.has(child.tagName)) {
        cleanNode(child);
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        node.removeChild(child);
        return;
      }

      Array.from(child.attributes).forEach((attr) => {
        if (attr.name === 'href' && child.tagName === 'A') return;
        if (attr.name === 'style') return;
        child.removeAttribute(attr.name);
      });

      const styleText = child.getAttribute('style');
      if (styleText) {
        const kept = [];
        styleText.split(';').forEach((rule) => {
          const parts = rule.split(':');
          const prop = parts[0] && parts[0].trim().toLowerCase();
          const val = parts[1] && parts[1].trim();
          if (prop && val && ALLOWED_STYLES.has(prop)) kept.push(prop + ':' + val);
        });
        if (kept.length) child.setAttribute('style', kept.join(';'));
        else child.removeAttribute('style');
      }

      if (child.tagName === 'A') {
        const href = child.getAttribute('href') || '';
        if (!SAFE_URL.test(href.trim())) {
          child.removeAttribute('href');
        } else {
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noopener noreferrer');
          child.setAttribute('title', href);
        }
      }

      cleanNode(child);
    });
  }

  // Same tag/URL rules as sanitizeHTML, but drops every visual style
  // (bold, italic, colour, font-size, highlight...) rather than keeping
  // it — so pasted text falls through to the page's own default look.
  // Block structure (paragraphs/line breaks/lists) and links survive,
  // since those are content/navigation, not formatting; links keep only
  // their href, so they render with this page's own link style
  // (including the underline) instead of the source's.
  function stripToPageFormatting(node) {
    Array.from(node.childNodes).forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) return;
      if (child.nodeType !== Node.ELEMENT_NODE) { node.removeChild(child); return; }

      if (STRIP_ENTIRELY.has(child.tagName)) {
        node.removeChild(child);
        return;
      }

      if (child.tagName === 'A') {
        const href = (child.getAttribute('href') || '').trim();
        stripToPageFormatting(child);
        Array.from(child.attributes).forEach((attr) => child.removeAttribute(attr.name));
        if (!SAFE_URL.test(href)) {
          // No usable destination — keep the text, drop the tag.
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          node.removeChild(child);
        } else {
          child.setAttribute('href', href);
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noopener noreferrer');
          child.setAttribute('title', href);
        }
        return;
      }

      if (!ALLOWED_TAGS.has(child.tagName)) {
        stripToPageFormatting(child);
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        node.removeChild(child);
        return;
      }

      // Structural tag we keep (P/DIV/UL/OL/LI/BR) — strip every
      // attribute, including style, so none of the source's formatting
      // (font, colour, size, weight...) rides along.
      Array.from(child.attributes).forEach((attr) => child.removeAttribute(attr.name));
      stripToPageFormatting(child);
    });
  }

  function matchPageFormatting(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (WORD_HTML_SIGNATURE.test(html)) normalizeWordPasteArtifacts(doc.body);
    stripToPageFormatting(doc.body);
    wrapLooseInlineContent(doc.body);
    return doc.body.innerHTML;
  }

  function handlePaste(e) {
    e.preventDefault();
    const clipboardData = e.clipboardData || window.clipboardData;
    const html = clipboardData.getData('text/html');
    const matchStyle = pasteMatchStyleArmed;
    pasteMatchStyleArmed = false;

    recordHistoryStep(() => {
      if (html) {
        document.execCommand('insertHTML', false, matchStyle ? matchPageFormatting(html) : sanitizeHTML(html));
      } else {
        const text = clipboardData.getData('text/plain');
        document.execCommand('insertText', false, text);
      }
    });
    schedulePagination();
  }

  // ============================================================
  // Copy — rewrite lists into Word-native markup (2.6)
  //
  // The browser copies contenteditable content by serialising the
  // live DOM as-is, so a plain <ul><li> goes to the clipboard with no
  // Word list metadata attached. Word still opens it, but since it
  // doesn't recognise it as "a real list" it falls back to inserting
  // a literal bullet character followed by a full default tab stop
  // before the text — the "dot, big gap, then text/link" look.
  // Giving Word its own mso-list / @list level definitions makes it
  // treat the paste as a genuine bulleted/numbered list, the same as
  // if the bullet button had been clicked inside Word itself.
  // ============================================================

  const WORD_BULLET_CHARS = ['\uf0b7', 'o', '\uf0a7'];       // Symbol, Courier New, Wingdings
  const WORD_BULLET_FONTS = ['Symbol', 'Courier New', 'Wingdings'];

  let wordListSeq = 0;

  function wordListLevelDef(listNum, level, ordered) {
    const indent = ((level + 1) * 0.25).toFixed(2) + 'in';
    if (ordered) {
      return '@list l' + listNum + ':level' + (level + 1) + '\n' +
        '  {mso-level-number-format:decimal;\n' +
        '  mso-level-text:%' + (level + 1) + '\\.;\n' +
        '  mso-level-tab-stop:none;\n' +
        '  mso-level-number-position:left;\n' +
        '  margin-left:' + indent + ';\n' +
        '  text-indent:-.25in;}';
    }
    const idx = level % WORD_BULLET_CHARS.length;
    return '@list l' + listNum + ':level' + (level + 1) + '\n' +
      '  {mso-level-number-format:bullet;\n' +
      '  mso-level-text:' + WORD_BULLET_CHARS[idx] + ';\n' +
      '  mso-level-tab-stop:none;\n' +
      '  mso-level-number-position:left;\n' +
      '  margin-left:' + indent + ';\n' +
      '  text-indent:-.25in;\n' +
      '  font-family:' + WORD_BULLET_FONTS[idx] + ';}';
  }

  // Flattens one <ul>/<ol> (recursing into nested lists) into a
  // sequence of <p> elements carrying mso-list metadata, in the order
  // Word itself stores list items (nested items become their own
  // paragraphs at a deeper level, not actual nested elements).
  function convertListToParagraphs(list, level, ctx) {
    const ordered = list.tagName === 'OL';
    const listNum = ++ctx.listId;
    ctx.defs.push(
      '@list l' + listNum + '\n' +
      '  {mso-list-id:' + (100000 + listNum) + ';\n' +
      '  mso-list-template-ids:' + (100000 + listNum) + ';}'
    );
    ctx.defs.push(wordListLevelDef(listNum, level, ordered));

    const out = [];
    let n = 0;
    Array.from(list.children).forEach((li) => {
      if (li.tagName !== 'LI') return;
      n++;

      const p = document.createElement('p');
      p.setAttribute('style',
        'margin:0 0 4pt;margin-left:' + ((level + 1) * 0.25).toFixed(2) + 'in;' +
        'text-indent:-.25in;mso-list:l' + listNum + ' level' + (level + 1) + ' lfo' + listNum + ';'
      );

      const marker = document.createElement('span');
      marker.setAttribute('style', 'mso-list:Ignore');
      if (ordered) {
        marker.appendChild(document.createTextNode(n + '.'));
      } else {
        const glyph = document.createElement('span');
        glyph.setAttribute('style', "font-family:'" + WORD_BULLET_FONTS[level % WORD_BULLET_FONTS.length] + "'");
        glyph.appendChild(document.createTextNode(WORD_BULLET_CHARS[level % WORD_BULLET_CHARS.length]));
        marker.appendChild(glyph);
      }
      const spacer = document.createElement('span');
      spacer.setAttribute('style', "font:7.0pt 'Times New Roman'");
      spacer.innerHTML = '&nbsp;&nbsp;&nbsp;&nbsp;';
      marker.appendChild(spacer);
      p.appendChild(marker);

      Array.from(li.childNodes).forEach((child) => {
        if (child.nodeType === 1 && (child.tagName === 'UL' || child.tagName === 'OL')) return;
        p.appendChild(child.cloneNode(true));
      });
      out.push(p);

      Array.from(li.children).forEach((child) => {
        if (child.tagName === 'UL' || child.tagName === 'OL') {
          out.push.apply(out, convertListToParagraphs(child, level + 1, ctx));
        }
      });
    });

    return out;
  }

  // Rewrites every top-level list inside `wrapper` in place, returns
  // the collected @list style definitions to embed in the clipboard.
  function buildWordListStyles(wrapper) {
    const ctx = { listId: wordListSeq, defs: [] };
    Array.from(wrapper.querySelectorAll('ul, ol')).forEach((list) => {
      if (list.closest('li')) return; // nested — handled by the recursion above
      const paragraphs = convertListToParagraphs(list, 0, ctx);
      const frag = document.createDocumentFragment();
      paragraphs.forEach((p) => frag.appendChild(p));
      list.parentNode.replaceChild(frag, list);
    });
    wordListSeq = ctx.listId;
    return ctx.defs;
  }

  // Reads the paragraph spacing straight from the live page CSS, so if
  // that value changes later this stays in sync automatically instead of
  // silently drifting from a hardcoded copy of the number.
  function currentParagraphMarginCss() {
    // Prefer a paragraph that ISN'T `:last-child` — that variant has its
    // margin-bottom zeroed by our own stylesheet, and picking it by
    // accident (e.g. when the doc/page only has one paragraph) would
    // apply a 0 bottom-margin to every copied paragraph instead of the
    // real gap.
    const sample = pagesContainer.querySelector('.mountain-page__body p:not(:last-child)') ||
      pagesContainer.querySelector('.mountain-page__body p');
    if (!sample) return '0 0 2px 0';
    const cs = getComputedStyle(sample);
    return [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft].join(' ');
  }

  // Builds the text/plain clipboard payload from a fragment that may
  // contain <p>, <br>, and (post buildWordListStyles) list paragraphs.
  // `wrapper.textContent` alone concatenates every text node with no
  // separator at all — paragraph and line boundaries simply vanish,
  // so a multi-paragraph copy pastes as one run-on wall of text
  // anywhere that only reads text/plain (plain-text editors, some
  // chat/mail composers, or Word's own "Keep Text Only" paste). This
  // walks a throwaway clone and turns each block boundary back into a
  // real newline before reading the text out.
  // Word's HTML is pretty-printed, so the raw text nodes inside a <p>
  // or <li> often carry stray newlines/tabs/indentation from the
  // source markup itself (e.g. a line break right after the marker
  // <span>). A browser collapses that as insignificant whitespace
  // when it renders the page, which is part of why it looks fine in
  // Mountain — but textContent doesn't collapse anything, so left
  // alone it leaks straight into the plain-text output as extra
  // blank lines. Flatten it to single spaces before we add any of our
  // own, deliberate newlines.
  function collapseInsignificantWhitespace(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      node.nodeValue = node.nodeValue.replace(/[ \t\n\r\u00a0]+/g, ' ');
    }
  }

  function wrapperToPlainText(wrapper) {
    const clone = wrapper.cloneNode(true);
    collapseInsignificantWhitespace(clone);
    Array.from(clone.querySelectorAll('li')).forEach((li) => {
      const ordered = li.parentElement && li.parentElement.tagName === 'OL';
      let marker = '\u2022 ';
      if (ordered) {
        const siblings = Array.from(li.parentElement.children).filter((c) => c.tagName === 'LI');
        marker = (siblings.indexOf(li) + 1) + '. ';
      }
      li.insertBefore(document.createTextNode(marker), li.firstChild);
    });
    Array.from(clone.querySelectorAll('br')).forEach((br) => {
      br.replaceWith('\n');
    });
    const blockSelector = 'p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote';
    Array.from(clone.querySelectorAll(blockSelector)).forEach((el) => {
      el.insertAdjacentText('afterend', '\n');
    });
    return (clone.textContent || '')
      .replace(/ {2,}/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+|\n+$/g, '')
      .trim();
  }

  function handleCopyOrCut(e) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!inMountain(range.commonAncestorContainer)) return;

    const frag = range.cloneContents();
    const wrapper = document.createElement('div');
    wrapper.appendChild(frag);

    const hasList = !!wrapper.querySelector('ul, ol');
    const listDefs = hasList ? buildWordListStyles(wrapper) : [];

    // Our tight paragraph spacing only exists because of this app's own
    // stylesheet, which doesn't travel with a copy — pasted elsewhere,
    // <p> falls back to the destination's own (usually much larger)
    // default margin, which reads as a doubled gap between every line.
    // Inlining the real margin here keeps the same spacing everywhere.
    const paragraphMargin = currentParagraphMarginCss();
    wrapper.querySelectorAll('p').forEach((p) => {
      if (p.getAttribute('style')) return;
      // A plain CSS `margin` isn't enough on its own: Word doesn't fully
      // trust it and falls back to its own "Normal" style's default space
      // after each paragraph (commonly ~8-10pt) on top of it — which is
      // what reads as the gap being doubled once pasted. The
      // mso-margin-*-alt pair tells Word's paragraph engine to defer to
      // our explicit margin instead of adding its own.
      p.setAttribute('style',
        'margin:' + paragraphMargin + ';' +
        'mso-margin-top-alt:auto;mso-margin-bottom-alt:auto;');
    });

    const html =
      '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
      'xmlns:w="urn:schemas-microsoft-com:office:word" ' +
      'xmlns="http://www.w3.org/TR/REC-html40">' +
      '<head><style>\n' + listDefs.join('\n') + '\n</style></head>' +
      '<body><!--StartFragment-->' + wrapper.innerHTML + '<!--EndFragment--></body></html>';

    e.clipboardData.setData('text/html', html);
    e.clipboardData.setData('text/plain', wrapperToPlainText(wrapper));
    e.preventDefault();

    if (e.type === 'cut') {
      recordHistoryStep(() => {
        if (selectionSpansMultiplePages(range)) {
          collapseSelectionAcrossPages(sel, range);
        } else {
          document.execCommand('delete', false, null);
        }
      });
      schedulePagination();
    }
  }

  // ============================================================
  // Page size (2.1)
  // ============================================================

  pageSizeSelect.addEventListener('change', () => {
    root.dataset.pageSize = pageSizeSelect.value;
    schedulePagination();
  });

  // ============================================================
  // Init
  // ============================================================

  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (err) { /* ignore */ }

  ensurePage(0);
  renumberPages();
  updateEmptyState(pages[0].body);

  // Helper surface for other sections (data lifecycle & export/import in
  // Section 4, reverse/deep-thinking search in Section 7) to read and
  // write document content without needing to know about the
  // pagination internals.
  window.Summit = window.Summit || { state: { mountain: {}, peaks: {}, draft: {} } };
  window.Summit.mountain = {
    getHTML: () => pages.map((p) => p.body.innerHTML).join(''),
    sanitizeHTML: (html) => sanitizeHTML(html),
    getPlainText: () => pages.map((p) => p.body.textContent).join('\n\n'),

    // One HTML string per page, in order — used by batch export (4.3+)
    // to split the document into page-range chunks.
    getPagesHTML: () => pages.map((p) => p.body.innerHTML),
    getPageCount: () => pages.length,

    // True when the document has no typed content and no links/images/
    // list items — used to skip export/auto-download on an unused tab.
    isEmpty: () => pages.length <= 1 && pages[0].body.classList.contains('is-empty'),

    // Replaces the entire document with the given HTML (Section 4.4
    // import — file upload or paste). Collapses back to one page and
    // lets the normal pagination engine reflow the new content across
    // as many pages as it needs.
    loadHTML: (html) => {
      recordHistoryStep(() => {
        while (pages.length > 1) {
          const last = pages.pop();
          pagesContainer.removeChild(last.el);
        }
        const first = pages[0] || ensurePage(0);

        const wrapper = document.createElement('div');
        wrapper.innerHTML = html || '';

        // The pagination engine moves whole top-level children between
        // pages, so bare inline/text content (no wrapping block element)
        // wouldn't have anything to move — wrap it in a single paragraph.
        const hasBlockChild = Array.from(wrapper.children).some((el) =>
          ['P', 'DIV', 'UL', 'OL', 'TABLE', 'H1', 'H2', 'H3', 'BLOCKQUOTE'].includes(el.tagName));
        if (!hasBlockChild) {
          const p = document.createElement('p');
          p.innerHTML = wrapper.innerHTML || '<br>';
          wrapper.innerHTML = '';
          wrapper.appendChild(p);
        }

        first.body.innerHTML = wrapper.innerHTML;
        if (!first.body.firstElementChild) {
          const p = document.createElement('p');
          p.appendChild(document.createElement('br'));
          first.body.appendChild(p);
        }
        updateEmptyState(first.body);
        repaginate();
      });
    }
  };
})();

/* ---------------------------------------------------------
   Summit — mountain.js (Section 2.6: Hikes tab)

   A lighter, non-paginated alternative to the Document view above,
   for text that just needs to copy out cleanly with its formatting.
   Uses the same flat contenteditable model as Draft's template
   editor (text + <br> + <a>/<b>/<i>/<u>) rather than Mountain's own
   paged Word engine — the rich-text kernel just below is ported
   from draft.js's template editor so the feel matches exactly.

   Hikes: multiple named documents, switchable in the sidebar.
   Pathways: a per-Hike mode that splits its text into separate
   paragraph blocks — add/reorder/delete them, or pull one in
   whole from any existing template via search — and copies out
   with a line break inserted between each paragraph.

   Kept as its own IIFE/state, independent of the pagination engine
   above; Hikes are session-only, same as the Document view.
--------------------------------------------------------- */
(function () {
  'use strict';

  const mtSubtabs = Array.from(document.querySelectorAll('#mountain-shell > .draft-subnav > .draft-subtab'));
  const mtSubpanels = {
    document: document.getElementById('mountain-subpanel-document'),
    hikes: document.getElementById('mountain-subpanel-hikes')
  };
  function activateMountainSubtab(name) {
    if (!mtSubpanels[name]) return;
    mtSubtabs.forEach((tab) => { if (tab.dataset.subtab) tab.setAttribute('aria-selected', String(tab.dataset.subtab === name)); });
    Object.keys(mtSubpanels).forEach((key) => { mtSubpanels[key].hidden = key !== name; });
    if (name === 'hikes') { renderHikesList(); renderActiveHike(); }
  }
  mtSubtabs.forEach((tab) => tab.addEventListener('click', () => activateMountainSubtab(tab.dataset.subtab)));

  // ============================================================
  // Rich-text kernel — ported from Draft's template editor
  // (draft.js) so Hikes/Pathways feel and behave identically.
  // ============================================================

  const NO_FORMAT = { bold: false, italic: false, underline: false };

  function escapeHtmlLocal(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Parses a segment list back out of stored HTML — same shape Draft
  // uses: [{ type: 'text', value, bold, italic, underline } | { type:
  // 'link', text, url, bold, italic, underline }], with '\n' text
  // segments standing in for line breaks.
  //
  // Handles more than this app's own hike.html ever produces (which
  // is always flat <b>/<i>/<u>/<a>/<br> in a bare <div>) because this
  // is also the conversion path for HTML that came from elsewhere —
  // an imported Draft template paragraph, or pasted/extracted outside
  // content. Those can legitimately contain <ul>/<ol><li> (turned
  // into literal "• "/"N. " prefixed lines, matching the bullet/
  // number convention toggleTextareaLinePrefix already uses),
  // <p>/<div> block boundaries (turned into line breaks), and
  // bold/italic/underline expressed as inline styles rather than
  // tags (how Word, Google Docs, and most rich-text sources actually
  // encode it) as well as <strong>/<em>.
  function htmlToSegments(html) {
    if (!html) return [];
    const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
    const root = doc.body.firstChild;
    const segments = [];

    const lastIsBareBreak = () => {
      const last = segments[segments.length - 1];
      return !!last && last.type === 'text' && last.value === '\n';
    };
    const breakLine = () => { if (segments.length && !lastIsBareBreak()) segments.push(Object.assign({ type: 'text', value: '\n' }, NO_FORMAT)); };

    function styleFmt(el, fmt) {
      let bold = fmt.bold, italic = fmt.italic, underline = fmt.underline;
      const style = el.getAttribute && el.getAttribute('style');
      if (style) {
        const fw = /font-weight\s*:\s*([^;]+)/i.exec(style);
        if (fw) {
          const v = fw[1].trim().toLowerCase();
          if (v === 'bold' || v === 'bolder' || (/^\d+$/.test(v) && parseInt(v, 10) >= 600)) bold = true;
        }
        if (/font-style\s*:\s*italic/i.test(style)) italic = true;
        if (/text-decoration[^:]*:[^;]*underline/i.test(style)) underline = true;
      }
      return { bold, italic, underline };
    }

    function walkList(listEl) {
      let n = 0;
      Array.from(listEl.children).forEach((li) => {
        if (li.tagName !== 'LI') return;
        n += 1;
        breakLine();
        segments.push({ type: 'text', value: listEl.tagName === 'UL' ? BULLET_PREFIX : (n + '. '), bold: false, italic: false, underline: false });
        walk(li, NO_FORMAT);
      });
    }

    function walk(node, fmt) {
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === 3) {
          if (child.textContent) segments.push(Object.assign({ type: 'text', value: child.textContent }, fmt));
          return;
        }
        if (child.nodeType !== 1) return;
        const tag = child.tagName;
        if (tag === 'BR') { segments.push(Object.assign({ type: 'text', value: '\n' }, NO_FORMAT)); return; }
        if (tag === 'A') {
          const f = styleFmt(child, fmt);
          segments.push(Object.assign({ type: 'link', text: child.textContent, url: child.getAttribute('href') || '' }, f));
          return;
        }
        if (tag === 'UL' || tag === 'OL') { breakLine(); walkList(child); return; }
        if (tag === 'P' || tag === 'DIV') { breakLine(); walk(child, styleFmt(child, fmt)); breakLine(); return; }
        const nextFmt = styleFmt(child, {
          bold: fmt.bold || tag === 'B' || tag === 'STRONG',
          italic: fmt.italic || tag === 'I' || tag === 'EM',
          underline: fmt.underline || tag === 'U'
        });
        walk(child, nextFmt);
      });
    }

    walk(root, NO_FORMAT);
    // Drop a leading/trailing bare line break left by a block boundary
    // at the very start/end (e.g. content wrapped in a single <p>).
    if (segments.length && lastIsBareBreak()) segments.pop();
    while (segments.length && segments[0].type === 'text' && segments[0].value === '\n') segments.shift();
    return segments;
  }

  function segmentsToInlineHtml(segments) {
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

  // Splits a segment list into paragraphs on blank-line boundaries
  // (two or more consecutive line breaks) — mirrors the identical
  // helper in draft.js so a template's own paragraph split (used by
  // window.Summit.draft.listAllTemplateParagraphs()) lines up with
  // how a Hike splits itself in Pathways mode.
  function splitIntoParagraphSegments(segments) {
    const paragraphs = [[]];
    let breakRun = 0;
    segments.forEach((seg) => {
      if (seg.type === 'text' && seg.value === '\n') {
        breakRun += 1;
        if (breakRun >= 2) { paragraphs.push([]); breakRun = 0; return; }
        paragraphs[paragraphs.length - 1].push(seg);
        return;
      }
      breakRun = 0;
      paragraphs[paragraphs.length - 1].push(seg);
    });
    return paragraphs
      .map((p) => {
        while (p.length && p[0].type === 'text' && p[0].value === '\n') p.shift();
        while (p.length && p[p.length - 1].type === 'text' && p[p.length - 1].value === '\n') p.pop();
        return p;
      })
      // Drop genuinely-empty paragraphs — except the last one, which is
      // kept even when blank. Otherwise a just-added "Add Paragraph"
      // block (pushed as an empty '' segment) gets parsed right back
      // out again the moment renderPathwaysMode() re-splits hike.html,
      // so the new empty box a user expects to type into never appears.
      .filter((p, i, arr) => i === arr.length - 1 || p.some((s) => s.type === 'link' || (s.value && s.value.trim())));
  }

  // Clipboard-only rendering: one <div> per line so a bulleted list
  // opens in Word as one bullet per line instead of one bullet
  // holding everything (Word's list-autoformat only fires per
  // paragraph) — same trick as templateToClipboardHtml in draft.js.
  function htmlStringToClipboardHtml(html) {
    const segments = htmlToSegments(html);
    const lines = [[]];
    segments.forEach((seg) => {
      if (seg.type === 'text' && seg.value === '\n') { lines.push([]); return; }
      lines[lines.length - 1].push(seg);
    });
    return lines.map((lineSegs) => lineSegs.length
      ? '<div>' + segmentsToInlineHtml(lineSegs) + '</div>'
      : '<div><br></div>').join('');
  }

  // ============================================================
  // Plain-text editing kernel — marker-based textarea editing,
  // ported from Draft's "Expand to edit" modal (draft.js) so the
  // Hikes editor is a genuine plain <textarea>: fully native,
  // predictable arrow-key/Backspace/Enter/selection behaviour, no
  // contenteditable Range/caret involved at all. Formatting shows
  // as literal ⟦B⟧/⟦/B⟧, ⟦I⟧/⟦/I⟧, ⟦U⟧/⟦/U⟧, ⟦L:url⟧/⟦/L⟧ bracket
  // markers (U+27E6/27E7 — nothing anyone would type in normal
  // text, so round-tripping through them is unambiguous). hike.html
  // stays the on-disk/copy-out model exactly as before; these
  // functions just convert it to/from that marker text for display.
  // ============================================================

  // Segment list (from htmlToSegments) -> marker plain text.
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
  // dropping content.
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

  // Marker plain text -> the same text + <br> + <a>/<b>/<i>/<u> HTML
  // hike.html has always stored, ready to save straight to state.
  function markupTextToHtml(text) {
    const nodes = parseMarkupText(text);
    const container = document.createElement('div');
    appendMarkupNodes(container, nodes);
    return container.innerHTML;
  }

  // Marker plain text -> plain reading text (markers/URLs stripped,
  // link labels kept) — the plain-text half of "Copy out".
  function plainTextFromMarkupText(text) {
    function walk(nodes) {
      return nodes.map((node) => (node.type === 'text' ? node.value : walk(node.children))).join('');
    }
    return walk(parseMarkupText(text));
  }

  // ---------- Bullet / numbered lines (identical to draft.js) ----------
  const BULLET_PREFIX = '\u2022 ';
  const NUMBER_PREFIX_RE = /^\d+\.\s/;
  const BULLET_PREFIX_RE = /^\u2022 /;

  // ============================================================
  // Rich paste into the marker-text kernel (2.6a)
  //
  // hikesEditorBox and each Pathways paragraph box are genuine
  // <textarea> elements (see note above), so a native paste only
  // ever gives them flat text — the browser throws away any HTML on
  // the clipboard before it reaches a textarea. That's why
  // bold/italic/underline/links/bullets copied from an outside page,
  // doc, or email used to disappear entirely on paste here.
  //
  // This reads the clipboard's HTML ourselves and converts it into
  // this editor's marker text via the same sanitizeHTML()/
  // htmlToSegments() pipeline used everywhere else in this file.
  //
  // Reading clipboard data programmatically is exactly the kind of
  // thing a locked-down/enterprise "security" browser can block —
  // and unlike a native browser paste, a blocked or failing read
  // here has no built-in fallback, so it can take the whole paste
  // down with it. Everything below is written so that a blocked or
  // throwing clipboard read (or a paste with no text/html on it —
  // most plain-text copies) always falls through to the textarea's
  // own native paste instead of silently eating the keystroke.
  // preventDefault() only ever happens after we already have real
  // replacement text in hand.
  // ============================================================

  function pastedHtmlToMarkupText(html) {
    if (!window.Summit || !window.Summit.mountain || typeof window.Summit.mountain.sanitizeHTML !== 'function') {
      throw new Error('sanitizeHTML unavailable — Document view has not initialized');
    }
    const cleanHtml = window.Summit.mountain.sanitizeHTML(html);
    return segmentsToMarkupText(htmlToSegments(cleanHtml));
  }

  // Shared paste handler for hikesEditorBox and every Pathways
  // paragraph textarea.
  function handleHikesTextareaPaste(e) {
    try {
      const clipboardData = e.clipboardData || window.clipboardData;
      if (!clipboardData) return;
      const html = clipboardData.getData('text/html');
      if (!html) return;
      const markupText = pastedHtmlToMarkupText(html);
      if (!markupText) return;
      const textarea = e.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      e.preventDefault();
      textarea.setRangeText(markupText, start, end, 'end');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (err) {
      // Clipboard access blocked or malformed HTML on the clipboard —
      // do nothing and let the browser's own native paste (plain
      // text) go through instead.
    }
  }

  // Pulls the Document view's current content (already live in the
  // page — no clipboard involved at all) into a Hikes textarea, for
  // when a "security" browser's clipboard restrictions make paste
  // unreliable in Hikes/Pathways. Users can still get formatted text
  // in by typing/pasting it into the Document tab (which works,
  // since a contenteditable's native paste doesn't need JS to read
  // the clipboard the way a <textarea> does) and then extracting it
  // here.
  function extractFromDocumentInto(textarea) {
    try {
      if (!window.Summit || !window.Summit.mountain || typeof window.Summit.mountain.getHTML !== 'function') {
        showHikesToast('Document view isn\u2019t available right now');
        return;
      }
      const html = window.Summit.mountain.getHTML();
      if (!html || !html.trim()) {
        showHikesToast('Document is empty — nothing to extract');
        return;
      }
      const markupText = pastedHtmlToMarkupText(html);
      const start = textarea.selectionStart || 0;
      const end = textarea.selectionEnd || 0;
      textarea.setRangeText(markupText, start, end, 'end');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.focus();
      showHikesToast('Extracted from Document');
    } catch (err) {
      // Surface the failure instead of doing nothing silently — check
      // the browser console (F12) for the full error if this shows up.
      console.error('Extract from Document failed:', err);
      showHikesToast('Extract failed — see browser console (F12) for details');
    }
  }

  // Wraps (or, with nothing selected, inserts a placeholder inside)
  // the current textarea selection in marker tags — plain
  // setRangeText-based string editing (same API Draft's expand
  // modal uses), so it's immune to any contenteditable Range/caret
  // quirks and arrow keys/Backspace/selection stay 100% native.
  // Collapses a paragraph's raw marker text down to a single flowing
  // line: every line break is removed, runs of whitespace collapse to
  // one space, and any sentence-ending punctuation (. ! ?) that's
  // butted directly up against the next sentence with no space at all
  // gets exactly one space inserted. Formatting markers (⟦B⟧ etc.) are
  // left untouched since they're just literal characters in this
  // marker-text model — same as every other textarea-editing helper
  // in this file.
  //
  // The "insert a space after sentence punctuation" step only fires
  // when punctuation is immediately followed by an uppercase letter,
  // an opening quote/paren, or a formatting marker — not by a digit or
  // lowercase letter — so it doesn't mangle decimals ("3.14") or
  // abbreviations ("e.g. next" already has its space; "U.S." rarely
  // gets touched). It's a heuristic, not perfect sentence detection.
  function rearrangeParagraphText(text) {
    return text
      .replace(/[\r\n]+/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/([.!?])(?=[A-Z\u201c"'(\u27e6])/g, '$1 ')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  function rearrangeParagraphBox(textarea) {
    const next = rearrangeParagraphText(textarea.value);
    if (next === textarea.value) { showHikesToast('Already tidy'); return; }
    textarea.value = next;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    showHikesToast('Paragraph rearranged');
  }

  function wrapSelectionInTextarea(textarea, openTag, closeTag, placeholder) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    const selected = value.slice(start, end) || placeholder;
    const replacement = openTag + selected + closeTag;
    textarea.setRangeText(replacement, start, end, 'select');
    textarea.focus();
    // Select just the inner text (not the markers) so typing over a
    // placeholder or existing selection replaces the right thing.
    textarea.setSelectionRange(start + openTag.length, start + openTag.length + selected.length);
  }

  // Same literal "\u2022 "/"N. " prefix as Draft's expand modal —
  // plain string splicing on the textarea's own line, since there's
  // no DOM selection to manage in a <textarea>.
  function toggleTextareaLinePrefix(textarea, kind) {
    const value = textarea.value;
    const caret = textarea.selectionStart;
    const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
    let lineEnd = value.indexOf('\n', caret);
    if (lineEnd === -1) lineEnd = value.length;
    const line = value.slice(lineStart, lineEnd);

    const hasBullet = BULLET_PREFIX_RE.test(line);
    const numberMatch = NUMBER_PREFIX_RE.exec(line);
    const rest = hasBullet ? line.slice(BULLET_PREFIX.length) : (numberMatch ? line.slice(numberMatch[0].length) : line);

    const togglingOffSameKind = (kind === 'bullet' && hasBullet) || (kind === 'number' && !!numberMatch);
    let newLine;
    if (togglingOffSameKind) {
      newLine = rest;
    } else if (kind === 'bullet') {
      newLine = BULLET_PREFIX + rest;
    } else {
      const prevLineEnd = lineStart > 0 ? lineStart - 1 : -1;
      const prevLineStart = prevLineEnd >= 0 ? value.lastIndexOf('\n', prevLineEnd - 1) + 1 : 0;
      const prevLine = prevLineEnd >= 0 ? value.slice(prevLineStart, prevLineEnd) : '';
      const prevMatch = NUMBER_PREFIX_RE.exec(prevLine);
      const n = prevMatch ? parseInt(prevMatch[0], 10) + 1 : 1;
      newLine = n + '. ' + rest;
    }

    textarea.setRangeText(newLine, lineStart, lineEnd, 'preserve');
    textarea.focus();
  }

  // Prompts for a URL/label and inserts a ⟦L:url⟧label⟦/L⟧ marker
  // at the current selection — the textarea equivalent of the old
  // contenteditable insertLinkInto.
  function insertLinkInTextarea(textarea) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.slice(start, end);
    const url = window.prompt('Link URL:');
    if (!url || !url.trim()) return false;
    const trimmedUrl = url.trim();
    const label = window.prompt('Link text (leave blank to show the URL itself):', selected || '');
    const trimmedLabel = (label || '').trim() || trimmedUrl;
    const replacement = '\u27e6L:' + trimmedUrl + '\u27e7' + trimmedLabel + '\u27e6/L\u27e7';
    textarea.setRangeText(replacement, start, end, 'end');
    textarea.focus();
    return true;
  }

  // ============================================================
  // Hikes state + sidebar
  // ============================================================

  window.Summit = window.Summit || { state: { mountain: {}, peaks: {}, draft: {} } };
  window.Summit.state.mountain.hikes = window.Summit.state.mountain.hikes || [];
  window.Summit.state.mountain.activeHikeId = window.Summit.state.mountain.activeHikeId || null;
  const S = window.Summit.state.mountain;

  let mode = 'editor'; // 'editor' | 'pathways' — applies to whichever Hike is active

  function uidH(prefix) { return prefix + '-' + Math.random().toString(36).slice(2, 10); }

  const hikesListEl = document.getElementById('hikes-list');
  const hikesListEmptyEl = document.getElementById('hikes-list-empty');
  const hikesNewBtn = document.getElementById('hikes-new-btn');
  const hikesEmptyEl = document.getElementById('hikes-empty');
  const hikesContentEl = document.getElementById('hikes-content');
  const hikesNameInput = document.getElementById('hikes-name-input');
  const hikesCopyBtn = document.getElementById('hikes-copy-btn');
  const hikesDeleteBtn = document.getElementById('hikes-delete-btn');

  const hikesModeEditorBtn = document.getElementById('hikes-mode-editor-btn');
  const hikesModePathwaysBtn = document.getElementById('hikes-mode-pathways-btn');
  const hikesEditorViewEl = document.getElementById('hikes-editor-view');
  const hikesPathwaysViewEl = document.getElementById('hikes-pathways-view');

  const hikesEditorBox = document.getElementById('hikes-editor-box');
  const hikesBoldBtn = document.getElementById('hikes-bold-btn');
  const hikesItalicBtn = document.getElementById('hikes-italic-btn');
  const hikesUnderlineBtn = document.getElementById('hikes-underline-btn');
  const hikesBulletBtn = document.getElementById('hikes-bullet-btn');
  const hikesNumberBtn = document.getElementById('hikes-number-btn');
  const hikesLinkBtn = document.getElementById('hikes-link-btn');
  const hikesExtractBtn = document.getElementById('hikes-extract-btn');

  const hikesPathwaysListEl = document.getElementById('hikes-pathways-list');
  const hikesAddParagraphBtn = document.getElementById('hikes-add-paragraph-btn');
  const hikesImportParagraphBtn = document.getElementById('hikes-import-paragraph-btn');

  const toastEl = document.getElementById('summit-toast');
  let toastTimer = null;
  function showHikesToast(message) {
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

  function getActiveHike() {
    return S.hikes.find((h) => h.id === S.activeHikeId) || null;
  }

  function renderHikesList() {
    hikesListEl.innerHTML = '';
    hikesListEmptyEl.hidden = S.hikes.length > 0;
    S.hikes.forEach((hike) => {
      const li = document.createElement('li');
      li.className = 'hikes-list-item' + (hike.id === S.activeHikeId ? ' is-active' : '');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hikes-list-item__btn';
      btn.textContent = hike.name || 'Untitled Hike';
      btn.title = hike.name || 'Untitled Hike';
      btn.addEventListener('click', () => selectHike(hike.id));
      li.appendChild(btn);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'hikes-list-item__delete';
      del.title = 'Delete this Hike';
      del.setAttribute('aria-label', 'Delete "' + (hike.name || 'Untitled Hike') + '"');
      del.textContent = '\u00d7';
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteHike(hike.id); });
      li.appendChild(del);

      hikesListEl.appendChild(li);
    });
  }

  function selectHike(id) {
    S.activeHikeId = id;
    mode = 'editor';
    renderHikesList();
    renderActiveHike();
  }

  function createHike() {
    const hike = { id: uidH('hike'), name: 'Hike ' + (S.hikes.length + 1), html: '' };
    S.hikes.push(hike);
    selectHike(hike.id);
    requestAnimationFrame(() => hikesNameInput.focus());
  }

  function deleteHike(id) {
    const hike = S.hikes.find((h) => h.id === id);
    if (!hike) return;
    if (!window.confirm('Delete "' + (hike.name || 'Untitled Hike') + '"? This can\'t be undone.')) return;
    S.hikes = S.hikes.filter((h) => h.id !== id);
    if (S.activeHikeId === id) S.activeHikeId = S.hikes.length ? S.hikes[0].id : null;
    renderHikesList();
    renderActiveHike();
  }

  function renderActiveHike() {
    const hike = getActiveHike();
    hikesEmptyEl.hidden = !!hike;
    hikesContentEl.hidden = !hike;
    if (!hike) return;
    hikesNameInput.value = hike.name || '';
    setMode(mode);
  }

  hikesNewBtn.addEventListener('click', createHike);
  hikesDeleteBtn.addEventListener('click', () => { if (S.activeHikeId) deleteHike(S.activeHikeId); });
  hikesNameInput.addEventListener('input', () => {
    const hike = getActiveHike();
    if (!hike) return;
    hike.name = hikesNameInput.value;
    renderHikesList();
  });

  // ============================================================
  // Editor mode — a single plain <textarea> showing bracket markers,
  // exactly Draft's "Expand to edit" template editor. No
  // contenteditable involved: arrow keys, Backspace, Home/End,
  // selection, etc. are entirely native <textarea> behaviour.
  // ============================================================

  function setMode(next) {
    mode = next;
    hikesModeEditorBtn.setAttribute('aria-selected', String(mode === 'editor'));
    hikesModePathwaysBtn.setAttribute('aria-selected', String(mode === 'pathways'));
    hikesEditorViewEl.hidden = mode !== 'editor';
    hikesPathwaysViewEl.hidden = mode !== 'pathways';
    if (mode === 'editor') renderEditorMode(); else renderPathwaysMode();
  }
  hikesModeEditorBtn.addEventListener('click', () => setMode('editor'));
  hikesModePathwaysBtn.addEventListener('click', () => setMode('pathways'));

  function renderEditorMode() {
    const hike = getActiveHike();
    if (!hike) return;
    hikesEditorBox.value = segmentsToMarkupText(htmlToSegments(hike.html || ''));
  }

  function commitEditorMode() {
    const hike = getActiveHike();
    if (!hike) return;
    hike.html = markupTextToHtml(hikesEditorBox.value);
    hike.pathwaysDirty = true;
  }

  hikesEditorBox.addEventListener('input', commitEditorMode);
  hikesEditorBox.addEventListener('paste', handleHikesTextareaPaste);
  hikesBoldBtn.addEventListener('click', () => wrapSelectionInTextarea(hikesEditorBox, '\u27e6B\u27e7', '\u27e6/B\u27e7', 'bold text'));
  hikesItalicBtn.addEventListener('click', () => wrapSelectionInTextarea(hikesEditorBox, '\u27e6I\u27e7', '\u27e6/I\u27e7', 'italic text'));
  hikesUnderlineBtn.addEventListener('click', () => wrapSelectionInTextarea(hikesEditorBox, '\u27e6U\u27e7', '\u27e6/U\u27e7', 'underlined text'));
  hikesBulletBtn.addEventListener('click', () => toggleTextareaLinePrefix(hikesEditorBox, 'bullet'));
  hikesNumberBtn.addEventListener('click', () => toggleTextareaLinePrefix(hikesEditorBox, 'number'));
  hikesLinkBtn.addEventListener('click', () => insertLinkInTextarea(hikesEditorBox));
  if (hikesExtractBtn) hikesExtractBtn.addEventListener('click', () => extractFromDocumentInto(hikesEditorBox));
  else console.error('Hikes: #hikes-extract-btn not found in the page — the Extract button won\u2019t work until index.html has it.');

  // ============================================================
  // Pathways mode — the same Hike's text as separate, reorderable,
  // collapsible paragraph blocks (an accordion with vertical scroll).
  // hike.pathwaysBlocks is the source of truth *while in Pathways
  // mode*: each block is a stable { id, html, expanded } object, so
  // add/delete/duplicate/move/import/collapse operate on that array
  // directly and never re-derive it from joined HTML (that round trip
  // is what silently ate empty paragraphs before). hike.html is kept
  // in sync from the blocks on every edit, so Editor mode and
  // "Copy text" always see the current content. Editor mode stays the
  // single source of truth *while in Editor mode*: editing there
  // marks the Hike dirty so the next time Pathways is opened it
  // re-splits fresh from hike.html on blank-line boundaries, exactly
  // like before.
  // ============================================================

  function readParagraphBoxes() {
    return Array.from(hikesPathwaysListEl.querySelectorAll('.hikes-paragraph__box'));
  }

  function joinBlocksToHtml(blocks) {
    return blocks.map((b) => b.html).join('<br><br>');
  }

  // Splits a Hike's stored HTML into paragraph blocks. A brand-new/
  // empty Hike starts with 5 blank paragraphs to fill in, rather than
  // a single empty one.
  function deriveBlocksFromHtml(html) {
    const segments = htmlToSegments(html || '');
    const paragraphs = splitIntoParagraphSegments(segments);
    let htmls = paragraphs.map((paraSegs) => segmentsToInlineHtml(paraSegs));
    if (!htmls.length) htmls = [''];
    if (htmls.length === 1 && !htmls[0].trim()) htmls = ['', '', '', '', ''];
    return htmls.map((h) => ({ id: uidH('para'), html: h, expanded: true }));
  }

  function ensurePathwaysBlocks(hike) {
    if (!hike.pathwaysBlocks || hike.pathwaysDirty) {
      hike.pathwaysBlocks = deriveBlocksFromHtml(hike.html || '');
      hike.pathwaysDirty = false;
    }
    return hike.pathwaysBlocks;
  }

  function commitPathwaysToHike() {
    const hike = getActiveHike();
    if (!hike || !hike.pathwaysBlocks) return;
    const boxes = readParagraphBoxes();
    hike.pathwaysBlocks.forEach((block, idx) => {
      const box = boxes[idx];
      if (box) block.html = markupTextToHtml(box.value);
    });
    hike.html = joinBlocksToHtml(hike.pathwaysBlocks);
  }

  function renderPathwaysMode() {
    const hike = getActiveHike();
    if (!hike) return;
    renderPathwaysList(ensurePathwaysBlocks(hike));
  }

  function renderPathwaysList(blocks) {
    hikesPathwaysListEl.innerHTML = '';
    blocks.forEach((block, idx) => {
      hikesPathwaysListEl.appendChild(renderParagraphBlock(block, idx, blocks.length));
    });
  }

  function toggleParagraphExpanded(id) {
    const hike = getActiveHike();
    if (!hike || !hike.pathwaysBlocks) return;
    commitPathwaysToHike();
    const block = hike.pathwaysBlocks.find((b) => b.id === id);
    if (!block) return;
    block.expanded = !block.expanded;
    renderPathwaysList(hike.pathwaysBlocks);
  }

  function renderParagraphBlock(block, index, total) {
    const card = document.createElement('div');
    card.className = 'hikes-paragraph' + (block.expanded ? ' is-expanded' : ' is-collapsed');

    // ---- Accordion header: click to expand/collapse; actions on the right ----
    const header = document.createElement('div');
    header.className = 'hikes-paragraph__header';

    const summary = document.createElement('button');
    summary.type = 'button';
    summary.className = 'hikes-paragraph__summary';
    summary.setAttribute('aria-expanded', String(!!block.expanded));
    summary.addEventListener('click', () => toggleParagraphExpanded(block.id));

    const chevron = document.createElement('span');
    chevron.className = 'hikes-paragraph__chevron';
    chevron.textContent = block.expanded ? '\u25be' : '\u25b8';
    summary.appendChild(chevron);

    const title = document.createElement('span');
    title.className = 'hikes-paragraph__title';
    title.textContent = 'Paragraph ' + (index + 1);
    summary.appendChild(title);

    const preview = document.createElement('span');
    preview.className = 'hikes-paragraph__preview';
    const previewText = plainTextFromMarkupText(segmentsToMarkupText(htmlToSegments(block.html))).replace(/\s+/g, ' ').trim();
    preview.textContent = previewText ? previewText.slice(0, 80) : 'Empty';
    summary.appendChild(preview);

    header.appendChild(summary);

    const actions = document.createElement('div');
    actions.className = 'hikes-paragraph__actions';

    const mkAction = (label, titleText, onClick, extraClass) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hikes-paragraph__action-btn' + (extraClass ? ' ' + extraClass : '');
      b.innerHTML = label;
      b.title = titleText;
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      return b;
    };

    const upBtn = mkAction('\u2191', 'Move up', () => moveParagraph(block.id, -1));
    if (index === 0) upBtn.disabled = true;
    actions.appendChild(upBtn);

    const downBtn = mkAction('\u2193', 'Move down', () => moveParagraph(block.id, 1));
    if (index === total - 1) downBtn.disabled = true;
    actions.appendChild(downBtn);

    actions.appendChild(mkAction('\u2295 Template', 'Fill this paragraph from a template', () => openImportModal(block.id), 'hikes-paragraph__template-btn'));

    actions.appendChild(mkAction('Duplicate', 'Duplicate this paragraph', () => duplicateParagraph(block.id)));

    const delBtn = mkAction('\u2715', 'Delete this paragraph', () => deleteParagraph(block.id), 'hikes-paragraph__delete-btn');
    if (total <= 1) delBtn.disabled = true;
    actions.appendChild(delBtn);

    header.appendChild(actions);
    card.appendChild(header);

    // ---- Body: the same formatting toolbar + textarea as the Hikes editor ----
    const body = document.createElement('div');
    body.className = 'hikes-paragraph__body';
    body.hidden = !block.expanded;

    const toolbar = document.createElement('div');
    toolbar.className = 'hikes-paragraph__toolbar';

    const box = document.createElement('textarea');
    box.className = 'draft-textarea draft-template-expand__input hikes-paragraph__box';
    box.setAttribute('aria-label', 'Paragraph ' + (index + 1) + ' of ' + total);
    box.setAttribute('placeholder', 'Write this paragraph…');
    box.value = segmentsToMarkupText(htmlToSegments(block.html));
    box.addEventListener('input', () => { commitPathwaysToHike(); preview.textContent = (plainTextFromMarkupText(box.value).replace(/\s+/g, ' ').trim().slice(0, 80)) || 'Empty'; });
    box.addEventListener('paste', handleHikesTextareaPaste);

    const mk = (label, titleText, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'summit-btn';
      b.innerHTML = label;
      b.title = titleText;
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus/selection in box
      b.addEventListener('click', onClick);
      return b;
    };

    toolbar.appendChild(mk('<b>B</b>', 'Wrap selection in bold markers', () => wrapSelectionInTextarea(box, '\u27e6B\u27e7', '\u27e6/B\u27e7', 'bold text')));
    toolbar.appendChild(mk('<i>I</i>', 'Wrap selection in italic markers', () => wrapSelectionInTextarea(box, '\u27e6I\u27e7', '\u27e6/I\u27e7', 'italic text')));
    toolbar.appendChild(mk('<u>U</u>', 'Wrap selection in underline markers', () => wrapSelectionInTextarea(box, '\u27e6U\u27e7', '\u27e6/U\u27e7', 'underlined text')));
    toolbar.appendChild(mk('&bull;', 'Toggle bullet on this line', () => toggleTextareaLinePrefix(box, 'bullet')));
    toolbar.appendChild(mk('1.', 'Toggle numbering on this line', () => toggleTextareaLinePrefix(box, 'number')));
    toolbar.appendChild(mk('Link', 'Insert a link at the cursor', () => insertLinkInTextarea(box)));
    toolbar.appendChild(mk('Rearrange', 'Remove line breaks and normalize spacing between sentences', () => rearrangeParagraphBox(box)));
    toolbar.appendChild(mk('Preview', 'See this paragraph with formatting rendered', () => openParagraphPreview(box, index)));
    toolbar.appendChild(mk('Extract from Document', 'Pull the Document tab\u2019s current content in here, converted to bold/italic/underline/links/bullets', () => extractFromDocumentInto(box)));

    body.appendChild(toolbar);
    body.appendChild(box);
    card.appendChild(body);

    return card;
  }

  function addParagraph() {
    const hike = getActiveHike();
    if (!hike) return;
    commitPathwaysToHike();
    const blocks = ensurePathwaysBlocks(hike);
    blocks.push({ id: uidH('para'), html: '', expanded: true });
    hike.html = joinBlocksToHtml(blocks);
    renderPathwaysList(blocks);
    requestAnimationFrame(() => {
      const boxes = readParagraphBoxes();
      const last = boxes[boxes.length - 1];
      if (last) last.focus();
    });
  }

  function duplicateParagraph(id) {
    const hike = getActiveHike();
    if (!hike || !hike.pathwaysBlocks) return;
    commitPathwaysToHike();
    const blocks = hike.pathwaysBlocks;
    const idx = blocks.findIndex((b) => b.id === id);
    if (idx === -1) return;
    blocks.splice(idx + 1, 0, { id: uidH('para'), html: blocks[idx].html, expanded: true });
    hike.html = joinBlocksToHtml(blocks);
    renderPathwaysList(blocks);
  }

  function fillParagraphFromTemplate(id, html) {
    const hike = getActiveHike();
    if (!hike || !hike.pathwaysBlocks) return;
    commitPathwaysToHike();
    const block = hike.pathwaysBlocks.find((b) => b.id === id);
    if (!block) return;
    block.html = html;
    block.expanded = true;
    hike.html = joinBlocksToHtml(hike.pathwaysBlocks);
    renderPathwaysList(hike.pathwaysBlocks);
  }

  function deleteParagraph(id) {
    const hike = getActiveHike();
    if (!hike || !hike.pathwaysBlocks) return;
    commitPathwaysToHike();
    if (hike.pathwaysBlocks.length <= 1) return;
    hike.pathwaysBlocks = hike.pathwaysBlocks.filter((b) => b.id !== id);
    hike.html = joinBlocksToHtml(hike.pathwaysBlocks);
    renderPathwaysList(hike.pathwaysBlocks);
  }

  function moveParagraph(id, delta) {
    const hike = getActiveHike();
    if (!hike || !hike.pathwaysBlocks) return;
    commitPathwaysToHike();
    const blocks = hike.pathwaysBlocks;
    const idx = blocks.findIndex((b) => b.id === id);
    const target = idx + delta;
    if (idx === -1 || target < 0 || target >= blocks.length) return;
    const [item] = blocks.splice(idx, 1);
    blocks.splice(target, 0, item);
    hike.html = joinBlocksToHtml(blocks);
    renderPathwaysList(blocks);
  }

  function insertImportedParagraph(html) {
    const hike = getActiveHike();
    if (!hike) return;
    commitPathwaysToHike();
    const blocks = ensurePathwaysBlocks(hike);
    blocks.push({ id: uidH('para'), html: html, expanded: true });
    hike.html = joinBlocksToHtml(blocks);
    renderPathwaysList(blocks);
  }

  hikesAddParagraphBtn.addEventListener('click', addParagraph);

  // ============================================================
  // Copy out
  // ============================================================

  async function writeRichClipboard(html, plain) {
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      try {
        const item = new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' })
        });
        await navigator.clipboard.write([item]);
        return true;
      } catch (err) { /* fall through to plain-text copy below */ }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(plain);
    return false;
  }

  async function copyHikeText() {
    const hike = getActiveHike();
    if (!hike) return;
    let html, plain;
    if (mode === 'pathways') {
      commitPathwaysToHike();
      const boxes = readParagraphBoxes();
      plain = boxes.map((box) => plainTextFromMarkupText(box.value)).join('\n');
      html = boxes.map((box) => htmlStringToClipboardHtml(markupTextToHtml(box.value))).join('<div><br></div>');
    } else {
      commitEditorMode();
      plain = plainTextFromMarkupText(hikesEditorBox.value);
      html = htmlStringToClipboardHtml(hike.html || '');
    }
    await writeRichClipboard(html, plain);
    showHikesToast('Copied to clipboard');
  }
  hikesCopyBtn.addEventListener('click', copyHikeText);

  // ============================================================
  // Import a paragraph from a template (Pathways mode)
  // ============================================================

  const importModal = document.getElementById('hikes-import-modal');
  const importTitleEl = document.getElementById('hikes-import-title');
  const importQueryInput = document.getElementById('hikes-import-query');
  const importSubFilterSel = document.getElementById('hikes-import-subfilter');
  const importResultsEl = document.getElementById('hikes-import-results');

  const previewModal = document.getElementById('hikes-preview-modal');
  const previewTitleEl = document.getElementById('hikes-preview-title');
  const previewBodyEl = document.getElementById('hikes-preview-body');
  const importCountEl = document.getElementById('hikes-import-count');

  let importTargetBlockId = null; // set when opened from a paragraph's own "⊕ Template" button

  function populateImportSubFilter() {
    const current = importSubFilterSel.value;
    importSubFilterSel.innerHTML = '<option value="">All Sub-Enquiries</option>';
    if (!window.Summit.draft || typeof window.Summit.draft.listSubEnquiries !== 'function') return;
    window.Summit.draft.listSubEnquiries().forEach((sub) => {
      const opt = document.createElement('option');
      opt.value = sub.id;
      opt.textContent = sub.path;
      importSubFilterSel.appendChild(opt);
    });
    importSubFilterSel.value = current || '';
  }

  function renderImportResult(p) {
    const card = document.createElement('div');
    card.className = 'hikes-import__result';

    const path = document.createElement('p');
    path.className = 'hikes-import__result-path';
    path.textContent = p.path + (p.tplName ? ' \u2014 ' + p.tplName : '') +
      (p.paraCount > 1 ? ' (paragraph ' + (p.paraIndex + 1) + ' of ' + p.paraCount + ')' : '');
    card.appendChild(path);

    const snippet = document.createElement('p');
    snippet.className = 'hikes-import__result-snippet';
    snippet.innerHTML = p.html;
    card.appendChild(snippet);

    const insertBtn = document.createElement('button');
    insertBtn.type = 'button';
    insertBtn.className = 'summit-btn summit-btn--primary';
    insertBtn.textContent = importTargetBlockId ? 'Use for this paragraph' : 'Insert as new paragraph';
    insertBtn.addEventListener('click', () => {
      if (importTargetBlockId) {
        fillParagraphFromTemplate(importTargetBlockId, p.html);
        showHikesToast('Paragraph filled from template');
        closeImportModal();
      } else {
        insertImportedParagraph(p.html);
        showHikesToast('Paragraph inserted');
      }
    });
    card.appendChild(insertBtn);

    return card;
  }

  function renderImportResults() {
    importResultsEl.innerHTML = '';
    if (!window.Summit.draft || typeof window.Summit.draft.listAllTemplateParagraphs !== 'function') {
      importCountEl.textContent = 'Template search isn\'t available right now.';
      return;
    }
    const all = window.Summit.draft.listAllTemplateParagraphs();
    const q = (importQueryInput.value || '').trim().toLowerCase();
    const subId = importSubFilterSel.value;
    const filtered = all.filter((p) => {
      if (subId && p.subId !== subId) return false;
      if (q && !p.text.toLowerCase().includes(q)) return false;
      return true;
    });
    const shown = filtered.slice(0, 60);
    importCountEl.textContent = filtered.length
      ? ('Showing ' + shown.length + ' of ' + filtered.length + ' matching paragraph' + (filtered.length === 1 ? '' : 's'))
      : (all.length ? 'No paragraphs match your search.' : 'No templates found yet in Draft.');
    shown.forEach((p) => importResultsEl.appendChild(renderImportResult(p)));
  }

  // targetId: pass a paragraph's block id to fill that specific
  // paragraph (from its own "⊕ Template" button); omit/pass nothing
  // to fall back to the footer's "Import from template…", which adds
  // the picked paragraph as a new block at the end instead.
  function openImportModal(targetId) {
    if (!importModal) return;
    importTargetBlockId = targetId || null;
    if (importTitleEl) {
      const hike = getActiveHike();
      const idx = importTargetBlockId && hike && hike.pathwaysBlocks
        ? hike.pathwaysBlocks.findIndex((b) => b.id === importTargetBlockId)
        : -1;
      importTitleEl.textContent = idx > -1
        ? 'Fill Paragraph ' + (idx + 1) + ' from a template'
        : 'Import a paragraph from a template';
    }
    populateImportSubFilter();
    importQueryInput.value = '';
    importModal.hidden = false;
    importModal.setAttribute('aria-hidden', 'false');
    renderImportResults();
    requestAnimationFrame(() => importQueryInput.focus());
  }
  function closeImportModal() {
    if (!importModal) return;
    importModal.hidden = true;
    importModal.setAttribute('aria-hidden', 'true');
    importTargetBlockId = null;
  }
  if (importModal) {
    importModal.querySelectorAll('[data-hikes-import-close]').forEach((el) => el.addEventListener('click', closeImportModal));
  }
  importQueryInput.addEventListener('input', renderImportResults);
  importSubFilterSel.addEventListener('change', renderImportResults);
  hikesImportParagraphBtn.addEventListener('click', () => openImportModal(null));

  // ============================================================
  // Paragraph preview (Pathways)
  //
  // The Pathways textarea shows raw marker text (⟦B⟧/⟦I⟧/⟦U⟧/⟦L:url⟧
  // brackets) so editing is fully native, but that means the user
  // never actually sees the formatted result inline. This renders
  // that one paragraph's current, uncommitted textarea content
  // through the same markupTextToHtml() pipeline used for copy-out,
  // so bold/italic/underline/links show exactly as they'll appear
  // when copied — without needing to commit or leave Pathways.
  // ============================================================

  function openParagraphPreview(box, index) {
    if (!previewModal) return;
    if (previewTitleEl) previewTitleEl.textContent = 'Preview — Paragraph ' + (index + 1);
    previewBodyEl.innerHTML = markupTextToHtml(box.value || '');
    previewModal.hidden = false;
    previewModal.setAttribute('aria-hidden', 'false');
  }
  function closeParagraphPreview() {
    if (!previewModal) return;
    previewModal.hidden = true;
    previewModal.setAttribute('aria-hidden', 'true');
  }
  if (previewModal) {
    previewModal.querySelectorAll('[data-hikes-preview-close]').forEach((el) => el.addEventListener('click', closeParagraphPreview));
  }

  // ---------- Initial paint ----------
  renderHikesList();
  renderActiveHike();
})();
