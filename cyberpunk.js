'use strict';

document.title = 'PS99 Clan Battle — Cyberpunk Battle';

const STORAGE_KEY   = 'ps99_clanbattle_cyberpunk_v1';
const API_BASE      = 'https://ps99.biggamesapi.io/api';
const CORS_PROXIES  = [
    'https://corsproxy.io/?url=',
    'https://api.allorigins.win/raw?url=',
];

const PALETTE = [
    '#6366f1', '#ec4899', '#10b981', '#f59e0b',
    '#ef4444', '#06b6d4', '#8b5cf6', '#f97316',
    '#14b8a6', '#a855f7', '#84cc16', '#3b82f6',
];

const DISPLAY_LIMIT = 1000;
const LIVE_POLL_MS  = 30_000;

let historyData       = [];
let resolvedNamesCache = {};
let liveClanPoints    = {};
let livePointsTs      = 0;
let playerSnapshots   = [];
let activeTab         = 'clans';

let state = {
    clanMode: 'top',
    clanSearchResults: [],
    playerMode: 'top',
    playerSearchResults: [],
    colorByName: {},
    colorByUser: {},
    nextColorIdx: 0,
};

let ui = {
    currentClanName: null,
    currentClanDetail: null,
    currentRank: undefined,
    livePointsAsOf: undefined,
};

function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
}

function load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) state = { ...state, ...JSON.parse(raw) };
    } catch (_) {}
}

function esc(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(str ?? ''));
    return d.innerHTML;
}

function fmt(n) { return (Number(n) || 0).toLocaleString(); }

function colorForClan(name) {
    const key = name.toLowerCase();
    if (!state.colorByName[key]) {
        state.colorByName[key] = PALETTE[state.nextColorIdx % PALETTE.length];
        state.nextColorIdx = (state.nextColorIdx + 1) % PALETTE.length;
    }
    return state.colorByName[key];
}

