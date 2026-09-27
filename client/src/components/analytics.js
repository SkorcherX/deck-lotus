/**
 * Analytics page: what the collection is made of, what it is worth, and when
 * it changed.
 *
 * Every chart colour comes through token()/tokenRgba(), never a hex and never
 * a var() — Chart.js paints to a canvas, which cannot resolve custom
 * properties. Charts are rebuilt on `theme:changed` so a theme switch repaints
 * them instead of leaving the old palette behind.
 */
import api from '../services/api.js';
import { token, tokenRgba, manaColor, cmcColor } from '../utils/theme.js';

const TOP_SETS = 15;

let data = null;
const charts = {};
const view = { setsBy: 'value', colorsBy: 'copies', compositionBy: 'copies', moversDays: '7' };

const el = (id) => document.getElementById(id);
const money = (n) => '$' + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const count = (n) => (n || 0).toLocaleString();

// Admin scope. null is "just me" — the normal path, no userIds sent. Otherwise
// the ids being viewed: one other person, or a household combined.
let currentUserId = null;
let allUsers = [];
let scopeUserIds = null;

export function setupAnalytics() {
  window.addEventListener('page:analytics', async () => {
    await setupAdminScope();
    load();
  });
  document.addEventListener('theme:changed', () => { if (data) renderCharts(); });

  document.querySelectorAll('[data-analytics-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [key, value] = btn.dataset.analyticsToggle.split(':');
      view[key] = value;
      document.querySelectorAll(`[data-analytics-toggle^="${key}:"]`).forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      });
      if (!data) return;
      if (key === 'setsBy') { renderSetsChart(); renderSetsTable(); }
      if (key === 'colorsBy') renderColorsChart();
      if (key === 'compositionBy') renderCompositionCharts();
      if (key === 'moversDays') loadMovers();
    });
  });
}

/**
 * The admin's "Viewing analytics for" checklist, the same control the
 * Inventory page uses: Everyone first, then one box per user. Tick one person
 * to see theirs alone, or several to see them as one combined collection.
 * Non-admins never see it, and the server would ignore their choice anyway.
 */
async function setupAdminScope() {
  const row = el('analytics-admin-scope');
  const checklist = el('analytics-user-checklist');

  try {
    const profile = await api.getProfile();
    currentUserId = profile.user.id;
    if (!profile.user.is_admin) {
      row.classList.add('hidden');
      scopeUserIds = null;
      return;
    }

    ({ users: allUsers } = await api.getAllUsers());
    row.classList.remove('hidden');

    // Keep the selection across visits; start from "me" the first time.
    const selected = new Set(scopeUserIds || [currentUserId]);
    checklist.innerHTML = `
      <label class="inventory-user-checkbox inventory-user-all">
        <input type="checkbox" id="analytics-user-all" /> Everyone
      </label>
      ${allUsers.map((u) => `
        <label class="inventory-user-checkbox">
          <input type="checkbox" value="${u.id}" ${selected.has(u.id) ? 'checked' : ''} />
          ${escapeHtml(u.username)}${u.id === currentUserId ? ' (me)' : ''}
        </label>`).join('')}`;
    syncScopeControls();

    if (!checklist.dataset.wired) {
      checklist.dataset.wired = 'true';
      checklist.addEventListener('change', (e) => {
        const boxes = [...checklist.querySelectorAll('input[value]')];
        if (e.target.id === 'analytics-user-all') {
          // Unticking Everyone falls back to your own, the one selection never empty.
          boxes.forEach((cb) => { cb.checked = e.target.checked || Number(cb.value) === currentUserId; });
        }
        let checked = boxes.filter((cb) => cb.checked).map((cb) => Number(cb.value));
        if (checked.length === 0) {
          e.target.checked = true;
          checked = [Number(e.target.value)];
        }
        scopeUserIds = checked.length === 1 && checked[0] === currentUserId ? null : checked;
        syncScopeControls();
        load();
      });
    }
  } catch (error) {
    console.error('Failed to load analytics user scope:', error);
    row.classList.add('hidden');
    scopeUserIds = null;
  }
}

