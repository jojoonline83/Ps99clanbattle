// One-off diagnostic: which API endpoints (if any) report league-event points for players
// who are not in a league. Usage: node probe-league-players.mjs <robloxUsername> [...]
const V1 = 'https://ps99.biggamesapi.io/v1';
const API = 'https://ps99.biggamesapi.io/api';

async function get(url, opts) {
    try {
        const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
        const text = await res.text();
        return { status: res.status, text };
    } catch (e) { return { status: 'ERR', text: String(e) }; }
}
const show = (label, r) => console.log(`${label} -> ${r.status} ${r.text.slice(0, 500).replace(/\s+/g, ' ')}`);

const names = process.argv.slice(2);
const lookup = await get('https://users.roblox.com/v1/usernames/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: names, excludeBannedUsers: false }),
});
show('roblox username lookup', lookup);
let users = [];
try { users = JSON.parse(lookup.text).data || []; } catch (_) {}

for (const u of users) {
    console.log(`\n=== ${u.name} (display "${u.displayName}") id ${u.id} ===`);
    for (const path of [
        `${V1}/leagues/players/${u.id}`,
        `${V1}/leagues/players?userId=${u.id}`,
        `${V1}/leagues/players?search=${encodeURIComponent(u.name)}`,
        `${V1}/players/${u.id}`,
        `${V1}/leaderboard/${u.id}`,
        `${API}/player/${u.id}`,
        `${V1}/leagues/players/${u.id}?includeSolo=true`,
        `${V1}/users/${u.id}`,
        `${V1}/players?userId=${u.id}`,
        `${API}/leaderboard?userId=${u.id}`,
    ]) show(path.replace('https://ps99.biggamesapi.io', ''), await get(path));
}

console.log('\n=== list / meta endpoints ===');
for (const path of [
    `${V1}/leagues/players?page=1&pageSize=3&sort=Points&sortOrder=desc`,
    `${V1}/leagues/players?page=1&pageSize=3&sort=Points&sortOrder=desc&includeSolo=true`,
    `${V1}/leagues?page=1&pageSize=1`,
    `${V1}/leagues/active`,
    `${V1}/leagues/config`,
    `${V1}/leagues/leaderboard`,
    `${V1}/leaderboard`,
    `${V1}/leaderboards`,
    `${V1}/events`,
    `${API}/activeLeague`,
    `${API}/activeLeagueBattle`,
    `${V1}/leagues/players?page=1&pageSize=3&league=none`,
    `${V1}/players?page=1&pageSize=3&sort=Points&sortOrder=desc`,
    `${V1}/leaderboard/players`,
    `${API}/leaderboard`,
    `${API}/clans?page=1&pageSize=1`,
    `${V1}`,
    `${API}`,
]) show(path.replace('https://ps99.biggamesapi.io', ''), await get(path));

// How deep does the individual list really go? Count unique players and find where pages start repeating.
const seen = new Map();
let pagesFetched = 0, firstRepeat = null, noLeague = 0, outOfOrder = 0, prevPts = Infinity;
for (let page = 1; page <= 400; page++) {
    const r = await get(`${V1}/leagues/players?page=${page}&pageSize=500&sort=Points&sortOrder=desc`);
    let arr = [];
    try { const d = JSON.parse(r.text).data; arr = Array.isArray(d) ? d : (d?.players || []); } catch (_) {}
    if (!arr.length) { console.log(`\nindividual list ends at page ${page} (status ${r.status})`); break; }
    pagesFetched++;
    let fresh = 0;
    for (const p of arr) {
        if (!seen.has(p.UserID)) { seen.set(p.UserID, p); fresh++; if (!p.League) noLeague++; }
        if (p.Points > prevPts) outOfOrder++;
        prevPts = p.Points;
    }
    if (!fresh && firstRepeat === null) { firstRepeat = page; console.log(`page ${page}: no new players (list repeats from here)`); break; }
    for (const u of users) if (arr.some(p => p.UserID === u.id)) console.log(`  ${u.name} found on page ${page}`);
}
const ranked = [...seen.values()].sort((a, b) => b.Points - a.Points);
console.log(`individual list: ${pagesFetched} pages, ${seen.size} unique players, ${noLeague} without a league, ${outOfOrder} out-of-order entries`);
for (const n of [1, 100, 500, 1000, 2000, 5000]) if (ranked[n - 1]) console.log(`  rank ${n}: ${ranked[n - 1].Points} pts (${ranked[n - 1].DisplayName}, league ${ranked[n - 1].League?.Name || '-'})`);

