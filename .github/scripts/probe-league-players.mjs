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

// How deep does the individual list go, and does any entry lack a league?
let total = 0, noLeague = 0, lastPts = null;
for (let page = 1; page <= 400; page++) {
    const r = await get(`${V1}/leagues/players?page=${page}&pageSize=500&sort=Points&sortOrder=desc`);
    let arr = [];
    try { const d = JSON.parse(r.text).data; arr = Array.isArray(d) ? d : (d?.players || []); } catch (_) {}
    if (!arr.length) { console.log(`\nindividual list ends at page ${page} (status ${r.status})`); break; }
    total += arr.length;
    noLeague += arr.filter(p => !p.League && !p.LeagueName).length;
    lastPts = arr.at(-1).Points;
    for (const u of users) if (arr.some(p => p.UserID === u.id)) console.log(`  ${u.name} found on page ${page}`);
}
console.log(`individual list: ${total} players, ${noLeague} without a league, lowest points ${lastPts}`);
