import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const API_BASE           = 'https://ps99.biggamesapi.io/api';
const SUBDIR             = 'luckyblox';
const HISTORY_FILE       = `${SUBDIR}/history.json`;
const RESOLVED_CACHE_FILE = `${SUBDIR}/resolved_names.json`;
const RETENTION_MS       = 95 * 60 * 1000;
const TOP_PAGES          = 10;
const PAGE_SIZE          = 50;
const DETAIL_CONCURRENCY = 50;

async function fetchJson(url, attempts = 2) {
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
const battleData = battleJson?.data?.configData;
if (!battleData || Date.now() / 1000 > battleData.FinishTime) {
    console.log('No active clan battle — skipping snapshot.');
    process.exit(0);
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

function isUnresolvedName(entry) {
    return entry.DisplayName === String(entry.UserID);
}

function buildClanFromDetail(detail, summary) {
    const members = Array.isArray(detail.Members) ? detail.Members : [];
    const battles = detail.Battles || detail.battles || {};
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

async function resolveUsernames(userIds, deadlineMs = 240_000) {
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
        for (let attempt = 1; attempt <= 2; attempt++) {
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
                    await new Promise(r => setTimeout(r, Math.max(retryAfter * 1000, 800 * attempt)));
                } else {
                    await new Promise(r => setTimeout(r, 300 * attempt));
                }
            } catch (_) {
                await new Promise(r => setTimeout(r, 500 * attempt));
            }
        }
        return false;
    }

    await mapWithConcurrency(batches, 5, resolveBatch);
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
        if (summaries.length >= 500) break;
    }
    if (summaries.length >= 500) break;
}

if (!summaries.length) {
    console.error('No clan data returned — skipping this snapshot.');
    process.exit(0);
}

const withPoints = summaries.filter(s => s.Points > 0);
console.log(`Fetched ${summaries.length} clan summaries (${withPoints.length} with points). Fetching detail…`);

const DETAIL_DEADLINE = Date.now() + 120_000;
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

const zeroClans = summaries.filter(s => s.Points <= 0).map(s => ({
    Name: s.Name, Points: 0, Members: s.Members, roster: [],
}));
const clans = [...detailedClans, ...zeroClans];

let resolvedCache = {};
if (existsSync(RESOLVED_CACHE_FILE)) {
    try { resolvedCache = JSON.parse(readFileSync(RESOLVED_CACHE_FILE, 'utf8')); } catch (_) { resolvedCache = {}; }
}

const needsResolve = new Set();
clans.forEach(c => c.roster.forEach(p => {
    if (!isUnresolvedName(p)) return;
    if (resolvedCache[p.UserID]) { p.DisplayName = resolvedCache[p.UserID]; return; }
    needsResolve.add(p.UserID);
}));

if (needsResolve.size) {
    const resolved = await resolveUsernames([...needsResolve]);
    clans.forEach(c => c.roster.forEach(p => {
        if (isUnresolvedName(p) && resolved[p.UserID]) p.DisplayName = resolved[p.UserID];
    }));
    Object.assign(resolvedCache, resolved);
    console.log(`Resolved ${Object.keys(resolved).length}/${needsResolve.size} new display names (${Object.keys(resolvedCache).length} cached total).`);
}
mkdirSync(SUBDIR, { recursive: true });
writeFileSync(RESOLVED_CACHE_FILE, JSON.stringify(resolvedCache));

let history = [];
if (existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')); } catch (_) { history = []; }
}

const now = Date.now();
history.push({ ts: now, clans });
history = history.filter(entry => now - entry.ts <= RETENTION_MS);

writeFileSync(HISTORY_FILE, JSON.stringify(history));
const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`Snapshot recorded: ${clans.length} clans with roster detail in ${elapsedSec}s, ${history.length} snapshots retained.`);

const ALERT_FILE = `${SUBDIR}/alert_state.json`;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const WATCH_PLAYER = 'jojo8';

async function checkAndAlert() {
    if (!DISCORD_WEBHOOK) {
        console.log('No DISCORD_WEBHOOK set — skipping alert check.');
        return;
    }
    if (history.length < 2) {
        console.log('Not enough snapshots for delta — skipping alert.');
        return;
    }

    function findPlayer(snap) {
        for (const clan of snap.clans) {
            for (const p of clan.roster || []) {
                const name = (resolvedCache[p.UserID] || p.DisplayName || '').toLowerCase();
                if (name === WATCH_PLAYER) return { ...p, DisplayName: resolvedCache[p.UserID] || p.DisplayName, clan: clan.Name };
            }
        }
        return null;
    }

    const latest = history[history.length - 1];
    const ALERT_WINDOW_MS = 20 * 60_000;
    let prev = null;
    for (const snap of history) {
        if (snap === latest) continue;
        if (latest.ts - snap.ts >= ALERT_WINDOW_MS) {
            if (!prev || snap.ts > prev.ts) prev = snap;
        }
    }
    if (!prev) {
        console.log('No snapshot ≥20 minutes old yet — skipping alert.');
        return;
    }
    const cur = findPlayer(latest);
    const old = findPlayer(prev);

    if (!cur) {
        console.log(`Player "${WATCH_PLAYER}" not found in latest snapshot.`);
        return;
    }

    const delta = cur.Points - (old ? old.Points : 0);
    const minsApart = Math.round((latest.ts - prev.ts) / 60000);
    console.log(`Alert check: ${WATCH_PLAYER} = ${cur.Points} pts, delta = ${delta} over ~${minsApart}m`);

    let alertState = {};
    if (existsSync(ALERT_FILE)) {
        try { alertState = JSON.parse(readFileSync(ALERT_FILE, 'utf8')); } catch (_) { alertState = {}; }
    }

    if (delta > 0) {
        if (alertState.sent) {
            console.log(`Points increasing again — clearing alert state.`);
            alertState = {};
            writeFileSync(ALERT_FILE, JSON.stringify(alertState));
        }
        return;
    }

    if (alertState.sent) {
        console.log(`Alert already sent — not repeating until points increase.`);
        return;
    }

    const embed = {
        title: '⚠️ Inactivity Alert — Lucky Blox',
        color: 0xff4444,
        fields: [
            { name: 'Player', value: cur.DisplayName, inline: true },
            { name: 'Clan', value: cur.clan, inline: true },
            { name: 'Points', value: cur.Points.toLocaleString(), inline: true },
            { name: 'No gain for', value: `~${minsApart} minutes`, inline: true },
        ],
        timestamp: new Date().toISOString(),
    };

    try {
        const res = await fetch(DISCORD_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: '<@967089828837597264>', embeds: [embed] }),
            signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
            console.log('Discord alert sent.');
            alertState.sent = true;
            alertState.ts = Date.now();
            writeFileSync(ALERT_FILE, JSON.stringify(alertState));
        } else {
            console.error(`Discord webhook returned ${res.status}`);
        }
    } catch (e) {
        console.error('Discord alert failed:', e.message);
    }
}

await checkAndAlert();
