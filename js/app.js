/* ---------------------------------------------------------
   Summit — app.js
   Section 1: app shell — tab switching, dark mode, shared state.
   Sections 2/3/5-8 will attach their own logic in
   mountain.js / peaks.js / draft.js, reading/writing
   window.Summit.state so switching tabs never loses work.
--------------------------------------------------------- */

(function () {
  'use strict';

  // Shared in-memory state, one entry per tab. Because panels are
  // hidden with the `hidden` attribute rather than removed from the
  // DOM, and any tab-specific data lives here rather than in local
  // variables inside a render call, switching tabs can never drop
  // unsaved work (Section 1: "each tab keeps its own in-memory state
  // for the duration of the session").
  window.Summit = window.Summit || {
    state: {
      mountain: {},
      peaks: {},
      draft: {}
    }
  };

  const tabs = Array.from(document.querySelectorAll('.summit-tab'));
  const panels = {
    mountain: document.getElementById('panel-mountain'),
    peaks: document.getElementById('panel-peaks'),
    draft: document.getElementById('panel-draft')
  };

  function activateTab(name) {
    tabs.forEach((tab) => {
      const isActive = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(isActive));
    });
    Object.keys(panels).forEach((key) => {
      panels[key].hidden = key !== name;
    });
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });

  // ---------- Theme toggle ----------
  // Theme is a UI preference, not document content, so it's fine to
  // persist it across sessions — this is separate from the
  // session-only document/spreadsheet data rule in Section 4.2.
  const THEME_KEY = 'summit:theme';
  const themeToggle = document.getElementById('theme-toggle');
  const root = document.documentElement;

  function applyTheme(theme) {
    if (theme === 'dark') {
      root.setAttribute('data-theme', 'dark');
    } else {
      root.removeAttribute('data-theme');
    }
    themeToggle.setAttribute('aria-pressed', String(theme === 'dark'));
  }

  function getStoredTheme() {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch (err) {
      return null;
    }
  }

  function storeTheme(theme) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (err) {
      // ignore — private browsing / storage disabled
    }
  }

  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initialTheme = getStoredTheme() || (prefersDark ? 'dark' : 'light');
  applyTheme(initialTheme);

  themeToggle.addEventListener('click', () => {
    const isDark = root.getAttribute('data-theme') === 'dark';
    const next = isDark ? 'light' : 'dark';
    applyTheme(next);
    storeTheme(next);
  });
})();