function colorForUser(userId) {
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

function firstDefined(...args) {
    for (const a of args) if (a !== undefined && a !== null) return a;
    return undefined;
}

function asNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function latestSnapshot() {
    return historyData.length ? historyData[historyData.length - 1] : null;
}

function topClans() {
    return latestSnapshot()?.clans || [];
}

function displayedClans() {
    return state.clanMode === 'search' ? state.clanSearchResults : topClans();
}

function getLivePoints(clanName) {
    const key = clanName.toLowerCase();
    return liveClanPoints[key] !== undefined ? liveClanPoints[key] : null;
}

function getClanPoints(clan) {
    return getLivePoints(clan.Name) ?? clan.Points;
}

function hasRosterData(entry) {
    return entry.clans.length === 0 || entry.clans[0].roster !== undefined;
}

function findSnapshotNear(msAgo, toleranceMs) {
    if (historyData.length < 2) return null;
    const latest = historyData[historyData.length - 1];
    const targetTs = latest.ts - msAgo;
    const minAgeMs = msAgo / 2;
    let best = null, bestDiff = Infinity;
    for (const entry of historyData) {
        if (entry === latest) continue;
        if (!hasRosterData(entry)) continue;
        if (latest.ts - entry.ts < minAgeMs) continue;
        const diff = Math.abs(entry.ts - targetTs);
        if (diff < bestDiff) { bestDiff = diff; best = entry; }
    }
    return best && bestDiff <= toleranceMs ? best : null;
}

function findPlayerSnapshotNear(msAgo, toleranceMs) {
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

function findClanInSnapshot(snap, clanName) {
    return snap.clans.find(c => c.Name.toLowerCase() === clanName.toLowerCase());
}

function formatAsOf(snap) {
    return snap ? `as of ${new Date(snap.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
}

function clanDelta(clanName, windowMs, toleranceMs) {
    const snap = findSnapshotNear(windowMs, toleranceMs);
    if (!snap) return { text: '—', color: '' };
    const entry = findClanInSnapshot(snap, clanName);
    if (!entry) return { text: '—', color: '' };
    const latest = latestSnapshot();
    const latestClan = latest ? findClanInSnapshot(latest, clanName) : null;
    const currentPoints = latestClan ? latestClan.Points : 0;
    const delta = currentPoints - entry.Points;
    const sign = delta >= 0 ? '+' : '−';
    return {
        text: `${sign}${fmt(Math.abs(delta))}`,
        color: delta > 0 ? 'var(--success)' : (delta < 0 ? 'var(--danger)' : ''),
    };
}

function renderClanDeltaStat(elId, detail, windowMs, toleranceMs) {
    const el = document.getElementById(elId);
    const asOfEl = document.getElementById(`${elId}-asof`);
    const snap = findSnapshotNear(windowMs, toleranceMs);
    if (!snap) {
        el.textContent = '—'; el.title = 'Not enough snapshot history yet';
        if (asOfEl) asOfEl.textContent = '';
        return null;
    }
    const entry = findClanInSnapshot(snap, detail.Name);
    if (!entry) {
        el.textContent = '—'; el.title = 'Clan was outside tracking at that time';
        if (asOfEl) asOfEl.textContent = '';
        return null;
    }
    const latest = latestSnapshot();
    const latestClan = latest ? findClanInSnapshot(latest, detail.Name) : null;
    const currentPoints = latestClan ? latestClan.Points : detail.Points;
    const ageMin = Math.round((latest.ts - snap.ts) / 60000);
    const delta = currentPoints - entry.Points;
    const sign = delta >= 0 ? '+' : '−';
    el.textContent = `${sign}${fmt(Math.abs(delta))}`;
    el.title = `From snapshot ${ageMin}m ago`;
    el.style.color = delta > 0 ? 'var(--success)' : (delta < 0 ? 'var(--danger)' : '');
    if (asOfEl) asOfEl.textContent = `${ageMin}m ago`;
    return snap;
}

function rosterPlayerDelta(detail, userId, currentPoints, windowMs, toleranceMs) {
    const snap = findSnapshotNear(windowMs, toleranceMs);
    if (!snap) return { text: '—', color: '' };
    const clan = findClanInSnapshot(snap, detail.Name);
    const past = clan?.roster?.find(p => p.UserID === userId)?.Points;
    if (past === undefined) return { text: '—', color: '' };
    const delta = currentPoints - past;
    const sign = delta >= 0 ? '+' : '−';
    return {
        text: `${sign}${fmt(Math.abs(delta))}`,
        color: delta > 0 ? 'var(--success)' : (delta < 0 ? 'var(--danger)' : ''),
    };
}

function playerDelta(userId, currentPoints, windowMs, toleranceMs) {
    const snap = findPlayerSnapshotNear(windowMs, toleranceMs);
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
function displayedPlayers() { return state.playerMode === 'search' ? state.playerSearchResults : topPlayers(); }

async function apiFetch(url) {
    const isValid = d => d && typeof d === 'object' && d.status === 'ok';
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (res.ok) { const d = await res.json(); if (isValid(d)) return d; }
    } catch (_) {}
    for (const proxy of CORS_PROXIES) {
        try {
            const res = await fetch(proxy + encodeURIComponent(url), { signal: AbortSignal.timeout(20000) });
            if (res.ok) { const d = await res.json(); if (isValid(d)) return d; }
        } catch (_) {}
    }
    throw new Error('API unavailable – check connection or try again later');
}

async function fetchLiveClanPoints() {
    const pages = 5;
    const pageSize = 50;
    const fetches = Array.from({ length: pages }, (_, i) =>
        apiFetch(`${API_BASE}/clans?page=${i + 1}&pageSize=${pageSize}&sort=Points&sortOrder=desc`).catch(() => null)
    );
    const results = await Promise.all(fetches);
    const newMap = {};
    for (const json of results) {
        if (!json?.data || !Array.isArray(json.data)) continue;
        for (const c of json.data) {
            const name = c.Name || c.name || c.ClanName || c.clanName;
            const pts = Number(c.Points ?? c.points ?? c.Score ?? c.score ?? 0);
            if (name) newMap[name.toLowerCase()] = pts;
        }
    }
    if (Object.keys(newMap).length > 0) {
        liveClanPoints = newMap;
        livePointsTs = Date.now();
    }
}

async function resolveUsernames(userIds) {
    if (!userIds.length) return {};
    const map = {};
    for (let i = 0; i < userIds.length; i += 100) {
        const batch = userIds.slice(i, i + 100).map(Number).filter(id => id > 0);
        if (!batch.length) continue;
        const body = JSON.stringify({ userIds: batch, excludeBannedUsers: false });
        const headers = { 'Content-Type': 'application/json' };
        let parsed = null;
        try {
            const res = await fetch('https://users.roproxy.com/v1/users', { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
            if (res.ok) parsed = await res.json();
        } catch (_) {}
        if (parsed && parsed.data && parsed.data.length) {
            parsed.data.forEach(u => {
                const n = u.displayName || u.name;
                map[u.id] = n; map[String(u.id)] = n;
                resolvedNamesCache[u.id] = n;
                resolvedNamesCache[String(u.id)] = n;
            });
        }
    }
    if (Object.keys(map).length > 0) return map;
    const remaining = userIds.map(Number).filter(id => id > 0 && !map[id]).slice(0, 200);
    if (!remaining.length) return map;
    let idx = 0;
    async function worker() {
        while (idx < remaining.length) {
            const uid = remaining[idx++];
            for (const makeFn of [
                u => ({ url: `https://api.allorigins.win/get?url=${encodeURIComponent(`https://users.roblox.com/v1/users/${u}`)}`, wrap: true }),
                u => ({ url: `https://corsproxy.io/?url=${encodeURIComponent(`https://users.roblox.com/v1/users/${u}`)}`, wrap: false }),
            ]) {
                try {
                    const { url, wrap } = makeFn(uid);
                    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
                    if (!res.ok) continue;
                    const data = wrap ? JSON.parse((await res.json()).contents) : await res.json();
                    const n = data.displayName || data.name;
                    if (n) { map[uid] = n; map[String(uid)] = n; resolvedNamesCache[uid] = n; resolvedNamesCache[String(uid)] = n; break; }
                } catch (_) {}
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(10, remaining.length) }, () => worker()));
    return map;
}

