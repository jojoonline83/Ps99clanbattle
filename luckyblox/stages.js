'use strict';

const PALETTE = [
    '#6366f1', '#ec4899', '#10b981', '#f59e0b',
    '#ef4444', '#06b6d4', '#8b5cf6', '#f97316',
    '#14b8a6', '#a855f7', '#84cc16', '#3b82f6',
];

let historyData = [];
let playerSnapshots = [];
let resolvedNamesCache = {};
let state = { mode: 'top', searchResults: [], colorByUser: {}, nextColorIdx: 0 };
const DISPLAY_LIMIT = 1000;

function save() {
    try { localStorage.setItem('ps99_clanbattle_luckyblox_stages_v1', JSON.stringify(state)); } catch (_) {}
}

function load() {
    try {
        const raw = localStorage.getItem('ps99_clanbattle_luckyblox_stages_v1');
        if (raw) state = { ...state, ...JSON.parse(raw) };
    } catch (_) {}
}

function esc(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(str ?? ''));
    return d.innerHTML;
}

function fmt(n) { return (Number(n) || 0).toLocaleString(); }

function stageLabel(points) {
    const pts = Number(points) || 0;
    const rebirth = Math.floor(pts / 20);
    const stage = (pts % 20) * 5;
    return { rebirth, stage };
}

function colorFor(userId) {
    const key = String(userId);
    if (!state.colorByUser[key]) {
        state.colorByUser[key] = PALETTE[state.nextColorIdx % PALETTE.length];
        state.nextColorIdx = (state.nextColorIdx + 1) % PALETTE.length;
    }
    return state.colorByUser[key];
}

function resolveDisplayName(p) {
    if (p.DisplayName && p.DisplayName !== String(p.UserID)) return p.DisplayName;
    return resolvedNamesCache[p.UserID] || resolvedNamesCache[String(p.UserID)] || String(p.UserID);
}

function extractPlayers(snapshot) {
    const playerMap = new Map();
    for (const clan of (snapshot.clans || [])) {
        for (const p of (clan.roster || [])) {
            const existing = playerMap.get(p.UserID);
            if (!existing || p.Points > existing.Points) {
                playerMap.set(p.UserID, {
                    UserID: p.UserID,
                    DisplayName: resolveDisplayName(p),
                    Points: p.Points,
                    Clan: clan.Name,
                });
            }
        }
    }
    const sorted = [...playerMap.values()].sort((a, b) => b.Points - a.Points);
    return { list: sorted, byId: playerMap };
}

function latestPlayerSnapshot() { return playerSnapshots.length ? playerSnapshots[playerSnapshots.length - 1] : null; }
function allPlayers() { return latestPlayerSnapshot()?.players?.list || []; }
function topPlayers() { return allPlayers().slice(0, DISPLAY_LIMIT); }
function displayedPlayers() { return state.mode === 'search' ? state.searchResults : topPlayers(); }

