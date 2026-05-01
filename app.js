/* ═══════════════════════════════════════════
   PS99 Clan Battle Tracker — App Logic
   ═══════════════════════════════════════════ */

'use strict';

// Change tab title so we can confirm which JS version is running
document.title = 'PS99 Battle Tracker [v32]';

// ── Constants ──────────────────────────────
const STORAGE_KEY = 'ps99_tracker_v1';
const API_BASE    = 'https://biggamesapi.io/api';
const CORS_PROXIES = [
    'https://corsproxy.io/?url=',
    'https://api.allorigins.win/raw?url=',
];

const PALETTE = [
    '#6366f1', // indigo
    '#ec4899', // pink
    '#10b981', // emerald
    '#f59e0b', // amber
    '#ef4444', // red
    '#06b6d4', // cyan
    '#8b5cf6', // violet
    '#f97316', // orange
    '#14b8a6', // teal
    '#a855f7', // purple
    '#84cc16', // lime
    '#3b82f6', // blue
];

// ── State ──────────────────────────────────
let state = {
    war: { name: '', startDate: '', endDate: '', battleId: '' },
    clans: [],
    nextColorIdx: 0,
};

let ui = {
    currentClanId: null,
    editingPlayerId: null,
    confirmCallback: null,
};

// ── Persistence ────────────────────────────
function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
}

function load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) state = JSON.parse(raw);
    } catch (_) {}
}

// ── Helpers ────────────────────────────────
function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function esc(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(str ?? ''));
    return d.innerHTML;
}

function fmt(n) {
    return (Number(n) || 0).toLocaleString();
}

function warHoursElapsed() {
    if (!state.war.startDate) return 0;
    const start  = new Date(state.war.startDate + 'T00:00:00');
    const now    = new Date();
    const end    = state.war.endDate ? new Date(state.war.endDate + 'T23:59:59') : now;
    const cutoff = end < now ? end : now;
    return Math.max(1, (cutoff - start) / 3_600_000);
}

function clanTotal(clan) {
    const fromPlayers = clan.players.reduce((s, p) => s + (p.points || 0), 0);
    return Math.max(fromPlayers, clan.battleTotal || 0);
}

function sortedClans() {
    return [...state.clans].sort((a, b) => clanTotal(b) - clanTotal(a));
}

function getClan(id) {
    return state.clans.find(c => c.id === id);
}

function getRoleClass(role) {
    switch (role) {
        case 'Leader':    return 'role-leader';
        case 'Co-Leader': return 'role-co-leader';
        case 'Officer':   return 'role-officer';
        default:          return 'role-member';
    }
}

// ── Toast ──────────────────────────────────
let toastTimer = null;
function toast(msg, type = 'success') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast ${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ── Confirm Dialog ─────────────────────────
function confirm(title, message, onOk) {
    document.getElementById('confirm-title').textContent   = title;
    document.getElementById('confirm-message').textContent = message;
    ui.confirmCallback = onOk;
    document.getElementById('confirm-overlay').classList.add('active');
}

// ── Navigation ─────────────────────────────
function switchView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`${name}-view`).classList.add('active');
    const btn = document.querySelector(`[data-view="${name}"]`);
    if (btn) btn.classList.add('active');

    if (name === 'dashboard') renderDashboard();
    if (name === 'compare')   renderCompareInit();
    if (name === 'manage')    renderManage();
    if (name === 'monitor')   renderMonitor();
}

function showClanDetail(clanId) {
    ui.currentClanId = clanId;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('clan-detail-view').classList.add('active');
    const clan = getClan(clanId);
    if (clan && clan.players.length === 0 && clan.name) {
        // No players yet — do full import
        renderClanDetail();
        importClanByName(clan.name, clan.battleTotal || 0)
            .then(() => renderClanDetail())
            .catch(() => renderClanDetail());
    } else {
        renderClanDetail();
        // Auto-refresh points immediately when opening detail
        if (clan && clan.players.length > 0) {
            fastRefreshClan(clanId)
                .then(() => renderClanDetail())
                .catch(() => {});
        }
    }
}

function toggleCardPlayers(btn) {
    const list = btn.nextElementSibling;
    const open = list.style.display !== 'none';
    list.style.display = open ? 'none' : 'block';
    btn.textContent = open ? 'Players ▼' : 'Players ▲';
}

// ── Dashboard ──────────────────────────────
function renderDashboardLoading() {
    document.getElementById('current-war-title').textContent = 'PS99 Clan Battle';
    document.getElementById('current-war-dates').textContent = 'Loading live data…';
    document.getElementById('war-status-badge').innerHTML    = '<span class="status-pill status-active"><span class="spinner" style="border-top-color:#10b981"></span>Fetching…</span>';
    document.getElementById('clans-grid').innerHTML = `
      <div class="skeleton-grid">
        ${[1,2,3].map(() => '<div class="skeleton-card"><div class="sk sk-title"></div><div class="sk sk-pts"></div><div class="sk sk-bar"></div><div class="sk sk-foot"></div></div>').join('')}
      </div>`;
}

function renderDashboard() {
    const { war } = state;

    document.getElementById('current-war-title').textContent =
        war.name || 'PS99 Clan Battle';

    let dateStr = war.lastFetched
        ? `Last updated: ${new Date(war.lastFetched).toLocaleTimeString()}`
        : '';
    if (war.startDate && war.endDate) {
        const s = new Date(war.startDate + 'T00:00:00');
        const e = new Date(war.endDate   + 'T00:00:00');
        dateStr = `${s.toLocaleDateString('en-US',{month:'short',day:'numeric'})} – ${e.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`;
    }
    document.getElementById('current-war-dates').textContent = dateStr;

    // Status badge
    const badge = document.getElementById('war-status-badge');
    badge.innerHTML = state.clans.length
        ? '<span class="status-pill status-active">⚡ Live</span>'
        : '';

    const grid   = document.getElementById('clans-grid');
    const ranked = sortedClans();

    if (ranked.length === 0) {
        grid.innerHTML = `
          <div class="empty-state" style="grid-column:1/-1">
            <div class="empty-state-icon">⚔️</div>
            <p>No active battle found</p>
            <small>Hit <strong>🔄 Refresh</strong> to try again, or add clans manually in <strong>Manage War</strong></small>
          </div>`;
        return;
    }

    grid.className = 'clans-grid';
    const maxPts = clanTotal(ranked[0]) || 1;

    const dashNow = Date.now();
    let dashHours = warHoursElapsed();

    grid.innerHTML = ranked.map((clan, idx) => {
        const total     = clanTotal(clan);
        const pct       = Math.round((total / maxPts) * 100);
        const rankClass = idx === 0 ? 'rank-1' : idx === 1 ? 'rank-2' : idx === 2 ? 'rank-3' : 'rank-other';
        const topPlayer = [...clan.players].sort((a, b) => b.points - a.points)[0];

        // Avg/hr
        let hrs = dashHours;
        if (hrs === 0) {
            const snaps  = clan.snapshots || [];
            const oldest = snaps.length ? Math.min(...snaps.map(s => s.ts)) : dashNow;
            hrs = Math.max(1, (dashNow - oldest) / 3_600_000);
        }
        const avgHrCard = fmt(Math.round(total / hrs)) + '/hr';

        // Delta since last refresh
        const prevSnap = clan.prevSnapshot || null;
        let cardDelta = null;
        if (prevSnap && clan.players.length) {
            cardDelta = clan.players.reduce((sum, p) => {
                const prev = prevSnap.pts?.[p.userId] ?? null;
                return sum + (prev !== null ? Math.max(0, p.points - prev) : 0);
            }, 0);
        }
        const cardDeltaText = cardDelta !== null ? `+${fmt(cardDelta)} since refresh` : '';

        const sortedPlayers = [...clan.players].sort((a, b) => b.points - a.points);
        const playerRows = sortedPlayers.length
            ? sortedPlayers.map((p, i) => `
                <div class="card-player-row">
                  <span class="card-player-rank">${i + 1}</span>
                  <span class="card-player-name">${esc(p.username)}</span>
                  <span class="card-player-pts" style="color:${clan.color}">${fmt(p.points)}</span>
                </div>`).join('')
            : '<div style="color:var(--text-muted);font-size:12px;padding:6px 0">No player data yet</div>';

        return `
          <div class="clan-card" style="--clan-color:${clan.color}"
               onclick="showClanDetail('${clan.id}')">
            <div class="clan-card-header">
              <div class="clan-name-block">
                <div class="clan-name">${esc(clan.name)}</div>
                ${clan.tag ? `<div class="clan-tag">${esc(clan.tag)}</div>` : ''}
              </div>
              <div class="clan-rank-badge ${rankClass}">${idx + 1}</div>
            </div>
            <div class="clan-points-label">Total Points</div>
            <div class="clan-points">${fmt(total)}</div>
            <div class="clan-card-rates">
              <span class="card-rate">${avgHrCard}</span>
              ${cardDeltaText ? `<span class="card-delta">${cardDeltaText}</span>` : ''}
            </div>
            <div class="progress-bar">
              <div class="progress-fill" style="width:${pct}%;background:${clan.color}"></div>
            </div>
            <div class="clan-card-footer">
              <span>${clan.players.length} player${clan.players.length !== 1 ? 's' : ''}</span>
              <span>${topPlayer ? '🏆 ' + esc(topPlayer.username) : 'Click to view'}</span>
            </div>
            ${clan.players.length ? `
            <button class="card-players-toggle" onclick="event.stopPropagation();toggleCardPlayers(this)">
              Players ▼
            </button>
            <div class="card-players-list" style="display:none">
              ${playerRows}
            </div>` : ''}
            <button class="clan-refresh-btn" onclick="event.stopPropagation();refreshClan('${clan.id}')" title="Refresh from API">🔄</button>
          </div>`;
    }).join('');
}

