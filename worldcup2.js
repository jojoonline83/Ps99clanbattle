/* ═══════════════════════════════════════════
   PS99 World Cup II — League Tracker App Logic
   ═══════════════════════════════════════════ */

'use strict';

document.title = 'PS99 World Cup II [v1]';

// ── Constants ──────────────────────────────
const STORAGE_KEY  = 'ps99_worldcup2_v1';
const API_BASE      = 'https://biggamesapi.io/api';
const CORS_PROXIES  = [
    'https://corsproxy.io/?url=',
    'https://api.allorigins.win/raw?url=',
];

const PALETTE = [
    '#6366f1', '#ec4899', '#10b981', '#f59e0b',
    '#ef4444', '#06b6d4', '#8b5cf6', '#f97316',
    '#14b8a6', '#a855f7', '#84cc16', '#3b82f6',
];

const POINTS_WIN  = 3;
const POINTS_DRAW = 1;
const POINTS_LOSS = 0;

// ── State ──────────────────────────────────
let state = {
    event: { name: 'PS99 World Cup II', startDate: '', endDate: '' },
    groups: [],
    teams: [],
    matches: [],
    nextColorIdx: 0,
};

let ui = {
    currentTeamId: null,
    editingMatchId: null,
    confirmCallback: null,
};

// ── Persistence ────────────────────────────
function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
}

function load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) state = { ...state, ...JSON.parse(raw) };
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

function getGroup(id) { return state.groups.find(g => g.id === id); }
function getTeam(id)  { return state.teams.find(t => t.id === id); }
function teamsInGroup(groupId) { return state.teams.filter(t => t.groupId === groupId); }
function matchesInGroup(groupId) { return state.matches.filter(m => m.groupId === groupId); }

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
function confirmDialog(title, message, onOk) {
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

    if (name === 'standings') renderStandings();
    if (name === 'matches')   renderMatchesView();
    if (name === 'manage')    renderManage();
}

function showTeamDetail(teamId) {
    ui.currentTeamId = teamId;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('team-detail-view').classList.add('active');
    renderTeamDetail();
}

// ── Standings computation ──────────────────
function computeStandings(groupId) {
    const teams = teamsInGroup(groupId);
    const table = teams.map(team => ({
        team, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, pts: 0,
    }));
    const rowFor = id => table.find(r => r.team.id === id);

    matchesInGroup(groupId).forEach(m => {
        const home = rowFor(m.homeId);
        const away = rowFor(m.awayId);
        if (!home || !away) return;
        const hs = Number(m.homeScore) || 0;
        const as = Number(m.awayScore) || 0;

        home.played++; away.played++;
        home.gf += hs; home.ga += as;
        away.gf += as; away.ga += hs;

        if (hs > as)      { home.won++;   away.lost++;  home.pts += POINTS_WIN;  away.pts += POINTS_LOSS; }
        else if (hs < as) { away.won++;   home.lost++;  away.pts += POINTS_WIN;  home.pts += POINTS_LOSS; }
        else              { home.drawn++; away.drawn++; home.pts += POINTS_DRAW; away.pts += POINTS_DRAW; }
    });

    table.forEach(r => { r.gd = r.gf - r.ga; });

    table.sort((a, b) =>
        b.pts - a.pts ||
        b.gd  - a.gd  ||
        b.gf  - a.gf  ||
        a.team.name.localeCompare(b.team.name)
    );

    return table;
}

function teamGroupRank(teamId) {
    const team = getTeam(teamId);
    if (!team) return null;
    const table = computeStandings(team.groupId);
    const idx = table.findIndex(r => r.team.id === teamId);
    return idx === -1 ? null : { rank: idx + 1, total: table.length, row: table[idx] };
}

