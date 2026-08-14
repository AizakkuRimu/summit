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