async function buildLiveDetail(raw) {
    const members = Array.isArray(raw.Members) ? raw.Members : [];
    const battles = raw.Battles || raw.battles || {};
    const battleKeys = Object.keys(battles);
    let battleData = battleKeys.length ? battles[battleKeys[battleKeys.length - 1]] : null;

    let contribRows = [];
    if (battleData) {
        contribRows = firstDefined(
            battleData.PointContributions, battleData.pointContributions,
            battleData.Contributions, battleData.contributions,
            battleData.Contribution, battleData.contribution
        ) || [];
        if (!Array.isArray(contribRows)) contribRows = [];
    }
    if (!contribRows.length) {
        const fb = firstDefined(
            raw.Contribution?.Battle, raw.contribution?.battle,
            raw.Contributions?.Battle, raw.contributions?.battle
        );
        if (Array.isArray(fb)) contribRows = fb;
    }

    const contribByUser = {};
    for (const c of contribRows) {
        const uid = asNumber(firstDefined(c.UserID, c.UserId, c.user_id, c.userId, c.id));
        const pts = asNumber(firstDefined(c.Points, c.points, c.TotalPoints, c.total_points, c.Score, c.score, c.Value, c.value));
        if (uid > 0) contribByUser[uid] = pts;
    }

    const roster = [];
    const seen = new Set();
    for (const m of members) {
        const uid = asNumber(firstDefined(m.UserID, m.UserId, m.user_id, m.userId, m.id));
        if (uid <= 0) continue;
        seen.add(uid);
        let displayName = String(uid);
        if (resolvedNamesCache[uid]) displayName = resolvedNamesCache[uid];
        else if (resolvedNamesCache[String(uid)]) displayName = resolvedNamesCache[String(uid)];
        roster.push({ UserID: uid, DisplayName: displayName, Points: contribByUser[uid] ?? 0 });
    }
    for (const [uidStr, pts] of Object.entries(contribByUser)) {
        const uid = Number(uidStr);
        if (!seen.has(uid) && uid > 0) {
            let displayName = String(uid);
            if (resolvedNamesCache[uid]) displayName = resolvedNamesCache[uid];
            else if (resolvedNamesCache[uidStr]) displayName = resolvedNamesCache[uidStr];
            roster.push({ UserID: uid, DisplayName: displayName, Points: pts });
        }
    }

    const needsResolve = roster.filter(p => p.DisplayName === String(p.UserID)).map(p => p.UserID);
    if (needsResolve.length) {
        const resolved = await resolveUsernames([...new Set(needsResolve)]);
        roster.forEach(p => {
            if (p.DisplayName === String(p.UserID) && (resolved[p.UserID] || resolved[String(p.UserID)])) {
                p.DisplayName = resolved[p.UserID] || resolved[String(p.UserID)];
            }
        });
    }

    roster.sort((a, b) => b.Points - a.Points);

    const totalPoints = asNumber(firstDefined(raw.Points, raw.points));
    return {
        Name: raw.Name || raw.name || 'Unknown',
        Points: totalPoints || Object.values(contribByUser).reduce((s, v) => s + v, 0),
        Members: roster.length,
        roster,
    };
}

