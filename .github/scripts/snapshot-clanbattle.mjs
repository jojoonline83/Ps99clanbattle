// Reusable clan battle snapshot.
// Usage: node .github/scripts/snapshot-clanbattle.mjs <subdir>
//
// The first run with an active battle "locks" <subdir> to that battle (saved in
// <subdir>/event.json). Later battles are ignored, so a finished event's data is
// never overwritten — a new event just needs a new <subdir>.
//
// Writes: <subdir>/history.json   lean clan points per snapshot
//         <subdir>/players.json   top players per snapshot: { ts, p: [[UserID, Points, clanIdx]], c: [clanNames] }
//         <subdir>/resolved_names.json, <subdir>/event.json
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const API_BASE           = 'https://ps99.biggamesapi.io/api';
const SUBDIR             = process.argv[2];
if (!SUBDIR || !/^[a-z0-9_-]+$/i.test(SUBDIR)) {
    console.error('Usage: node snapshot-clanbattle.mjs <subdir>');
    process.exit(1);
}
const HISTORY_FILE       = `${SUBDIR}/history.json`;
const PLAYERS_FILE       = `${SUBDIR}/players.json`;
const EVENT_FILE         = `${SUBDIR}/event.json`;
const RESOLVED_CACHE_FILE = `${SUBDIR}/resolved_names.json`;
const RETENTION_MS       = 95 * 60 * 1000;
const TOP_PAGES          = 20;
const PAGE_SIZE          = 50;
const DETAIL_CONCURRENCY = 15;
const TOP_PLAYERS        = 1000;

async function fetchJson(url, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (res.ok) {
                const json = await res.json();
                if (json.status === 'ok') return json;
            }
        } catch (_) {}
        if (i < attempts - 1) await new Promise(r => setTimeout(r, 300));
    }
    return null;
}

const battleJson = await fetchJson(`${API_BASE}/activeClanBattle`);
const activeBattle = battleJson?.data;
const battleData = activeBattle?.configData;
if (!battleData || Date.now() / 1000 > battleData.FinishTime) {
    console.log('No active clan battle — skipping snapshot.');
    process.exit(0);
}
const battleId = String(activeBattle.configName || activeBattle._id || battleData.Title || battleData.Name || 'unknown');
// "HatchWarBattle2026" -> "Hatch War"
const battleTitle = String(battleData.Title || battleData.Name || battleData.DisplayName || battleId)
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/\s*\bBattle\b\s*/gi, ' ')
    .replace(/\s*\b20\d\d\b\s*/g, ' ')
    .trim() || battleId;
console.log(`Active clan battle: id="${battleId}" title="${battleTitle}" (configData keys: ${Object.keys(battleData).join(', ')})`);

let eventInfo = null;
if (existsSync(EVENT_FILE)) {
    try { eventInfo = JSON.parse(readFileSync(EVENT_FILE, 'utf8')); } catch (_) { eventInfo = null; }
}
if (eventInfo?.id && eventInfo.id !== battleId) {
    console.log(`${SUBDIR}/ is locked to battle "${eventInfo.id}" — active battle "${battleId}" is a different event, skipping.`);
    process.exit(0);
}
mkdirSync(SUBDIR, { recursive: true });
eventInfo = {
    id: battleId,
    title: battleTitle,
    startTime: battleData.StartTime ?? null,
    finishTime: battleData.FinishTime ?? null,
};
writeFileSync(EVENT_FILE, JSON.stringify(eventInfo));