// ── Clan Detail ────────────────────────────
function renderClanDetail() {
    const clan = getClan(ui.currentClanId);
    if (!clan) { switchView('dashboard'); return; }

    const ranked = sortedClans();
    const rank   = ranked.findIndex(c => c.id === clan.id) + 1;
    const total  = clanTotal(clan);

    // Clan avg/hr
    let hours = warHoursElapsed();
    if (hours === 0) {
        const snaps  = clan.snapshots || [];
        const oldest = snaps.length ? Math.min(...snaps.map(s => s.ts)) : Date.now();
        hours = Math.max(1, (Date.now() - oldest) / 3_600_000);
    }
    const avgHr = Math.round(total / hours);

    // Clan delta since last refresh
    const prevSnap = clan.prevSnapshot || null;
    let delta = null;
    if (prevSnap && clan.players.length) {
        delta = clan.players.reduce((sum, p) => {
            const prev = prevSnap.pts?.[p.userId] ?? null;
            return sum + (prev !== null ? Math.max(0, p.points - prev) : 0);
        }, 0);
    }
    const snapAgeMin = prevSnap ? Math.round((Date.now() - prevSnap.ts) / 60000) : null;
    const ageLabel   = snapAgeMin !== null
        ? (snapAgeMin >= 60 ? `${Math.round(snapAgeMin / 60)}hr` : `${snapAgeMin}m`) + ' ago'
        : '';
    const deltaText  = delta !== null
        ? `+${fmt(delta)}${ageLabel ? ' (' + ageLabel + ')' : ''}`
        : '—';

    // Clan pts/5min: project from since-refresh rate if available, else from avg/hr
    const detailSnapAge = prevSnap ? Math.max(1, Math.round((Date.now() - prevSnap.ts) / 60000)) : null;
    let clan5min;
    if (delta !== null && detailSnapAge > 0) {
        clan5min = Math.round(delta / detailSnapAge * 5);
    } else {
        clan5min = Math.round(avgHr / 12);
    }
    const delta5mText = fmt(clan5min) + '/5m';

    // DC count for header (only when snapshot is 90s–4min old)
    const headerSnapAgeSec = prevSnap ? Math.round((Date.now() - prevSnap.ts) / 1000) : null;
    const canShowDC        = headerSnapAgeSec !== null && headerSnapAgeSec >= 90 && headerSnapAgeSec <= 240;
    const dcCount          = canShowDC
        ? clan.players.filter(p => {
            const prev = prevSnap.pts?.[p.userId];
            return prev !== undefined && p.points - prev === 0;
          }).length
        : 0;
    const playersDisplay = dcCount > 0 ? `${clan.players.length} (${dcCount} 💤)` : `${clan.players.length}`;

    // Header
    const setEl = (id, val, color) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = val;
        if (color) el.style.color = color;
    };
    document.getElementById('clan-detail-color-bar').style.background = clan.color;
    setEl('clan-detail-name',    clan.name);
    setEl('clan-detail-tag',     clan.tag || '');
    setEl('clan-detail-points',  fmt(total));
    setEl('clan-detail-players', playersDisplay);
    setEl('clan-detail-rank',    `#${rank}`);
    setEl('clan-detail-avg',     fmt(avgHr) + '/hr',  '#f59e0b');
    setEl('clan-detail-delta',   deltaText,            '#10b981');
    setEl('clan-detail-delta5m', delta5mText,          '#22d3ee');

    renderPlayersTable(clan);
}