function syncScopeControls() {
  const boxes = [...el('analytics-user-checklist').querySelectorAll('input[value]')];
  const checked = boxes.filter((cb) => cb.checked);
  const all = el('analytics-user-all');
  all.checked = checked.length === boxes.length;
  all.indeterminate = checked.length > 0 && checked.length < boxes.length;

  const names = checked.map((cb) => allUsers.find((u) => u.id === Number(cb.value))?.username).filter(Boolean);
  el('analytics-scope-note').textContent = names.length > 1
    ? `Combined collection of ${names.join(', ')}. Cards traded or lent between them stay inside the group, so they don't count as coming in, going out or lent out.`
    : '';
}

let loadSeq = 0;

async function load() {
  // Ticking boxes quickly starts overlapping loads; only the newest may render,
  // or a slow earlier answer could paint one scope under another's name.
  const seq = ++loadSeq;
  const status = el('analytics-status');
  status.textContent = 'Loading…';
  status.classList.remove('hidden');
  try {
    const [
      summary, timeline, sets, colors, valueHistory, composition, topCards, completion, daily, deckUse, tradesLoans,
      movers,
    ] = await Promise.all([
      api.getAnalytics('summary', scopeUserIds),
      api.getAnalytics('timeline', scopeUserIds),
      api.getAnalytics('sets', scopeUserIds),
      api.getAnalytics('colors', scopeUserIds),
      api.getAnalytics('value-history', scopeUserIds),
      api.getAnalytics('composition', scopeUserIds),
      api.getAnalytics('top-cards', scopeUserIds),
      api.getAnalytics('set-completion', scopeUserIds),
      api.getAnalytics('daily', scopeUserIds),
      api.getAnalytics('deck-use', scopeUserIds),
      api.getAnalytics('trades-loans', scopeUserIds),
      api.getAnalytics(`movers?days=${view.moversDays}`, scopeUserIds),
    ]);
    if (seq !== loadSeq) return;
    data = {
      summary, timeline, sets, colors, valueHistory, composition, topCards, completion, daily, deckUse, tradesLoans,
      movers,
    };
    status.classList.add('hidden');
    renderSummary();
    renderSetsTable();
    renderSources();
    renderCalendar();
    renderTopCards();
    renderCompletion();
    renderDeckUse();
    renderTradesLoans();
    renderMovers();
    renderCharts();
  } catch (error) {
    if (seq !== loadSeq) return;
    status.textContent = `Could not load analytics: ${error.message}`;
  }
}

function renderCharts() {
  if (!window.Chart) return;
  renderTimelineChart();
  renderValueChart();
  renderSetsChart();
  renderColorsChart();
  renderCompositionCharts();
}

// ---- Shared chart styling ---------------------------------------------------

function baseOptions(extra = {}) {
  const text = token('--text-secondary');
  const border = token('--border');
  const grid = tokenRgba('--primary-rgb', 0.08);
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: text, boxWidth: 12, font: { size: 11 } } },
      tooltip: tooltipStyle(),
    },
    scales: {
      x: { ticks: { color: text, font: { size: 10 } }, grid: { color: grid }, border: { color: border } },
      y: { ticks: { color: text, font: { size: 10 } }, grid: { color: grid }, border: { color: border } },
    },
    ...extra,
  };
}

function tooltipStyle() {
  return {
    backgroundColor: token('--bg-tertiary'),
    titleColor: token('--text'),
    bodyColor: token('--text-secondary'),
    borderColor: token('--border'),
    borderWidth: 1,
  };
}

function draw(key, canvasId, config) {
  charts[key]?.destroy();
  charts[key] = new window.Chart(el(canvasId), config);
}

/** Swap a chart for its empty-state message. Returns whether it was empty. */
function showEmpty(key, canvasId, emptyId, isEmpty) {
  el(canvasId).parentElement.classList.toggle('hidden', isEmpty);
  el(emptyId).classList.toggle('hidden', !isEmpty);
  if (isEmpty) { charts[key]?.destroy(); charts[key] = null; }
  return isEmpty;
}

// ---- Summary ----------------------------------------------------------------