// ── Standings View ─────────────────────────
function renderStandings() {
    const { event } = state;
    document.getElementById('event-title').textContent = event.name || 'PS99 World Cup II';

    let dateStr = '';
    if (event.startDate && event.endDate) {
        const s = new Date(event.startDate + 'T00:00:00');
        const e = new Date(event.endDate   + 'T00:00:00');
        dateStr = `${s.toLocaleDateString('en-US',{month:'short',day:'numeric'})} – ${e.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`;
    }
    document.getElementById('event-dates').textContent = dateStr;

    const badge = document.getElementById('event-status-badge');
    badge.innerHTML = state.groups.length
        ? '<span class="status-pill status-active">⚡ Tracking</span>'
        : '';

    const container = document.getElementById('groups-container');

    if (state.groups.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">🏆</div>
            <p>No groups set up yet</p>
            <small>Head to <strong>Manage</strong> to create groups and add teams</small>
          </div>`;
        return;
    }

    container.innerHTML = state.groups.map(group => {
        const table = computeStandings(group.id);
        const rows = table.length
            ? table.map((r, idx) => {
                const gdClass = r.gd > 0 ? 'st-gd-pos' : (r.gd < 0 ? 'st-gd-neg' : '');
                const gdText  = r.gd > 0 ? `+${r.gd}` : r.gd;
                const qualifyClass = idx === 1 && table.length > 2 ? 'qualify-row' : '';
                return `
                  <tr class="${qualifyClass}" onclick="showTeamDetail('${r.team.id}')">
                    <td class="st-rank">${idx + 1}</td>
                    <td class="st-team"><span class="st-team-dot" style="background:${r.team.color}"></span>${esc(r.team.name)}</td>
                    <td>${r.played}</td>
                    <td>${r.won}</td>
                    <td>${r.drawn}</td>
                    <td>${r.lost}</td>
                    <td class="${gdClass}">${gdText}</td>
                    <td class="st-pts">${r.pts}</td>
                  </tr>`;
              }).join('')
            : `<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">No teams in this group yet</td></tr>`;

        return `
          <div class="group-card">
            <div class="group-card-title">${esc(group.name)}</div>
            <table class="standings-table">
              <thead>
                <tr>
                  <th>#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`;
    }).join('');
}

// ── Team Detail View ───────────────────────
function renderTeamDetail() {
    const team = getTeam(ui.currentTeamId);
    if (!team) { switchView('standings'); return; }
    const group = getGroup(team.groupId);
    const info  = teamGroupRank(team.id);
    const row   = info ? info.row : { played: 0, won: 0, drawn: 0, lost: 0, gd: 0, pts: 0 };

    document.getElementById('team-detail-color-bar').style.background = team.color;
    document.getElementById('team-detail-name').textContent = team.name;
    document.getElementById('team-detail-group').textContent =
        (group ? group.name : 'No group') + (team.tag ? ' · ' + team.tag : '');

    document.getElementById('td-played').textContent = row.played;
    document.getElementById('td-wdl').textContent = `${row.won}-${row.drawn}-${row.lost}`;
    document.getElementById('td-gd').textContent = row.gd > 0 ? `+${row.gd}` : row.gd;
    document.getElementById('td-pts').textContent = row.pts;
    document.getElementById('td-rank').textContent = info ? `#${info.rank} of ${info.total}` : '—';

    const teamMatches = state.matches
        .filter(m => m.homeId === team.id || m.awayId === team.id)
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    const tbody = document.getElementById('team-matches-tbody');
    if (!teamMatches.length) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:32px;color:var(--text-muted)">No matches recorded yet</td></tr>`;
        return;
    }

    tbody.innerHTML = teamMatches.map(m => {
        const isHome   = m.homeId === team.id;
        const oppId    = isHome ? m.awayId : m.homeId;
        const opp      = getTeam(oppId);
        const myScore  = isHome ? m.homeScore : m.awayScore;
        const oppScore = isHome ? m.awayScore : m.homeScore;
        let resultClass = 'result-draw', resultText = 'Draw';
        if (myScore > oppScore) { resultClass = 'result-win';  resultText = 'Win'; }
        if (myScore < oppScore) { resultClass = 'result-loss'; resultText = 'Loss'; }

        return `
          <tr>
            <td>${m.date ? esc(m.date) : '—'}</td>
            <td>${opp ? esc(opp.name) : 'Unknown team'}</td>
            <td>${myScore} – ${oppScore}</td>
            <td class="${resultClass}">${resultText}</td>
          </tr>`;
    }).join('');
}

// ── Matches View ───────────────────────────
function populateGroupSelect(selectEl, { includeAll = false } = {}) {
    const opts = state.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
    selectEl.innerHTML = (includeAll ? '<option value="">All Groups</option>' : '') + opts;
}

function populateTeamSelect(selectEl, groupId) {
    const teams = groupId ? teamsInGroup(groupId) : state.teams;
    selectEl.innerHTML = teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
}

