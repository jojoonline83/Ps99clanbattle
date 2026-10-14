// Reusable clan battle / league snapshot.
// Usage: node .github/scripts/snapshot-clanbattle.mjs <subdir> [--league] [--title "Event Name"] [--track id,id]
//
// Clan battles: the first run with an active battle "locks" <subdir> to that battle (saved in
// <subdir>/event.json). Later battles are ignored, so a finished event's data is
// never overwritten — a new event just needs a new <subdir>.
// Leagues (--league, /v1/leagues API): there is no "active league" endpoint, so <subdir> is
// marked ended (and never written again) when the points reset that starts the next league.
// Leagues are stored in the same shape as clans, so the pages and files are shared.
//
// Writes: <subdir>/history.json   lean clan points per snapshot
//         <subdir>/players.json   top players per snapshot: { ts, p: [[UserID, Points, clanIdx]], c: [clanNames] }
//         <subdir>/rosters.json   every clan's members: { ts, clans: { Name: [[UserID, Points, d10m, d30m, d1h]] } }
//         <subdir>/resolved_names.json, <subdir>/event.json
// Roster point history (for the per-member deltas) lives in $ROSTER_STATE_FILE, which the
// workflow keeps in the Actions cache so it is not committed to gh-pages.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolveUsernames } from './roblox-names.mjs';
import { loadLeagues } from './league-source.mjs';