async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let idx = 0;
    async function worker() {
        while (idx < items.length) {
            const i = idx++;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

function firstDefined(...args) {
    for (const a of args) if (a !== undefined && a !== null) return a;
    return undefined;
}

function asNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function buildClanFromDetail(detail, summary) {
    const members = Array.isArray(detail.Members) ? detail.Members : [];
    const battles = detail.Battles || detail.battles || {};
    const battleKeys = Object.keys(battles);
    let battleData = battles[battleId] || (battleKeys.length ? battles[battleKeys[battleKeys.length - 1]] : null);

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
            detail.Contribution?.Battle, detail.contribution?.battle,
            detail.Contributions?.Battle, detail.contributions?.battle
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
        roster.push({ UserID: uid, DisplayName: String(uid), Points: contribByUser[uid] ?? 0 });
    }
    for (const [uidStr, pts] of Object.entries(contribByUser)) {
        const uid = Number(uidStr);
        if (!seen.has(uid) && uid > 0) {
            roster.push({ UserID: uid, DisplayName: String(uid), Points: pts });
        }
    }

    roster.sort((a, b) => b.Points - a.Points);
    return {
        Name: detail.Name || detail.name || summary.Name,
        Points: summary.Points,
        Members: roster.length,
        roster,
    };
}

async function resolveUsernames(userIds, deadlineMs = 60_000) {
    const map = {};
    const sent = new Set();
    const ROBLOX_URL = 'https://users.roblox.com/v1/users';
    const deadline = Date.now() + deadlineMs;
    const batches = [];
    for (let i = 0; i < userIds.length; i += 100) {
        const batch = userIds.slice(i, i + 100);
        if (batch.length) batches.push(batch);
    }

    let skipped = 0;
    async function resolveBatch(batch) {
        if (Date.now() > deadline) { skipped++; return false; }
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (Date.now() > deadline) { skipped++; return false; }
            try {
                const res = await fetch(ROBLOX_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userIds: batch, excludeBannedUsers: false }),
                    signal: AbortSignal.timeout(8000),
                });
                if (res.ok) {
                    const json = await res.json();
                    const data = json.data || [];
                    batch.forEach(uid => sent.add(uid));
                    data.forEach(u => { map[u.id] = u.displayName || u.name; });
                    return true;
                } else if (res.status === 429) {
                    const retryAfter = Number(res.headers.get('retry-after')) || 0;
                    await new Promise(r => setTimeout(r, Math.max(retryAfter * 1000, 2000 * attempt)));
                } else {
                    await new Promise(r => setTimeout(r, 500 * attempt));
                }
            } catch (_) {
                await new Promise(r => setTimeout(r, 500 * attempt));
            }
        }
        return false;
    }

    await mapWithConcurrency(batches, 2, resolveBatch);
    if (skipped) console.log(`resolveUsernames: ${skipped} batch(es) skipped (deadline).`);

    let unresolvable = 0;
    for (const uid of sent) {
        if (!map[uid]) { map[uid] = String(uid); unresolvable++; }
    }
    if (unresolvable) console.log(`  ${unresolvable} user(s) marked unresolvable (Roblox returned no data).`);
    return map;
}

const startedAt = Date.now();

const pageResults = await Promise.all(
    Array.from({ length: TOP_PAGES }, (_, i) =>
        fetchJson(`${API_BASE}/clans?page=${i + 1}&pageSize=${PAGE_SIZE}&sort=Points&sortOrder=desc`)
    )
);
const summaries = [];
for (const json of pageResults) {
    const data = json?.data;
    if (!Array.isArray(data) || !data.length) continue;
    for (const raw of data) {
        summaries.push({
            Name: firstDefined(raw.Name, raw.name, raw.ClanName, raw.clanName) || 'Unknown',
            Points: asNumber(firstDefined(raw.Points, raw.points, raw.Score, raw.score, raw.Total, raw.total)),
            Members: asNumber(firstDefined(raw.Members, raw.members, raw.MemberCount, raw.memberCount)),
        });
        if (summaries.length >= 1000) break;
    }
    if (summaries.length >= 1000) break;
}

if (!summaries.length) {
    console.error('No clan data returned — skipping this snapshot.');
    process.exit(0);
}

const withPoints = summaries.filter(s => s.Points > 0);
console.log(`Fetched ${summaries.length} clan summaries (${withPoints.length} with points). Fetching detail…`);

const DETAIL_DEADLINE = Date.now() + 45_000;
let detailDone = 0;
let detailFailed = 0;

const detailedClans = await mapWithConcurrency(withPoints, DETAIL_CONCURRENCY, async summary => {
    if (Date.now() > DETAIL_DEADLINE) {
        detailFailed++;
        return { Name: summary.Name, Points: summary.Points, Members: summary.Members, roster: [] };
    }
    const detailJson = await fetchJson(`${API_BASE}/clan/${encodeURIComponent(summary.Name)}`);
    const detail = detailJson?.data;
    detailDone++;
    if (detailDone % 50 === 0) console.log(`  detail progress: ${detailDone}/${withPoints.length}`);

    if (!detail) {
        detailFailed++;
        return { Name: summary.Name, Points: summary.Points, Members: summary.Members, roster: [] };
    }

    return buildClanFromDetail(detail, summary);
});
if (detailFailed) console.log(`  ${detailFailed} clan detail(s) skipped or failed.`);

