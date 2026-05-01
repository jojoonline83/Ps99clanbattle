/* ═══════════════════════════════════════════
   PS99 Clan Battle Tracker — App Logic
   ═══════════════════════════════════════════ */

'use strict';

// ── Constants ──────────────────────────────
const STORAGE_KEY = 'ps99_tracker_v1';

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
    war: { name: '', startDate: '', endDate: '' },
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
    n = Number(n) || 0;
    if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9)  return (n / 1e9).toFixed(2)  + 'B';
    if (n >= 1e6)  return (n / 1e6).toFixed(2)  + 'M';
    if (n >= 1e3)  return (n / 1e3).toFixed(1)  + 'K';
    return n.toLocaleString();
}

function clanTotal(clan) {
    return clan.players.reduce((s, p) => s + (p.points || 0), 0);
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
    renderClanDetail();
}

// ── Dashboard ──────────────────────────────
function renderDashboard() {
    const { war } = state;

    document.getElementById('current-war-title').textContent =
        war.name || 'No Active War';

    let dateStr = '';
    if (war.startDate && war.endDate) {
        const s = new Date(war.startDate + 'T00:00:00');
        const e = new Date(war.endDate   + 'T00:00:00');
        dateStr = `${s.toLocaleDateString('en-US',{month:'short',day:'numeric'})} – ${e.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`;
    }
    document.getElementById('current-war-dates').textContent = dateStr;

    // Status badge
    const badge = document.getElementById('war-status-badge');
    badge.innerHTML = '';
    if (war.startDate && war.endDate) {
        const now   = new Date();
        const start = new Date(war.startDate + 'T00:00:00');
        const end   = new Date(war.endDate   + 'T23:59:59');
        if (now < start) {
            badge.innerHTML = '<span class="status-pill status-upcoming">Upcoming</span>';
        } else if (now > end) {
            badge.innerHTML = '<span class="status-pill status-ended">Ended</span>';
        } else {
            badge.innerHTML = '<span class="status-pill status-active">⚡ Active</span>';
        }
    }

    const grid = document.getElementById('clans-grid');
    const ranked = sortedClans();

    if (ranked.length === 0) {
        grid.innerHTML = `
          <div class="empty-state" style="grid-column:1/-1">
            <div class="empty-state-icon">⚔️</div>
            <p>No clans added yet</p>
            <small>Go to <strong>Manage War</strong> to add clans and track points</small>
          </div>`;
        return;
    }

    const maxPts = clanTotal(ranked[0]) || 1;

    grid.innerHTML = ranked.map((clan, idx) => {
        const total     = clanTotal(clan);
        const pct       = Math.round((total / maxPts) * 100);
        const rankClass = idx === 0 ? 'rank-1' : idx === 1 ? 'rank-2' : idx === 2 ? 'rank-3' : 'rank-other';
        const topPlayer = [...clan.players].sort((a, b) => b.points - a.points)[0];

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
            <div class="progress-bar">
              <div class="progress-fill" style="width:${pct}%;background:${clan.color}"></div>
            </div>
            <div class="clan-card-footer">
              <span>${clan.players.length} player${clan.players.length !== 1 ? 's' : ''}</span>
              <span>${topPlayer ? '🏆 ' + esc(topPlayer.username) : 'Click to manage'}</span>
            </div>
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
    const avg    = clan.players.length ? Math.round(total / clan.players.length) : 0;

    // Header
    document.getElementById('clan-detail-color-bar').style.background = clan.color;
    document.getElementById('clan-detail-name').textContent = clan.name;
    document.getElementById('clan-detail-tag').textContent  = clan.tag || '';
    document.getElementById('clan-detail-points').textContent  = fmt(total);
    document.getElementById('clan-detail-players').textContent = clan.players.length;
    document.getElementById('clan-detail-rank').textContent    = `#${rank}`;
    document.getElementById('clan-detail-avg').textContent     = fmt(avg);

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
            <td colspan="6" style="text-align:center;padding:40px;color:var(--text-muted)">
              ${search ? 'No players match your search.' : 'No players yet — click <strong>+ Add Player</strong>.'}
            </td>
          </tr>`;
        return;
    }

    tbody.innerHTML = players.map((p, idx) => {
        const pct      = total > 0 ? ((p.points / total) * 100).toFixed(1) : '0.0';
        const barWidth = total > 0 ? Math.round((p.points / total) * 100) : 0;
        return `
          <tr>
            <td class="player-rank">${idx + 1}</td>
            <td class="player-name">
              ${esc(p.username)}
              <span class="role-badge ${getRoleClass(p.role)}">${esc(p.role || 'Member')}</span>
            </td>
            <td class="player-points" style="color:${clan.color}">${fmt(p.points)}</td>
            <td class="player-pct">${pct}%</td>
            <td>
              <div class="mini-bar">
                <div class="mini-bar-fill" style="width:${barWidth}%;background:${clan.color}"></div>
              </div>
            </td>
            <td>
              <div class="action-btns">
                <button class="btn-icon" onclick="openEditPlayer('${p.id}')" title="Edit">✏️</button>
                <button class="btn-icon del" onclick="deletePlayer('${p.id}')" title="Delete">🗑️</button>
              </div>
            </td>
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

function openEditPlayer(playerId) {
    const clan   = getClan(ui.currentClanId);
    const player = clan?.players.find(p => p.id === playerId);
    if (!player) return;

    ui.editingPlayerId = playerId;
    document.getElementById('modal-title').textContent  = 'Edit Player';
    document.getElementById('modal-submit').textContent = 'Save Changes';
    document.getElementById('player-username').value    = player.username;
    document.getElementById('player-points').value      = player.points;
    document.getElementById('player-role').value        = player.role || 'Member';
    document.getElementById('modal-overlay').classList.add('active');
    document.getElementById('player-username').focus();
}

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('active');
    ui.editingPlayerId = null;
}

function deletePlayer(playerId) {
    const clan   = getClan(ui.currentClanId);
    const player = clan?.players.find(p => p.id === playerId);
    if (!player) return;

    confirm(
        'Remove Player',
        `Remove "${player.username}" from ${clan.name}?`,
        () => {
            clan.players = clan.players.filter(p => p.id !== playerId);
            save();
            renderClanDetail();
            toast(`${player.username} removed`);
        }
    );
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

// ── Event Listeners ────────────────────────

// Nav
document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// Back button
document.getElementById('back-btn').addEventListener('click', () => switchView('dashboard'));

// Add player button
document.getElementById('add-player-btn').addEventListener('click', openAddPlayer);

// Player search & sort (live filter)
document.getElementById('player-search').addEventListener('input', () => {
    const clan = getClan(ui.currentClanId);
    if (clan) renderPlayersTable(clan);
});
document.getElementById('sort-select').addEventListener('change', () => {
    const clan = getClan(ui.currentClanId);
    if (clan) renderPlayersTable(clan);
});

// Player form submit
document.getElementById('player-form').addEventListener('submit', e => {
    e.preventDefault();

    const username = document.getElementById('player-username').value.trim();
    const points   = Number(document.getElementById('player-points').value) || 0;
    const role     = document.getElementById('player-role').value;

    if (!username) { toast('Enter a username', 'error'); return; }

    const clan = getClan(ui.currentClanId);
    if (!clan) return;

    if (ui.editingPlayerId) {
        const player = clan.players.find(p => p.id === ui.editingPlayerId);
        if (player) { player.username = username; player.points = points; player.role = role; }
        toast('Player updated');
    } else {
        clan.players.push({ id: uid(), username, points, role });
        toast('Player added');
    }

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

// ── Monitor ────────────────────────────────

const MONITOR_KEY      = 'ps99_monitor_v1';
const PS99_ROOT_PLACE  = 8737899170;

let monitorState = {
    webhook:           '',
    intervalSec:       60,
    privateServerLink: '',
    robloSecurity:     '',
    targetGameId:      '',
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
        case 'inServer':     return { cls: 'ms-ingame',       label: 'In Private Server' };
        case 'inGame':       return { cls: 'ms-online',       label: 'In PS99 (other server)' };
        case 'online':       return { cls: 'ms-online',       label: 'Online' };
        case 'offline':      return { cls: 'ms-offline',      label: 'Offline' };
        case 'disconnected': return { cls: 'ms-disconnected', label: 'Left Server!' };
        case 'checking':     return { cls: 'ms-checking',     label: 'Checking…' };
        default:             return { cls: 'ms-unknown',      label: 'Unknown' };
    }
}

function renderMonitor() {
    document.getElementById('mon-webhook').value      = monitorState.webhook           || '';
    document.getElementById('mon-interval').value     = monitorState.intervalSec       || 60;
    document.getElementById('mon-ps-link').value      = monitorState.privateServerLink || '';
    document.getElementById('mon-roblo-cookie').value = monitorState.robloSecurity     || '';
    const sid = document.getElementById('mon-server-id');
    sid.textContent = monitorState.targetGameId
        ? `Captured: ${monitorState.targetGameId.substring(0, 12)}…`
        : 'No server captured yet';
    renderMonitorPlayers();
    renderMonitorLog();
    updateMonitorBtn();
}

function renderMonitorPlayers() {
    const list = document.getElementById('mon-players-list');
    document.getElementById('mon-player-count').textContent = monitorState.players.length;

    if (monitorState.players.length === 0) {
        list.innerHTML = '<div class="mon-empty">No players added yet. Use the form to add a Roblox username or user ID.</div>';
        return;
    }

    list.innerHTML = monitorState.players.map(p => {
        const si          = getStatusInfo(p.status);
        const lastChecked = p.lastChecked ? new Date(p.lastChecked).toLocaleTimeString() : '—';
        const name        = esc(p.nickname || p.username);
        const sub         = p.nickname ? `<span class="mon-player-sub">@${esc(p.username)}</span>` : '';
        return `
          <div class="mon-player-row" id="mon-row-${p.id}">
            <span class="mon-dot ${si.cls}"></span>
            <div class="mon-player-info">
              <span class="mon-player-name">${name}</span>${sub}
            </div>
            <span class="mon-badge ${si.cls}">${si.label}</span>
            <span class="mon-time">${lastChecked}</span>
            <button class="btn-icon del" onclick="removeMonitorPlayer('${p.id}')" title="Remove">🗑️</button>
          </div>`;
    }).join('');
}

function renderMonitorLog() {
    const el = document.getElementById('mon-log');
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
    const logEl = document.getElementById('mon-log');
    if (logEl) renderMonitorLog();
}

function updateMonitorBtn() {
    const btn  = document.getElementById('mon-toggle-btn');
    const ind  = document.getElementById('mon-global-indicator');
    const txt  = document.getElementById('mon-global-text');
    if (monitorRunning) {
        btn.textContent = '⏹ Stop Monitoring';
        btn.className   = 'btn-danger';
        ind.className   = 'mon-global-status mon-global-running';
        txt.textContent = 'Monitoring';
    } else {
        btn.textContent = '▶ Start Monitoring';
        btn.className   = 'btn-primary';
        ind.className   = 'mon-global-status mon-global-idle';
        txt.textContent = 'Idle';
    }
}

// ── Roblox API ─────────────────────────────

const PROXY = 'https://corsproxy.io/?';

async function fetchPresences(userIds) {
    const headers = { 'Content-Type': 'application/json' };
    if (monitorState.robloSecurity) {
        headers['Cookie'] = `.ROBLOSECURITY=${monitorState.robloSecurity}`;
    }
    const res = await fetch(PROXY + encodeURIComponent('https://presence.roblox.com/v1/presence/users'), {
        method:  'POST',
        headers,
        body:    JSON.stringify({ userIds }),
    });
    if (!res.ok) throw new Error(`Presence API error ${res.status}`);
    const data = await res.json();
    data.userPresences?.forEach(p => {
        addLog(`Presence: ${JSON.stringify({ id: p.userId, type: p.userPresenceType, place: p.placeId ?? null, game: p.gameId ?? null })}`, 'info');
    });
    return data.userPresences || [];
}

// ── Discord ────────────────────────────────

async function sendDiscordAlert(player, newStatus) {
    if (!monitorState.webhook) return;
    const psLink    = monitorState.privateServerLink;
    const now       = Math.floor(Date.now() / 1000);
    const label     = newStatus === 'offline' ? 'Offline' : 'Left PS99';
    const display   = player.nickname || player.username;
    const fields    = [
        { name: 'Player', value: `**${display}**${player.nickname ? ` (@${player.username})` : ''}`, inline: true },
        { name: 'Status', value: label,                    inline: true },
        { name: 'Time',   value: `<t:${now}:T>`,           inline: true },
    ];
    if (psLink) fields.push({ name: 'Rejoin Private Server', value: psLink, inline: false });

    const payload = {
        username: 'PS99 Monitor',
        embeds: [{
            title:       `⚠️ ${display} disconnected from PS99!`,
            description: `**${player.username}** has left the game or disconnected from the private server.`,
            color:       0xEF4444,
            fields,
            footer:    { text: 'PS99 Clan Battle Tracker • Server Monitor' },
            timestamp: new Date().toISOString(),
        }],
    };

    try {
        const r = await fetch(monitorState.webhook, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
        });
        if (!r.ok && r.status !== 204) addLog(`Discord error ${r.status}`, 'error');
    } catch (e) {
        addLog(`Discord failed: ${e.message}`, 'error');
    }
}

async function testWebhook() {
    const url = document.getElementById('mon-webhook').value.trim();
    if (!url) { toast('Enter a webhook URL first', 'error'); return; }
    try {
        const r = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                username: 'PS99 Monitor',
                embeds: [{
                    title:       '✅ Webhook connected!',
                    description: 'PS99 connection monitor will send alerts here when a player disconnects.',
                    color:       0x10B981,
                    footer:      { text: 'PS99 Clan Battle Tracker' },
                }],
            }),
        });
        if (r.ok || r.status === 204) {
            toast('Test message sent!', 'success');
            addLog('Discord webhook test successful', 'success');
        } else {
            toast(`Webhook error: ${r.status}`, 'error');
        }
    } catch (e) {
        toast('Webhook failed: ' + e.message, 'error');
    }
}