function renderPlayersTable(clan) {
    const search   = (document.getElementById('player-search').value || '').toLowerCase();
    const sortMode = document.getElementById('sort-select').value;
    const total    = clanTotal(clan);

    let players = [...clan.players];

    // Filter
    if (search) players = players.filter(p => p.username.toLowerCase().includes(search));

    // Sort
    switch (sortMode) {
        case 'points-asc':       players.sort((a,b) => a.points - b.points); break;
        case 'name-asc':         players.sort((a,b) => a.username.localeCompare(b.username)); break;
        case 'contribution-desc':
        case 'points-desc':
        default:                 players.sort((a,b) => b.points - a.points); break;
    }

    const tbody = document.getElementById('players-tbody');

    if (players.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="3" style="text-align:center;padding:40px;color:var(--text-muted)">
              ${search ? 'No players match your search.' : 'No players yet.'}
            </td>
          </tr>`;
        return;
    }

    const now  = Date.now();

    // Hours elapsed: prefer war startDate, fall back to oldest clan snapshot
    let hours = warHoursElapsed();
    if (hours === 0) {
        const snaps = clan.snapshots || [];
        const oldest = snaps.length ? Math.min(...snaps.map(s => s.ts)) : now;
        hours = Math.max(1, (now - oldest) / 3_600_000);
    }

    // Use previous refresh snapshot for delta (available after 2nd import)
    const snap = clan.prevSnapshot || null;
    const snapAgeMin = snap ? Math.max(1, Math.round((now - snap.ts) / 60000)) : null;
    const ageLabel   = snapAgeMin !== null
        ? (snapAgeMin >= 60 ? `${Math.round(snapAgeMin / 60)}hr` : `${snapAgeMin}m`) + ' ago'
        : '';

    tbody.innerHTML = players.map((p, idx) => {
        const ptsPerHr = p.points / hours;

        // Points gained since previous refresh
        const prevPts = snap?.pts?.[p.userId] ?? null;
        const delta1h = prevPts !== null ? Math.max(0, p.points - prevPts) : null;

        // Pts/5min: project from since-refresh rate if available, else from avg/hr
        let pts5min;
        if (delta1h !== null && snapAgeMin > 0) {
            pts5min = Math.round(delta1h / snapAgeMin * 5);
        } else {
            pts5min = Math.round(ptsPerHr / 12);
        }

        // Disconnect detection: snapshot 90s–4min old + 0 points gained = likely DC
        const snapAgeSec = snap ? Math.round((now - snap.ts) / 1000) : null;
        const isDC       = snapAgeSec !== null && snapAgeSec >= 90 && snapAgeSec <= 240 && delta1h === 0;

        const SEP = `<span style="color:#6b7280;margin:0 5px">·</span>`;
        const avgSpan   = `<span style="color:#f59e0b;font-size:12px;font-weight:700">${fmt(Math.round(ptsPerHr))}/hr</span>`;
        const deltaSpan = delta1h !== null
            ? `${SEP}<span style="color:#10b981;font-size:12px;font-weight:700">+${fmt(delta1h)}${ageLabel ? ' (' + ageLabel + ')' : ''}</span>`
            : '';
        const pts5Span  = `${SEP}<span style="color:#22d3ee;font-size:12px;font-weight:700">${fmt(pts5min)}/5m</span>`;
        const dcBadge   = isDC
            ? `<span style="color:#ef4444;font-size:10px;font-weight:700;background:rgba(239,68,68,.15);padding:1px 5px;border-radius:3px;margin-left:6px">💤 DC?</span>`
            : '';

        return `
          <tr${isDC ? ' style="opacity:.65"' : ''}>
            <td class="player-rank">${idx + 1}</td>
            <td class="player-name">
              <div>${esc(p.username)} <span class="role-badge ${getRoleClass(p.role)}">${esc(p.role || 'Member')}</span>${dcBadge}</div>
              <div class="player-sub">${avgSpan}${deltaSpan}${pts5Span}</div>
            </td>
            <td class="player-points" style="color:${isDC ? '#ef4444' : clan.color}">${fmt(p.points)}</td>
          </tr>`;
    }).join('');
}

// ── Player Modal ───────────────────────────
function openAddPlayer() {
    ui.editingPlayerId = null;
    document.getElementById('modal-title').textContent  = 'Add Player';
    document.getElementById('modal-submit').textContent = 'Add Player';
    document.getElementById('player-username').value    = '';
    document.getElementById('player-points').value      = '';
    document.getElementById('player-role').value        = 'Member';
    document.getElementById('modal-overlay').classList.add('active');
    document.getElementById('player-username').focus();
}

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('active');
    ui.editingPlayerId = null;
}

// ── Compare ────────────────────────────────
function renderCompareInit() {
    const ranked  = sortedClans();
    const options = ranked.map(c => `<option value="${c.id}">${esc(c.name)}${c.tag ? ' ' + esc(c.tag) : ''}</option>`).join('');

    document.getElementById('compare-clan-1').innerHTML = options;
    document.getElementById('compare-clan-2').innerHTML = options;

    if (ranked.length >= 2) {
        document.getElementById('compare-clan-2').value = ranked[1].id;
    }

    document.getElementById('compare-results').innerHTML = '';
}

function doCompare() {
    const id1 = document.getElementById('compare-clan-1').value;
    const id2 = document.getElementById('compare-clan-2').value;

    if (!id1 || !id2) { toast('Select two clans to compare', 'error'); return; }
    if (id1 === id2)   { toast('Select two different clans', 'error'); return; }

    const c1 = getClan(id1);
    const c2 = getClan(id2);
    if (!c1 || !c2) return;

    const t1 = clanTotal(c1);
    const t2 = clanTotal(c2);

    document.getElementById('compare-results').innerHTML =
        renderCompareSide(c1, t1, t2) + renderCompareSide(c2, t2, t1);
}

function renderCompareSide(clan, myTotal, theirTotal) {
    const isLeading = myTotal > theirTotal;
    const isTied    = myTotal === theirTotal && myTotal > 0;
    const diff      = myTotal - theirTotal;
    const diffFmt   = diff >= 0 ? `+${fmt(diff)}` : `−${fmt(Math.abs(diff))}`;
    const diffColor = diff >= 0 ? 'var(--success)' : 'var(--danger)';
    const avg       = clan.players.length ? Math.round(myTotal / clan.players.length) : 0;
    const topTotal  = myTotal || 1;

    const players = [...clan.players].sort((a, b) => b.points - a.points);

    const playerRows = players.slice(0, 15).map((p, idx) => {
        const pct = myTotal > 0 ? ((p.points / myTotal) * 100).toFixed(1) : '0.0';
        const barW = myTotal > 0 ? Math.round((p.points / myTotal) * 100) : 0;
        return `
          <div class="compare-player-row">
            <span class="cpr-rank">${idx + 1}</span>
            <span class="cpr-name" title="${esc(p.username)}">${esc(p.username)}</span>
            <div style="flex:1;padding:0 8px">
              <div class="mini-bar" style="width:100%;max-width:80px">
                <div class="mini-bar-fill" style="width:${barW}%;background:${clan.color}"></div>
              </div>
            </div>
            <span class="cpr-pts" style="color:${clan.color}">${fmt(p.points)}</span>
            <span class="cpr-pct">${pct}%</span>
          </div>`;
    }).join('');

    const moreRow = players.length > 15
        ? `<div class="compare-more">+${players.length - 15} more players</div>`
        : '';

    const emptyRow = players.length === 0
        ? `<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px">No players added yet</div>`
        : '';

    // Leading indicator
    let leadHtml = '';
    if (isTied)         leadHtml = '<span class="winner-badge">🤝 Tied</span>';
    else if (isLeading) leadHtml = '<span class="winner-badge">👑 Leading</span>';

    // Progress bar vs opponent
    const vsMax  = Math.max(myTotal, theirTotal) || 1;
    const vsPct  = Math.round((myTotal / vsMax) * 100);

    return `
      <div class="compare-clan-card" style="border-top:4px solid ${clan.color}">
        <div class="compare-clan-header">
          <h3 style="color:${clan.color}">${esc(clan.name)} ${leadHtml}</h3>
          ${clan.tag ? `<div class="sub">${esc(clan.tag)}</div>` : ''}
        </div>
        <div class="compare-summary">
          <div class="compare-stat">
            <div class="compare-stat-value" style="color:${clan.color}">${fmt(myTotal)}</div>
            <div class="compare-stat-label">Total Pts</div>
          </div>
          <div class="compare-stat">
            <div class="compare-stat-value">${clan.players.length}</div>
            <div class="compare-stat-label">Players</div>
          </div>
          <div class="compare-stat">
            <div class="compare-stat-value" style="color:${diffColor}">${diffFmt}</div>
            <div class="compare-stat-label">vs Opponent</div>
          </div>
        </div>
        <div class="compare-bar-row">
          <div class="compare-bar-label">
            <span>Relative score</span>
            <strong>${vsPct}%</strong>
          </div>
          <div class="progress-bar" style="height:8px">
            <div class="progress-fill" style="width:${vsPct}%;background:${clan.color}"></div>
          </div>
        </div>
        <div class="compare-players">
          ${playerRows}
          ${moreRow}
          ${emptyRow}
        </div>
      </div>`;
}

// ── Manage View ────────────────────────────
function renderManage() {
    const { war } = state;
    document.getElementById('war-name').value  = war.name  || '';
    document.getElementById('war-start').value = war.startDate || '';
    document.getElementById('war-end').value   = war.endDate   || '';

    // Color swatches
    const colorContainer = document.getElementById('color-options');
    colorContainer.innerHTML = PALETTE.map((color, idx) => `
      <div class="color-swatch ${idx === state.nextColorIdx ? 'selected' : ''}"
           style="background:${color}"
           onclick="selectColor(${idx})"
           title="${color}"></div>
    `).join('');

    // Clans list
    const ranked  = sortedClans();
    const listEl  = document.getElementById('manage-clans-list');
    document.getElementById('clan-count-badge').textContent = ranked.length;

    if (ranked.length === 0) {
        listEl.innerHTML = `<div style="color:var(--text-muted);text-align:center;padding:24px;font-size:13px">
          No clans added. Use the form above to add one.
        </div>`;
        return;
    }

    listEl.innerHTML = ranked.map((clan, idx) => {
        const total = clanTotal(clan);
        return `
          <div class="manage-clan-row">
            <div class="clan-color-dot" style="background:${clan.color}"></div>
            <span class="mcr-rank">#${idx + 1}</span>
            <span class="mcr-name">
              ${esc(clan.name)}
              ${clan.tag ? `<span class="mcr-tag">${esc(clan.tag)}</span>` : ''}
            </span>
            <span class="mcr-pts">${fmt(total)}</span>
            <span class="mcr-count">${clan.players.length} players</span>
            <button class="btn-icon" onclick="showClanDetail('${clan.id}')" title="Manage players">👥</button>
            <button class="btn-icon del" onclick="deleteClan('${clan.id}')" title="Delete clan">🗑️</button>
          </div>`;
    }).join('');
}

function selectColor(idx) {
    state.nextColorIdx = idx;
    document.querySelectorAll('.color-swatch').forEach((sw, i) => {
        sw.classList.toggle('selected', i === idx);
    });
}

function deleteClan(clanId) {
    const clan = getClan(clanId);
    if (!clan) return;
    confirm(
        'Delete Clan',
        `Delete "${clan.name}" and all its player data? This cannot be undone.`,
        () => {
            state.clans = state.clans.filter(c => c.id !== clanId);
            save();
            renderManage();
            toast(`"${clan.name}" deleted`);
        }
    );
}

// ── Live PS99 API ──────────────────────────

function setImportStatus(msg, type = '') {
    const el = document.getElementById('import-status');
    if (!el) return;
    el.className = `import-status ${type}`;
    el.innerHTML = type === 'loading'
        ? `<span class="spinner"></span>${msg}`
        : msg;
}

function setLiveBtnsDisabled(disabled) {
    const ids = ['fetch-active-battle-btn', 'fetch-clan-btn'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = disabled;
    });
}