function renderMatchesView() {
    const groupSel  = document.getElementById('match-group');
    const filterSel = document.getElementById('match-filter-group');
    const prevGroupVal = groupSel.value;
    const prevFilterVal = filterSel.value;

    populateGroupSelect(groupSel);
    populateGroupSelect(filterSel, { includeAll: true });
    if (state.groups.some(g => g.id === prevGroupVal)) groupSel.value = prevGroupVal;
    if (prevFilterVal && state.groups.some(g => g.id === prevFilterVal)) filterSel.value = prevFilterVal;

    populateTeamSelect(document.getElementById('match-home'), groupSel.value);
    populateTeamSelect(document.getElementById('match-away'), groupSel.value);

    renderMatchesList();
}

function renderMatchesList() {
    const filterGroup = document.getElementById('match-filter-group').value;
    const matches = state.matches
        .filter(m => !filterGroup || m.groupId === filterGroup)
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    const listEl = document.getElementById('matches-list');
    if (!matches.length) {
        listEl.innerHTML = `<div style="color:var(--text-muted);text-align:center;padding:24px;font-size:13px">No match results recorded yet.</div>`;
        return;
    }

    listEl.innerHTML = matches.map(m => {
        const home  = getTeam(m.homeId);
        const away  = getTeam(m.awayId);
        const group = getGroup(m.groupId);
        return `
          <div class="manage-clan-row">
            <span class="mcr-sub">${m.date ? esc(m.date) : 'No date'}</span>
            <span class="mcr-name">
              ${home ? esc(home.name) : '?'} <strong>${m.homeScore} – ${m.awayScore}</strong> ${away ? esc(away.name) : '?'}
            </span>
            <span class="mcr-tag">${group ? esc(group.name) : ''}</span>
            <button class="btn-icon" onclick="editMatch('${m.id}')" title="Edit result">✏️</button>
            <button class="btn-icon del" onclick="deleteMatch('${m.id}')" title="Delete result">🗑️</button>
          </div>`;
    }).join('');
}