// ── Monitor Loop ───────────────────────────

async function runMonitorCycle() {
    const players = monitorState.players.filter(p => p.userId);
    if (!players.length) return;

    try {
        const presences = await fetchPresences(players.map(p => p.userId));

        for (const presence of presences) {
            const player = players.find(p => p.userId === presence.userId);
            if (!player) continue;

            const prevStatus = player.status;
            let   newStatus;

            if      (presence.userPresenceType === 2 && presence.gameId)  newStatus = 'inServer';
            else if (presence.userPresenceType === 2 || presence.userPresenceType === 1)  newStatus = 'online';
            else                                                                          newStatus = 'offline';

            player.lastChecked = Date.now();

            const wasInServer = prevStatus === 'inServer';
            const leftServer  = wasInServer && newStatus !== 'inServer';


            if (leftServer) {
                player.status = 'disconnected';
                addLog(`⚠️ ${player.nickname || player.username} left the private server!`, 'alert');
                await sendDiscordAlert(player, newStatus);
                toast(`${player.nickname || player.username} left the server!`, 'error');
                setTimeout(() => {
                    player.status = newStatus;
                    renderMonitorPlayers();
                }, 5000);
            } else {
                if (newStatus === 'inServer' && prevStatus !== 'inServer' &&
                    prevStatus !== 'unknown' && prevStatus !== undefined) {
                    addLog(`✅ ${player.nickname || player.username} joined the private server`, 'success');
                }
                player.status = newStatus;
            }
        }

        saveMonitor();
        renderMonitorPlayers();
    } catch (e) {
        addLog(`Check failed: ${e.message}`, 'error');
    }
}