let toastTimer = null;
function toast(msg, type = 'success') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast ${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function switchTab(tab) {
    activeTab = tab;
    document.getElementById('tab-clans').classList.toggle('active', tab === 'clans');
    document.getElementById('tab-players').classList.toggle('active', tab === 'players');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    if (tab === 'clans') {
        document.getElementById('leaderboard-view').classList.add('active');
        renderClanLeaderboard();
    } else {
        document.getElementById('players-view').classList.add('active');
        renderPlayerLeaderboard();
    }
}

function showClanLeaderboard() {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('leaderboard-view').classList.add('active');
    renderClanLeaderboard();
}

function renderClanLeaderboard() {
    const badge = document.getElementById('event-status-badge');
    if (livePointsTs) {
        badge.innerHTML = `<span class="status-pill status-active">🔴 Live ${new Date(livePointsTs).toLocaleTimeString()}</span>`;
    } else {
        const snap = latestSnapshot();
        badge.innerHTML = snap
            ? `<span class="status-pill status-active">⚡ Updated ${new Date(snap.ts).toLocaleTimeString()}</span>`
            : '';
    }

    let list = [...displayedClans()];
    if (state.clanMode !== 'search' && Object.keys(liveClanPoints).length > 0) {
        list.sort((a, b) => getClanPoints(b) - getClanPoints(a));
    }

    document.getElementById('leaderboard-heading').textContent =
        state.clanMode === 'search'
            ? `Search Results (${list.length} match${list.length === 1 ? '' : 'es'})`
            : 'Top Clans';

    document.getElementById('clear-search-btn').style.display = state.clanMode === 'search' ? 'inline-block' : 'none';

    const tbody = document.getElementById('leaderboard-tbody');
    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-muted)">
          ${state.clanMode === 'search' ? 'No clans matched your search.' : 'No data yet — hit <strong>🔄 Refresh</strong> to load.'}
        </td></tr>`;
        return;
    }

    tbody.innerHTML = list.map((c, idx) => {
        const color = colorForClan(c.Name);
        const members = c.roster ? c.roster.length : (c.Members || 0);
        const pts = getClanPoints(c);
        const d10 = clanDelta(c.Name, 10 * 60_000, 11 * 60_000);
        const d30 = clanDelta(c.Name, 30 * 60_000, 8  * 60_000);
        const d1h = clanDelta(c.Name, 60 * 60_000, 12 * 60_000);
        return `
      <tr onclick="showClanDetail('${esc(c.Name).replace(/'/g, "\\'")}')" style="cursor:pointer">
        <td class="player-rank">${idx + 1}</td>
        <td class="player-name"><span class="st-team-dot" style="background:${color}"></span> ${esc(c.Name)}</td>
        <td>${members}</td>
        <td class="player-points" style="color:${color}">${fmt(pts)}</td>
        <td style="color:${d10.color};font-size:12px">${d10.text}</td>
        <td style="color:${d30.color};font-size:12px">${d30.text}</td>
        <td style="color:${d1h.color};font-size:12px">${d1h.text}</td>
      </tr>`;
    }).join('');
}

function showClanDetail(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('clan-detail-view').classList.add('active');
    ui.currentClanName = name;
    ui.currentClanDetail = null;
    ui.currentRank = undefined;
    ui.livePointsAsOf = undefined;
    renderClanDetail();
    openClanDetail(name);
}

function openClanDetail(name) {
    const nameLower = name.toLowerCase();
    const fromSnapshot = topClans().find(c => c.Name.toLowerCase() === nameLower);
    if (fromSnapshot) {
        ui.currentClanDetail = fromSnapshot;
        const idx = topClans().indexOf(fromSnapshot);
        ui.currentRank = idx !== -1 ? idx + 1 : undefined;
        renderClanDetail();
        resolveRosterNames(fromSnapshot.roster, name);
        refreshClanDetailLive(name);
        return;
    }
    fetchClanDetailLive(name);
}

async function resolveRosterNames(roster, clanName) {
    if (!roster || !roster.length) return;
    const unresolved = roster.filter(p => p.DisplayName === String(p.UserID)).map(p => p.UserID);
    if (!unresolved.length) return;
    const resolved = await resolveUsernames([...new Set(unresolved)]);
    let changed = 0;
    for (const p of roster) {
        if (p.DisplayName === String(p.UserID)) {
            const name = resolved[p.UserID] || resolved[String(p.UserID)];
            if (name) { p.DisplayName = name; changed++; }
        }
    }
    if (changed && ui.currentClanName === clanName) renderClanDetail();
}

function renderClanDetail() {
    const name = ui.currentClanName;
    const color = colorForClan(name);
    document.getElementById('clan-detail-color-bar').style.background = color;
    document.getElementById('clan-detail-name').textContent = name;

    const rankEl = document.getElementById('cd-rank');
    if (ui.currentRank === undefined) rankEl.textContent = 'Calculating…';
    else if (ui.currentRank === null) rankEl.textContent = 'Unknown';
    else rankEl.textContent = `#${fmt(ui.currentRank)}`;

    const detail = ui.currentClanDetail;
    if (!detail) {
        document.getElementById('clan-detail-sub').textContent = 'Loading…';
        document.getElementById('cd-pts').textContent = '…';
        document.getElementById('cd-pts-asof').textContent = '';
        document.getElementById('cd-roster').textContent = '…';
        ['cd-delta-10m', 'cd-delta-30m', 'cd-delta-1h'].forEach(id => {
            document.getElementById(id).textContent = '—';
            document.getElementById(`${id}-asof`).textContent = '';
        });
        document.getElementById('roster-delta-note').textContent = '';
        document.getElementById('roster-tbody').innerHTML =
            `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-muted)">Loading roster…</td></tr>`;
        return;
    }

    document.getElementById('clan-detail-sub').textContent = 'Clan Battle — Cyberpunk Battle';
    const livePts = getLivePoints(detail.Name);
    document.getElementById('cd-pts').textContent = fmt(livePts ?? detail.Points);
    const rosterCount = detail.roster ? detail.roster.length : 0;
    document.getElementById('cd-roster').textContent = `${rosterCount}`;
    const asOfTs = ui.livePointsAsOf || livePointsTs;
    document.getElementById('cd-pts-asof').textContent = asOfTs
        ? `🔴 Live as of ${new Date(asOfTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
        : (latestSnapshot() ? `Snapshot as of ${new Date(latestSnapshot().ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — refreshing…` : '');

    const snap10 = renderClanDeltaStat('cd-delta-10m', detail, 10 * 60_000, 11 * 60_000);
    const snap30 = renderClanDeltaStat('cd-delta-30m', detail, 30 * 60_000, 8  * 60_000);
    const snap1h = renderClanDeltaStat('cd-delta-1h',  detail, 60 * 60_000, 12 * 60_000);

    const noteParts = [
        snap10 && `Δ10m ${formatAsOf(snap10)}`,
        snap30 && `Δ30m ${formatAsOf(snap30)}`,
        snap1h && `Δ1h ${formatAsOf(snap1h)}`,
    ].filter(Boolean);
    document.getElementById('roster-delta-note').textContent = noteParts.length ? noteParts.join(' · ') : '';

    const tbody = document.getElementById('roster-tbody');
    const roster = detail.roster || [];
    const snapClan = latestSnapshot() ? findClanInSnapshot(latestSnapshot(), detail.Name) : null;
    const snapRoster = snapClan?.roster || [];
    const snapPointsById = {};
    snapRoster.forEach(sp => { snapPointsById[sp.UserID] = sp.Points; });
    tbody.innerHTML = roster.length
        ? roster.map((p, idx) => {
            const pts = snapPointsById[p.UserID] !== undefined ? snapPointsById[p.UserID] : p.Points;
            const d10 = rosterPlayerDelta(detail, p.UserID, pts, 10 * 60_000, 11 * 60_000);
            const d30 = rosterPlayerDelta(detail, p.UserID, pts, 30 * 60_000, 8  * 60_000);
            const d1h = rosterPlayerDelta(detail, p.UserID, pts, 60 * 60_000, 12 * 60_000);
            return `
              <tr>
                <td class="player-rank">${idx + 1}</td>
                <td class="player-name">${esc(p.DisplayName)}</td>
                <td class="player-points" style="color:${color}">${fmt(p.Points)}</td>
                <td style="color:${d10.color};font-size:12px">${d10.text}</td>
                <td style="color:${d30.color};font-size:12px">${d30.text}</td>
                <td style="color:${d1h.color};font-size:12px">${d1h.text}</td>
              </tr>`;
          }).join('')
        : `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-muted)">No roster data.</td></tr>`;
}