async function apiFetch(path) {
    const url = `${API_BASE}${path}`;
    // Returns true if the parsed JSON looks like real API data (not a proxy error wrapper)
    const isValid = d => d && typeof d === 'object' && !d.error && !d.Error
        && !(typeof d.message === 'string' && d.message.toLowerCase().includes('timeout'));

    // 1. Try direct
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (res.ok) { const d = await res.json(); if (isValid(d)) return d; }
    } catch (_) {}
    // 2. Try each CORS proxy in order
    for (const proxy of CORS_PROXIES) {
        try {
            const res = await fetch(proxy + encodeURIComponent(url), {
                signal: AbortSignal.timeout(20000)
            });
            if (res.ok) { const d = await res.json(); if (isValid(d)) return d; }
        } catch (_) {}
    }
    throw new Error('API unavailable – check connection or try again later');
}

// Resolve Roblox UserIDs → usernames in batches of 100
async function resolveUsernames(userIds) {
    if (!userIds.length) return {};
    const map = {};
    const ROBLOX_URL = 'https://users.roblox.com/v1/users';

    for (let i = 0; i < userIds.length; i += 100) {
        const batch = userIds.slice(i, i + 100)
            .map(id => Number(id))
            .filter(id => id > 0);
        if (!batch.length) continue;

        const body    = JSON.stringify({ userIds: batch, excludeBannedUsers: false });
        const headers = { 'Content-Type': 'application/json' };

        let parsed = null;

        // 1. Try direct (works if Roblox allows the origin)
        try {
            const res = await fetch(ROBLOX_URL, {
                method: 'POST', headers, body,
                signal: AbortSignal.timeout(8000),
            });
            if (res.ok) parsed = await res.json();
        } catch (_) {}

        // 2. Fallback via each CORS proxy
        for (const proxy of CORS_PROXIES) {
            if (parsed) break;
            try {
                const res = await fetch(`${proxy}${encodeURIComponent(ROBLOX_URL)}`, {
                    method: 'POST', headers, body,
                    signal: AbortSignal.timeout(12000),
                });
                if (res.ok) parsed = await res.json();
            } catch (_) {}
        }

        if (parsed) {
            (parsed.data || []).forEach(u => {
                map[u.id]         = u.name;
                map[String(u.id)] = u.name;
            });
        }
    }
    return map;
}

function permToRole(level) {
    if (level >= 255) return 'Leader';
    if (level >= 200) return 'Co-Leader';
    if (level >= 90)  return 'Officer';
    return 'Member';
}

