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

  const PLACEHOLDER = 'Start typing your document…';
  const MAX_REPAGINATION_PASSES = 40;

  let pages = [];         // [{ el, body, numberEl }]
  let activeBody = null;  // last-focused page body
  let paginationScheduled = false;
  let savedColorRange = null;
  let savedLinkRange = null;
  let editingLinkEl = null;

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

  function attachPageListeners(body) {
    body.addEventListener('input', () => {
      updateEmptyState(body);
      schedulePagination();
    });
    body.addEventListener('paste', handlePaste);
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
    if (sel && sel.rangeCount && inMountain(sel.anchorNode)) updateToolbarState();
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

  function adjustFontSize(delta) {
    const range = currentRangeInMountain();
    if (!range || range.collapsed) return;

    const refEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const currentSize = parseFloat(getComputedStyle(refEl).fontSize) || 15;
    const newSize = Math.max(8, Math.min(96, Math.round(currentSize + delta)));

    const frag = range.extractContents();
    const span = document.createElement('span');
    span.style.fontSize = newSize + 'px';
    span.appendChild(frag);
    range.insertNode(span);

    const sel = window.getSelection();
    const newRange = document.createRange();
    newRange.selectNodeContents(span);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }

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

    try { document.execCommand('removeFormat', false, null); } catch (err) { /* ignore */ }

    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range2 = sel.getRangeAt(0);
    const container = range2.commonAncestorContainer.nodeType === 1
      ? range2.commonAncestorContainer
      : range2.commonAncestorContainer.parentElement;
    if (!container || !container.querySelectorAll) return;

    // removeFormat alone is inconsistent across browsers for highlight
    // colour and custom font-size spans, so unwrap anything left over.
    // Links are deliberately left alone — clearing character formatting
    // shouldn't also delete the hyperlink itself.
    const leftovers = container.querySelectorAll('span[style], font, mark, b, strong, i, em, u, s, strike');
    leftovers.forEach((el) => {
      if (!range2.intersectsNode(el)) return;
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    });
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
    } else {
      document.execCommand('createLink', false, url);
      const sel2 = window.getSelection();
      if (sel2.rangeCount) {
        const link = getAncestorLink(sel2.getRangeAt(0).startContainer);
        if (link) {
          link.setAttribute('target', '_blank');
          link.setAttribute('rel', 'noopener noreferrer');
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
        }
      }

      cleanNode(child);
    });
  }

  function handlePaste(e) {
    e.preventDefault();
    const clipboardData = e.clipboardData || window.clipboardData;
    const html = clipboardData.getData('text/html');

    if (html) {
      document.execCommand('insertHTML', false, sanitizeHTML(html));
    } else {
      const text = clipboardData.getData('text/plain');
      document.execCommand('insertText', false, text);
    }
    schedulePagination();
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