let toastTimer = null;
function toast(msg, type = 'success') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast ${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function findSnapshotNear(msAgo, toleranceMs) {
    if (playerSnapshots.length < 2) return null;
    const latest = playerSnapshots[playerSnapshots.length - 1];
    const targetTs = latest.ts - msAgo;
    const minAgeMs = msAgo / 2;
    let best = null, bestDiff = Infinity;
    for (const entry of playerSnapshots) {
        if (entry === latest) continue;
        if (latest.ts - entry.ts < minAgeMs) continue;
        const diff = Math.abs(entry.ts - targetTs);
        if (diff < bestDiff) { bestDiff = diff; best = entry; }
    }
    return best && bestDiff <= toleranceMs ? best : null;
}

function playerDelta(userId, currentPoints, windowMs, toleranceMs) {
    const snap = findSnapshotNear(windowMs, toleranceMs);
    if (!snap) return { text: '—', color: '', value: null };
    const pastEntry = snap.players?.byId?.get(userId);
    if (!pastEntry) return { text: '—', color: '', value: null };
    const delta = currentPoints - pastEntry.Points;
    const sign = delta >= 0 ? '+' : '−';
    return {
        text: `${sign}${fmt(Math.abs(delta))}`,
        color: delta > 0 ? 'var(--success)' : (delta < 0 ? 'var(--danger)' : 'var(--text-muted)'),
        value: delta,
    };
}

function renderLeaderboard() {
    const badge = document.getElementById('event-status-badge');
    const snap = latestPlayerSnapshot();
    badge.innerHTML = snap
        ? `<span class="status-pill status-active">⚡ Updated ${new Date(snap.ts).toLocaleTimeString()}</span>`
        : '';

    const list = displayedPlayers();
    document.getElementById('leaderboard-heading').textContent =
        state.mode === 'search'
            ? `Search Results (${list.length} match${list.length === 1 ? '' : 'es'})`
            : `Top Players by Stage (${topPlayers().length})`;

    document.getElementById('clear-search-btn').style.display = state.mode === 'search' ? 'inline-block' : 'none';

    const tbody = document.getElementById('leaderboard-tbody');
    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--text-muted)">
          ${state.mode === 'search' ? 'No players matched your search.' : 'No data yet — waiting for first snapshot.'}
        </td></tr>`;
        return;
    }

    const globalList = allPlayers();
    tbody.innerHTML = list.map((p, idx) => {
        const color = colorFor(p.UserID);
        const sl = stageLabel(p.Points);
        const d10 = playerDelta(p.UserID, p.Points, 10 * 60_000, 11 * 60_000);
        const d30 = playerDelta(p.UserID, p.Points, 30 * 60_000, 8  * 60_000);
        const d1h = playerDelta(p.UserID, p.Points, 60 * 60_000, 12 * 60_000);
        const globalRank = state.mode === 'search' ? globalList.findIndex(g => g.UserID === p.UserID) + 1 : idx + 1;
        const rankLabel = globalRank > 0 ? globalRank : '—';
        const isResolved = p.DisplayName !== String(p.UserID);
        const nameHtml = isResolved
            ? `<div>${esc(p.DisplayName)}</div><div style="font-size:10px;color:var(--text-muted);font-weight:400">ID: ${p.UserID}</div>`
            : `<div style="color:var(--text-muted)">${p.UserID}</div>`;
        return `
      <tr>
        <td class="player-rank">${rankLabel}</td>
        <td class="player-name"><span class="st-team-dot" style="background:${color}"></span> <div>${nameHtml}</div></td>
        <td style="font-size:12px;color:var(--text-secondary)">${esc(p.Clan || '—')}</td>
        <td style="font-weight:700;color:${color}">${sl.rebirth}</td>
        <td style="font-weight:600;color:var(--text-primary)">${sl.stage}</td>
        <td style="font-weight:600;color:var(--gold)">${fmt(p.Points * 5)}</td>
        <td style="font-size:12px;color:var(--text-secondary)">${fmt(p.Points)}</td>
        <td style="color:${d10.color};font-size:12px">${d10.text}</td>
        <td style="color:${d30.color};font-size:12px">${d30.text}</td>
        <td style="color:${d1h.color};font-size:12px">${d1h.text}</td>
      </tr>`;
    }).join('');
}

async function searchPlayers() {
    const input = document.getElementById('search-player-name');
    const query = (input?.value || '').trim();
    if (!query) { toast('Enter a player name', 'error'); return; }

    const btn = document.getElementById('search-player-btn');
    btn.disabled = true;

    const queryLower = query.toLowerCase();
    const localMatches = allPlayers().filter(p =>
        p.DisplayName.toLowerCase().includes(queryLower) ||
        String(p.UserID) === query ||
        (p.Clan && p.Clan.toLowerCase().includes(queryLower))
    );

    state.searchResults = localMatches;
    state.mode = 'search';
    save();
    renderLeaderboard();

    const statusEl = document.getElementById('search-status');
    if (localMatches.length) {
        statusEl.className = 'import-status success';
        statusEl.innerHTML = `Found ${localMatches.length} player(s).`;
    } else {
        statusEl.className = 'import-status error';
        statusEl.innerHTML = `No players found matching "${esc(query)}".`;
    }
    btn.disabled = false;
}

function clearSearch() {
    document.getElementById('search-player-name').value = '';
    document.getElementById('search-status').innerHTML = '';
    if (state.mode === 'search') { state.mode = 'top'; save(); renderLeaderboard(); }
}

async function loadHistory() {
    const [histRes, namesRes] = await Promise.all([
        fetch(`history.json?t=${Date.now()}`, { signal: AbortSignal.timeout(30000) }),
        fetch(`resolved_names.json?t=${Date.now()}`, { signal: AbortSignal.timeout(10000) }).catch(() => null),
    ]);
    if (namesRes && namesRes.ok) {
        try { resolvedNamesCache = await namesRes.json(); } catch (_) {}
    }
    if (histRes.ok) {
        const raw = await histRes.json();
        historyData = raw;
        playerSnapshots = raw.map(snap => ({
            ts: snap.ts,
            players: extractPlayers(snap),
        }));
    }
}

async function refreshAll({ silent = false } = {}) {
    const btn = document.getElementById('refresh-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Loading…'; }
    try {
        await loadHistory();
        renderLeaderboard();
        if (!silent) toast(`Loaded ${fmt(allPlayers().length)} players`, 'success');
    } catch (err) {
        if (!silent) toast(err.message || 'Failed to refresh', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh'; }
    }
}

document.getElementById('refresh-btn').addEventListener('click', () => refreshAll({ silent: false }));
document.getElementById('search-player-btn').addEventListener('click', searchPlayers);
document.getElementById('clear-search-btn').addEventListener('click', clearSearch);
document.getElementById('search-player-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); searchPlayers(); }
});
setInterval(() => refreshAll({ silent: true }), 10 * 60_000);

load();
renderLeaderboard();
refreshAll({ silent: false });