async function importClanByName(clanName, battleTotal = 0) {
    setImportStatus(`Fetching clan "${clanName}"…`, 'loading');

    const raw = await apiFetch(`/clan/${encodeURIComponent(clanName)}`);
    if (raw.status !== 'ok' || !raw.data) throw new Error(`Clan "${clanName}" not found`);

    const clanData = raw.data;

    // The API stores current battle data in clanData.Battles (not Contribution)
    // Contribution is only populated after a battle ends.
    const battleId  = state.war.battleId || '';
    const battles   = clanData.Battles   || {};
    const contrib   = clanData.Contribution || {};

    // Normalize any value (array or object) into [{UserID, Points}]
    function normalizeContrib(val) {
        if (!val) return [];
        if (Array.isArray(val)) return val;
        if (typeof val === 'object') {
            return Object.entries(val).map(([uid, v]) => ({
                UserID: Number(uid),
                Points: typeof v === 'object'
                    ? (v.Points ?? v.points ?? v.Damage ?? v.damage ?? v.Score ?? v.score ?? 0)
                    : Number(v),
            }));
        }
        return [];
    }

    // Normalize and filter out null-UserID entries (historical battles strip UserIDs)
    function validContrib(val) {
        return normalizeContrib(val).filter(c => {
            const id = Number(c.UserID ?? c.userId ?? c.id ?? 0);
            return id > 0;
        });
    }

    // The current battle data is at battles[lastBattleKey].PointContributions
    const battleKeys    = Object.keys(battles);
    const lastBattleKey = battleKeys[battleKeys.length - 1]; // most recently added = current battle
    const activeBattleId = lastBattleKey || battleId;
    if (activeBattleId) state.war.battleId = activeBattleId;

    // battles[key] is an object with: PointContributions(arr), Points(number), Place(number), etc.
    const battleObj  = battles[activeBattleId] || battles[battleId] || {};
    const battleArr  = battleObj.PointContributions || battleObj.pointContributions
                    || validContrib(contrib[activeBattleId]) || [];
    const usedKey    = activeBattleId;

    // If the API already gives us the clan's total battle points, use it
    if (battleObj.Points && battleObj.Points > (battleTotal || 0)) {
        battleTotal = battleObj.Points;
    }

    const battlePoints = {};
    battleArr.forEach(c => {
        const id  = String(c.UserID ?? c.userId ?? c.Id ?? c.ID ?? c.id ?? '');
        const pts = c.Points ?? c.points ?? c.Damage ?? c.damage ?? c.Score ?? c.score ?? 0;
        if (id && id !== '0' && id !== 'null') battlePoints[id] = pts;
    });

    let members = clanData.Members || clanData.members || [];

    // Owner is sometimes not in the Members array — add them if missing
    const ownerID = clanData.Owner ?? clanData.owner;
    if (ownerID && Number(ownerID) > 0) {
        const alreadyIn = members.some(m => String(m.UserID ?? m.userId ?? m.id) === String(ownerID));
        if (!alreadyIn) {
            members = [{ UserID: ownerID, PermissionLevel: 255 }, ...members];
        }
    }

    // Only keep members with a valid numeric UserID > 0
    const validMembers = members.filter(m => {
        const id = Number(m.UserID ?? m.userId ?? m.id);
        return id > 0;
    });

    const allIds = validMembers.map(m => m.UserID ?? m.userId ?? m.id);

    setImportStatus(`Resolving ${allIds.length} usernames for ${clanName}…`, 'loading');
    const usernameMap = await resolveUsernames(allIds);

    const players = validMembers.map(m => {
        const memberId = m.UserID ?? m.userId ?? m.id;
        return {
            id:       uid(),
            username: usernameMap[memberId] || usernameMap[String(memberId)] || `User_${memberId}`,
            points:   battlePoints[String(memberId)] ?? battlePoints[String(Number(memberId))] ?? 0,
            role:     permToRole(m.PermissionLevel ?? m.permissionLevel ?? 0),
            userId:   String(memberId),
        };
    });

    const playerSum     = players.reduce((s, p) => s + p.points, 0);
    const resolvedTotal = Math.max(playerSum, battleTotal);

    // Snapshot: record current points by userId so we can compute delta on next refresh
    const now      = Date.now();
    const snapshot = { ts: now, pts: {} };
    players.forEach(p => { snapshot.pts[p.userId] = p.points; });

    const existing = state.clans.find(c => c.name.toLowerCase() === clanName.toLowerCase());
    if (existing) {
        // Capture the most recent previous snapshot BEFORE adding the new one
        const prevSnap = existing.snapshots?.length
            ? existing.snapshots[existing.snapshots.length - 1]
            : null;
        existing.prevSnapshot = prevSnap;

        if (!existing.snapshots) existing.snapshots = [];
        existing.snapshots.push(snapshot);
        existing.snapshots = existing.snapshots.filter(s => now - s.ts < 25 * 3_600_000);
        existing.players     = players;
        existing.battleTotal = resolvedTotal;
    } else {
        const color = PALETTE[state.nextColorIdx % PALETTE.length];
        state.nextColorIdx = (state.nextColorIdx + 1) % PALETTE.length;
        state.clans.push({
            id: uid(), name: clanData.Name || clanName,
            tag: '', color, players, battleTotal: resolvedTotal,
            snapshots: [snapshot], prevSnapshot: null,
        });
    }

    save();
    return clanData.Name || clanName;
}

async function loadBattleData({ silent = false } = {}) {
    if (!silent) renderDashboardLoading();

    const refreshBtn = document.getElementById('dashboard-refresh-btn');
    if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = '⏳ Loading…'; }

    try {
        // 1. Battle config → optional, don't fail if missing
        let cfgData = {};
        try {
            const battleCfg = await apiFetch('/activeClanBattle');
            cfgData = battleCfg?.data?.configData || battleCfg?.data || {};
        } catch (_) {}
        const startTime = cfgData.StartTime  ? new Date(cfgData.StartTime  * 1000) : null;
        const endTime   = cfgData.FinishTime ? new Date(cfgData.FinishTime * 1000) : null;

        // 2. Top clans — page2 is optional; normalise response to flat array
        const toArr = d => Array.isArray(d) ? d : (Array.isArray(d?.data) ? d.data : []);
        const page1 = await apiFetch('/clans?page=1&pageSize=100&sort=Points&sortOrder=desc');
        let page2data = [];
        try {
            const p2 = await apiFetch('/clans?page=2&pageSize=100&sort=Points&sortOrder=desc');
            page2data = toArr(p2?.data);
        } catch (_) {}
        const clanList = [...toArr(page1?.data), ...page2data];
        if (!clanList.length) throw new Error('No clan data returned');

        // 3. Rebuild state — preserve existing clan snapshots/players
        const oldClans        = state.clans;
        state.clans           = [];
        state.nextColorIdx    = 0;
        state.war.name        = cfgData.Title || 'PS99 Clan Battle';
        state.war.battleId    = cfgData._id   || cfgData.Title || '';
        state.war.lastFetched = Date.now();
        state.war.startDate   = startTime ? startTime.toISOString().split('T')[0] : '';
        state.war.endDate     = endTime   ? endTime.toISOString().split('T')[0]   : '';

        clanList.forEach((entry, idx) => {
            const name   = entry.Name || entry.name || `Clan_${idx}`;
            const points = entry.Points || entry.points || 0;
            const old    = oldClans.find(c => c.name.toLowerCase() === name.toLowerCase());
            const color  = old?.color || PALETTE[state.nextColorIdx % PALETTE.length];
            if (!old) state.nextColorIdx++;
            state.clans.push({
                id:           old?.id           || uid(),
                name,
                tag:          old?.tag          || '',
                color,
                battleTotal:  points,
                players:      old?.players      || [],
                snapshots:    old?.snapshots    || [],
                prevSnapshot: old?.prevSnapshot || null,
            });
        });

        save();
        renderDashboard();
        if (!silent) toast(`Loaded top ${clanList.length} clans`, 'success');
        setImportStatus(`✅ Loaded ${clanList.length} clans!`, 'success');

    } catch (err) {
        if (!silent) { renderDashboard(); toast(err.message, 'error'); }
        setImportStatus(`❌ ${err.message}`, 'error');
    } finally {
        if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = '🔄 Refresh'; }
    }
}

// kept for the Manage War button
async function fetchActiveBattle() {
    setLiveBtnsDisabled(true);
    try {
        await loadBattleData({ silent: false });
        renderManage();
    } finally {
        setLiveBtnsDisabled(false);
    }
}

async function fetchSingleClan() {
    const input = document.getElementById('fetch-clan-name');
    const name  = (input?.value || '').trim();
    if (!name) { toast('Enter a clan name', 'error'); return; }

    setLiveBtnsDisabled(true);
    try {
        const imported = await importClanByName(name);
        input.value = '';
        renderManage();
        renderDashboard();
        setImportStatus(`✅ "${imported}" imported successfully!`, 'success');
        toast(`"${imported}" imported`, 'success');
    } catch (err) {
        setImportStatus(`❌ ${err.message}`, 'error');
        toast(err.message, 'error');
    } finally {
        setLiveBtnsDisabled(false);
    }
}

