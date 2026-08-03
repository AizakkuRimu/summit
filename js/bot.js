/* ---------------------------------------------------------
   Summit — bot.js
   Sherpa: a small bottom-right chat assistant. Session-only,
   same as the rest of the app — nothing here persists across
   a reload. Reads/writes the Draft hierarchy exclusively
   through window.Summit.draft's public API (Section 5), never
   touching its internal state directly.

   Commands so far:
     /help       — list what Sherpa can do
     /duplicate  — search-and-pick a Sub-Enquiry to copy

   Anything else gets a friendly-but-robotic non-answer, which
   is deliberate: Sherpa is upfront about only knowing two
   tricks right now.
--------------------------------------------------------- */

(function () {
  'use strict';

  const BOT_NAME = 'Sherpa';

  function timeOfDay() {
    const h = new Date().getHours();
    if (h < 12) return 'morning';
    if (h < 18) return 'afternoon';
    return 'evening';
  }

  // ============================================================
  // DOM scaffold — built at runtime, same pattern draft.js uses
  // for its own modals, so index.html doesn't need touching.
  // ============================================================

  const launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'summit-bot__launcher';
  launcher.setAttribute('aria-label', 'Open ' + BOT_NAME + ' chat');
  launcher.innerHTML =
    '<svg viewBox="0 0 32 32" aria-hidden="true">' +
      '<path d="M16 6 L27 25 H5 Z" fill="currentColor"></path>' +
      '<path d="M16 6 L21 15 H11 Z" fill="var(--bronze-deep)"></path>' +
    '</svg>' +
    '<span class="summit-bot__dot" aria-hidden="true"></span>';

  const panel = document.createElement('div');
  panel.className = 'summit-bot__panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', BOT_NAME + ' chat');
  panel.innerHTML =
    '<div class="summit-bot__header">' +
      '<svg class="summit-bot__header-mark" viewBox="0 0 32 32" aria-hidden="true">' +
        '<path d="M16 5 L28 26 H4 Z" class="summit-mark__outer"></path>' +
        '<path d="M16 5 L22 16 H10 Z" class="summit-mark__inner"></path>' +
      '</svg>' +
      '<div class="summit-bot__header-text">' +
        '<span class="summit-bot__header-name">' + BOT_NAME + '</span>' +
        '<span class="summit-bot__header-status">on the trail</span>' +
      '</div>' +
      '<button type="button" class="summit-bot__close" aria-label="Close chat">' +
        '<svg viewBox="0 0 20 20" aria-hidden="true"><line x1="4" y1="4" x2="16" y2="16"></line><line x1="16" y1="4" x2="4" y2="16"></line></svg>' +
      '</button>' +
    '</div>' +
    '<div class="summit-bot__messages" id="summit-bot-messages" aria-live="polite"></div>' +
    '<div class="summit-bot__inputrow">' +
      '<input type="text" class="summit-bot__input" id="summit-bot-input" placeholder="Message ' + BOT_NAME + '\u2026 try /help" autocomplete="off">' +
      '<button type="button" class="summit-bot__send" aria-label="Send">' +
        '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h14M11 4l6 6-6 6"></path></svg>' +
      '</button>' +
    '</div>';

  document.body.appendChild(launcher);
  document.body.appendChild(panel);

  const messagesEl = panel.querySelector('#summit-bot-messages');
  const inputEl = panel.querySelector('#summit-bot-input');
  const sendBtn = panel.querySelector('.summit-bot__send');
  const closeBtn = panel.querySelector('.summit-bot__close');

  let hasOpenedOnce = false;

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMessage(text, who) {
    const bubble = document.createElement('div');
    bubble.className = 'summit-bot__msg summit-bot__msg--' + who;
    bubble.textContent = text;
    messagesEl.appendChild(bubble);
    scrollToBottom();
    return bubble;
  }

  function greet() {
    addMessage(
      'Good ' + timeOfDay() + '. ' + BOT_NAME + ' here, basecamp assistant for this hierarchy. ' +
      'I\u2019m still learning the ropes \u2014 send /help to see what I\u2019ve got so far.',
      'bot'
    );
  }

  function openPanel() {
    panel.hidden = false;
    launcher.querySelector('.summit-bot__dot').style.display = 'none';
    if (!hasOpenedOnce) {
      hasOpenedOnce = true;
      greet();
    }
    inputEl.focus();
  }

  function closePanel() {
    panel.hidden = true;
  }

  launcher.addEventListener('click', () => {
    if (panel.hidden) openPanel(); else closePanel();
  });
  closeBtn.addEventListener('click', closePanel);

  // ============================================================
  // /duplicate — searchable Sub-Enquiry picker, rendered as its
  // own bot bubble so it scrolls and wraps with the rest of the
  // conversation instead of floating off in a separate popup.
  // ============================================================

  function renderDuplicatePicker() {
    const draftApi = window.Summit && window.Summit.draft;
    const all = draftApi && typeof draftApi.listSubEnquiries === 'function'
      ? draftApi.listSubEnquiries()
      : [];

    if (all.length === 0) {
      addMessage(
        'Scanned the hierarchy \u2014 no Sub-Enquiries out there yet. Add one in the Draft tab, then send /duplicate again.',
        'bot'
      );
      return;
    }

    const bubble = document.createElement('div');
    bubble.className = 'summit-bot__msg summit-bot__msg--bot summit-bot__msg--picker';

    const intro = document.createElement('p');
    intro.className = 'summit-bot__picker-intro';
    intro.textContent = 'Found ' + all.length + ' sub-enquir' + (all.length === 1 ? 'y' : 'ies') + '. Search or pick one to duplicate:';
    bubble.appendChild(intro);

    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'summit-bot__picker-search';
    search.placeholder = 'Search by name or path\u2026';
    search.setAttribute('aria-label', 'Search sub-enquiries to duplicate');
    bubble.appendChild(search);

    const list = document.createElement('ul');
    list.className = 'summit-bot__picker-list';
    bubble.appendChild(list);

    function renderList(items) {
      list.innerHTML = '';
      if (items.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'summit-bot__picker-empty';
        empty.textContent = 'Nothing matches that search.';
        list.appendChild(empty);
        return;
      }
      items.forEach((entry) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'summit-bot__picker-item';

        const nameEl = document.createElement('span');
        nameEl.className = 'summit-bot__picker-item-name';
        nameEl.textContent = entry.name;
        btn.appendChild(nameEl);

        if (entry.path) {
          const pathEl = document.createElement('span');
          pathEl.className = 'summit-bot__picker-item-path';
          pathEl.textContent = entry.path;
          btn.appendChild(pathEl);
        }

        btn.addEventListener('click', () => {
          search.disabled = true;
          Array.from(list.querySelectorAll('button')).forEach((b) => { b.disabled = true; });
          const newId = draftApi.duplicateSubEnquiry(entry.id);
          if (newId) {
            addMessage('Duplicate complete \u2014 "' + entry.name + '" is copied and open in the Draft tab.', 'bot');
          } else {
            addMessage('That one\u2019s gone missing \u2014 try /duplicate again to refresh the list.', 'bot');
          }
        });

        li.appendChild(btn);
        list.appendChild(li);
      });
    }

    renderList(all);

    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      if (!q) { renderList(all); return; }
      const filtered = all.filter((entry) =>
        entry.name.toLowerCase().includes(q) || (entry.path && entry.path.toLowerCase().includes(q))
      );
      renderList(filtered);
    });

    messagesEl.appendChild(bubble);
    scrollToBottom();
    search.focus();
  }

  const HELP_TEXT =
    'Here\u2019s what I can do so far:\n' +
    '\u2022 /duplicate \u2014 search for a Sub-Enquiry and make a copy of it\n' +
    '\u2022 /help \u2014 show this list\n' +
    'More commands are on the way as I learn the trail.';

  function handleCommand(raw) {
    const command = raw.trim().slice(1).split(/\s+/)[0].toLowerCase();
    if (command === 'help') {
      addMessage(HELP_TEXT, 'bot');
      return;
    }
    if (command === 'duplicate') {
      renderDuplicatePicker();
      return;
    }
    addMessage('Command not recognized: /' + command + '. Send /help to see what I\u2019ve got.', 'bot');
  }

  function handleFreeText() {
    addMessage(
      'Noted \u2014 I can\u2019t chat freely just yet, only /help and /duplicate for now. ' +
      'In the meantime: good ' + timeOfDay() + '!',
      'bot'
    );
  }

  function submitMessage() {
    const value = inputEl.value.trim();
    if (!value) return;
    addMessage(value, 'user');
    inputEl.value = '';
    if (value.startsWith('/')) {
      handleCommand(value);
    } else {
      handleFreeText();
    }
  }

  sendBtn.addEventListener('click', submitMessage);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitMessage();
    }
  });
})();