function startMonitoring() {
    if (!monitorState.players.length) { toast('Add players to monitor first', 'error'); return; }
    if (!monitorState.webhook)        { toast('Set a Discord webhook URL first', 'error'); return; }
    monitorRunning = true;
    updateMonitorBtn();
    addLog('Monitoring started', 'success');
    runMonitorCycle();
    monitorTimer = setInterval(runMonitorCycle, (monitorState.intervalSec || 60) * 1000);
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
    const p = monitorState.players.find(x => x.id === id);
    if (p) addLog(`Removed ${p.nickname || p.username}`, 'info');
    monitorState.players = monitorState.players.filter(x => x.id !== id);
    saveMonitor();
    renderMonitorPlayers();
    if (!monitorState.players.length && monitorRunning) stopMonitoring();
}

async function detectServer() {
    const players = monitorState.players.filter(p => p.userId);
    if (!players.length) { toast('Add a player first', 'error'); return; }
    if (!monitorState.robloSecurity) { toast('Enter your Roblox cookie first', 'error'); return; }

    toast('Detecting server…', 'info');
    try {
        const presences = await fetchPresences(players.map(p => p.userId));
        const found = presences.find(p => p.userPresenceType === 2);
        if (!found) {
            toast('No monitored player is currently in a game', 'error');
            addLog('Detect server failed — no player found in-game', 'error');
            return;
        }
        monitorState.targetGameId = found.gameId || 'detected';
        saveMonitor();
        const sid = document.getElementById('mon-server-id');
        sid.textContent = `Captured: ${found.gameId.substring(0, 12)}…`;
        addLog(`✅ Private server captured (${found.gameId})`, 'success');
        toast('Private server captured!', 'success');
    } catch (e) {
        toast(`Error: ${e.message}`, 'error');
    }
}