async function refreshClan(clanId) {
    const clan = getClan(clanId);
    if (!clan) return;
    try {
        await importClanByName(clan.name);
        renderDashboard();
        if (ui.currentClanId === clanId) renderClanDetail();
        toast(`"${clan.name}" refreshed`, 'success');
    } catch (err) {
        toast(err.message, 'error');
    }
}

// Fast refresh: update points only (no username re-resolution) — used by auto-refresh
async function fastRefreshClan(clanId) {
    const clan = getClan(clanId);
    if (!clan || !clan.players.length) return;

    const raw = await apiFetch(`/clan/${encodeURIComponent(clan.name)}`);
    if (raw.status !== 'ok' || !raw.data) return;

    const clanData = raw.data;
    const battles  = clanData.Battles    || {};
    const contrib  = clanData.Contribution || {};

    // Mirror importClanByName: last key = current battle, fall back to stored battleId
    const battleKeys     = Object.keys(battles);
    const lastBattleKey  = battleKeys[battleKeys.length - 1];
    const activeBattleId = lastBattleKey || state.war.battleId || '';
    if (activeBattleId) state.war.battleId = activeBattleId;

    const battleObj = battles[activeBattleId] || {};

    function normalizeContrib(val) {
        if (!val) return [];
        if (Array.isArray(val)) return val;
        if (typeof val === 'object') {
            return Object.entries(val).map(([uid, v]) => ({
                UserID: Number(uid),
                Points: typeof v === 'object'
                    ? (v.Points ?? v.points ?? v.Damage ?? v.damage ?? v.Score ?? v.score ?? 0)
                    : Number(v),
            }));
        }
        return [];
    }
    function validContrib(val) {
        return normalizeContrib(val).filter(c => Number(c.UserID ?? c.userId ?? c.id ?? 0) > 0);
    }

    const arr = battleObj.PointContributions || battleObj.pointContributions
             || validContrib(contrib[activeBattleId]) || [];

    const bpts = {};
    arr.forEach(c => {
        const id  = String(c.UserID ?? c.userId ?? c.Id ?? c.ID ?? c.id ?? '');
        const pts = c.Points ?? c.points ?? c.Damage ?? c.damage ?? c.Score ?? c.score ?? 0;
        if (id && id !== '0' && id !== 'null') bpts[id] = pts;
    });

    // Don't take a snapshot if we got no point data — would corrupt delta tracking
    if (!Object.keys(bpts).length) return;

    const now  = Date.now();
    const snap = { ts: now, pts: {} };
    clan.players.forEach(p => {
        const newPts       = bpts[p.userId] ?? bpts[String(Number(p.userId))] ?? p.points;
        p.points           = newPts;
        snap.pts[p.userId] = newPts;
    });

    // Always update battleTotal from API (not just when higher, so decreases are reflected too)
    if (battleObj.Points != null) clan.battleTotal = Number(battleObj.Points);

    const prev = clan.snapshots?.length ? clan.snapshots[clan.snapshots.length - 1] : null;
    clan.prevSnapshot = prev;
    if (!clan.snapshots) clan.snapshots = [];
    clan.snapshots.push(snap);
    clan.snapshots = clan.snapshots.filter(s => now - s.ts < 25 * 3_600_000);

    save();
}

// ── Event Listeners ────────────────────────

// Nav
document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// Back button
document.getElementById('back-btn').addEventListener('click', () => switchView('dashboard'));

// Clan detail refresh button
document.getElementById('detail-refresh-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('detail-refresh-btn');
    if (!ui.currentClanId) return;
    btn.disabled = true;
    btn.textContent = '⏳ Refreshing…';
    try {
        await fastRefreshClan(ui.currentClanId);
        renderClanDetail();
        toast('Points refreshed', 'success');
    } catch (err) {
        toast(err.message || 'Refresh failed', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '🔄 Refresh';
    }
});

// Player search & sort (live filter)
document.getElementById('player-search').addEventListener('input', () => {
    const clan = getClan(ui.currentClanId);
    if (clan) renderPlayersTable(clan);
});
document.getElementById('sort-select').addEventListener('change', () => {
    const clan = getClan(ui.currentClanId);
    if (clan) renderPlayersTable(clan);
});

// Player form submit (add only)
document.getElementById('player-form').addEventListener('submit', e => {
    e.preventDefault();

    const username = document.getElementById('player-username').value.trim();
    const points   = Number(document.getElementById('player-points').value) || 0;
    const role     = document.getElementById('player-role').value;

    if (!username) { toast('Enter a username', 'error'); return; }

    const clan = getClan(ui.currentClanId);
    if (!clan) return;

    clan.players.push({ id: uid(), username, points, role });
    toast('Player added');

    save();
    closeModal();
    renderClanDetail();
});

// Modal close
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
});

// Confirm dialog
document.getElementById('confirm-cancel').addEventListener('click', () => {
    document.getElementById('confirm-overlay').classList.remove('active');
    ui.confirmCallback = null;
});
document.getElementById('confirm-ok').addEventListener('click', () => {
    document.getElementById('confirm-overlay').classList.remove('active');
    if (ui.confirmCallback) { ui.confirmCallback(); ui.confirmCallback = null; }
});
document.getElementById('confirm-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('confirm-overlay')) {
        document.getElementById('confirm-overlay').classList.remove('active');
        ui.confirmCallback = null;
    }
});

// War form
document.getElementById('war-form').addEventListener('submit', e => {
    e.preventDefault();
    state.war.name      = document.getElementById('war-name').value.trim()  || 'War';
    state.war.startDate = document.getElementById('war-start').value;
    state.war.endDate   = document.getElementById('war-end').value;
    save();
    toast('War info saved');
});

// Add clan form
document.getElementById('add-clan-form').addEventListener('submit', e => {
    e.preventDefault();
    const name = document.getElementById('new-clan-name').value.trim();
    if (!name) { toast('Enter a clan name', 'error'); return; }

    const color = PALETTE[state.nextColorIdx % PALETTE.length];
    state.clans.push({
        id: uid(),
        name,
        tag:     document.getElementById('new-clan-tag').value.trim(),
        color,
        players: [],
    });

    // Advance to next unused color
    state.nextColorIdx = (state.nextColorIdx + 1) % PALETTE.length;

    document.getElementById('new-clan-name').value = '';
    document.getElementById('new-clan-tag').value  = '';

    save();
    renderManage();
    toast(`"${name}" added`);
});

// Compare button
document.getElementById('do-compare-btn').addEventListener('click', doCompare);

// Live data buttons
document.getElementById('fetch-active-battle-btn')?.addEventListener('click', fetchActiveBattle);
document.getElementById('fetch-clan-btn')?.addEventListener('click', fetchSingleClan);
document.getElementById('fetch-clan-name')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') fetchSingleClan();
});

// Refresh button on dashboard
document.getElementById('dashboard-refresh-btn')?.addEventListener('click', () => {
    loadBattleData({ silent: false });
});

// ── Auto-Refresh ───────────────────────────
// Every 2 minutes: fast-refresh the current clan (DC detection) + silent dashboard update
setInterval(async () => {
    try {
        if (ui.currentClanId) {
            await fastRefreshClan(ui.currentClanId);
            renderClanDetail();
        }
    } catch (_) {}
    try { await loadBattleData({ silent: true }); } catch (_) {}
}, 120_000);

// ── Monitor ────────────────────────────────

const MONITOR_KEY = 'ps99_monitor_v1';

let monitorState = {
    webhook:           '',
    intervalSec:       45,
    privateServerLink: '',
    players:           [],
};

