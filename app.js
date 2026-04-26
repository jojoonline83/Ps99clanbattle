/* ═══════════════════════════════════════════
   PS99 Clan Battle Tracker — App Logic
   ═══════════════════════════════════════════ */

'use strict';

// ── Constants ──────────────────────────────
const STORAGE_KEY = 'ps99_tracker_v1';
const API_BASE    = 'https://biggamesapi.io/api';
const CORS_PROXY  = 'https://corsproxy.io/?url=';

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
}

function showClanDetail(clanId) {
    ui.currentClanId = clanId;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('clan-detail-view').classList.add('active');
    const clan = getClan(clanId);
    // Lazy-load players if not yet fetched
    if (clan && clan.players.length === 0 && clan.name) {
        renderClanDetail();
        importClanByName(clan.name, clan.battleTotal || 0)
            .then(() => renderClanDetail())
            .catch(() => renderClanDetail());
    } else {
        renderClanDetail();
    }
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

    // Clan delta last 5 minutes (snapshot closest to 5m ago, within 2–10 min window)
    const detailNow     = Date.now();
    const detailSnaps   = clan.snapshots || [];
    const target5m      = detailNow - 5 * 60_000;
    const snap5mClan    = detailSnaps
        .filter(s => s.ts <= detailNow - 2 * 60_000 && s.ts >= detailNow - 10 * 60_000)
        .sort((a, b) => Math.abs(a.ts - target5m) - Math.abs(b.ts - target5m))[0] || null;
    let delta5m = null;
    if (snap5mClan && clan.players.length) {
        delta5m = clan.players.reduce((sum, p) => {
            const prev = snap5mClan.pts?.[p.userId] ?? null;
            return sum + (prev !== null ? Math.max(0, p.points - prev) : 0);
        }, 0);
    }
    const snap5mAgeMin = snap5mClan ? Math.round((detailNow - snap5mClan.ts) / 60000) : null;
    const delta5mText  = delta5m !== null
        ? `+${fmt(delta5m)}${snap5mAgeMin !== null ? ' (' + snap5mAgeMin + 'm)' : ''}`
        : '—';

    // Header
    document.getElementById('clan-detail-color-bar').style.background = clan.color;
    document.getElementById('clan-detail-name').textContent = clan.name;
    document.getElementById('clan-detail-tag').textContent  = clan.tag || '';
    document.getElementById('clan-detail-points').textContent  = fmt(total);
    document.getElementById('clan-detail-players').textContent = clan.players.length;
    document.getElementById('clan-detail-rank').textContent    = `#${rank}`;
    document.getElementById('clan-detail-avg').textContent     = fmt(avgHr) + '/hr';
    document.getElementById('clan-detail-delta').textContent   = deltaText;
    document.getElementById('clan-detail-delta5m').textContent = delta5mText;

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
    const snapAgeMin = snap ? Math.round((now - snap.ts) / 60000) : null;
    const ageLabel   = snapAgeMin !== null
        ? (snapAgeMin >= 60 ? `${Math.round(snapAgeMin / 60)}hr` : `${snapAgeMin}m`) + ' ago'
        : '';

    // Snapshot closest to 5 minutes ago (within 2–10 min window)
    const snapshots  = clan.snapshots || [];
    const t5m        = now - 5 * 60_000;
    const snap5m     = snapshots
        .filter(s => s.ts <= now - 2 * 60_000 && s.ts >= now - 10 * 60_000)
        .sort((a, b) => Math.abs(a.ts - t5m) - Math.abs(b.ts - t5m))[0] || null;
    const snap5mAge  = snap5m ? Math.round((now - snap5m.ts) / 60000) : null;

    tbody.innerHTML = players.map((p, idx) => {
        const ptsPerHr = p.points / hours;

        // Points gained since previous refresh
        const prevPts = snap?.pts?.[p.userId] ?? null;
        const delta1h = prevPts !== null ? Math.max(0, p.points - prevPts) : null;

        // Points gained in last ~5 minutes
        const prev5mPts = snap5m?.pts?.[p.userId] ?? null;
        const delta5m   = prev5mPts !== null ? Math.max(0, p.points - prev5mPts) : null;

        const avgHrText   = fmt(Math.round(ptsPerHr)) + '/hr';
        const delta1hText = delta1h !== null
            ? `+${fmt(delta1h)}${ageLabel ? ' (' + ageLabel + ')' : ''}`
            : null;
        const delta5mText = delta5m !== null
            ? `+${fmt(delta5m)}${snap5mAge !== null ? ' (' + snap5mAge + 'm)' : ''}`
            : null;
        const subLine = [avgHrText, delta1hText, delta5mText].filter(Boolean).join('  ·  ');

        return `
          <tr>
            <td class="player-rank">${idx + 1}</td>
            <td class="player-name">
              <div>${esc(p.username)} <span class="role-badge ${getRoleClass(p.role)}">${esc(p.role || 'Member')}</span></div>
              ${subLine ? `<div class="player-sub">${esc(subLine)}</div>` : ''}
            </td>
            <td class="player-points" style="color:${clan.color}">${fmt(p.points)}</td>
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
    // Try direct first, then CORS proxy
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error('not ok');
        return await res.json();
    } catch {
        const proxyRes = await fetch(CORS_PROXY + encodeURIComponent(url), {
            signal: AbortSignal.timeout(12000)
        });
        if (!proxyRes.ok) throw new Error(`API error: ${proxyRes.status}`);
        return await proxyRes.json();
    }
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

        // 2. Fallback via CORS proxy
        if (!parsed) {
            try {
                const res = await fetch(`${CORS_PROXY}${encodeURIComponent(ROBLOX_URL)}`, {
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
        // 1. Battle config → name + dates only
        const battleCfg = await apiFetch('/activeClanBattle');
        const cfgData   = battleCfg?.data?.configData || {};
        const startTime = cfgData.StartTime  ? new Date(cfgData.StartTime  * 1000) : null;
        const endTime   = cfgData.FinishTime ? new Date(cfgData.FinishTime * 1000) : null;

        // 2. Top clans sorted by Points — fetch enough pages to cover the full battle
        const page1 = await apiFetch('/clans?page=1&pageSize=100&sort=Points&sortOrder=desc');
        const page2 = await apiFetch('/clans?page=2&pageSize=100&sort=Points&sortOrder=desc');
        const clanList = [...(page1?.data || []), ...(page2?.data || [])];
        if (!clanList.length) throw new Error('No clan data returned');

        // 3. Rebuild state
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
            const color  = PALETTE[state.nextColorIdx % PALETTE.length];
            state.nextColorIdx++;
            state.clans.push({
                id: uid(), name, tag: '', color,
                battleTotal: points,
                players: [],   // loaded lazily on drill-down
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

// ── Event Listeners ────────────────────────

// Nav
document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// Back button
document.getElementById('back-btn').addEventListener('click', () => switchView('dashboard'));

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

// ── Bootstrap ──────────────────────────────
load();
// Show cached data instantly, then fetch fresh data in background
renderDashboard();
loadBattleData({ silent: state.clans.length > 0 });