async function fetchClanDetailLive(name) {
    try {
        const res = await apiFetch(`${API_BASE}/clan/${encodeURIComponent(name)}`);
        const detail = await buildLiveDetail(res.data);
        detail.Name = name;
        ui.currentClanDetail = detail;
        if (ui.currentClanName === name) {
            ui.livePointsAsOf = Date.now();
            const idx = topClans().findIndex(c => c.Name.toLowerCase() === name.toLowerCase());
            ui.currentRank = idx !== -1 ? idx + 1 : null;
            renderClanDetail();
        }
    } catch (err) {
        toast(err.message, 'error');
        document.getElementById('clan-detail-sub').textContent = 'Failed to load clan detail.';
    }
}

async function refreshClanDetailLive(name) {
    try {
        const res = await apiFetch(`${API_BASE}/clan/${encodeURIComponent(name)}`);
        if (ui.currentClanName !== name) return;
        const detail = await buildLiveDetail(res.data);
        if (ui.currentClanName !== name) return;
        detail.Name = name;
        ui.currentClanDetail = detail;
        ui.livePointsAsOf = Date.now();
        renderClanDetail();
    } catch (_) {}
}

function renderPlayerLeaderboard() {
    const badge = document.getElementById('event-status-badge');
    const snap = latestPlayerSnapshot();
    badge.innerHTML = snap
        ? `<span class="status-pill status-active">⚡ Updated ${new Date(snap.ts).toLocaleTimeString()}</span>`
        : '';

    const list = displayedPlayers();
    document.getElementById('players-heading').textContent =
        state.playerMode === 'search'
            ? `Search Results (${list.length} match${list.length === 1 ? '' : 'es'})`
            : `Top Players (${topPlayers().length})`;

    document.getElementById('clear-player-search-btn').style.display = state.playerMode === 'search' ? 'inline-block' : 'none';

    const tbody = document.getElementById('players-tbody');
    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-muted)">
          ${state.playerMode === 'search' ? 'No players matched your search.' : 'No data yet — waiting for first snapshot.'}
        </td></tr>`;
        return;
    }

    const globalList = allPlayers();
    tbody.innerHTML = list.map((p, idx) => {
        const color = colorForUser(p.UserID);
        const d10 = playerDelta(p.UserID, p.Points, 10 * 60_000, 11 * 60_000);
        const d30 = playerDelta(p.UserID, p.Points, 30 * 60_000, 8  * 60_000);
        const d1h = playerDelta(p.UserID, p.Points, 60 * 60_000, 12 * 60_000);
        const globalRank = state.playerMode === 'search' ? globalList.findIndex(g => g.UserID === p.UserID) + 1 : idx + 1;
        const rankLabel = globalRank > 0 ? globalRank : '—';
        const isResolved = p.DisplayName !== String(p.UserID);
        const nameHtml = isResolved
            ? `<div>${esc(p.DisplayName)}</div><div style="font-size:10px;color:var(--text-muted);font-weight:400">ID: ${p.UserID}</div>`
            : `<div style="color:var(--text-muted)">${p.UserID}</div>`;
        return `
      <tr onclick="showPlayerDetail(${p.UserID})" style="cursor:pointer">
        <td class="player-rank">${rankLabel}</td>
        <td class="player-name"><span class="st-team-dot" style="background:${color}"></span> <div>${nameHtml}</div></td>
        <td style="font-size:12px;color:var(--text-secondary)">${esc(p.Clan || '—')}</td>
        <td class="player-points" style="color:${color}">${fmt(p.Points)}</td>
        <td style="color:${d10.color};font-size:12px">${d10.text}</td>
        <td style="color:${d30.color};font-size:12px">${d30.text}</td>
        <td style="color:${d1h.color};font-size:12px">${d1h.text}</td>
      </tr>`;
    }).join('');
}

function showPlayerDetail(userId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('player-detail-view').classList.add('active');
    renderPlayerDetailView(userId);
}

function renderPlayerDetailView(userId) {
    const players = allPlayers();
    const player = players.find(p => p.UserID === userId);
    if (!player) {
        toast('Player not found in current snapshot', 'error');
        switchTab('players');
        return;
    }

    const color = colorForUser(userId);
    const rank = players.indexOf(player) + 1;

    const clanMembers = player.Clan
        ? players.filter(p => p.Clan === player.Clan).sort((a, b) => b.Points - a.Points)
        : [];
    const clanRank = clanMembers.findIndex(p => p.UserID === userId) + 1;

    document.getElementById('player-detail-color-bar').style.background = color;
    document.getElementById('player-detail-name').textContent = player.DisplayName;
    document.getElementById('player-detail-sub').textContent = `User ID: ${player.UserID}`;
    document.getElementById('pd-rank').textContent = `#${fmt(rank)}`;
    document.getElementById('pd-clan-rank').textContent = clanRank > 0 ? `#${clanRank} / ${clanMembers.length}` : '—';
    document.getElementById('pd-pts').textContent = fmt(player.Points);
    document.getElementById('pd-clan').textContent = player.Clan || '—';

    const d10 = playerDelta(userId, player.Points, 10 * 60_000, 11 * 60_000);
    const d30 = playerDelta(userId, player.Points, 30 * 60_000, 8  * 60_000);
    const d1h = playerDelta(userId, player.Points, 60 * 60_000, 12 * 60_000);

    const el10 = document.getElementById('pd-delta-10m');
    const el30 = document.getElementById('pd-delta-30m');
    const el1h = document.getElementById('pd-delta-1h');
    el10.textContent = d10.text; el10.style.color = d10.color;
    el30.textContent = d30.text; el30.style.color = d30.color;
    el1h.textContent = d1h.text; el1h.style.color = d1h.color;

    const tbody = document.getElementById('history-tbody');
    const rows = [];
    for (let i = playerSnapshots.length - 1; i >= 0; i--) {
        const snap = playerSnapshots[i];
        const entry = snap.players?.byId?.get(userId);
        if (!entry) continue;
        const prev = i > 0 ? playerSnapshots[i - 1].players?.byId?.get(userId) : null;
        const change = prev ? entry.Points - prev.Points : null;
        rows.push({ ts: snap.ts, points: entry.Points, change });
    }

    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:32px;color:var(--text-muted)">No history available.</td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(r => {
        const changeText = r.change === null ? '—'
            : r.change === 0 ? '+0'
            : (r.change > 0 ? `+${fmt(r.change)}` : `−${fmt(Math.abs(r.change))}`);
        const changeColor = r.change === null ? '' : (r.change > 0 ? 'var(--success)' : (r.change < 0 ? 'var(--danger)' : 'var(--text-muted)'));
        return `
          <tr>
            <td style="font-size:12px">${new Date(r.ts).toLocaleTimeString()}</td>
            <td class="player-points">${fmt(r.points)}</td>
            <td style="color:${changeColor};font-weight:600">${changeText}</td>
          </tr>`;
    }).join('');
}