const API_BASE           = 'https://ps99.biggamesapi.io/api';
const ARGS               = process.argv.slice(2);
const MODE               = ARGS.includes('--league') ? 'league' : 'clan';
const argValue           = flag => (ARGS.includes(flag) ? ARGS[ARGS.indexOf(flag) + 1] || '' : '');
const TITLE_OVERRIDE     = argValue('--title');
// --track 123,456: user IDs always included in the individual leaderboard (leagues only)
const TRACK_IDS          = argValue('--track').split(',').map(Number).filter(n => n > 0);
const SUBDIR             = ARGS.find((a, i) => !a.startsWith('--') && !['--title', '--track'].includes(ARGS[i - 1]));
if (!SUBDIR || !/^[a-z0-9_-]+$/i.test(SUBDIR)) {
    console.error('Usage: node snapshot-clanbattle.mjs <subdir> [--league] [--title "Event Name"] [--track id,id]');
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
// Time for looking up other members' names each run (runs are ~10 min apart; job timeout is 8 min).
const NAME_BUDGET_MS     = 240_000;
const ROSTERS_FILE       = `${SUBDIR}/rosters.json`;
const ROSTER_STATE_FILE  = process.env.ROSTER_STATE_FILE || `roster-state/${SUBDIR}.json`;
// Same windows as the pages: [window, tolerance]
const DELTA_WINDOWS      = [[10 * 60_000, 11 * 60_000], [30 * 60_000, 8 * 60_000], [60 * 60_000, 12 * 60_000]];

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

let eventInfo = null;
if (existsSync(EVENT_FILE)) {
    try { eventInfo = JSON.parse(readFileSync(EVENT_FILE, 'utf8')); } catch (_) { eventInfo = null; }
}
if (eventInfo?.ended) {
    console.log(`${SUBDIR}/ is marked ended (${eventInfo.endedReason || 'event over'}) — skipping.`);
    process.exit(0);
}
// Clan battle config name; selects the right entry in each clan's Battles.
let battleId = null;

async function detectClanBattle() {
    const battleJson = await fetchJson(`${API_BASE}/activeClanBattle`);
    const activeBattle = battleJson?.data;
    const battleData = activeBattle?.configData;
    if (!battleData || Date.now() / 1000 > battleData.FinishTime) {
        console.log('No active clan battle — skipping snapshot.');
        process.exit(0);
    }
    battleId = String(activeBattle.configName || activeBattle._id || battleData.Title || battleData.Name || 'unknown');
    // "HatchWarBattle2026" -> "Hatch War"
    const battleTitle = String(battleData.Title || battleData.Name || battleData.DisplayName || battleId)
        .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
        .replace(/\s*\bBattle\b\s*/gi, ' ')
        .replace(/\s*\b20\d\d\b\s*/g, ' ')
        .trim() || battleId;
    console.log(`Active clan battle: id="${battleId}" title="${battleTitle}" (configData keys: ${Object.keys(battleData).join(', ')})`);
    if (eventInfo?.id && eventInfo.id !== battleId) {
        console.log(`${SUBDIR}/ is locked to battle "${eventInfo.id}" — active battle "${battleId}" is a different event, skipping.`);
        process.exit(0);
    }
    return {
        id: battleId,
        title: TITLE_OVERRIDE || battleTitle,
        startTime: battleData.StartTime ?? null,
        finishTime: battleData.FinishTime ?? null,
    };
}

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

async function loadClanBattleClans() {
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
    return [...detailedClans, ...zeroClans];
}

function topSum(list, n = 100) {
    return [...list].sort((a, b) => b.Points - a.Points).slice(0, n).reduce((s, c) => s + (Number(c.Points) || 0), 0);
}

// A league runs until the next one resets everyone's points; detect that and stop writing.
function checkLeagueLock(clans, meta) {
    const apiId = String(meta.ConfigName || meta.configName || meta.EventName || meta.Name || meta.name || '') || null;
    const markEnded = reason => {
        writeFileSync(EVENT_FILE, JSON.stringify({ ...eventInfo, ended: true, endedReason: reason, endedAt: Date.now() }));
        console.log(`${SUBDIR}/ league ended: ${reason}. Folder is now frozen.`);
        process.exit(0);
    };
    if (eventInfo?.apiId && apiId && apiId !== eventInfo.apiId) markEnded(`API now reports "${apiId}" instead of "${eventInfo.apiId}"`);
    let prev = null;
    if (existsSync(HISTORY_FILE)) {
        try { prev = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')).at(-1) || null; } catch (_) { prev = null; }
    }
    if (prev?.clans?.length) {
        if (clans.length < prev.clans.length * 0.5) {
            console.log(`Only ${clans.length} leagues returned (last snapshot had ${prev.clans.length}) — looks partial, skipping this run.`);
            process.exit(0);
        }
        const prevSum = topSum(prev.clans), curSum = topSum(clans);
        const prevTop = new Set([...prev.clans].sort((a, b) => b.Points - a.Points).slice(0, 50).map(c => c.Name));
        const overlap = [...clans].sort((a, b) => b.Points - a.Points).slice(0, 50).filter(c => prevTop.has(c.Name)).length / 50;
        if (prevSum > 0 && curSum < prevSum * 0.2 && overlap < 0.5) {
            markEnded(`points reset (top-100 total ${prevSum} -> ${curSum}, ${Math.round(overlap * 100)}% of top 50 unchanged)`);
        }
    }
    return {
        id: eventInfo?.id || apiId || `league-${new Date().toISOString().slice(0, 10)}`,
        apiId: eventInfo?.apiId || apiId,
        kind: 'league',
        title: TITLE_OVERRIDE || eventInfo?.title || apiId || 'League',
        startTime: eventInfo?.startTime ?? Math.floor(Date.now() / 1000),
        finishTime: null,
    };
}

const startedAt = Date.now();
let clans;
let nameHints = {};
let extraPlayers = [];
if (MODE === 'league') {
    const league = await loadLeagues({ trackIds: TRACK_IDS });
    if (!league.clans.length) {
        console.log('No league data returned — skipping snapshot.');
        process.exit(0);
    }
    eventInfo = checkLeagueLock(league.clans, league.meta);
    clans = league.clans;
    nameHints = league.nameHints;
    extraPlayers = league.players;
} else {
    eventInfo = await detectClanBattle();
    clans = await loadClanBattleClans();
}
mkdirSync(SUBDIR, { recursive: true });
writeFileSync(EVENT_FILE, JSON.stringify(eventInfo));
// Snapshot time = when the data was fetched, so slow name lookups don't skew the 10-minute spacing.
const now = Date.now();

// Individual leaderboard: best contribution per player across all clans.
const playerMap = new Map();
for (const c of clans) {
    for (const p of c.roster) {
        if (p.Points <= 0) continue;
        const existing = playerMap.get(p.UserID);
        if (!existing || p.Points > existing.Points) playerMap.set(p.UserID, { UserID: p.UserID, Points: p.Points, Clan: c.Name });
    }
}
// Leagues: merge the individual leaderboard so players outside the top leagues (or in no league) are ranked too.
let extraAdded = 0;
for (const p of extraPlayers) {
    if (p.Points <= 0) continue;
    const existing = playerMap.get(p.UserID);
    if (!existing) extraAdded++;
    if (!existing || p.Points > existing.Points) {
        playerMap.set(p.UserID, { UserID: p.UserID, Points: p.Points, Clan: p.League || existing?.Clan || 'No league' });
    }
}
if (extraPlayers.length) console.log(`Individual leaderboard added ${extraAdded} players not found in the top leagues' rosters.`);
const topPlayers = [...playerMap.values()].sort((a, b) => b.Points - a.Points).slice(0, TOP_PLAYERS);

let resolvedCache = {};
if (existsSync(RESOLVED_CACHE_FILE)) {
    try { resolvedCache = JSON.parse(readFileSync(RESOLVED_CACHE_FILE, 'utf8')); } catch (_) { resolvedCache = {}; }
}
// Names the API already gave us (leagues include DisplayName) — no Roblox lookup needed for these.
Object.assign(resolvedCache, nameHints);

// Top players first, then the remaining clan members (highest points first) while time allows;
// the cache carries over, so every member gets a name within a few runs.
const needsResolve = topPlayers.filter(p => !resolvedCache[p.UserID]).map(p => p.UserID);
if (needsResolve.length) {
    const resolved = await resolveUsernames(needsResolve);
    Object.assign(resolvedCache, resolved);
    console.log(`Resolved ${Object.keys(resolved).length}/${needsResolve.length} new top-player names (${Object.keys(resolvedCache).length} cached total).`);
}
// Every clan member (including 0-point members), highest points first.
const restPoints = new Map();
for (const c of clans) for (const p of c.roster) {
    if (!resolvedCache[p.UserID] && !(restPoints.get(p.UserID) >= p.Points)) restPoints.set(p.UserID, p.Points);
}
const needsResolveRest = [...restPoints.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
if (needsResolveRest.length) {
    const resolved = await resolveUsernames(needsResolveRest, NAME_BUDGET_MS);
    Object.assign(resolvedCache, resolved);
    console.log(`Resolved ${Object.keys(resolved).length}/${needsResolveRest.length} other member names (${Object.keys(resolvedCache).length} cached total).`);
}
writeFileSync(RESOLVED_CACHE_FILE, JSON.stringify(resolvedCache));


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

// Full clan rosters with per-member deltas from the cached roster point history.
let rosterHistory = [];
if (existsSync(ROSTER_STATE_FILE)) {
    try { rosterHistory = JSON.parse(readFileSync(ROSTER_STATE_FILE, 'utf8')); } catch (_) { rosterHistory = []; }
}
rosterHistory = rosterHistory.filter(entry => now - entry.ts <= RETENTION_MS);
const pastSnaps = DELTA_WINDOWS.map(([windowMs, toleranceMs]) => {
    let best = null, bestDiff = Infinity;
    for (const entry of rosterHistory) {
        if (now - entry.ts < windowMs / 2) continue;
        const diff = Math.abs(entry.ts - (now - windowMs));
        if (diff < bestDiff) { bestDiff = diff; best = entry; }
    }
    return best && bestDiff <= toleranceMs ? best.m : null;
});
const currentPoints = {};
const rosters = {};
let rosterMembers = 0;
for (const c of clans) {
    if (!c.roster.length) continue;
    rosters[c.Name] = c.roster.map(p => {
        currentPoints[p.UserID] = p.Points;
        const deltas = pastSnaps.map(m => (m && m[p.UserID] !== undefined ? p.Points - m[p.UserID] : null));
        return [p.UserID, p.Points, ...deltas];
    });
    rosterMembers += c.roster.length;
}
writeFileSync(ROSTERS_FILE, JSON.stringify({ ts: now, clans: rosters }));
rosterHistory.push({ ts: now, m: currentPoints });
mkdirSync(ROSTER_STATE_FILE.replace(/\/[^/]*$/, ''), { recursive: true });
writeFileSync(ROSTER_STATE_FILE, JSON.stringify(rosterHistory));
console.log(`Rosters: ${Object.keys(rosters).length} clans, ${rosterMembers} members; roster history ${rosterHistory.length} snapshots (deltas available: ${pastSnaps.map(m => (m ? 'yes' : 'no')).join('/')}).`);

const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`Snapshot recorded for "${eventInfo.title}": ${clans.length} clans, ${topPlayers.length} players (of ${playerMap.size}) in ${elapsedSec}s, ${history.length} snapshots retained.`);