console.log('\n=== paging variants for /v1/leagues/players ===');
const firstIds = async q => {
    const r = await get(`${V1}/leagues/players?${q}`);
    try { const d = JSON.parse(r.text).data; const a = Array.isArray(d) ? d : (d?.players || []); return `${r.status} n=${a.length} first=${a[0]?.UserID}:${a[0]?.Points} last=${a.at(-1)?.UserID}:${a.at(-1)?.Points} meta=${JSON.stringify(Object.fromEntries(Object.entries(d || {}).filter(([k]) => k !== 'players')))}`; }
    catch (_) { return `${r.status} ${r.text.slice(0, 200)}`; }
};
for (const q of [
    'page=1&pageSize=100&sort=Points&sortOrder=desc',
    'page=2&pageSize=100&sort=Points&sortOrder=desc',
    'page=6&pageSize=100&sort=Points&sortOrder=desc',
    'page=1&pageSize=1000&sort=Points&sortOrder=desc',
    'page=1&pageSize=100&sort=Points&sortOrder=desc&offset=500',
    'page=1&pageSize=100&sort=Points&sortOrder=asc',
]) console.log(`  ${q} -> ${await firstIds(q)}`);

console.log('\n=== /v1/players registry ===');
for (const q of ['sort=recent&sortOrder=desc', 'sort=username&sortOrder=asc']) {
    show(`/v1/players?page=1&pageSize=3&${q}`, await get(`${V1}/players?page=1&pageSize=3&${q}`));
}
for (const u of users) show(`/v1/players search ${u.name}`, await get(`${V1}/players?page=1&pageSize=5&sort=username&sortOrder=asc&search=${encodeURIComponent(u.name)}`));

console.log('\n=== hatching points: league detail fields ===');
{
    const r = await get(`${V1}/leagues/Top_4`);
    try {
        const d = JSON.parse(r.text).data || {};
        console.log(`league detail keys: ${Object.keys(d).join(', ')}`);
        for (const k of Object.keys(d)) {
            const v = d[k];
            if (Array.isArray(v) && v.length) console.log(`  ${k}[0] = ${JSON.stringify(v[0]).slice(0, 300)}`);
            else if (v && typeof v === 'object') console.log(`  ${k} = ${JSON.stringify(v).slice(0, 300)}`);
        }
    } catch (_) { show('/v1/leagues/Top_4', r); }
}

console.log('\n=== hatching points: candidate endpoints ===');
for (const path of [
    `${V1}/leagues/hatch`, `${V1}/leagues/hatching`, `${V1}/leagues/players/hatch`,
    `${V1}/leagues/players?page=1&pageSize=3&sort=Hatches&sortOrder=desc`,
    `${V1}/leagues/players?page=1&pageSize=3&sort=HatchPoints&sortOrder=desc`,
    `${V1}/leagues/players?page=1&pageSize=3&type=hatch`,
    `${V1}/hatch`, `${V1}/hatching`, `${V1}/hatching/leaderboard`, `${V1}/hatches`,
    `${V1}/leaderboards/hatch`, `${V1}/leaderboards/hatching`, `${V1}/leaderboard/hatch`,
    `${V1}/events/hatch`, `${V1}/event/leaderboard`, `${V1}/events/leaderboard`,
    `${V1}/players?page=1&pageSize=3&sort=hatches&sortOrder=desc`,
    `${API}/hatchLeaderboard`, `${API}/leaderboard/hatch`, `${API}/activeEvent`, `${API}/events`,
    `${API}/activeHatchEvent`, `${API}/eventLeaderboard`,
]) show(path.replace('https://ps99.biggamesapi.io', ''), await get(path));
for (const u of users) {
    show(`/v1/players/${u.name}?include=stats`, await get(`${V1}/players/${encodeURIComponent(u.name)}?include=stats`));
}