function editMatch(matchId) {
    const m = state.matches.find(x => x.id === matchId);
    if (!m) return;
    ui.editingMatchId = matchId;

    document.getElementById('match-group').value = m.groupId;
    populateTeamSelect(document.getElementById('match-home'), m.groupId);
    populateTeamSelect(document.getElementById('match-away'), m.groupId);
    document.getElementById('match-home').value = m.homeId;
    document.getElementById('match-away').value = m.awayId;
    document.getElementById('match-home-score').value = m.homeScore;
    document.getElementById('match-away-score').value = m.awayScore;
    document.getElementById('match-date').value = m.date || '';

    document.getElementById('match-form-title').textContent = 'Edit Match Result';
    document.getElementById('match-submit-btn').textContent = 'Update Result';
    document.getElementById('match-cancel-edit').style.display = 'inline-block';
    document.getElementById('match-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEditMatch() {
    ui.editingMatchId = null;
    document.getElementById('match-form').reset();
    document.getElementById('match-form-title').textContent = 'Record Match Result';
    document.getElementById('match-submit-btn').textContent = 'Save Result';
    document.getElementById('match-cancel-edit').style.display = 'none';
}

function deleteMatch(matchId) {
    const m = state.matches.find(x => x.id === matchId);
    if (!m) return;
    const home = getTeam(m.homeId), away = getTeam(m.awayId);
    confirmDialog(
        'Delete Match',
        `Delete the result "${home?.name || '?'} ${m.homeScore}-${m.awayScore} ${away?.name || '?'}"? This cannot be undone.`,
        () => {
            state.matches = state.matches.filter(x => x.id !== matchId);
            save();
            renderMatchesList();
            renderStandings();
            toast('Match deleted');
        }
    );
}

// ── Manage View ────────────────────────────
function renderManage() {
    const { event } = state;
    document.getElementById('event-name').value  = event.name || '';
    document.getElementById('event-start').value = event.startDate || '';
    document.getElementById('event-end').value   = event.endDate   || '';

    // Groups list
    const groupsListEl = document.getElementById('groups-list');
    groupsListEl.innerHTML = state.groups.length
        ? state.groups.map(g => `
            <div class="manage-clan-row">
              <span class="mcr-name">${esc(g.name)}</span>
              <span class="mcr-count">${teamsInGroup(g.id).length} teams</span>
              <button class="btn-icon del" onclick="deleteGroup('${g.id}')" title="Delete group">🗑️</button>
            </div>`).join('')
        : `<div style="color:var(--text-muted);text-align:center;padding:12px;font-size:13px">No groups yet.</div>`;

    // Team group select + color swatches
    populateGroupSelect(document.getElementById('new-team-group'));
    const colorContainer = document.getElementById('color-options');
    colorContainer.innerHTML = PALETTE.map((color, idx) => `
      <div class="color-swatch ${idx === state.nextColorIdx ? 'selected' : ''}"
           style="background:${color}"
           onclick="selectColor(${idx})"
           title="${color}"></div>
    `).join('');

    // Teams list
    const teamsListEl = document.getElementById('manage-teams-list');
    document.getElementById('team-count-badge').textContent = state.teams.length;

    if (state.teams.length === 0) {
        teamsListEl.innerHTML = `<div style="color:var(--text-muted);text-align:center;padding:24px;font-size:13px">No teams added. Use the form above to add one.</div>`;
        return;
    }

    teamsListEl.innerHTML = [...state.teams]
        .sort((a, b) => (getGroup(a.groupId)?.name || '').localeCompare(getGroup(b.groupId)?.name || '') || a.name.localeCompare(b.name))
        .map(team => {
            const group = getGroup(team.groupId);
            const info  = teamGroupRank(team.id);
            return `
              <div class="manage-clan-row">
                <div class="clan-color-dot" style="background:${team.color}"></div>
                <span class="mcr-name">
                  ${esc(team.name)}
                  ${team.tag ? `<span class="mcr-tag">${esc(team.tag)}</span>` : ''}
                </span>
                <span class="mcr-tag">${group ? esc(group.name) : 'No group'}</span>
                <span class="mcr-pts">${info ? info.row.pts + ' pts' : ''}</span>
                <button class="btn-icon" onclick="showTeamDetail('${team.id}')" title="View team">👁️</button>
                <button class="btn-icon del" onclick="deleteTeam('${team.id}')" title="Delete team">🗑️</button>
              </div>`;
        }).join('');
}

function selectColor(idx) {
    state.nextColorIdx = idx;
    document.querySelectorAll('.color-swatch').forEach((sw, i) => {
        sw.classList.toggle('selected', i === idx);
    });
}

function deleteGroup(groupId) {
    const group = getGroup(groupId);
    if (!group) return;
    const teamCount = teamsInGroup(groupId).length;
    if (teamCount > 0) {
        toast(`Remove or reassign the ${teamCount} team(s) in "${group.name}" first`, 'error');
        return;
    }
    confirmDialog(
        'Delete Group',
        `Delete group "${group.name}"? This cannot be undone.`,
        () => {
            state.groups = state.groups.filter(g => g.id !== groupId);
            state.matches = state.matches.filter(m => m.groupId !== groupId);
            save();
            renderManage();
            renderStandings();
            toast(`"${group.name}" deleted`);
        }
    );
}

function deleteTeam(teamId) {
    const team = getTeam(teamId);
    if (!team) return;
    const matchCount = state.matches.filter(m => m.homeId === teamId || m.awayId === teamId).length;
    confirmDialog(
        'Delete Team',
        `Delete "${team.name}"?${matchCount ? ` Its ${matchCount} recorded match result(s) will also be deleted.` : ''} This cannot be undone.`,
        () => {
            state.teams = state.teams.filter(t => t.id !== teamId);
            state.matches = state.matches.filter(m => m.homeId !== teamId && m.awayId !== teamId);
            save();
            renderManage();
            renderStandings();
            toast(`"${team.name}" deleted`);
        }
    );
}

// ── Live PS99 Clan Lookup (read-only, cosmetic) ────
function setLookupStatus(msg, type = '') {
    const el = document.getElementById('lookup-status');
    if (!el) return;
    el.className = `import-status ${type}`;
    el.innerHTML = type === 'loading' ? `<span class="spinner"></span>${msg}` : msg;
}

async function apiFetch(path) {
    const url = `${API_BASE}${path}`;
    const isValid = d => d && typeof d === 'object' && !d.error && !d.Error
        && !(typeof d.message === 'string' && d.message.toLowerCase().includes('timeout'));

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

async function lookupClan() {
    const input = document.getElementById('lookup-clan-name');
    const name  = (input?.value || '').trim();
    if (!name) { toast('Enter a clan name', 'error'); return; }

    const btn = document.getElementById('lookup-clan-btn');
    btn.disabled = true;
    setLookupStatus(`Looking up "${name}"…`, 'loading');

    try {
        const raw = await apiFetch(`/clan/${encodeURIComponent(name)}`);
        if (raw.status !== 'ok' || !raw.data) throw new Error(`Clan "${name}" not found`);
        const clan = raw.data;
        const memberCount = (clan.Members || clan.members || []).length;
        setLookupStatus(
            `✅ Found <strong>${esc(clan.Name || name)}</strong> — ${memberCount} members. ` +
            `<button class="btn-icon" style="width:auto;padding:4px 10px;display:inline-flex" onclick="useClanAsTeam('${esc(clan.Name || name).replace(/'/g, "\\'")}')">Use as Team ↓</button>`,
            'success'
        );
    } catch (err) {
        setLookupStatus(`❌ ${err.message}`, 'error');
    } finally {
        btn.disabled = false;
    }
}

function useClanAsTeam(clanName) {
    document.getElementById('new-team-name').value = clanName;
    document.getElementById('new-team-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('new-team-name').focus();
}

// ── Event Listeners ────────────────────────

document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
});

document.getElementById('team-back-btn').addEventListener('click', () => switchView('standings'));

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

// Event settings form
document.getElementById('event-form').addEventListener('submit', e => {
    e.preventDefault();
    state.event.name      = document.getElementById('event-name').value.trim() || 'PS99 World Cup II';
    state.event.startDate = document.getElementById('event-start').value;
    state.event.endDate   = document.getElementById('event-end').value;
    save();
    toast('Event info saved');
});

// Add group form
document.getElementById('add-group-form').addEventListener('submit', e => {
    e.preventDefault();
    const nameInput = document.getElementById('new-group-name');
    const name = nameInput.value.trim();
    if (!name) { toast('Enter a group name', 'error'); return; }
    state.groups.push({ id: uid(), name });
    nameInput.value = '';
    save();
    renderManage();
    toast(`Group "${name}" added`);
});

// Add team form
document.getElementById('add-team-form').addEventListener('submit', e => {
    e.preventDefault();
    const name = document.getElementById('new-team-name').value.trim();
    const groupId = document.getElementById('new-team-group').value;
    if (!name) { toast('Enter a team name', 'error'); return; }
    if (!groupId) { toast('Create a group first', 'error'); return; }

    const color = PALETTE[state.nextColorIdx % PALETTE.length];
    state.teams.push({
        id: uid(), name,
        tag: document.getElementById('new-team-tag').value.trim(),
        color, groupId,
    });
    state.nextColorIdx = (state.nextColorIdx + 1) % PALETTE.length;

    document.getElementById('new-team-name').value = '';
    document.getElementById('new-team-tag').value  = '';

    save();
    renderManage();
    toast(`"${name}" added to group`);
});

// Live clan lookup
document.getElementById('lookup-clan-btn')?.addEventListener('click', lookupClan);
document.getElementById('lookup-clan-name')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); lookupClan(); }
});

