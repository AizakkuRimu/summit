/* ---------------------------------------------------------
   Summit — data.js
   Section 4: Naming, Data Handling, Import & Export
   (Mountain + Peaks) — shared across tabs, per Section 1.3.1's
   "js/ ... plus any shared helpers".

   - 4.2 Sensitive data lifecycle: session-only data, a best-effort
         auto-download right before the tab/browser closes, and a
         manual "Save & Exit" button as the reliable safety net.
   - 4.3 Manual export to native Word (.docx) / Excel (.xlsx) at
         any time.
   - 4.4 Import from .docx/.xlsx via file upload or copy-paste,
         with a preview step before committing.
   - Batch export: split a long Mountain document or Peaks sheet
         into several files (by page count / row count, in order)
         zipped together in one download.

   Reads/writes document content only through the small API each
   tab exposes on window.Summit (see the bottom of mountain.js and
   peaks.js) — this file never touches their internals directly.

   Needs, loaded before this file: JSZip, html-docx-js (window.htmlDocx),
   SheetJS (window.XLSX), mammoth (window.mammoth).
--------------------------------------------------------- */

(function () {
  'use strict';

  window.Summit = window.Summit || { state: { mountain: {}, peaks: {}, draft: {} } };

  // ============================================================
  // Small shared helpers
  // ============================================================

  function pad(n, len) { return String(n).padStart(len, '0'); }

  function timestamp() {
    const d = new Date();
    return d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) +
      '-' + pad(d.getHours(), 2) + pad(d.getMinutes(), 2);
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

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ============================================================
  // Mountain — build & export .docx
  //
  // html-docx-js wraps the given HTML in a minimal .docx package via
  // Word's "altChunk" feature: Word converts the embedded HTML to real
  // WordProcessingML the moment the file is opened. It's a tiny,
  // well-worn trick (not supported by LibreOffice/Google Docs — Word
  // only), which is why the exported file opens cleanly in Word but is
  // best treated as "Word native", not "any office suite".
  // ============================================================

  function mountainHtmlDocument(bodyHTML) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Summit — Mountain</title>' +
      '<style>' +
      'body{font-family:Calibri,"Segoe UI",Arial,sans-serif;font-size:11pt;color:#24211d;}' +
      'p{margin:0 0 8pt 0;} ul,ol{margin:0 0 8pt 24pt;} a{color:#7A4E23;}' +
      '</style></head><body>' + (bodyHTML || '<p></p>') + '</body></html>';
  }

  function docxBlobFromHTML(bodyHTML) {
    return window.htmlDocx.asBlob(mountainHtmlDocument(bodyHTML));
  }

  function exportMountainNow() {
    const M = window.Summit.mountain;
    if (!M) return;
    if (M.isEmpty()) { showToast('Mountain is empty — nothing to export.'); return; }
    downloadBlob(docxBlobFromHTML(M.getHTML()), 'mountain-' + timestamp() + '.docx');
  }

  // ============================================================
  // Peaks — build & export .xlsx
  //
  // Cell values export faithfully; per-cell fill colours/borders don't
  // carry into the .xlsx (SheetJS's open-source writer doesn't do
  // cell styling) — this exports Peaks' data, not its visual styling.
  // ============================================================

  function coerceValue(text) {
    if (text == null || text === '') return '';
    const trimmed = String(text).trim();
    if (trimmed !== '' && /^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return text;
  }

  function matrixToWorkbook(matrix, sheetName) {
    const values = matrix.map((row) => row.map(coerceValue));
    const ws = XLSX.utils.aoa_to_sheet(values);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, (sheetName || 'Peaks').slice(0, 31));
    return wb;
  }

  function xlsxArrayFromMatrix(matrix, sheetName) {
    return XLSX.write(matrixToWorkbook(matrix, sheetName), { bookType: 'xlsx', type: 'array' });
  }

  function exportPeaksNow() {
    const P = window.Summit.peaks;
    if (!P) return;
    const used = P.getUsedRange();
    if (used.rows === 0 || used.cols === 0) { showToast('Peaks is empty — nothing to export.'); return; }
    const matrix = P.getMatrix(0, used.rows - 1, 0, used.cols - 1);
    downloadBlob(new Blob([xlsxArrayFromMatrix(matrix, 'Peaks')], { type: 'application/octet-stream' }),
      'peaks-' + timestamp() + '.xlsx');
  }

  // ============================================================
  // Batch export — split into N-page / N-row chunks, in order,
  // zipped into a single download.
  // ============================================================

  async function batchExportMountain(pagesPerBatch) {
    const M = window.Summit.mountain;
    if (!M || M.isEmpty()) { showToast('Mountain is empty — nothing to export.'); return; }
    const pagesHTML = M.getPagesHTML();

    const batches = [];
    for (let i = 0; i < pagesHTML.length; i += pagesPerBatch) batches.push(pagesHTML.slice(i, i + pagesPerBatch));

    if (batches.length <= 1) { exportMountainNow(); return; }

    const zip = new JSZip();
    batches.forEach((batch, idx) => {
      const startPage = idx * pagesPerBatch + 1;
      const endPage = startPage + batch.length - 1;
      const name = 'mountain-pages-' + pad(startPage, 3) + '-' + pad(endPage, 3) + '.docx';
      zip.file(name, docxBlobFromHTML(batch.join('')));
    });
    downloadBlob(await zip.generateAsync({ type: 'blob' }), 'mountain-batches-' + timestamp() + '.zip');
  }

  async function batchExportPeaks(rowsPerBatch) {
    const P = window.Summit.peaks;
    if (!P) return;
    const used = P.getUsedRange();
    if (used.rows === 0 || used.cols === 0) { showToast('Peaks is empty — nothing to export.'); return; }

    const batches = [];
    for (let r = 0; r < used.rows; r += rowsPerBatch) {
      batches.push(P.getMatrix(r, Math.min(r + rowsPerBatch, used.rows) - 1, 0, used.cols - 1));
    }

    if (batches.length <= 1) { exportPeaksNow(); return; }

    const zip = new JSZip();
    batches.forEach((batch, idx) => {
      const startRow = idx * rowsPerBatch + 1;
      const endRow = startRow + batch.length - 1;
      const name = 'peaks-rows-' + pad(startRow, 4) + '-' + pad(endRow, 4) + '.xlsx';
      zip.file(name, xlsxArrayFromMatrix(batch, 'Rows ' + startRow + '-' + endRow));
    });
    downloadBlob(await zip.generateAsync({ type: 'blob' }), 'peaks-batches-' + timestamp() + '.zip');
  }

  // ============================================================
  // Toast — quiet confirmation for Save & Exit / batch export,
  // since those finish with no other visible change on screen.
  // ============================================================

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

  // ============================================================
  // 4.2 — Sensitive data lifecycle
  //
  // Session-only storage is already true by construction (Mountain
  // and Peaks keep their content in the DOM/JS memory — see app.js —
  // nothing is written to disk or a server). What's left is making
  // sure the user gets a copy before that memory disappears.
  // ============================================================

  function saveAll(prefix) {
    const M = window.Summit.mountain;
    const P = window.Summit.peaks;
    let savedAny = false;
    if (M && !M.isEmpty()) {
      downloadBlob(docxBlobFromHTML(M.getHTML()), prefix + '-mountain-' + timestamp() + '.docx');
      savedAny = true;
    }
    if (P && !P.isEmpty()) {
      const used = P.getUsedRange();
      const matrix = P.getMatrix(0, used.rows - 1, 0, used.cols - 1);
      downloadBlob(new Blob([xlsxArrayFromMatrix(matrix, 'Peaks')], { type: 'application/octet-stream' }),
        prefix + '-peaks-' + timestamp() + '.xlsx');
      savedAny = true;
    }
    return savedAny;
  }

  // Best-effort auto-download right before the tab/browser closes.
  // Note (mirrors the spec): 'beforeunload'/'pagehide' downloads are
  // NOT reliable across all browsers — many block or silently drop
  // work triggered during unload. This is a safety net on top of the
  // manual "Save & Exit" button below, not a substitute for it.
  function attemptAutoDownload() {
    try { saveAll('autosave'); } catch (err) { /* best effort only */ }
  }
  window.addEventListener('pagehide', attemptAutoDownload);
  window.addEventListener('beforeunload', attemptAutoDownload);

  // Manual safety net (Section 4.2 note): reliably downloads whatever
  // has content, right now, on click.
  const saveExitBtn = document.getElementById('save-exit-btn');
  if (saveExitBtn) {
    saveExitBtn.addEventListener('click', () => {
      const savedAny = saveAll('save');
      showToast(savedAny
        ? 'Downloaded your files — this tab is safe to close now.'
        : 'Nothing to save yet — this tab is safe to close.');
    });
  }

  // ============================================================
  // 4.4 — Import modal (file upload or paste, with preview)
  // Shared between Mountain and Peaks; `importTarget` tells it which.
  // ============================================================

  const modal = document.getElementById('summit-import-modal');
  if (modal) {
    const modalTitle = document.getElementById('summit-import-title');
    const modalTabs = Array.from(modal.querySelectorAll('[data-import-mode]'));
    const fileLabel = document.getElementById('summit-import-filelabel');
    const fileLabelText = document.getElementById('summit-import-filelabel-text');
    const fileInput = document.getElementById('summit-import-file');
    const warningEl = document.getElementById('summit-import-warning');
    const workspace = document.getElementById('summit-import-workspace');
    const commitBtn = document.getElementById('summit-import-commit');

    let importTarget = null; // 'mountain' | 'peaks'
    let importMode = 'file';
    let pendingMatrix = null; // populated after a successful Peaks file read

    function openImportModal(target) {
      importTarget = target;
      pendingMatrix = null;

      modalTitle.textContent = 'Import into ' + (target === 'mountain' ? 'Mountain' : 'Peaks');
      fileInput.value = '';
      fileInput.accept = target === 'mountain' ? '.docx,.txt' : '.xlsx,.xls,.csv';
      fileLabelText.textContent = 'Choose a file…';

      const hasContent = target === 'mountain'
        ? !window.Summit.mountain.isEmpty()
        : !window.Summit.peaks.isEmpty();
      warningEl.hidden = !hasContent;
      warningEl.textContent = 'Importing will replace the current ' +
        (target === 'mountain' ? 'Mountain document.' : 'Peaks sheet.');

      setMode('file');
      modal.hidden = false;
      modal.setAttribute('aria-hidden', 'false');
    }

    function closeImportModal() {
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
      workspace.innerHTML = '';
      fileInput.value = '';
      pendingMatrix = null;
    }

    function setMode(mode) {
      importMode = mode;
      modalTabs.forEach((btn) => {
        const active = btn.dataset.importMode === mode;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', String(active));
      });
      fileLabel.hidden = mode !== 'file';
      workspace.contentEditable = mode === 'paste' ? 'true' : 'false';
      workspace.innerHTML = '';
      workspace.dataset.placeholder = importTarget === 'mountain'
        ? 'Paste rich text here (Ctrl+V / Cmd+V)…'
        : 'Paste a table or tab-separated data here (Ctrl+V / Cmd+V)…';
      commitBtn.disabled = true;
    }

    modalTabs.forEach((btn) => btn.addEventListener('click', () => setMode(btn.dataset.importMode)));
    modal.querySelectorAll('[data-modal-close]').forEach((el) => el.addEventListener('click', closeImportModal));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) closeImportModal();
    });

    function matrixToPreviewTable(matrix) {
      return '<table class="summit-modal__table">' + matrix.map((row) =>
        '<tr>' + row.map((cell) => '<td>' + escapeHtml(cell) + '</td>').join('') + '</tr>'
      ).join('') + '</table>';
    }

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      fileLabelText.textContent = file.name;
      commitBtn.disabled = true;
      pendingMatrix = null;
      workspace.innerHTML = '<p class="summit-modal__status">Reading file…</p>';

      try {
        if (importTarget === 'mountain') {
          if (/\.docx$/i.test(file.name)) {
            const buf = await file.arrayBuffer();
            const result = await window.mammoth.convertToHtml({ arrayBuffer: buf });
            workspace.innerHTML = result.value || '<p><em>(empty document)</em></p>';
          } else {
            const text = await file.text();
            workspace.innerHTML = text.split(/\r?\n\r?\n/).map((para) =>
              '<p>' + escapeHtml(para).replace(/\r?\n/g, '<br>') + '</p>').join('') || '<p><em>(empty file)</em></p>';
          }
        } else {
          const buf = await file.arrayBuffer();
          const wb = XLSX.read(buf, { type: 'array' });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          pendingMatrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
          workspace.innerHTML = pendingMatrix.length
            ? matrixToPreviewTable(pendingMatrix)
            : '<p><em>(empty sheet)</em></p>';
        }
        commitBtn.disabled = false;
      } catch (err) {
        workspace.innerHTML = '<p class="summit-modal__status summit-modal__status--error">' +
          'Could not read that file: ' + escapeHtml(err && err.message ? err.message : err) + '</p>';
      }
    });

    function refreshPasteCommitState() {
      commitBtn.disabled = workspace.textContent.trim() === '';
    }
    workspace.addEventListener('input', () => { if (importMode === 'paste') refreshPasteCommitState(); });
    workspace.addEventListener('paste', () => {
      if (importMode === 'paste') setTimeout(refreshPasteCommitState, 0);
    });

    commitBtn.addEventListener('click', () => {
      if (importTarget === 'mountain') {
        window.Summit.mountain.loadHTML(workspace.innerHTML);
        showToast('Imported into Mountain.');
      } else {
        let matrix = null;
        if (importMode === 'file') {
          matrix = pendingMatrix;
        } else {
          const table = workspace.querySelector('table');
          if (table) {
            const wb = XLSX.utils.table_to_book(table);
            const sheet = wb.Sheets[wb.SheetNames[0]];
            matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
          } else {
            const text = workspace.innerText || '';
            matrix = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map((row) => row.split('\t'));
          }
        }
        if (matrix && matrix.length) {
          window.Summit.peaks.loadFromMatrix(matrix);
          showToast('Imported into Peaks.');
        }
      }
      closeImportModal();
    });

    // ---------- Wire up the toolbar buttons that open this modal ----------
    const mountainImportBtn = document.getElementById('mountain-import-btn');
    const peaksImportBtn = document.getElementById('peaks-import-btn');
    if (mountainImportBtn) mountainImportBtn.addEventListener('click', () => openImportModal('mountain'));
    if (peaksImportBtn) peaksImportBtn.addEventListener('click', () => openImportModal('peaks'));
  }

  // ============================================================
  // 4.3 — Manual export buttons
  // ============================================================

  const mountainExportBtn = document.getElementById('mountain-export-btn');
  if (mountainExportBtn) mountainExportBtn.addEventListener('click', exportMountainNow);

  const peaksExportBtn = document.getElementById('peaks-export-btn');
  if (peaksExportBtn) peaksExportBtn.addEventListener('click', exportPeaksNow);

  // ============================================================
  // Batch export controls
  // ============================================================

  function wireBatchControls(selectId, customId, btnId, runBatch, unitLabel) {
    const select = document.getElementById(selectId);
    const custom = document.getElementById(customId);
    const btn = document.getElementById(btnId);
    if (!select || !btn) return;

    select.addEventListener('change', () => {
      if (custom) custom.hidden = select.value !== 'custom';
    });

    btn.addEventListener('click', () => {
      const n = select.value === 'custom' ? parseInt(custom.value, 10) : parseInt(select.value, 10);
      if (!n || n < 1) { showToast('Enter a valid number of ' + unitLabel + ' per batch.'); return; }
      runBatch(n);
    });
  }

  wireBatchControls('mountain-batch-size', 'mountain-batch-custom', 'mountain-batch-btn', batchExportMountain, 'pages');
  wireBatchControls('peaks-batch-size', 'peaks-batch-custom', 'peaks-batch-btn', batchExportPeaks, 'rows');
})();
