/**
 * The grouped top navigation: five entries where there were eleven links.
 *
 * Decks and Collection are split buttons — the label goes straight to My
 * Decks / Inventory, the pages used most, and a separate caret opens the rest.
 * Market, Sharing and Insights have no single main page, so the whole button
 * opens the menu.
 *
 * Menus open on click, not hover: hover does not exist on a phone and a menu
 * that closes when the pointer drifts is worse than one more click. They are
 * moved to <body> and positioned against their button, because the row they
 * belong to scrolls sideways and carries a fade mask — either would clip a
 * menu drawn inside it.
 *
 * The Trades and Loans badges live on their menu items (trades.js / loans.js
 * update them by id, unchanged); the Sharing button shows their sum, so a
 * waiting trade is not hidden behind a closed menu.
 */

let openGroup = null;

function menuOf(group) {
  return group._menu;
}

function triggerOf(group) {
  return group.querySelector('.nav-caret, .nav-group-toggle');
}

function place(group) {
  const menu = menuOf(group);
  const rect = group.getBoundingClientRect();
  menu.style.top = `${Math.round(rect.bottom + 6)}px`;
  // Kept on screen: at phone width the last group sits near the right edge.
  const width = menu.offsetWidth;
  const left = Math.min(rect.left, window.innerWidth - width - 8);
  menu.style.left = `${Math.max(8, Math.round(left))}px`;
}

function close({ focusTrigger = false } = {}) {
  if (!openGroup) return;
  const group = openGroup;
  openGroup = null;
  menuOf(group).classList.add('hidden');
  triggerOf(group).setAttribute('aria-expanded', 'false');
  group.classList.remove('open');
  if (focusTrigger) triggerOf(group).focus();
}

function open(group, { focusFirst = false } = {}) {
  if (openGroup === group) return;
  close();
  openGroup = group;
  const menu = menuOf(group);
  menu.classList.remove('hidden');
  triggerOf(group).setAttribute('aria-expanded', 'true');
  group.classList.add('open');
  place(group);
  if (focusFirst) menu.querySelector('.nav-menu-item')?.focus();
}

function moveFocus(menu, step) {
  const items = [...menu.querySelectorAll('.nav-menu-item')];
  const at = items.indexOf(document.activeElement);
  items[(at + step + items.length) % items.length]?.focus();
}

/** Sharing shows the sum of the Trades and Loans badges it hides. */
function mirrorSharingBadge() {
  const total = document.getElementById('sharing-badge');
  const parts = ['trade-pending-badge', 'loan-action-badge']
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  if (!total || !parts.length) return;

  const update = () => {
    const sum = parts
      .filter((b) => !b.classList.contains('hidden'))
      .reduce((n, b) => n + (parseInt(b.textContent, 10) || 0), 0);
    total.textContent = sum;
    total.classList.toggle('hidden', sum === 0);
  };
  const observer = new MutationObserver(update);
  for (const b of parts) observer.observe(b, { attributes: true, childList: true, characterData: true, subtree: true });
  update();
}

/**
 * Wire the groups. `navigate(page)` is the app's showPage; every page link,
 * top-level or in a menu, goes through it so history and page events behave
 * exactly as they did with flat links.
 */
export function setupNavMenu(navigate) {
  const groups = [...document.querySelectorAll('.nav-links .nav-group')];

  for (const group of groups) {
    const menu = group.querySelector('.nav-menu');
    group._menu = menu;
    menu.dataset.group = group.dataset.group;
    document.body.appendChild(menu);

    triggerOf(group).addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (openGroup === group) close(); else open(group);
    });
    triggerOf(group).addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        open(group, { focusFirst: true });
      }
    });

    menu.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(menu, 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(menu, -1); }
      else if (e.key === 'Escape') { e.preventDefault(); close({ focusTrigger: true }); }
      else if (e.key === 'Tab') close();
    });
  }

  const pageLinks = [
    ...document.querySelectorAll('.nav-links [data-page]'),
    ...document.querySelectorAll('.nav-menu [data-page]'),
  ];
  for (const link of pageLinks) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      close();
      navigate(link.dataset.page);
    });
  }

  document.addEventListener('click', (e) => {
    if (openGroup && !menuOf(openGroup).contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openGroup) close({ focusTrigger: true });
  });
  // A fixed menu would drift away from a row that moved under it.
  window.addEventListener('resize', () => close());
  document.querySelector('.nav-links')?.addEventListener('scroll', () => close(), { passive: true });

  mirrorSharingBadge();
}

/** Mark the current page in its menu, and its group in the row. */
export function setActiveNav(pageName) {
  for (const el of document.querySelectorAll('.nav-menu-item, .nav-group-main')) {
    const on = el.dataset.page === pageName;
    el.classList.toggle('active', on);
    if (el.classList.contains('nav-menu-item')) {
      if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
    }
  }
  for (const group of document.querySelectorAll('.nav-links .nav-group')) {
    const menu = group._menu || group.querySelector('.nav-menu');
    const inGroup = !!menu?.querySelector(`[data-page="${CSS.escape(pageName)}"]`);
    group.classList.toggle('active', inGroup);
    group.querySelector('.nav-group-toggle')?.classList.toggle('active', inGroup);
  }
}