function renderSummary() {
  const s = data.summary;
  const tiles = [
    ['Total cards', count(s.totalCards)],
    ['Unique cards', count(s.uniqueCards)],
    ['Collection value', money(s.totalValue)],
    ['Sets', count(s.sets)],
    ['Foils', count(s.foilCards)],
    ['Added, last 30 days', count(s.addedLast30Days)],
  ];
  const change = valueChange(data.valueHistory, 30);
  if (change) {
    const sign = change.amount > 0 ? '+' : change.amount < 0 ? '−' : '';
    tiles.push([
      `Value change, ${change.days} days`,
      `${sign}${money(Math.abs(change.amount))}`,
      change.amount > 0 ? 'up' : change.amount < 0 ? 'down' : '',
      change.percent == null ? '' : `${sign}${Math.abs(change.percent).toFixed(1)}%`,
    ]);
  }
  el('analytics-kpis').innerHTML = tiles.map(([label, value, trend = '', sub = '']) => `
    <div class="analytics-kpi">
      <div class="analytics-kpi-value ${trend}">${value}${sub ? ` <small>${sub}</small>` : ''}</div>
      <div class="analytics-kpi-label">${label}</div>
    </div>`).join('');
}

/**
 * Latest snapshot against the one closest to `days` ago, or the oldest if
 * history is shorter than that. Null until there are two snapshots. Note the
 * change includes cards added or removed, not only price movement.
 */
function valueChange(points, days) {
  if (points.length < 2) return null;
  const last = points[points.length - 1];
  const cutoff = new Date(new Date(last.date + 'T00:00:00Z').getTime() - days * DAY_MS).toISOString().slice(0, 10);
  const base = [...points].reverse().find((p) => p.date <= cutoff) || points[0];
  const span = Math.round((new Date(last.date) - new Date(base.date)) / DAY_MS);
  return {
    days: span,
    amount: last.value - base.value,
    percent: base.value ? ((last.value - base.value) / base.value) * 100 : null,
  };
}

// ---- Deck use ---------------------------------------------------------------
//
// HTML bars rather than a chart: three segments of one whole, and as DOM they
// take var() colours directly.

function renderDeckUse() {
  const u = data.deckUse;
  if (!u.copies) {
    el('analytics-deck-use').innerHTML = '<p class="analytics-empty">No cards yet.</p>';
    el('analytics-idle').innerHTML = '<p class="analytics-empty">No cards yet.</p>';
    return;
  }

  const bar = (label, parts, total, fmt) => `
    <div class="analytics-split">
      <div class="analytics-split-label">${label}</div>
      <div class="analytics-split-bar">
        ${parts.map(([key, n]) => (n > 0
          ? `<div class="seg-${key}" style="flex-grow: ${n}" title="${fmt(n)} (${((n / total) * 100).toFixed(1)}%)"></div>`
          : '')).join('')}
      </div>
    </div>`;

  const pct = (n, total) => (total ? `${((n / total) * 100).toFixed(0)}%` : '0%');

  el('analytics-deck-use').innerHTML = `
    ${bar('Cards', [['decks', u.inDecks], ['lent', u.lent], ['idle', u.idle]], u.copies, count)}
    ${bar('Value', [['decks', u.inDecksValue], ['lent', u.lentValue], ['idle', u.idleValue]], u.value || 1, money)}
    <div class="analytics-split-legend">
      <span><i class="seg-decks"></i>In decks <b>${count(u.inDecks)}</b> · ${money(u.inDecksValue)} · ${pct(u.inDecks, u.copies)}</span>
      <span><i class="seg-lent"></i>Lent out <b>${count(u.lent)}</b> · ${money(u.lentValue)}</span>
      <span><i class="seg-idle"></i>Not in a deck <b>${count(u.idle)}</b> · ${money(u.idleValue)} · ${pct(u.idle, u.copies)}</span>
    </div>
    <ul class="analytics-facts">
      <li><b>${count(u.cardsInNoDeck)}</b> different cards aren't in any of your decks.</li>
      <li><b>${count(u.spare)}</b> spare copies beyond a playset of four, worth ${money(u.spareValue)} — likely trade material.</li>
    </ul>`;

  el('analytics-idle').innerHTML = u.topIdle.length ? `
    <table class="analytics-table analytics-top">
      <tbody>${u.topIdle.map((r, i) => `
        <tr>
          <td class="rank">${i + 1}</td>
          <td><span class="analytics-top-name">${escapeHtml(r.name)}</span></td>
          <td class="num">${money(r.perCopy)}</td>
          <td class="num analytics-top-total">${r.idle > 1 ? `×${r.idle} = ${money(r.total)}` : ''}</td>
        </tr>`).join('')}
      </tbody>
    </table>` : '<p class="analytics-empty">Every priced card is in a deck.</p>';
}