async function checkNow() {
    if (!monitorRunning) { toast('Start monitoring first', 'error'); return; }
    addLog('Manual check triggered…', 'info');
    await runMonitorCycle();
}

async function testDisconnectAlert() {
    if (!monitorState.webhook) { toast('Set a Discord webhook URL first', 'error'); return; }
    if (!monitorState.players.length) { toast('Add a player first', 'error'); return; }

    const player = monitorState.players[0];
    addLog(`Sending test disconnect alert for ${player.username}…`, 'info');
    await sendDiscordAlert(player, 'offline');
    toast('Test alert sent to Discord!', 'success');
    addLog('Test alert sent successfully', 'success');
}

function clearMonitorLog() {
    monitorLog = [];
    renderMonitorLog();
}

// ── Monitor Event Listeners ────────────────

document.getElementById('mon-settings-form').addEventListener('submit', e => {
    e.preventDefault();
    monitorState.webhook           = document.getElementById('mon-webhook').value.trim();
    monitorState.intervalSec       = Number(document.getElementById('mon-interval').value) || 60;
    monitorState.privateServerLink = document.getElementById('mon-ps-link').value.trim();
    monitorState.robloSecurity     = document.getElementById('mon-roblo-cookie').value.trim();
    saveMonitor();
    toast('Settings saved');
    if (monitorRunning) {
        clearInterval(monitorTimer);
        monitorTimer = setInterval(runMonitorCycle, monitorState.intervalSec * 1000);
    }
});

document.getElementById('mon-add-form').addEventListener('submit', e => {
    e.preventDefault();
    const rawId    = document.getElementById('mon-add-userid').value.trim();
    const username = document.getElementById('mon-add-username').value.trim();
    if (!rawId || !username) return;

    if (!/^\d+$/.test(rawId)) { toast('User ID must be numbers only', 'error'); return; }
    const userId = Number(rawId);

    if (monitorState.players.some(p => p.userId === userId)) {
        toast('Player already in monitor list', 'error');
        return;
    }

    try {
        monitorState.players.push({
            id: uid(), userId, username,
            nickname:    '',
            status:      'unknown',
            lastChecked: null,
        });

        document.getElementById('mon-add-userid').value   = '';
        document.getElementById('mon-add-username').value  = '';
        saveMonitor();
        renderMonitorPlayers();
        addLog(`Added ${username} (ID: ${userId})`, 'info');
        toast(`${username} added`);
    } catch (err) {
        toast(`Error: ${err.message}`, 'error');
    }
});

// ── Bootstrap ──────────────────────────────
load();
loadMonitor();
renderDashboard();