async function searchClans() {
    const input = document.getElementById('search-clan-name');
    const query = (input?.value || '').trim();
    if (!query) { toast('Enter a clan name', 'error'); return; }

    const btn = document.getElementById('search-clan-btn');
    const setStatus = (msg, type = '') => {
        const el = document.getElementById('search-status');
        el.className = `import-status ${type}`;
        el.innerHTML = type === 'loading' ? `<span class="spinner"></span>${msg}` : msg;
    };

    btn.disabled = true;
    setStatus(`Searching for "${esc(query)}"…`, 'loading');

    try {
        const res = await apiFetch(`${API_BASE}/clan/${encodeURIComponent(query)}`);
        const clan = res.data;
        if (!clan) throw new Error('Clan not found');
        const detail = await buildLiveDetail(clan);
        state.clanSearchResults = [detail];
        state.clanMode = 'search';
        save();
        renderClanLeaderboard();
        setStatus(`✅ Found clan "${esc(detail.Name)}".`, 'success');
    } catch (err) {
        try {
            const queryLower = query.toLowerCase();
            const matches = topClans().filter(c => c.Name.toLowerCase().includes(queryLower));
            if (matches.length) {
                state.clanSearchResults = matches;
                state.clanMode = 'search';
                save();
                renderClanLeaderboard();
                setStatus(`✅ Found ${matches.length} clan(s) matching "${esc(query)}" in Top 500.`, 'success');
            } else {
                setStatus(`❌ Clan "${esc(query)}" not found.`, 'error');
            }
        } catch (_) {
            setStatus(`❌ ${err.message}`, 'error');
        }
    } finally {
        btn.disabled = false;
    }
}

