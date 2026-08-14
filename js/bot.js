/* ---------------------------------------------------------
   Summit — bot.js
   Sherpa: a small bottom-right chat assistant. Session-only,
   same as the rest of the app — nothing here persists across
   a reload. Reads/writes the Draft hierarchy exclusively
   through window.Summit.draft's public API (Section 5), never
   touching its internal state directly.

   Commands so far:
     /help       — list what Sherpa can do
     /duplicate  — search-and-pick a Sub-Enquiry to copy (name only,
                   by default — see "Duplicate (all contents)" below
                   for keywords/templates/labels too)

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
  // Generic searchable picker, rendered as its own full-width bot
  // bubble so it scrolls and wraps with the rest of the conversation
  // instead of floating off in a separate popup. Used by both the
  // /duplicate command and the Move destination picker below.
  // ============================================================

  function renderPicker({ items, emptyText, introText, searchPlaceholder, searchLabel, onPick }) {
    if (items.length === 0) {
      addMessage(emptyText, 'bot');
      return;
    }

    const bubble = document.createElement('div');
    bubble.className = 'summit-bot__msg summit-bot__msg--bot summit-bot__msg--picker';

    const intro = document.createElement('p');
    intro.className = 'summit-bot__picker-intro';
    intro.textContent = introText;
    bubble.appendChild(intro);

    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'summit-bot__picker-search';
    search.placeholder = searchPlaceholder;
    search.setAttribute('aria-label', searchLabel);
    bubble.appendChild(search);

    const list = document.createElement('ul');
    list.className = 'summit-bot__picker-list';
    bubble.appendChild(list);

    function renderList(filteredItems) {
      list.innerHTML = '';
      if (filteredItems.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'summit-bot__picker-empty';
        empty.textContent = 'Nothing matches that search.';
        list.appendChild(empty);
        return;
      }
      filteredItems.forEach((entry) => {
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
          onPick(entry);
        });

        li.appendChild(btn);
        list.appendChild(li);
      });
    }

    renderList(items);

    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      if (!q) { renderList(items); return; }
      const filtered = items.filter((entry) =>
        entry.name.toLowerCase().includes(q) || (entry.path && entry.path.toLowerCase().includes(q))
      );
      renderList(filtered);
    });

    messagesEl.appendChild(bubble);
    scrollToBottom();
    search.focus();
  }

  // /duplicate — searchable Sub-Enquiry picker.
  function renderDuplicatePicker() {
    const draftApi = window.Summit && window.Summit.draft;
    const all = draftApi && typeof draftApi.listSubEnquiries === 'function'
      ? draftApi.listSubEnquiries()
      : [];

    renderPicker({
      items: all,
      emptyText: 'Scanned the hierarchy \u2014 no Sub-Enquiries out there yet. Add one in the Draft tab, then send /duplicate again.',
      introText: 'Found ' + all.length + ' sub-enquir' + (all.length === 1 ? 'y' : 'ies') + '. Search or pick one to duplicate:',
      searchPlaceholder: 'Search by name or path\u2026',
      searchLabel: 'Search sub-enquiries to duplicate',
      onPick: (entry) => {
        const newId = draftApi.duplicateSubEnquiry(entry.id);
        if (newId) {
          addMessage('Duplicate complete \u2014 a blank copy of "' + entry.name + '" (name only) is open in the Draft tab. Need the keywords/templates/labels too? Use the + bullet in the tree and pick "Duplicate (all contents)".', 'bot');
        } else {
          addMessage('That one\u2019s gone missing \u2014 try /duplicate again to refresh the list.', 'bot');
        }
      }
    });
  }

  // Move destination picker — searchable list of Enquiry folders.
  // `afterDuplicate` only changes the confirmation wording once the
  // move lands, so "Duplicate then Move" reads correctly.
  function renderMovePicker(subId, subName, afterDuplicate) {
    const draftApi = window.Summit && window.Summit.draft;
    const enquiries = draftApi && typeof draftApi.listEnquiries === 'function'
      ? draftApi.listEnquiries()
      : [];

    renderPicker({
      items: enquiries,
      emptyText: 'No Enquiry folders to move into yet \u2014 add one in the Draft tab first.',
      introText: 'Choose an Enquiry folder to move "' + subName + '" into:',
      searchPlaceholder: 'Search Enquiry folders\u2026',
      searchLabel: 'Search Enquiry folders to move into',
      onPick: (entry) => {
        const ok = draftApi.moveSubEnquiry(subId, entry.id);
        if (ok) {
          addMessage(
            (afterDuplicate ? 'Duplicated and moved \u2014 "' : 'Moved \u2014 "') + subName + '" is now in "' + entry.name + '", open in the Draft tab.',
            'bot'
          );
        } else {
          addMessage('Couldn\u2019t complete the move \u2014 that Sub-Enquiry or folder is gone. Try again from the tree.', 'bot');
        }
      }
    });
  }

  // ============================================================
  // + bullet on a Sub-Enquiry in the tree — drops it into the chat
  // as a context card, followed by Duplicate / Duplicate (all
  // contents) / Move / Duplicate then Move actions. "Duplicate" alone
  // copies just the name; "Duplicate (all contents)" also copies
  // keywords/templates/labels. Entry point is
  // window.Summit.bot.sendSubEnquiry, called from draft.js's onSend
  // handler (Section 5.2).
  // ============================================================

  function renderSubEnquiryActions(subId, name, path) {
    const draftApi = window.Summit && window.Summit.draft;

    const card = document.createElement('div');
    card.className = 'summit-bot__msg summit-bot__msg--bot summit-bot__context';
    const nameEl = document.createElement('div');
    nameEl.className = 'summit-bot__context-name';
    nameEl.textContent = name;
    card.appendChild(nameEl);
    if (path) {
      const pathEl = document.createElement('div');
      pathEl.className = 'summit-bot__context-path';
      pathEl.textContent = path;
      card.appendChild(pathEl);
    }
    messagesEl.appendChild(card);

    const actionsBubble = document.createElement('div');
    actionsBubble.className = 'summit-bot__msg summit-bot__msg--bot summit-bot__actions';

    function makeActionBtn(label, onClick) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'summit-bot__action-btn';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        Array.from(actionsBubble.querySelectorAll('button')).forEach((b) => { b.disabled = true; });
        onClick();
      });
      return btn;
    }

    actionsBubble.appendChild(makeActionBtn('Duplicate', () => {
      const newId = draftApi.duplicateSubEnquiry(subId);
      if (newId) {
        addMessage('Duplicate complete \u2014 a blank copy of "' + name + '" (name only) is open in the Draft tab.', 'bot');
      } else {
        addMessage('That one\u2019s gone missing \u2014 try again from the tree.', 'bot');
      }
    }));

    actionsBubble.appendChild(makeActionBtn('Duplicate (all contents)', () => {
      const newId = draftApi.duplicateSubEnquiry(subId, { withContents: true });
      if (newId) {
        addMessage('Duplicate complete \u2014 "' + name + '" is copied with its keywords, templates, and labels, and is open in the Draft tab.', 'bot');
      } else {
        addMessage('That one\u2019s gone missing \u2014 try again from the tree.', 'bot');
      }
    }));

    actionsBubble.appendChild(makeActionBtn('Move', () => {
      renderMovePicker(subId, name, false);
    }));

    actionsBubble.appendChild(makeActionBtn('Duplicate then Move', () => {
      const newId = draftApi.duplicateSubEnquiry(subId);
      if (!newId) {
        addMessage('That one\u2019s gone missing \u2014 try again from the tree.', 'bot');
        return;
      }
      addMessage('Duplicated \u2014 now pick where the copy should live:', 'bot');
      renderMovePicker(newId, name, true);
    }));

    messagesEl.appendChild(actionsBubble);
    scrollToBottom();
  }

  const HELP_TEXT =
    'Here\u2019s what I can do so far:\n' +
    '\u2022 /duplicate \u2014 search for a Sub-Enquiry and make a blank copy of it (name only)\n' +
    '\u2022 Hover the dot beside any Sub-Enquiry in the tree and click the + that appears \u2014 I\u2019ll offer to Duplicate (name only), Duplicate (all contents), Move, or Duplicate then Move it\n' +
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

  // ============================================================
  // Public API (mirrors window.Summit.draft) — lets draft.js hand a
  // Sub-Enquiry over without knowing anything about the chat panel's
  // internals.
  // ============================================================

  window.Summit = window.Summit || {};
  window.Summit.bot = {
    sendSubEnquiry(id) {
      const draftApi = window.Summit && window.Summit.draft;
      const entry = draftApi && typeof draftApi.getSubEnquiry === 'function'
        ? draftApi.getSubEnquiry(id)
        : null;
      if (!entry) return;
      openPanel();
      renderSubEnquiryActions(entry.id, entry.name, entry.path);
    }
  };
})();
