// League data source for snapshot-clanbattle.mjs --league.
// Returns the same shape the clan battle source produces, so everything downstream
// (history/players/rosters/names) is shared:
//   { clans: [{ Name, Points, Members, roster: [{ UserID, DisplayName, Points }] }], meta, nameHints,
//     players: [{ UserID, DisplayName, Points, League }] }   <- individual leaderboard, incl. players
//                                                              outside the top leagues or in no league
const API_V1 = 'https://ps99.biggamesapi.io/v1';
const PAGE_SIZE = 100;
const MAX_LEAGUES = 1000;

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

async function fetchLeagueDetail(summary) {
    const detail = (await fetchJson(`${API_V1}/leagues/${encodeURIComponent(summary.Name)}`))?.data;
    if (!detail) return null;
    const contrib = {};
    for (const c of (detail.PointContributions || [])) contrib[c.UserID] = Number(c.Points) || 0;
    const people = [...(detail.Owner?.UserID ? [detail.Owner] : []), ...(detail.Members || [])];
    const seen = new Set();
    const roster = [];
    for (const m of people) {
        const uid = Number(m.UserID);
        if (!(uid > 0) || seen.has(uid)) continue;
        seen.add(uid);
        roster.push({ UserID: uid, DisplayName: m.DisplayName || String(uid), Points: contrib[uid] ?? 0 });
    }
    for (const [uidStr, pts] of Object.entries(contrib)) {
        const uid = Number(uidStr);
        if (uid > 0 && !seen.has(uid)) roster.push({ UserID: uid, DisplayName: String(uid), Points: pts });
    }
    roster.sort((a, b) => b.Points - a.Points);
    return { Name: detail.Name || summary.Name, Points: Number(detail.Points ?? summary.Points) || 0, Members: roster.length, roster };
}

// Individual leaderboard (/v1/leagues/players, sorted by points) plus any always-tracked user IDs.
const PLAYER_PAGES = 15;
function leagueOf(p) {
    const v = p.League ?? p.LeagueName ?? p.league ?? null;
    if (!v) return '';
    return typeof v === 'object' ? (v.Name || '') : String(v);
}
function toPlayer(p) {
    const uid = Number(p?.UserID ?? p?.userId);
    if (!(uid > 0)) return null;
    return { UserID: uid, DisplayName: p.DisplayName || p.displayName || String(uid), Points: Number(p.Points ?? p.points) || 0, League: leagueOf(p) };
}
async function loadLeaguePlayers(trackIds) {
    const pages = await mapWithConcurrency(Array.from({ length: PLAYER_PAGES }, (_, i) => i + 1), 5, async page => {
        const json = await fetchJson(`${API_V1}/leagues/players?page=${page}&pageSize=${PAGE_SIZE}&sort=Points&sortOrder=desc`);
        const d = json?.data;
        const arr = Array.isArray(d) ? d : (d?.players || d?.data || []);
        return Array.isArray(arr) ? arr : [];
    });
    const raw = pages.flat();
    if (raw.length) console.log(`Individual leaderboard sample: ${JSON.stringify(raw[0]).slice(0, 300)}`);
    const players = raw.map(toPlayer).filter(Boolean);
    const tracked = await mapWithConcurrency(trackIds, 3, async uid => {
        const d = (await fetchJson(`${API_V1}/leagues/players/${uid}`))?.data;
        const p = toPlayer(Array.isArray(d) ? d[0] : d);
        console.log(`  tracked player ${uid}: ${p ? `${p.DisplayName}, ${p.Points} pts, league "${p.League || 'none'}"` : 'not returned by the API'}`);
        return p;
    });
    players.push(...tracked.filter(Boolean));
    console.log(`Individual leaderboard: ${raw.length} entries (${players.filter(p => !p.League).length} without a league) + ${tracked.filter(Boolean).length}/${trackIds.length} tracked players.`);
    return players;
}

export async function loadLeagues({ trackIds = [] } = {}) {
    const summaries = [];
    let meta = {};
    for (let page = 1; summaries.length < MAX_LEAGUES; page += 10) {
        const pages = Array.from({ length: 10 }, (_, i) => page + i);
        const results = await mapWithConcurrency(pages, 10, p =>
            fetchJson(`${API_V1}/leagues?page=${p}&pageSize=${PAGE_SIZE}&sort=Points&sortOrder=desc`));
        let ended = false;
        for (const json of results) {
            const list = json?.data?.leagues || [];
            if (json?.data && !Object.keys(meta).length) {
                // Anything besides the list (e.g. an event/config name) — logged so the lock can use it.
                for (const [k, v] of Object.entries(json.data)) if (k !== 'leagues' && typeof v !== 'object') meta[k] = v;
            }
            if (!list.length) { ended = true; break; }
            summaries.push(...list);
        }
        if (ended) break;
    }
    if (summaries.length > MAX_LEAGUES) summaries.length = MAX_LEAGUES;
    console.log(`Fetched ${summaries.length} league summaries. List metadata: ${JSON.stringify(meta)}`);
    if (!summaries.length) return { clans: [], meta, nameHints: {} };

    const details = await mapWithConcurrency(summaries, 10, fetchLeagueDetail);
    const failed = details.map((d, i) => (d ? -1 : i)).filter(i => i >= 0);
    if (failed.length) {
        console.log(`League details: ${failed.length} failed — retrying at lower concurrency...`);
        await new Promise(r => setTimeout(r, 2000));
        await mapWithConcurrency(failed, 4, async i => { details[i] = await fetchLeagueDetail(summaries[i]); });
        console.log(`  still missing after retry: ${details.filter(d => !d).length}`);
    }

    const nameHints = {};
    const clans = summaries.map((s, i) => {
        const d = details[i];
        if (!d) return { Name: s.Name, Points: Number(s.Points) || 0, Members: Number(s.Members) || 0, roster: [] };
        for (const p of d.roster) if (p.DisplayName && p.DisplayName !== String(p.UserID)) nameHints[p.UserID] = p.DisplayName;
        return d;
    });
    const players = await loadLeaguePlayers(trackIds);
    for (const p of players) if (p.DisplayName !== String(p.UserID)) nameHints[p.UserID] = p.DisplayName;
    return { clans, meta, nameHints, players };
}
