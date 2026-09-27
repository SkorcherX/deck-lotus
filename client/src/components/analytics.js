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
import { token, tokenRgba, manaColor } from '../utils/theme.js';

const TOP_SETS = 15;

let data = null;
const charts = {};
const view = { setsBy: 'value', colorsBy: 'copies' };

const el = (id) => document.getElementById(id);
const money = (n) => '$' + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const count = (n) => (n || 0).toLocaleString();

export function setupAnalytics() {
  window.addEventListener('page:analytics', load);
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
    });
  });
}

async function load() {
  const status = el('analytics-status');
  status.textContent = 'Loading…';
  status.classList.remove('hidden');
  try {
    const [summary, timeline, sets, colors, valueHistory] = await Promise.all([
      api.getAnalytics('summary'),
      api.getAnalytics('timeline'),
      api.getAnalytics('sets'),
      api.getAnalytics('colors'),
      api.getAnalytics('value-history'),
    ]);
    data = { summary, timeline, sets, colors, valueHistory };
    status.classList.add('hidden');
    renderSummary();
    renderSetsTable();
    renderSources();
    renderCharts();
  } catch (error) {
    status.textContent = `Could not load analytics: ${error.message}`;
  }
}

function renderCharts() {
  if (!window.Chart) return;
  renderTimelineChart();
  renderValueChart();
  renderSetsChart();
  renderColorsChart();
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
  el('analytics-kpis').innerHTML = tiles.map(([label, value]) => `
    <div class="analytics-kpi">
      <div class="analytics-kpi-value">${value}</div>
      <div class="analytics-kpi-label">${label}</div>
    </div>`).join('');
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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