// Matches: group select changes which teams are selectable
document.getElementById('match-group').addEventListener('change', () => {
    const groupId = document.getElementById('match-group').value;
    populateTeamSelect(document.getElementById('match-home'), groupId);
    populateTeamSelect(document.getElementById('match-away'), groupId);
});

document.getElementById('match-filter-group').addEventListener('change', renderMatchesList);

document.getElementById('match-cancel-edit').addEventListener('click', cancelEditMatch);

// Match form submit (add or update)
document.getElementById('match-form').addEventListener('submit', e => {
    e.preventDefault();
    const groupId    = document.getElementById('match-group').value;
    const homeId     = document.getElementById('match-home').value;
    const awayId     = document.getElementById('match-away').value;
    const homeScore  = Number(document.getElementById('match-home-score').value);
    const awayScore  = Number(document.getElementById('match-away-score').value);
    const date       = document.getElementById('match-date').value;

    if (!groupId) { toast('Select a group', 'error'); return; }
    if (!homeId || !awayId) { toast('Select both teams', 'error'); return; }
    if (homeId === awayId) { toast('Home and away teams must differ', 'error'); return; }
    if (Number.isNaN(homeScore) || Number.isNaN(awayScore)) { toast('Enter both scores', 'error'); return; }

    if (ui.editingMatchId) {
        const m = state.matches.find(x => x.id === ui.editingMatchId);
        if (m) Object.assign(m, { groupId, homeId, awayId, homeScore, awayScore, date });
        toast('Match result updated');
    } else {
        state.matches.push({ id: uid(), groupId, homeId, awayId, homeScore, awayScore, date });
        toast('Match result saved');
    }

    save();
    cancelEditMatch();
    renderMatchesList();
    renderStandings();
});

// ── Bootstrap ──────────────────────────────
load();
renderStandings();
