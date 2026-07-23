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

  // Ctrl+Shift+V / Cmd+Shift+V — "paste and match [page] formatting".
  // The browser still fires a normal `paste` event for this shortcut, so
  // we just flag it here and read the flag once, in handlePaste.
  function isPasteMatchStyleShortcut(e) {
    const mod = e.metaKey || e.ctrlKey;
    return mod && e.shiftKey && e.key.toLowerCase() === 'v';
  }

  function attachPageListeners(body) {
    body.addEventListener('input', () => {
      updateEmptyState(body);
      schedulePagination();
    });
    body.addEventListener('paste', handlePaste);
    body.addEventListener('copy', handleCopyOrCut);
    body.addEventListener('cut', handleCopyOrCut);
    // The browser's native undo/redo isn't aware that repagination moves
    // paragraphs between page bodies with plain DOM calls, not
    // execCommand. Letting undo run against that can desync the
    // browser's internal edit state from the DOM — the editor then
    // stops responding to clicks until some other edit (e.g. a spelling
    // fix) forces a repagination pass that happens to resync things.
    // Blocking the shortcut here avoids that broken state entirely.
    body.addEventListener('keydown', (e) => {
      if (isUndoRedoShortcut(e)) e.preventDefault();
      if (isPasteMatchStyleShortcut(e)) pasteMatchStyleArmed = true;
    });
    body.addEventListener('focus', () => {
      activeBody = body;
    });
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
      }

      // 2. Pull content back from the next page while there's room (reflow on delete).
      for (let i = 0; i < pages.length - 1; i++) {
        const body = pages[i].body;
        const nextBody = pages[i + 1].body;
        while (nextBody.firstElementChild) {
          const node = nextBody.firstElementChild;
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
      document.execCommand(cmd, false, null);
      updateToolbarState();
      schedulePagination();
      return;
    }

    switch (action) {
      case 'font-size-increase': adjustFontSize(2); break;
      case 'font-size-decrease': adjustFontSize(-2); break;
      case 'uppercase': transformCase('upper'); break;
      case 'lowercase': transformCase('lower'); break;
      case 'indent': document.execCommand('indent', false, null); break;
      case 'outdent': document.execCommand('outdent', false, null); break;
      case 'link': openLinkPopover(); break;
      case 'unlink': removeLink(); break;
      case 'clear-format': clearFormatting(); break;
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
    let ok = false;
    try { ok = document.execCommand(cmd, false, value); } catch (err) { /* ignore */ }
    if (!ok && cmd === 'hiliteColor') {
      try { document.execCommand('backColor', false, value); } catch (err) { /* ignore */ }
    }

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

    wrapRangeInFontSize(savedFontSizeRange, size);
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

  function sanitizeHTML(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    cleanNode(doc.body);
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
    stripToPageFormatting(doc.body);
    return doc.body.innerHTML;
  }

  function handlePaste(e) {
    e.preventDefault();
    const clipboardData = e.clipboardData || window.clipboardData;
    const html = clipboardData.getData('text/html');
    const matchStyle = pasteMatchStyleArmed;
    pasteMatchStyleArmed = false;

    if (html) {
      document.execCommand('insertHTML', false, matchStyle ? matchPageFormatting(html) : sanitizeHTML(html));
    } else {
      const text = clipboardData.getData('text/plain');
      document.execCommand('insertText', false, text);
    }
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
        '  mso-level-text:%' + (level + 1) + '.;\n' +
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
    e.clipboardData.setData('text/plain', wrapper.textContent);
    e.preventDefault();

    if (e.type === 'cut') document.execCommand('delete', false, null);
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

  // Small helper surface for later sections (export in Section 4,
  // reverse/deep-thinking search in Section 7) to read document content
  // without needing to know about the pagination internals.
  window.Summit = window.Summit || { state: { mountain: {}, peaks: {}, draft: {} } };
  window.Summit.mountain = {
    getHTML: () => pages.map((p) => p.body.innerHTML).join(''),
    getPlainText: () => pages.map((p) => p.body.textContent).join('\n\n')
  };
})();
