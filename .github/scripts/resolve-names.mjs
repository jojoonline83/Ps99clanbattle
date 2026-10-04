// One-off / catch-up name lookup for a clan battle folder.
// Usage: node resolve-names.mjs <subdir> [budgetSeconds]
// Names every clan member in <subdir>/rosters.json that is missing from
// <subdir>/resolved_names.json (highest points first, 0-point members included).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolveUsernames } from './roblox-names.mjs';

const SUBDIR = process.argv[2];
const BUDGET_MS = (Number(process.argv[3]) || 1200) * 1000;
if (!SUBDIR || !/^[a-z0-9_-]+$/i.test(SUBDIR)) {
    console.error('Usage: node resolve-names.mjs <subdir> [budgetSeconds]');
    process.exit(1);
}
const ROSTERS_FILE = `${SUBDIR}/rosters.json`;
const NAMES_FILE = `${SUBDIR}/resolved_names.json`;
if (!existsSync(ROSTERS_FILE)) {
    console.log(`${ROSTERS_FILE} not found — nothing to do.`);
    process.exit(0);
}

const rosters = JSON.parse(readFileSync(ROSTERS_FILE, 'utf8')).clans || {};
let names = {};
if (existsSync(NAMES_FILE)) {
    try { names = JSON.parse(readFileSync(NAMES_FILE, 'utf8')); } catch (_) { names = {}; }
}

const best = new Map();
for (const rows of Object.values(rosters)) {
    for (const [uid, pts] of rows) {
        if (names[uid]) continue;
        if (!(best.get(uid) >= pts)) best.set(uid, pts);
    }
}
const todo = [...best.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
const zero = [...best.values()].filter(p => p <= 0).length;
console.log(`${todo.length} members without a name (${zero} with 0 points); budget ${BUDGET_MS / 1000}s.`);
if (!todo.length) process.exit(0);

const resolved = await resolveUsernames(todo, BUDGET_MS);
Object.assign(names, resolved);
writeFileSync(NAMES_FILE, JSON.stringify(names));
console.log(`Named ${Object.keys(resolved).length}/${todo.length}; ${Object.keys(names).length} names cached.`);