let monitorRunning = false;
let monitorTimer   = null;
let monitorLog     = [];

function saveMonitor() {
    try { localStorage.setItem(MONITOR_KEY, JSON.stringify(monitorState)); } catch (_) {}
}

function loadMonitor() {
    try {
        const raw = localStorage.getItem(MONITOR_KEY);
        if (raw) {
            const saved = JSON.parse(raw);
            monitorState = { ...monitorState, ...saved };
            monitorState.players.forEach(p => { p.status = 'unknown'; p.lastChecked = null; });
        }
    } catch (_) {}
}

function getStatusInfo(status) {
    switch (status) {
        case 'inServer':     return { cls: 'ms-ingame',       label: 'In PS99' };
        case 'online':       return { cls: 'ms-online',       label: 'Online' };
        case 'offline':      return { cls: 'ms-offline',      label: 'Offline' };
        case 'disconnected': return { cls: 'ms-disconnected', label: 'Inactive!' };
        default:             return { cls: 'ms-unknown',      label: 'Unknown' };
    }
}

function renderMonitor() {
    document.getElementById('mon-webhook').value  = monitorState.webhook           || '';
    document.getElementById('mon-interval').value = monitorState.intervalSec       || 45;
    document.getElementById('mon-ps-link').value  = monitorState.privateServerLink || '';
    const cs = document.getElementById('mon-clan-status');
    if (cs && state.clans.length) {
        const total = state.clans.reduce((s, c) => s + c.players.length, 0);
        cs.textContent = `${state.clans.length} clans, ${total} players`;
    }
    renderMonitorPlayers();
    renderMonitorLog();
    updateMonitorBtn();
}

function renderMonitorPlayers() {
    const list = document.getElementById('mon-players-list');
    if (!list) return;
    document.getElementById('mon-player-count').textContent = monitorState.players.length;

    if (monitorState.players.length === 0) {
        list.innerHTML = '<div class="mon-empty">No players added yet.</div>';
        return;
    }

    list.innerHTML = monitorState.players.map(p => {
        const si          = getStatusInfo(p.status);
        const lastChecked = p.lastChecked ? new Date(p.lastChecked).toLocaleTimeString() : '—';
        const name        = esc(p.username);
        const pts         = p.lastKnownPoints !== null && p.lastKnownPoints !== undefined
            ? `<span class="mon-pts">${Number(p.lastKnownPoints).toLocaleString()} pts</span>` : '';
        return `
          <div class="mon-player-row" id="mon-row-${p.id}">
            <span class="mon-dot ${si.cls}"></span>
            <div class="mon-player-info">
              <span class="mon-player-name">${name}</span>${pts}
            </div>
            <span class="mon-badge ${si.cls}">${si.label}</span>
            <span class="mon-time">${lastChecked}</span>
            <button class="btn-icon del" onclick="removeMonitorPlayer('${p.id}')" title="Remove">🗑️</button>
          </div>`;
    }).join('');
}

function renderMonitorLog() {
    const el = document.getElementById('mon-log');
    if (!el) return;
    if (monitorLog.length === 0) {
        el.innerHTML = '<div class="mon-log-empty">No activity yet.</div>';
        return;
    }
    el.innerHTML = [...monitorLog].slice(-60).reverse().map(e => `
      <div class="mon-log-entry mon-log-${e.type}">
        <span class="mon-log-time">${e.time}</span>
        <span>${esc(e.msg)}</span>
      </div>`).join('');
}

function addLog(msg, type = 'info') {
    monitorLog.push({ time: new Date().toLocaleTimeString(), msg, type });
    if (monitorLog.length > 100) monitorLog.shift();
    renderMonitorLog();
}

function updateMonitorBtn() {
    const btn = document.getElementById('mon-toggle-btn');
    const ind = document.getElementById('mon-global-indicator');
    const txt = document.getElementById('mon-global-text');
    if (!btn) return;
    if (monitorRunning) {
        btn.textContent = '⏹ Stop Monitoring';
        btn.className   = 'btn-danger';
        if (ind) ind.className = 'mon-global-status mon-global-running';
        if (txt) txt.textContent = 'Monitoring';
    } else {
        btn.textContent = '▶ Start Monitoring';
        btn.className   = 'btn-primary';
        if (ind) ind.className = 'mon-global-status mon-global-idle';
        if (txt) txt.textContent = 'Idle';
    }
}

// ── Point-tracking helpers ──────────────────

function getPlayerPointsByUserId(userId) {
    const id = String(userId);
    for (const clan of state.clans) {
        const p = clan.players.find(p => String(p.userId) === id || String(p.id) === id);
        if (p) return p.points ?? 0;
    }
    return null;
}

async function refreshClanPoints() {
    if (!state.clans.length) return;
    const PROXIES = ['https://corsproxy.io/?url=', 'https://api.allorigins.win/raw?url='];
    for (const clan of state.clans) {
        for (const px of PROXIES) {
            try {
                const url = `https://biggamesapi.io/api/clan/${encodeURIComponent(clan.name)}?_=${Date.now()}`;
                const res = await fetch(px + encodeURIComponent(url), { cache: 'no-store', signal: AbortSignal.timeout(10000) });
                if (!res.ok) continue;
                const json = await res.json();
                const battles = json?.data?.Battles ?? {};
                const lastKey = Object.keys(battles).sort().pop();
                if (!lastKey) break;
                const contributions = battles[lastKey]?.PointContributions ?? [];
                const pts = {};
                contributions.forEach(c => {
                    const id = String(c.UserID ?? c.userId ?? c.id ?? '');
                    if (id && id !== '0') pts[id] = c.Points ?? c.points ?? 0;
                });
                clan.players.forEach(p => {
                    const v = pts[String(p.userId)] ?? pts[String(p.id)];
                    if (v !== undefined) p.points = v;
                });
                break;
            } catch (_) {}
        }
    }
}

async function loadClanDataForMonitoring() {
    const statusEl = document.getElementById('mon-clan-status');
    if (!state.clans.length) {
        if (statusEl) statusEl.textContent = 'No clans — add clans in Manage War first';
        toast('Add clans in Manage War first', 'error');
        return;
    }
    if (statusEl) statusEl.textContent = 'Refreshing…';
    await refreshClanPoints();
    const total = state.clans.reduce((s, c) => s + c.players.length, 0);
    if (statusEl) statusEl.textContent = `${state.clans.length} clans, ${total} players loaded`;
    addLog(`📋 Clan data loaded: ${state.clans.length} clans, ${total} players`, 'success');
    toast('Clan data loaded', 'success');
}

// ── Discord ────────────────────────────────

async function sendDiscordAlert(player) {
    if (!monitorState.webhook) return;
    const psLink   = monitorState.privateServerLink;
    const now      = Math.floor(Date.now() / 1000);
    const display  = player.username;
    const secSince = player.lastPointsChangeTime
        ? Math.round((Date.now() - player.lastPointsChangeTime) / 1000) : null;
    const inactDesc = secSince ? `No battle point increase for **${Math.round(secSince / 60)} minutes**.` : '';
    const fields = [
        { name: 'Player',      value: `**${display}**`, inline: true },
        { name: 'Last Points', value: player.lastKnownPoints != null ? Number(player.lastKnownPoints).toLocaleString() : 'N/A', inline: true },
        { name: 'Time',        value: `<t:${now}:T>`, inline: true },
    ];
    if (psLink) fields.push({ name: 'Rejoin', value: psLink, inline: false });

    try {
        await fetch(monitorState.webhook, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'PS99 Monitor',
                embeds: [{
                    title:       `⚠️ ${display} may have stopped playing!`,
                    description: `**${display}** has not gained battle points. ${inactDesc}`,
                    color:       0xEF4444,
                    fields,
                    footer:    { text: 'PS99 Clan Battle Tracker • Monitor' },
                    timestamp: new Date().toISOString(),
                }],
            }),
        });
    } catch (e) {
        addLog(`Discord failed: ${e.message}`, 'error');
    }
}