console.log('\n=== clan battle status ===');
{
    const r = await get(`${API}/activeClanBattle`);
    console.log(`/api/activeClanBattle -> ${r.status} ${r.text.slice(0, 1500).replace(/\s+/g, ' ')}`);
    try {
        const d = JSON.parse(r.text).data;
        const c = d?.configData || {};
        const fmt = t => (t ? new Date(t * 1000).toISOString() : '-');
        console.log(`configName=${d?.configName} title=${c.Title} start=${fmt(c.StartTime)} finish=${fmt(c.FinishTime)} now=${new Date().toISOString()}`);
    } catch (_) {}
    const top = await get(`${API}/clans?page=1&pageSize=3&sort=Points&sortOrder=desc`);
    console.log(`/api/clans top3 -> ${top.status} ${top.text.slice(0, 500).replace(/\s+/g, ' ')}`);
}

console.log('\n=== clan battle entries in clan detail ===');
for (const name of ['UN0', 'SOPU']) {
    const r = await get(`${API}/clan/${name}`);
    try {
        const d = JSON.parse(r.text).data || {};
        const battles = d.Battles || {};
        console.log(`${name}: detail keys = ${Object.keys(d).join(', ')}`);
        for (const [k, b] of Object.entries(battles)) {
            const pc = b.PointContributions || [];
            const top = [...pc].sort((a, b) => b.Points - a.Points)[0];
            console.log(`  battle ${k}: keys=${Object.keys(b).join(',')} Points=${b.Points} contributors=${pc.length} top=${JSON.stringify(top)} earned=${JSON.stringify(b.EarnedMedal ?? b.ProcessedAwards ?? null)}`);
        }
    } catch (e) { show(`/api/clan/${name}`, r); }
}

console.log('\n=== looking for a new clan battle (v8) ===');
{
    const r = await get(`${API}/activeClanBattle`);
    try { const d = JSON.parse(r.text).data; console.log(`activeClanBattle: ${d?.configName} modified ${d?.dateModified} finish ${new Date((d?.configData?.FinishTime || 0) * 1000).toISOString()}`); } catch (_) { show('activeClanBattle', r); }
    const list = async () => { try { return JSON.parse((await get(`${API}/clans?page=1&pageSize=30&sort=Points&sortOrder=desc`)).text).data || []; } catch (_) { return []; } };
    const a = await list();
    const keyCounts = {};
    for (const c of a) {
        try {
            const d = JSON.parse((await get(`${API}/clan/${encodeURIComponent(c.Name)}`)).text).data || {};
            const keys = Object.keys(d.Battles || {});
            const last = keys.at(-1);
            keyCounts[last] = (keyCounts[last] || 0) + 1;
            const b = d.Battles?.[last] || {};
            if (last !== 'HatchWarBattle2026') console.log(`  ${c.Name}: newest battle ${last} Points=${b.Points} contributors=${(b.PointContributions || []).length} medal=${b.EarnedMedal ?? '-'}`);
        } catch (_) {}
    }
    console.log(`newest battle key across top ${a.length} clans: ${JSON.stringify(keyCounts)}`);
    await new Promise(r => setTimeout(r, 60000));
    const b = await list();
    const moved = a.filter(x => { const y = b.find(z => z.Name === x.Name); return y && y.Points !== x.Points; });
    console.log(`clans whose /api/clans Points changed within 60s: ${moved.length}/${a.length} ${moved.slice(0, 5).map(x => `${x.Name} ${x.Points}->${b.find(z => z.Name === x.Name).Points}`).join(', ')}`);
}
