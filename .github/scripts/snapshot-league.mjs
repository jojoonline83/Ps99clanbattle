import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const API_V1             = 'https://ps99.biggamesapi.io/v1';
const SUBDIR             = 'luckyblox2';
const LEAGUE_HISTORY_FILE = `${SUBDIR}/league_history.json`;
const RESOLVED_CACHE_FILE = `${SUBDIR}/resolved_names.json`;
const RETENTION_MS       = 95 * 60 * 1000;
const PAGE_SIZE          = 100;
const LIST_CONCURRENCY   = 10;

async function fetchJson(url, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
            if (res.ok) {
                const json = await res.json();
                if (json.status === 'ok') return json;
            }
        } catch (_) {}
        if (i < attempts - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
    return null;
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

async function resolveUsernames(userIds) {
    const map = {};
    const ROBLOX_URL = 'https://users.roblox.com/v1/users';
    let failedBatches = 0;

    for (let i = 0; i < userIds.length; i += 100) {
        const batch = userIds.slice(i, i + 100);
        if (!batch.length) continue;

        let ok = false;
        for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
            try {
                const res = await fetch(ROBLOX_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userIds: batch, excludeBannedUsers: false }),
                    signal: AbortSignal.timeout(10000),
                });
                if (res.ok) {
                    const json = await res.json();
                    const data = json.data || [];
                    if (data.length === 0) {
                        await new Promise(r => setTimeout(r, 1500 * attempt));
                    } else {
                        data.forEach(u => { map[u.id] = u.displayName || u.name; });
                        ok = true;
                    }
                } else if (res.status === 429) {
                    const retryAfter = Number(res.headers.get('retry-after')) || 0;
                    await new Promise(r => setTimeout(r, Math.max(retryAfter * 1000, 1500 * attempt)));
                } else {
                    await new Promise(r => setTimeout(r, 500 * attempt));
                }
            } catch (_) {
                await new Promise(r => setTimeout(r, 500 * attempt));
            }
        }
        if (!ok) failedBatches++;
        await new Promise(r => setTimeout(r, 500));
    }

    if (failedBatches) console.log(`resolveUsernames: ${failedBatches} batch(es) never succeeded after retries.`);
    return map;
}

const startedAt = Date.now();
const now = Date.now();

mkdirSync(SUBDIR, { recursive: true });

let resolvedCache = {};
if (existsSync(RESOLVED_CACHE_FILE)) {
    try { resolvedCache = JSON.parse(readFileSync(RESOLVED_CACHE_FILE, 'utf8')); } catch (_) { resolvedCache = {}; }
}

const MAX_LEAGUES = 1000;
const leagueSummaries = [];
const BATCH_SIZE = 10;
let page = 1;
let done = false;
while (!done && leagueSummaries.length < MAX_LEAGUES) {
    const batchPages = Array.from({ length: BATCH_SIZE }, (_, i) => page + i);
    const batchResults = await mapWithConcurrency(batchPages, LIST_CONCURRENCY, async p => {
        const json = await fetchJson(`${API_V1}/leagues?page=${p}&pageSize=${PAGE_SIZE}&sort=Points&sortOrder=desc`);
        return json?.data?.leagues || [];
    });
    for (const pageResult of batchResults) {
        if (!pageResult.length) { done = true; break; }
        leagueSummaries.push(...pageResult);
    }
    page += BATCH_SIZE;
}
if (leagueSummaries.length > MAX_LEAGUES) leagueSummaries.length = MAX_LEAGUES;
console.log(`Fetched ${leagueSummaries.length} league summaries (${page - 1} pages scanned).`);

if (!leagueSummaries.length) {
    console.log('No league data returned — skipping snapshot.');
    process.exit(0);
}

async function fetchLeagueDetail(summary) {
    const detailJson = await fetchJson(`${API_V1}/leagues/${encodeURIComponent(summary.Name)}`);
    const detail = detailJson?.data;
    if (!detail) {
        return {
            ID: summary.ID, Name: summary.Name, Points: summary.Points,
            Members: summary.Members, MemberCapacity: summary.MemberCapacity, roster: [], _failed: true,
        };
    }
    const contribByUser = {};
    (detail.PointContributions || []).forEach(c => { contribByUser[c.UserID] = c.Points; });
    const roster = [];
    if (detail.Owner && detail.Owner.UserID) {
        roster.push({
            UserID: detail.Owner.UserID, DisplayName: detail.Owner.DisplayName,
            Points: contribByUser[detail.Owner.UserID] ?? 0, Role: 'Owner',
        });
    }
    (detail.Members || []).forEach(m => {
        roster.push({
            UserID: m.UserID, DisplayName: m.DisplayName,
            Points: contribByUser[m.UserID] ?? 0, Role: 'Member',
        });
    });
    return {
        ID: detail.ID, Name: detail.Name, Points: detail.Points,
        Members: roster.length, MemberCapacity: detail.MemberCapacity,
        Level: detail.Level, roster,
    };
}

let leagueDetails = await mapWithConcurrency(leagueSummaries, 10, fetchLeagueDetail);

const failedIdxs = leagueDetails.map((l, i) => l._failed ? i : -1).filter(i => i >= 0);
if (failedIdxs.length) {
    console.log(`League details: ${failedIdxs.length}/${leagueDetails.length} failed — retrying at lower concurrency...`);
    await new Promise(r => setTimeout(r, 2000));
    const retryResults = await mapWithConcurrency(failedIdxs, 5, async idx => {
        return { idx, result: await fetchLeagueDetail(leagueSummaries[idx]) };
    });
    let fixed = 0;
    for (const { idx, result } of retryResults) {
        if (!result._failed) { leagueDetails[idx] = result; fixed++; }
    }
    console.log(`League details: retry fixed ${fixed}/${failedIdxs.length}.`);
}
leagueDetails.forEach(l => delete l._failed);

const leagueNeedsResolve = [];
leagueDetails.forEach(l => l.roster.forEach(p => {
    if (p.DisplayName === String(p.UserID)) {
        if (resolvedCache[p.UserID]) { p.DisplayName = resolvedCache[p.UserID]; }
        else { leagueNeedsResolve.push(p.UserID); }
    }
}));
if (leagueNeedsResolve.length) {
    const resolved = await resolveUsernames([...new Set(leagueNeedsResolve)]);
    leagueDetails.forEach(l => l.roster.forEach(p => {
        if (p.DisplayName === String(p.UserID) && resolved[p.UserID]) p.DisplayName = resolved[p.UserID];
    }));
    Object.assign(resolvedCache, resolved);
    console.log(`League names resolved: ${Object.keys(resolved).length}/${leagueNeedsResolve.length}`);
}

let leagueHistory = [];
if (existsSync(LEAGUE_HISTORY_FILE)) {
    try { leagueHistory = JSON.parse(readFileSync(LEAGUE_HISTORY_FILE, 'utf8')); } catch (_) { leagueHistory = []; }
}
leagueHistory.push({ ts: now, leagues: leagueDetails });
leagueHistory = leagueHistory.filter(entry => now - entry.ts <= RETENTION_MS);
writeFileSync(LEAGUE_HISTORY_FILE, JSON.stringify(leagueHistory));

writeFileSync(RESOLVED_CACHE_FILE, JSON.stringify(resolvedCache));

const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`League snapshot: ${leagueDetails.length} leagues, ${leagueHistory.length} snapshots retained in ${elapsedSec}s.`);