function clearClanSearch() {
    document.getElementById('search-clan-name').value = '';
    document.getElementById('search-status').innerHTML = '';
    if (state.clanMode === 'search') {
        state.clanMode = 'top';
        renderClanLeaderboard();
    }
}

async function searchPlayers() {
    const input = document.getElementById('search-player-name');
    const query = (input?.value || '').trim();
    if (!query) { toast('Enter a player name', 'error'); return; }

    const btn = document.getElementById('search-player-btn');
    const setStatus = (msg, type = '') => {
        const el = document.getElementById('player-search-status');
        el.className = `import-status ${type}`;
        el.innerHTML = type === 'loading' ? `<span class="spinner"></span>${msg}` : msg;
    };

    btn.disabled = true;
    setStatus(`Searching for "${esc(query)}"…`, 'loading');

    const queryLower = query.toLowerCase();
    const localMatches = allPlayers().filter(p =>
        p.DisplayName.toLowerCase().includes(queryLower) ||
        String(p.UserID) === query ||
        (p.Clan && p.Clan.toLowerCase().includes(queryLower))
    );

    state.playerSearchResults = localMatches;
    state.playerMode = 'search';
    save();
    renderPlayerLeaderboard();

    if (localMatches.length) {
        setStatus(`Found ${localMatches.length} player(s).`, 'success');
        const unresolved = localMatches.filter(p => p.DisplayName === String(p.UserID)).map(p => p.UserID);
        if (unresolved.length) {
            setStatus(`Found ${localMatches.length} player(s). Resolving ${unresolved.length} name(s)…`, 'loading');
            const resolved = await resolveUsernames(unresolved);
            const count = Object.keys(resolved).length;
            if (count) {
                for (const p of localMatches) {
                    if (p.DisplayName === String(p.UserID) && (resolved[p.UserID] || resolved[String(p.UserID)])) {
                        p.DisplayName = resolved[p.UserID] || resolved[String(p.UserID)];
                    }
                }
                for (const snap of playerSnapshots) {
                    for (const [, sp] of snap.players.byId) {
                        if (sp.DisplayName === String(sp.UserID) && resolved[sp.UserID]) sp.DisplayName = resolved[sp.UserID];
                    }
                    snap.players.list = [...snap.players.byId.values()].sort((a, b) => b.Points - a.Points);
                }
                renderPlayerLeaderboard();
            }
            setStatus(`Found ${localMatches.length} player(s). Resolved ${count} name(s).`, 'success');
        }
    } else {
        setStatus(`No players found matching "${esc(query)}".`, 'error');
    }
    btn.disabled = false;
}