const emptyIdxs = detailedClans.map((c, i) => (!c.roster || !c.roster.length) && withPoints[i].Points > 0 ? i : -1).filter(i => i >= 0);
if (emptyIdxs.length) {
    console.log(`Retrying ${emptyIdxs.length} clans with empty roster at lower concurrency...`);
    await new Promise(r => setTimeout(r, 1000));
    const retryResults = await mapWithConcurrency(emptyIdxs, 5, async idx => {
        const summary = withPoints[idx];
        const detailJson = await fetchJson(`${API_BASE}/clan/${encodeURIComponent(summary.Name)}`);
        const detail = detailJson?.data;
        if (!detail) return null;
        return { idx, result: buildClanFromDetail(detail, summary) };
    });
    let fixed = 0;
    for (const r of retryResults) {
        if (r && r.result.roster.length > 0) { detailedClans[r.idx] = r.result; fixed++; }
    }
    console.log(`  Retry fixed ${fixed}/${emptyIdxs.length} rosters.`);

    // Second, slower pass for clans the API still rate-limited.
    const stillEmpty = emptyIdxs.filter(i => !detailedClans[i].roster?.length);
    if (stillEmpty.length) {
        console.log(`Second retry for ${stillEmpty.length} clans...`);
        await new Promise(r => setTimeout(r, 3000));
        const RETRY_DEADLINE = Date.now() + 90_000;
        let fixed2 = 0;
        await mapWithConcurrency(stillEmpty, 2, async idx => {
            if (Date.now() > RETRY_DEADLINE) return;
            const summary = withPoints[idx];
            const detailJson = await fetchJson(`${API_BASE}/clan/${encodeURIComponent(summary.Name)}`, 4);
            if (!detailJson?.data) return;
            const result = buildClanFromDetail(detailJson.data, summary);
            if (result.roster.length) { detailedClans[idx] = result; fixed2++; }
        });
        console.log(`  Second retry fixed ${fixed2}/${stillEmpty.length} rosters.`);
    }
}

const zeroClans = summaries.filter(s => s.Points <= 0).map(s => ({
    Name: s.Name, Points: 0, Members: s.Members, roster: [],
}));
const clans = [...detailedClans, ...zeroClans];

// Individual leaderboard: best contribution per player across all clans.
const playerMap = new Map();
for (const c of clans) {
    for (const p of c.roster) {
        if (p.Points <= 0) continue;
        const existing = playerMap.get(p.UserID);
        if (!existing || p.Points > existing.Points) playerMap.set(p.UserID, { UserID: p.UserID, Points: p.Points, Clan: c.Name });
    }
}
const topPlayers = [...playerMap.values()].sort((a, b) => b.Points - a.Points).slice(0, TOP_PLAYERS);

let resolvedCache = {};
if (existsSync(RESOLVED_CACHE_FILE)) {
    try { resolvedCache = JSON.parse(readFileSync(RESOLVED_CACHE_FILE, 'utf8')); } catch (_) { resolvedCache = {}; }
}

// Only the top players need names server-side; clan rosters resolve in the browser.
const needsResolve = topPlayers.filter(p => !resolvedCache[p.UserID]).map(p => p.UserID);
if (needsResolve.length) {
    const resolved = await resolveUsernames(needsResolve);
    Object.assign(resolvedCache, resolved);
    console.log(`Resolved ${Object.keys(resolved).length}/${needsResolve.length} new display names (${Object.keys(resolvedCache).length} cached total).`);
}
writeFileSync(RESOLVED_CACHE_FILE, JSON.stringify(resolvedCache));

const now = Date.now();

let history = [];
if (existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')); } catch (_) { history = []; }
}
const leanClans = clans.map(c => ({ Name: c.Name, Points: c.Points, Members: c.Members }));
history.push({ ts: now, clans: leanClans });
history = history.filter(entry => now - entry.ts <= RETENTION_MS);
writeFileSync(HISTORY_FILE, JSON.stringify(history));

let playerHistory = [];
if (existsSync(PLAYERS_FILE)) {
    try { playerHistory = JSON.parse(readFileSync(PLAYERS_FILE, 'utf8')); } catch (_) { playerHistory = []; }
}
const clanNames = [...new Set(topPlayers.map(p => p.Clan))];
const clanIdx = new Map(clanNames.map((n, i) => [n, i]));
playerHistory.push({ ts: now, c: clanNames, p: topPlayers.map(p => [p.UserID, p.Points, clanIdx.get(p.Clan)]) });
playerHistory = playerHistory.filter(entry => now - entry.ts <= RETENTION_MS);
writeFileSync(PLAYERS_FILE, JSON.stringify(playerHistory));

const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`Snapshot recorded for "${eventInfo.title}": ${clans.length} clans, ${topPlayers.length} players (of ${playerMap.size}) in ${elapsedSec}s, ${history.length} snapshots retained.`);