// ---- Price movers -----------------------------------------------------------

/** Refetch just the movers when the period changes; the rest of the page stands. */
async function loadMovers() {
  if (!data) return;
  const seq = loadSeq;
  try {
    const movers = await api.getAnalytics(`movers?days=${view.moversDays}`, scopeUserIds);
    if (seq !== loadSeq) return; // the scope changed underneath; that load will render its own
    data.movers = movers;
    renderMovers();
  } catch (error) {
    el('analytics-movers-note').textContent = `Could not load price movers: ${error.message}`;
  }
}

function renderMovers() {
  const m = data.movers;
  const note = el('analytics-movers-note');
  const out = el('analytics-movers');

  if (!m.since) {
    note.textContent = '';
    out.innerHTML = `<p class="analytics-empty">Prices are recorded each night after the price refresh.
      Movers appear once there are two days of history.</p>`;
    return;
  }

  const since = new Date(m.since + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${money(Math.abs(n))}`;
  const spanDays = Math.round((Date.now() - new Date(m.since + 'T00:00:00Z')) / DAY_MS);
  note.innerHTML = `Since ${since}${spanDays < m.days ? ` (only ${spanDays} days of history so far)` : ''}.
    Net change on your cards: <b class="${m.netChange >= 0 ? 'up' : 'down'}">${signed(m.netChange)}</b>.
    Ranked by what the move did to your collection, so a card you hold four of counts four times.`;

  const table = (rows, empty) => (rows.length ? `
    <table class="analytics-table analytics-top">
      <tbody>${rows.map((r) => `
        <tr>
          <td>
            <span class="analytics-top-name">${escapeHtml(r.name)}</span>${r.isFoil ? ' <span class="analytics-foil">Foil</span>' : ''}
            <span class="analytics-set-code">${escapeHtml(r.setCode)} ${escapeHtml(r.collectorNumber || '')}</span>
          </td>
          <td class="num analytics-top-total">${money(r.then)} → ${money(r.now)}</td>
          <td class="num ${r.change > 0 ? 'up' : 'down'}">${r.percent == null ? '' : `${r.percent > 0 ? '+' : ''}${r.percent.toFixed(0)}%`}</td>
          <td class="num ${r.change > 0 ? 'up' : 'down'}">${signed(r.totalChange)}${r.quantity > 1 ? `<small> ×${r.quantity}</small>` : ''}</td>
        </tr>`).join('')}
      </tbody>
    </table>` : `<p class="analytics-empty">${empty}</p>`);

  out.innerHTML = `
    <div><h5>Gainers</h5>${table(m.gainers, 'Nothing went up.')}</div>
    <div><h5>Losers</h5>${table(m.losers, 'Nothing went down.')}</div>`;
}

// ---- Trades & loans ---------------------------------------------------------

function renderTradesLoans() {
  const { trades, loans } = data.tradesLoans;
  const stats = [
    ['Trades completed', count(trades.accepted)],
    ['Trades open', count(trades.open)],
    ['Cards received in trades', count(trades.cardsIn)],
    ['Cards given in trades', count(trades.cardsOut)],
    ['Copies lent out now', count(loans.lentNow)],
    ['Copies borrowed now', count(loans.borrowedNow)],
    ['Loans made', count(loans.made)],
    ['Loans taken', count(loans.taken)],
  ];
  if (scopeUserIds && scopeUserIds.length > 1) {
    stats.push(
      ['Trades within the group', count(trades.withinGroup)],
      ['Loans within the group', count(loans.withinGroup)],
    );
  }
  el('analytics-trades-loans').innerHTML = stats.map(([label, value]) => `
    <div><b>${value}</b><span>${label}</span></div>`).join('');
}

// ---- Activity timeline ------------------------------------------------------

function renderTimelineChart() {
  const { months, trackingSince } = data.timeline;
  el('analytics-tracking-since').textContent = trackingSince
    ? `Tracked since ${new Date(trackingSince.replace(' ', 'T') + 'Z').toLocaleDateString()}. Changes before then were not recorded.`
    : '';
  if (showEmpty('timeline', 'analytics-timeline', 'analytics-timeline-empty', months.length === 0)) return;

  const labels = months.map((m) => {
    const [y, mo] = m.month.split('-').map(Number);
    return new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  });

  const opts = baseOptions({ interaction: { mode: 'index', intersect: false } });
  opts.scales.x.stacked = true;
  opts.scales.y.stacked = true;
  opts.scales.y.ticks.callback = (v) => Math.abs(v).toLocaleString();
  opts.plugins.tooltip.callbacks = {
    label: (ctx) => `${ctx.dataset.label}: ${Math.abs(ctx.parsed.y).toLocaleString()}`,
  };

  draw('timeline', 'analytics-timeline', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Added', data: months.map((m) => m.added), backgroundColor: tokenRgba('--success-rgb', 0.8), borderRadius: 3, maxBarThickness: 48 },
        // Drawn below zero so a month's net change reads at a glance.
        { label: 'Removed', data: months.map((m) => -m.removed), backgroundColor: tokenRgba('--danger-rgb', 0.75), borderRadius: 3, maxBarThickness: 48 },
      ],
    },
    options: opts,
  });
}

const SOURCE_LABELS = {
  bulk_add: 'Bulk add', quick_add: 'Quick add', card_page: 'Card page', deck_builder: 'Deck builder',
  deck_import: 'Deck import', trade: 'Trades', scan: 'Scanner', api: 'Other',
};

function renderSources() {
  const rows = data.timeline.bySource.filter((r) => r.added || r.removed);
  el('analytics-sources').innerHTML = rows.length ? `
    <table class="analytics-table">
      <thead><tr><th>Source</th><th class="num">Added</th><th class="num">Removed</th></tr></thead>
      <tbody>${rows.map((r) => `
        <tr><td>${escapeHtml(SOURCE_LABELS[r.source] || r.source)}</td>
            <td class="num">${count(r.added)}</td><td class="num">${count(r.removed)}</td></tr>`).join('')}
      </tbody>
    </table>` : '';
}

// ---- Value over time --------------------------------------------------------

function renderValueChart() {
  const points = data.valueHistory;
  // One point is not a line. Snapshots are written after each daily price refresh.
  if (showEmpty('value', 'analytics-value', 'analytics-value-empty', points.length < 2)) return;

  const opts = baseOptions({ interaction: { mode: 'index', intersect: false } });
  opts.plugins.legend.display = false;
  opts.scales.y.ticks.callback = (v) => money(v);
  opts.plugins.tooltip.callbacks = { label: (ctx) => money(ctx.parsed.y) };

  draw('value', 'analytics-value', {
    type: 'line',
    data: {
      labels: points.map((p) => new Date(p.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })),
      datasets: [{
        label: 'Value',
        data: points.map((p) => p.value),
        borderColor: tokenRgba('--primary-rgb', 0.95),
        backgroundColor: tokenRgba('--primary-rgb', 0.12),
        pointRadius: points.length > 60 ? 0 : 3,
        tension: 0.25,
        fill: true,
      }],
    },
    options: opts,
  });
}

// ---- Sets -------------------------------------------------------------------

/** Top sets by the current measure, with the tail folded into "Other". */
function topSets() {
  const field = view.setsBy;
  const sorted = [...data.sets].sort((a, b) => b[field] - a[field]);
  if (sorted.length <= TOP_SETS) return sorted;
  const rest = sorted.slice(TOP_SETS);
  return [
    ...sorted.slice(0, TOP_SETS),
    {
      name: `Other (${rest.length} sets)`,
      isOther: true,
      copies: rest.reduce((s, r) => s + r.copies, 0),
      value: rest.reduce((s, r) => s + r.value, 0),
    },
  ];
}

function renderSetsChart() {
  if (!window.Chart) return;
  if (showEmpty('sets', 'analytics-sets', 'analytics-sets-empty', data.sets.length === 0)) return;

  const field = view.setsBy;
  const total = data.sets.reduce((s, r) => s + r[field], 0) || 1;
  const rows = topSets();
  el('analytics-sets').parentElement.style.height = `${Math.max(220, rows.length * 26 + 40)}px`;

  const opts = baseOptions({ indexAxis: 'y' });
  opts.plugins.legend.display = false;
  opts.scales.y.grid.display = false;
  opts.scales.x.ticks.callback = (v) => (field === 'value' ? money(v) : count(v));
  opts.plugins.tooltip.callbacks = {
    label: (ctx) => {
      const r = rows[ctx.dataIndex];
      const share = ((r[field] / total) * 100).toFixed(1);
      return `${count(r.copies)} cards · ${money(r.value)} · ${share}% of ${field === 'value' ? 'value' : 'cards'}`;
    },
  };

  draw('sets', 'analytics-sets', {
    type: 'bar',
    data: {
      labels: rows.map((r) => (r.isOther ? r.name : `${r.name} (${r.code})`)),
      datasets: [{
        data: rows.map((r) => r[field]),
        backgroundColor: rows.map((r) => tokenRgba('--primary-rgb', r.isOther ? 0.3 : 0.85)),
        borderRadius: 3,
      }],
    },
    options: opts,
  });
}

function renderSetsTable() {
  const field = view.setsBy;
  const totalCopies = data.sets.reduce((s, r) => s + r.copies, 0) || 1;
  const totalValue = data.sets.reduce((s, r) => s + r.value, 0) || 1;
  const rows = [...data.sets].sort((a, b) => b[field] - a[field]);
  el('analytics-sets-count').textContent = `(${rows.length})`;
  el('analytics-sets-table').innerHTML = `
    <table class="analytics-table">
      <thead><tr>
        <th>Set</th><th class="num">Cards</th><th class="num">% of cards</th>
        <th class="num">Value</th><th class="num">% of value</th>
      </tr></thead>
      <tbody>${rows.map((r) => `
        <tr>
          <td>${r.keyrune ? `<i class="ss ss-${escapeHtml(r.keyrune.toLowerCase())}"></i> ` : ''}${escapeHtml(r.name)}
              <span class="analytics-set-code">${escapeHtml(r.code)}</span></td>
          <td class="num">${count(r.copies)}</td>
          <td class="num">${((r.copies / totalCopies) * 100).toFixed(1)}%</td>
          <td class="num">${money(r.value)}</td>
          <td class="num">${((r.value / totalValue) * 100).toFixed(1)}%</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

// ---- Colors -----------------------------------------------------------------

// Mana colours come from the theme's --mana-* tokens so they stay
// recognisable as W/U/B/R/G while still belonging to the theme's palette.
function colorFor(key) {
  if ('WUBRG'.includes(key)) return manaColor(key);
  return {
    multi: token('--warning'),
    colorless: token('--mana-colorless-b'),
    nonbasic_land: tokenRgba('--primary-rgb', 0.7),
    basic_land: token('--text-muted'),
  }[key];
}

function renderColorsChart() {
  if (!window.Chart) return;
  const field = view.colorsBy;
  const rows = data.colors.filter((c) => c[field] > 0);
  if (showEmpty('colors', 'analytics-colors', 'analytics-colors-empty', rows.length === 0)) return;
  const total = rows.reduce((s, r) => s + r[field], 0) || 1;

  draw('colors', 'analytics-colors', {
    type: 'doughnut',
    data: {
      labels: rows.map((r) => r.label),
      datasets: [{
        data: rows.map((r) => r[field]),
        backgroundColor: rows.map((r) => colorFor(r.key)),
        // Slice gaps in the panel colour, so White and Colorless stay
        // separate shapes rather than one pale blob.
        borderColor: token('--bg-secondary'),
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '58%',
      plugins: {
        legend: { position: 'right', labels: { color: token('--text-secondary'), boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          ...tooltipStyle(),
          callbacks: {
            label: (ctx) => {
              const r = rows[ctx.dataIndex];
              return `${r.label}: ${count(r.copies)} cards · ${money(r.value)} (${((r[field] / total) * 100).toFixed(1)}%)`;
            },
          },
        },
      },
    },
  });
}

// ---- Daily activity calendar ------------------------------------------------
//
// Plain HTML cells rather than a chart: it is a grid of squares, and as DOM it
// takes its colours straight from var() with no canvas bridge to keep in step.
// Days are UTC, matching SQLite's date() over the audit log's UTC stamps.

const DAY_MS = 86400000;

function renderCalendar() {
  const byDate = new Map(data.daily.map((d) => [d.date, d]));
  const max = Math.max(1, ...data.daily.map((d) => d.added));

  // 53 weeks ending with the current one, each column Sunday..Saturday.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const start = new Date(today.getTime() - (52 * 7 + today.getUTCDay()) * DAY_MS);

  const cells = [];
  const monthLabels = [];
  let lastMonth = -1;
  for (let week = 0; week < 53; week++) {
    const first = new Date(start.getTime() + week * 7 * DAY_MS);
    if (first.getUTCMonth() !== lastMonth) {
      monthLabels.push(`<span style="grid-column: ${week + 1}">${first.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' })}</span>`);
      lastMonth = first.getUTCMonth();
    }
    for (let dow = 0; dow < 7; dow++) {
      const d = new Date(first.getTime() + dow * DAY_MS);
      if (d > today) { cells.push('<i class="future"></i>'); continue; }
      const row = byDate.get(d.toISOString().slice(0, 10));
      const label = d.toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
      if (!row) {
        cells.push(`<i data-level="0" title="${label}: no changes"></i>`);
        continue;
      }
      const title = `${label}: +${row.added} added, −${row.removed} removed`;
      if (!row.added) {
        cells.push(`<i class="removed-only" title="${title}"></i>`);
        continue;
      }
      // Scaled to the busiest day, in four steps.
      const level = Math.min(4, Math.max(1, Math.ceil((row.added / max) * 4)));
      cells.push(`<i data-level="${level}" title="${title}"></i>`);
    }
  }

  el('analytics-calendar').innerHTML = `
    <div class="analytics-calendar-months">${monthLabels.join('')}</div>
    <div class="analytics-calendar">${cells.join('')}</div>`;
}

// ---- Composition: types, curve, rarity -------------------------------------

function renderCompositionCharts() {
  if (!window.Chart || !data) return;
  const field = view.compositionBy;
  const fmt = (v) => (field === 'value' ? money(v) : count(v));
  const { types, curve, rarities } = data.composition;

  // Types: horizontal bars, empty types dropped so the chart isn't half blank.
  const typeRows = types.filter((t) => t.copies > 0);
  if (!showEmpty('types', 'analytics-types', 'analytics-types-empty', typeRows.length === 0)) {
    const opts = baseOptions({ indexAxis: 'y' });
    opts.plugins.legend.display = false;
    opts.scales.y.grid.display = false;
    opts.scales.x.ticks.callback = fmt;
    opts.plugins.tooltip.callbacks = {
      label: (ctx) => `${count(typeRows[ctx.dataIndex].copies)} cards · ${money(typeRows[ctx.dataIndex].value)}`,
    };
    draw('types', 'analytics-types', {
      type: 'bar',
      data: {
        labels: typeRows.map((t) => t.key),
        datasets: [{ data: typeRows.map((t) => t[field]), backgroundColor: tokenRgba('--primary-rgb', 0.85), borderRadius: 3, maxBarThickness: 28 }],
      },
      options: opts,
    });
  }

  // Curve: every bucket kept, zeros included — a gap at 5 is information.
  const curveEmpty = curve.every((b) => b.copies === 0);
  if (!showEmpty('curve', 'analytics-curve', 'analytics-curve-empty', curveEmpty)) {
    const opts = baseOptions();
    opts.plugins.legend.display = false;
    opts.scales.x.grid.display = false;
    opts.scales.y.ticks.callback = fmt;
    opts.plugins.tooltip.callbacks = {
      title: (items) => `Mana value ${items[0].label}`,
      label: (ctx) => `${count(curve[ctx.dataIndex].copies)} cards · ${money(curve[ctx.dataIndex].value)}`,
    };
    draw('curve', 'analytics-curve', {
      type: 'bar',
      data: {
        labels: curve.map((b) => b.key),
        // The theme's own --cmc-N ramp, the same colours the deck builder's curve uses.
        datasets: [{ data: curve.map((b) => b[field]), backgroundColor: curve.map((b) => cmcColor(b.key === '7+' ? 7 : b.key)), borderRadius: 3 }],
      },
      options: opts,
    });
  }

  const rarityRows = rarities.filter((r) => r[field] > 0);
  if (!showEmpty('rarity', 'analytics-rarity', 'analytics-rarity-empty', rarityRows.length === 0)) {
    const total = rarityRows.reduce((s, r) => s + r[field], 0) || 1;
    draw('rarity', 'analytics-rarity', {
      type: 'doughnut',
      data: {
        labels: rarityRows.map((r) => RARITY_LABELS[r.key]),
        datasets: [{
          data: rarityRows.map((r) => r[field]),
          backgroundColor: rarityRows.map((r) => rarityColor(r.key)),
          borderColor: token('--bg-secondary'),
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '58%',
        plugins: {
          legend: { position: 'right', labels: { color: token('--text-secondary'), boxWidth: 12, font: { size: 11 } } },
          tooltip: {
            ...tooltipStyle(),
            callbacks: {
              label: (ctx) => {
                const r = rarityRows[ctx.dataIndex];
                return `${RARITY_LABELS[r.key]}: ${count(r.copies)} cards · ${money(r.value)} (${((r[field] / total) * 100).toFixed(1)}%)`;
              },
            },
          },
        },
      },
    });
  }
}

const RARITY_LABELS = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', mythic: 'Mythic', special: 'Special' };

// Roughly the set-symbol colours people already read rarity by, from theme tokens.
function rarityColor(key) {
  return {
    common: token('--text-muted'),
    uncommon: token('--mana-u'),
    rare: token('--warning'),
    mythic: token('--mana-r'),
    special: tokenRgba('--primary-rgb', 0.85),
  }[key];
}

// ---- Most valuable cards ----------------------------------------------------

function renderTopCards() {
  const rows = data.topCards;
  el('analytics-top-cards').innerHTML = rows.length ? `
    <table class="analytics-table analytics-top">
      <tbody>${rows.map((r, i) => `
        <tr>
          <td class="rank">${i + 1}</td>
          <td>
            <span class="analytics-top-name">${escapeHtml(r.name)}</span>${r.isFoil ? ' <span class="analytics-foil">Foil</span>' : ''}
            <span class="analytics-set-code">${escapeHtml(r.setCode)} ${escapeHtml(r.collectorNumber || '')}</span>
          </td>
          <td class="num">${money(r.price)}</td>
          <td class="num analytics-top-total">${r.quantity > 1 ? `×${r.quantity} = ${money(r.total)}` : ''}</td>
        </tr>`).join('')}
      </tbody>
    </table>` : '<p class="analytics-empty">No priced cards yet.</p>';
}

// ---- Set completion ---------------------------------------------------------

const COMPLETION_SHOWN = 12;

function completionRow(r) {
  return `
    <div class="analytics-progress-row">
      <div class="analytics-progress-label">
        ${r.keyrune ? `<i class="ss ss-${escapeHtml(r.keyrune.toLowerCase())}"></i> ` : ''}${escapeHtml(r.name)}
        <span class="analytics-set-code">${escapeHtml(r.code)}</span>
      </div>
      <div class="analytics-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${r.percent}">
        <div style="width: ${Math.min(100, r.percent)}%"></div>
      </div>
      <div class="analytics-progress-num">${count(r.owned)} / ${count(r.total)} <b>${r.percent.toFixed(1)}%</b></div>
    </div>`;
}

function renderCompletion() {
  const rows = data.completion;
  el('analytics-completion').innerHTML = rows.length
    ? rows.slice(0, COMPLETION_SHOWN).map(completionRow).join('')
    : '<p class="analytics-empty">No cards yet.</p>';
  const rest = rows.slice(COMPLETION_SHOWN);
  const more = el('analytics-completion-more-wrap');
  more.classList.toggle('hidden', rest.length === 0);
  more.querySelector('summary').textContent = `${rest.length} more sets`;
  el('analytics-completion-more').innerHTML = rest.map(completionRow).join('');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
