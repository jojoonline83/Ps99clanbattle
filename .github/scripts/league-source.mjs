// League data source for snapshot-clanbattle.mjs --league.
// Returns the same shape the clan battle source produces, so everything downstream
// (history/players/rosters/names) is shared:
//   { clans: [{ Name, Points, Members, roster: [{ UserID, DisplayName, Points }] }], meta, nameHints }
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

export async function loadLeagues() {
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
    return { clans, meta, nameHints };
}