async function testWebhook() {
    const url = document.getElementById('mon-webhook').value.trim();
    if (!url) { toast('Enter a webhook URL first', 'error'); return; }
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'PS99 Monitor',
                embeds: [{ title: '✅ Webhook connected!', description: 'PS99 Monitor will send alerts here.', color: 0x10B981 }],
            }),
        });
        if (r.ok || r.status === 204) toast('Test message sent!', 'success');
        else toast(`Webhook error: ${r.status}`, 'error');
    } catch (e) {
        toast('Webhook failed: ' + e.message, 'error');
    }
}

// ── Monitor Loop ───────────────────────────

async function runMonitorCycle() {
    const players = monitorState.players.filter(p => p.userId);
    if (!players.length) return;

    try {
        await refreshClanPoints();

        // 5 minutes: biggamesapi.io updates every few minutes, shorter = false positives
        const inactiveMs = 5 * 60 * 1000;

        for (const player of players) {
            player.lastChecked = Date.now();

            const currentPoints = getPlayerPointsByUserId(player.userId);
            const hasPointData  = currentPoints !== null;
            const pointsIncreased = hasPointData &&
                                    player.lastKnownPoints != null &&
                                    currentPoints > player.lastKnownPoints;

            const isInactive = hasPointData &&
                                player.lastKnownPoints != null &&
                                !pointsIncreased &&
                                player.lastPointsChangeTime &&
                                (Date.now() - player.lastPointsChangeTime) > inactiveMs &&
                                !player.alertSent;

            if (isInactive) {
                const secSince = Math.round((Date.now() - player.lastPointsChangeTime) / 1000);
                player.status    = 'disconnected';
                player.alertSent = true;
                addLog(`⚠️ ${player.username}: no points for ${secSince}s — alert sent`, 'alert');
                await sendDiscordAlert(player);
                toast(`${player.username} — inactive for ${Math.round(secSince / 60)}min!`, 'error');
                setTimeout(() => { player.status = 'unknown'; renderMonitorPlayers(); }, 5000);
            }

            if (hasPointData) {
                if (player.lastKnownPoints == null) {
                    player.lastKnownPoints     = currentPoints;
                    player.lastPointsChangeTime = Date.now();
                    addLog(`📊 ${player.username}: tracking started at ${currentPoints.toLocaleString()} pts`, 'info');
                } else if (pointsIncreased) {
                    addLog(`📈 ${player.username}: ${Number(player.lastKnownPoints).toLocaleString()} → ${currentPoints.toLocaleString()} pts`, 'success');
                    player.lastKnownPoints     = currentPoints;
                    player.lastPointsChangeTime = Date.now();
                    player.alertSent = false;
                    if (player.status === 'disconnected') player.status = 'unknown';
                } else {
                    const secSince = Math.round((Date.now() - player.lastPointsChangeTime) / 1000);
                    addLog(`📊 ${player.username}: ${currentPoints.toLocaleString()} pts (no change ${secSince}s)`, 'info');
                }
            } else {
                addLog(`⚠️ No clan data for ${player.username} — click Load Clans`, 'error');
            }
        }

        saveMonitor();
        renderMonitorPlayers();
    } catch (e) {
        addLog(`Check failed: ${e.message}`, 'error');
    }
}

function startMonitoring() {
    if (!monitorState.players.length) { toast('Add players first', 'error'); return; }
    if (!monitorState.webhook)        { toast('Set a Discord webhook URL first', 'error'); return; }

    monitorState.players.forEach(p => {
        p.lastKnownPoints      = null;
        p.lastPointsChangeTime = null;
        p.alertSent            = false;
        p.status               = 'unknown';
    });

    monitorRunning = true;
    updateMonitorBtn();
    addLog('Monitoring started', 'success');
    runMonitorCycle();
    monitorTimer = setInterval(runMonitorCycle, (monitorState.intervalSec || 45) * 1000);
}

function stopMonitoring() {
    monitorRunning = false;
    clearInterval(monitorTimer);
    monitorTimer = null;
    updateMonitorBtn();
    addLog('Monitoring stopped', 'info');
    monitorState.players.forEach(p => { p.status = 'unknown'; });
    renderMonitorPlayers();
}

function toggleMonitoring() {
    if (monitorRunning) stopMonitoring();
    else                startMonitoring();
}

function removeMonitorPlayer(id) {
    monitorState.players = monitorState.players.filter(x => x.id !== id);
    saveMonitor();
    renderMonitorPlayers();
    if (!monitorState.players.length && monitorRunning) stopMonitoring();
}

async function checkNow() {
    if (!monitorRunning) { toast('Start monitoring first', 'error'); return; }
    addLog('Manual check triggered…', 'info');
    await runMonitorCycle();
}

async function testDisconnectAlert() {
    if (!monitorState.webhook) { toast('Set a Discord webhook URL first', 'error'); return; }
    if (!monitorState.players.length) { toast('Add a player first', 'error'); return; }
    const player = { ...monitorState.players[0], lastPointsChangeTime: Date.now() - 360000, lastKnownPoints: 12345 };
    addLog(`Sending test alert for ${player.username}…`, 'info');
    await sendDiscordAlert(player);
    toast('Test alert sent!', 'success');
}

function clearMonitorLog() {
    monitorLog = [];
    renderMonitorLog();
}

// ── Monitor Event Wiring ───────────────────

document.getElementById('mon-settings-form')?.addEventListener('submit', e => {
    e.preventDefault();
    monitorState.webhook           = document.getElementById('mon-webhook').value.trim();
    monitorState.intervalSec       = Number(document.getElementById('mon-interval').value) || 45;
    monitorState.privateServerLink = document.getElementById('mon-ps-link').value.trim();
    saveMonitor();
    toast('Settings saved');
    if (monitorRunning) {
        clearInterval(monitorTimer);
        monitorTimer = setInterval(runMonitorCycle, monitorState.intervalSec * 1000);
    }
});

document.getElementById('mon-add-form')?.addEventListener('submit', e => {
    e.preventDefault();
    const rawId    = document.getElementById('mon-add-userid').value.trim();
    const username = document.getElementById('mon-add-username').value.trim();
    if (!rawId || !username) return;
    if (!/^\d+$/.test(rawId)) { toast('User ID must be numbers only', 'error'); return; }
    const userId = Number(rawId);
    if (monitorState.players.some(p => p.userId === userId)) { toast('Already in list', 'error'); return; }

    monitorState.players.push({ id: uid(), userId, username, status: 'unknown', lastChecked: null });
    document.getElementById('mon-add-userid').value  = '';
    document.getElementById('mon-add-username').value = '';
    saveMonitor();
    renderMonitorPlayers();
    addLog(`Added ${username} (ID: ${userId})`, 'info');
    toast(`${username} added`);
});

// ── Bootstrap ──────────────────────────────
load();
loadMonitor();
// Show cached data instantly, then fetch fresh data in background
renderDashboard();
loadBattleData({ silent: state.clans.length > 0 });