function clearPlayerSearch() {
    document.getElementById('search-player-name').value = '';
    document.getElementById('player-search-status').innerHTML = '';
    if (state.playerMode === 'search') {
        state.playerMode = 'top';
        save();
        renderPlayerLeaderboard();
    }
}

async function resolveUnresolvedPlayers() {
    const players = topPlayers();
    const unresolved = players.filter(p => p.DisplayName === String(p.UserID)).map(p => p.UserID);
    if (!unresolved.length) return;
    const resolved = await resolveUsernames(unresolved);
    const count = Object.keys(resolved).length;
    if (!count) return;
    for (const snap of playerSnapshots) {
        for (const [, p] of snap.players.byId) {
            if (p.DisplayName === String(p.UserID) && resolved[p.UserID]) {
                p.DisplayName = resolved[p.UserID];
            }
        }
        snap.players.list = [...snap.players.byId.values()].sort((a, b) => b.Points - a.Points);
    }
    if (activeTab === 'players') renderPlayerLeaderboard();
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
        for (const snap of historyData) {
            for (const clan of (snap.clans || [])) {
                for (const p of (clan.roster || [])) {
                    if (p.DisplayName === String(p.UserID)) {
                        const cached = resolvedNamesCache[p.UserID] || resolvedNamesCache[String(p.UserID)];
                        if (cached) p.DisplayName = cached;
                    }
                }
            }
        }
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
        await Promise.all([loadHistory(), fetchLiveClanPoints().catch(() => {})]);
        if (activeTab === 'clans') renderClanLeaderboard();
        else renderPlayerLeaderboard();
        if (ui.currentClanName) refreshClanDetailLive(ui.currentClanName);
        if (!silent) toast('Data refreshed', 'success');
        resolveUnresolvedPlayers();
    } catch (err) {
        if (!silent) toast(err.message || 'Failed to refresh', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh'; }
    }
}

async function pollLivePoints() {
    try {
        await fetchLiveClanPoints();
        if (activeTab === 'clans') renderClanLeaderboard();
        if (ui.currentClanName) refreshClanDetailLive(ui.currentClanName);
    } catch (_) {}
}

document.getElementById('tab-clans').addEventListener('click', () => switchTab('clans'));
document.getElementById('tab-players').addEventListener('click', () => switchTab('players'));
document.getElementById('clan-back-btn').addEventListener('click', showClanLeaderboard);
document.getElementById('player-back-btn').addEventListener('click', () => switchTab('players'));
document.getElementById('refresh-btn').addEventListener('click', () => refreshAll({ silent: false }));
document.getElementById('search-clan-btn').addEventListener('click', searchClans);
document.getElementById('clear-search-btn').addEventListener('click', clearClanSearch);
document.getElementById('search-clan-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); searchClans(); }
});
document.getElementById('search-player-btn').addEventListener('click', searchPlayers);
document.getElementById('clear-player-search-btn').addEventListener('click', clearPlayerSearch);
document.getElementById('search-player-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); searchPlayers(); }
});

setInterval(() => refreshAll({ silent: true }), 10 * 60_000);
setInterval(pollLivePoints, LIVE_POLL_MS);

load();
renderClanLeaderboard();
refreshAll({ silent: false });
